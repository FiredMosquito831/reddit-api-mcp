// Task 10 replay transport and backend tests. Everything is offline: a fake Playwright request context
// stands in for the live browser session, and the fake session manager never launches anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayBackend } from '../src/backends/replay.js';
import { deriveAccountKey, usernameKey } from '../src/accounts.js';
import { readRuntimeSettings } from '../src/config.js';
import { createDispatcher } from '../src/dispatch.js';
import { OperationError } from '../src/errors.js';
import { describeOperation } from '../src/operations.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createReplayTransport } from '../src/replay/transport.js';
import { REPLAY_MAPPINGS } from '../src/replay/mappings.js';

const FIXTURES = new URL('./fixtures/replay/', import.meta.url);
const fixtureText = (name) => readFile(fileURLToPath(new URL(name, FIXTURES)), 'utf8');
const ALICE_KEY = deriveAccountKey(usernameKey('alice'));

function snapshot(overrides = {}) {
  return { id: 'p_one', alias: 'main', expectedUsername: 'alice', accountKey: null, visibility: 'visible', ...overrides };
}

function apiResponse({ status = 200, body = '', contentType = 'application/json', headers = {}, url = 'https://www.reddit.com/' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const all = { 'content-type': contentType, ...headers };
  return {
    status: () => status,
    headers: () => all,
    async text() {
      return text;
    },
    url: () => url,
  };
}

// A fake APIRequestContext: records every call and answers from a route function or a queue.
function fakeRequestContext(answer) {
  const calls = [];
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push({ url: String(url), options });
      if (typeof answer === 'function') return answer({ url: String(url), options, index: calls.length - 1 });
      return answer;
    },
    posts: () => calls.filter((call) => String(call.options.method ?? 'GET').toUpperCase() === 'POST'),
  };
}

function identityRecord(overrides = {}) {
  return {
    profileId: 'p_one',
    verified: true,
    username: 'alice',
    accountId: 'abc123',
    accountKey: ALICE_KEY,
    source: 'request',
    visibility: 'visible',
    ...overrides,
  };
}

function fakeSessions({ requestContext, identity = identityRecord(), openError = null } = {}) {
  const opens = [];
  return {
    opens,
    async open(target, options) {
      opens.push({ target, options });
      if (openError) throw openError;
      return { id: target.id, requestContext, visibility: options?.visibility ?? 'visible' };
    },
    async identity(profileId) {
      return { ...identity, profileId };
    },
  };
}

function context(overrides = {}) {
  return { profile: snapshot(), accountKey: ALICE_KEY, verified: true, backendId: 'replay', ...overrides };
}

test('a read request goes to the exact evidenced path and never attaches credentials or a client user-agent', async () => {
  const me = await fixtureText('me.json');
  const requestContext = fakeRequestContext(apiResponse({ body: await fixtureText('listing.json') }));
  const sessions = fakeSessions({ requestContext });
  const transport = createReplayTransport({ sessionManager: sessions, clock: () => 1_000 });

  const response = await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node', sort: 'hot', limit: 5 }, context());

  assert.equal(requestContext.calls.length, 1);
  const call = requestContext.calls[0];
  assert.equal(call.url, 'https://www.reddit.com/r/node/hot.json?limit=5');
  assert.equal(call.options.method, 'GET');
  const headers = Object.fromEntries(Object.entries(call.options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['user-agent'], undefined);
  assert.equal(response.status, 200);
  assert.equal(response.json.data.children.length, 2);
  assert.equal(me.length > 0, true);
});

test('a caller cannot smuggle a different origin, path, method, query, or header through a mapping', async () => {
  const requestContext = fakeRequestContext(apiResponse({ body: {} }));
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  const base = REPLAY_MAPPINGS.browse_subreddit;
  const forged = [
    { ...base, origin: 'https://evil.example' },
    { ...base, path: 'https://evil.example/x.json' },
    { ...base, path: '//evil.example/x.json' },
    { ...base, path: '/\\evil.example/x.json' },
    { ...base, path: '/r/../api/vote/' },
    { ...base, method: 'DELETE' },
    { ...base, headers: { cookie: 'stolen' } },
    { ...base, build: () => ({ path: 'https://evil.example/x.json', query: {} }) },
  ];
  for (const mapping of forged) {
    await assert.rejects(
      transport.request(mapping, { subreddit: 'node' }, context()),
      (error) => error instanceof OperationError && error.code === 'UNSUPPORTED_OPERATION' && error.outcome === null,
    );
  }
  assert.equal(requestContext.calls.length, 0);
});

test('GET redirects are followed only to allowlisted first-party destinations', async () => {
  const listing = await fixtureText('listing.json');
  const requestContext = fakeRequestContext(({ index }) => {
    if (index === 0) {
      return apiResponse({ status: 302, body: '', headers: { location: '/r/node/hot.json?limit=5&redirected=1' } });
    }
    return apiResponse({ body: listing, url: 'https://www.reddit.com/r/node/hot.json?limit=5&redirected=1' });
  });
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });

  const response = await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node', limit: 5 }, context());
  assert.equal(requestContext.calls.length, 2);
  assert.equal(requestContext.calls[1].url, 'https://www.reddit.com/r/node/hot.json?limit=5&redirected=1');
  assert.equal(response.status, 200);

  const evil = fakeRequestContext(apiResponse({ status: 302, body: '', headers: { location: 'https://evil.example/steal' } }));
  const evilTransport = createReplayTransport({ sessionManager: fakeSessions({ requestContext: evil }) });
  await assert.rejects(
    evilTransport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError
      && error.code === 'BACKEND_UNAVAILABLE'
      && error.safeDetails?.reason === 'redirect_not_allowed',
  );
  assert.equal(evil.calls.length, 1);
});

test('a mutation redirect is never followed, so a single write is never dispatched twice', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ status: 307, body: '', headers: { location: '/api/submit/' } });
  });
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });

  await assert.rejects(
    transport.request(REPLAY_MAPPINGS[operation.tool], operation.args, context()),
    (error) => error instanceof OperationError && error.code === 'OUTCOME_UNKNOWN' && error.outcome === 'OUTCOME_UNKNOWN',
  );
  assert.equal(requestContext.posts().length, 1);
});

test('an HTML block page is a security handoff, not a retry or a different route', async () => {
  const html = await fixtureText('block-page.html');
  const requestContext = fakeRequestContext(apiResponse({ status: 403, body: html, contentType: 'text/html' }));
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });

  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
      assert.equal(error.safeDetails?.reason, 'security_challenge');
      assert.equal(error.outcome, 'FAILED_KNOWN');
      assert.equal(JSON.stringify(error).includes('pardner'), false);
      return true;
    },
  );
  assert.equal(requestContext.calls.length, 1);
});

test('expiry and throttling are distinct from a security challenge', async () => {
  const expired = fakeRequestContext(apiResponse({ status: 401, body: '' }));
  const expiredTransport = createReplayTransport({ sessionManager: fakeSessions({ requestContext: expired }) });
  await assert.rejects(
    expiredTransport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError && error.code === 'LOGIN_REQUIRED'
      && error.safeDetails?.reason === 'session_expired',
  );

  const throttled = fakeRequestContext(apiResponse({ status: 429, body: {}, headers: { 'retry-after': '30' } }));
  const throttledTransport = createReplayTransport({ sessionManager: fakeSessions({ requestContext: throttled }) });
  await assert.rejects(
    throttledTransport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError && error.code === 'THROTTLED' && error.retryAfterMs === 30_000,
  );
});

test('malformed JSON fails closed without leaking the response body', async () => {
  const requestContext = fakeRequestContext(apiResponse({ body: 'not-json secret-cookie-value', contentType: 'application/json' }));
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.safeDetails?.reason, 'invalid_response');
      assert.equal(JSON.stringify(error).includes('secret-cookie-value'), false);
      return true;
    },
  );
  assert.equal(requestContext.calls.length, 1);
});

test('a response Set-Cookie header stays in the session request context and never enters the result or an error', async () => {
  const requestContext = fakeRequestContext(async ({ index }) => apiResponse({
    body: await fixtureText(index === 0 ? 'listing.json' : 'me.json'),
    headers: { 'set-cookie': 'reddit_session=secret-cookie; Path=/; Secure' },
  }));
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  const first = await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());
  assert.equal(JSON.stringify(first).includes('secret-cookie'), false);
  assert.equal(first.headers, undefined);

  await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());
  assert.equal(requestContext.calls.length, 2);
  for (const call of requestContext.calls) {
    const names = Object.keys(call.options.headers ?? {}).map((key) => key.toLowerCase());
    assert.equal(names.includes('cookie'), false);
    assert.equal(names.includes('set-cookie'), false);
  }
});

test('identity is verified before an operation and a wrong account blocks before any operation request', async () => {
  const requestContext = fakeRequestContext(apiResponse({ body: await fixtureText('listing.json') }));
  const sessions = fakeSessions({ requestContext, identity: identityRecord({ username: 'mallory', accountKey: deriveAccountKey(usernameKey('mallory')) }) });
  const transport = createReplayTransport({ sessionManager: sessions });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError && error.code === 'IDENTITY_MISMATCH',
  );
  assert.equal(requestContext.calls.length, 0);
  assert.equal(sessions.opens.length, 1);
});

test('a missing request context is reported as a browser dependency problem, never repaired implicitly', async () => {
  const sessions = fakeSessions({ requestContext: null });
  const transport = createReplayTransport({ sessionManager: sessions });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError
      && error.code === 'BROWSER_DEPENDENCY_MISSING'
      && error.safeDetails?.reason === 'request_context_missing',
  );
  assert.equal(sessions.opens.length, 1);
});

test('a write adds only the session modhash and sends the form exactly once', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: await fixtureText('submit.json') });
  });
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  const response = await transport.request(REPLAY_MAPPINGS.create_post, operation.args, context(), { footer: '\n\nfooter' });

  const posts = requestContext.posts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://www.reddit.com/api/submit/');
  assert.deepEqual(posts[0].options.form, {
    api_type: 'json', sr: 'node', kind: 'self', title: 'Hi', text: 'Body\n\nfooter',
  });
  const headerNames = Object.keys(posts[0].options.headers ?? {}).map((key) => key.toLowerCase());
  assert.deepEqual(headerNames.sort(), ['accept', 'x-modhash']);
  assert.equal(posts[0].options.headers['X-Modhash'], 'modhash-from-own-session');
  assert.equal(response.json.json.data.name, 't3_abc123');
});

test('a write without a session modhash is refused before anything is sent', async () => {
  const requestContext = fakeRequestContext(({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') {
      return apiResponse({ body: { kind: 'User', data: { name: 'alice', id: 'abc123' } } });
    }
    return apiResponse({ body: {} });
  });
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  const operation = describeOperation('vote_on_thing', { fullname: 't1_abc', direction: 'up' });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.vote_on_thing, operation.args, context()),
    (error) => error instanceof OperationError
      && error.code === 'USER_HANDOFF_REQUIRED'
      && error.safeDetails?.reason === 'modhash_unavailable'
      && error.outcome === null,
  );
  assert.equal(requestContext.posts().length, 0);
});

// ---- Backend integration ------------------------------------------------------------------------

function backendWith(requestContext, overrides = {}) {
  const sessions = fakeSessions({ requestContext, ...(overrides.sessions ?? {}) });
  const transport = createReplayTransport({ sessionManager: sessions, clock: () => 1_000 });
  const backend = createReplayBackend({
    transport,
    snapshot: snapshot(overrides.snapshot ?? {}),
    settings: { botFooter: '', ...(overrides.settings ?? {}) },
  });
  return { backend, sessions, transport };
}

test('backend capabilities are the finite evidenced inventory and explicitly exclude flairs', async () => {
  const { backend } = backendWith(fakeRequestContext(apiResponse({ body: {} })));
  const capabilities = await backend.capabilities(context());
  assert.equal(capabilities.backend, 'replay');
  assert.equal(capabilities.readOnly, false);
  assert.equal(capabilities.appOnly, false);
  assert.ok(capabilities.reads.includes('browse_subreddit'));
  assert.ok(capabilities.reads.includes('get_me'));
  assert.equal(capabilities.reads.includes('get_post_flairs'), false);
  assert.equal(capabilities.writes.length, 11);
  assert.equal(capabilities.completeness, 'unknown');
});

test('backend probe returns the verified session identity and never claims app-only access', async () => {
  const { backend } = backendWith(fakeRequestContext(apiResponse({ body: {} })));
  const probe = await backend.probe(context());
  assert.equal(probe.verified, true);
  assert.equal(probe.appOnly, false);
  assert.equal(probe.username, 'alice');
  assert.equal(probe.accountKey, ALICE_KEY);
  assert.equal(probe.backend, 'replay');
});

test('backend read returns action-shaped data with honest replay metadata', async () => {
  const routed = fakeRequestContext(async ({ url }) => {
    if (url === 'https://www.reddit.com/api/me.json') {
      return apiResponse({ body: { kind: 'User', data: { name: 'alice', id: 'abc123', link_karma: 1, comment_karma: 2 } } });
    }
    return apiResponse({ body: await fixtureText('listing.json') });
  });
  const { backend } = backendWith(routed);
  const me = await backend.read(describeOperation('get_me', {}), context());
  assert.deepEqual(me.data, { name: 'alice', linkKarma: 1, commentKarma: 2 });
  assert.equal(me.meta.backend, 'replay');
  assert.equal(me.meta.completeness, 'unknown');

  const listing = await backend.read(describeOperation('browse_subreddit', { subreddit: 'node' }), context());
  assert.equal(listing.data.items.length, 2);
  assert.equal(listing.data.after, 't3_next');
  assert.equal(listing.meta.completeness, 'unknown');
});

test('backend write preparation performs no network work and commit dispatches exactly once', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: await fixtureText('submit.json') });
  });
  const { backend } = backendWith(requestContext, { settings: { botFooter: '\n\nbot' } });
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  const prepared = await backend.prepareWrite(operation, context());
  assert.equal(requestContext.calls.length, 0);
  const result = await backend.commitWrite(prepared, context());
  assert.equal(requestContext.posts().length, 1);
  assert.equal(result.name, 't3_abc123');
});

test('backend commit treats an ambiguous response as OUTCOME_UNKNOWN and never retries', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: 'not json', contentType: 'application/json' });
  });
  const { backend } = backendWith(requestContext);
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  const prepared = await backend.prepareWrite(operation, context());
  await assert.rejects(
    backend.commitWrite(prepared, context()),
    (error) => error instanceof OperationError && error.code === 'OUTCOME_UNKNOWN'
      && error.outcome === 'OUTCOME_UNKNOWN' && error.safeDetails?.reason === 'invalid_response',
  );
  assert.equal(requestContext.posts().length, 1);
});

test('backend refuses an unmapped or unsupported operation explicitly', async () => {
  const { backend } = backendWith(fakeRequestContext(apiResponse({ body: {} })));
  await assert.rejects(
    backend.read(describeOperation('get_post_flairs', { subreddit: 'node' }), context()),
    (error) => error instanceof OperationError
      && error.code === 'UNSUPPORTED_OPERATION'
      && error.safeDetails?.reason === 'flair_path_not_evidenced',
  );
});

test('the production dispatcher factory signature creates a working replay backend', async () => {
  const { createBackendFactories } = await import('../src/dispatch.js');
  const requestContext = fakeRequestContext(async ({ url }) => {
    if (url === 'https://www.reddit.com/api/me.json') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: await fixtureText('listing.json') });
  });
  const sessions = fakeSessions({ requestContext });
  const factories = createBackendFactories({ browserSessions: sessions, secretStore: null });
  const backend = await factories.replay({
    snapshot: snapshot(),
    settings: { botFooter: '', visibility: 'visible', homeDir: process.cwd() },
    cacheGeneration: null,
  });
  assert.equal(backend.id, 'replay');
  const probe = await backend.probe(context());
  assert.equal(probe.username, 'alice');
  const result = await backend.read(describeOperation('browse_subreddit', { subreddit: 'node' }), context());
  assert.equal(result.data.items.length, 2);
  await backend.close();
});

test('backend composes the evidenced user_analysis reads without inventing endpoints', async () => {
  const about = await fixtureText('user-about.json');
  const listing = await fixtureText('listing.json');
  const requestContext = fakeRequestContext(({ url }) => {
    if (url.includes('/user/alice/about.json')) return apiResponse({ body: about });
    return apiResponse({ body: listing });
  });
  const { backend } = backendWith(requestContext);
  const result = await backend.read(describeOperation('user_analysis', { username: 'alice' }), context());
  assert.equal(result.data.account.name, 'alice');
  assert.equal(result.data.sampledPosts, 2);
  assert.equal(result.data.sampledComments, 2);
  assert.deepEqual(result.data.activeSubreddits, [{ name: 'node', count: 4 }]);
  const urls = requestContext.calls.map((call) => call.url);
  assert.ok(urls.some((url) => url.includes('/user/alice/submitted.json')));
  assert.ok(urls.some((url) => url.includes('/user/alice/comments.json')));
  assert.ok(urls.every((url) => url.startsWith('https://www.reddit.com/')));
});

test('backend self-test reports replay checks without claiming an OAuth auth mode', async () => {
  const requestContext = fakeRequestContext(apiResponse({ body: await fixtureText('popular.json') }));
  const { backend } = backendWith(requestContext);
  const result = await backend.read(describeOperation('test_reddit_mcp_server', {}), context());
  assert.equal(result.data.authMode, 'replay');
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.checks.map((check) => check.name), ['read: popular subreddits', 'account: whoami']);
  assert.equal(result.data.checks[1].detail, 'alice');
});

test('backend self-test reports a failed replay check instead of inventing success', async () => {
  const requestContext = fakeRequestContext(apiResponse({ status: 500, body: '{}' }));
  const { backend } = backendWith(requestContext);
  const result = await backend.read(describeOperation('test_reddit_mcp_server', {}), context());
  assert.equal(result.data.ok, false);
  assert.equal(result.data.checks[0].ok, false);
  assert.equal(result.data.checks[0].detail, 'BACKEND_UNAVAILABLE');
});

test('a successful identity probe never widens the finite mapping inventory', async () => {
  const { backend } = backendWith(fakeRequestContext(apiResponse({ body: {} })));
  const before = await backend.capabilities(context());
  await backend.probe(context());
  const after = await backend.capabilities(context());
  assert.deepEqual(after.reads, before.reads);
  assert.equal(REPLAY_MAPPINGS.get_post_flairs, undefined);
  assert.equal(REPLAY_MAPPINGS.raw_post, undefined);
  assert.throws(() => {
    REPLAY_MAPPINGS.browse_subreddit.path = '/api/vote/';
  }, TypeError);
});

test('a redirect to a login or non-evidenced page is refused, not followed', async () => {
  const requestContext = fakeRequestContext(apiResponse({ status: 302, body: '', headers: { location: '/login' } }));
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }) });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context()),
    (error) => error instanceof OperationError
      && error.code === 'BACKEND_UNAVAILABLE'
      && error.safeDetails?.reason === 'redirect_not_allowed',
  );
  assert.equal(requestContext.calls.length, 1);
});

test('a browserless request factory can probe identity from the same own session', async () => {
  const requestContext = fakeRequestContext(apiResponse({ body: await fixtureText('me.json') }));
  const transport = createReplayTransport({
    requestFactory: async ({ profileId }) => {
      assert.equal(profileId, 'p_one');
      return requestContext;
    },
  });
  const probe = await transport.probe(context());
  assert.equal(probe.username, 'alice');
  assert.equal(requestContext.calls.length, 1);
  assert.equal(requestContext.calls[0].url, 'https://www.reddit.com/api/me.json');
});

test('a replay read completes through the real dispatcher with list-shaped missing fields', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-replay-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const registry = createProfileRegistry({ homeDir: home });
  const profile = await registry.add({ alias: 'main' });
  await registry.update(profile.id, { enabledBackends: ['replay'], backendPreference: ['replay'] });
  await registry.bindIdentity(profile.id, { username: 'alice' });
  await registry.setDefault(profile.id);

  const listing = await fixtureText('listing.json');
  const about = await fixtureText('user-about.json');
  const requestContext = fakeRequestContext(({ url }) => {
    if (url.includes('/user/alice/about.json')) return apiResponse({ body: about });
    return apiResponse({ body: listing });
  });
  const sessions = fakeSessions({ requestContext });
  const runtime = { ...readRuntimeSettings({ REDDIT_CLI_HOME: home }), minGapMs: 0 };
  const dispatcher = createDispatcher({
    registry,
    settings: runtime,
    clock: () => 1_000_000,
    env: { REDDIT_CLI_HOME: home },
    backendFactories: {
      replay: async ({ snapshot, settings }) => createReplayBackend({
        transport: createReplayTransport({ sessionManager: sessions, clock: () => 1_000_000 }),
        snapshot,
        settings,
        clock: () => 1_000_000,
      }),
    },
  });

  const read = await dispatcher.execute('browse_subreddit', { subreddit: 'node' }, { backend: 'replay' });
  assert.equal(read.data.items.length, 2);
  assert.equal(read.meta.backend, 'replay');
  assert.equal(read.meta.completeness, 'unknown');
  assert.deepEqual(read.meta.missingFields ?? [], []);

  const composite = await dispatcher.execute('user_analysis', { username: 'alice' }, { backend: 'replay' });
  assert.equal(composite.data.account.name, 'alice');
  assert.deepEqual(composite.meta.missingFields ?? [], []);
});

test('each replay write re-verifies the signed-in account, so a switched account is never written as the old one', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: await fixtureText('submit.json') });
  });
  let signedIn = identityRecord();
  const sessions = {
    opens: [],
    async open(target, options) {
      this.opens.push({ target, options });
      return { id: target.id, requestContext };
    },
    async identity(profileId) {
      return { ...signedIn, profileId };
    },
  };
  const transport = createReplayTransport({ sessionManager: sessions, clock: () => 1_000_000 });

  // A read caches alice's verified identity for a bounded window.
  await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());

  // The visible profile is signed out and back in as a different account without re-enrollment.
  signedIn = identityRecord({ username: 'mallory', accountKey: deriveAccountKey(usernameKey('mallory')) });
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.create_post, operation.args, context()),
    (error) => error instanceof OperationError && error.code === 'IDENTITY_MISMATCH',
  );
  assert.equal(requestContext.posts().length, 0);
});

test('each replay write reads the session modhash again instead of reusing a stale one', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: await fixtureText('submit.json') });
  });
  const transport = createReplayTransport({ sessionManager: fakeSessions({ requestContext }), clock: () => 1_000_000 });
  const first = describeOperation('create_post', { subreddit: 'node', title: 'One', text: 'Body' });
  const second = describeOperation('create_post', { subreddit: 'node', title: 'Two', text: 'Body' });
  await transport.request(REPLAY_MAPPINGS.create_post, first.args, context());
  await transport.request(REPLAY_MAPPINGS.create_post, second.args, context());
  const meReads = requestContext.calls.filter((call) => call.url === 'https://www.reddit.com/api/me.json');
  assert.equal(meReads.length, 2);
  assert.equal(requestContext.posts().length, 2);
});

test('a read recovers once from an idle-closed session instead of failing until process restart', async () => {
  const listing = await fixtureText('listing.json');
  const me = await fixtureText('me.json');
  let closed = false;
  let opens = 0;
  const first = fakeRequestContext(async ({ url }) => {
    if (closed) throw new Error('Target page, context or browser has been closed');
    return apiResponse({ body: url.endsWith('/api/me.json') ? me : listing });
  });
  const second = fakeRequestContext(({ url }) => apiResponse({ body: url.endsWith('/api/me.json') ? me : listing }));
  const sessions = {
    async open() {
      opens += 1;
      closed = false;
      return { id: 'p_one', requestContext: opens === 1 ? first : second };
    },
    async identity(profileId) {
      if (closed) {
        throw new OperationError('PROFILE_NOT_FOUND', 'No browser session is open for this profile in this process.', {
          safeDetails: { profileId, sessionOpen: false },
        });
      }
      return { ...identityRecord(), profileId };
    },
  };
  const transport = createReplayTransport({ sessionManager: sessions, clock: () => 1_000_000 });

  await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());
  closed = true;
  const recovered = await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());
  assert.equal(opens, 2);
  assert.equal(recovered.json.data.children.length, 2);
});

test('a write through a dead cached session is never sent twice and the next read reopens the session', async () => {
  const listing = await fixtureText('listing.json');
  const me = await fixtureText('me.json');
  let closed = false;
  let opens = 0;
  const dead = fakeRequestContext(async () => {
    throw new Error('Target page, context or browser has been closed');
  });
  const fresh = fakeRequestContext(({ url }) => apiResponse({ body: url.endsWith('/api/me.json') ? me : listing }));
  const sessions = {
    async open() {
      opens += 1;
      closed = false;
      return { id: 'p_one', requestContext: opens === 1 ? dead : fresh };
    },
    async identity(profileId) {
      return { ...identityRecord(), profileId };
    },
  };
  const transport = createReplayTransport({ sessionManager: sessions, clock: () => 1_000_000 });
  const operation = describeOperation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  // The failure happens while reading the session modhash, before the POST, so it is a known failure
  // rather than an unknown write. The mutation is never attempted.
  await assert.rejects(
    transport.request(REPLAY_MAPPINGS.create_post, operation.args, context()),
    (error) => error instanceof OperationError
      && error.code === 'BACKEND_UNAVAILABLE'
      && error.safeDetails?.reason === 'transport_error',
  );
  assert.equal(dead.posts().length, 0);

  closed = true;
  const read = await transport.request(REPLAY_MAPPINGS.browse_subreddit, { subreddit: 'node' }, context());
  assert.equal(opens, 2);
  assert.equal(read.json.data.children.length, 2);
});

test('the modhash and session cookies never appear in a write result or a refusal error', async () => {
  const requestContext = fakeRequestContext(async ({ options }) => {
    if (String(options.method).toUpperCase() === 'GET') return apiResponse({ body: await fixtureText('me.json') });
    return apiResponse({ body: { json: { errors: [['RATELIMIT', 'try later']], data: {} } } });
  });
  const { backend } = backendWith(requestContext);
  const operation = describeOperation('vote_on_thing', { fullname: 't1_abc', direction: 'up' });
  const prepared = await backend.prepareWrite(operation, context());
  await assert.rejects(
    backend.commitWrite(prepared, context()),
    (error) => {
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes('modhash-from-own-session'), false);
      assert.equal(serialized.includes('try later'), false);
      assert.equal(error.code, 'THROTTLED');
      assert.equal(error.safeDetails?.reason, 'rate_limited');
      assert.equal(error.safeDetails?.errorCode, 'RATELIMIT');
      return true;
    },
  );
  assert.equal(requestContext.posts().length, 1);
});
