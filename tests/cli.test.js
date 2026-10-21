import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cli-cli-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function unconfigured(home) {
  return {
    REDDIT_CLIENT_ID: '',
    REDDIT_USERNAME: '',
    REDDIT_CLIENT_SECRET: '',
    REDDIT_REFRESH_TOKEN: '',
    REDDIT_AUTH_MODE: '',
    REDDIT_PASSWORD: '',
    REDDIT_CLI_HOME: home,
  };
}

test('--help lists the existing commands plus profile and browser groups', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  for (const command of ['login', 'feed', 'post', 'vote', 'subscribe', 'api', 'profile', 'browser']) {
    assert.match(stdout, new RegExp(command));
  }
});

test('profile and browser help are available without configuration or a keychain', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const profile = await run(['profile', '--help'], unconfigured(home));
    assert.equal(profile.code, 0, profile.stderr);
    for (const command of ['add', 'list', 'default', 'status', 'configure', 'approve-settings', 'credentials', 'logout', 'remove', 'attempts', 'resolve']) {
      assert.match(profile.stdout, new RegExp(command));
    }
    const browser = await run(['browser', 'doctor', '--help'], unconfigured(home));
    assert.equal(browser.code, 0, browser.stderr);
    assert.match(browser.stdout, /--profile/);
    assert.match(browser.stdout, /--json/);
  } finally {
    await cleanup();
  }
});

test('commands fail with a clear message when the environment is not configured', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { code, stderr } = await run(['whoami'], unconfigured(home));
    assert.equal(code, 1);
    assert.match(stderr, /REDDIT_CLIENT_ID/);
  } finally {
    await cleanup();
  }
});

test('a dry run prints the request, needs no credentials, and creates no account state', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { code, stdout } = await run(
      ['post', 'node', '--title', 'Hello', '--text', 'Body', '--dry-run'],
      unconfigured(home),
    );
    assert.equal(code, 0);
    assert.match(stdout, /Dry run: nothing was sent/);
    assert.match(stdout, /"subreddit": "node"/);
    // No ledger, attempts, cache generation, or approval record was created.
    const entries = await readdir(home).catch(() => []);
    assert.deepEqual(entries, []);
  } finally {
    await cleanup();
  }
});

test('profile list and explain and scopes work offline and write no home state', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const list = await run(['profile', 'list'], unconfigured(home));
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /No named profiles/);

    const explain = await run(['explain', 'karma'], unconfigured(home));
    assert.equal(explain.code, 0, explain.stderr);
    assert.match(explain.stdout, /karma/i);

    const scopes = await run(['scopes'], unconfigured(home));
    assert.equal(scopes.code, 0, scopes.stderr);
    assert.match(scopes.stdout, /identity/);

    assert.deepEqual(await readdir(home).catch(() => []), []);
  } finally {
    await cleanup();
  }
});

test('the raw api command refuses a non-API backend before it resolves credentials', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const { code, stderr } = await run(
      ['api', 'GET', '/api/v1/me', '--backend', 'browser'],
      unconfigured(home),
    );
    assert.equal(code, 1);
    assert.match(stderr, /official-API-only/);
  } finally {
    await cleanup();
  }
});

test('a raw POST runs through the shared boundary and still needs official API credentials', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const result = await run(['api', 'POST', '/api/vote', '--field', 'id=t3_abc123', '--yes'], unconfigured(home));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /REDDIT_CLIENT_ID/);
    assert.doesNotMatch(result.stderr, /not available/i);
  } finally {
    await cleanup();
  }
});

test('the raw api command stays a working official-API path, not a dead code path', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const dry = await run(['api', 'GET', '/api/v1/me', '--dry-run', '--backend', 'api'], unconfigured(home));
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run: nothing was sent/);
    const live = await run(['api', 'GET', '/api/v1/me'], unconfigured(home));
    assert.equal(live.code, 1);
    assert.match(live.stderr, /REDDIT_CLIENT_ID/);
    assert.doesNotMatch(live.stderr, /not available/i);
  } finally {
    await cleanup();
  }
});

test('read and write commands expose --profile, --backend, --json, and --confirm', async () => {
  const { home, cleanup } = await tempHome();
  try {
    const read = await run(['feed', '--help'], unconfigured(home));
    assert.equal(read.code, 0, read.stderr);
    for (const flag of ['--profile', '--backend', '--json']) assert.match(read.stdout, new RegExp(flag));
    const write = await run(['post', '--help'], unconfigured(home));
    assert.equal(write.code, 0, write.stderr);
    for (const flag of ['--profile', '--backend', '--json', '--confirm', '--dry-run', '--yes']) {
      assert.match(write.stdout, new RegExp(flag));
    }
    assert.match(write.stdout, /never satisfies/);
  } finally {
    await cleanup();
  }
});
