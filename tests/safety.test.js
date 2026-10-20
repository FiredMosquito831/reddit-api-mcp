import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLog, createWriteGuard, fingerprint } from '../src/safety.js';

const HOUR_MS = 60 * 60 * 1000;

function harness({ maxWritesPerHour = 30 } = {}) {
  const clock = { time: 1_000_000, sleeps: [] };
  const log = createMemoryLog();
  const guard = createWriteGuard({
    log,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
    maxWritesPerHour,
  });
  const write = (text) => guard.run({ text, perform: async () => 'sent' });
  return { clock, write };
}

test('fingerprint ignores case and extra whitespace but not real edits', () => {
  assert.equal(fingerprint('  Hello   World '), fingerprint('hello world'));
  assert.notEqual(fingerprint('hello'), fingerprint('hello!'));
});

test('identical text is blocked for 24 hours, then allowed again', async () => {
  const { clock, write } = harness();
  await write('same');
  await assert.rejects(write('same'), /Identical text/);
  clock.time += 25 * HOUR_MS;
  assert.equal(await write('same'), 'sent');
});

test('writes are spaced at least two seconds apart', async () => {
  const { clock, write } = harness();
  await write('one');
  await write('two');
  assert.deepEqual(clock.sleeps, [2_000]);
});

test('the hourly cap refuses further writes, and frees up after an hour', async () => {
  const { clock, write } = harness({ maxWritesPerHour: 2 });
  await write('a');
  await write('b');
  await assert.rejects(write('c'), /Hourly write limit/);
  clock.time += HOUR_MS + 1;
  assert.equal(await write('c'), 'sent');
});

test('a failed write is not recorded, so it does not count against the limits', async () => {
  const log = createMemoryLog();
  const guard = createWriteGuard({ log, now: () => 1_000_000, sleep: async () => {} });
  await assert.rejects(guard.run({ text: 'oops', perform: async () => { throw new Error('network'); } }), /network/);
  assert.deepEqual(await log.load(), []);
});
