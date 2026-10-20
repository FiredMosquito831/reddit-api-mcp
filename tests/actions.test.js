import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/actions.js';
import { RedditError } from '../src/client.js';
import { createMemoryLog, createWriteGuard } from '../src/safety.js';

// A stand-in for the Reddit client: it records each request and answers with a canned body.
function fakeClient(body = {}) {
  const requests = [];
  return {
    requests,
    client: {
      async request(method, path, options = {}) {
        requests.push({ method, path, ...options });
        return body;
      },
    },
  };
}

function guardWith(log = createMemoryLog()) {
  const clock = { time: 1_000_000 };
  return createWriteGuard({
    log,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
    },
  });
}

test('a listing without a data payload is reported, not crashed on', async () => {
  const { client } = fakeClient({ message: 'Forbidden', error: 403 });
  const actions = createActions({ client, guard: guardWith() });
  await assert.rejects(actions.feed({ subreddit: 'node' }), /unexpected response for this listing/);
});

test('feed builds the listing path and maps the posts', async () => {
  const listing = {
    data: {
      children: [{ kind: 't3', data: { name: 't3_a', score: 7, num_comments: 2, author: 'bob', title: 'Hi', subreddit: 'node' } }],
    },
  };
  const { client, requests } = fakeClient(listing);
  const actions = createActions({ client, guard: guardWith() });
  const { items, after } = await actions.feed({ subreddit: 'node', sort: 'top', time: 'week', limit: 5 });
  assert.equal(requests[0].path, '/r/node/top');
  assert.deepEqual(requests[0].query, { limit: 5, t: 'week' });
  assert.equal(after, null);
  assert.equal(items[0].fullname, 't3_a');
  assert.equal(items[0].score, 7);
  assert.equal(items[0].title, 'Hi');
});

test('bad subreddit names, sorts, and limits are rejected before any request is sent', async () => {
  const { client, requests } = fakeClient({});
  const actions = createActions({ client, guard: guardWith() });
  await assert.rejects(actions.feed({ subreddit: '../admin' }), /Not a valid subreddit/);
  await assert.rejects(actions.feed({ subreddit: 'node', sort: 'best' }), /Sort must be/);
  await assert.rejects(actions.feed({ subreddit: 'node', limit: 500 }), /between 1 and 100/);
  assert.equal(requests.length, 0);
});

test('submitPost sends a self post with JSON responses and returns the post data', async () => {
  const { client, requests } = fakeClient({ json: { errors: [], data: { url: 'https://reddit.com/r/node/x' } } });
  const actions = createActions({ client, guard: guardWith() });
  const result = await actions.submitPost({ subreddit: 'node', title: 'Hello', text: 'Body' });
  assert.equal(requests[0].path, '/api/submit/');
  assert.deepEqual(requests[0].form, {
    api_type: 'json',
    sr: 'node',
    kind: 'self',
    title: 'Hello',
    text: 'Body',
  });
  assert.equal(result.url, 'https://reddit.com/r/node/x');
});

test('submitPost needs exactly one of text or url', async () => {
  const actions = createActions({ client: fakeClient({}).client, guard: guardWith() });
  await assert.rejects(actions.submitPost({ subreddit: 'node', title: 'x' }), /exactly one/);
  await assert.rejects(
    actions.submitPost({ subreddit: 'node', title: 'x', text: 'a', url: 'https://example.com' }),
    /exactly one/,
  );
});

test('a link post uses kind=link and the url', async () => {
  const { client, requests } = fakeClient({ json: { errors: [], data: {} } });
  const actions = createActions({ client, guard: guardWith() });
  await actions.submitPost({ subreddit: 'node', title: 'Read this', url: 'https://example.com' });
  assert.equal(requests[0].form.kind, 'link');
  assert.equal(requests[0].form.url, 'https://example.com');
});

test('Reddit error lists become a RedditError that names the code', async () => {
  const { client } = fakeClient({
    json: { errors: [['SUBREDDIT_NOTALLOWED', 'you are not allowed to post there', 'sr']] },
  });
  const actions = createActions({ client, guard: guardWith() });
  await assert.rejects(
    actions.submitPost({ subreddit: 'node', title: 'x', text: 'y' }),
    (error) => error instanceof RedditError && /SUBREDDIT_NOTALLOWED/.test(error.message),
  );
});

test('comment only accepts post or comment fullnames', async () => {
  const actions = createActions({ client: fakeClient({}).client, guard: guardWith() });
  await assert.rejects(actions.comment({ parent: 't5_abc', text: 'hi' }), /fullname/);
});

test('comment posts thing_id and text', async () => {
  const { client, requests } = fakeClient({ json: { errors: [], data: { things: [] } } });
  const actions = createActions({ client, guard: guardWith() });
  await actions.comment({ parent: 't3_abc', text: 'Nice' });
  assert.equal(requests[0].path, '/api/comment/');
  assert.deepEqual(requests[0].form, { api_type: 'json', thing_id: 't3_abc', text: 'Nice' });
});

test('vote maps up, down, and clear to 1, -1, and 0', async () => {
  const { client, requests } = fakeClient({});
  const actions = createActions({ client, guard: guardWith() });
  await actions.vote({ fullname: 't3_abc', direction: 'up' });
  await actions.vote({ fullname: 't3_abc', direction: 'down' });
  await actions.vote({ fullname: 't3_abc', direction: 'clear' });
  assert.deepEqual(requests.map((request) => request.form.dir), ['1', '-1', '0']);
  assert.equal(requests[0].path, '/api/vote/');
  await assert.rejects(actions.vote({ fullname: 't3_abc', direction: 'toString' }), /Direction/);
});

test('subscribe and unsubscribe send the action and sr_name fields', async () => {
  const { client, requests } = fakeClient({});
  const actions = createActions({ client, guard: guardWith() });
  await actions.subscribe({ subreddit: 'node', subscribe: true });
  await actions.subscribe({ subreddit: 'node', subscribe: false });
  assert.deepEqual(requests.map((request) => [request.path, request.form]), [
    ['/api/subscribe/', { action: 'sub', sr_name: 'node' }],
    ['/api/subscribe/', { action: 'unsub', sr_name: 'node' }],
  ]);
});

test('save and undo-save use the save and unsave endpoints', async () => {
  const { client, requests } = fakeClient({});
  const actions = createActions({ client, guard: guardWith() });
  await actions.save({ fullname: 't3_abc' });
  await actions.save({ fullname: 't3_abc', undo: true });
  assert.deepEqual(requests.map((request) => request.path), ['/api/save/', '/api/unsave/']);
});

test('the guard refuses identical text sent again, ignoring case and spacing', async () => {
  const { client, requests } = fakeClient({ json: { errors: [], data: {} } });
  const actions = createActions({ client, guard: guardWith() });
  await actions.submitPost({ subreddit: 'node', title: 'Same', text: 'Same body' });
  await assert.rejects(
    actions.submitPost({ subreddit: 'node', title: 'same', text: '  same   BODY ' }),
    /Identical text/,
  );
  assert.equal(requests.length, 1);
});

test('raw GET skips the write guard, raw POST goes through it', async () => {
  const log = createMemoryLog();
  const { client, requests } = fakeClient({ name: 'alice' });
  const actions = createActions({ client, guard: guardWith(log) });
  await actions.raw({ method: 'get', path: '/api/v1/me', fields: {} });
  assert.deepEqual(await log.load(), []);
  await actions.raw({ method: 'POST', path: '/api/read_all_messages/', fields: {} });
  assert.equal((await log.load()).length, 1);
  assert.equal(requests[1].method, 'POST');
});

test('raw rejects methods other than GET and POST', async () => {
  const actions = createActions({ client: fakeClient({}).client, guard: guardWith() });
  await assert.rejects(actions.raw({ method: 'DELETE', path: '/x', fields: {} }), /Only GET and POST/);
});
