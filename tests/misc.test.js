import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActions, parsePostRef } from '../src/actions.js';
import { lookupTerm } from '../src/glossary.js';
import { fakeClient, guardWith } from './fake-client.js';

test('parsePostRef reads reddit.com, old/np/m subdomains, and redd.it short links', () => {
  assert.deepEqual(
    parsePostRef('https://www.reddit.com/r/node/comments/ABC123/some_title/'),
    { subreddit: 'node', id: 'abc123' },
  );
  assert.deepEqual(parsePostRef('https://old.reddit.com/r/node/comments/abc123/x/'), { subreddit: 'node', id: 'abc123' });
  assert.deepEqual(parsePostRef('https://redd.it/abc123'), { subreddit: undefined, id: 'abc123' });
  assert.equal(parsePostRef('t3_abc123'), null);
});

test('readPost accepts a reddit.com link in place of an id', async () => {
  const { client, requests } = fakeClient([{ data: { children: [] } }, { data: { children: [] } }]);
  const actions = createActions({ client, guard: guardWith() });
  await assert.rejects(
    actions.readPost({ id: 'https://www.reddit.com/r/node/comments/abc123/x/' }),
    /was not found/,
  );
  assert.equal(requests[0].path, '/r/node/comments/abc123');
});

test('lookupTerm explains known terms and says when a term is unknown', () => {
  assert.match(lookupTerm('Karma').definition, /upvotes/);
  assert.equal(lookupTerm('zzz-unknown').definition, null);
});

test('search adds author and flair to the query, and needs something to search for', async () => {
  const { client, requests } = fakeClient({ data: { children: [], after: null } });
  const actions = createActions({ client, guard: guardWith() });
  await actions.search({ query: 'async', author: 'alice', flair: 'Help "me"' });
  assert.equal(requests[0].query.q, 'async author:alice flair:"Help me"');
  await actions.search({ author: 'bob' });
  assert.equal(requests[1].query.q, 'author:bob');
  await assert.rejects(actions.search({}), /Give a search query/);
});

test('feed with includeInfo adds the subreddit details to the page', async () => {
  const { client, requests } = fakeClient((method, path) => (path.endsWith('/about')
    ? { data: { display_name: 'node', title: 'Node', subscribers: 1000, public_description: 'JS' } }
    : { data: { children: [], after: null } }));
  const actions = createActions({ client, guard: guardWith() });
  const page = await actions.feed({ subreddit: 'node', includeInfo: true });
  assert.equal(page.info.subscribers, 1000);
  assert.equal(requests[1].path, '/r/node/about');
});

test('userActivity counts the subreddits a user is active in', async () => {
  const about = { kind: 't2', data: { name: 'bob', id: 'u1', link_karma: 10, comment_karma: 5 } };
  const child = (kind, subreddit) => ({
    kind,
    data: { name: `${kind}_x`, subreddit, title: 'x', body: 'y', score: 1, author: 'bob', num_comments: 0 },
  });
  const { client } = fakeClient((method, path) => {
    if (path.endsWith('/about')) return about;
    if (path.endsWith('/submitted')) return { data: { children: [child('t3', 'node'), child('t3', 'pics')], after: null } };
    return { data: { children: [child('t1', 'node'), child('t1', 'node'), child('t1', 'rust')], after: null } };
  });
  const actions = createActions({ client, guard: guardWith() });
  const report = await actions.userActivity('bob');
  assert.equal(report.account.totalKarma, 15);
  assert.equal(report.sampledPosts, 2);
  assert.equal(report.sampledComments, 3);
  assert.deepEqual(report.activeSubreddits[0], { name: 'node', count: 3 });
});

test('selfTest in app mode reads without asking for an account', async () => {
  const { client, requests } = fakeClient({ data: { children: [{ data: { display_name: 'pics' } }] } });
  const actions = createActions({ client, guard: guardWith(), authMode: 'app' });
  const report = await actions.selfTest();
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 1);
  assert.ok(!requests.some((request) => request.path === '/api/v1/me'));
});

test('selfTest in a user mode also checks the account', async () => {
  const { client } = fakeClient((method, path) => (path === '/api/v1/me'
    ? { name: 'alice', link_karma: 1, comment_karma: 2 }
    : { data: { children: [{ data: { display_name: 'pics' } }] } }));
  const actions = createActions({ client, guard: guardWith(), authMode: 'oauth' });
  const report = await actions.selfTest();
  assert.equal(report.checks.length, 2);
  assert.equal(report.checks[1].detail, 'alice');
});
