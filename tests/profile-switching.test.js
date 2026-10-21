// Task 8 profile switching: a resolved profile is frozen per call, but a changed policy, credential,
// identity, or removal is rechecked before any durable dispatch. Aliases of one verified account share
// the same account-level ledger, so a second alias cannot bypass the duplicate or quota rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../src/dispatch.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createAccountRegistry } from '../src/accounts.js';
import { readRuntimeSettings } from '../src/config.js';
import { OUTCOMES } from '../src/errors.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'reddit-switch-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function fakeBackend(id, overrides = {}) {
  const calls = { probe: 0, read: 0, prepare: 0, commit: 0, close: 0 };
  const backend = {
    id,
    async capabilities() {
      return { backend: id, reads: ['get_me'], writes: ['create_post', 'save_content'], completeness: 'complete' };
    },
    async probe() {
      calls.probe += 1;
      if (overrides.probe) return await overrides.probe();
      return { verified: true, username: 'alice' };
    },
    async read(operation) {
      calls.read += 1;
      if (overrides.read) return await overrides.read(operation);
      return { ok: true };
    },
    async prepareWrite(operation) {
      calls.prepare += 1;
      if (overrides.prepare) return await overrides.prepare(operation);
      return { tool: operation.tool };
    },
    async commitWrite(prepared) {
      calls.commit += 1;
      if (overrides.commit) return await overrides.commit(prepared);
      return { completed: prepared.tool };
    },
    async close() {
      calls.close += 1;
    },
  };
  return { backend, calls };
}

async function setup(settings = {}) {
  const { home, cleanup } = await tempHome();
  const registry = createProfileRegistry({ homeDir: home });
  const accounts = createAccountRegistry({ registry });
  const runtime = { ...readRuntimeSettings({ REDDIT_CLI_HOME: home }), minGapMs: 0, maxWritesPerHour: 30, ...settings };
  return { home, cleanup, registry, accounts, settings: runtime };
}

async function addBound(registry, alias, username = 'alice') {
  const profile = await registry.add({ alias });
  await registry.bindIdentity(profile.id, { username });
  await registry.setDefault(profile.id);
  return registry.snapshot(profile.id);
}

async function readAttempts(home, accountKey) {
  const path = join(home, 'accounts', accountKey, 'attempts.json');
  try {
    return JSON.parse(await readFile(path, 'utf8')).attempts;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function dispatcherFor(ctx, backend, extra = {}) {
  return createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
    ...extra,
  });
}

test('a changed default applies to the next call only', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const alice = await addBound(ctx.registry, 'alice');
  const bob = await addBound(ctx.registry, 'bob', 'bob');
  await ctx.registry.setDefault(alice.id);
  const seen = [];
  const gate = deferred();
  const started = deferred();
  const { backend } = fakeBackend('api', {
    async read() {
      seen.push('read');
      started.resolve();
      await gate.promise;
      return { ok: true };
    },
  });
  const dispatch = dispatcherFor(ctx, backend);
  const pending = dispatch.execute('get_me', {});
  await started.promise;
  await ctx.registry.setDefault(bob.id);
  gate.resolve();
  const first = await pending;
  const second = await dispatch.execute('get_me', {});
  assert.equal(first.meta.profile, 'alice');
  assert.equal(second.meta.profile, 'bob');
});

test('a confirmation policy change while a write is prepared cancels it before commit', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBound(ctx.registry, 'alice');
  const gate = deferred();
  const started = deferred();
  const { backend, calls } = fakeBackend('api', {
    async prepare() {
      started.resolve();
      await gate.promise;
      return { tool: 'create_post' };
    },
  });
  const dispatch = dispatcherFor(ctx, backend);
  const pending = dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  await started.promise;
  await ctx.registry.update(snapshot.id, { confirmations: { create_post: true } });
  gate.resolve();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'POLICY_CHANGED');
    assert.equal(error.outcome, null);
    return true;
  });
  assert.equal(calls.commit, 0);
  assert.deepEqual(await readAttempts(ctx.home, snapshot.accountKey), []);
});

test('a credential rotation while a write is prepared cancels it before commit', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBound(ctx.registry, 'alice');
  const gate = deferred();
  const started = deferred();
  const { backend, calls } = fakeBackend('api', {
    async prepare() {
      started.resolve();
      await gate.promise;
      return { tool: 'create_post' };
    },
  });
  const dispatch = dispatcherFor(ctx, backend);
  const pending = dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  await started.promise;
  await ctx.registry.update(snapshot.id, { credentialRotation: true });
  gate.resolve();
  await assert.rejects(pending, (error) => error.code === 'POLICY_CHANGED');
  assert.equal(calls.commit, 0);
});

test('an identity rebinding while a write is prepared cancels with IDENTITY_MISMATCH', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const profile = await ctx.registry.add({ alias: 'alice' });
  await ctx.registry.setDefault(profile.id);
  const gate = deferred();
  const started = deferred();
  const { backend, calls } = fakeBackend('api', {
    async prepare() {
      started.resolve();
      await gate.promise;
      return { tool: 'create_post' };
    },
  });
  const dispatch = dispatcherFor(ctx, backend);
  // The profile is unbound; the backend probe establishes alice for the ledger.
  const pending = dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  await started.promise;
  await ctx.registry.bindIdentity(profile.id, { username: 'bob' });
  gate.resolve();
  await assert.rejects(pending, (error) => error.code === 'IDENTITY_MISMATCH');
  assert.equal(calls.commit, 0);
});

test('a removed profile cancels a queued write with PROFILE_NOT_FOUND', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBound(ctx.registry, 'alice');
  const gate = deferred();
  const started = deferred();
  const { backend, calls } = fakeBackend('api', {
    async prepare() {
      started.resolve();
      await gate.promise;
      return { tool: 'create_post' };
    },
  });
  const dispatch = dispatcherFor(ctx, backend);
  const pending = dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  await started.promise;
  await ctx.registry.remove(snapshot.id, { approved: true });
  gate.resolve();
  await assert.rejects(pending, (error) => error.code === 'PROFILE_NOT_FOUND');
  assert.equal(calls.commit, 0);
});

test('profiles without a default do not guess; the error lists safe aliases', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  await ctx.registry.add({ alias: 'alice' });
  await ctx.registry.add({ alias: 'bob' });
  const dispatch = dispatcherFor(ctx, fakeBackend('api').backend);
  await assert.rejects(dispatch.execute('get_me', {}), (error) => {
    assert.equal(error.code, 'PROFILE_REQUIRED');
    assert.deepEqual(error.safeDetails.aliases.sort(), ['alice', 'bob']);
    return true;
  });
});

test('aliases of one verified account share the account ledger and duplicate guard', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const alice = await addBound(ctx.registry, 'alice', 'alice');
  const second = await addBound(ctx.registry, 'second', 'alice');
  assert.equal(alice.accountKey, second.accountKey);
  const { backend, calls } = fakeBackend('api');
  const dispatch = dispatcherFor(ctx, backend);
  await dispatch.execute('save_content', { fullname: 't3_same' }, { profile: 'alice' });
  await assert.rejects(
    dispatch.execute('save_content', { fullname: 't3_same' }, { profile: 'second' }),
    (error) => error.code === 'DUPLICATE_WRITE',
  );
  assert.equal(calls.commit, 1);
  const attempts = await readAttempts(ctx.home, alice.accountKey);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, OUTCOMES.SUCCEEDED);
});

test('the legacy environment is not used once named profiles exist', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  await ctx.registry.add({ alias: 'alice' });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    env: { REDDIT_CLI_HOME: ctx.home, REDDIT_CLIENT_ID: 'legacy', REDDIT_USERNAME: 'alice' },
    backendFactories: { api: async () => fakeBackend('api').backend },
  });
  await assert.rejects(dispatch.execute('get_me', {}), (error) => error.code === 'PROFILE_REQUIRED');
});

test('registry rejects confirmation keys that are not write tools', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const profile = await ctx.registry.add({ alias: 'alice' });
  await assert.rejects(
    ctx.registry.update(profile.id, { confirmations: { not_a_write_tool: true } }, { expectedGeneration: 1 }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  // The same rejection applies to a plausible typo of a real tool name.
  await assert.rejects(
    ctx.registry.update(profile.id, { confirmations: { create_posts: true } }, { expectedGeneration: 1 }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  assert.deepEqual((await ctx.registry.get(profile.id)).confirmations, {});
});
