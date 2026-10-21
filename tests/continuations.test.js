import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContinuationStore, normalizeBackendResult } from '../src/continuations.js';

const binding = (patch = {}) => ({
  profileId: 'profile-a', accountKey: 'reddit:t2_a', backend: 'browser',
  operation: 'browse_subreddit', filterHash: 'hot:node', credentialGeneration: 1,
  ...patch,
});

test('a continuation is opaque and bound to every original request dimension', () => {
  const store = createContinuationStore();
  const token = store.issue({ ...binding(), taskId: 'task-a', state: { offset: 10 } });
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.ok(!token.includes('profile-a'));
  assert.deepEqual(store.resolve(token, binding()).state, { offset: 10 });
  for (const [key, value] of Object.entries({ profileId: 'profile-b', accountKey: 'reddit:t2_b', backend: 'api', operation: 'search_reddit', filterHash: 'new:node', credentialGeneration: 2 })) {
    assert.throws(() => store.resolve(token, binding({ [key]: value })), { code: 'CONTINUATION_INVALID' });
  }
  assert.throws(() => store.resolve('invented', binding()), { code: 'CONTINUATION_INVALID' });
});

test('continuations expire after five minutes and cannot survive task closure or restart', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: {} });
  time = 299_999;
  assert.equal(store.resolve(token, binding()).taskId, 'task-a');
  time = 300_000;
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
  const other = store.issue({ ...binding(), taskId: 'task-b', state: {} });
  // A closed task is gone for good: its token reads as expired, not as an unknown token.
  store.expireTask('task-b');
  assert.throws(() => store.resolve(other, binding()), { code: 'CONTINUATION_EXPIRED' });
  assert.throws(() => createContinuationStore().resolve(other, binding()), { code: 'CONTINUATION_INVALID' });
});

test('closing one task leaves another task and its continuation intact', () => {
  const store = createContinuationStore();
  const first = store.issue({ ...binding(), taskId: 'task-a', state: { page: 1 } });
  const second = store.issue({ ...binding(), taskId: 'task-b', state: { page: 2 } });
  store.expireTask('task-a');
  assert.throws(() => store.resolve(first, binding()), { code: 'CONTINUATION_EXPIRED' });
  assert.deepEqual(store.resolve(second, binding()).state, { page: 2 });
});

test('continuation state is copied and cannot be changed by later caller mutations', () => {
  const store = createContinuationStore();
  const state = { offset: 10, seen: ['t3_a'] };
  const token = store.issue({ ...binding(), taskId: 'task-a', state });
  state.offset = 900;
  const first = store.resolve(token, binding());
  first.state.seen.push('t3_b');
  first.binding.backend = 'api';
  assert.deepEqual(store.resolve(token, binding()).state, { offset: 10, seen: ['t3_a'] });
  assert.equal(store.resolve(token, binding()).binding.backend, 'browser');
});

test('a malformed or missing binding fails as invalid before any token lookup', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: {} });
  time = 300_000;
  // Binding validation runs first, so a bad call never learns whether the token existed or expired.
  assert.throws(() => store.resolve(token), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(token, null), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(token, binding({ profileId: '' })), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(token, binding({ accountKey: { name: 'reddit:t2_a' } })), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(42, binding()), { code: 'CONTINUATION_INVALID' });
});

test('issuing rejects non-scalar, empty, or uncloneable continuation inputs', () => {
  const store = createContinuationStore();
  const stateless = store.issue({ ...binding(), taskId: 'task-a' });
  assert.equal(store.resolve(stateless, binding()).state, undefined);
  assert.throws(() => store.issue({ ...binding({ filterHash: '' }), taskId: 'task-a', state: {} }), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.issue({ ...binding(), taskId: '', state: {} }), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-a', state: { page: { session: 'secret-cookie' }, toJSON() {} } }), (error) => {
    assert.equal(error.code, 'CONTINUATION_INVALID');
    assert.ok(!error.message.includes('secret-cookie'));
    return true;
  });
});

test('capacity is bounded, new entries cannot evict live task continuations silently', () => {
  const store = createContinuationStore({ maxEntries: 1 });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: {} });
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-b', state: {} }), { code: 'CONTINUATION_INVALID' });
  assert.equal(store.resolve(token, binding()).taskId, 'task-a');
});

test('expired tokens cannot be reissued through a colliding id generator', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time, newId: () => 'fixed-token-value', maxEntries: 10 });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: {} });
  assert.equal(token, 'fixed-token-value');
  // A live collision is refused.
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-b', state: {} }), { code: 'CONTINUATION_INVALID' });
  time = 300_000;
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
  // The tombstone survives expiry, so the expired capability cannot be handed out again.
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-a', state: {} }), { code: 'CONTINUATION_INVALID' });
});

test('a capacity of one keeps its tombstone instead of trimming it away at issue time', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time, newId: () => 'fixed-token-value', maxEntries: 1 });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: { page: 1 } });
  // Expiry through resolve tombstones the token; the tombstone must survive a full set.
  time = 300_000;
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-b', state: { page: 2 } }), { code: 'CONTINUATION_INVALID' });
  // The old capability never revives with the new task's state.
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
});

test('a capacity of one keeps swept tombstones so a fixed generator cannot reuse an expired id', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time, newId: () => 'fixed-token-value', maxEntries: 1 });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: { page: 1 } });
  time = 300_000;
  // Issuing sweeps the expired entry first; the tombstone it writes survives the capacity check.
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-b', state: { page: 2 } }), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
});

test('a full tombstone set never blocks a genuinely new token, and old tombstones age out', () => {
  let time = 0;
  const ids = ['first-token', 'second-token'];
  const store = createContinuationStore({ clock: () => time, newId: () => ids.shift(), maxEntries: 1 });
  const first = store.issue({ ...binding(), taskId: 'task-a', state: { page: 1 } });
  time = 300_000;
  const second = store.issue({ ...binding(), taskId: 'task-b', state: { page: 2 } });
  assert.equal(second, 'second-token');
  assert.deepEqual(store.resolve(second, binding()).state, { page: 2 });
  assert.throws(() => store.resolve(first, binding()), { code: 'CONTINUATION_EXPIRED' });
  // Memory stays bounded: tombstoning the second token evicts the oldest tombstone only.
  store.expireTask('task-b');
  assert.throws(() => store.resolve(first, binding()), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(second, binding()), { code: 'CONTINUATION_EXPIRED' });
});

test('closing a task with a fixed generator prevents reissuing that token to a new task', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time, newId: () => 'fixed-token-value', maxEntries: 1 });
  const token = store.issue({ ...binding(), taskId: 'task-a', state: { page: 1 } });
  store.expireTask('task-a');
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-b', state: { page: 2 } }), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => store.resolve(token, binding()), { code: 'CONTINUATION_EXPIRED' });
  // No global leak: another store is unaffected and can issue the same id.
  const otherStore = createContinuationStore({ clock: () => time, newId: () => 'fixed-token-value' });
  assert.equal(otherStore.issue({ ...binding(), taskId: 'task-c', state: { page: 3 } }), 'fixed-token-value');
});

test('tombstones stay bounded across many expirations without resurrecting old tokens', () => {
  let time = 0;
  const store = createContinuationStore({ clock: () => time, ttlMs: 1, maxEntries: 8 });
  const tokens = [];
  for (let index = 0; index < 40; index += 1) {
    tokens.push(store.issue({ ...binding(), taskId: `task-${index}`, state: { index } }));
    time += 2;
  }
  for (const token of tokens.slice(0, -1)) {
    assert.throws(() => store.resolve(token, binding()), (error) => ['CONTINUATION_EXPIRED', 'CONTINUATION_INVALID'].includes(error.code));
  }
  const fresh = store.issue({ ...binding(), taskId: 'task-fresh', state: { index: 40 } });
  assert.deepEqual(store.resolve(fresh, binding()).state, { index: 40 });
});

test('a clock that stops returning a timestamp fails loudly', () => {
  const store = createContinuationStore({ clock: () => Number.NaN });
  assert.throws(() => store.issue({ ...binding(), taskId: 'task-a', state: {} }), TypeError);
  assert.throws(() => createContinuationStore({ ttlMs: 0 }), TypeError);
  assert.throws(() => createContinuationStore({ maxEntries: 1.5 }), TypeError);
});

test('result normalization preserves legacy API data and exact cursors', () => {
  const data = { items: [{ fullname: 't3_a', score: 0 }], after: 't3_a' };
  const result = normalizeBackendResult(data, { backend: 'api', profile: 'personal' });
  assert.equal(result.data, data);
  assert.equal(result.meta.backend, 'api');
  assert.equal(result.meta.cursorKind, 'exact');
  assert.equal(result.meta.completeness, 'complete');
  assert.deepEqual(result.meta.missingFields, []);
  assert.deepEqual(normalizeBackendResult(['a'], { backend: 'api' }).data, ['a']);
  assert.equal(normalizeBackendResult('a', { backend: 'api' }).data, 'a');
});

test('UI results never pretend an opaque token is an API cursor or missing metrics are zero', () => {
  const data = { items: [{ fullname: 't3_a' }], after: null };
  const result = normalizeBackendResult(data, {
    backend: 'browser', completeness: 'partial', missingFields: ['score'],
    continuation: { token: 'opaque', kind: 'ui-opaque' },
  });
  assert.equal(result.data.after, null);
  assert.equal(result.data.items[0].score, undefined);
  assert.equal(result.meta.cursorKind, 'ui-opaque');
  assert.equal(result.meta.completeness, 'partial');
  assert.deepEqual(result.meta.missingFields, ['score']);
  assert.throws(() => normalizeBackendResult({ after: 't3_a' }, { backend: 'browser', continuation: { token: 'opaque' } }), { code: 'CURSOR_CONFLICT' });
});

test('an undeclared UI result is unknown rather than silently complete', () => {
  const result = normalizeBackendResult({ items: [] }, { backend: 'browser' });
  assert.equal(result.meta.completeness, 'unknown');
  assert.equal(result.meta.missingFields, null);
  assert.equal(result.meta.cursorKind, 'none');
  const replay = normalizeBackendResult({}, { backend: 'replay' });
  assert.equal(replay.meta.completeness, 'unknown');
});

test('an API backend cannot carry a UI continuation', () => {
  assert.throws(() => normalizeBackendResult({ after: null }, { backend: 'api', continuation: { token: 'opaque' } }), { code: 'CURSOR_CONFLICT' });
  assert.throws(() => normalizeBackendResult({}, { backend: 'api', continuation: { token: 'opaque' } }), { code: 'CURSOR_CONFLICT' });
});

test('public result metadata is allowlisted rather than echoing session internals', () => {
  const result = normalizeBackendResult({}, {
    backend: 'replay', profile: 'personal', username: 'alice', outcome: 'SUCCEEDED', attemptId: 'attempt-1',
    cookie: 'secret', token: 'secret', context: { password: 'secret' }, debugUrl: 'secret',
    continuation: { token: 'opaque', kind: 'ui-opaque', cookies: 'secret', issuedAt: 10, ttlMs: 20 },
  });
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.meta.profile, 'personal');
  assert.equal(result.meta.username, 'alice');
  assert.equal(result.meta.outcome, 'SUCCEEDED');
  assert.equal(result.meta.attemptId, 'attempt-1');
  assert.deepEqual(result.meta.continuation, { token: 'opaque', kind: 'ui-opaque', issuedAt: 10, ttlMs: 20 });
});

test('metadata values are type-checked by field name without echoing them', () => {
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', profile: { alias: 'secret' } }), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /profile/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', username: 7 }), TypeError);
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', outcome: 'MOSTLY_OK' }), TypeError);
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', completeness: '' }), TypeError);
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', missingFields: 'score' }), TypeError);
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', missingFields: [''] }), TypeError);
  assert.throws(() => normalizeBackendResult({}, null), TypeError);
});

test('UI continuation envelopes require a non-empty string token and finite timing', () => {
  for (const continuation of [{}, { token: '' }, { token: 42 }, { token: null }, { token: { value: 'secret' } }]) {
    assert.throws(() => normalizeBackendResult({}, { backend: 'browser', continuation }), (error) => {
      assert.equal(error.code, 'CONTINUATION_INVALID');
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', continuation: { token: 'opaque', ttlMs: -1 } }), TypeError);
  assert.throws(() => normalizeBackendResult({}, { backend: 'browser', continuation: { token: 'opaque', issuedAt: 'yesterday' } }), TypeError);
});
