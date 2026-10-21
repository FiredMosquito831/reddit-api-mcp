import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttemptLedger, createCacheGeneration } from '../src/attempts.js';
import { OUTCOMES } from '../src/errors.js';

const HOUR_MS = 60 * 60 * 1000;
const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'acct_fedcba9876543210fedcba9876543210';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-attempts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function operation(overrides = {}) {
  return {
    tool: 'reply_to_post',
    action: 'comment',
    kind: 'write',
    policyKey: 'reply_to_post',
    target: 't3_abc123',
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

function clockAt(start = 1_000_000) {
  const clock = { time: start };
  return clock;
}

function makeLedger(homeDir, { clock = clockAt(), accountKey = ACCOUNT, options = {} } = {}) {
  return createAttemptLedger({
    homeDir,
    accountKey,
    clock: () => clock.time,
    newId: (() => {
      let n = 0;
      return () => `attempt-${++n}`;
    })(),
    ...options,
  });
}

const context = (accountKey = ACCOUNT) => ({ accountKey, callId: 'call-1', backendId: 'api', profile: { id: 'profile-1' } });

test('reserve persists a prepared attempt visible to another ledger instance', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock });

  const attempt = await ledger.reserve(operation(), context());
  assert.equal(attempt.state, 'PREPARED');
  assert.equal(attempt.policyKey, 'reply_to_post');
  assert.equal(attempt.target, 't3_abc123');
  assert.equal(attempt.contentHash, 'a'.repeat(64));
  assert.equal(attempt.scheduledAt, 1_000_000);

  const reopened = makeLedger(home, { clock });
  const pending = await reopened.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, attempt.id);
  assert.equal(pending[0].state, 'PREPARED');

  // The file holds identifiers and hashes only, never content text or secrets.
  const raw = await readFile(join(home, 'accounts', ACCOUNT, 'attempts.json'), 'utf8');
  assert.ok(!raw.includes('secret comment text'));
});

test('an identical pending attempt blocks a second reservation but different content passes', async (t) => {
  const home = await tempHome(t);
  const ledger = makeLedger(home);

  await ledger.reserve(operation(), context());
  await assert.rejects(ledger.reserve(operation(), context()), (error) => error.code === 'DUPLICATE_WRITE');

  const different = await ledger.reserve(operation({ contentHash: 'b'.repeat(64) }), context());
  assert.equal(different.state, 'PREPARED');
});

test('a known rejection frees the duplicate and the quota', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 1 } } });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  await ledger.settle(first.id, OUTCOMES.FAILED_KNOWN);
  assert.deepEqual(await ledger.listPending(), []);

  const again = await ledger.reserve(operation(), context());
  assert.equal(again.state, 'PREPARED');
});

test('an unknown outcome duplicates block after restart and consumes quota until resolved', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 2 } } });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  await ledger.settle(first.id, OUTCOMES.OUTCOME_UNKNOWN);

  const restarted = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 2 } } });
  const pending = await restarted.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'OUTCOME_UNKNOWN');
  await assert.rejects(restarted.reserve(operation(), context()), (error) => error.code === 'DUPLICATE_WRITE');

  // The unknown attempt consumes one of the two hourly slots.
  const second = await restarted.reserve(operation({ target: 't3_other', contentHash: 'c'.repeat(64) }), context());
  assert.equal(second.state, 'PREPARED');
  await assert.rejects(
    restarted.reserve(operation({ target: 't3_third', contentHash: 'd'.repeat(64) }), context()),
    (error) => error.code === 'THROTTLED',
  );
});

test('a successful identical write is blocked for the duplicate window, then allowed', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 30 } } });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  await ledger.settle(first.id, OUTCOMES.SUCCEEDED);

  await assert.rejects(ledger.reserve(operation(), context()), (error) => error.code === 'DUPLICATE_WRITE');
  clock.time += 24 * HOUR_MS + 1;
  const later = await ledger.reserve(operation(), context());
  assert.equal(later.state, 'PREPARED');
});

test('a user-local resolution converts unknown into a known settled outcome', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 1 } } });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  await ledger.settle(first.id, OUTCOMES.OUTCOME_UNKNOWN);

  const resolved = await ledger.resolveLocally(first.id, 'failed');
  assert.equal(resolved.state, 'FAILED_KNOWN');
  assert.equal(resolved.resolution, 'local');

  const retried = await ledger.reserve(operation(), context());
  assert.equal(retried.state, 'PREPARED');
  // The reservation got the next durable slot; a direct ledger caller must wait for it too.
  clock.time += 2_000;

  await ledger.markDispatched(retried.id);
  await ledger.settle(retried.id, OUTCOMES.OUTCOME_UNKNOWN);
  const confirmed = await ledger.resolveLocally(retried.id, 'succeeded');
  assert.equal(confirmed.state, 'SUCCEEDED');
  // A success still counts against the hourly cap.
  await assert.rejects(
    ledger.reserve(operation({ target: 't3_elsewhere', contentHash: 'e'.repeat(64) }), context()),
    (error) => error.code === 'THROTTLED',
  );
});

test('a crashed dispatched attempt stays uncertain after a restart and blocks duplicates', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  // No settle call: the process "crashed" after the durable mark.
  const restarted = makeLedger(home, { clock });
  const pending = await restarted.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'DISPATCHED');
  assert.equal(pending[0].uncertain, true);
  await assert.rejects(restarted.reserve(operation(), context()), (error) => error.code === 'DUPLICATE_WRITE');
});

test('spacing reservations are durable, monotonic slots', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { minGapMs: 2_000 } } });

  const first = await ledger.reserve(operation(), context());
  assert.equal(first.scheduledAt, clock.time);

  const second = await ledger.reserve(operation({ contentHash: 'b'.repeat(64) }), context());
  assert.equal(second.scheduledAt, clock.time + 2_000);

  const late = await ledger.recheckSlot(second.id);
  assert.equal(late.ready, false);
  assert.equal(late.waitMs, 2_000);

  clock.time += 2_000;
  const ready = await ledger.recheckSlot(second.id);
  assert.equal(ready.ready, true);
});

test('a dead process preparation expires but a live one is kept', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const settings = { limits: { minGapMs: 0 }, preparedTtlMs: 1_000 };

  const crashed = makeLedger(home, { clock, options: { ...settings, pid: 900001, isAlive: () => false } });
  const first = await crashed.reserve(operation(), context());
  await crashed.reserve(operation({ contentHash: 'b'.repeat(64) }), context());

  const live = makeLedger(home, { clock, options: { ...settings, pid: 900002, isAlive: (pid) => pid === 900002 } });
  // Too young to expire: both preparations are still pending.
  assert.equal((await live.listPending()).length, 2);
  clock.time += 1_001;
  const after = makeLedger(home, { clock, options: { ...settings, pid: 900002, isAlive: (pid) => pid === 900002 } });
  const recreated = await after.reserve(operation(), context());
  assert.equal(recreated.state, 'PREPARED');
  const pending = await after.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, recreated.id);
});

test('distinct accounts do not share duplicate or quota state', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const one = makeLedger(home, { clock, accountKey: ACCOUNT, options: { limits: { maxWritesPerHour: 1 } } });
  const two = makeLedger(home, { clock, accountKey: OTHER_ACCOUNT, options: { limits: { maxWritesPerHour: 1 } } });

  await one.reserve(operation(), context(ACCOUNT));
  await assert.rejects(one.reserve(operation({ contentHash: 'b'.repeat(64) }), context(ACCOUNT)), (error) => error.code === 'THROTTLED');
  const independent = await two.reserve(operation(), context(OTHER_ACCOUNT));
  assert.equal(independent.state, 'PREPARED');
});

test('a mismatched account key is refused before anything is recorded', async (t) => {
  const home = await tempHome(t);
  const ledger = makeLedger(home);
  await assert.rejects(ledger.reserve(operation(), context(OTHER_ACCOUNT)), (error) => error.code === 'IDENTITY_MISMATCH');
  assert.deepEqual(await ledger.listPending(), []);
});

test('pending uncertainty survives ledger compaction while settled records are pruned', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { maxAttempts: 3, limits: { minGapMs: 0 } } });

  const unknown = await ledger.reserve(operation(), context());
  await ledger.markDispatched(unknown.id);
  await ledger.settle(unknown.id, OUTCOMES.OUTCOME_UNKNOWN);

  for (let index = 0; index < 6; index += 1) {
    const entry = await ledger.reserve(operation({ target: `t3_bulk${index}`, contentHash: `${index}`.padStart(64, '0') }), context());
    await ledger.markDispatched(entry.id);
    await ledger.settle(entry.id, OUTCOMES.SUCCEEDED);
    clock.time += 1;
  }

  const pending = await ledger.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, unknown.id);
});

test('settle refuses an attempt that was never durably dispatched', async (t) => {
  const home = await tempHome(t);
  const ledger = makeLedger(home);

  const attempt = await ledger.reserve(operation(), context());
  await assert.rejects(
    ledger.settle(attempt.id, OUTCOMES.SUCCEEDED),
    (error) => error.code === 'ATTEMPT_STATE',
  );
  await assert.rejects(
    ledger.settle(attempt.id, OUTCOMES.FAILED_KNOWN),
    (error) => error.code === 'ATTEMPT_STATE',
  );
  // Nothing was fabricated; only cancel may release a pre-dispatch reservation.
  const pending = await ledger.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'PREPARED');
  await ledger.cancel(attempt.id);
  assert.deepEqual(await ledger.listPending(), []);
});

test('markDispatched enforces the durable slot and account spacing under the lock', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { minGapMs: 2_000 } } });

  const first = await ledger.reserve(operation(), context());
  const second = await ledger.reserve(operation({ contentHash: 'b'.repeat(64) }), context());
  assert.equal(second.scheduledAt, clock.time + 2_000);

  await ledger.markDispatched(first.id);
  // The second slot has not arrived, and the first dispatch just set the spacing baseline.
  await assert.rejects(
    ledger.markDispatched(second.id),
    (error) => error.code === 'ATTEMPT_NOT_READY' && error.details.waitMs === 2_000,
  );
  const stillPending = await ledger.listPending();
  assert.equal(stillPending.find((entry) => entry.id === second.id).state, 'PREPARED');

  clock.time += 2_000;
  const marked = await ledger.markDispatched(second.id);
  assert.equal(marked.state, 'DISPATCHED');
});

test('duplicate detection precedes the hourly quota so callers can tell them apart', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const ledger = makeLedger(home, { clock, options: { limits: { maxWritesPerHour: 1 } } });

  const first = await ledger.reserve(operation(), context());
  await ledger.markDispatched(first.id);
  await ledger.settle(first.id, OUTCOMES.SUCCEEDED);

  await assert.rejects(ledger.reserve(operation(), context()), (error) => error.code === 'DUPLICATE_WRITE');
  await assert.rejects(
    ledger.reserve(operation({ target: 't3_other', contentHash: 'b'.repeat(64) }), context()),
    (error) => error.code === 'THROTTLED',
  );
});

test('resolving a crashed success locally bumps the account cache generation', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const generation = createCacheGeneration({ homeDir: home, accountKey: ACCOUNT, clock: () => clock.time });
  const ledger = makeLedger(home, { clock, options: { cacheGeneration: generation } });

  const crashed = await ledger.reserve(operation(), context());
  await ledger.markDispatched(crashed.id);
  const resolved = await ledger.resolveLocally(crashed.id, 'succeeded');
  assert.equal(resolved.state, OUTCOMES.SUCCEEDED);
  assert.equal(resolved.cacheGeneration, 1);
  assert.equal(await generation.current(), 1);

  // A failed resolution frees the reservation without changing cached reads.
  const failed = await ledger.reserve(operation({ target: 't3_other', contentHash: 'b'.repeat(64) }), context());
  clock.time += 2_000;
  await ledger.markDispatched(failed.id);
  const rejected = await ledger.resolveLocally(failed.id, 'failed');
  assert.equal(rejected.state, OUTCOMES.FAILED_KNOWN);
  assert.equal(rejected.cacheGeneration, undefined);
  assert.equal(await generation.current(), 1);
});

test('cache generation is account-scoped and persisted', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const generation = createCacheGeneration({ homeDir: home, accountKey: ACCOUNT, clock: () => clock.time });

  assert.equal(await generation.current(), 0);
  assert.equal(await generation.bump(), 1);
  assert.equal(await generation.bump(), 2);
  assert.equal(await generation.current(), 2);

  const reopened = createCacheGeneration({ homeDir: home, accountKey: ACCOUNT });
  assert.equal(await reopened.current(), 2);
  const other = createCacheGeneration({ homeDir: home, accountKey: OTHER_ACCOUNT });
  assert.equal(await other.current(), 0);
});
