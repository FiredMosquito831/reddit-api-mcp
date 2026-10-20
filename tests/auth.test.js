import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient, RedditError } from '../src/client.js';
import { clientCredentialsGrant, passwordGrant, TOKEN_URL } from '../src/oauth.js';
import { fakeClock, jsonResponse, memoryStore, recordingFetch } from './helpers.js';

const API = 'https://oauth.reddit.com';
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

test('the password grant sends the username and password with Basic auth, and stores nothing', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'AT', expires_in: 3600, scope: 'identity read' }));
  const tokens = await passwordGrant({
    fetch,
    clientId: 'abc',
    clientSecret: 'shh',
    userAgent: 'UA/1',
    username: 'alice',
    password: 'pw:123456',
  });
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].init.headers.authorization, basic('abc', 'shh'));
  assert.deepEqual(calls[0].body, { grant_type: 'password', username: 'alice', password: 'pw:123456' });
  assert.equal(tokens.accessToken, 'AT');
  assert.equal(tokens.refreshToken, null);
});

test('the app-only grant sends client_credentials with the client secret', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'APP', expires_in: 3600 }));
  const tokens = await clientCredentialsGrant({ fetch, clientId: 'abc', clientSecret: 'shh', userAgent: 'UA/1' });
  assert.deepEqual(calls[0].body, { grant_type: 'client_credentials' });
  assert.equal(calls[0].init.headers.authorization, basic('abc', 'shh'));
  assert.equal(tokens.accessToken, 'APP');
});

test('a client with its own token source caches the token until it nearly expires', async () => {
  const clock = fakeClock();
  let issued = 0;
  const { fetch, calls } = recordingFetch(() => jsonResponse({ n: 1 }));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(null),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    obtainToken: async () => {
      issued += 1;
      return { accessToken: `t${issued}`, expiresIn: 3600 };
    },
  });
  await client.request('GET', '/a');
  await client.request('GET', '/b');
  assert.equal(issued, 1);
  await clock.sleep(3_550_000); // inside the one-minute refresh margin
  await client.request('GET', '/c');
  assert.equal(issued, 2);
  const apiCalls = calls.filter((call) => call.url.startsWith(API));
  assert.equal(apiCalls.at(-1).init.headers.authorization, 'bearer t2');
});

test('an app-only session refuses writes before anything is sent', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({}));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(null),
    fetch,
    readOnly: true,
    obtainToken: async () => ({ accessToken: 't', expiresIn: 3600 }),
  });
  await assert.rejects(
    client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    (error) => error instanceof RedditError && /read-only/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('maxAttempts limits how many times a throttled request is retried', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }));
  const clock = fakeClock();
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    maxAttempts: 2,
    obtainToken: async () => ({ accessToken: 't', expiresIn: 3600 }),
  });
  await assert.rejects(client.request('GET', '/x'), /throttling/);
  assert.equal(calls.filter((call) => call.url.startsWith(API)).length, 2);
});

test('rateLimit reports the headers from the last response', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({}, {
    headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-used': '18', 'x-ratelimit-reset': '300' },
  }));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    cacheTtlMs: 0,
    obtainToken: async () => ({ accessToken: 't', expiresIn: 3600 }),
  });
  await client.request('GET', '/x');
  assert.deepEqual(client.rateLimit(), { remaining: 42, reset: 300, used: 18 });
});
