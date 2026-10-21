import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SETTINGS_PATCH_KEYS,
  classifySettingsPatch,
  createApprovalStore,
  resolveApprovalPolicy,
} from '../src/approvals.js';
import { OperationError } from '../src/errors.js';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-proposals-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function settingsBinding(overrides = {}) {
  return {
    profileId: 'profile-1',
    accountKey: 'account-1',
    tool: 'settings',
    targetHash: 'settings-target',
    contentHash: 'settings-content',
    policyGeneration: 7,
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

test('the settings allowlist covers the runtime settings and has no home, credential, or raw path key', () => {
  assert.ok(Object.isFrozen(SETTINGS_PATCH_KEYS));
  for (const key of ['safeMode', 'maxWritesPerHour', 'botFooter', 'cacheTtlMs', 'maxAttempts',
    'backendPreference', 'enabledBackends', 'visibility', 'confirmations', 'browser', 'sampling']) {
    assert.ok(SETTINGS_PATCH_KEYS.includes(key), key);
  }
  for (const key of ['homeDir', 'password', 'clientSecret', 'refreshToken', 'clientId', 'userAgent', 'scopes']) {
    assert.equal(SETTINGS_PATCH_KEYS.includes(key), false, key);
  }
});

test('operational settings changes classify as operational without touching approval policy', () => {
  const visibility = classifySettingsPatch({ visibility: 'hidden', backendPreference: 'auto' });
  assert.equal(visibility.classification, 'operational');
  assert.deepEqual([...visibility.keys].sort(), ['backendPreference', 'visibility']);

  assert.equal(classifySettingsPatch({ enabledBackends: ['api', 'browser'] }).classification, 'operational');
  assert.equal(classifySettingsPatch({ sampling: { enabled: true } }).classification, 'operational');
  assert.equal(classifySettingsPatch({ browser: { enabled: true } }).classification, 'operational');
  assert.equal(classifySettingsPatch({ safeMode: 'strict', maxWritesPerHour: 5 }).classification, 'operational');

  for (const patch of [
    { visibility: 'hidden' },
    { backendPreference: 'browser' },
    { enabledBackends: ['browser'] },
    { sampling: { enabled: true } },
  ]) {
    const result = classifySettingsPatch(patch);
    assert.equal(result.affectsApprovals, false);
    assert.equal(result.securityKeys.length, 0);
  }
});

test('approval-policy and stored-password changes classify as security changes that require local approval', () => {
  for (const patch of [
    { confirmations: { global: 'on' } },
    { confirmations: { perAction: { delete_post: 'on' } } },
    { browser: { passwordLoginEnabled: true } },
  ]) {
    const result = classifySettingsPatch(patch);
    assert.equal(result.classification, 'security', JSON.stringify(patch));
    assert.equal(result.affectsApprovals, true);
    assert.ok(result.securityKeys.length > 0);
  }

  const mixed = classifySettingsPatch({ visibility: 'hidden', confirmations: { global: 'on' } });
  assert.equal(mixed.classification, 'security');
  assert.deepEqual([...mixed.keys].sort(), ['confirmations', 'visibility']);
});

test('a settings proposal is pending, shown to the local prompt with risks, and never carries secrets', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const patch = { confirmations: { global: 'on' }, visibility: 'hidden' };
  const proposal = await store.propose(settingsBinding(), patch);

  assert.equal(proposal.kind, 'settings');
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.classification, 'security');
  assert.deepEqual(proposal.patch, patch);
  assert.ok(Object.isFrozen(proposal.patch));
  assert.ok(proposal.binding);
  const serialized = JSON.stringify(proposal).toLowerCase();
  for (const word of ['password', 'secret', 'token', 'cookie', 'approvalcode']) {
    assert.equal(serialized.includes(word), false, `proposal must not contain ${word}`);
  }

  const prompt = autoPrompt(true);
  const approved = await store.approveLocally(proposal.id, { prompt });
  assert.equal(prompt.calls.length, 1);
  const request = prompt.calls[0];
  assert.equal(request.kind, 'settings');
  assert.equal(request.classification, 'security');
  assert.deepEqual(request.patch, patch);
  assert.ok(Array.isArray(request.risks) && request.risks.length > 0);

  const consumed = await store.consume(proposal.binding);
  assert.equal(consumed.approved, true);
  assert.equal(consumed.kind, 'settings');
  assert.deepEqual(consumed.patch, patch);
  await assert.rejects(() => store.consume(proposal.binding), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('a declined settings proposal is rejected and cannot be consumed', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { confirmations: { global: 'on' } });

  const declined = await store.approveLocally(proposal.id, { prompt: autoPrompt(false) });
  assert.equal(declined.status, 'rejected');
  assert.equal((await store.status(proposal.id)).status, 'rejected');
  await assert.rejects(
    () => store.approveLocally(proposal.id, { prompt: autoPrompt(true) }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  await assert.rejects(() => store.consume(proposal.binding), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('a settings approval cannot be consumed from a different profile or account', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { visibility: 'hidden' });
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  for (const override of [
    { profileId: 'profile-2' },
    { accountKey: 'account-2' },
  ]) {
    await assert.rejects(
      () => store.consume({ ...proposal.binding, ...override }),
      (error) => error.code === 'APPROVAL_REQUIRED',
    );
  }
  assert.equal((await store.consume(proposal.binding)).approved, true);
});

test('the passwordLoginEnabled exemption from the secret-name check is scoped to browser', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });

  // The allowlisted boolean exception is accepted exactly where it is declared.
  const proposal = await store.propose(settingsBinding(), { browser: { passwordLoginEnabled: true } });
  assert.equal(proposal.classification, 'security');

  // The same key name elsewhere is still refused as secret-shaped, not merely as an unknown key.
  await assert.rejects(
    () => store.propose(settingsBinding(), { sampling: { passwordLoginEnabled: true } }),
    /secret/i,
  );
  await assert.rejects(
    () => store.propose(settingsBinding(), { browser: { passwordLoginEnabled: true, password: 'x' } }),
    /secret/i,
  );
});

test('settings proposals reject secret fields, raw paths, unknown keys, and confirm booleans', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const bad = [
    { password: 'hunter2' },
    { clientSecret: 'shh' },
    { refreshToken: 'rt' },
    { browser: { passwordLoginEnabled: true, password: 'hunter2' } },
    { credentials: { username: 'alice' } },
    { session: { cookie: 'x' } },
    { homeDir: 'D:/elsewhere' },
    { confirm: true },
    { confirmations: { global: 'yes' } },
    { confirmations: { perAction: { get_me: 'on' } } },
    { visibility: 'invisible' },
    { enabledBackends: ['desktop'] },
    { maxWritesPerHour: 0 },
  ];
  for (const patch of bad) {
    await assert.rejects(() => store.propose(settingsBinding(), patch), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(['INVALID_PATCH', 'APPROVAL_REQUIRED'].includes(error.code) || error instanceof TypeError);
      return true;
    }, JSON.stringify(patch));
  }

  const secret = await store.propose(settingsBinding(), { password: 'hunter2' }).then(
    () => null,
    (error) => error,
  );
  assert.ok(secret);
  assert.match(secret.message, /secret|allowlist/i);
});

test('a settings approval is bound to its exact patch and cannot authorize a different one', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { visibility: 'hidden' });
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const different = {
    ...proposal.binding,
    contentHash: 'some-other-content',
  };
  await assert.rejects(() => store.consume(different), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.equal((await store.consume(proposal.binding)).approved, true);
});

test('settings approval is local-only: no MCP-style caller can approve by passing confirm or a result', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { confirmations: { global: 'on' } });

  await assert.rejects(() => store.approveLocally(proposal.id), /local prompt/);
  await assert.rejects(() => store.approveLocally(proposal.id, { prompt: true }), /local prompt/);
  await assert.rejects(() => store.consume(proposal.binding), (error) => error.code === 'APPROVAL_REQUIRED');

  assert.equal(typeof resolveApprovalPolicy, 'function');
});

test('an operational proposal is still a two-step local approval, but focuses its risk text on operations', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { visibility: 'hidden', sampling: { enabled: false } });
  assert.equal(proposal.classification, 'operational');

  const prompt = autoPrompt(true);
  await store.approveLocally(proposal.id, { prompt });
  assert.equal(prompt.calls[0].classification, 'operational');
  assert.ok(prompt.calls[0].risks.every((risk) => typeof risk === 'string'));
  assert.equal((await store.consume(proposal.binding)).approved, true);
});

test('proposal/status output exposes no reusable approval secret and a proposal id alone cannot consume', async (t) => {
  const homeDir = await tempHome(t);
  const store = createApprovalStore({ homeDir });
  const proposal = await store.propose(settingsBinding(), { confirmations: { global: 'on' } });
  await store.approveLocally(proposal.id, { prompt: autoPrompt(true) });

  const status = await store.status(proposal.id);
  assert.equal(status.status, 'approved');
  const serialized = JSON.stringify(status).toLowerCase();
  for (const word of ['password', 'secret', 'token', 'cookie', 'approvalcode', 'bearer']) {
    assert.equal(serialized.includes(word), false);
  }

  // The proposal id is visible but is not itself a credential.
  await assert.rejects(() => store.consume({ proposalId: proposal.id }), (error) => error instanceof Error);
  assert.equal((await store.consume(proposal.binding)).approved, true);
});
