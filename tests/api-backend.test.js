import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiBackend } from '../src/backends/api.js';
import { createRedditClient } from '../src/client.js';
import { deriveAccountKey, usernameKey } from '../src/accounts.js';
import { createAttemptLedger } from '../src/attempts.js';
import { describeOperation } from '../src/operations.js';
import { createWriteBoundary } from '../src/write-boundary.js';
import { TOKEN_URL } from '../src/oauth.js';
import { fakeClock, jsonResponse, memoryStore, recordingFetch, router } from './helpers.js';

const API = 'https://oauth.reddit.com';
const ALICE_KEY = deriveAccountKey(usernameKey('alice'));
const TOKEN_URL_FOR_TEST = TOKEN_URL;

function snapshot(overrides = {}) {
  return {
    id: 'p_one',
    alias: 'main',
    expectedUsername: 'alice',
    accountKey: ALICE_KEY,
    generation: 1,
    credentialGeneration: 1,
    api: { clientId: 'abc', appType: null },
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    profileId: 'p_one',
    accountKey: ALICE_KEY,
    authMode: 'oauth',
    appOnly: false,
    readOnly: false,
    clientId: 'abc',
    clientSecret: '',
    username: 'alice',
    password: '',
    refreshToken: '',
    userAgent: 'UA/1',
    botFooter: '',
    minGapMs: 2_000,
    maxWritesPerHour: 30,
    cacheTtlMs: 60_000,
    maxAttempts: 4,
    credentialGeneration: 1,
    ...overrides,
  };
}

function build(responses, { snapshotOverrides = {}, configOverrides = {}, clientOptions = {} } = {}) {
  const clock = fakeClock();
  const { fetch, calls } = recordingFetch(router(responses));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    obtainToken: async () => ({ accessToken: 'token-1', expiresIn: 3600 }),
    ...clientOptions,
  });
  const backend = createApiBackend({
    snapshot: snapshot(snapshotOverrides),
    config: config(configOverrides),
    client,
  });
  return {
    backend,
    client,
    clock,
    apiCalls: () => calls.filter((call) => call.url.startsWith(API)),
  };
}

function operation(tool, args) {
  return describeOperation(tool, args);
}

test('reads keep the existing action argument mapping and output shapes', async () => {
  const { backend, apiCalls } = build([
    jsonResponse({ data: { display_name: 'node', title: 'Node', subscribers: 5, public_description: 'js' } }),
    jsonResponse({ data: { children: [], after: null } }),
    jsonResponse({ name: 'alice', link_karma: 1, comment_karma: 2 }),
  ]);
  assert.deepEqual(await backend.read(operation('get_subreddit_info', { subreddit: 'node' })), {
    name: 'node',
    title: 'Node',
    subscribers: 5,
    description: 'js',
  });
  assert.deepEqual(await backend.read(operation('get_user_posts', { username: 'bob', limit: 5 })), {
    items: [],
    after: null,
  });
  assert.deepEqual(await backend.read(operation('get_me', {})), { name: 'alice', linkKarma: 1, commentKarma: 2 });
  assert.deepEqual(apiCalls().map((call) => call.url.replace(API, '')), [
    '/r/node/about',
    '/user/bob/submitted?limit=5&sort=new&t=all',
    '/api/v1/me',
  ]);
});

test('an app-only API backend refuses identity reads and writes before any request', async () => {
  const { backend, apiCalls } = build([], { configOverrides: { authMode: 'app', appOnly: true, readOnly: true } });
  await assert.rejects(
    backend.read(operation('get_me', {})),
    (error) => error.code === 'APP_ONLY_READ_ONLY',
  );
  await assert.rejects(
    backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' })),
    (error) => error.code === 'APP_ONLY_READ_ONLY',
  );
  assert.equal(apiCalls().length, 0);
});

test('an app-only probe reports app-only without calling whoami or user history', async () => {
  const { backend, apiCalls } = build([], { configOverrides: { authMode: 'app', appOnly: true, readOnly: true } });
  assert.deepEqual(await backend.probe(), {
    backend: 'api',
    identity: 'app-only',
    verified: false,
    appOnly: true,
    readOnly: true,
    username: null,
    accountKey: null,
  });
  assert.equal(apiCalls().length, 0);
});

test('a user probe verifies the username and derives the canonical account key', async () => {
  const { backend } = build([jsonResponse({ name: 'Alice', link_karma: 1, comment_karma: 2 })]);
  const status = await backend.probe();
  assert.equal(status.verified, true);
  assert.equal(status.username, 'Alice');
  assert.equal(status.accountKey, ALICE_KEY);
  assert.equal(status.identity, 'user');
});

test('a probe whose account differs from the profile is an identity mismatch', async () => {
  const { backend } = build([jsonResponse({ name: 'bob' })]);
  await assert.rejects(
    backend.probe(),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
});

test('a probe for a profile without a verified account key derives and returns one', async () => {
  const { backend } = build([jsonResponse({ name: 'alice' })], { snapshotOverrides: { accountKey: null } });
  assert.equal((await backend.probe()).accountKey, ALICE_KEY);
});

test('prepareWrite builds the request without touching the network', async () => {
  const { backend, apiCalls } = build([]);
  const prepared = await backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }));
  assert.equal(prepared.path, '/api/submit/');
  assert.equal(prepared.method, 'POST');
  assert.deepEqual(prepared.form, { api_type: 'json', sr: 'node', kind: 'self', title: 'Hi', text: 'Body' });
  assert.equal(apiCalls().length, 0);
});

test('commitWrite preserves the API action data for a post with an id', async () => {
  const data = { id: 'abc', name: 't3_abc', url: 'https://reddit.com/r/node/x' };
  const { backend, apiCalls } = build([jsonResponse({ json: { errors: [], data } })]);
  const prepared = await backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }));
  assert.deepEqual(await backend.commitWrite(prepared), data);
  assert.equal(apiCalls().length, 1);
});

test('a submit 200 without post evidence is unknown, not a false success', async () => {
  const { backend } = build([jsonResponse({ json: { errors: [], data: {} } })]);
  const prepared = await backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }));
  await assert.rejects(
    backend.commitWrite(prepared),
    (error) => error.outcome === 'OUTCOME_UNKNOWN' && /could not|completion/i.test(error.message),
  );
});

test('a comment needs a created thing as evidence', async () => {
  const { backend } = build([
    jsonResponse({ json: { errors: [], data: { things: [] } } }),
    jsonResponse({ json: { errors: [], data: { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] } } }),
  ]);
  const empty = await backend.prepareWrite(operation('reply_to_post', { parent: 't3_a', text: 'hi' }));
  await assert.rejects(backend.commitWrite(empty), (error) => error.outcome === 'OUTCOME_UNKNOWN');
  const ok = await backend.prepareWrite(operation('reply_to_post', { parent: 't3_a', text: 'hi' }));
  assert.deepEqual(await backend.commitWrite(ok), { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] });
});

test('documented empty mutation responses succeed only for the endpoints that document them', async () => {
  const { backend, apiCalls } = build([jsonResponse({}), jsonResponse({}), jsonResponse({}), jsonResponse({})]);
  const del = await backend.prepareWrite(operation('delete_post', { fullname: 't3_abc' }));
  assert.deepEqual(await backend.commitWrite(del), {});
  const vote = await backend.prepareWrite(operation('vote_on_thing', { fullname: 't3_abc', direction: 'up' }));
  assert.deepEqual(await backend.commitWrite(vote), {});
  const sub = await backend.prepareWrite(operation('subscribe_to_subreddit', { subreddit: 'node' }));
  assert.deepEqual(await backend.commitWrite(sub), {});
  const save = await backend.prepareWrite(operation('save_content', { fullname: 't3_abc' }));
  assert.deepEqual(await backend.commitWrite(save), {});
  assert.equal(apiCalls().length, 4);
});

test('an error list in the body of an empty-documented endpoint is a known rejection', async () => {
  const { backend } = build([jsonResponse({ json: { errors: [['BAD', 'nope', 'x']] } })]);
  const prepared = await backend.prepareWrite(operation('vote_on_thing', { fullname: 't3_abc', direction: 'up' }));
  await assert.rejects(backend.commitWrite(prepared), (error) => error.outcome === 'FAILED_KNOWN');
});

test('the raw_post operation uses its own policy/admission key and stays POST-only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-raw-'));
  try {
    const { client } = build([jsonResponse({})]);
    const clock = { time: 1_000_000 };
    const ledger = createAttemptLedger({ homeDir: home, accountKey: ALICE_KEY, clock: () => clock.time });
    const boundary = createWriteBoundary({ ledger, clock: () => clock.time, sleep: async (ms) => { clock.time += ms; } });
    const rawBackend = createApiBackend({ snapshot: snapshot(), config: config(), client, boundary });
    const raw = Object.freeze({
      tool: 'raw_post',
      action: 'raw',
      kind: 'write',
      policyKey: 'raw_post',
      target: 'raw:POST:/api/read_all_messages/',
      requiresIdentity: true,
      contentHash: null,
      args: Object.freeze({ method: 'POST', path: '/api/read_all_messages/', fields: { x: '1' } }),
    });
    const result = await rawBackend.write(raw, {
      accountKey: ALICE_KEY,
      verified: true,
      backendId: 'api',
      profile: { id: 'p_one', alias: 'main', accountKey: ALICE_KEY },
    });
    assert.equal(result.meta.outcome, 'SUCCEEDED');
    const [attempt] = await ledger.listPending();
    assert.equal(attempt, undefined);
    const prepared = await rawBackend.prepareWrite(raw);
    assert.equal(prepared.path, '/api/read_all_messages/');
    await assert.rejects(
      rawBackend.prepareWrite({ ...raw, args: { method: 'GET', path: '/api/v1/me', fields: {} } }),
      (error) => error.code === 'UNSUPPORTED_OPERATION',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('one boundary run performs exactly one reservation and one dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-t7-'));
  try {
    const clock = { time: 1_000_000 };
    const ledger = createAttemptLedger({ homeDir: home, accountKey: ALICE_KEY, clock: () => clock.time });
    const boundary = createWriteBoundary({ ledger, clock: () => clock.time, sleep: async (ms) => { clock.time += ms; } });
    const { backend, client, apiCalls } = build([jsonResponse({ json: { errors: [], data: { id: 'a', name: 't3_a' } } })]);
    const api = createApiBackend({ snapshot: snapshot(), config: config(), client, boundary });
    const result = await api.write(
      operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }),
      {
        accountKey: ALICE_KEY,
        verified: true,
        backendId: 'api',
        profile: { id: 'p_one', alias: 'main', accountKey: ALICE_KEY },
      },
    );
    assert.equal(result.meta.attemptId.length > 0, true);
    assert.equal(result.meta.outcome, 'SUCCEEDED');
    assert.equal(apiCalls().length, 1);
    assert.deepEqual(await ledger.listPending(), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('backend results and errors never contain the access token', async () => {
  const { backend } = build([jsonResponse({ json: { errors: [], data: {} } })]);
  const prepared = await backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }));
  await assert.rejects(backend.commitWrite(prepared), (error) => {
    assert.equal(JSON.stringify(error.toJSON ? error.toJSON() : error.message).includes('token-1'), false);
    return error.outcome === 'OUTCOME_UNKNOWN';
  });
});

test('unsupported and non-read operations are refused before dispatch', async () => {
  const { backend, apiCalls } = build([]);
  await assert.rejects(
    backend.read(operation('reddit_explain', { term: 'karma' })),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
  await assert.rejects(
    backend.read(operation('browse_subreddit_rss', { subreddit: 'node' })),
    (error) => error.code === 'UNSUPPORTED_OPERATION',
  );
  assert.equal(apiCalls().length, 0);
});

// ---- Named-profile API session -------------------------------------------------------------------

function memorySecretStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    ref(profileId, name) {
      return `reddit-cli:profile:${profileId}:${name}`;
    },
    async get(ref) {
      return values.get(ref) ?? null;
    },
    async set(ref, value) {
      values.set(ref, value);
    },
    async delete(ref) {
      return values.delete(ref);
    },
  };
}

test('openApiSession uses the profile secret refs and writes a rotated token back to them', async () => {
  const { openApiSession } = await import('../src/session.js');
  const secretStore = memorySecretStore({});
  secretStore.values.set(secretStore.ref('p_one', 'refreshToken'), 'rt1');
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (url === TOKEN_URL_FOR_TEST) {
      return jsonResponse({ access_token: 'a1', expires_in: 3600, refresh_token: 'rt2' });
    }
    return jsonResponse({ name: 'alice', link_karma: 0, comment_karma: 0 });
  });
  const session = await openApiSession({
    snapshot: { id: 'p_one', alias: 'main', accountKey: null, expectedUsername: 'alice', api: { clientId: 'abc', appType: null } },
    settings: {},
    secretStore,
    fetch,
  });
  assert.equal(session.appOnly, false);
  assert.equal(session.alias, 'main');
  assert.equal(Object.hasOwn(session, 'config'), false);
  assert.equal(JSON.stringify(session).includes('rt1'), false);
  assert.equal(JSON.stringify(session).includes('secret'), false);
  assert.deepEqual(await session.actions.whoami(), { name: 'alice', linkKarma: 0, commentKarma: 0 });
  assert.equal(secretStore.values.get(secretStore.ref('p_one', 'refreshToken')), 'rt2');
  assert.ok(calls.some((call) => call.url === TOKEN_URL_FOR_TEST));
});

test('an app-only profile session refuses writes before any request', async () => {
  const { openApiSession } = await import('../src/session.js');
  const secretStore = memorySecretStore({});
  secretStore.values.set(secretStore.ref('p_app', 'clientSecret'), 'shh');
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'a', expires_in: 3600 }));
  const session = await openApiSession({
    snapshot: { id: 'p_app', alias: 'public', accountKey: null, expectedUsername: null, api: { clientId: 'abc', appType: 'script' } },
    settings: {},
    secretStore,
    fetch,
  });
  assert.equal(session.appOnly, true);
  await assert.rejects(
    session.client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    (error) => error.outcome === 'FAILED_KNOWN' && /read-only/.test(error.message),
  );
  assert.equal(calls.filter((call) => call.url.startsWith(API)).length, 0);
});

test('createActions accepts exactly one admission adapter and routes writes through the new one', async () => {
  const { createActions } = await import('../src/actions.js');
  const requests = [];
  const client = {
    async request(method, path, options = {}) {
      requests.push({ method, path, ...options });
      return { json: { errors: [], data: { id: 'x', name: 't3_x' } } };
    },
  };
  assert.throws(
    () => createActions({ client, guard: { run: async () => ({}) }, writes: { run: async () => ({}) } }),
    /either the legacy guard or a writes adapter/,
  );
  const seen = [];
  const actions = createActions({
    client,
    writes: {
      async run({ operation, perform }) {
        seen.push(operation);
        return perform();
      },
    },
  });
  const createOp = operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' });
  assert.deepEqual(
    await actions.submitPost(createOp.args, { operation: createOp }),
    { id: 'x', name: 't3_x' },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].policyKey, 'create_post');
  assert.equal(requests.length, 1);
});

// ---- Review regressions -------------------------------------------------------------------------

test('an app-only backend derives identity needs from the tool, not caller-supplied metadata', async () => {
  const { backend, apiCalls } = build([], { configOverrides: { authMode: 'app', appOnly: true, readOnly: true } });
  const forgedAccountRead = Object.freeze({
    tool: 'get_my_saved',
    action: 'saved',
    kind: 'read',
    policyKey: 'get_my_saved',
    target: 'me:saved',
    requiresIdentity: false,
    args: Object.freeze({}),
  });
  await assert.rejects(backend.read(forgedAccountRead), (error) => error.code === 'APP_ONLY_READ_ONLY');
  const forgedWhoami = Object.freeze({
    tool: 'get_me',
    action: 'saved',
    kind: 'read',
    policyKey: 'get_me',
    target: 'me',
    requiresIdentity: false,
    args: Object.freeze({}),
  });
  await assert.rejects(backend.read(forgedWhoami), (error) => error.code === 'APP_ONLY_READ_ONLY');
  assert.equal(apiCalls().length, 0);
});

test('an app-only self test never calls whoami even when checkAccount is requested', async () => {
  const { backend, apiCalls } = build([jsonResponse({ data: { children: [{ data: { display_name: 'node' } }] } })], {
    configOverrides: { authMode: 'app', appOnly: true, readOnly: true },
  });
  const result = await backend.read(operation('test_reddit_mcp_server', { checkAccount: true }));
  assert.equal(result.ok, true);
  assert.equal(result.checks.some((check) => check.name.startsWith('account:')), false);
  assert.equal(apiCalls().some((call) => call.url.includes('/api/v1/me')), false);
});

test('app-only capabilities list only public reads and no writes', async () => {
  const { backend } = build([], { configOverrides: { authMode: 'app', appOnly: true, readOnly: true } });
  const caps = await backend.capabilities();
  assert.equal(caps.appOnly, true);
  assert.equal(caps.readOnly, true);
  assert.deepEqual(caps.writes, []);
  assert.equal(caps.reads.includes('get_me'), false);
  assert.equal(caps.reads.includes('get_my_saved'), false);
  assert.equal(caps.reads.includes('get_my_overview'), false);
  assert.equal(caps.reads.includes('list_my_subreddits'), false);
  assert.equal(caps.reads.includes('browse_subreddit'), true);
  assert.equal(Object.isFrozen(caps.reads), true);
});

test('a completion whose only evidence is an empty string is unknown, not success', async () => {
  const submit = build([jsonResponse({ json: { errors: [], data: { name: '' } } })]);
  const post = await submit.backend.prepareWrite(operation('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }));
  await assert.rejects(submit.backend.commitWrite(post), (error) => error.outcome === 'OUTCOME_UNKNOWN');

  const comment = build([jsonResponse({ json: { errors: [], data: { things: [{ kind: 't1', data: { id: '' } }] } } })]);
  const reply = await comment.backend.prepareWrite(operation('reply_to_post', { parent: 't3_a', text: 'hi' }));
  await assert.rejects(comment.backend.commitWrite(reply), (error) => error.outcome === 'OUTCOME_UNKNOWN');
});

test('a raw mutation path cannot escape the API host', async () => {
  const { backend, apiCalls } = build([]);
  const raw = (path) => Object.freeze({
    tool: 'raw_post',
    action: 'raw',
    kind: 'write',
    policyKey: 'raw_post',
    target: 'raw:POST:/x',
    requiresIdentity: true,
    contentHash: null,
    args: Object.freeze({ method: 'POST', path, fields: {} }),
  });
  await assert.rejects(backend.prepareWrite(raw('/\\evil.example/api/vote/')), (error) => error.code === 'UNSUPPORTED_OPERATION');
  await assert.rejects(backend.prepareWrite(raw('//evil.example/api/vote/')), (error) => error.code === 'UNSUPPORTED_OPERATION');
  assert.equal(apiCalls().length, 0);
});

const WRITE_CASES = [
  ['create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }, '/api/submit/', { api_type: 'json', sr: 'node', kind: 'self', title: 'Hi', text: 'Body' }],
  ['reply_to_post', { parent: 't3_a', text: 'hi' }, '/api/comment/', { api_type: 'json', thing_id: 't3_a', text: 'hi' }],
  ['edit_post', { fullname: 't3_a', text: 'new' }, '/api/editusertext/', { api_type: 'json', thing_id: 't3_a', text: 'new' }],
  ['edit_comment', { fullname: 't1_a', text: 'new' }, '/api/editusertext/', { api_type: 'json', thing_id: 't1_a', text: 'new' }],
  ['delete_post', { fullname: 't3_a' }, '/api/del/', { id: 't3_a' }],
  ['delete_comment', { fullname: 't1_a' }, '/api/del/', { id: 't1_a' }],
  ['save_content', { fullname: 't3_a' }, '/api/save/', { id: 't3_a' }],
  ['unsave_content', { fullname: 't3_a' }, '/api/unsave/', { id: 't3_a' }],
  ['vote_on_thing', { fullname: 't3_a', direction: 'up' }, '/api/vote/', { id: 't3_a', dir: '1' }],
  ['subscribe_to_subreddit', { subreddit: 'node' }, '/api/subscribe/', { action: 'sub', sr_name: 'node' }],
  ['unsubscribe_from_subreddit', { subreddit: 'node' }, '/api/subscribe/', { action: 'unsub', sr_name: 'node' }],
];

test('all eleven write tools map to their own plan and policy key', async () => {
  const { backend, apiCalls } = build([]);
  assert.equal(WRITE_CASES.length, 11);
  for (const [tool, args, path, form] of WRITE_CASES) {
    const op = operation(tool, args);
    const prepared = await backend.prepareWrite(op);
    assert.equal(prepared.path, path, tool);
    assert.deepEqual(prepared.form, form, tool);
    assert.equal(prepared.policyKey, tool, tool);
    assert.equal(prepared.tool, tool, tool);
  }
  assert.equal(apiCalls().length, 0);
});

test('every write tool performs exactly one reservation and one dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-t7-all-'));
  try {
    const evidence = {
      create_post: { id: 'a', name: 't3_a' },
      reply_to_post: { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] },
      edit_post: { things: [{ kind: 't3', data: { id: 'a', name: 't3_a' } }] },
      edit_comment: { things: [{ kind: 't1', data: { id: 'c1', name: 't1_c1' } }] },
    };
    const clock = { time: 1_000_000 };
    for (const [tool, args] of WRITE_CASES) {
      const ledger = createAttemptLedger({ homeDir: home, accountKey: ALICE_KEY, clock: () => clock.time });
      const boundary = createWriteBoundary({
        ledger,
        clock: () => clock.time,
        sleep: async (ms) => { clock.time += ms; },
      });
      const body = evidence[tool] ? { json: { errors: [], data: evidence[tool] } } : {};
      const { client, apiCalls } = build([jsonResponse(body)]);
      const api = createApiBackend({ snapshot: snapshot(), config: config(), client, boundary });
      const result = await api.write(operation(tool, args), {
        accountKey: ALICE_KEY,
        verified: true,
        backendId: 'api',
        profile: { id: 'p_one', alias: 'main', accountKey: ALICE_KEY },
      });
      assert.equal(result.meta.outcome, 'SUCCEEDED', tool);
      assert.equal(typeof result.meta.attemptId, 'string', tool);
      assert.equal(apiCalls().length, 1, tool);
      assert.deepEqual(await ledger.listPending(), [], tool);
      clock.time += 5_000;
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
