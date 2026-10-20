import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/actions.js';
import { fakeClient, guardWith } from './fake-client.js';

const post = (overrides = {}) => ({
  name: 't3_abc',
  title: 'Hello',
  author: 'bob',
  subreddit: 'node',
  score: 9,
  num_comments: 2,
  url: 'https://example.com',
  permalink: '/r/node/comments/abc/hello/',
  selftext: '',
  ...overrides,
});

test('readPost fetches the post and flattens its comment tree, collecting "load more" ids', async () => {
  const response = [
    { kind: 'Listing', data: { children: [{ kind: 't3', data: post() }] } },
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't1',
            data: {
              name: 't1_c1',
              author: 'ann',
              body: 'top level',
              score: 3,
              parent_id: 't3_abc',
              replies: {
                data: {
                  children: [
                    { kind: 't1', data: { name: 't1_c2', author: 'ben', body: 'reply', score: 1, parent_id: 't1_c1', replies: '' } },
                    { kind: 'more', data: { children: ['x1', 'x2'] } },
                  ],
                },
              },
            },
          },
          { kind: 'more', data: { children: ['y1'] } },
        ],
      },
    },
  ];
  const { client, requests } = fakeClient(response);
  const actions = createActions({ client, guard: guardWith() });
  const page = await actions.readPost({ id: 't3_abc', subreddit: 'node' });
  assert.equal(requests[0].path, '/r/node/comments/abc');
  assert.deepEqual(requests[0].query, { sort: 'confidence', limit: 100 });
  assert.equal(page.post.fullname, 't3_abc');
  assert.deepEqual(page.comments.map((comment) => [comment.fullname, comment.depth]), [['t1_c1', 0], ['t1_c2', 1]]);
  assert.deepEqual(page.moreIds, ['x1', 'x2', 'y1']);
});

test('readPost checks its options and reports a post it cannot see', async () => {
  const { client } = fakeClient([{ data: { children: [] } }, { data: { children: [] } }]);
  const actions = createActions({ client, guard: guardWith() });
  await assert.rejects(actions.readPost({ id: 'abc', sort: 'best' }), /Comment sort/);
  await assert.rejects(actions.readPost({ id: 'abc', depth: 11 }), /Depth must be between/);
  await assert.rejects(actions.readPost({ id: '../etc' }), /Not a valid Reddit id/);
  await assert.rejects(actions.readPost({ id: 'abc' }), /was not found/);
});

test('moreComments expands ids through morechildren and keeps only comments', async () => {
  const { client, requests } = fakeClient({
    json: {
      errors: [],
      data: {
        things: [
          { kind: 't1', data: { name: 't1_m1', author: 'cy', body: 'more', score: 2, parent_id: 't1_c1' } },
          { kind: 'more', data: {} },
        ],
      },
    },
  });
  const actions = createActions({ client, guard: guardWith() });
  const comments = await actions.moreComments({ postFullname: 't3_abc', childIds: ['t1_c1', 'c2'] });
  assert.equal(requests[0].path, '/api/morechildren');
  assert.deepEqual(requests[0].query, { api_type: 'json', link_id: 't3_abc', children: 'c1,c2' });
  assert.deepEqual(comments.map((comment) => comment.fullname), ['t1_m1']);
  await assert.rejects(actions.moreComments({ postFullname: 'abc', childIds: ['x'] }), /Expected a Reddit fullname/);
  await assert.rejects(
    actions.moreComments({ postFullname: 't3_abc', childIds: Array(101).fill('x') }),
    /between 1 and 100/,
  );
});

test('search uses the global or the subreddit endpoint and returns the cursor', async () => {
  const listing = { data: { children: [{ kind: 't3', data: post() }], after: 't3_abc' } };
  const { client, requests } = fakeClient(listing);
  const actions = createActions({ client, guard: guardWith() });
  const result = await actions.search({ query: 'rust async' });
  assert.equal(requests[0].path, '/search');
  assert.deepEqual(requests[0].query, { q: 'rust async', sort: 'relevance', t: 'all', limit: 25, type: 'link' });
  assert.equal(result.after, 't3_abc');
  await actions.search({ query: 'x', subreddit: 'node', sort: 'new' });
  assert.equal(requests[1].path, '/r/node/search');
  assert.equal(requests[1].query.restrict_sr, 'true');
  await assert.rejects(actions.search({ query: 'x', sort: 'best' }), /Search sort/);
  await assert.rejects(actions.search({ query: '  ' }), /Give a search query/);
});

test('user lookups hit the user endpoints with the listing options', async () => {
  const about = {
    kind: 't2',
    data: { name: 'bob', id: 'u1', link_karma: 10, comment_karma: 5, is_mod: false, is_gold: true, is_employee: false, created_utc: 1700000000 },
  };
  const { client, requests } = fakeClient((method, path) => (path.endsWith('/about') ? about : { data: { children: [], after: null } }));
  const actions = createActions({ client, guard: guardWith() });
  const info = await actions.userInfo('bob');
  assert.equal(info.totalKarma, 15);
  assert.equal(requests[0].path, '/user/bob/about');
  await actions.userPosts('bob', { limit: 5, after: 't3_x' });
  assert.equal(requests[1].path, '/user/bob/submitted');
  assert.deepEqual(requests[1].query, { limit: 5, sort: 'new', t: 'all', after: 't3_x' });
  await actions.userComments('bob');
  assert.equal(requests[2].path, '/user/bob/comments');
  await assert.rejects(actions.userInfo('a'), /Not a valid Reddit username/);
});

test('overview and saved use your account name from whoami', async () => {
  const { client, requests } = fakeClient((method, path) => {
    if (path === '/api/v1/me') return { name: 'Alice', link_karma: 1, comment_karma: 2 };
    return { data: { children: [], after: null } };
  });
  const actions = createActions({ client, guard: guardWith() });
  await actions.overview();
  await actions.saved({ limit: 3 });
  assert.equal(requests[1].path, '/user/Alice/overview');
  assert.equal(requests[3].path, '/user/Alice/saved');
  assert.deepEqual(requests[3].query, { limit: 3 });
});

test('rules, flairs, popular subreddits, and your subscriptions map their fields', async () => {
  const { client, requests } = fakeClient((method, path) => {
    if (path.endsWith('/about/rules')) return { rules: [{ short_name: 'Be kind', description: 'No insults', kind: 'all' }] };
    if (path.endsWith('/api/link_flair_v2')) return [{ id: 'f1', text: 'News', text_editable: false }];
    if (path === '/subreddits/popular') return { data: { children: [{ data: { display_name: 'pics' } }] } };
    return { data: { children: [{ data: { display_name: 'node' } }] } };
  });
  const actions = createActions({ client, guard: guardWith() });
  assert.deepEqual(await actions.rules('node'), [{ shortName: 'Be kind', description: 'No insults', kind: 'all' }]);
  assert.deepEqual(await actions.flairs('node'), [{ id: 'f1', text: 'News', textEditable: false }]);
  assert.deepEqual(await actions.popular({ limit: 3 }), ['pics']);
  assert.deepEqual(await actions.mySubscriptions(), ['node']);
  assert.equal(requests[2].query.limit, 3);
});

test('feed passes the paging cursor, and topPosts asks for the top sort', async () => {
  const { client, requests } = fakeClient({ data: { children: [{ kind: 't3', data: post() }], after: 't3_next' } });
  const actions = createActions({ client, guard: guardWith() });
  const page = await actions.feed({ subreddit: 'node', after: 't3_prev' });
  assert.equal(page.after, 't3_next');
  assert.equal(requests[0].query.after, 't3_prev');
  await actions.topPosts({ subreddit: 'node' });
  assert.equal(requests[1].path, '/r/node/top');
  assert.deepEqual(requests[1].query, { limit: 10, t: 'day' });
});
