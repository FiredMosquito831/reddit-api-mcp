// CLI confirmation policy: default off, configured policy mandatory, one-call --confirm stricter, and
// a trusted local approval consumed by the dispatcher. These tests never touch a real terminal,
// keychain, Reddit, or browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { createHash } from 'node:crypto';
import { createApprovalStore } from '../src/approvals.js';
import { readRuntimeSettings } from '../src/config.js';
import { createDispatcher } from '../src/dispatch.js';
import { createProfileRegistry } from '../src/profiles.js';
import {
  addBackendOptions,
  buildApprovalBinding,
  executeCliRead,
  executeCliWrite,
} from '../src/cli-profiles.js';
import { OperationError } from '../src/errors.js';
import { deriveAccountKey, usernameKey } from '../src/profiles.js';

const PROFILE = Object.freeze({
  id: 'p_alice',
  alias: 'alice',
  isLegacy: false,
  expectedUsername: 'alice',
  username: 'alice',
  accountKey: deriveAccountKey(usernameKey('alice')),
  accountId: null,
  bound: true,
  policyGeneration: 3,
});

function statusWith(policy = { global: 'off', perAction: {} }, profile = PROFILE) {
  return {
    profile,
    defaultProfile: profile.alias,
    enabledBackends: ['api'],
    backendPreference: ['api'],
    visibility: 'visible',
    passwordLoginEnabled: false,
    confirmations: {},
    api: { clientId: 'cid', appType: 'installed' },
    approvalPolicy: policy,
    pendingAttempts: [],
  };
}

function fakeApprovals({ approve = true } = {}) {
  const calls = { propose: 0, approve: 0, prompts: [], bindings: [] };
  let counter = 0;
  return {
    calls,
    async propose(binding) {
      calls.propose += 1;
      calls.bindings.push({ ...binding });
      counter += 1;
      return {
        id: `ap_${counter}`,
        kind: 'action',
        classification: 'action',
        binding: { ...binding },
        risks: ['This action needs a local approval before it can be dispatched.'],
      };
    },
    async approveLocally(id, { prompt }) {
      calls.approve += 1;
      const answer = await prompt({ id, tool: 'create_post', risks: ['risk'] });
      calls.prompts.push(answer);
      return answer ? { id, status: 'approved' } : { id, status: 'rejected' };
    },
  };
}

function fakeDispatcher({ policy, profile = PROFILE, executeImpl } = {}) {
  const calls = { status: 0, execute: [] };
  return {
    calls,
    async status() {
      calls.status += 1;
      return statusWith(policy ?? { global: 'off', perAction: {} }, profile);
    },
    async execute(tool, args, options) {
      calls.execute.push({ tool, args, options });
      if (executeImpl) return await executeImpl(tool, args, options);
      return { data: { ok: true }, meta: { backend: 'api', completeness: 'complete' } };
    },
  };
}

function harness({
  policy,
  profile = PROFILE,
  approvals = fakeApprovals(),
  interactive = true,
  promptAnswer = true,
  executeImpl,
  env = {},
} = {}) {
  const dispatcher = fakeDispatcher({ policy, profile, executeImpl });
  const prompts = [];
  const lines = [];
  const deps = {
    services: () => ({
      dispatcher,
      approvals,
      registry: { async snapshot() { return { ...profile, policyGeneration: profile.policyGeneration ?? 3 }; } },
      settings: {},
      homeDir: 'C:\\tmp\\home',
      env,
    }),
    out: (line) => lines.push(String(line)),
    err: (line) => lines.push(String(line)),
    interactive: () => interactive,
    promptApproval: async (request) => {
      prompts.push(request);
      return promptAnswer;
    },
  };
  return { deps, dispatcher, approvals, prompts, lines };
}

const POST_ARGS = { subreddit: 'node', title: 'Hello', text: 'Body' };

test('addBackendOptions exposes --profile, --backend, and --json', () => {
  const program = new Command().name('t');
  const command = addBackendOptions(program.command('feed'));
  command.parse(['node', 'feed', '--profile', 'alice', '--backend', 'api', '--json']);
  assert.equal(command.opts().profile, 'alice');
  assert.equal(command.opts().backend, 'api');
  assert.equal(command.opts().json, true);
});

test('default policy off dispatches without any local approval', async () => {
  const { deps, dispatcher, approvals, prompts } = harness();
  const result = await executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS });
  assert.deepEqual(result, { data: { ok: true }, meta: { backend: 'api', completeness: 'complete' } });
  assert.equal(approvals.calls.propose, 0);
  assert.equal(approvals.calls.approve, 0);
  assert.equal(prompts.length, 0);
  assert.equal(dispatcher.calls.execute.length, 1);
  assert.equal(dispatcher.calls.execute[0].options.requestConfirmation, false);
});

test('a global configured policy requires and consumes a local approval', async () => {
  const { deps, dispatcher, approvals, prompts, lines } = harness({
    policy: { global: 'on', perAction: {} },
  });
  await executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS });
  assert.equal(approvals.calls.propose, 1);
  assert.equal(approvals.calls.approve, 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 'ap_1');
  assert.equal(dispatcher.calls.execute.length, 1);
  assert.ok(lines.some((line) => line.includes('Target: r/node')));
  assert.ok(lines.some((line) => line.startsWith('Risk: ')));
});

test('a per-action configured policy requires an approval for that tool only', async () => {
  const first = harness({ policy: { global: 'off', perAction: { create_post: 'on' } } });
  await executeCliWrite(first.deps, { tool: 'create_post', args: POST_ARGS });
  assert.equal(first.approvals.calls.propose, 1);

  const second = harness({ policy: { global: 'off', perAction: { save_content: 'on' } } });
  await executeCliWrite(second.deps, { tool: 'create_post', args: POST_ARGS });
  assert.equal(second.approvals.calls.propose, 0);
});

test('--confirm makes one action stricter even when policy is off', async () => {
  const { deps, dispatcher, approvals } = harness();
  await executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS, confirm: true });
  assert.equal(approvals.calls.propose, 1);
  assert.equal(dispatcher.calls.execute[0].options.requestConfirmation, true);
});

test('a required local approval cannot be bypassed in a non-interactive shell', async () => {
  const { deps, dispatcher, approvals } = harness({
    policy: { global: 'on', perAction: {} },
    interactive: false,
  });
  await assert.rejects(
    executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS }),
    (error) => error instanceof OperationError && error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(approvals.calls.propose, 0);
  assert.equal(dispatcher.calls.execute.length, 0);
});

test('a declined local prompt sends nothing', async () => {
  const { deps, dispatcher, approvals } = harness({
    policy: { global: 'on', perAction: {} },
    promptAnswer: false,
  });
  await assert.rejects(
    executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS }),
    (error) => error instanceof OperationError && error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(approvals.calls.approve, 1);
  assert.equal(dispatcher.calls.execute.length, 0);
});

test('the approval binding matches the write boundary canonical fields', () => {
  const operation = {
    policyKey: 'create_post',
    target: 'r/node',
    contentHash: 'c'.repeat(64),
  };
  const binding = buildApprovalBinding({ profile: PROFILE, operation, policyGeneration: 3 });
  assert.deepEqual(binding, {
    profileId: PROFILE.id,
    accountKey: PROFILE.accountKey,
    tool: 'create_post',
    targetHash: createHash('sha256').update('r/node').digest('hex'),
    contentHash: operation.contentHash,
    policyGeneration: 3,
  });
});

test('an unbound profile with an expected username derives the same account key', () => {
  const profile = { id: 'p_bob', expectedUsername: 'bob', username: null, accountKey: null };
  const binding = buildApprovalBinding({
    profile,
    operation: { policyKey: 'create_post', target: 'r/node', contentHash: null },
  });
  assert.equal(binding.accountKey, deriveAccountKey(usernameKey('bob')));
});

test('a policy-bound approval refuses a profile that cannot be bound to any account', async () => {
  const profile = {
    id: 'p_new', alias: 'new', isLegacy: false, expectedUsername: null, username: null, accountKey: null, bound: false,
  };
  const { deps, dispatcher, approvals } = harness({
    policy: { global: 'on', perAction: {} },
    profile,
  });
  await assert.rejects(
    executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS }),
    (error) => error instanceof OperationError && error.code === 'PROFILE_REQUIRED',
  );
  assert.equal(approvals.calls.propose, 0);
  assert.equal(dispatcher.calls.execute.length, 0);
});

test('the legacy environment profile binds an approval to its configured username', async () => {
  // The dispatcher reports the legacy profile with no identity fields; only the environment knows the
  // account, so the CLI has to derive the same key the backend probe will.
  const legacy = {
    id: 'legacy', alias: 'legacy-environment', isLegacy: true, expectedUsername: null, username: null, accountKey: null,
  };
  const env = {
    REDDIT_CLIENT_ID: 'cid',
    REDDIT_USERNAME: 'alice',
    REDDIT_AUTH_MODE: 'password',
    REDDIT_CLIENT_SECRET: 'secret',
    REDDIT_PASSWORD: 'password',
  };
  // A policy generation of 0 would not match the write boundary's LEGACY_PROFILE.policyGeneration of 1.
  const { deps, dispatcher, approvals } = harness({ policy: { global: 'on', perAction: {} }, profile: legacy, env });
  await executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS });
  assert.equal(approvals.calls.propose, 1);
  assert.equal(approvals.calls.bindings[0].profileId, 'legacy');
  assert.equal(approvals.calls.bindings[0].accountKey, deriveAccountKey(usernameKey('alice')));
  assert.equal(approvals.calls.bindings[0].policyGeneration, 1);
  assert.equal(dispatcher.calls.execute.length, 1);
});

test('only write tools reach the write path; reads never propose', async () => {
  const { deps, dispatcher } = harness();
  await assert.rejects(
    executeCliWrite(deps, { tool: 'get_me', args: {} }),
    /Not a write tool/,
  );
  const result = await executeCliRead(deps, { tool: 'get_me', profile: 'alice', backend: 'api' });
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(dispatcher.calls.execute[0].options, {
    profile: 'alice',
    backend: 'api',
  });
});

test('a read passes the profile and backend through unchanged', async () => {
  const { deps, dispatcher } = harness();
  await executeCliRead(deps, { tool: 'browse_subreddit', args: { subreddit: 'node' }, profile: 'bob', backend: 'replay' });
  assert.equal(dispatcher.calls.execute[0].args.subreddit, 'node');
  assert.deepEqual(dispatcher.calls.execute[0].options, {
    profile: 'bob',
    backend: 'replay',
  });
});

test('an approval prepared by the CLI is the one the real write boundary consumes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cli-policy-'));
  try {
    const registry = createProfileRegistry({ homeDir: home });
    const record = await registry.add({ alias: 'alice', expectedUsername: 'alice' });
    await registry.setDefault(record.id);
    const approvals = createApprovalStore({ homeDir: home });
    const settings = {
      ...readRuntimeSettings({ REDDIT_CLI_HOME: home }),
      minGapMs: 0,
      maxWritesPerHour: 30,
      confirmations: { global: 'on', perAction: {} },
    };
    let committed = 0;
    const backend = {
      async capabilities() {
        return { backend: 'api', reads: ['get_me'], writes: ['create_post'], completeness: 'complete' };
      },
      async probe() {
        return { verified: true, username: 'alice' };
      },
      async read() {
        return { ok: true };
      },
      async prepareWrite() {
        return { prepared: true };
      },
      async commitWrite() {
        committed += 1;
        return { id: 't3_new' };
      },
    };
    const dispatcher = createDispatcher({
      registry,
      approvals,
      backendFactories: { api: async () => ({ backend }) },
      settings,
      env: { REDDIT_CLI_HOME: home },
    });
    const lines = [];
    const prompts = [];
    const deps = {
      services: () => ({ dispatcher, approvals, registry, settings, homeDir: home }),
      out: (line) => lines.push(line),
      interactive: () => true,
      promptApproval: async (request) => {
        prompts.push(request);
        return true;
      },
    };
    const result = await executeCliWrite(deps, {
      tool: 'create_post',
      args: POST_ARGS,
      profile: 'alice',
    });
    assert.deepEqual(result.data, { id: 't3_new' });
    assert.equal(committed, 1);
    assert.equal(prompts.length, 1);
    const status = await approvals.status(prompts[0].id);
    assert.equal(status.status, 'consumed');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a legacy environment approval is the one the real write boundary consumes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cli-policy-legacy-'));
  try {
    // The registry exists but holds no profiles, which is exactly when the dispatcher falls back to
    // the environment-only legacy profile.
    const registry = createProfileRegistry({ homeDir: home });
    const approvals = createApprovalStore({ homeDir: home });
    const env = {
      REDDIT_CLI_HOME: home,
      REDDIT_CLIENT_ID: 'cid',
      REDDIT_USERNAME: 'alice',
      REDDIT_AUTH_MODE: 'password',
      REDDIT_CLIENT_SECRET: 'secret',
      REDDIT_PASSWORD: 'password',
    };
    const settings = {
      ...readRuntimeSettings({ REDDIT_CLI_HOME: home }),
      minGapMs: 0,
      maxWritesPerHour: 30,
      confirmations: { global: 'on', perAction: {} },
    };
    let committed = 0;
    const backend = {
      async capabilities() {
        return { backend: 'api', reads: ['get_me'], writes: ['create_post'], completeness: 'complete' };
      },
      async probe() {
        return { verified: true, username: 'alice' };
      },
      async read() {
        return { ok: true };
      },
      async prepareWrite() {
        return { prepared: true };
      },
      async commitWrite() {
        committed += 1;
        return { id: 't3_legacy' };
      },
    };
    const dispatcher = createDispatcher({
      registry,
      approvals,
      backendFactories: { api: async () => ({ backend }) },
      settings,
      env,
    });
    const lines = [];
    const prompts = [];
    const deps = {
      services: () => ({ dispatcher, approvals, registry, settings, homeDir: home, env }),
      out: (line) => lines.push(line),
      interactive: () => true,
      promptApproval: async (request) => {
        prompts.push(request);
        return true;
      },
    };
    const result = await executeCliWrite(deps, { tool: 'create_post', args: POST_ARGS });
    assert.deepEqual(result.data, { id: 't3_legacy' });
    assert.equal(committed, 1);
    assert.equal(prompts.length, 1);
    const status = await approvals.status(prompts[0].id);
    assert.equal(status.status, 'consumed');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
