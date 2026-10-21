import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttemptLedger } from '../src/attempts.js';
import { createWriteBoundary } from '../src/write-boundary.js';
import { OperationError, OUTCOMES } from '../src/errors.js';

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function clockAt(start = 1_000_000) {
  const clock = {
    time: start,
    sleeps: [],
    async sleep(ms) {
      clock.sleeps.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

function operation(overrides = {}) {
  return Object.freeze({
    tool: 'reply_to_post',
    action: 'comment',
    kind: 'write',
    policyKey: 'reply_to_post',
    target: 't3_abc123',
    contentHash: 'a'.repeat(64),
    requiresIdentity: true,
    args: Object.freeze({}),
    ...overrides,
  });
}

function callContext(overrides = {}) {
  return {
    callId: 'call-1',
    accountKey: ACCOUNT,
    backendId: 'api',
    profile: { id: 'profile-1', alias: 'main', username: 'tester', policyGeneration: 3 },
    ...overrides,
  };
}

function fakeApprovalStore({ reject = null } = {}) {
  const consumed = [];
  return {
    consumed,
    async consume(binding) {
      consumed.push(binding);
      if (reject) throw reject;
      return { approved: true, proposalId: 'proposal-1' };
    },
  };
}

function fakeCacheGeneration(start = 5) {
  let generation = start;
  const bumps = [];
  return {
    bumps,
    async current() {
      return generation;
    },
    async bump() {
      bumps.push(generation + 1);
      generation += 1;
      return generation;
    },
  };
}

function harness(home, options = {}) {
  const clock = options.clock ?? clockAt();
  const ledger = createAttemptLedger({
    homeDir: home,
    accountKey: ACCOUNT,
    clock: () => clock.time,
    ...(options.ledger ?? {}),
  });
  const approvals = options.approvalStore === undefined ? fakeApprovalStore() : options.approvalStore;
  const cacheGeneration = options.cacheGeneration ?? fakeCacheGeneration();
  const boundary = createWriteBoundary({
    ledger,
    policy: options.policy ?? { global: 'off', perAction: {} },
    approvalStore: approvals,
    revalidate: options.revalidate ?? null,
    clock: () => clock.time,
    sleep: clock.sleep,
    limits: options.limits ?? { minGapMs: 0, maxWritesPerHour: 30 },
    cacheGeneration,
  });
  return { clock, ledger, approvals, cacheGeneration, boundary };
}

test('one call reserves, prepares, dispatches, and commits exactly once', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger, cacheGeneration } = harness(home);
  const calls = { prepare: 0, commit: 0 };

  const result = await boundary.run({
    operation: operation(),
    context: callContext(),
    prepare: async () => {
      calls.prepare += 1;
      return { prepared: true };
    },
    commit: async (prepared) => {
      calls.commit += 1;
      assert.deepEqual(prepared, { prepared: true });
      return { id: 't1_comment' };
    },
  });

  assert.deepEqual(calls, { prepare: 1, commit: 1 });
  assert.deepEqual(result.data, { id: 't1_comment' });
  assert.equal(result.meta.outcome, OUTCOMES.SUCCEEDED);
  assert.equal(result.meta.backend, 'api');
  assert.equal(result.meta.profile, 'main');
  assert.ok(result.meta.attemptId);
  assert.deepEqual(await ledger.listPending(), []);
  assert.deepEqual(cacheGeneration.bumps, [6]);
  assert.equal(cacheGeneration.bumps.length, 1);
});

test('non-write operations and unverified accounts reserve nothing', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);
  const commit = async () => 'never';

  await assert.rejects(
    boundary.run({ operation: operation({ kind: 'read' }), context: callContext(), commit }),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
  await assert.rejects(
    boundary.run({ operation: operation(), context: callContext({ accountKey: undefined }), commit }),
    (error) => error.code === 'IDENTITY_UNVERIFIED',
  );
  await assert.rejects(
    boundary.run({ operation: operation(), context: callContext({ accountKey: 'acct_fedcba9876543210fedcba9876543210' }), commit }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  assert.deepEqual(await ledger.listPending(), []);
});

test('an app-only session refuses before anything is reserved', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);
  let committed = false;

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext({ authMode: 'app' }),
      commit: async () => {
        committed = true;
      },
    }),
    (error) => error.code === 'APP_ONLY_READ_ONLY',
  );
  assert.equal(committed, false);
  assert.deepEqual(await ledger.listPending(), []);
});

test('a required approval consumes the exact operation binding before commit, and confirm alone is not proof', async (t) => {
  const home = await tempHome(t);
  const events = [];

  // Without a trusted local approval store, a required approval fails closed even when the model
  // supplies confirm: true. The reservation is released and nothing is dispatched.
  const noStore = harness(home, { policy: { global: 'on', perAction: {} }, approvalStore: null });
  await assert.rejects(
    noStore.boundary.run({
      operation: operation({ args: Object.freeze({ confirm: true }) }),
      context: callContext(),
      prepare: async () => {
        events.push('prepare');
      },
      commit: async () => {
        events.push('commit');
      },
    }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.deepEqual(events, ['prepare']);
  assert.deepEqual(noStore.cacheGeneration.bumps, []);
  assert.deepEqual(await noStore.ledger.listPending(), []);

  // With a matching local approval, the exact binding is consumed once, before the commit.
  const approvalStore = {
    async consume(binding) {
      events.push('approve');
      assert.equal(binding.tool, 'reply_to_post');
      assert.equal(binding.profileId, 'profile-1');
      assert.equal(binding.accountKey, ACCOUNT);
      assert.equal(binding.contentHash, 'a'.repeat(64));
      assert.equal(binding.policyGeneration, 3);
      assert.equal(binding.targetHash, createHash('sha256').update('t3_abc123').digest('hex'));
      return { approved: true };
    },
  };
  const approving = harness(home, { policy: { global: 'on', perAction: {} }, approvalStore });
  const result = await approving.boundary.run({
    operation: operation({ args: Object.freeze({ confirm: true }) }),
    context: callContext(),
    commit: async () => {
      events.push('commit');
      return { ok: true };
    },
  });
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(events, ['prepare', 'approve', 'commit']);
});

test('a per-action policy requires approval only for its own tool', async (t) => {
  const home = await tempHome(t);
  const approvalStore = fakeApprovalStore();
  const { boundary } = harness(home, {
    policy: { global: 'off', perAction: { delete_post: 'on' } },
    approvalStore,
  });

  await boundary.run({ operation: operation(), context: callContext(), commit: async () => ({ ok: true }) });
  assert.equal(approvalStore.consumed.length, 0);

  await boundary.run({
    operation: operation({ tool: 'delete_post', action: 'deleteThing', policyKey: 'delete_post', contentHash: null }),
    context: callContext(),
    commit: async () => ({ ok: true }),
  });
  assert.equal(approvalStore.consumed.length, 1);
});

test('policy preflight and stale generations cancel without preparing or committing', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  let revalidations = 0;
  const { boundary, ledger, cacheGeneration } = harness(home, {
    clock,
    revalidate: async () => {
      revalidations += 1;
      if (revalidations === 2) throw new OperationError('POLICY_CHANGED', 'policy changed while queued');
    },
  });
  let committed = false;

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      prepare: async () => ({ ready: true }),
      commit: async () => {
        committed = true;
      },
    }),
    (error) => error.code === 'POLICY_CHANGED',
  );
  assert.equal(revalidations, 2);
  assert.equal(committed, false);
  assert.deepEqual(await ledger.listPending(), []);
  assert.deepEqual(cacheGeneration.bumps, []);

  // A rejected revalidation before reservation also records nothing.
  const rejecting = createWriteBoundary({
    ledger,
    policy: { global: 'off', perAction: {} },
    revalidate: async () => {
      throw new OperationError('IDENTITY_MISMATCH', 'account changed');
    },
    clock: () => clock.time,
    limits: { minGapMs: 0 },
  });
  await assert.rejects(rejecting.run({ operation: operation(), context: callContext(), commit: async () => null }), (error) => error.code === 'IDENTITY_MISMATCH');
  assert.deepEqual(await ledger.listPending(), []);
});

test('a preparation failure cancels the reservation and never marks dispatch', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);
  let marked = false;
  const wrapped = {
    ...ledger,
    markDispatched: async (id) => {
      marked = true;
      return ledger.markDispatched(id);
    },
  };
  const guarded = createWriteBoundary({
    ledger: wrapped,
    policy: { global: 'off', perAction: {} },
    approvalStore: null,
    clock: () => 1_000_000,
    limits: { minGapMs: 0 },
  });

  await assert.rejects(
    guarded.run({
      operation: operation(),
      context: callContext(),
      prepare: async () => {
        throw new OperationError('USER_HANDOFF_REQUIRED', 'challenge');
      },
      commit: async () => {
        throw new Error('unreachable');
      },
    }),
    (error) => error.code === 'USER_HANDOFF_REQUIRED',
  );
  assert.equal(marked, false);
  assert.deepEqual(await ledger.listPending(), []);
});

test('a definite known rejection frees the reservation and does not invalidate the cache', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger, cacheGeneration } = harness(home);
  const rejection = new OperationError('THROTTLED', 'Reddit rejected the write', { outcome: OUTCOMES.FAILED_KNOWN });

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      prepare: async () => ({ ready: true }),
      commit: async () => {
        throw rejection;
      },
    }),
    (error) => {
      assert.equal(error.code, 'THROTTLED');
      assert.equal(error.outcome, OUTCOMES.FAILED_KNOWN);
      assert.equal(error.message, rejection.message);
      assert.equal(error.safeDetails.attemptId.length > 0, true);
      return true;
    },
  );
  assert.deepEqual(cacheGeneration.bumps, []);
  assert.deepEqual(await ledger.listPending(), []);

  // The duplicate is free again after a known rejection.
  const again = await boundary.run({
    operation: operation(),
    context: callContext(),
    commit: async () => ({ ok: true }),
  });
  assert.deepEqual(again.data, { ok: true });
});

test('an ambiguous commit failure becomes durable unknown, invalidates caches, and blocks retries', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger, cacheGeneration } = harness(home);
  let commits = 0;

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      prepare: async () => ({ ready: true }),
      commit: async () => {
        commits += 1;
        throw new Error('socket hang up');
      },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, 'OUTCOME_UNKNOWN');
      assert.equal(error.outcome, OUTCOMES.OUTCOME_UNKNOWN);
      assert.ok(!String(error.message).includes('socket hang up'));
      return true;
    },
  );

  const pending = await ledger.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'OUTCOME_UNKNOWN');
  assert.deepEqual(cacheGeneration.bumps, [6]);

  // A restart tries the same write: it must not dispatch again.
  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      commit: async () => {
        commits += 1;
      },
    }),
    (error) => error.code === 'DUPLICATE_WRITE',
  );
  assert.equal(commits, 1);
});

test('an operation error without an outcome is treated as unknown after dispatch', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      commit: async () => {
        throw new OperationError('STEP_STALE', 'the UI moved');
      },
    }),
    (error) => {
      assert.equal(error.code, 'STEP_STALE');
      assert.equal(error.outcome, OUTCOMES.OUTCOME_UNKNOWN);
      return true;
    },
  );
  const [pending] = await ledger.listPending();
  assert.equal(pending.state, 'OUTCOME_UNKNOWN');
});

test('null content hashes still detect target-only conflicts', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);
  const deletion = operation({
    tool: 'delete_post',
    action: 'deleteThing',
    policyKey: 'delete_post',
    contentHash: null,
  });

  await assert.rejects(
    boundary.run({
      operation: deletion,
      context: callContext(),
      commit: async () => {
        throw new Error('timeout');
      },
    }),
    (error) => error.code === 'OUTCOME_UNKNOWN',
  );
  await assert.rejects(
    boundary.run({ operation: deletion, context: callContext(), commit: async () => ({}) }),
    (error) => error.code === 'DUPLICATE_WRITE',
  );
  // A different target or a different operation kind remains possible.
  const other = await boundary.run({
    operation: operation({ target: 't3_other', policyKey: 'delete_post', contentHash: null }),
    context: callContext(),
    commit: async () => ({ ok: true }),
  });
  assert.deepEqual(other.data, { ok: true });
  assert.equal((await ledger.listPending()).length, 1);
});

test('spacing is enforced between committed writes of one account', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const { boundary } = harness(home, { clock, limits: { minGapMs: 2_000 } });
  const committedAt = [];

  for (const [index, content] of ['a', 'b'].entries()) {
    await boundary.run({
      operation: operation({ target: `t3_${index}`, contentHash: content.repeat(64) }),
      context: callContext(),
      commit: async () => {
        committedAt.push(clock.time);
        return { ok: true };
      },
    });
  }

  assert.deepEqual(clock.sleeps, [2_000]);
  assert.equal(committedAt[1] - committedAt[0], 2_000);
});

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setImmediate(done));
  }
}

test('spacing is re-enforced at the durable dispatch point after an approval blocks', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  let releasePrepare;
  let releaseApproval;
  const prepareGate = new Promise((done) => {
    releasePrepare = done;
  });
  const approvalGate = new Promise((done) => {
    releaseApproval = done;
  });
  let firstPreparing = false;
  // The second call reaches its approval prompt only after its scheduling wait has finished. Waiting
  // for that point (rather than for a clock value, which the sleep sets before the call resumes) keeps
  // the sequence deterministic when the test runner is under CPU contention.
  let signalApprovalWait;
  const approvalReached = new Promise((done) => {
    signalApprovalWait = done;
  });
  const approvalStore = {
    async consume() {
      signalApprovalWait();
      await approvalGate;
      return { approved: true };
    },
  };
  let revalidations = 0;
  const { boundary } = harness(home, {
    clock,
    policy: { global: 'off', perAction: { create_post: 'on' } },
    approvalStore,
    revalidate: async () => {
      revalidations += 1;
    },
    limits: { minGapMs: 2_000, maxWritesPerHour: 30 },
  });
  const commits = [];

  const first = boundary.run({
    operation: operation(),
    context: callContext(),
    prepare: async () => {
      firstPreparing = true;
      return prepareGate;
    },
    commit: async () => {
      commits.push(['first', clock.time]);
      return { ok: true };
    },
  });
  await waitUntil(() => firstPreparing, 'first prepare');

  const second = boundary.run({
    operation: operation({
      tool: 'create_post',
      action: 'submit',
      policyKey: 'create_post',
      target: 't3_other',
      contentHash: 'b'.repeat(64),
    }),
    context: callContext({ callId: 'call-2' }),
    prepare: async () => ({ ready: true }),
    commit: async () => {
      commits.push(['second', clock.time]);
      return { ok: true };
    },
  });

  // The second call reached its slot (clock advanced by the gap) and is now waiting on the approval.
  await approvalReached;
  assert.ok(clock.time >= 1_002_000, 'the second call waited for the spacing slot');
  clock.time += 1_000;
  releasePrepare();
  await first;
  releaseApproval();
  await second;

  // The second dispatch was pushed to the next spacing slot instead of going out with the first.
  assert.deepEqual(commits, [['first', 1_003_000], ['second', 1_005_000]]);
  // Preflight + commit for both calls, plus one revalidation after the second call's extra wait.
  assert.equal(revalidations, 5);
});

test('a cache bump failure never masks a durable unknown outcome', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const cacheGeneration = {
    async bump() {
      throw new Error('cache generation store unavailable');
    },
  };
  const { boundary, ledger } = harness(home, { clock, cacheGeneration });

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      commit: async () => {
        throw new Error('socket hang up');
      },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, 'OUTCOME_UNKNOWN');
      assert.equal(error.outcome, OUTCOMES.OUTCOME_UNKNOWN);
      return true;
    },
  );
  const [pending] = await ledger.listPending();
  assert.equal(pending.state, OUTCOMES.OUTCOME_UNKNOWN);
});

test('an already-unknown operation error still carries its attempt id', async (t) => {
  const home = await tempHome(t);
  const { boundary, ledger } = harness(home);

  await assert.rejects(
    boundary.run({
      operation: operation(),
      context: callContext(),
      commit: async () => {
        throw new OperationError('STEP_STALE', 'the UI moved', { outcome: OUTCOMES.OUTCOME_UNKNOWN });
      },
    }),
    (error) => {
      assert.equal(error.code, 'STEP_STALE');
      assert.equal(error.outcome, OUTCOMES.OUTCOME_UNKNOWN);
      assert.equal(typeof error.safeDetails.attemptId, 'string');
      return true;
    },
  );
  const [pending] = await ledger.listPending();
  assert.equal(pending.state, OUTCOMES.OUTCOME_UNKNOWN);
});

test('a rejected cache bump surfaces after the durable success without claiming the write failed', async (t) => {
  const home = await tempHome(t);
  const clock = clockAt();
  const cacheGeneration = {
    async bump() {
      throw new Error('cache generation store unavailable');
    },
  };
  const { boundary, ledger } = harness(home, { clock, cacheGeneration });

  await assert.rejects(
    boundary.run({ operation: operation(), context: callContext(), commit: async () => ({ ok: true }) }),
    /cache generation store unavailable/,
  );
  assert.deepEqual(await ledger.listPending(), []);
});
