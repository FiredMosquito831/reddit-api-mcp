import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDED_CONTROLS,
  SAFE_STEPS,
  createBrowserTasks,
  readControls,
  redactText,
  sanitizeObservation,
  sanitizeUrl,
} from '../src/browser/steps.js';
import { BOUNDED_PAGE_MODEL } from '../src/browser/adapters/reads.js';
import { createFixturePage } from './fixtures/browser/page.js';
import { createDom, node, withDom } from './fixtures/browser/dom.js';

function model(overrides = {}) {
  return {
    url: 'https://www.reddit.com/r/test/',
    title: 'r/test',
    elements: [
      { role: 'link', name: 'Hot' },
      { role: 'textbox', name: 'Title' },
      { role: 'textbox', name: 'Password', attributes: { type: 'password' } },
      { role: 'button', name: 'Post' },
    ],
    observationText: 'First post Second post',
    ...overrides,
  };
}

function fixedClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function context(page, overrides = {}) {
  return {
    profileId: 'p_alpha',
    accountKey: 'acct_1',
    operation: { tool: 'browse_subreddit', kind: 'read', target: 'r/test', policyKey: 'browse_subreddit' },
    page,
    ...overrides,
  };
}

function expectCode(fn, code) {
  return assert.rejects(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('a task observation is bounded, sanitized, and tied to the latest observation id', async () => {
  const page = createFixturePage(model({
    url: 'https://www.reddit.com/r/test/?token=super-secret&sort=hot#frag',
  }));
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  const { taskId } = tasks.create(context(page));

  const observation = await tasks.observe(taskId, { kind: 'page' });
  assert.equal(observation.taskId, taskId);
  assert.equal(observation.url, 'https://www.reddit.com/r/test/?sort=hot');
  assert.equal(observation.security, null);
  assert.deepEqual(observation.elements.slice(0, 2), [
    { role: 'link', name: 'Hot' },
    { role: 'textbox', name: 'Title' },
  ]);
  assert.ok(observation.elements.length <= 100);
  assert.ok(!JSON.stringify(observation).includes('super-secret'));
  assert.ok(!JSON.stringify(observation).includes('password'));

  await assert.rejects(
    tasks.step(taskId, { observationId: 'obs_other', step: 'scroll', args: { direction: 'down', amount: 100 } }),
    (error) => error.code === 'STEP_STALE',
  );
  const stepped = await tasks.step(taskId, { observationId: observation.observationId, step: 'scroll', args: { direction: 'down', amount: 100 } });
  assert.equal(stepped.step, 'scroll');
  // A step invalidates the observation it was bound to.
  await expectCode(() => tasks.step(taskId, { observationId: observation.observationId, step: 'scroll', args: { direction: 'down', amount: 100 } }), 'STEP_STALE');
});

test('only the finite safe step allowlist is accepted; mutation-like names are refused', async () => {
  const page = createFixturePage(model());
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  const { taskId } = tasks.create(context(page));
  const observation = await tasks.observe(taskId);
  assert.deepEqual([...SAFE_STEPS].sort(), ['expand_branch', 'navigate', 'prepare_field', 'scroll', 'sort']);

  for (const step of ['click', 'submit', 'vote', 'save', 'subscribe', 'delete', 'evaluate', 'fetch', 'header', 'press', 'upload']) {
    await assert.rejects(
      tasks.step(taskId, { observationId: observation.observationId, step, args: {} }),
      (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'step_not_allowed',
      `step ${step} must be refused`,
    );
  }
  // Refused steps do not invalidate the observation or move the page.
  assert.equal(page.actions.filter((action) => action.kind !== 'evaluate').length, 0);
});

test('navigation is limited to exact Reddit HTTPS destinations', async () => {
  const page = createFixturePage(model());
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  const { taskId } = tasks.create(context(page));
  const observation = await tasks.observe(taskId);

  for (const url of [
    'https://evil.example/r/test/',
    'http://www.reddit.com/r/test/',
    'https://www.reddit.com.evil.example/r/test/',
    'https://www.reddit.com@evil.example/r/test/',
    'https://www.reddit.com/r/test/\\@evil.example',
    '//evil.example/r/test/',
    'javascript:alert(1)',
  ]) {
    await assert.rejects(
      tasks.step(taskId, { observationId: observation.observationId, step: 'navigate', args: { url } }),
      (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'redirect_not_allowed',
      `URL ${url} must be refused`,
    );
  }
  assert.equal(page.actions.filter((action) => action.kind === 'goto').length, 0);

  const moved = await tasks.step(taskId, { observationId: observation.observationId, step: 'navigate', args: { url: 'https://www.reddit.com/r/other/' } });
  assert.equal(moved.url, 'https://www.reddit.com/r/other/');
  assert.equal(page.actions.filter((action) => action.kind === 'goto').length, 1);
});

test('secret-bearing field preparation is refused and non-secret fields are filled', async () => {
  const page = createFixturePage(model());
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  const { taskId } = tasks.create(context(page));
  const observation = await tasks.observe(taskId);

  for (const field of ['password', 'username', 'otp', 'two_factor', 'recovery_code']) {
    await assert.rejects(
      tasks.step(taskId, { observationId: observation.observationId, step: 'prepare_field', args: { field, value: 'secret' } }),
      (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'field_not_allowed',
    );
  }
  assert.equal(page.actions.filter((action) => action.kind === 'fill').length, 0);

  await tasks.step(taskId, { observationId: observation.observationId, step: 'prepare_field', args: { field: 'title', value: 'hello world' } });
  const fill = page.actions.find((action) => action.kind === 'fill');
  assert.equal(fill.value, 'hello world');
});

test('login, password, 2FA, and recovery screens never yield page content', async () => {
  for (const screen of ['login', 'password', 'two_factor', 'challenge', 'recovery']) {
    const page = createFixturePage({
      url: 'https://www.reddit.com/login/',
      title: 'Sign in',
      security: screen,
      observationText: 'enter your password here',
      elements: [{ role: 'textbox', name: 'Password', attributes: { type: 'password' } }],
    });
    const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
    const { taskId } = tasks.create(context(page));
    await assert.rejects(tasks.observe(taskId), (error) => {
      assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
      assert.equal(error.safeDetails?.reason, 'security_screen');
      const text = JSON.stringify(error);
      assert.ok(!text.includes('enter your password'));
      assert.ok(!text.includes('Sign in'));
      return true;
    });
  }
});

test('tasks expire and close, and stale task ids cannot observe, step, or hand off', async () => {
  const clock = fixedClock();
  const page = createFixturePage(model());
  let counter = 0;
  const tasks = createBrowserTasks({ clock: clock.now, newId: () => `task_${++counter}`, ttlMs: 5_000 });
  const { taskId } = tasks.create(context(page));

  clock.advance(6_000);
  await expectCode(() => tasks.observe(taskId), 'STEP_STALE');
  assert.equal(tasks.hasActiveTask('p_alpha'), false);

  const second = tasks.create(context(page));
  assert.equal(tasks.hasActiveTask('p_alpha'), true);
  assert.equal(tasks.activeCount('p_alpha'), 1);
  const closed = await tasks.close(second.taskId);
  assert.equal(closed.closed, true);
  await expectCode(() => tasks.observe(second.taskId), 'STEP_STALE');
  await expectCode(() => tasks.handoff(second.taskId), 'STEP_STALE');
});

test('handoff reports a visible user action and can resume after a fresh observation', async () => {
  const page = createFixturePage(model());
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  const { taskId } = tasks.create(context(page, { visibility: 'headless' }));
  const handoff = await tasks.handoff(taskId, { reason: 'challenge' });
  assert.equal(handoff.state, 'waiting_for_user');
  assert.equal(handoff.taskId, taskId);
  assert.equal(handoff.visibility, 'headless');
  assert.match(handoff.instructions.join(' '), /visible/i);
  assert.equal(tasks.hasActiveTask('p_alpha'), true);
  // Stale observations cannot be replayed, and a handoff cannot be stepped without a fresh look.
  await expectCode(() => tasks.step(taskId, { observationId: 'x', step: 'scroll', args: {} }), 'STEP_STALE');

  // The handoff instructions tell the user to take a fresh observation; that must be possible.
  const observation = await tasks.observe(taskId);
  assert.equal(observation.taskId, taskId);
  const stepped = await tasks.step(taskId, { observationId: observation.observationId, step: 'scroll', args: { direction: 'down', amount: 100 } });
  assert.equal(stepped.step, 'scroll');
  assert.equal(tasks.activeCount('p_alpha'), 1);
});

test('sanitizeUrl and redactText remove credentials and sensitive query parameters', () => {
  assert.equal(
    sanitizeUrl('https://www.reddit.com/r/test/?token=abc&code=def&password=ghi&sort=hot&access_token=jkl#frag'),
    'https://www.reddit.com/r/test/?sort=hot',
  );
  assert.equal(sanitizeUrl('https://user:pass@www.reddit.com/r/test/'), 'https://www.reddit.com/r/test/');
  assert.equal(sanitizeUrl('not a url'), '');
  assert.equal(sanitizeUrl('https://evil.example/r/test/?a=1'), '');

  const redacted = redactText('Authorization: Bearer abc123 cookie=sessionvalue token=xyz visible text');
  assert.ok(!redacted.includes('abc123'));
  assert.ok(!redacted.includes('sessionvalue'));
  assert.ok(!redacted.includes('xyz'));
  assert.ok(redacted.includes('visible text'));

  const observation = sanitizeObservation({
    url: 'https://www.reddit.com/r/test/?token=abc',
    title: 'title token=abc',
    elements: [
      { role: 'textbox', name: 'Password', value: 'hunter2' },
      { role: 'button', name: 'Post', value: 'ignored' },
    ],
    observationText: 'hello token=abc',
  });
  assert.ok(!JSON.stringify(observation).includes('hunter2'));
  assert.ok(!JSON.stringify(observation).includes('abc'));
  assert.deepEqual(observation.elements, [{ role: 'button', name: 'Post' }]);
});

test('task contexts reject unknown tools and missing profile ids', () => {
  const page = createFixturePage(model());
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => 'task_1' });
  assert.throws(() => tasks.create(context(page, { profileId: '' })), TypeError);
  assert.throws(() => tasks.create(context(page, { operation: { tool: '', target: 'x' } })), TypeError);
});

test('the real controls extractor reports the states and evidence the write adapters need', () => {
  const postNode = node({
    tag: 'shreddit-post',
    attrs: { id: 't3_abc123', permalink: '/r/test/comments/abc123/a_post/' },
    query: { '[slot="text-body"]': node({ tag: 'div', text: 'post body' }) },
    queryAll: {
      '[aria-label],[role="button"]': [
        node({ tag: 'button', attrs: { 'aria-label': 'Upvote', 'aria-pressed': 'false' } }),
        node({ tag: 'button', attrs: { 'aria-label': 'Downvote', 'aria-pressed': 'false' } }),
        node({ tag: 'button', attrs: { 'aria-label': 'Save', 'aria-pressed': 'false' } }),
        node({ tag: 'button', attrs: { 'aria-label': 'Join', 'aria-pressed': 'false' } }),
      ],
    },
  });
  const commentNode = node({
    tag: 'shreddit-comment',
    attrs: { thingid: 't1_c1', author: 'someone', permalink: '/r/test/comments/abc123/a_post/c1/' },
    text: 'a comment',
    query: { '[slot="comment"]': node({ tag: 'div', text: 'a comment' }) },
    queryAll: {
      '[aria-label],[role="button"]': [
        node({ tag: 'button', attrs: { 'aria-label': 'Upvote', 'aria-pressed': 'true' } }),
        node({ tag: 'button', attrs: { 'aria-label': 'Save', 'aria-pressed': 'true' } }),
      ],
    },
    closest: { 'shreddit-post': postNode },
  });
  const dom = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    title: 'A post : r/test',
    bodyText: 'a comment',
    query: {
      'shreddit-post[id="t3_abc123"]': postNode,
      'shreddit-comment[thingid="t1_c1"]': commentNode,
    },
    queryAll: {
      'shreddit-comment': [commentNode],
      '[aria-label],[role="button"]': postNode.queryAllMap['[aria-label],[role="button"]'],
      '[role="alert"]': [],
    },
  });

  const controls = withDom(dom, () => BOUNDED_CONTROLS({ kind: 'controls' }));
  assert.equal(controls.canonicalId, 'abc123');
  assert.equal(controls.subreddit, 'test');
  assert.equal(controls.saved, false);
  assert.equal(controls.vote, 'none');
  assert.equal(controls.joined, false);
  assert.equal(controls.deleted, false);
  assert.equal(controls.createdId, 'abc123');
  assert.equal(controls.createdPermalink, '/r/test/comments/abc123/a_post/');

  const commentControls = withDom(dom, () => BOUNDED_CONTROLS({ focusId: 'c1', focusKind: 't1' }));
  assert.equal(commentControls.focus.id, 'c1');
  assert.equal(commentControls.focus.postId, 'abc123');
  assert.equal(commentControls.focus.body, 'a comment');
  assert.equal(commentControls.bodyText, 'a comment');
  assert.equal(commentControls.vote, 'up');
  assert.equal(commentControls.saved, true);

  const created = withDom(dom, () => BOUNDED_CONTROLS({
    kind: 'controls',
    expectedText: 'a comment',
    accountUsername: 'someone',
  }));
  assert.deepEqual(created.lastComment, { id: 'c1', parentId: null, body: 'a comment' });
  assert.equal(created.refusal, null);
  assert.equal(created.security, null);
});

test('the real page-model extractor supplies canonical ids, the focused post, and community/user facts', () => {
  const header = node({
    tag: 'shreddit-subreddit-header',
    attrs: { 'display-name': 'Testing', subscribers: '12,500', description: 'A place to test' },
  });
  const profile = node({
    tag: 'shreddit-profile-header',
    attrs: { 'post-karma': '120', 'comment-karma': '34', 'created-timestamp': '2020-01-02T03:04:05Z' },
  });
  const postNode = node({
    tag: 'shreddit-post',
    attrs: {
      id: 't3_abc123',
      permalink: '/r/test/comments/abc123/a_post/',
      author: 'someone',
      'subreddit-name': 'test',
      score: '10',
      'comment-count': '3',
      'created-timestamp': '2024-05-06T07:08:09Z',
    },
    query: {
      '[slot="text-body"]': node({ tag: 'div', text: 'body text' }),
      '[slot="title"], h1, h2': node({ tag: 'h1', text: 'A post' }),
    },
  });
  const dom = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    title: 'Testing : r/test',
    query: {
      'shreddit-subreddit-header': header,
      'meta[name="description"]': node({ tag: 'meta', attrs: { content: 'A place to test' } }),
      'shreddit-post[id="t3_abc123"]': postNode,
    },
    queryAll: {
      'shreddit-post, [data-testid="post-container"]': [postNode],
      'shreddit-comment': [],
      'shreddit-community-rules [data-testid="rule"], [data-testid="rule"]': [],
      '#expand-user-drawer [data-testid="profile-name"], faceplate-tracker[noun="user"] a': [],
    },
  });

  const page = withDom(dom, () => BOUNDED_PAGE_MODEL({ kind: 'post' }));
  assert.equal(page.canonicalId, 'abc123');
  assert.equal(page.entry.id, 'abc123');
  assert.equal(page.entry.title, 'A post');
  assert.equal(page.entry.score, 10);
  assert.equal(page.entry.comments, 3);
  assert.equal(page.entry.body, 'body text');
  assert.equal(page.entry.createdUtc, Date.parse('2024-05-06T07:08:09Z') / 1000);
  assert.equal(page.subreddit.name, 'test');
  assert.equal(page.subreddit.title, 'Testing');
  assert.equal(page.subreddit.subscribers, 12_500);
  assert.equal(page.subreddit.description, 'A place to test');

  const profileDom = createDom({
    url: 'https://www.reddit.com/user/someone/',
    title: 'someone (u/someone)',
    bodyText: '120 post karma 34 comment karma',
    query: { 'shreddit-profile-header': profile },
    queryAll: {},
  });
  const userPage = withDom(profileDom, () => BOUNDED_PAGE_MODEL({ kind: 'user' }));
  assert.equal(userPage.user.name, 'someone');
  assert.equal(userPage.user.linkKarma, 120);
  assert.equal(userPage.user.commentKarma, 34);
  assert.equal(userPage.user.createdUtc, Date.parse('2020-01-02T03:04:05Z') / 1000);
});

test('the controls extractor reports refusals and security challenges as bounded text', () => {
  const dom = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    bodyText: 'Something went wrong. Please try again later.',
    queryAll: {
      '[aria-label],[role="button"]': [],
      '[role="alert"]': [node({ tag: 'div', text: 'You are doing that too much. Try again in 5 minutes.' })],
    },
  });
  const controls = withDom(dom, () => BOUNDED_CONTROLS({ kind: 'controls' }));
  assert.match(controls.refusal, /too much/);
  assert.equal(controls.security, null);

  const challenge = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    bodyText: 'Please verify you are human to continue',
    queryAll: { '[aria-label],[role="button"]': [] },
  });
  const challenged = withDom(challenge, () => BOUNDED_CONTROLS({ kind: 'controls' }));
  assert.equal(challenged.security, 'challenge');
});

test('readControls passes the task-bound focus to the real extractor', async () => {
  const page = createFixturePage({}, {
    evaluate: async (fn, arg) => fn(arg),
  });
  const dom = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    queryAll: { '[aria-label],[role="button"]': [] },
  });
  const controls = await withDom(dom, () => readControls(page, { focusId: 'c1', focusKind: 't1' }));
  assert.equal(controls.canonicalId, 'abc123');
  assert.equal(page.actions.filter((action) => action.kind === 'evaluate').length, 1);
});

test('known sort and branch-expansion steps click only their named controls', async () => {
  const page = createFixturePage(model({
    elements: [
      { role: 'link', name: 'Top' },
      { role: 'button', name: 'Load more comments', scopeId: 'c1' },
      { role: 'button', name: 'Load more comments', scopeId: 'c2' },
      { role: 'button', name: 'Load more replies', scopeId: 'c3' },
    ],
  }));
  let counter = 0;
  const tasks = createBrowserTasks({ clock: fixedClock().now, newId: () => `task_${++counter}` });
  const { taskId } = tasks.create(context(page));

  let observation = await tasks.observe(taskId);
  await tasks.step(taskId, { observationId: observation.observationId, step: 'sort', args: { sort: 'top' } });
  assert.deepEqual(page.actions.filter((action) => action.kind === 'click').map((action) => action.name), ['Top']);

  observation = await tasks.observe(taskId);
  await tasks.step(taskId, { observationId: observation.observationId, step: 'expand_branch', args: { commentIds: ['c1', 'c2'] } });
  const clicks = page.actions.filter((action) => action.kind === 'click');
  assert.deepEqual(clicks.map((click) => click.name), ['Top', 'Load more comments', 'Load more comments']);
  assert.deepEqual(clicks.map((click) => click.scopeId), [null, 'c1', 'c2']);
  assert.equal(clicks.filter((click) => click.name === 'Load more replies').length, 0);

  observation = await tasks.observe(taskId);
  await assert.rejects(
    tasks.step(taskId, { observationId: observation.observationId, step: 'expand_branch', args: { commentIds: ['c9'] } }),
    (error) => error.code === 'STEP_STALE' && error.safeDetails?.reason === 'branch_not_found',
  );
  await assert.rejects(
    tasks.step(taskId, { observationId: observation.observationId, step: 'sort', args: { sort: 'made-up' } }),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'invalid_step_arguments',
  );
});

test('deletion evidence is never taken from another comment or the whole page', () => {
  // A t3 operation on a post page whose named post element is missing. "[deleted]" elsewhere on the
  // page (a comment tree) is not evidence that this post was deleted.
  const dom = createDom({
    url: 'https://www.reddit.com/r/test/comments/abc123/a_post/',
    title: 'A post : r/test',
    bodyText: 'a comment [deleted] another comment',
    query: {},
    queryAll: {},
  });
  const controls = withDom(dom, () => BOUNDED_CONTROLS({ focusId: 'abc123', focusKind: 't3' }));
  assert.equal(controls.deleted, null);
  assert.equal(controls.saved, null);
  assert.equal(controls.vote, null);
  assert.equal(controls.focus, null);

  // A t1 operation whose named comment element is missing cannot borrow the page's marker either.
  const comment = withDom(dom, () => BOUNDED_CONTROLS({ focusId: 'c1', focusKind: 't1' }));
  assert.equal(comment.deleted, null);
  assert.equal(comment.focus, null);

  // Without a focus kind the extractor is used for read-only page facts; page text remains allowed.
  const page = withDom(dom, () => BOUNDED_CONTROLS({ kind: 'controls' }));
  assert.equal(page.deleted, true);
});
