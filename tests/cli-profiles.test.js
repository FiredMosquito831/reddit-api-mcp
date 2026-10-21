// Named-profile CLI controls, driven directly with injected services and a temporary home directory.
// No OS keychain, browser, Reddit request, or real ~/.reddit-cli is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { createAccountRegistry } from '../src/accounts.js';
import { createApprovalStore } from '../src/approvals.js';
import { readRuntimeSettings } from '../src/config.js';
import { effectiveApprovalPolicy } from '../src/dispatch.js';
import { addProfileCommands, approvalAccountKeyFor, logoutProfile } from '../src/cli-profiles.js';
import { createProfileRegistry } from '../src/profiles.js';

function fakeSecretStore(initial = []) {
  const values = new Map(initial);
  return {
    values,
    ref: (profileId, name) => `ref:${profileId}:${name}`,
    async get(ref) {
      return values.has(ref) ? values.get(ref) : null;
    },
    async set(ref, value) {
      values.set(ref, value);
    },
    async delete(ref) {
      return values.delete(ref);
    },
  };
}

function fakeBrowserSessions({ closeResult } = {}) {
  return {
    closed: [],
    async close(profileId, options) {
      this.closed.push({ profileId, options });
      return closeResult ?? {
        closed: true,
        profileId,
        localOnly: false,
        remoteLogoutRequested: true,
        remoteLogoutFailed: false,
      };
    },
  };
}

async function harness({ interactive = true, promptAnswer = true, closeResult, statusOverride } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cli-profiles-'));
  const settings = readRuntimeSettings({ REDDIT_CLI_HOME: home });
  const registry = createProfileRegistry({ homeDir: home });
  const accounts = createAccountRegistry({ registry });
  const approvals = createApprovalStore({ homeDir: home });
  const secretStore = fakeSecretStore();
  const browserSessions = fakeBrowserSessions({ closeResult });
  const lines = [];
  const prompts = [];
  const hiddenQuestions = [];
  const textQuestions = [];
  let hiddenAnswers = [];

  const dispatcher = {
    async status(selector) {
      if (statusOverride) return await statusOverride({ registry, selector });
      const snapshot = selector ? await registry.snapshot(selector) : await registry.get(null);
      if (!snapshot) throw new Error('No default profile is set.');
      return {
        profile: {
          id: snapshot.id,
          alias: snapshot.alias,
          isLegacy: false,
          isDefault: snapshot.isDefault,
          expectedUsername: snapshot.expectedUsername,
          username: snapshot.username,
          accountKey: snapshot.accountKey,
          accountId: snapshot.accountId,
          bound: Boolean(snapshot.accountKey),
        },
        defaultProfile: (await registry.get(null))?.alias ?? null,
        enabledBackends: snapshot.enabledBackends,
        backendPreference: snapshot.backendPreference,
        visibility: snapshot.visibility,
        passwordLoginEnabled: snapshot.passwordLoginEnabled,
        confirmations: snapshot.confirmations,
        api: snapshot.api,
        approvalPolicy: { global: 'off', perAction: {} },
        pendingAttempts: [],
      };
    },
    async pendingAttempts(selector) {
      this.resolved = selector ?? null;
      return [];
    },
    async resolveAttempt(selector, attemptId, resolution) {
      this.resolution = { selector, attemptId, resolution };
      return { id: attemptId, state: resolution.outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED_KNOWN', resolution: 'local' };
    },
  };

  const services = {
    homeDir: home,
    settings,
    registry,
    accounts,
    approvals,
    secretStore,
    browserSessions,
    dispatcher,
  };
  const deps = {
    services: () => services,
    settings: () => settings,
    out: (line) => lines.push(String(line)),
    err: (line) => lines.push(String(line)),
    interactive: () => interactive,
    askText: async (question) => {
      textQuestions.push(question);
      return textQuestions.length === 0 ? '' : (deps.textAnswer ?? '');
    },
    askHidden: async (question) => {
      hiddenQuestions.push(question);
      return hiddenAnswers.shift() ?? '';
    },
    promptApproval: async (request) => {
      prompts.push(request);
      return promptAnswer;
    },
  };
  const cleanup = () => rm(home, { recursive: true, force: true });
  const setHiddenAnswers = (values) => { hiddenAnswers = [...values]; };
  return {
    home, settings, registry, accounts, approvals, secretStore, browserSessions, services, deps, lines, prompts,
    hiddenQuestions, textQuestions, cleanup, setHiddenAnswers,
  };
}

function programFor(deps) {
  const program = new Command().name('t');
  program.exitOverride();
  addProfileCommands(program, deps);
  return program;
}

async function run(deps, args) {
  return await programFor(deps).parseAsync(['node', 't', ...args]);
}

test('profile add stores public metadata and list/default report it', async () => {
  const h = await harness();
  try {
    await run(h.deps, ['profile', 'add', 'alice', '--username', 'Alice', '--api-client-id', 'cid', '--app-type', 'installed']);
    const profiles = await h.registry.list();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].alias, 'alice');
    assert.equal(profiles[0].expectedUsername, 'Alice');
    assert.deepEqual(profiles[0].api, { clientId: 'cid', appType: 'installed' });
    assert.ok(h.lines.some((line) => line.includes('Added profile "alice"')));

    await run(h.deps, ['profile', 'default', 'alice']);
    assert.equal((await h.registry.get(null)).alias, 'alice');
    assert.ok(h.lines.some((line) => line.includes('Default profile: alice')));

    h.lines.length = 0;
    await run(h.deps, ['profile', 'list']);
    assert.ok(h.lines.some((line) => line.includes('alice')));
    assert.ok(h.lines.some((line) => line.startsWith('*')));

    h.lines.length = 0;
    await run(h.deps, ['profile', 'default']);
    assert.ok(h.lines.some((line) => line.includes('Default profile: alice')));
  } finally {
    await h.cleanup();
  }
});

test('profile add rejects an unknown app type before anything is stored', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      run(h.deps, ['profile', 'add', 'alice', '--app-type', 'desktop']),
      /--app-type must be script, web, or installed/,
    );
    assert.deepEqual(await h.registry.list(), []);
  } finally {
    await h.cleanup();
  }
});

test('profile status shows the resolved policy and supports --json', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    await h.registry.setDefault(record.id);
    await run(h.deps, ['profile', 'status']);
    assert.ok(h.lines.some((line) => line.includes('Profile: alice')));
    assert.ok(h.lines.some((line) => line.includes('Effective approval policy')));
    h.lines.length = 0;
    await run(h.deps, ['profile', 'status', '--json']);
    const parsed = JSON.parse(h.lines.join('\n'));
    assert.equal(parsed.profile.alias, 'alice');
    assert.equal(parsed.approvalPolicy.global, 'off');
  } finally {
    await h.cleanup();
  }
});

test('profile configure applies operational settings without a local prompt', async () => {
  const h = await harness();
  try {
    await h.registry.add({ alias: 'alice' });
    await run(h.deps, [
      'profile', 'configure', 'alice',
      '--enable-backends', 'api,replay',
      '--preference', 'api,replay',
      '--visibility', 'headless',
    ]);
    const record = await h.registry.snapshot('alice');
    assert.deepEqual(record.enabledBackends, ['api', 'replay']);
    assert.deepEqual(record.backendPreference, ['api', 'replay']);
    assert.equal(record.visibility, 'headless');
    assert.equal(h.prompts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('an approval-policy change requires a trusted local prompt and cannot be done non-interactively', async () => {
  const nonInteractive = await harness({ interactive: false });
  try {
    await nonInteractive.registry.add({ alias: 'alice' });
    await assert.rejects(
      run(nonInteractive.deps, ['profile', 'configure', 'alice', '--confirmation-global', 'on']),
      /needs an interactive local approval/,
    );
    assert.deepEqual((await nonInteractive.registry.snapshot('alice')).confirmations, {});
  } finally {
    await nonInteractive.cleanup();
  }

  const declined = await harness({ promptAnswer: false });
  try {
    await declined.registry.add({ alias: 'alice' });
    await assert.rejects(
      run(declined.deps, ['profile', 'configure', 'alice', '--confirmation-global', 'on']),
      /declined/,
    );
    assert.deepEqual((await declined.registry.snapshot('alice')).confirmations, {});
    assert.equal(declined.prompts.length, 1);
  } finally {
    await declined.cleanup();
  }

  const approved = await harness({ promptAnswer: true });
  try {
    await approved.registry.add({ alias: 'alice' });
    await run(approved.deps, [
      'profile', 'configure', 'alice',
      '--confirmation-global', 'on',
      '--confirmation', 'create_post=on',
    ]);
    const record = await approved.registry.snapshot('alice');
    assert.equal(record.confirmations.global, true);
    assert.equal(record.confirmations.create_post, true);
    // The stored profile map is the shape the dispatcher reads: booleans plus `global`.
    const effective = effectiveApprovalPolicy(approved.settings, await approved.registry.snapshot('alice'));
    assert.equal(effective.global, 'on');
    assert.equal(effective.perAction.create_post, 'on');
    assert.equal(approved.prompts.length, 1);
    assert.equal(approved.prompts[0].kind, 'settings');
    assert.ok(approved.lines.some((line) => line.startsWith('Risk: ')));
    // The approval was consumed, so it cannot authorize a second application.
    const consumed = await approved.approvals.status(approved.prompts[0].id);
    assert.equal(consumed.status, 'consumed');
  } finally {
    await approved.cleanup();
  }
});

test('profile configure refuses to overwrite a settings change made during the prompt', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    // Another process enables a different confirmation while this one waits for its local prompt.
    h.deps.promptApproval = async () => {
      await h.registry.update(record.id, { confirmations: { save_content: true } });
      return true;
    };
    await assert.rejects(
      run(h.deps, ['profile', 'configure', 'alice', '--confirmation-global', 'on']),
      (error) => error.code === 'POLICY_CHANGED',
    );
    const current = await h.registry.snapshot('alice');
    assert.deepEqual(current.confirmations, { save_content: true });
  } finally {
    await h.cleanup();
  }
});

test('profile configure rejects unknown confirmation keys and dry-run changes nothing', async () => {
  const h = await harness();
  try {
    await h.registry.add({ alias: 'alice' });
    await assert.rejects(
      run(h.deps, ['profile', 'configure', 'alice', '--confirmation', 'not_a_tool=on']),
      /Unknown write tool/,
    );
    h.lines.length = 0;
    await run(h.deps, ['profile', 'configure', 'alice', '--confirmation-global', 'on', '--dry-run']);
    assert.ok(h.lines.some((line) => line.includes('Dry run')));
    assert.ok(h.lines.some((line) => line.includes('Classification: security')));
    assert.deepEqual((await h.registry.snapshot('alice')).confirmations, {});
    assert.equal(h.prompts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('profile approve-settings applies an MCP-created settings proposal after local approval', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    const proposal = await h.approvals.propose({
      profileId: record.id,
      accountKey: 'acct_' + '0'.repeat(32),
      tool: 'settings',
      policyGeneration: record.policyGeneration,
    }, { confirmations: { global: 'on', perAction: { create_post: 'on' } } });
    await run(h.deps, ['profile', 'approve-settings', proposal.id]);
    assert.equal(h.prompts.length, 1);
    assert.ok(h.lines.some((line) => line.includes('Risk: ')));
    assert.ok(!h.lines.some((line) => line.includes('av_')));
    // The approved patch is applied to the profile registry, not merely recorded.
    const updated = await h.registry.snapshot(record.id);
    assert.equal(updated.confirmations.global, true);
    assert.equal(updated.confirmations.create_post, true);
    assert.ok(h.lines.some((line) => line.includes('Applied')));
    // The approval is consumed, so it cannot be applied again.
    const status = await h.approvals.status(proposal.id);
    assert.equal(status.status, 'consumed');
    await assert.rejects(
      run(h.deps, ['profile', 'approve-settings', proposal.id]),
      /consumed/,
    );
  } finally {
    await h.cleanup();
  }
});

test('profile approve-settings --json prints one parseable result', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    const proposal = await h.approvals.propose({
      profileId: record.id,
      accountKey: 'acct_' + '0'.repeat(32),
      tool: 'settings',
      policyGeneration: record.policyGeneration,
    }, { confirmations: { global: 'on' } });
    await run(h.deps, ['profile', 'approve-settings', proposal.id, '--json']);
    const parsed = JSON.parse(h.lines.join('\n'));
    assert.equal(parsed.status, 'approved');
    assert.deepEqual(parsed.applied.applied, ['confirmations']);
  } finally {
    await h.cleanup();
  }
});

test('profile approve-settings reports runtime-only settings it cannot apply to a profile', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    const proposal = await h.approvals.propose({
      profileId: record.id,
      accountKey: 'acct_' + '0'.repeat(32),
      tool: 'settings',
      policyGeneration: record.policyGeneration,
    }, { safeMode: 'strict' });
    await run(h.deps, ['profile', 'approve-settings', proposal.id]);
    assert.ok(h.lines.some((line) => line.includes('safeMode')));
    assert.deepEqual((await h.registry.snapshot(record.id)).confirmations, {});
  } finally {
    await h.cleanup();
  }
});

test('profile approve-settings refuses unknown and expired proposals', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      run(h.deps, ['profile', 'approve-settings', 'ap_missing']),
      /missing/,
    );
    assert.equal(h.prompts.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('credentials reads secrets only from a hidden local prompt and never prints them', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    h.setHiddenAnswers(['super-secret-value', 'refresh-token-value']);
    await run(h.deps, ['profile', 'credentials', 'alice']);
    assert.equal(h.secretStore.values.get(h.secretStore.ref(record.id, 'clientSecret')), 'super-secret-value');
    assert.equal(h.secretStore.values.get(h.secretStore.ref(record.id, 'refreshToken')), 'refresh-token-value');
    assert.equal(h.hiddenQuestions.length, 2);
    const allOutput = h.lines.join('\n');
    assert.ok(!allOutput.includes('super-secret-value'));
    assert.ok(!allOutput.includes('refresh-token-value'));
    assert.ok(allOutput.includes('clientSecret'));
    assert.ok(allOutput.includes('refreshToken'));
  } finally {
    await h.cleanup();
  }
});

test('credentials refuses a non-interactive shell before reading anything', async () => {
  const h = await harness({ interactive: false });
  try {
    await h.registry.add({ alias: 'alice' });
    await assert.rejects(
      run(h.deps, ['profile', 'credentials', 'alice']),
      /interactive terminal/,
    );
    assert.equal(h.hiddenQuestions.length, 0);
    assert.equal(h.secretStore.values.size, 0);
  } finally {
    await h.cleanup();
  }
});

test('enabling stored-password login needs local approval and stores the password hidden', async () => {
  const h = await harness({ promptAnswer: true });
  try {
    const record = await h.registry.add({ alias: 'alice' });
    h.setHiddenAnswers(['reddit-password']);
    await run(h.deps, ['profile', 'credentials', 'alice', '--password-login', 'on']);
    assert.equal(h.prompts.length, 1);
    assert.equal((await h.registry.snapshot('alice')).passwordLoginEnabled, true);
    assert.equal(h.secretStore.values.get(h.secretStore.ref(record.id, 'password')), 'reddit-password');
    assert.ok(!h.lines.join('\n').includes('reddit-password'));

    await run(h.deps, ['profile', 'credentials', 'alice', '--password-login', 'off']);
    assert.equal((await h.registry.snapshot('alice')).passwordLoginEnabled, false);
    assert.equal(h.secretStore.values.has(h.secretStore.ref(record.id, 'password')), false);
  } finally {
    await h.cleanup();
  }
});

test('enabling stored-password login with a blank password changes nothing', async () => {
  const h = await harness();
  try {
    await h.registry.add({ alias: 'alice' });
    h.setHiddenAnswers(['']);
    await assert.rejects(
      run(h.deps, ['profile', 'credentials', 'alice', '--password-login', 'on']),
      /No password/,
    );
    assert.equal((await h.registry.snapshot('alice')).passwordLoginEnabled, false);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.secretStore.values.size, 0);
  } finally {
    await h.cleanup();
  }
});

test('credentials refuses to apply a stale enable after a concurrent profile change', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    h.setHiddenAnswers(['reddit-password']);
    h.deps.promptApproval = async () => {
      await h.registry.update(record.id, { visibility: 'headless' });
      return true;
    };
    await assert.rejects(
      run(h.deps, ['profile', 'credentials', 'alice', '--password-login', 'on']),
      (error) => error.code === 'POLICY_CHANGED',
    );
    assert.equal((await h.registry.snapshot('alice')).passwordLoginEnabled, false);
    assert.equal(h.secretStore.values.has(h.secretStore.ref(record.id, 'password')), false);
  } finally {
    await h.cleanup();
  }
});

test('profile logout distinguishes remote revocation from local removal', async () => {
  const revoked = [];
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice', expectedUsername: 'alice' });
    await h.registry.update(record.id, { api: { clientId: 'cid', appType: 'script' } });
    await h.secretStore.set(h.secretStore.ref(record.id, 'clientSecret'), 'secret-value');
    await h.secretStore.set(h.secretStore.ref(record.id, 'refreshToken'), 'token-value');
    h.deps.revokeToken = async (options) => { revoked.push(options); };
    const result = await logoutProfile(h.deps, 'alice');
    assert.equal(result.api.localRemoved, true);
    assert.equal(result.api.remoteLogoutRequested, true);
    assert.equal(result.api.remoteLogoutFailed, false);
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].refreshToken, 'token-value');
    assert.equal(h.secretStore.values.has(h.secretStore.ref(record.id, 'refreshToken')), false);
    assert.ok(!h.lines.join('\n').includes('token-value'));
    assert.equal(h.browserSessions.closed.length, 1);
    assert.deepEqual(h.browserSessions.closed[0].options, { logout: true });
  } finally {
    await h.cleanup();
  }
});

test('profile logout reports a failed remote revocation while still removing the local token', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    await h.registry.update(record.id, { api: { clientId: 'cid', appType: 'script' } });
    await h.secretStore.set(h.secretStore.ref(record.id, 'clientSecret'), 'secret-value');
    await h.secretStore.set(h.secretStore.ref(record.id, 'refreshToken'), 'token-value');
    h.deps.revokeToken = async () => { throw new Error('network down'); };
    const result = await logoutProfile(h.deps, 'alice');
    assert.equal(result.api.localRemoved, true);
    assert.equal(result.api.remoteLogoutRequested, true);
    assert.equal(result.api.remoteLogoutFailed, true);
    assert.equal(h.secretStore.values.has(h.secretStore.ref(record.id, 'refreshToken')), false);
    assert.ok(h.lines.some((line) => line.includes('remote revocation failed')));
  } finally {
    await h.cleanup();
  }
});

test('profile logout --json prints parseable JSON without human lines first', async () => {
  const h = await harness();
  try {
    await h.registry.add({ alias: 'alice', expectedUsername: 'alice' });
    await run(h.deps, ['profile', 'logout', 'alice', '--json']);
    const parsed = JSON.parse(h.lines.join('\n'));
    assert.equal(parsed.profile, 'alice');
    assert.equal(parsed.api.localRemoved, false);
  } finally {
    await h.cleanup();
  }
});

test('profile remove requires the typed alias and clears local secrets', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    await h.secretStore.set(h.secretStore.ref(record.id, 'clientSecret'), 'secret-value');
    await h.secretStore.set(h.secretStore.ref(record.id, 'refreshToken'), 'token-value');

    h.deps.textAnswer = 'nope';
    await assert.rejects(run(h.deps, ['profile', 'remove', 'alice']), /did not match/);
    assert.equal((await h.registry.list()).length, 1);

    h.deps.textAnswer = 'alice';
    await run(h.deps, ['profile', 'remove', 'alice']);
    assert.deepEqual(await h.registry.list(), []);
    assert.equal(h.secretStore.values.size, 0);
    assert.ok(h.lines.some((line) => line.includes('Removed profile "alice"')));
    assert.ok(h.lines.some((line) => line.includes('Browser profile files')));
  } finally {
    await h.cleanup();
  }
});

test('profile remove refuses a non-interactive shell without deleting anything', async () => {
  const h = await harness({ interactive: false });
  try {
    await h.registry.add({ alias: 'alice' });
    await assert.rejects(
      run(h.deps, ['profile', 'remove', 'alice']),
      /interactive terminal/,
    );
    assert.equal((await h.registry.list()).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('approvalAccountKeyFor uses the bound key or the expected account', () => {
  assert.equal(approvalAccountKeyFor({ accountKey: 'acct_bound' }), 'acct_bound');
  assert.equal(approvalAccountKeyFor({ expectedUsername: 'Alice' }), approvalAccountKeyFor({ username: 'alice' }));
  assert.equal(approvalAccountKeyFor({ alias: 'only-alias' }), null);
});

test('profile remove refuses while another process owns the browser profile', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    await h.secretStore.set(h.secretStore.ref(record.id, 'refreshToken'), 'token-value');
    h.browserSessions.close = async () => {
      throw Object.assign(new Error('Another local process owns this browser profile.'), { code: 'PROFILE_IN_USE' });
    };
    h.deps.textAnswer = 'alice';
    await assert.rejects(
      run(h.deps, ['profile', 'remove', 'alice']),
      (error) => error.code === 'PROFILE_IN_USE' && /not removed/.test(error.message),
    );
    assert.equal((await h.registry.list()).length, 1, 'the profile metadata is preserved');
    assert.equal(h.secretStore.values.size, 1, 'local secrets are preserved');
  } finally {
    await h.cleanup();
  }
});

test('profile attempts and profile resolve expose the local unknown-outcome route', async () => {
  const h = await harness();
  try {
    await h.registry.add({ alias: 'alice' });
    await run(h.deps, ['profile', 'attempts', 'alice']);
    assert.equal(h.services.dispatcher.resolved, 'alice');
    assert.ok(h.lines.some((line) => line.includes('No pending or unknown writes')));

    await run(h.deps, ['profile', 'resolve', 'alice', 'attempt_1', 'succeeded', '--note', 'checked on reddit.com']);
    assert.deepEqual(h.services.dispatcher.resolution, {
      selector: 'alice',
      attemptId: 'attempt_1',
      resolution: { outcome: 'succeeded', note: 'checked on reddit.com' },
    });
    assert.ok(h.lines.some((line) => line.includes('attempt_1 recorded as SUCCEEDED')));

    await assert.rejects(
      run(h.deps, ['profile', 'resolve', 'alice', 'attempt_1', 'maybe']),
      /Outcome must be "succeeded" or "failed"/,
    );
  } finally {
    await h.cleanup();
  }
});
