// Task 8 dispatcher contract: profile resolution, offline/RSS short-circuits, one shared write
// boundary, confirmation policy integration, and sanitized public errors. Every test uses a temporary
// REDDIT_CLI_HOME, a fake backend transport, and the real registry/ledger/approval services.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../src/dispatch.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createAccountRegistry } from '../src/accounts.js';
import { createApprovalStore } from '../src/approvals.js';
import { createAttemptLedger } from '../src/attempts.js';
import { readRuntimeSettings } from '../src/config.js';
import { createContinuationStore } from '../src/continuations.js';
import { describeOperation } from '../src/operations.js';
import { OperationError, OUTCOMES } from '../src/errors.js';
import { createFixturePage } from './fixtures/browser/page.js';
import { listingModel, post } from './fixtures/browser/models.js';
import { jsonResponse } from './helpers.js';

const ALICE_KEY_SEED = 'alice';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'reddit-dispatch-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function runtimeSettings(home, overrides = {}) {
  return {
    ...readRuntimeSettings({ REDDIT_CLI_HOME: home }),
    minGapMs: 0,
    maxWritesPerHour: 30,
    ...overrides,
  };
}

// A backend that records every call. Default capabilities support every read and write.
function fakeBackend(id, overrides = {}) {
  const calls = { capabilities: 0, probe: 0, read: 0, prepare: 0, commit: 0, close: 0 };
  const backend = {
    id,
    async capabilities(ctx) {
      calls.capabilities += 1;
      if (overrides.capabilities) return await overrides.capabilities(ctx);
      return { backend: id, reads: ALL_READS, writes: ALL_WRITES, completeness: 'complete' };
    },
    async probe(ctx) {
      calls.probe += 1;
      if (overrides.probe) return await overrides.probe(ctx);
      return { verified: true, username: 'alice' };
    },
    async read(operation, ctx) {
      calls.read += 1;
      if (overrides.read) return await overrides.read(operation, ctx);
      return { tool: operation.tool, args: operation.args };
    },
    async prepareWrite(operation, ctx) {
      calls.prepare += 1;
      if (overrides.prepare) return await overrides.prepare(operation, ctx);
      return { tool: operation.tool, form: operation.args };
    },
    async commitWrite(prepared, ctx) {
      calls.commit += 1;
      if (overrides.commit) return await overrides.commit(prepared, ctx);
      return { completed: prepared.tool };
    },
    async close() {
      calls.close += 1;
    },
  };
  return { backend, calls };
}

const ALL_READS = Object.freeze([
  'get_me', 'browse_subreddit', 'get_top_posts', 'get_subreddit_info', 'get_subreddit_rules',
  'get_post_flairs', 'get_trending_subreddits', 'search_reddit', 'get_reddit_post', 'get_post_comments',
  'get_more_comments', 'get_user_info', 'get_user_posts', 'get_user_comments', 'user_analysis',
  'get_my_overview', 'get_my_saved', 'list_my_subreddits', 'test_reddit_mcp_server',
]);
const ALL_WRITES = Object.freeze([
  'create_post', 'reply_to_post', 'edit_post', 'edit_comment', 'delete_post', 'delete_comment',
  'save_content', 'unsave_content', 'vote_on_thing', 'subscribe_to_subreddit', 'unsubscribe_from_subreddit',
]);

function factoryFor(result) {
  return async () => result;
}

async function setup({ settings = {}, backendFactories = {}, withRegistry = true, env = {} } = {}) {
  const { home, cleanup } = await tempHome();
  const registry = withRegistry ? createProfileRegistry({ homeDir: home }) : null;
  const accounts = registry ? createAccountRegistry({ registry }) : null;
  const runtime = runtimeSettings(home, settings);
  const dispatcher = createDispatcher({
    registry,
    accounts,
    backendFactories,
    settings: runtime,
    clock: () => Date.now(),
    env: { REDDIT_CLI_HOME: home, ...env },
  });
  return { home, cleanup, registry, accounts, settings: runtime, dispatcher };
}

async function addBoundProfile(registry, alias = 'alice', username = 'alice') {
  const profile = await registry.add({ alias });
  await registry.bindIdentity(profile.id, { username });
  await registry.setDefault(profile.id);
  return registry.snapshot(profile.id);
}

async function approveWrite(approvals, snapshot, operation, accountKey) {
  const binding = {
    profileId: snapshot.id,
    accountKey: accountKey ?? snapshot.accountKey,
    tool: operation.policyKey,
    targetHash: createHash('sha256').update(operation.target).digest('hex'),
    contentHash: operation.contentHash ?? null,
    policyGeneration: snapshot.policyGeneration,
  };
  const proposal = await approvals.propose(binding);
  return approvals.approveLocally(proposal.id, { prompt: async () => true });
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

test('offline glossary runs before profile resolution and needs no backend', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  let factoryCalls = 0;
  const dispatch = createDispatcher({
    backendFactories: {
      api: async () => { factoryCalls += 1; throw new Error('must not be called'); },
    },
    settings: ctx.settings,
  });
  const result = await dispatch.execute('reddit_explain', { term: 'Karma' });
  assert.equal(result.data.term, 'karma');
  assert.match(result.data.definition, /upvotes/i);
  assert.equal(result.meta.backend, 'offline');
  assert.equal(factoryCalls, 0);
});

test('public RSS runs without a profile and reports reduced completeness', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  const urls = [];
  const dispatch = createDispatcher({
    settings: ctx.settings,
    backendFactories: {},
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(
        '<feed><entry><id>t3_abc</id><title>Hello</title><updated>2026-10-21T00:00:00Z</updated>'
          + '<author><name>/u/alice</name></author><link href="https://www.reddit.com/r/test/abc"/></entry></feed>',
        { status: 200, headers: { 'content-type': 'application/atom+xml' } },
      );
    },
  });
  const result = await dispatch.execute('browse_subreddit_rss', { subreddit: 'test', limit: 1 });
  assert.equal(result.meta.backend, 'rss');
  assert.equal(result.meta.completeness, 'partial');
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].fullname, 't3_abc');
  assert.match(urls[0], /\/r\/test\/hot\/\.rss/);
});

test('an unknown tool and invalid essential parameters fail before any backend work', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  let factoryCalls = 0;
  const dispatch = createDispatcher({
    settings: ctx.settings,
    backendFactories: { api: async () => { factoryCalls += 1; return fakeBackend('api').backend; } },
  });
  await assert.rejects(dispatch.execute('no_such_tool', {}), (error) => error.code === 'UNSUPPORTED_OPERATION');
  await assert.rejects(dispatch.execute('create_post', { subreddit: 'test', title: 'T' }), /exactly one of/i);
  assert.equal(factoryCalls, 0);
});

test('no profile, no default, and no legacy configuration is PROFILE_REQUIRED', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const dispatch = createDispatcher({ registry: ctx.registry, settings: ctx.settings, backendFactories: {}, env: {} });
  await assert.rejects(dispatch.execute('get_me', {}), (error) => error.code === 'PROFILE_REQUIRED');
});

test('an empty registry with invalid legacy env keeps the original REDDIT_CLIENT_ID error', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  const dispatch = createDispatcher({ settings: ctx.settings, backendFactories: {}, env: {} });
  await assert.rejects(dispatch.execute('get_me', {}), /REDDIT_CLIENT_ID/);
});

test('an empty registry with valid legacy env resolves the isolated legacy profile', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  const seen = [];
  const dispatch = createDispatcher({
    settings: ctx.settings,
    env: { REDDIT_CLIENT_ID: 'legacy-id', REDDIT_USERNAME: 'alice' },
    backendFactories: {
      api: async ({ snapshot }) => {
        seen.push(snapshot);
        return fakeBackend('api').backend;
      },
    },
  });
  const result = await dispatch.execute('get_me', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'legacy');
  assert.equal(result.meta.profile, 'legacy-environment');
  assert.equal(result.meta.backend, 'api');
});

test('an explicit profile overrides the saved default', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const alice = await addBoundProfile(ctx.registry, 'alice', 'alice');
  const bob = await addBoundProfile(ctx.registry, 'bob', 'bob');
  await ctx.registry.setDefault(alice.id);
  const aliases = [];
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {
      api: async ({ snapshot }) => {
        aliases.push(snapshot.alias);
        return fakeBackend('api').backend;
      },
    },
  });
  const result = await dispatch.execute('get_me', {}, { profile: bob.alias });
  assert.deepEqual(aliases, ['bob']);
  assert.equal(result.meta.profile, 'bob');
});

test('a default change never mutates a call that already resolved its profile', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const alice = await addBoundProfile(ctx.registry, 'alice', 'alice');
  const bob = await addBoundProfile(ctx.registry, 'bob', 'bob');
  await ctx.registry.setDefault(alice.id);
  const gate = deferred();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {
      api: async () => fakeBackend('api', {
        async read() {
          started();
          await gate.promise;
          return { ok: true };
        },
      }).backend,
    },
  });
  const pending = dispatch.execute('get_me', {});
  await startedPromise;
  await ctx.registry.setDefault(bob.id);
  gate.resolve();
  const result = await pending;
  assert.equal(result.meta.profile, 'alice');
});

test('a successful write reserves once, commits once, and settles SUCCEEDED', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  const result = await dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  assert.equal(calls.commit, 1);
  assert.equal(calls.prepare, 1);
  assert.equal(result.meta.outcome, OUTCOMES.SUCCEEDED);
  assert.equal(result.meta.backend, 'api');
  assert.equal(result.meta.profile, 'alice');
  assert.ok(result.meta.attemptId);
  // The public envelope never carries backend-internal account fields.
  assert.equal(result.meta.accountKey, undefined);
  assert.equal(result.meta.profileId, undefined);
  assert.equal(result.meta.cacheGeneration, undefined);
  const attempts = await readAttempts(ctx.home, snapshot.accountKey);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, OUTCOMES.SUCCEEDED);
});

test('global confirmation policy cannot dispatch without a trusted approval', async (t) => {
  const ctx = await setup({ settings: { confirmations: { global: 'on', perAction: {} } } });
  t.after(ctx.cleanup);
  await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World', confirm: true }),
    (error) => {
      assert.equal(error.code, 'APPROVAL_REQUIRED');
      assert.equal(error.outcome, null);
      return true;
    },
  );
  assert.equal(calls.commit, 0);
  assert.deepEqual(await readAttempts(ctx.home, (await ctx.registry.snapshot()).accountKey), []);
});

test('global confirmation policy dispatches once with a trusted local approval', async (t) => {
  const ctx = await setup({ settings: { confirmations: { global: 'on', perAction: {} } } });
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry);
  const approvals = createApprovalStore({ homeDir: ctx.home });
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    approvals,
    backendFactories: { api: async () => backend },
  });
  const operation = describeOperation('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }, ctx.settings);
  await approveWrite(approvals, snapshot, operation);
  const result = await dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  assert.equal(calls.commit, 1);
  assert.equal(result.meta.outcome, OUTCOMES.SUCCEEDED);
});

test('profile confirmation booleans add strictness for exactly the named tool', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const profile = await ctx.registry.add({ alias: 'alice' });
  await ctx.registry.update(profile.id, { confirmations: { create_post: true } });
  await ctx.registry.setDefault(profile.id);
  const snapshot = await ctx.registry.snapshot(profile.id);
  const approvals = createApprovalStore({ homeDir: ctx.home });
  const { backend, calls } = fakeBackend('api', {
    probe: async () => ({ verified: true, username: 'alice' }),
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    approvals,
    backendFactories: { api: async () => backend },
  });
  // save_content is not named in the profile map, so it needs no approval.
  await dispatch.execute('save_content', { fullname: 't3_abc' });
  assert.equal(calls.commit, 1);
  // create_post is named, so it is refused without an approval.
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.commit, 1);
});

test('a profile global confirmation key is honored and cannot weaken runtime global-on', async (t) => {
  const ctx = await setup({ settings: { confirmations: { global: 'on', perAction: {} } } });
  t.after(ctx.cleanup);
  const profile = await ctx.registry.add({ alias: 'alice' });
  await ctx.registry.update(profile.id, { confirmations: { global: false, create_post: false } });
  await ctx.registry.setDefault(profile.id);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.commit, 0);

  // The same profile map can also escalate a runtime global-off policy.
  const second = await addBoundProfile(ctx.registry, 'bob', 'alice');
  await ctx.registry.update(second.id, { confirmations: { global: true } });
  const dispatchOff = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: runtimeSettings(ctx.home),
    backendFactories: { api: async () => fakeBackend('api').backend },
  });
  await assert.rejects(
    dispatchOff.execute('save_content', { fullname: 't3_abc' }, { profile: 'bob' }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
});

test('a one-call confirmation request is stricter than stored off policy', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  await assert.rejects(
    dispatch.execute('save_content', { fullname: 't3_abc' }, { requestConfirmation: true }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.commit, 0);
});

test('an unknown write outcome is terminal and never tried on another backend', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const profile = await addBoundProfile(ctx.registry);
  await ctx.registry.update(profile.id, { enabledBackends: ['api', 'replay'], backendPreference: ['api', 'replay'] });
  let replayFactories = 0;
  const api = fakeBackend('api', {
    async commit() {
      throw new OperationError('OUTCOME_UNKNOWN', 'lost response', { outcome: OUTCOMES.OUTCOME_UNKNOWN });
    },
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {
      api: async () => api.backend,
      replay: async () => { replayFactories += 1; return fakeBackend('replay').backend; },
    },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }),
    (error) => {
      assert.equal(error.code, 'OUTCOME_UNKNOWN');
      assert.equal(error.outcome, OUTCOMES.OUTCOME_UNKNOWN);
      return true;
    },
  );
  assert.equal(api.calls.commit, 1);
  assert.equal(replayFactories, 0);
});

test('status reports the frozen profile plus account-level pending attempts', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry);
  await ctx.registry.setDefault(snapshot.id);
  const ledger = createAttemptLedger({ homeDir: ctx.home, accountKey: snapshot.accountKey });
  await ledger.reserve(
    { kind: 'write', tool: 'create_post', policyKey: 'create_post', target: 'r/sandbox', contentHash: 'abc' },
    { accountKey: snapshot.accountKey },
  );
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {},
  });
  const status = await dispatch.status();
  assert.equal(status.profile.alias, 'alice');
  assert.equal(status.profile.accountKey, snapshot.accountKey);
  assert.equal(status.pendingAttempts.length, 1);
  assert.equal(status.pendingAttempts[0].state, 'PREPARED');
  assert.equal(status.pendingAttempts[0].policyKey, 'create_post');
});

test('closeProfile closes cached backends and the browser session owner', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const closedSessions = [];
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
    browserSessions: { close: async (id) => { closedSessions.push(id); return { closed: true, profileId: id }; } },
  });
  await dispatch.execute('get_me', {}, { profile: snapshot.id });
  const result = await dispatch.closeProfile(snapshot.id);
  assert.equal(calls.close, 1);
  assert.deepEqual(closedSessions, [snapshot.id]);
  assert.equal(result.profileId, snapshot.id);
});

test('close releases every cached backend and all browser sessions', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const alice = await addBoundProfile(ctx.registry, 'alice', 'alice');
  const bob = await addBoundProfile(ctx.registry, 'bob', 'bob');
  const first = fakeBackend('api');
  const second = fakeBackend('api');
  const backends = new Map([['alice', first.backend], ['bob', second.backend]]);
  let closeAllCalls = 0;
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {
      api: async ({ snapshot }) => backends.get(snapshot.alias),
    },
    browserSessions: { closeAll: async () => { closeAllCalls += 1; return []; } },
  });
  await dispatch.execute('get_me', {}, { profile: alice.alias });
  await dispatch.execute('get_me', {}, { profile: bob.alias });
  const result = await dispatch.close();
  assert.equal(first.calls.close, 1);
  assert.equal(second.calls.close, 1);
  assert.equal(closeAllCalls, 1);
  assert.equal(result.backends, 2);
});

test('a local rate-limit rejection is terminal and never rerouted', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const profile = await addBoundProfile(ctx.registry);
  await ctx.registry.update(profile.id, {
    enabledBackends: ['api', 'replay'],
    backendPreference: ['api', 'replay'],
  });
  let replayFactories = 0;
  const api = fakeBackend('api', {
    async read() {
      // src/client.js throws this shape for the local sliding-window / blockedUntil throttle path:
      // a RedditError with no HTTP status and no outcome. It is still a throttle, never a reroute.
      throw Object.assign(new Error('Reddit rate limit reached. Try again in about 12 seconds.'), { name: 'RedditError' });
    },
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: {
      api: async () => api.backend,
      replay: async () => { replayFactories += 1; return fakeBackend('replay').backend; },
    },
  });
  await assert.rejects(
    dispatch.execute('get_me'),
    (error) => {
      assert.equal(error.code, 'THROTTLED');
      assert.equal(error.outcome, null);
      return true;
    },
  );
  assert.equal(api.calls.read, 1);
  assert.equal(replayFactories, 0);
});

test('a profile-shaped runtime confirmation map is honored, not silently disabled', async (t) => {
  const ctx = await setup({ settings: { confirmations: { global: true, create_post: true } } });
  t.after(ctx.cleanup);
  await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.commit, 0);
});

test('an unreadable confirmation value refuses to dispatch instead of weakening policy', async (t) => {
  const ctx = await setup({ settings: { confirmations: { global: 'yes' } } });
  t.after(ctx.cleanup);
  await addBoundProfile(ctx.registry);
  const { backend, calls } = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => backend },
  });
  await assert.rejects(
    dispatch.execute('save_content', { fullname: 't3_abc' }),
    (error) => error instanceof TypeError && /confirmation/i.test(error.message),
  );
  assert.equal(calls.commit, 0);
});

test('a write aborted during preparation never commits', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  await addBoundProfile(ctx.registry);
  const controller = new AbortController();
  const api = fakeBackend('api', {
    async prepare() {
      controller.abort();
      return { form: {} };
    },
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => api.backend },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }, { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
      assert.equal(error.outcome, null);
      return true;
    },
  );
  assert.equal(api.calls.prepare, 1);
  assert.equal(api.calls.commit, 0);
});

test('an already-aborted signal stops a public RSS fetch before it is sent', async (t) => {
  const ctx = await setup({ withRegistry: false });
  t.after(ctx.cleanup);
  let fetchCalls = 0;
  const dispatch = createDispatcher({
    settings: ctx.settings,
    backendFactories: {},
    fetch: async () => {
      fetchCalls += 1;
      return new Response('<feed></feed>', { status: 200 });
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    dispatch.execute('browse_subreddit_rss', { subreddit: 'test' }, { signal: controller.signal }),
    (error) => error.code === 'USER_HANDOFF_REQUIRED',
  );
  assert.equal(fetchCalls, 0);
});

test('closeProfile closes the isolated legacy backend by its reserved id', async (t) => {
  const ctx = await setup({ env: { REDDIT_CLIENT_ID: 'legacy-id', REDDIT_USERNAME: 'alice' } });
  t.after(ctx.cleanup);
  const api = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    env: { REDDIT_CLI_HOME: ctx.home, REDDIT_CLIENT_ID: 'legacy-id', REDDIT_USERNAME: 'alice' },
    backendFactories: { api: async () => api.backend },
  });
  const result = await dispatch.execute('get_me');
  assert.equal(result.meta.profile, 'legacy-environment');
  const closed = await dispatch.closeProfile('legacy');
  assert.equal(api.calls.close, 1);
  assert.equal(closed.profileId, 'legacy');
  assert.deepEqual(closed.closedBackends, ['api']);
});

test('a continuation token is typed-refused and never silently restarts a read', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry);
  const api = fakeBackend('api');
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => api.backend },
  });

  // No store is wired: the dispatcher must name that rather than quietly re-reading page one.
  await assert.rejects(
    dispatch.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' }, { continuation: 'opaque' }),
    (error) => {
      assert.equal(error.code, 'CONTINUATION_INVALID');
      assert.equal(error.safeDetails.reason, 'continuation_unavailable');
      return true;
    },
  );
  assert.equal(api.calls.read, 0);
  assert.equal(api.calls.capabilities, 0);

  // With a store, a correctly bound token resolves, but the rendered-UI mappings cannot resume from it
  // yet. That remains a typed refusal, not a fresh read and not a fake success.
  const continuations = createContinuationStore({ clock: () => 1_000, newId: () => 'token-1' });
  const operation = describeOperation('browse_subreddit', { subreddit: 'test', sort: 'hot' }, ctx.settings);
  const token = continuations.issue({
    profileId: snapshot.id,
    accountKey: snapshot.accountKey,
    backend: 'browser',
    operation: 'browse_subreddit',
    filterHash: createHash('sha256').update(JSON.stringify(operation.args)).digest('hex'),
    credentialGeneration: snapshot.credentialGeneration ?? 1,
    taskId: 'task-1',
    state: { cursor: 'next' },
  });
  const wired = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: { api: async () => api.backend },
    continuations,
  });
  await assert.rejects(
    wired.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' }, { continuation: token }),
    (error) => {
      assert.equal(error.code, 'CONTINUATION_INVALID');
      assert.equal(error.safeDetails.reason, 'continuation_resume_unverified');
      return true;
    },
  );

  // A token bound to another query cannot be redeemed for this one.
  await assert.rejects(
    wired.execute('browse_subreddit', { subreddit: 'other', sort: 'hot' }, { continuation: token }),
    (error) => error.code === 'CONTINUATION_INVALID',
  );
  assert.equal(api.calls.read, 0);
});

test('a browser-backed read flows through the dispatcher and issues a UI continuation', async (t) => {
  const { home, cleanup } = await tempHome();
  t.after(cleanup);
  const registry = createProfileRegistry({ homeDir: home });
  const profile = await registry.add({ alias: 'alice' });
  await registry.bindIdentity(profile.id, { username: 'alice' });
  await registry.update(profile.id, { enabledBackends: ['browser'], backendPreference: ['browser'] });
  await registry.setDefault(profile.id);
  const snapshot = await registry.snapshot(profile.id);
  const accounts = createAccountRegistry({ registry });
  const settings = runtimeSettings(home);
  const page = createFixturePage(listingModel({
    items: [post({ id: 'abc123', subreddit: 'test' })],
    next: { cursor: 'visible-next' },
  }));
  const sessions = {
    async open() {
      return { id: snapshot.id, visibility: 'visible', context: { pages: () => [page] } };
    },
    async identity() {
      return {
        username: 'alice',
        accountKey: snapshot.accountKey,
        accountId: snapshot.accountId ?? null,
        verified: true,
      };
    },
  };
  const continuations = createContinuationStore({ clock: () => 1_000, newId: () => 'ui-token-1' });
  const dispatch = createDispatcher({
    registry,
    accounts,
    settings,
    browserSessions: sessions,
    continuations,
  });

  const result = await dispatch.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' });
  assert.equal(result.meta.backend, 'browser');
  assert.equal(result.meta.profile, 'alice');
  assert.equal(result.meta.completeness, 'partial');
  assert.deepEqual(result.meta.continuation.token, 'ui-token-1');
  assert.equal(result.meta.cursorKind, 'ui-opaque');
  await dispatch.close();
});

test('a cached browser backend is rebuilt when the profile policy generation changes', async (t) => {
  const ctx = await setup({ withRegistry: true });
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry, 'alice');
  await ctx.registry.update(snapshot.id, { enabledBackends: ['browser'], backendPreference: ['browser'], visibility: 'visible' });
  await ctx.registry.setDefault(snapshot.id);

  const seen = [];
  const browser = fakeBackend('browser', {
    capabilities: async () => ({ backend: 'browser', reads: ALL_READS, writes: ALL_WRITES, completeness: 'partial' }),
    read: async (operation, context) => ({ tool: operation.tool, visibility: context.profile.visibility }),
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    env: { REDDIT_CLI_HOME: ctx.home },
    backendFactories: {
      browser: async ({ snapshot: resolved }) => {
        seen.push(resolved.visibility);
        return browser.backend;
      },
    },
  });

  const first = await dispatch.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' });
  assert.equal(first.data.visibility, 'visible');

  // Headless is a policy-generation change; the next call must not reuse the old backend/snapshot.
  await ctx.registry.update(snapshot.id, { visibility: 'headless' });
  const second = await dispatch.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' });
  assert.deepEqual(seen, ['visible', 'headless']);
  assert.equal(second.data.visibility, 'headless');
  await dispatch.close();
});

test('the dispatcher passes the process-scope browser task manager to its browser factory', async (t) => {
  const ctx = await setup({ withRegistry: true });
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry, 'alice');
  await ctx.registry.update(snapshot.id, { enabledBackends: ['browser'], backendPreference: ['browser'] });
  await ctx.registry.setDefault(snapshot.id);
  const marker = { hasActiveTask: () => false, activeCount: () => 0, marker: true };
  let received = null;
  const browser = fakeBackend('browser', {
    capabilities: async () => ({ backend: 'browser', reads: ALL_READS, writes: ALL_WRITES }),
    read: async (operation) => ({ tool: operation.tool }),
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    env: { REDDIT_CLI_HOME: ctx.home },
    tasks: marker,
    backendFactories: {
      browser: async (options) => {
        received = options.tasks;
        return browser.backend;
      },
    },
  });
  await dispatch.execute('browse_subreddit', { subreddit: 'test', sort: 'hot' });
  assert.equal(received, marker);
  await dispatch.close();
});

test('pending attempt visibility includes a derived account key and a local resolution route exists', async (t) => {
  const ctx = await setup({ withRegistry: true });
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry, 'alice');
  await ctx.registry.update(snapshot.id, { enabledBackends: ['api'], backendPreference: ['api'] });
  await ctx.registry.setDefault(snapshot.id);
  const ledger = createAttemptLedger({
    homeDir: ctx.home,
    accountKey: snapshot.accountKey,
    clock: () => Date.now(),
    limits: { minGapMs: 0, maxWritesPerHour: 30 },
  });
  const operation = describeOperation('vote_on_thing', { fullname: 't3_abc123', direction: 'up' }, ctx.settings);
  const attempt = await ledger.reserve(operation, { accountKey: snapshot.accountKey, verified: true });
  await ledger.markDispatched(attempt.id);
  await ledger.settle(attempt.id, OUTCOMES.OUTCOME_UNKNOWN);

  const status = await ctx.dispatcher.status('alice');
  assert.equal(status.pendingAttempts.length, 1);
  assert.equal(status.pendingAttempts[0].id, attempt.id);

  const resolved = await ctx.dispatcher.resolveAttempt('alice', attempt.id, { outcome: 'succeeded', note: 'checked on reddit.com' });
  assert.equal(resolved.state, OUTCOMES.SUCCEEDED);
  assert.equal(resolved.resolution, 'local');
  assert.equal((await ctx.dispatcher.pendingAttempts('alice')).length, 0);
});

test('a raw POST is admitted once through the shared boundary with the raw_post key', async (t) => {
  const ctx = await setup({ withRegistry: true });
  t.after(ctx.cleanup);
  const snapshot = await addBoundProfile(ctx.registry, 'alice');
  await ctx.registry.update(snapshot.id, { enabledBackends: ['api'], backendPreference: ['api'] });
  await ctx.registry.setDefault(snapshot.id);
  const api = fakeBackend('api', {
    capabilities: async () => ({ backend: 'api', reads: ALL_READS, writes: ALL_WRITES }),
    prepare: async (operation) => ({ operation }),
    commit: async () => ({ data: { ok: true }, meta: { completeness: 'complete' } }),
  });
  const dispatch = createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    env: { REDDIT_CLI_HOME: ctx.home },
    backendFactories: { api: async () => api.backend },
  });
  const result = await dispatch.executeRaw({
    method: 'POST', path: '/api/vote', fields: { id: 't3_abc123', dir: '1' },
  }, { profile: 'alice' });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.meta.outcome, OUTCOMES.SUCCEEDED);
  assert.equal(api.calls.prepare, 1);
  assert.equal(api.calls.commit, 1);
  const attempts = await readAttempts(ctx.home, snapshot.accountKey);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].tool ?? attempts[0].operation?.tool, 'raw_post');
  await dispatch.close();
});
