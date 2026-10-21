import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient, parseWaitMs, RedditError } from '../src/client.js';
import { TOKEN_URL } from '../src/oauth.js';
import { fakeClock, jsonResponse, memoryStore, recordingFetch, router } from './helpers.js';

const UA = 'node:reddit-cli:test (by /u/alice)';
const API = 'https://oauth.reddit.com';

function makeClient({ route = router([]), store = memoryStore(), requestsPerMinute } = {}) {
  const { fetch, calls } = recordingFetch(route);
  const clock = fakeClock();
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: UA,
    store,
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    requestsPerMinute,
  });
  return { client, calls, clock };
}

const apiCalls = (calls) => calls.filter((call) => call.url.startsWith(API));

test('requests go to oauth.reddit.com with the bearer token and User-Agent', async () => {
  const { client, calls } = makeClient({ route: router([jsonResponse({ name: 'alice' })]) });
  const me = await client.request('GET', '/api/v1/me');
  assert.equal(me.name, 'alice');
  const [call] = apiCalls(calls);
  assert.equal(call.url, `${API}/api/v1/me`);
  assert.equal(call.init.headers.authorization, 'bearer access-1');
  assert.equal(call.init.headers['user-agent'], UA);
});

test('GET sends query parameters and POST sends a form body', async () => {
  const { client, calls } = makeClient({ route: router([jsonResponse({}), jsonResponse({})]) });
  await client.request('GET', '/r/node/top', { query: { limit: 5, t: 'week' } });
  await client.request('POST', '/api/vote/', { form: { id: 't3_abc', dir: '1' } });
  const [get, post] = apiCalls(calls);
  assert.equal(get.url, `${API}/r/node/top?limit=5&t=week`);
  assert.equal(get.init.body, undefined);
  assert.equal(post.init.method, 'POST');
  assert.deepEqual(post.body, { id: 't3_abc', dir: '1' });
});

test('without a stored refresh token the client refuses to call Reddit', async () => {
  const { client, calls } = makeClient({ store: memoryStore(null) });
  await assert.rejects(client.request('GET', '/api/v1/me'), /reddit-cli login/);
  assert.equal(calls.length, 0);
});

test('a rotated refresh token from Reddit replaces the stored one', async () => {
  const store = memoryStore('old-token');
  const route = ({ url }) => (url === TOKEN_URL
    ? jsonResponse({ access_token: 'a', expires_in: 3600, refresh_token: 'new-token' })
    : jsonResponse({ name: 'alice' }));
  const { client } = makeClient({ store, route });
  await client.request('GET', '/api/v1/me');
  assert.equal(store.value, 'new-token');
});

test('a 401 refreshes the token once and retries', async () => {
  const { client, calls } = makeClient({
    route: router([jsonResponse({ message: 'Unauthorized' }, { status: 401 }), jsonResponse({ name: 'alice' })]),
  });
  const me = await client.request('GET', '/api/v1/me');
  assert.equal(me.name, 'alice');
  assert.equal(calls.filter((call) => call.url === TOKEN_URL).length, 2);
});

test('a 429 with a short Retry-After waits, then retries', async () => {
  const { client, calls, clock } = makeClient({
    route: router([
      jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }),
      jsonResponse({ name: 'alice' }),
    ]),
  });
  await client.request('GET', '/api/v1/me');
  assert.ok(clock.sleeps.includes(5_000));
  assert.equal(apiCalls(calls).length, 2);
});

test('a wait longer than a minute is reported to the caller instead of slept through', async () => {
  const { client, clock } = makeClient({
    route: router([jsonResponse({}, { status: 429, headers: { 'retry-after': '600' } })]),
  });
  await assert.rejects(
    client.request('GET', '/api/v1/me'),
    (error) => error instanceof RedditError && /600 seconds/.test(error.message),
  );
  assert.deepEqual(clock.sleeps, []);
});

test('a RATELIMIT error inside a 200 mutation response is known and is not retried', async () => {
  const throttled = {
    json: { errors: [['RATELIMIT', "You're doing that too much. Try again in 30 seconds.", 'ratelimit']] },
  };
  const accepted = { json: { errors: [], data: { ok: true } } };
  const { client, calls, clock } = makeClient({ route: router([jsonResponse(throttled), jsonResponse(accepted)]) });
  await assert.rejects(
    client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN',
  );
  assert.deepEqual(clock.sleeps, []);
  assert.equal(calls.filter((call) => call.url.startsWith(API)).length, 1);
});

test('parseWaitMs understands seconds, minutes, and hours', () => {
  assert.equal(parseWaitMs('Try again in 45 seconds.'), 45_000);
  assert.equal(parseWaitMs('Try again in 3 minutes.'), 180_000);
  assert.equal(parseWaitMs('try again in 1 hour'), 3_600_000);
  assert.equal(parseWaitMs('no hint here'), 60_000);
});

test('the client waits for the one-minute window to slide once the cap is reached', async () => {
  const { client, clock } = makeClient({
    route: router([jsonResponse({}), jsonResponse({}), jsonResponse({})]),
    requestsPerMinute: 2,
  });
  await client.request('GET', '/a');
  await client.request('GET', '/b');
  await client.request('GET', '/c');
  assert.deepEqual(clock.sleeps, [60_000]);
});

test('paths must start with a single slash, and nothing is sent when they do not', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(client.request('GET', '//evil.example/x'), /single slash/);
  assert.equal(calls.length, 0);
});

test('a path that resolves to another host is refused before the token is sent', async () => {
  const { client, calls } = makeClient();
  // WHATWG URL treats a backslash as a slash, so `/\host` becomes `//host` and would carry the
  // bearer token to that host.
  for (const path of ['/\\evil.example/api/v1/me', '/\\/evil.example/api/v1/me', '/\tevil.example/x']) {
    await assert.rejects(
      client.request('GET', path),
      (error) => error instanceof RedditError && /single slash|same host|origin/i.test(error.message),
      `expected ${JSON.stringify(path)} to be refused`,
    );
  }
  await assert.rejects(
    client.request('POST', '/\\evil.example/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN',
  );
  assert.equal(calls.length, 0);
});
