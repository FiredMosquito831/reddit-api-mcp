import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_TTL_MS,
  WRITE_TOOL_POLICY_KEYS,
  createApprovalStore,
  resolveApprovalPolicy,
} from '../src/approvals.js';
import { WRITE_TOOL_NAMES } from '../src/operations.js';
import { OperationError } from '../src/errors.js';

const ALL_WRITES = [
  'create_post',
  'reply_to_post',
  'edit_post',
  'edit_comment',
  'delete_post',
  'delete_comment',
  'save_content',
  'unsave_content',
  'vote_on_thing',
  'subscribe_to_subreddit',
  'unsubscribe_from_subreddit',
];

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-approvals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function binding(overrides = {}) {
  return {
    profileId: 'profile-1',
    accountKey: 'account-1',
    tool: 'create_post',
    targetHash: 'target-abc',
    contentHash: 'content-def',
    policyGeneration: 3,
    ...overrides,
  };
}

function autoPrompt(answer = true) {
  const calls = [];
  const prompt = async (request) => {
    calls.push(request);
    return answer;
  };
  prompt.calls = calls;
  return prompt;
}

test('the policy key list is the exact 11 write tool names and is frozen', () => {
  assert.deepEqual(WRITE_TOOL_POLICY_KEYS, ALL_WRITES);
  assert.deepEqual(WRITE_TOOL_POLICY_KEYS, WRITE_TOOL_NAMES);
  assert.ok(Object.isFrozen(WRITE_TOOL_POLICY_KEYS));
  assert.equal(APPROVAL_TTL_MS, 120_000);
});

test('confirmations default off for every write tool, including deletes', () => {
  for (const tool of ALL_WRITES) {
    assert.equal(resolveApprovalPolicy({ global: 'off', perAction: {} }, tool), false, tool);
    assert.equal(resolveApprovalPolicy({}, tool), false, tool);
  }
  assert.equal(resolveApprovalPolicy({ global: 'off' }, 'delete_post'), false);
  assert.equal(resolveApprovalPolicy({ global: 'off' }, 'delete_comment'), false);
});

test('global-on requires approval for every write and a per-action override cannot weaken it', () => {
  for (const tool of ALL_WRITES) {
    assert.equal(resolveApprovalPolicy({ global: 'on', perAction: {} }, tool), true, tool);
    assert.equal(resolveApprovalPolicy({ global: 'on', perAction: { [tool]: 'off' } }, tool), true, tool);
  }
});

test('a per-action requirement is exact to its tool and never leaks to a sibling action', () => {
  const policy = { global: 'off', perAction: { edit_post: 'on', save_content: 'on' } };
  assert.equal(resolveApprovalPolicy(policy, 'edit_post'), true);
  assert.equal(resolveApprovalPolicy(policy, 'edit_comment'), false);
  assert.equal(resolveApprovalPolicy(policy, 'save_content'), true);
  assert.equal(resolveApprovalPolicy(policy, 'unsave_content'), false);
  assert.equal(resolveApprovalPolicy(policy, 'delete_post'), false);
});

test('a one-call confirmation request may only make an action stricter', () => {
  assert.equal(resolveApprovalPolicy({ global: 'off' }, 'vote_on_thing', { requestConfirmation: true }), true);
  assert.equal(resolveApprovalPolicy({ global: 'off' }, 'vote_on_thing', { requestConfirmation: false }), false);
  assert.equal(resolveApprovalPolicy({ global: 'on' }, 'vote_on_thing', { requestConfirmation: false }), true);
  assert.equal(resolveApprovalPolicy({ global: 'on' }, 'vote_on_thing', { requestConfirmation: true }), true);
});

test('unknown tools and invalid policy values are rejected instead of guessed', () => {
  assert.throws(() => resolveApprovalPolicy({ global: 'off' }, 'get_me'), TypeError);
  assert.throws(() => resolveApprovalPolicy({ global: 'maybe' }, 'create_post'), TypeError);
  assert.throws(() => resolveApprovalPolicy({ global: 'off', perAction: { create_post: 'require' } }, 'create_post'), TypeError);
  assert.throws(() => resolveApprovalPolicy({ global: 'off', perAction: { get_me: 'on' } }, 'create_post'), TypeError);
  assert.throws(() => resolveApprovalPolicy({ global: 'off' }, 'create_post', { requestConfirmation: 'yes' }), TypeError);
  assert.throws(() => resolveApprovalPolicy(null, 'create_post'), TypeError);
});

test('a proposed action approval is pending, contains no reusable secret, and is single use', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });

  const proposal = await store.propose(binding());
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.kind, 'action');
  assert.equal(proposal.tool, 'create_post');
  assert.ok(proposal.id);
  const serialized = JSON.stringify(proposal);
  for (const word of ['token', 'secret', 'password', 'approvalCode', 'cookie']) {
    assert.equal(serialized.toLowerCase().includes(word), false, `proposal must not contain ${word}`);
  }

  const status = await store.status(proposal.id);
  assert.equal(status.status, 'pending');
  assert.equal(status.tool, 'create_post');

  const prompt = autoPrompt(true);
  const approved = await store.approveLocally(proposal.id, { prompt });
  assert.equal(prompt.calls.length, 1);
  assert.equal(approved.status, 'approved');
  assert.ok(approved.expiresAt > Date.now());
  assert.equal(JSON.stringify(approved).includes('secret'), false);

  const consumed = await store.consume(binding());
  assert.equal(consumed.approved, true);
  assert.equal(consumed.proposalId, proposal.id);

  await assert.rejects(() => store.consume(binding()), (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    return true;
  });
  assert.equal((await store.status(proposal.id)).status, 'consumed');
});

test('simultaneous consumers of one approval: exactly one succeeds', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const results = await Promise.allSettled([
    store.consume(binding()),
    store.consume(binding()),
    store.consume(binding()),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  for (const result of rejected) assert.equal(result.reason.code, 'APPROVAL_REQUIRED');
});

test('an approval expires after 120 seconds and is then unusable and unreplayable', async (t) => {
  const homeDir = await tempHome(t);
  let now = 1_000_000;
  const store = createApprovalStore({ homeDir, clock: () => now });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  now += APPROVAL_TTL_MS - 1;
  const consumed = await store.consume(binding());
  assert.equal(consumed.approved, true);

  const second = await store.propose(binding());
  await store.approveLocally(second.id, { prompt: autoPrompt(true) });
  now += APPROVAL_TTL_MS + 1;
  await assert.rejects(() => store.consume(binding()), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.equal((await store.status(second.id)).status, 'expired');
});

test('wrong profile, account, tool, target, or content is rejected', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const wrong = [
    binding({ profileId: 'profile-2' }),
    binding({ accountKey: 'account-2' }),
    binding({ tool: 'delete_post' }),
    binding({ targetHash: 'target-other' }),
    binding({ contentHash: 'content-other' }),
  ];
  for (const candidate of wrong) {
    await assert.rejects(() => store.consume(candidate), (error) => error.code === 'APPROVAL_REQUIRED');
  }

  // The original binding is still usable after all the rejected attempts.
  assert.equal((await store.consume(binding())).approved, true);
});

test('a changed policy generation is a policy error, not a silent approval', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  await assert.rejects(() => store.consume(binding({ policyGeneration: 4 })), (error) => {
    assert.equal(error.code, 'POLICY_CHANGED');
    return true;
  });
  assert.equal((await store.consume(binding())).approved, true);
});

test('approval records persist across store instances and the proposal id alone is not an approval', async (t) => {
  const homeDir = await tempHome(t);
  const first = createApprovalStore({ homeDir });
  const proposal = await first.propose(binding());
  await first.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const second = createApprovalStore({ homeDir });
  assert.equal((await second.status(proposal.id)).status, 'approved');
  assert.equal((await second.consume(binding())).approved, true);

  const raw = await readFile(join(homeDir, 'approvals.json'), 'utf8');
  assert.equal(raw.includes('refresh_token'), false);
  assert.equal(raw.includes('cookie'), false);
});

test('approveLocally requires an injected trusted prompt and never reads stdin', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());

  await assert.rejects(() => store.approveLocally(proposal.id), /local prompt/);
  await assert.rejects(() => store.approveLocally(proposal.id, { prompt: 'yes' }), /local prompt/);

  const declined = await store.approveLocally(proposal.id, { prompt: autoPrompt(false) });
  assert.equal(declined.status, 'rejected');
  await assert.rejects(() => store.consume(binding()), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('an expired or already-approved proposal cannot be approved again', async (t) => {
  const homeDir = await tempHome(t);
  let now = 2_000_000;
  const store = createApprovalStore({ homeDir, clock: () => now });
  const proposal = await store.propose(binding());

  now += 16 * 60 * 1000;
  await assert.rejects(() => store.approveLocally(proposal.id, { prompt: autoPrompt(true) }), (error) => {
    assert.equal(error.code, 'APPROVAL_REQUIRED');
    return true;
  });

  const fresh = await store.propose(binding({ contentHash: 'second' }));
  await store.approveLocally(fresh.id, { prompt: autoPrompt(true) });
  await assert.rejects(() => store.approveLocally(fresh.id, { prompt: autoPrompt(true) }), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('the binding hash is canonical: key order does not create a second approval', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const reordered = {
    contentHash: 'content-def',
    tool: 'create_post',
    accountKey: 'account-1',
    policyGeneration: 3,
    targetHash: 'target-abc',
    profileId: 'profile-1',
  };
  assert.equal((await store.consume(reordered)).approved, true);
});

test('an approval that expires during the store-lock wait is not consumed', async (t) => {
  const homeDir = await tempHome(t);
  let now = 3_000_000;
  let stall = false;
  const leases = {
    withLease: async (path, options, fn) => {
      if (stall) now += 130_000;
      return fn();
    },
  };
  const store = createApprovalStore({ homeDir, clock: () => now, leases });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  stall = true;
  await assert.rejects(() => store.consume(binding()), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.equal((await store.status(proposal.id)).status, 'expired');
});

test('consumedAt records the time after the lock wait, not the time before it', async (t) => {
  const homeDir = await tempHome(t);
  let now = 4_000_000;
  let stall = false;
  const leases = {
    withLease: async (path, options, fn) => {
      if (stall) now += 1_000;
      return fn();
    },
  };
  const store = createApprovalStore({ homeDir, clock: () => now, leases });
  const proposal = await store.propose(binding());
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  stall = true;
  await store.consume(binding());
  const raw = JSON.parse(await readFile(join(homeDir, 'approvals.json'), 'utf8'));
  const approval = raw.approvals.find((entry) => entry.proposalId === proposal.id);
  assert.equal(approval.consumedAt, now);
  assert.ok(approval.consumedAt > 4_000_000);
});

test('a decline is persisted and a rejected proposal cannot be approved later', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());

  const declined = await store.approveLocally(proposal.id, { prompt: autoPrompt(false) });
  assert.equal(declined.status, 'rejected');
  const status = await store.status(proposal.id);
  assert.equal(status.status, 'rejected');
  assert.equal(typeof status.rejectedAt, 'number');

  await assert.rejects(
    () => store.approveLocally(proposal.id, { prompt: autoPrompt(true) }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  await assert.rejects(() => store.consume(binding()), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('status is profile/account-scoped when a scope is supplied', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(binding());

  assert.equal((await store.status(proposal.id, { profileId: 'profile-1', accountKey: 'account-1' })).status, 'pending');
  assert.equal((await store.status(proposal.id, { profileId: 'profile-2' })).status, 'missing');
  assert.equal((await store.status(proposal.id, { accountKey: 'account-2' })).status, 'missing');
  await assert.rejects(() => store.status(proposal.id, { profileId: '' }), TypeError);
});

test('a LOCK_CORRUPT raised after the locked callback ran is not retried', async (t) => {
  const homeDir = await tempHome(t);
  let calls = 0;
  const leases = {
    withLease: async (path, options, fn) => {
      calls += 1;
      await fn();
      throw Object.assign(new Error('the callback raised after mutating'), { code: 'LOCK_CORRUPT' });
    },
  };
  const store = createApprovalStore({ homeDir, leases });
  await assert.rejects(() => store.propose(binding()), (error) => error.code === 'LOCK_CORRUPT');
  assert.equal(calls, 1);
});

test('a LOCK_CORRUPT observed before the callback runs is retried', async (t) => {
  const homeDir = await tempHome(t);
  let calls = 0;
  const leases = {
    withLease: async (path, options, fn) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('still being created'), { code: 'LOCK_CORRUPT' });
      return fn();
    },
  };
  const store = createApprovalStore({ homeDir, leases });
  const proposal = await store.propose(binding());
  assert.equal(proposal.status, 'pending');
  assert.equal(calls, 3);
});

test('two store instances still allow exactly one consumer of one approval', async (t) => {
  const homeDir = await tempHome(t);
  const first = createApprovalStore({ homeDir });
  const second = createApprovalStore({ homeDir });
  const proposal = await first.propose(binding());
  await first.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const results = await Promise.allSettled([
    first.consume(binding()),
    second.consume(binding()),
    first.consume(binding()),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results.filter((entry) => entry.status === 'rejected')) {
    assert.equal(result.reason.code, 'APPROVAL_REQUIRED');
  }
});

test('proposals and bindings reject malformed input and secret-bearing fields', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });

  await assert.rejects(() => store.propose(null), TypeError);
  await assert.rejects(() => store.propose(binding({ tool: 'get_me' })), TypeError);
  await assert.rejects(() => store.propose(binding({ profileId: '' })), TypeError);
  await assert.rejects(() => store.propose(binding({ policyGeneration: -1 })), TypeError);
  await assert.rejects(() => store.propose(binding({ password: 'hunter2' })), (error) => {
    assert.match(error.message, /secret/i);
    return true;
  });
  await assert.rejects(() => store.propose(binding({ refreshToken: 'rt' })), /secret/i);

  assert.equal((await store.status('missing-id')).status, 'missing');
});
