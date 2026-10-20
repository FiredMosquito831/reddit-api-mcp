import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseSubredditRss, parseAtomEntries } from '../src/rss.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>hot in node</title>
  <entry>
    <author><name>/u/alice</name></author>
    <id>t3_abc123</id>
    <link href="https://www.reddit.com/r/node/comments/abc123/x/" />
    <updated>2026-10-20T10:00:00+00:00</updated>
    <title type="html">Rock &amp; roll &lt;3 &quot;quoted&quot;</title>
  </entry>
  <entry>
    <author><name>bob</name></author>
    <id>t3_def456</id>
    <link href="https://www.reddit.com/r/node/comments/def456/y/" />
    <updated>2026-10-20T11:00:00+00:00</updated>
    <title>Plain title</title>
  </entry>
</feed>`;

test('parseAtomEntries reads title, link, author, time, and fullname, and decodes entities', () => {
  const [first, second] = parseAtomEntries(FEED);
  assert.deepEqual(first, {
    fullname: 't3_abc123',
    title: 'Rock & roll <3 "quoted"',
    author: 'alice',
    url: 'https://www.reddit.com/r/node/comments/abc123/x/',
    updated: '2026-10-20T10:00:00+00:00',
  });
  assert.equal(second.author, 'bob');
  assert.equal(second.title, 'Plain title');
});

test('browseSubredditRss requests the .rss feed with a limit and returns the entries', async () => {
  let requested;
  const fetch = async (url) => {
    requested = String(url);
    return new Response(FEED, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
  };
  const entries = await browseSubredditRss({ subreddit: 'node', sort: 'new', limit: 1, fetch, userAgent: 'UA/1' });
  assert.equal(requested, 'https://www.reddit.com/r/node/new/.rss?limit=1');
  assert.equal(entries.length, 1);
});

test('browseSubredditRss explains throttling, non-feed responses, and bad names', async () => {
  const throttled = async () => new Response('', { status: 429 });
  await assert.rejects(browseSubredditRss({ subreddit: 'node', fetch: throttled, userAgent: 'UA' }), /throttling/);
  const html = async () => new Response('<html>blocked</html>', { status: 200 });
  await assert.rejects(browseSubredditRss({ subreddit: 'node', fetch: html, userAgent: 'UA' }), /Atom feed/);
  await assert.rejects(browseSubredditRss({ subreddit: '../x', fetch: html, userAgent: 'UA' }), /Not a valid subreddit/);
});
