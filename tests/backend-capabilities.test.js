// Task 8 backend capability selection: auto order, explicit backend choice, fallback only for an
// eligible pre-dispatch unsupported/unavailable implementation, and app-only profiles that never
// promote a write onto a browser backend. Also exercises the production API factory end to end with a
// fake transport, so the dispatcher is tested against the real session/client/actions stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatcher } from '../src/dispatch.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createAccountRegistry } from '../src/accounts.js';
import { readRuntimeSettings } from '../src/config.js';
import { OperationError, OUTCOMES } from '../src/errors.js';
import { TOKEN_URL } from '../src/oauth.js';
import { jsonResponse, recordingFetch } from './helpers.js';

const READS = Object.freeze(['get_me', 'browse_subreddit', 'get_my_saved']);
const WRITES = Object.freeze(['create_post', 'save_content']);

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cap-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function fakeBackend(id, overrides = {}) {
  const calls = { probe: 0, read: 0, prepare: 0, commit: 0, close: 0 };
  const backend = {
    id,
    async capabilities() {
      if (overrides.capabilities) return await overrides.capabilities();
      return { backend: id, reads: READS, writes: WRITES, completeness: 'complete' };
    },
    async probe() {
      calls.probe += 1;
      if (overrides.probe) return await overrides.probe();
      return { verified: true, username: 'alice' };
    },
    async read(operation) {
      calls.read += 1;
      if (overrides.read) return await overrides.read(operation);
      return { backend: id, tool: operation.tool };
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
    async close() { calls.close += 1; },
  };
  return { backend, calls };
}

async function setup({ enabled = ['api', 'replay', 'browser'], preference = ['api'], settings = {}, secretStore = null } = {}) {
  const { home, cleanup } = await tempHome();
  const registry = createProfileRegistry({ homeDir: home });
  const profile = await registry.add({ alias: 'alice' });
  await registry.bindIdentity(profile.id, { username: 'alice' });
  await registry.update(profile.id, { enabledBackends: enabled, backendPreference: preference });
  await registry.setDefault(profile.id);
  const accounts = createAccountRegistry({ registry });
  const runtime = { ...readRuntimeSettings({ REDDIT_CLI_HOME: home }), minGapMs: 0, maxWritesPerHour: 30, ...settings };
  return { home, cleanup, registry, accounts, settings: runtime, profileId: profile.id, secretStore };
}

function makeDispatcher(ctx, factories, extra = {}) {
  return createDispatcher({
    registry: ctx.registry,
    accounts: ctx.accounts,
    settings: ctx.settings,
    backendFactories: factories,
    ...extra,
  });
}

test('auto tries api, then replay, then browser for an unavailable implementation', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const order = [];
  const dispatch = makeDispatcher(ctx, {
    api: async () => { order.push('api'); throw new OperationError('BACKEND_UNAVAILABLE', 'no API'); },
    replay: async () => { order.push('replay'); return fakeBackend('replay', {
      capabilities: async () => ({ backend: 'replay', reads: READS, writes: WRITES }),
    }).backend; },
    browser: async () => { order.push('browser'); return fakeBackend('browser').backend; },
  });
  const result = await dispatch.execute('get_me', {});
  assert.deepEqual(order, ['api', 'replay']);
  assert.equal(result.meta.backend, 'replay');
});

test('auto walks the full chain when earlier backends report the operation unsupported', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api', {
      capabilities: async () => ({ backend: 'api', reads: [], writes: [] }),
    }).backend,
    replay: async () => fakeBackend('replay', {
      capabilities: async () => ({ backend: 'replay', reads: [], writes: [] }),
    }).backend,
    browser: async () => fakeBackend('browser').backend,
  });
  const result = await dispatch.execute('get_me', {});
  assert.equal(result.meta.backend, 'browser');
});

test('a profile backendPreference array controls the auto order', async (t) => {
  const ctx = await setup({ preference: ['browser', 'api'] });
  t.after(ctx.cleanup);
  const order = [];
  const dispatch = makeDispatcher(ctx, {
    api: async () => { order.push('api'); return fakeBackend('api').backend; },
    browser: async () => { order.push('browser'); return fakeBackend('browser').backend; },
    replay: async () => { order.push('replay'); return fakeBackend('replay').backend; },
  });
  const result = await dispatch.execute('get_me', {});
  assert.deepEqual(order, ['browser']);
  assert.equal(result.meta.backend, 'browser');
});

test('disabled backends are never instantiated', async (t) => {
  const ctx = await setup({ enabled: ['api'], preference: ['api'] });
  t.after(ctx.cleanup);
  let browserCalls = 0;
  let replayCalls = 0;
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api').backend,
    browser: async () => { browserCalls += 1; return fakeBackend('browser').backend; },
    replay: async () => { replayCalls += 1; return fakeBackend('replay').backend; },
  });
  await dispatch.execute('get_me', {});
  assert.equal(browserCalls, 0);
  assert.equal(replayCalls, 0);
});

test('an explicit backend must be enabled for the profile', async (t) => {
  const ctx = await setup({ enabled: ['api'], preference: ['api'] });
  t.after(ctx.cleanup);
  let browserCalls = 0;
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api').backend,
    browser: async () => { browserCalls += 1; return fakeBackend('browser').backend; },
  });
  await assert.rejects(
    dispatch.execute('get_me', {}, { backend: 'browser' }),
    (error) => error.code === 'BACKEND_UNAVAILABLE',
  );
  assert.equal(browserCalls, 0);
});

test('an explicit enabled backend is used even when a later preference exists', async (t) => {
  const ctx = await setup({ enabled: ['api', 'browser'], preference: ['browser', 'api'] });
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api').backend,
    browser: async () => fakeBackend('browser').backend,
  });
  const result = await dispatch.execute('get_me', {}, { backend: 'api' });
  assert.equal(result.meta.backend, 'api');
});

test('runtime settings backendPreference is used when the call names no backend', async (t) => {
  const ctx = await setup({ settings: { backendPreference: 'api' } });
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api').backend,
    replay: async () => { throw new Error('replay must not be used'); },
  });
  const result = await dispatch.execute('get_me', {});
  assert.equal(result.meta.backend, 'api');
});

test('a definite authentication or throttle failure never falls back', async (t) => {
  for (const code of ['LOGIN_REQUIRED', 'THROTTLED', 'USER_HANDOFF_REQUIRED', 'IDENTITY_MISMATCH']) {
    const ctx = await setup();
    let replayCalls = 0;
    const dispatch = makeDispatcher(ctx, {
      api: async () => fakeBackend('api', {
        async read() { throw new OperationError(code, 'stop'); },
      }).backend,
      replay: async () => { replayCalls += 1; return fakeBackend('replay').backend; },
    });
    await assert.rejects(dispatch.execute('get_me', {}), (error) => error.code === code);
    assert.equal(replayCalls, 0, `${code} must not trigger a fallback`);
    await ctx.cleanup();
  }
});

test('a raw transport failure on a read is an unavailable pre-dispatch error and may fall back', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api', {
      async read() { throw new TypeError('socket hang up'); },
    }).backend,
    replay: async () => fakeBackend('replay').backend,
  });
  const result = await dispatch.execute('get_me', {});
  assert.equal(result.meta.backend, 'replay');
});

test('a reddit rejection is not converted into a backend fallback', async (t) => {
  const ctx = await setup({ settings: {} });
  t.after(ctx.cleanup);
  const { RedditError } = await import('../src/client.js');
  for (const [status, code] of [[401, 'LOGIN_REQUIRED'], [403, 'USER_HANDOFF_REQUIRED'], [429, 'THROTTLED']]) {
    let replayCalls = 0;
    const dispatch = makeDispatcher(ctx, {
      api: async () => fakeBackend('api', {
        async read() { throw new RedditError('reddit refused', { status }); },
      }).backend,
      replay: async () => { replayCalls += 1; return fakeBackend('replay').backend; },
    });
    await assert.rejects(dispatch.execute('get_me', {}), (error) => error.code === code);
    assert.equal(replayCalls, 0);
  }
});

test('an app-only API session refuses writes and account reads without promoting a browser backend', async (t) => {
  const ctx = await setup({ enabled: ['api', 'browser'], preference: ['api'] });
  t.after(ctx.cleanup);
  let browserCalls = 0;
  const api = fakeBackend('api', {
    capabilities: async () => ({ backend: 'api', appOnly: true, reads: ['browse_subreddit'], writes: [] }),
    probe: async () => ({ verified: false, appOnly: true, username: null, accountKey: null }),
  });
  const dispatch = makeDispatcher(ctx, {
    api: async () => api.backend,
    browser: async () => { browserCalls += 1; return fakeBackend('browser').backend; },
  });
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }),
    (error) => error.code === 'APP_ONLY_READ_ONLY',
  );
  await assert.rejects(
    dispatch.execute('get_my_saved', {}),
    (error) => error.code === 'APP_ONLY_READ_ONLY',
  );
  const publicRead = await dispatch.execute('browse_subreddit', { subreddit: 'test' });
  assert.equal(publicRead.meta.backend, 'api');
  assert.equal(browserCalls, 0);
});

test('the last backend reports UNSUPPORTED_OPERATION instead of inventing a result', async (t) => {
  const ctx = await setup({ enabled: ['api'], preference: ['api'] });
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, {
    api: async () => fakeBackend('api', {
      capabilities: async () => ({ backend: 'api', reads: ['browse_subreddit'], writes: WRITES }),
    }).backend,
  });
  await assert.rejects(
    dispatch.execute('get_my_saved', {}),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
});

test('production factories report a missing browser session manager as a typed unavailability', async (t) => {
  const ctx = await setup({ enabled: ['browser'], preference: ['browser'] });
  t.after(ctx.cleanup);
  // The rendered-UI module exists in this checkout, but no session manager was injected. That is a
  // pre-dispatch unavailability with an explicit backend id, never a crash or an automatic launch.
  const dispatch = makeDispatcher(ctx, undefined);
  await assert.rejects(dispatch.execute('get_me', {}), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.equal(error.safeDetails.backend, 'browser');
    assert.equal(error.safeDetails.reason, 'session_manager_unavailable');
    return true;
  });
});

test('production replay factories report a missing session manager with the replay backend id', async (t) => {
  const ctx = await setup({ enabled: ['replay'], preference: ['replay'] });
  t.after(ctx.cleanup);
  const dispatch = makeDispatcher(ctx, undefined);
  await assert.rejects(dispatch.execute('get_me', {}), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.equal(error.safeDetails.backend, 'replay');
    assert.equal(error.safeDetails.reason, 'session_manager_unavailable');
    return true;
  });
});

test('an already-aborted call fails before any backend work', async (t) => {
  const ctx = await setup();
  t.after(ctx.cleanup);
  let factoryCalls = 0;
  const dispatch = makeDispatcher(ctx, {
    api: async () => { factoryCalls += 1; return fakeBackend('api').backend; },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' }, { signal: controller.signal }),
    (error) => error.code === 'USER_HANDOFF_REQUIRED',
  );
  assert.equal(factoryCalls, 0);
});

test('production API factory reads and writes through the real session, client, and ledger', async (t) => {
  const { home, cleanup } = await tempHome();
  t.after(cleanup);
  const registry = createProfileRegistry({ homeDir: home });
  const profile = await registry.add({ alias: 'alice' });
  await registry.bindIdentity(profile.id, { username: 'alice' });
  await registry.update(profile.id, { api: { clientId: 'client-abc' }, enabledBackends: ['api'], backendPreference: ['api'] });
  await registry.setDefault(profile.id);
  const accounts = createAccountRegistry({ registry });
  const settings = { ...readRuntimeSettings({ REDDIT_CLI_HOME: home }), minGapMs: 0, maxWritesPerHour: 30 };
  const secretStore = {
    ref: (profileId, name) => ({ profileId, name }),
    async get(ref) { return ref.name === 'refreshToken' ? 'refresh-1' : null; },
  };
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'access-1', expires_in: 3600 });
    if (/\/api\/v1\/me$/.test(url)) return jsonResponse({ name: 'alice', link_karma: 1, comment_karma: 2 });
    if (/\/api\/submit\/?$/.test(url)) {
      return jsonResponse({ json: { errors: [], data: { id: 'abc', name: 't3_abc', url: 'https://reddit.com/x' } } });
    }
    return jsonResponse({ unexpected: url }, { status: 500 });
  });
  const dispatch = createDispatcher({
    registry,
    accounts,
    settings,
    secretStore,
    fetch,
    backendFactories: undefined,
  });
  const read = await dispatch.execute('get_me', {});
  assert.equal(read.data.name, 'alice');
  assert.equal(read.meta.backend, 'api');
  assert.equal(read.meta.profile, 'alice');

  const write = await dispatch.execute('create_post', { subreddit: 'sandbox', title: 'Hello', text: 'World' });
  assert.equal(write.meta.outcome, OUTCOMES.SUCCEEDED);
  assert.equal(write.data.name, 't3_abc');
  const submit = calls.find((call) => /\/api\/submit\/?$/.test(call.url));
  assert.equal(submit.body.sr, 'sandbox');
  assert.equal(submit.body.kind, 'self');
  assert.equal(calls.filter((call) => /\/api\/submit\/?$/.test(call.url)).length, 1);
});
