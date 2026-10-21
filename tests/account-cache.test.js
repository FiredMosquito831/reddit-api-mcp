import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedditClient } from '../src/client.js';
import { fakeClock, jsonResponse, recordingFetch, router } from './helpers.js';

const API = 'https://oauth.reddit.com';

function fakeGeneration(start = 0) {
  let value = start;
  const reads = [];
  const bumps = [];
  return {
    reads,
    bumps,
    async current() {
      reads.push(value);
      return value;
    },
    async bump() {
      value += 1;
      bumps.push(value);
      return value;
    },
    get value() {
      return value;
    },
  };
}

function makeClient(route, { generation = null, namespace = null, cacheTtlMs = 60_000 } = {}) {
  const clock = fakeClock();
  const { fetch, calls } = recordingFetch(route);
  const client = createRedditClient({
    clientId: 'abc',
    userAgent: 'UA/1',
    store: null,
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    cacheTtlMs,
    cacheGeneration: generation,
    cacheNamespace: namespace,
    obtainToken: async () => ({ accessToken: 'token-1', expiresIn: 3600 }),
  });
  return { client, clock, apiCalls: () => calls.filter((call) => call.url.startsWith(API)) };
}

const VOTE_OK = jsonResponse({ json: { errors: [], data: {} } });

test('a successful write bumps the account generation so another client refetches', async () => {
  const generation = fakeGeneration();
  const a = makeClient(router([jsonResponse({ n: 1 }), VOTE_OK]), { generation, namespace: 'profile-a' });
  const b = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })]), { generation, namespace: 'profile-a' });
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(await b.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.equal(b.apiCalls().length, 1);

  await a.client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } });
  assert.equal(generation.value, 1);
  assert.equal(generation.bumps.length, 1);

  assert.deepEqual(await b.client.request('GET', '/r/node/hot'), { n: 2 });
  assert.equal(b.apiCalls().length, 2);
});

test('an unknown mutation also invalidates same-account cached reads', async () => {
  const generation = fakeGeneration();
  const a = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({}, { status: 500 })]), { generation, namespace: 'profile-a' });
  const b = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })]), { generation, namespace: 'profile-a' });
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(await b.client.request('GET', '/r/node/hot'), { n: 1 });
  await assert.rejects(
    a.client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    (error) => error.outcome === 'OUTCOME_UNKNOWN',
  );
  assert.equal(generation.value, 1);
  assert.deepEqual(await b.client.request('GET', '/r/node/hot'), { n: 2 });
});

test('a definite known rejection does not invalidate cached reads', async () => {
  const generation = fakeGeneration();
  const a = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({}, { status: 403 })]), { generation });
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  await assert.rejects(a.client.request('POST', '/api/vote/', { form: {} }), (error) => error.outcome === 'FAILED_KNOWN');
  assert.equal(generation.value, 0);
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.equal(a.apiCalls().length, 2);
});

test('the generation is read asynchronously before each cached read', async () => {
  const generation = fakeGeneration();
  const { client } = makeClient(router([jsonResponse({ n: 1 })]), { generation });
  await client.request('GET', '/r/node/hot');
  assert.equal(generation.reads.length, 1);
  await client.request('GET', '/r/node/hot');
  assert.equal(generation.reads.length, 2);
  assert.equal(generation.reads[0], 0);
});

test('an unavailable generation store bypasses the cache instead of serving stale data', async () => {
  let fail = false;
  const generation = {
    async current() {
      if (fail) throw new Error('generation file unreadable');
      return 0;
    },
    async bump() {
      return 1;
    },
  };
  const { client, apiCalls } = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })]), { generation });
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 1 });
  fail = true;
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
  assert.equal(apiCalls().length, 2);
});

test('caches from different profile namespaces are never shared', async () => {
  const a = makeClient(router([jsonResponse({ n: 1 })]), { namespace: 'profile-a' });
  const b = makeClient(router([jsonResponse({ n: 2 })]), { namespace: 'profile-b' });
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(await b.client.request('GET', '/r/node/hot'), { n: 2 });
  assert.equal(b.apiCalls().length, 1);
});

test('two clients with the same namespace and no generation still share nothing locally', async () => {
  const a = makeClient(router([jsonResponse({ n: 1 })]));
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(await a.client.request('GET', '/r/node/hot'), { n: 1 });
  assert.equal(a.apiCalls().length, 1);
});

test('a successful mutation whose generation bump fails is still a success and clears local cache', async () => {
  const generation = {
    async current() {
      return 0;
    },
    async bump() {
      throw new Error('generation file is read-only');
    },
  };
  const { client } = makeClient(
    router([jsonResponse({ n: 1 }), jsonResponse({ json: { errors: [], data: {} } }), jsonResponse({ n: 2 })]),
    { generation },
  );
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 1 });
  assert.deepEqual(
    await client.request('POST', '/api/vote/', { form: { id: 't3_a', dir: '1' } }),
    { json: { errors: [], data: {} } },
  );
  // The local copy is dropped even though the cross-process generation could not advance.
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
});

test('invalidate() still surfaces a generation failure to an explicit caller', async () => {
  const generation = {
    async current() {
      return 0;
    },
    async bump() {
      throw new Error('generation file is read-only');
    },
  };
  const { client } = makeClient(router([]), { generation });
  await assert.rejects(client.invalidate(), /generation file is read-only/);
});

test('invalidate() clears only this client cache and advances a supplied generation', async () => {
  const generation = fakeGeneration();
  const { client, apiCalls } = makeClient(router([jsonResponse({ n: 1 }), jsonResponse({ n: 2 })]), { generation });
  await client.request('GET', '/r/node/hot');
  await client.invalidate();
  assert.equal(generation.value, 1);
  assert.deepEqual(await client.request('GET', '/r/node/hot'), { n: 2 });
  assert.equal(apiCalls().length, 2);
});
