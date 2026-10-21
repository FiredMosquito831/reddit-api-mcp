import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixturePage } from './fixtures/browser/page.js';
import {
  comment,
  listingModel,
  post,
  postModel,
  securityModel,
  subredditModel,
  userModel,
} from './fixtures/browser/models.js';
import { createReadAdapters } from '../src/browser/adapters/reads.js';
import { createDom, node, withDom } from './fixtures/browser/dom.js';

// A page whose evaluate runs the production in-page extractor under a fake DOM. This is the wiring
// real sessions use: page.evaluate(extractor, request). Synthetic model injection (above) does not
// prove the extractor produces the fields the adapters require.
function realExtractorPage(dom) {
  return createFixturePage({ url: dom.location.href }, {
    evaluate: async (fn, arg) => fn(arg),
  });
}

function postPageDom(url = 'https://www.reddit.com/r/test/comments/abc123/a_post/') {
  const postNode = node({
    tag: 'shreddit-post',
    attrs: {
      id: 't3_abc123',
      permalink: '/r/test/comments/abc123/a_post/',
      author: 'someone',
      'subreddit-name': 'test',
      score: '7',
      'comment-count': '2',
      'created-timestamp': '2024-05-06T07:08:09Z',
    },
    query: {
      '[slot="text-body"]': node({ tag: 'div', text: 'post body' }),
      '[slot="title"], h1, h2': node({ tag: 'h1', text: 'A post' }),
    },
  });
  const commentNode = node({
    tag: 'shreddit-comment',
    attrs: { thingid: 't1_c1', parentid: 't3_abc123', author: 'someone', score: '3', depth: '0' },
    query: { '[slot="comment"]': node({ tag: 'div', text: 'a comment' }) },
  });
  return createDom({
    url,
    title: 'A post : r/test',
    query: { 'shreddit-post[id="t3_abc123"]': postNode },
    queryAll: {
      'shreddit-post, [data-testid="post-container"]': [postNode],
      'shreddit-comment': [commentNode],
      'shreddit-community-rules [data-testid="rule"], [data-testid="rule"]': [],
      '[aria-label],[role="button"]': [],
    },
  });
}

function op(tool, args = {}, extra = {}) {
  return {
    tool,
    kind: 'read',
    target: extra.target ?? 'r/test',
    requiresIdentity: extra.requiresIdentity ?? false,
    args,
  };
}

function gotoUrls(page) {
  return page.actions.filter((action) => action.kind === 'goto').map((action) => action.url);
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('subreddit feeds navigate with the requested sort and time and disclose visible-only completeness', async () => {
  const page = createFixturePage(listingModel({
    url: 'https://www.reddit.com/r/test/hot/?t=week',
    items: [post({ id: 'abc123', title: 'One', author: 'a', subreddit: 'test', score: 10, comments: 3 })],
  }));
  const adapters = createReadAdapters();
  const result = await adapters.read(op('browse_subreddit', { subreddit: 'test', sort: 'hot', time: 'week', limit: 10 }), { page });

  assert.deepEqual(gotoUrls(page), ['https://www.reddit.com/r/test/hot/?t=week']);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].kind, 't3');
  assert.equal(result.data.items[0].fullname, 't3_abc123');
  assert.equal(result.data.items[0].permalink, '/r/test/comments/abc123/a_post/');
  assert.equal(result.data.after, null);
  assert.equal(result.meta.completeness, 'partial');
  assert.ok(result.meta.missingFields.includes('upvoteRatio'));
});

test('top posts use the top path with the requested time range and never another range', async () => {
  const page = createFixturePage(listingModel({ items: [] }));
  const adapters = createReadAdapters();
  await adapters.read(op('get_top_posts', { subreddit: 'test', time: 'month' }), { page });
  assert.deepEqual(gotoUrls(page), ['https://www.reddit.com/r/test/top/?t=month']);
});

test('search maps query, author, flair, type, sort, and time into the visible search URL', async () => {
  const page = createFixturePage(listingModel({ items: [post({ id: 'abc123', subreddit: 'test' })] }));
  const adapters = createReadAdapters();
  const result = await adapters.read(op('search_reddit', {
    query: 'hello world',
    subreddit: 'test',
    sort: 'top',
    time: 'year',
    type: 'link',
    author: 'someone',
    flair: 'Help',
  }), { page });
  const [url] = gotoUrls(page);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://www.reddit.com/r/test/search/');
  assert.equal(parsed.searchParams.get('restrict_sr'), '1');
  assert.equal(parsed.searchParams.get('sort'), 'top');
  assert.equal(parsed.searchParams.get('t'), 'year');
  assert.equal(parsed.searchParams.get('type'), 'link');
  assert.match(parsed.searchParams.get('q'), /hello world/);
  assert.match(parsed.searchParams.get('q'), /author:someone/);
  assert.match(parsed.searchParams.get('q'), /flair:"Help"/);
  assert.equal(result.data.items[0].id, 'abc123');
});

test('subreddit info and rules read structured data and mark fields the rendered page does not show', async () => {
  const infoPage = createFixturePage(subredditModel({ name: 'test', info: { title: 'Testing', subscribers: 12 } }));
  const adapters = createReadAdapters();
  const info = await adapters.read(op('get_subreddit_info', { subreddit: 'test' }), { page: infoPage });
  assert.deepEqual(gotoUrls(infoPage), ['https://www.reddit.com/r/test/about/']);
  assert.equal(info.data.name, 'test');
  assert.equal(info.data.title, 'Testing');
  assert.equal(info.data.subscribers, 12);
  assert.equal(info.data.description, null);
  assert.ok(info.meta.missingFields.includes('description'));
  assert.equal(info.meta.completeness, 'partial');

  const rulesPage = createFixturePage(subredditModel({
    rules: [{ shortName: 'Be kind', description: 'Be nice', kind: null }],
  }));
  const rules = await adapters.read(op('get_subreddit_rules', { subreddit: 'test' }), { page: rulesPage });
  assert.deepEqual(gotoUrls(rulesPage), ['https://www.reddit.com/r/test/about/rules/']);
  assert.deepEqual(rules.data, [{ shortName: 'Be kind', description: 'Be nice', kind: null }]);
  assert.ok(rules.meta.missingFields.includes('kind'));
});

test('post and comment reads bind themselves to the requested canonical id and disclose partial trees', async () => {
  const page = createFixturePage(postModel({
    entry: post({ id: 'abc123', title: 'Post', author: 'a', subreddit: 'test', score: 4, comments: 1, body: 'body' }),
    comments: [
      comment({ id: 'c1', parentId: 't3_abc123', depth: 0, score: 2 }),
      comment({ id: 'c2', parentId: 't1_c1', depth: 1 }),
    ],
    truncated: true,
  }));
  const adapters = createReadAdapters();
  const result = await adapters.read(op('get_post_comments', { id: 'abc123' }, { target: 't3_abc123' }), { page });
  assert.deepEqual(gotoUrls(page), ['https://www.reddit.com/comments/abc123/']);
  assert.equal(result.data.post.id, 'abc123');
  assert.equal(result.data.comments.length, 2);
  assert.equal(result.data.comments[1].depth, 1);
  assert.equal(result.data.moreIds.length, 0);
  assert.equal(result.meta.completeness, 'partial');
  assert.ok(result.meta.missingFields.includes('commentTreeBeyondVisiblePage'));

  const single = await adapters.read(op('get_reddit_post', { id: 'abc123' }, { target: 't3_abc123' }), { page });
  assert.equal(single.data.post.title, 'Post');
});

test('a post read refuses a page for a different canonical id', async () => {
  const page = createFixturePage(postModel({
    url: 'https://www.reddit.com/comments/zzz999/',
    entry: post({ id: 'zzz999' }),
  }));
  const adapters = createReadAdapters();
  await assert.rejects(
    adapters.read(op('get_reddit_post', { id: 'abc123' }, { target: 't3_abc123' }), { page }),
    (error) => error.code === 'STEP_STALE' && error.safeDetails?.reason === 'target_changed',
  );
});

test('the production extractor satisfies post reads: canonical id, entry, and comments', async () => {
  const dom = postPageDom();
  const page = realExtractorPage(dom);
  const adapters = createReadAdapters();
  const result = await withDom(dom, () => adapters.read(
    op('get_post_comments', { id: 'abc123' }, { target: 't3_abc123' }),
    { page },
  ));

  assert.deepEqual(gotoUrls(page), ['https://www.reddit.com/comments/abc123/']);
  assert.equal(result.data.post.id, 'abc123');
  assert.equal(result.data.post.title, 'A post');
  assert.equal(result.data.post.author, 'someone');
  assert.equal(result.data.post.subreddit, 'test');
  assert.equal(result.data.post.score, 7);
  assert.equal(result.data.post.selftext, 'post body');
  assert.equal(result.data.comments.length, 1);
  assert.equal(result.data.comments[0].id, 'c1');
  assert.equal(result.data.comments[0].parentId, 't3_abc123');
  assert.equal(result.data.comments[0].body, 'a comment');

  const single = await withDom(dom, () => adapters.read(op('get_reddit_post', { id: 'abc123' }, { target: 't3_abc123' }), { page }));
  assert.equal(single.data.post.id, 'abc123');
});

test('the production extractor supplies subreddit and user facts instead of name-only results', async () => {
  const aboutDom = createDom({
    url: 'https://www.reddit.com/r/test/about/',
    title: 'Testing : r/test',
    query: {
      'shreddit-subreddit-header': node({
        tag: 'shreddit-subreddit-header',
        attrs: { 'display-name': 'Testing', subscribers: '12,500', description: 'A place to test' },
      }),
      'meta[name="description"]': node({ tag: 'meta', attrs: { content: 'A place to test' } }),
    },
    queryAll: {
      'shreddit-post, [data-testid="post-container"]': [],
      'shreddit-comment': [],
      'shreddit-community-rules [data-testid="rule"], [data-testid="rule"]': [],
      '[aria-label],[role="button"]': [],
    },
  });
  const aboutPage = realExtractorPage(aboutDom);
  const adapters = createReadAdapters();
  const info = await withDom(aboutDom, () => adapters.read(op('get_subreddit_info', { subreddit: 'test' }), { page: aboutPage }));
  assert.equal(info.data.name, 'test');
  assert.equal(info.data.title, 'Testing');
  assert.equal(info.data.subscribers, 12_500);
  assert.equal(info.data.description, 'A place to test');

  const userDom = createDom({
    url: 'https://www.reddit.com/user/someone/',
    title: 'someone (u/someone)',
    bodyText: '120 post karma 34 comment karma',
    query: {
      'shreddit-profile-header': node({
        tag: 'shreddit-profile-header',
        attrs: { 'post-karma': '120', 'comment-karma': '34', 'created-timestamp': '2020-01-02T03:04:05Z' },
      }),
    },
    queryAll: {
      'shreddit-post, [data-testid="post-container"]': [],
      'shreddit-comment': [],
      '[aria-label],[role="button"]': [],
    },
  });
  const userPage = realExtractorPage(userDom);
  const user = await withDom(userDom, () => adapters.read(op('get_user_info', { username: 'someone' }), { page: userPage }));
  assert.equal(user.data.name, 'someone');
  assert.equal(user.data.linkKarma, 120);
  assert.equal(user.data.commentKarma, 34);
  assert.equal(user.data.totalKarma, 154);
  assert.equal(user.data.createdUtc, Date.parse('2020-01-02T03:04:05Z') / 1000);
});

test('an unverified canonical id on a post page is refused rather than assumed', async () => {
  const page = createFixturePage(postModel({ canonicalId: null, entry: post({ id: undefined }) }));
  const adapters = createReadAdapters();
  await assert.rejects(
    adapters.read(op('get_reddit_post', { id: 'abc123' }, { target: 't3_abc123' }), { page }),
    (error) => error.code === 'STEP_STALE' && error.safeDetails?.reason === 'target_unverified',
  );
});

test('user reads preserve requested listings, and identity reads require the correct account', async () => {
  const page = createFixturePage(userModel({
    name: 'someone',
    info: { linkKarma: 5, commentKarma: 7, totalKarma: 12 },
    items: [comment({ id: 'c1', parentId: 't3_abc123' })],
  }));
  const adapters = createReadAdapters();
  const info = await adapters.read(op('get_user_info', { username: 'someone' }), { page });
  assert.deepEqual(gotoUrls(page), ['https://www.reddit.com/user/someone/']);
  assert.equal(info.data.name, 'someone');
  assert.equal(info.data.linkKarma, 5);
  assert.equal(info.data.totalKarma, 12);
  assert.ok(info.meta.missingFields.includes('createdUtc'));

  const posts = await adapters.read(op('get_user_posts', { username: 'someone', options: { sort: 'new', time: 'all', limit: 10 } }), { page });
  assert.deepEqual(gotoUrls(page).at(-1), 'https://www.reddit.com/user/someone/submitted/?sort=new&t=all');
  assert.equal(posts.data.items[0].kind, 't1');
});

test('account-scoped listings refuse a page showing a different signed-in account', async () => {
  const page = createFixturePage(listingModel({
    url: 'https://www.reddit.com/user/someone/saved/',
    account: { username: 'otherperson' },
  }));
  const adapters = createReadAdapters();
  await expectCode(
    adapters.read(op('get_my_saved', {}, { target: 'me:saved', requiresIdentity: true }), {
      page,
      account: { username: 'someone', accountKey: 'acct_1' },
    }),
    'IDENTITY_MISMATCH',
  );
});

test('get_me returns the verified identity, not page guesses', async () => {
  const page = createFixturePage(userModel({ name: 'someone' }));
  const adapters = createReadAdapters();
  const result = await adapters.read(op('get_me', {}, { target: 'me', requiresIdentity: true }), {
    page,
    account: { username: 'someone', accountKey: 'acct_1' },
  });
  assert.equal(result.data.name, 'someone');
  assert.equal(result.data.linkKarma, null);
  assert.deepEqual(gotoUrls(page), []);
  assert.ok(result.meta.missingFields.includes('linkKarma'));
});

test('flairs and generic comment expansion are explicit parameter gaps, not guessed selectors', async () => {
  const adapters = createReadAdapters();
  const page = createFixturePage(listingModel());
  await assert.rejects(
    adapters.read(op('get_post_flairs', { subreddit: 'test' }), { page }),
    (error) => error.code === 'PARAMETER_UNSUPPORTED' && error.safeDetails?.reason === 'flair_template_ids_unavailable',
  );
  await assert.rejects(
    adapters.read(op('get_more_comments', { postFullname: 't3_abc123', childIds: ['c1'] }, { target: 't3_abc123' }), { page }),
    (error) => error.code === 'PARAMETER_UNSUPPORTED' && error.safeDetails?.reason === 'branch_ids_unavailable',
  );
  assert.deepEqual(gotoUrls(page), []);
});

test('login and challenge screens produce a handoff, never a parsed page', async () => {
  const adapters = createReadAdapters();
  for (const screen of ['login', 'challenge', 'two_factor']) {
    const page = createFixturePage(securityModel(screen));
    await expectCode(adapters.read(op('browse_subreddit', { subreddit: 'test' }), { page }), 'USER_HANDOFF_REQUIRED');
  }
});

test('an extraction failure is a classified backend failure with no raw page dump', async () => {
  const page = createFixturePage({}, {
    evaluate: async () => { throw new Error('DOM exploded: <html>secret token=abc</html>'); },
  });
  const adapters = createReadAdapters();
  await assert.rejects(
    adapters.read(op('browse_subreddit', { subreddit: 'test' }), { page }),
    (error) => {
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    },
  );
});

test('a paged browser read issues a task-bound UI continuation and keeps its task alive', async () => {
  const { createBrowserBackend } = await import('../src/backends/browser.js');
  const { createBrowserTasks } = await import('../src/browser/steps.js');
  const { createContinuationStore } = await import('../src/continuations.js');
  const page = createFixturePage(listingModel({
    items: [post({ id: 'abc123', subreddit: 'test' })],
    next: { cursor: 'visible-next' },
  }));
  const sessions = {
    async open(snapshot) {
      return { id: snapshot.id, visibility: 'visible', context: { pages: () => [page], newPage: async () => page } };
    },
    async identity() {
      return { username: 'someone', accountKey: 'acct_1', accountId: 't2_abc', verified: true };
    },
  };
  const tasks = createBrowserTasks({ clock: () => 1_000, newId: () => 'task_1' });
  const continuations = createContinuationStore({ clock: () => 1_000, newId: () => 'continuation_1' });
  const backend = createBrowserBackend({
    snapshot: {
      id: 'p_alpha',
      alias: 'Alpha',
      expectedUsername: 'someone',
      accountKey: 'acct_1',
      accountId: 't2_abc',
      generation: 1,
      credentialGeneration: 1,
      policyGeneration: 1,
      enabledBackends: ['browser'],
      backendPreference: ['browser'],
      visibility: 'visible',
      confirmations: {},
      api: { clientId: null, appType: null },
      passwordLoginEnabled: false,
    },
    sessions,
    settings: {},
    tasks,
    continuations,
  });
  const result = await backend.read(
    { tool: 'browse_subreddit', kind: 'read', target: 'r/test', requiresIdentity: false, args: { subreddit: 'test', sort: 'hot' } },
    {},
  );
  assert.equal(result.meta.continuation.token, 'continuation_1');
  assert.equal(result.meta.cursorKind, undefined);
  assert.equal(tasks.hasActiveTask('p_alpha'), true);
  await backend.close();
  assert.equal(tasks.hasActiveTask('p_alpha'), false);
});

test('account listings, analysis, and the self-test use the verified account and disclose their sample', async () => {
  const adapters = createReadAdapters();
  const account = { username: 'someone', accountKey: 'acct_1' };

  const overviewPage = createFixturePage(listingModel({
    url: 'https://www.reddit.com/user/someone/',
    account: { username: 'someone' },
    items: [post({ id: 'abc123', subreddit: 'test' })],
  }));
  const overview = await adapters.read(op('get_my_overview', {}, { target: 'me:overview', requiresIdentity: true }), { page: overviewPage, account });
  assert.deepEqual(gotoUrls(overviewPage), ['https://www.reddit.com/user/someone/']);
  assert.equal(overview.data.items[0].id, 'abc123');

  const savedPage = createFixturePage(listingModel({ url: 'https://www.reddit.com/user/someone/saved/', account: { username: 'someone' } }));
  await adapters.read(op('get_my_saved', {}, { target: 'me:saved', requiresIdentity: true }), { page: savedPage, account });
  assert.deepEqual(gotoUrls(savedPage), ['https://www.reddit.com/user/someone/saved/']);

  const subsPage = createFixturePage(listingModel({ url: 'https://www.reddit.com/subreddits/mine/' }));
  const subs = await adapters.read(op('list_my_subreddits', {}, { target: 'me:subreddits', requiresIdentity: true }), { page: subsPage, account });
  assert.deepEqual(gotoUrls(subsPage), ['https://www.reddit.com/subreddits/mine/']);
  assert.deepEqual(subs.data, []);

  const analysisUser = userModel({ info: { linkKarma: 1, commentKarma: 2 } });
  const analysisPage = createFixturePage(analysisUser, {
    evaluate: async (fn, arg, fixture) => {
      if (arg?.kind === 'user') return analysisUser;
      const url = fixture.url();
      if (url.includes('/submitted/')) {
        return listingModel({ items: [post({ id: 'p1', subreddit: 'alpha' }), post({ id: 'p2', subreddit: 'alpha' })] });
      }
      return listingModel({ items: [comment({ id: 'c1', parentId: 't3_p1' })] });
    },
  });
  const analysis = await adapters.read(op('user_analysis', { username: 'someone' }), { page: analysisPage });
  assert.equal(analysis.data.sampledPosts, 2);
  assert.equal(analysis.data.sampledComments, 1);
  assert.deepEqual(analysis.data.activeSubreddits[0], { name: 'alpha', count: 2 });
  assert.equal(analysis.meta.sampled, true);
  assert.ok(analysis.meta.missingFields.includes('sampleBounded'));

  const selfPage = createFixturePage(listingModel({ items: [post({ id: 'abc123', subreddit: 'test' })] }));
  const self = await adapters.read(op('test_reddit_mcp_server', { checkAccount: true }), { page: selfPage, account });
  assert.equal(self.data.authMode, 'browser');
  assert.equal(self.data.ok, true);
  assert.deepEqual(self.data.checks.map((check) => check.ok), [true, true]);
});

test('an unrecognized page variant fails closed instead of guessing selectors', async () => {
  const page = createFixturePage({ recognized: false, url: 'https://www.reddit.com/r/test/', items: [] });
  const adapters = createReadAdapters();
  await assert.rejects(
    adapters.read(op('browse_subreddit', { subreddit: 'test' }), { page }),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'unrecognized_page',
  );
});
