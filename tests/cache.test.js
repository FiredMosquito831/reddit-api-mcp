import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient } from '../src/client.js';
import { fakeClock, jsonResponse, memoryStore, recordingFetch, router } from './helpers.js';

const API = 'https://oauth.reddit.com';

function makeClient(responses, cacheTtlMs) {
  const clock = fakeClock();
  const { fetch, calls } = recordingFetch(router(responses));
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: memoryStore(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    cacheTtlMs,
  });
  return { client, calls, clock, apiCalls: () => calls.filter((call) => call.url.startsWith(API)).length };
}

test('a repeated GET inside the TTL is served from the cache', async () => {
  const { client, apiCalls } = makeClient([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })], 60_000);
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 1 });
  assert.equal(apiCalls(), 1);
});

test('the cache expires after the TTL', async () => {
  const { client, clock } = makeClient([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })], 60_000);
  await client.request('GET', '/r/node/hot');
  await clock.sleep(61_000);
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
});

test('a successful write clears the cache', async () => {
  const { client } = makeClient([
    jsonResponse({ n: 1 }),
    jsonResponse({ json: { errors: [], data: {} } }),
    jsonResponse({ n: 2 }),
  ], 60_000);
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 1 });
  await client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } });
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
});

test('a TTL of zero turns caching off', async () => {
  const { client, apiCalls } = makeClient([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })], 0);
  await client.request('GET', '/r/node/hot');
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
  assert.equal(apiCalls(), 2);
});
