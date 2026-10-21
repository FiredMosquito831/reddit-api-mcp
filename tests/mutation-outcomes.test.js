import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient, RedditError } from '../src/client.js';
import { TOKEN_URL } from '../src/oauth.js';
import { fakeClock, jsonResponse, memoryStore, recordingFetch, router } from './helpers.js';

const API = 'https://oauth.reddit.com';

function makeClient(route, options = {}) {
  const clock = fakeClock();
  const { fetch, calls } = recordingFetch(route);
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    ...options,
  });
  const apiCalls = () => calls.filter((call) => call.url.startsWith(API));
  const tokenCalls = () => calls.filter((call) => call.url === TOKEN_URL);
  return { client, calls, apiCalls, tokenCalls, clock };
}

const post = (client) => client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } });

function rejectsWith(assertion, promise) {
  return assert.rejects(promise, assertion);
}

test('a mutation whose connection fails is unknown and is never resent', async () => {
  let sent = 0;
  const { client, apiCalls } = makeClient(({ url }) => {
    if (url === TOKEN_URL) return jsonResponse({ access_token: 'a', expires_in: 3600 });
    sent += 1;
    throw new TypeError('socket hang up');
  });
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'OUTCOME_UNKNOWN',
    post(client),
  );
  assert.equal(sent, 1);
  assert.equal(apiCalls().length, 1);
});

test('a mutation answered with HTTP 500 is unknown and is sent exactly once', async () => {
  const { client, apiCalls } = makeClient(router([jsonResponse({ message: 'oops' }, { status: 500 })]));
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'OUTCOME_UNKNOWN' && /HTTP 500/.test(error.message),
    post(client),
  );
  assert.equal(apiCalls().length, 1);
});

test('a mutation answered with unparseable JSON is unknown and is sent exactly once', async () => {
  const { client, apiCalls } = makeClient(router([new Response('<html>busy</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })]));
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'OUTCOME_UNKNOWN',
    post(client),
  );
  assert.equal(apiCalls().length, 1);
});

test('a mutation 401 is a definite known rejection: no refresh-resend', async () => {
  const { client, apiCalls, tokenCalls } = makeClient(
    router([jsonResponse({ message: 'Unauthorized' }, { status: 401 }), jsonResponse({})]),
  );
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN' && error.status === 401,
    post(client),
  );
  assert.equal(apiCalls().length, 1);
  assert.equal(tokenCalls().length, 1);
});

test('a mutation 429 with a short Retry-After is known and is not slept or resent', async () => {
  const { client, apiCalls, clock } = makeClient(
    router([jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }), jsonResponse({})]),
  );
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN',
    post(client),
  );
  assert.equal(apiCalls().length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('a RATELIMIT rejection inside a 200 mutation response is known, not retried', async () => {
  const throttled = {
    json: { errors: [['RATELIMIT', "You're doing that too much. Try again in 30 seconds.", 'ratelimit']] },
  };
  const { client, apiCalls, clock } = makeClient(router([jsonResponse(throttled), jsonResponse({})]));
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN' && /throttling/.test(error.message),
    post(client),
  );
  assert.equal(apiCalls().length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test('any other error list in a 200 mutation response is a definite known rejection', async () => {
  const refused = { json: { errors: [['NO_THING', 'that thing does not exist', 'id']] } };
  const { client, apiCalls } = makeClient(router([jsonResponse(refused)]));
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN' && /NO_THING/.test(error.message),
    post(client),
  );
  assert.equal(apiCalls().length, 1);
});

test('a mutation 403 is a definite known rejection', async () => {
  const { client, apiCalls } = makeClient(router([jsonResponse({}, { status: 403 })]));
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN' && error.status === 403,
    post(client),
  );
  assert.equal(apiCalls().length, 1);
});

test('a local rate-limit wait beyond a minute is a known pre-send refusal', async () => {
  const clock = fakeClock();
  const { fetch, calls } = recordingFetch(router([jsonResponse({}, {
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' },
  }), jsonResponse({}), jsonResponse({})]));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
  });
  await client.request('GET', '/a');
  await rejectsWith(
    (error) => error instanceof RedditError && error.outcome === 'FAILED_KNOWN',
    post(client),
  );
  assert.equal(calls.filter((call) => call.url.startsWith(API)).length, 1);
});

test('GET 401 refresh-and-retry behavior is preserved', async () => {
  const { client, apiCalls } = makeClient(
    router([jsonResponse({ message: 'Unauthorized' }, { status: 401 }), jsonResponse({ name: 'alice' })]),
  );
  assert.deepEqual(await client.request('GET', '/api/v1/me'), { name: 'alice' });
  assert.equal(apiCalls().length, 2);
});

test('GET 429 retry behavior is preserved', async () => {
  const { client, apiCalls, clock } = makeClient(
    router([jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } }), jsonResponse({ name: 'alice' })]),
  );
  assert.deepEqual(await client.request('GET', '/api/v1/me'), { name: 'alice' });
  assert.equal(apiCalls().length, 2);
  assert.ok(clock.sleeps.includes(5_000));
});

test('GET RATELIMIT-in-body retry behavior is preserved', async () => {
  const throttled = {
    json: { errors: [['RATELIMIT', "You're doing that too much. Try again in 30 seconds.", 'ratelimit']] },
  };
  const accepted = { json: { errors: [], data: { things: [] } } };
  const { client, clock } = makeClient(router([jsonResponse(throttled), jsonResponse(accepted)]));
  assert.deepEqual(
    await client.request('GET', '/api/morechildren', { query: { api_type: 'json' } }),
    accepted,
  );
  assert.ok(clock.sleeps.includes(30_000));
});
