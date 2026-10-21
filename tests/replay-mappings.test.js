// Task 10 mapping-ledger tests. Every mapping is finite: one method, one first-party origin, one
// explicit path builder, and one response normalizer. Evidence is pinned to the Apollo-Reborn commit
// that was inspected; no mapping is promoted to "verified" by these offline tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createActions } from '../src/actions.js';
import { OperationError } from '../src/errors.js';
import { OPERATION_DESCRIPTORS, WRITE_TOOL_NAMES } from '../src/operations.js';
import {
  REPLAY_MAPPINGS,
  REPLAY_ORIGIN,
  REPLAY_READ_TOOLS,
  REPLAY_SOURCE_REF,
  REPLAY_STATUS,
  REPLAY_WRITE_TOOLS,
  UNSUPPORTED_REPLAY_OPERATIONS,
  buildReplayRequest,
  normalizeReplayRead,
  verifyReplayWrite,
} from '../src/replay/mappings.js';
import { fakeClient } from './fake-client.js';

const FIXTURES = new URL('./fixtures/replay/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(fileURLToPath(new URL(name, FIXTURES)), 'utf8'));

const ALICE = { id: 'p_one', alias: 'main', expectedUsername: 'alice', accountKey: null };

test('every mapping is finite and carries a pinned evidence reference', () => {
  const entries = Object.entries(REPLAY_MAPPINGS);
  assert.ok(entries.length > 0);
  for (const [tool, mapping] of entries) {
    assert.equal(mapping.tool, tool);
    assert.ok(['GET', 'POST'].includes(mapping.method), `${tool} method`);
    assert.equal(mapping.origin, REPLAY_ORIGIN);
    assert.match(mapping.origin, /^https:\/\/www\.reddit\.com$/);
    assert.equal(typeof mapping.build, 'function');
    assert.equal(typeof mapping.normalize, 'function');
    assert.ok(['read', 'write'].includes(mapping.kind));
    assert.ok(mapping.inputSchema && typeof mapping.inputSchema === 'object');
    assert.equal(typeof mapping.responseSchema, 'string');
    assert.equal(mapping.sourceRef, REPLAY_SOURCE_REF);
    assert.match(mapping.sourceRef, /32745d3450f4291845220e0d9a6deee33ee6eacf/);
    assert.ok(Object.values(REPLAY_STATUS).includes(mapping.status), `${tool} status`);
    assert.match(mapping.evidence, /Apollo-Reborn|upstream/);
  }
});

test('all eleven write tools have explicit mappings; the four read-only RSS/offline tools do not', () => {
  assert.deepEqual([...REPLAY_WRITE_TOOLS].sort(), [...WRITE_TOOL_NAMES].sort());
  for (const tool of REPLAY_WRITE_TOOLS) assert.equal(REPLAY_MAPPINGS[tool].kind, 'write');
  for (const tool of ['browse_subreddit_rss', 'reddit_explain']) {
    assert.equal(REPLAY_MAPPINGS[tool], undefined);
  }
  const readTools = Object.values(OPERATION_DESCRIPTORS)
    .filter((descriptor) => descriptor.kind === 'read')
    .map((descriptor) => descriptor.tool)
    .filter((tool) => tool !== 'get_post_flairs');
  assert.deepEqual([...REPLAY_READ_TOOLS].sort(), readTools.sort());
});

test('missing operations are listed explicitly with a reason, never guessed', () => {
  assert.deepEqual(Object.keys(UNSUPPORTED_REPLAY_OPERATIONS), ['get_post_flairs']);
  const entry = UNSUPPORTED_REPLAY_OPERATIONS.get_post_flairs;
  assert.equal(entry.status, REPLAY_STATUS.UNSUPPORTED);
  assert.equal(entry.reason, 'flair_path_not_evidenced');
  assert.match(entry.sourceRef, /32745d3450f4291845220e0d9a6deee33ee6eacf/);
});

test('read request builders use the evidenced www.reddit.com JSON paths and query parameters', () => {
  assert.deepEqual(buildReplayRequest('browse_subreddit', { subreddit: 'node', sort: 'top', time: 'week', limit: 5, after: 't3_a' }), {
    method: 'GET', origin: REPLAY_ORIGIN, path: '/r/node/top.json', query: { limit: '5', t: 'week', after: 't3_a' }, form: null,
  });
  assert.deepEqual(buildReplayRequest('get_top_posts', { subreddit: 'node', limit: 2 }).path, '/r/node/top.json');
  assert.equal(buildReplayRequest('get_subreddit_info', { subreddit: 'node' }).path, '/r/node/about.json');
  assert.equal(buildReplayRequest('get_subreddit_rules', { subreddit: 'node' }).path, '/r/node/about/rules.json');
  assert.deepEqual(buildReplayRequest('get_trending_subreddits', { limit: 3 }).query, { limit: '3' });
  assert.equal(buildReplayRequest('get_trending_subreddits', {}).path, '/subreddits/popular.json');
  assert.equal(buildReplayRequest('search_reddit', { query: 'hello world', subreddit: 'node', sort: 'new' }).path, '/r/node/search.json');
  assert.deepEqual(buildReplayRequest('search_reddit', { query: 'hello', author: 'bob', flair: 'Help' }).query, {
    q: 'hello author:bob flair:"Help"', sort: 'relevance', t: 'all', limit: '25', type: 'link',
  });
  assert.equal(buildReplayRequest('get_reddit_post', { id: 'abc', subreddit: 'node' }).path, '/r/node/comments/abc.json');
  assert.equal(buildReplayRequest('get_post_comments', { id: 'abc' }).path, '/comments/abc.json');
  assert.deepEqual(buildReplayRequest('get_more_comments', { postFullname: 't3_abc', childIds: ['t1_a', 't1_b'] }).query, {
    api_type: 'json', link_id: 't3_abc', children: 'a,b',
  });
  assert.equal(buildReplayRequest('get_user_info', { username: 'alice' }).path, '/user/alice/about.json');
  assert.equal(buildReplayRequest('get_user_posts', { username: 'alice', options: { limit: 4 } }).path, '/user/alice/submitted.json');
  assert.equal(buildReplayRequest('get_user_comments', { username: 'alice', options: {} }).path, '/user/alice/comments.json');
  assert.equal(buildReplayRequest('get_my_overview', { limit: 5 }, { username: 'alice' }).path, '/user/alice/overview.json');
  assert.equal(buildReplayRequest('get_my_saved', {}, { username: 'alice' }).path, '/user/alice/saved.json');
  assert.equal(buildReplayRequest('list_my_subreddits', {}, { username: 'alice' }).path, '/subreddits/mine/subscriber.json');
  assert.equal(buildReplayRequest('get_me', {}).path, '/api/me.json');
});

test('identity-required reads cannot be built without the verified session username', () => {
  assert.throws(
    () => buildReplayRequest('get_my_saved', {}),
    (error) => error instanceof OperationError && error.code === 'IDENTITY_UNVERIFIED',
  );
});

test('mapping builders reject unknown or malformed parameters instead of passing them through', () => {
  assert.throws(() => buildReplayRequest('browse_subreddit', { subreddit: '../evil', sort: 'hot' }), /subreddit/i);
  assert.throws(() => buildReplayRequest('search_reddit', { query: 'x', sort: 'bogus' }), /sort/i);
  assert.throws(() => buildReplayRequest('vote_on_thing', { fullname: 't3_abc', direction: 'sideways' }), /direction/i);
  assert.equal(buildReplayRequest('unknown_tool', {}), undefined);
});

test('write builders match the official-API plan forms', () => {
  const submit = buildReplayRequest('create_post', { subreddit: 'node', title: 'Hi', text: 'Body' }, { footer: '\n\nbot' });
  assert.equal(submit.method, 'POST');
  assert.equal(submit.path, '/api/submit/');
  assert.deepEqual(submit.form, { api_type: 'json', sr: 'node', kind: 'self', title: 'Hi', text: 'Body\n\nbot' });
  assert.deepEqual(buildReplayRequest('create_post', { subreddit: 'node', title: 'Hi', url: 'https://example.com/x' }).form, {
    api_type: 'json', sr: 'node', kind: 'link', title: 'Hi', url: 'https://example.com/x',
  });
  assert.deepEqual(buildReplayRequest('reply_to_post', { parent: 't3_abc', text: 'Hi' }, { footer: ' #bot' }).form, {
    api_type: 'json', thing_id: 't3_abc', text: 'Hi #bot',
  });
  assert.deepEqual(buildReplayRequest('edit_comment', { fullname: 't1_abc', text: 'New' }).form, {
    api_type: 'json', thing_id: 't1_abc', text: 'New',
  });
  assert.deepEqual(buildReplayRequest('delete_post', { fullname: 't3_abc' }).form, { id: 't3_abc' });
  assert.deepEqual(buildReplayRequest('save_content', { fullname: 't1_abc' }).form, { id: 't1_abc' });
  assert.deepEqual(buildReplayRequest('unsave_content', { fullname: 't1_abc' }).path, '/api/unsave/');
  assert.deepEqual(buildReplayRequest('vote_on_thing', { fullname: 't1_abc', direction: 'up' }).form, { id: 't1_abc', dir: '1' });
  assert.deepEqual(buildReplayRequest('subscribe_to_subreddit', { subreddit: 'node' }).form, { action: 'sub', sr_name: 'node' });
  assert.deepEqual(buildReplayRequest('unsubscribe_from_subreddit', { subreddit: 'node' }).form, { action: 'unsub', sr_name: 'node' });
});

test('read normalizers preserve the existing action result shapes exactly', async () => {
  const listing = await fixture('listing.json');
  const { client } = fakeClient(listing);
  const actions = createActions({ client });
  const apiListing = await actions.feed({ subreddit: 'node' });
  assert.deepEqual(normalizeReplayRead('browse_subreddit', listing), apiListing);

  const apiTop = await actions.topPosts({ subreddit: 'node' });
  assert.deepEqual(normalizeReplayRead('get_top_posts', listing), apiTop);

  const comments = await fixture('comments.json');
  const { client: commentClient } = fakeClient(comments);
  const commentActions = createActions({ client: commentClient });
  const apiComments = await commentActions.readPost({ id: 'abc', subreddit: 'node' });
  assert.deepEqual(normalizeReplayRead('get_post_comments', comments), apiComments);

  const me = await fixture('me.json');
  // The official API's whoami shape is flat; the web /api/me.json payload nests it under `data`.
  const apiMe = { name: me.data.name, link_karma: me.data.link_karma, comment_karma: me.data.comment_karma };
  const { client: meClient } = fakeClient(apiMe);
  assert.deepEqual(normalizeReplayRead('get_me', me), await createActions({ client: meClient }).whoami());

  const about = await fixture('user-about.json');
  const { client: aboutClient } = fakeClient(about);
  assert.deepEqual(
    normalizeReplayRead('get_user_info', about),
    await createActions({ client: aboutClient }).userInfo('alice'),
  );

  assert.deepEqual(normalizeReplayRead('get_subreddit_rules', await fixture('rules.json')), [
    { shortName: 'Be kind', description: 'No harassment.', kind: 'link' },
    { shortName: 'Stay on topic', description: 'Node only.', kind: 'all' },
  ]);
  assert.deepEqual(normalizeReplayRead('get_trending_subreddits', await fixture('popular.json')), ['node', 'javascript']);
  assert.deepEqual(normalizeReplayRead('list_my_subreddits', await fixture('subscriptions.json')), ['node', 'programming']);

  const more = await fixture('morechildren.json');
  const { client: moreClient } = fakeClient(more);
  assert.deepEqual(
    normalizeReplayRead('get_more_comments', more),
    await createActions({ client: moreClient }).moreComments({ postFullname: 't3_abc', childIds: ['a', 'b'] }),
  );
});

test('subreddit info and search normalize to the API action shapes', async () => {
  const about = {
    kind: 't5',
    data: { display_name: 'node', title: 'Node.js', subscribers: 100, public_description: 'JavaScript' },
  };
  const { client } = fakeClient(about);
  assert.deepEqual(
    normalizeReplayRead('get_subreddit_info', about),
    await createActions({ client }).subreddit('node'),
  );

  const listing = await fixture('listing.json');
  const { client: searchClient } = fakeClient(listing);
  assert.deepEqual(
    normalizeReplayRead('search_reddit', listing, { query: 'hello' }),
    await createActions({ client: searchClient }).search({ query: 'hello' }),
  );
});

test('a malformed read payload fails closed with a canonical, body-free error', () => {
  assert.throws(
    () => normalizeReplayRead('browse_subreddit', { kind: 'Listing', data: { children: 'nope' } }),
    (error) => error instanceof OperationError && error.code === 'BACKEND_UNAVAILABLE'
      && error.safeDetails?.reason === 'invalid_response',
  );
  assert.throws(
    () => normalizeReplayRead('get_me', { data: {} }),
    (error) => error instanceof OperationError && error.code === 'LOGIN_REQUIRED',
  );
});

test('write verification requires real evidence for submit, comment, and edit', async () => {
  assert.deepEqual(verifyReplayWrite('create_post', await fixture('submit.json')), {
    id: 'abc123', name: 't3_abc123', url: 'https://www.reddit.com/r/node/comments/abc123/hello/',
  });
  const legacy = await fixture('comment-legacy.json');
  assert.deepEqual(verifyReplayWrite('reply_to_post', legacy), { fullname: 't1_new1', legacy: true });
  assert.deepEqual(verifyReplayWrite('edit_comment', legacy), { fullname: 't1_new1', legacy: true });

  assert.throws(
    () => verifyReplayWrite('create_post', { json: { errors: [], data: {} } }),
    (error) => error instanceof OperationError && error.code === 'OUTCOME_UNKNOWN' && error.outcome === 'OUTCOME_UNKNOWN',
  );
  assert.throws(
    () => verifyReplayWrite('reply_to_post', { json: { errors: [], data: { things: [{ kind: 't1', data: {} }] } } }),
    (error) => error instanceof OperationError && error.code === 'OUTCOME_UNKNOWN',
  );
});

test('legacy jQuery responses are recognized but never treated as proof of a write', async () => {
  const legacy = await fixture('jquery-legacy.json');
  for (const tool of ['delete_post', 'vote_on_thing', 'save_content']) {
    assert.throws(
      () => verifyReplayWrite(tool, legacy),
      (error) => error instanceof OperationError && error.code === 'OUTCOME_UNKNOWN',
      tool,
    );
  }
  // A no-evidence operation is only successful when the endpoint's documented body is an object.
  assert.deepEqual(verifyReplayWrite('delete_post', await fixture('delete-empty.json')), {});
});

test('an in-body RATELIMIT write refusal is a distinct throttle, not a backend outage', () => {
  assert.throws(
    () => verifyReplayWrite('vote_on_thing', { json: { errors: [['RATELIMIT', 'try again in 5 minutes']], data: {} } }),
    (error) => error instanceof OperationError
      && error.code === 'THROTTLED'
      && error.outcome === 'FAILED_KNOWN'
      && error.safeDetails?.reason === 'rate_limited'
      && error.safeDetails?.errorCode === 'RATELIMIT'
      && JSON.stringify(error).includes('try again in 5 minutes') === false,
  );
});

test('write refusal errors are FAILED_KNOWN and carry only the Reddit error code', () => {
  assert.throws(
    () => verifyReplayWrite('create_post', { json: { errors: [['SUBREDDIT_NOTALLOWED', 'no']] } }),
    (error) => error instanceof OperationError
      && error.code === 'BACKEND_UNAVAILABLE'
      && error.outcome === 'FAILED_KNOWN'
      && error.safeDetails?.reason === 'reddit_refusal'
      && !JSON.stringify(error).includes('no'),
  );
});

test('an empty write response only succeeds for the documented empty envelope', async () => {
  // The documented shape is `{json:{errors:[],data:{}}}` (or a bare `{}`). Any unrelated object or
  // alternate error envelope is not evidence that the mutation landed.
  assert.deepEqual(verifyReplayWrite('vote_on_thing', await fixture('delete-empty.json')), {});
  assert.deepEqual(verifyReplayWrite('save_content', {}), {});
  for (const payload of [
    { error: 'something else' },
    { json: { data: { id: 'unrelated' } } },
    { json: { error: 'nope' } },
    { json: { errors: [], data: [], extra: true } },
    { ok: true },
  ]) {
    assert.throws(
      () => verifyReplayWrite('vote_on_thing', payload),
      (error) => error instanceof OperationError
        && error.code === 'OUTCOME_UNKNOWN'
        && error.outcome === 'OUTCOME_UNKNOWN',
      JSON.stringify(payload),
    );
  }
});
