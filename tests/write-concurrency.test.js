import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ATTEMPTS_URL = new URL('../src/attempts.js', import.meta.url).href;

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'acct_fedcba9876543210fedcba9876543210';

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Each child runs one ledger operation against shared temp storage and prints one JSON line.
const CHILD_SOURCE = `
import { createAttemptLedger } from ${JSON.stringify(ATTEMPTS_URL)};

const mode = process.env.CHILD_MODE;
const homeDir = process.env.CHILD_HOME;
const accountKey = process.env.CHILD_ACCOUNT;
const startAt = Number(process.env.CHILD_START_AT || '0');
const operation = {
  tool: 'reply_to_post',
  action: 'comment',
  kind: 'write',
  policyKey: 'reply_to_post',
  target: process.env.CHILD_TARGET || 't3_shared',
  contentHash: process.env.CHILD_CONTENT || 'a'.repeat(64),
};

const ledger = createAttemptLedger({
  homeDir,
  accountKey,
  limits: { minGapMs: 0, maxWritesPerHour: Number(process.env.CHILD_MAX || '30') },
});

async function waitForStart() {
  while (Date.now() < startAt) await new Promise((done) => setTimeout(done, 5));
}

try {
  await waitForStart();
  if (mode === 'reserve') {
    const attempt = await ledger.reserve(operation, { accountKey, callId: 'child' });
    process.stdout.write(JSON.stringify({ ok: true, id: attempt.id }) + '\\n');
  } else if (mode === 'unknown') {
    const attempt = await ledger.reserve(operation, { accountKey, callId: 'child' });
    await ledger.markDispatched(attempt.id);
    await ledger.settle(attempt.id, 'OUTCOME_UNKNOWN');
    process.stdout.write(JSON.stringify({ ok: true, id: attempt.id }) + '\\n');
  } else {
    throw new Error('unknown child mode');
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || null, message: error.message }) + '\\n');
}
`;

async function runChild(scriptPath, { mode, home, account = ACCOUNT, content, target, max, startAt = 0 }) {
  const output = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath],
      {
        env: {
          ...process.env,
          CHILD_MODE: mode,
          CHILD_HOME: home,
          CHILD_ACCOUNT: account,
          CHILD_CONTENT: content ?? '',
          CHILD_TARGET: target ?? '',
          CHILD_MAX: String(max ?? 30),
          CHILD_START_AT: String(startAt),
        },
        timeout: 60_000,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `unexpected child output: ${output}`);
  return JSON.parse(lines[0]);
}

test('two processes racing for one account admission reserve exactly one identical write', async (t) => {
  const home = await tempDir(t, 'reddit-write-race-');
  const script = join(home, 'child.mjs');
  await writeFile(script, CHILD_SOURCE);
  const startAt = Date.now() + 400;

  const [first, second] = await Promise.all([
    runChild(script, { mode: 'reserve', home, startAt, content: 'a'.repeat(64) }),
    runChild(script, { mode: 'reserve', home, startAt, content: 'a'.repeat(64) }),
  ]);

  const accepted = [first, second].filter((result) => result.ok);
  const refused = [first, second].filter((result) => !result.ok);
  assert.equal(accepted.length, 1, JSON.stringify([first, second]));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, 'DUPLICATE_WRITE');
});

test('an unknown write from a previous process consumes quota and blocks duplicates for a new process', async (t) => {
  const home = await tempDir(t, 'reddit-write-restart-');
  const script = join(home, 'child.mjs');
  await writeFile(script, CHILD_SOURCE);

  const written = await runChild(script, { mode: 'unknown', home, max: 2 });
  assert.equal(written.ok, true);

  const duplicate = await runChild(script, {
    mode: 'reserve',
    home,
    max: 2,
    content: 'a'.repeat(64),
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'DUPLICATE_WRITE');

  const exhausted = await runChild(script, {
    mode: 'reserve',
    home,
    max: 1,
    target: 't3_other',
    content: 'b'.repeat(64),
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'THROTTLED');
});

test('different verified accounts admit independently in separate processes', async (t) => {
  const home = await tempDir(t, 'reddit-write-accounts-');
  const script = join(home, 'child.mjs');
  await writeFile(script, CHILD_SOURCE);
  const startAt = Date.now() + 400;

  const [one, two] = await Promise.all([
    runChild(script, { mode: 'reserve', home, account: ACCOUNT, startAt, content: 'a'.repeat(64) }),
    runChild(script, { mode: 'reserve', home, account: OTHER_ACCOUNT, startAt, content: 'a'.repeat(64) }),
  ]);

  assert.equal(one.ok, true, JSON.stringify(one));
  assert.equal(two.ok, true, JSON.stringify(two));
  assert.notEqual(one.id, two.id);
});
