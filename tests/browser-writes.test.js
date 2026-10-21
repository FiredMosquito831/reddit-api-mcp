import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixturePage } from './fixtures/browser/page.js';
import { post, postModel, subredditModel } from './fixtures/browser/models.js';
import { createWriteAdapters } from '../src/browser/adapters/writes.js';
import { createBrowserBackend } from '../src/backends/browser.js';
import { createBrowserTasks } from '../src/browser/steps.js';
import { OperationError } from '../src/errors.js';

const PROFILE = Object.freeze({
  id: 'p_alpha',
  alias: 'Alpha',
  expectedUsername: 'someone',
  accountKey: 'acct_1',
  accountId: 't2_abc',
  username: 'someone',
  generation: 1,
  credentialGeneration: 1,
  policyGeneration: 1,
  enabledBackends: ['browser'],
  backendPreference: ['browser'],
  visibility: 'visible',
  confirmations: {},
  api: { clientId: null, appType: null },
  passwordLoginEnabled: false,
});

const ACCOUNT = Object.freeze({ username: 'someone', accountKey: 'acct_1', accountId: 't2_abc' });

function op(tool, args) {
  return { tool, kind: 'write', target: 't3_abc123', policyKey: tool, requiresIdentity: true, args };
}

function adapters(options = {}) {
  return createWriteAdapters({ sleep: async () => {}, maxEvidenceAttempts: 2, ...options });
}

function ctx(page, overrides = {}) {
  return {
    page,
    account: ACCOUNT,
    verifyIdentity: async () => ({ username: 'someone', accountKey: 'acct_1', accountId: 't2_abc' }),
    footer: '',
    ...overrides,
  };
}

function clicks(page) {
  return page.actions.filter((action) => action.kind === 'click');
}

function requestControls(page, controls) {
  Object.assign(page.model.controls ??= {}, controls);
}

test('create_post fills the title and body, clicks one recognized submit button, and returns the created id', async () => {
  const page = createFixturePage({
    url: 'https://www.reddit.com/r/test/submit/',
    canonicalId: null,
    controls: { subreddit: 'test' },
    elements: [
      { role: 'textbox', name: 'Title' },
      { role: 'textbox', name: 'Body' },
      {
        role: 'button',
        name: 'Post',
        onClick: (element, fixture) => {
          Object.assign(fixture.model.controls, { createdId: 'new123', createdPermalink: '/r/test/comments/new123/a_title/' });
        },
      },
    ],
  });
  const writes = adapters({ footer: undefined });
  const operation = op('create_post', { subreddit: 'test', title: 'A title', text: 'Body text' });
  const prepared = await writes.prepare(operation, ctx(page));
  assert.equal(prepared.alreadySatisfied, false);
  const result = await writes.commit(prepared, ctx(page));

  assert.equal(result.data.id, 'new123');
  assert.equal(result.data.name, 't3_new123');
  assert.equal(result.data.url, '/r/test/comments/new123/a_title/');
  assert.equal(clicks(page).length, 1);
  assert.equal(clicks(page)[0].name, 'Post');
  const fills = page.actions.filter((action) => action.kind === 'fill');
  assert.deepEqual(fills.map((fill) => fill.value).sort(), ['A title', 'Body text'].sort());
});

test('the configured footer is appended to UI text writes, matching the API path', async () => {
  const page = createFixturePage({
    url: 'https://www.reddit.com/r/test/submit/',
    controls: { subreddit: 'test' },
    elements: [
      { role: 'textbox', name: 'Title' },
      { role: 'textbox', name: 'Body' },
      { role: 'button', name: 'Post', onClick: (element, fixture) => { fixture.model.controls.createdId = 'new1'; } },
    ],
  });
  const writes = createWriteAdapters({ sleep: async () => {} });
  const operation = op('create_post', { subreddit: 'test', title: 'T', text: 'B' });
  const prepared = await writes.prepare(operation, ctx(page, { footer: '\n\n-- bot' }));
  await writes.commit(prepared, ctx(page, { footer: '\n\n-- bot' }));
  const body = page.actions.filter((action) => action.kind === 'fill').find((fill) => fill.name === 'Body');
  assert.equal(body.value, 'B\n\n-- bot');
});

test('an unfamiliar submit control is unsupported instead of clicking a guessed button', async () => {
  const page = createFixturePage({
    url: 'https://www.reddit.com/r/test/submit/',
    controls: { subreddit: 'test' },
    elements: [
      { role: 'textbox', name: 'Title' },
      { role: 'textbox', name: 'Body' },
      { role: 'button', name: 'Publish' },
    ],
  });
  const writes = adapters();
  await assert.rejects(
    writes.prepare(op('create_post', { subreddit: 'test', title: 'T', text: 'B' }), ctx(page)),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'control_not_recognized',
  );
  assert.equal(clicks(page).length, 0);
});

test('save_content does not toggle an already-saved item and returns a no-change receipt', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: true },
    elements: [{ role: 'button', name: 'Saved', pressed: true }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, true);
  const result = await writes.commit(prepared, ctx(page));
  assert.equal(result.data.alreadySatisfied, true);
  assert.equal(result.data.changed, false);
  assert.equal(clicks(page).length, 0);

  const unsavedPage = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{
      role: 'button',
      name: 'Save',
      onClick: (element, fixture) => { fixture.model.controls.saved = true; },
    }],
  }));
  const pending = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(unsavedPage));
  assert.equal(pending.alreadySatisfied, false);
  const saved = await writes.commit(pending, ctx(unsavedPage));
  assert.deepEqual(saved.data, {});
  assert.equal(clicks(unsavedPage).length, 1);
});

test('unsave_content does not click when the item is already unsaved', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{ role: 'button', name: 'Save' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('unsave_content', { fullname: 't3_abc123' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, true);
  await writes.commit(prepared, ctx(page));
  assert.equal(clicks(page).length, 0);
});

test('vote_on_thing votes exactly once and never duplicates the current vote state', async () => {
  const votePage = createFixturePage(postModel({
    controls: { vote: 'none' },
    elements: [{
      role: 'button',
      name: 'Upvote',
      onClick: (element, fixture) => { fixture.model.controls.vote = 'up'; },
    }, { role: 'button', name: 'Downvote' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('vote_on_thing', { fullname: 't3_abc123', direction: 'up' }), ctx(votePage));
  assert.equal(prepared.alreadySatisfied, false);
  const result = await writes.commit(prepared, ctx(votePage));
  assert.deepEqual(result.data, {});
  assert.equal(clicks(votePage).length, 1);

  const already = createFixturePage(postModel({
    controls: { vote: 'up' },
    elements: [{ role: 'button', name: 'Upvote', pressed: true }],
  }));
  const noop = await writes.prepare(op('vote_on_thing', { fullname: 't3_abc123', direction: 'up' }), ctx(already));
  assert.equal(noop.alreadySatisfied, true);
  await writes.commit(noop, ctx(already));
  assert.equal(clicks(already).length, 0);

  const clearPage = createFixturePage(postModel({
    controls: { vote: 'none' },
    elements: [{ role: 'button', name: 'Upvote' }],
  }));
  const clear = await writes.prepare(op('vote_on_thing', { fullname: 't3_abc123', direction: 'clear' }), ctx(clearPage));
  assert.equal(clear.alreadySatisfied, true);
  await writes.commit(clear, ctx(clearPage));
  assert.equal(clicks(clearPage).length, 0);
});

test('subscribe does not click when membership already matches, and unsubscribes once otherwise', async () => {
  const joined = createFixturePage(subredditModel({
    controls: { joined: true },
    elements: [{ role: 'button', name: 'Joined', pressed: true }],
  }));
  const writes = adapters();
  const noop = await writes.prepare(
    { ...op('subscribe_to_subreddit', { subreddit: 'test' }), target: 'r/test' },
    ctx(joined),
  );
  assert.equal(noop.alreadySatisfied, true);
  await writes.commit(noop, ctx(joined));
  assert.equal(clicks(joined).length, 0);

  const notJoined = createFixturePage(subredditModel({
    controls: { joined: true },
    elements: [{
      role: 'button',
      name: 'Joined',
      onClick: (element, fixture) => { fixture.model.controls.joined = false; },
    }],
  }));
  const leaving = await writes.prepare(
    { ...op('unsubscribe_from_subreddit', { subreddit: 'test' }), target: 'r/test' },
    ctx(notJoined),
  );
  await writes.commit(leaving, ctx(notJoined));
  assert.equal(clicks(notJoined).length, 1);
  assert.equal(notJoined.model.controls.joined, false);
});

test('reply_to_post fills the comment box and returns the created comment id from visible evidence', async () => {
  const page = createFixturePage(postModel({
    controls: {},
    elements: [
      { role: 'textbox', name: 'Add a comment' },
      {
        role: 'button',
        name: 'Comment',
        onClick: (element, fixture) => {
          fixture.model.controls.lastComment = { id: 'c9', parentId: 't3_abc123', body: 'hello' };
        },
      },
    ],
  }));
  const writes = adapters();
  const operation = op('reply_to_post', { parent: 't3_abc123', text: 'hello' });
  const prepared = await writes.prepare(operation, ctx(page));
  const result = await writes.commit(prepared, ctx(page));
  assert.equal(result.data.things[0].kind, 't1');
  assert.equal(result.data.things[0].data.id, 'c9');
  assert.equal(clicks(page).length, 1);
});

test('edit_post saves the edited body once', async () => {
  const page = createFixturePage(postModel({
    controls: { bodyText: 'old' },
    elements: [
      { role: 'textbox', name: 'Edit body' },
      { role: 'button', name: 'Save', onClick: (element, fixture) => {
        const fills = fixture.actions.filter((action) => action.kind === 'fill');
        fixture.model.controls.bodyText = fills.at(-1)?.value ?? null;
      } },
    ],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('edit_post', { fullname: 't3_abc123', text: 'new text', kind: 't3' }), ctx(page));
  const result = await writes.commit(prepared, ctx(page));
  assert.equal(result.data.things[0].kind, 't3');
  assert.equal(result.data.things[0].data.body, 'new text');
  assert.equal(clicks(page).length, 1);
});

test('delete_post deletes only after the named menu and confirmation controls and reports success', async () => {
  const page = createFixturePage(postModel({
    controls: { deleted: false },
    elements: [
      { role: 'button', name: 'More options' },
      { role: 'button', name: 'Delete', onClick: (element, fixture) => { fixture.model.controls.confirmOpen = true; } },
      {
        role: 'button',
        name: 'Delete post',
        onClick: (element, fixture) => { fixture.model.controls.deleted = true; },
      },
    ],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('delete_post', { fullname: 't3_abc123', kind: 't3' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, false);
  const result = await writes.commit(prepared, ctx(page));
  assert.deepEqual(result.data, {});
  assert.deepEqual(clicks(page).map((click) => click.name), ['More options', 'Delete', 'Delete post']);
});

test('delete_comment treats an already-deleted target as a no-change success', async () => {
  const page = createFixturePage({ url: 'https://www.reddit.com/user/someone/comments/', controls: {}, elements: [] }, {
    evaluate: async (fn, arg, fixture) => {
      if (arg?.kind !== 'controls') return { recognized: true, items: [], comments: [] };
      return fixture.url().includes('/user/')
        ? { canonicalId: null, focus: { id: 'c1', postId: 'abc123' } }
        : { canonicalId: 'abc123', focus: { id: 'c1', postId: 'abc123' }, deleted: true };
    },
  });
  const writes = adapters();
  const prepared = await writes.prepare(op('delete_comment', { fullname: 't1_c1', kind: 't1' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, true);
  const result = await writes.commit(prepared, ctx(page));
  assert.equal(result.data.alreadySatisfied, true);
  assert.equal(clicks(page).length, 0);
});

test('a changed account refuses the commit before any click', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{ role: 'button', name: 'Save' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  await assert.rejects(
    writes.commit(prepared, ctx(page, {
      verifyIdentity: async () => ({ username: 'otherperson', accountKey: 'acct_2' }),
    })),
    (error) => error.code === 'IDENTITY_MISMATCH' && error.outcome === 'FAILED_KNOWN',
  );
  assert.equal(clicks(page).length, 0);
});

test('a target that changed after preparation is refused before any click', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{ role: 'button', name: 'Save' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  page.model.canonicalId = 'zzz999';
  await assert.rejects(
    writes.commit(prepared, ctx(page)),
    (error) => error.code === 'STEP_STALE' && error.outcome === 'FAILED_KNOWN',
  );
  assert.equal(clicks(page).length, 0);
});

test('a login screen at commit is a user handoff and performs no click', async () => {
  const page = createFixturePage(postModel({ controls: { saved: false }, elements: [{ role: 'button', name: 'Save' }] }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  page.model.security = 'login';
  await assert.rejects(writes.commit(prepared, ctx(page)), (error) => error.code === 'USER_HANDOFF_REQUIRED');
  assert.equal(clicks(page).length, 0);
});

test('a refusal message after the click is a known failure, and silence becomes OUTCOME_UNKNOWN', async () => {
  const refused = createFixturePage(postModel({
    controls: {},
    elements: [{
      role: 'button',
      name: 'Comment',
      onClick: (element, fixture) => { fixture.model.controls.refusal = 'You are not allowed to comment here.'; },
    }, { role: 'textbox', name: 'Add a comment' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('reply_to_post', { parent: 't3_abc123', text: 'hi' }), ctx(refused));
  await assert.rejects(
    writes.commit(prepared, ctx(refused)),
    (error) => error.code === 'FAILED_KNOWN' || error.outcome === 'FAILED_KNOWN',
  );

  const silent = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{ role: 'button', name: 'Save' }],
  }));
  const pending = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(silent));
  await assert.rejects(pending && writes.commit(pending, ctx(silent)), (error) => {
    assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.equal(error.outcome, 'OUTCOME_UNKNOWN');
    return true;
  });
});

test('the browser backend exposes all browser read and write capabilities and probes the live session', async () => {
  const page = createFixturePage(postModel());
  const opened = [];
  const sessions = {
    async open(snapshot) {
      opened.push(snapshot.id);
      return { id: snapshot.id, visibility: 'visible', context: { pages: () => [page], newPage: async () => page } };
    },
    async identity() {
      if (opened.length === 0) throw new OperationError('PROFILE_NOT_FOUND', 'not open');
      return { username: 'someone', accountKey: 'acct_1', accountId: 't2_abc', verified: true };
    },
  };
  const tasks = createBrowserTasks({ clock: () => 1_000, newId: () => 'task_1' });
  const backend = createBrowserBackend({ snapshot: PROFILE, sessions, settings: {}, tasks });

  const capabilities = await backend.capabilities();
  assert.equal(capabilities.backend, 'browser');
  assert.equal(capabilities.reads.length, 19);
  assert.equal(capabilities.writes.length, 11);
  assert.equal(capabilities.writes.includes('delete_comment'), true);
  assert.equal(capabilities.reads.includes('browse_subreddit_rss'), false);

  const closedSessions = {
    async open() {
      throw new OperationError('LOGIN_REQUIRED', 'This profile needs a local sign-in first.');
    },
    async identity() {
      throw new OperationError('PROFILE_NOT_FOUND', 'not open');
    },
  };
  const closedBackend = createBrowserBackend({ snapshot: PROFILE, sessions: closedSessions, settings: {}, tasks });
  await assert.rejects(closedBackend.probe(), (error) => error.code === 'LOGIN_REQUIRED');

  const identity = await backend.probe();
  assert.equal(identity.username, 'someone');
  assert.equal(identity.verified, true);
  assert.equal(tasks.hasActiveTask(PROFILE.id), false);
});

test('backend reads run inside a task and close it when no continuation is issued', async () => {
  const page = createFixturePage(postModel({
    entry: post({ id: 'abc123', title: 'T', author: 'a', subreddit: 'test' }),
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
  const backend = createBrowserBackend({ snapshot: PROFILE, sessions, settings: {}, tasks });
  const result = await backend.read(
    { tool: 'get_reddit_post', kind: 'read', target: 't3_abc123', requiresIdentity: false, args: { id: 'abc123' } },
    {},
  );
  assert.equal(result.data.post.id, 'abc123');
  assert.equal(result.meta.backend, 'browser');
  assert.equal(result.meta.completeness, 'partial');
  assert.equal(tasks.hasActiveTask(PROFILE.id), false);
});

test('a prepared UI write runs exactly once through the shared write boundary', async () => {
  const { createWriteBoundary } = await import('../src/write-boundary.js');
  const page = createFixturePage({
    url: 'https://www.reddit.com/r/test/submit/',
    controls: { subreddit: 'test' },
    elements: [
      { role: 'textbox', name: 'Title' },
      { role: 'textbox', name: 'Body' },
      { role: 'button', name: 'Post', onClick: (element, fixture) => { fixture.model.controls.createdId = 'new777'; } },
    ],
  });
  const sessions = {
    async open() {
      return { id: PROFILE.id, visibility: 'visible', context: { pages: () => [page], newPage: async () => page } };
    },
    async identity() {
      return { username: 'someone', accountKey: 'acct_1', accountId: 't2_abc', verified: true };
    },
  };
  const tasks = createBrowserTasks({ clock: () => 1_000, newId: () => 'task_1' });
  const backend = createBrowserBackend({ snapshot: PROFILE, sessions, settings: {}, tasks });
  const settled = [];
  const ledger = {
    accountKey: 'acct_1',
    async reserve() { return { id: 'attempt_1', scheduledAt: 0 }; },
    async recheckSlot() { return { ready: true }; },
    async markDispatched(id) { settled.push(['dispatched', id]); },
    async settle(id, outcome) { settled.push(['settle', id, outcome]); },
    async cancel(id) { settled.push(['cancel', id]); },
  };
  const boundary = createWriteBoundary({ ledger, policy: { global: 'off', perAction: {} }, clock: () => 1_000, sleep: async () => {} });
  const operation = {
    tool: 'create_post',
    action: 'submitPost',
    kind: 'write',
    policyKey: 'create_post',
    target: 'r/test',
    requiresIdentity: true,
    contentHash: 'hash',
    args: { subreddit: 'test', title: 'T', text: 'B' },
  };
  const result = await boundary.run({
    operation,
    context: { accountKey: 'acct_1', verified: true, profile: PROFILE, backendId: 'browser' },
    prepare: () => backend.prepareWrite(operation, {}),
    commit: (prepared) => backend.commitWrite(prepared, {}),
  });
  assert.equal(result.data.id, 'new777');
  assert.equal(result.meta.outcome, 'SUCCEEDED');
  assert.equal(clicks(page).length, 1);
  assert.deepEqual(settled, [['dispatched', 'attempt_1'], ['settle', 'attempt_1', 'SUCCEEDED']]);
  assert.equal(tasks.hasActiveTask(PROFILE.id), false);
});

test('an unobserved toggle state is refused before dispatch instead of clicking an unknown direction', async () => {
  const cases = [
    ['save_content', { fullname: 't3_abc123' }, {}],
    ['unsave_content', { fullname: 't3_abc123' }, {}],
    ['vote_on_thing', { fullname: 't3_abc123', direction: 'clear' }, {}],
    ['vote_on_thing', { fullname: 't3_abc123', direction: 'up' }, {}],
  ];
  for (const [tool, args, controls] of cases) {
    const page = createFixturePage(postModel({
      controls,
      elements: [
        { role: 'button', name: 'Upvote', onClick: (element, fixture) => { fixture.model.controls.vote = 'up'; } },
        { role: 'button', name: 'Downvote', onClick: (element, fixture) => { fixture.model.controls.vote = 'down'; } },
        { role: 'button', name: 'Save', onClick: (element, fixture) => { fixture.model.controls.saved = true; } },
      ],
    }));
    const writes = adapters();
    await assert.rejects(
      writes.prepare(op(tool, args), ctx(page)),
      (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'state_unverified',
      `${tool} must refuse an unknown state`,
    );
    assert.equal(clicks(page).length, 0, `${tool} must not click`);
  }

  const subreddit = createFixturePage(subredditModel({
    controls: {},
    elements: [{
      role: 'button',
      name: 'Join',
      onClick: (element, fixture) => { fixture.model.controls.joined = true; },
    }],
  }));
  await assert.rejects(
    adapters().prepare(
      { ...op('subscribe_to_subreddit', { subreddit: 'test' }), target: 'r/test' },
      ctx(subreddit),
    ),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'state_unverified',
  );
  assert.equal(clicks(subreddit).length, 0);
});

test('a state change between prepare and commit is honored instead of returning a stale no-op', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: true },
    elements: [{ role: 'button', name: 'Saved', pressed: true, onClick: (element, fixture) => { fixture.model.controls.saved = true; } }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, true);

  // The item was unsaved elsewhere between preparation and the guarded commit.
  page.model.controls.saved = false;
  const result = await writes.commit(prepared, ctx(page));
  assert.equal(result.data.alreadySatisfied, undefined);
  assert.equal(result.data.changed, undefined);
  assert.equal(clicks(page).length, 1);
  assert.equal(page.model.controls.saved, true);
});

test('clearing a vote uses the state observed at commit, not the prepare-time state', async () => {
  const page = createFixturePage(postModel({
    controls: { vote: 'up' },
    elements: [
      { role: 'button', name: 'Upvote', pressed: true, onClick: (element, fixture) => { fixture.model.controls.vote = 'none'; } },
      { role: 'button', name: 'Downvote', onClick: (element, fixture) => { fixture.model.controls.vote = 'none'; } },
    ],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('vote_on_thing', { fullname: 't3_abc123', direction: 'clear' }), ctx(page));
  assert.equal(prepared.alreadySatisfied, false);

  page.model.controls.vote = 'down';
  const result = await writes.commit(prepared, ctx(page));
  assert.deepEqual(result.data, {});
  assert.deepEqual(clicks(page).map((click) => click.name), ['Downvote']);
  assert.equal(page.model.controls.vote, 'none');
});

test('delete works when the menu item and confirmation appear only after the menu click', async () => {
  const page = createFixturePage(postModel({
    controls: { deleted: false },
    elements: [{
      role: 'button',
      name: 'More options',
      onClick: (element, fixture) => {
        fixture.model.elements.push({
          role: 'menuitem',
          name: 'Delete',
          scopeId: 'abc123',
          onClick: (item, inner) => {
            inner.model.elements.push({
              role: 'button',
              name: 'Delete post',
              scopeId: 'abc123',
              onClick: (confirm, confirmed) => { confirmed.model.controls.deleted = true; },
            });
          },
        });
      },
    }],
  }));
  const writes = adapters({ sleep: async () => {}, maxEvidenceAttempts: 2, pollMs: 0 });
  const prepared = await writes.prepare(op('delete_post', { fullname: 't3_abc123', kind: 't3' }), ctx(page));
  const result = await writes.commit(prepared, ctx(page));
  assert.deepEqual(result.data, {});
  assert.deepEqual(clicks(page).map((click) => click.name), ['More options', 'Delete', 'Delete post']);
});

test('comment-target writes resolve the comment to its post page and use the comment-scoped controls', async () => {
  const elements = [
    { role: 'button', name: 'More options', scopeId: 'c1' },
    {
      role: 'button',
      name: 'Delete',
      scopeId: 'c1',
      onClick: (element, fixture) => {
        fixture.model.elements.push({
          role: 'button',
          name: 'Delete comment',
          scopeId: 'c1',
          onClick: (confirm, confirmed) => { confirmed.model.controls.deleted = true; },
        });
      },
    },
  ];
  const page = createFixturePage({ url: 'https://www.reddit.com/user/someone/comments/', controls: {}, elements }, {
    evaluate: async (fn, arg, fixture) => {
      if (arg?.kind !== 'controls') return { recognized: true, items: [], comments: [] };
      const onLabelPage = fixture.url().includes('/user/');
      return onLabelPage
        ? { canonicalId: null, focus: { id: 'c1', postId: 'p1', body: 'old' } }
        : {
          canonicalId: 'p1',
          focus: { id: 'c1', postId: 'p1', body: 'old' },
          deleted: fixture.model.controls.deleted === true ? true : false,
          saved: false,
        };
    },
  });
  const writes = adapters({ pollMs: 0 });
  const prepared = await writes.prepare(op('delete_comment', { fullname: 't1_c1', kind: 't1' }), ctx(page));
  const result = await writes.commit(prepared, ctx(page));

  assert.deepEqual(result.data, {});
  assert.deepEqual(page.actions.filter((action) => action.kind === 'goto').map((action) => action.url), [
    'https://www.reddit.com/user/someone/comments/',
    'https://www.reddit.com/comments/p1/',
  ]);
  assert.deepEqual(clicks(page).map((click) => click.name), ['More options', 'Delete', 'Delete comment']);
  assert.equal(clicks(page).every((click) => click.scopeId === 'c1'), true);
});

test('a challenge overlay on a normal post URL is detected at commit before any click', async () => {
  const page = createFixturePage(postModel({
    controls: { saved: false },
    elements: [{ role: 'button', name: 'Save' }],
  }));
  const writes = adapters();
  const prepared = await writes.prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page));
  page.model.controls.observationText = 'Please verify you are human to continue';
  await assert.rejects(
    writes.commit(prepared, ctx(page)),
    (error) => error.code === 'USER_HANDOFF_REQUIRED' && error.safeDetails?.screen === 'challenge',
  );
  assert.equal(clicks(page).length, 0);
});

test('post-target writes never fall back to a comment-scoped control with the same label', async () => {
  // The page can show many Save/Upvote/More options controls. A t3 operation may only use a
  // control inside shreddit-post[id="t3_abc123"]; a comment's control is a different target.
  const savePage = createFixturePage(postModel({
    controls: {},
    elements: [{ role: 'button', name: 'Save', scopeId: 'c1', onClick: (element, fixture) => { fixture.model.controls.saved = true; } }],
  }));
  await assert.rejects(
    adapters().prepare(op('save_content', { fullname: 't3_abc123' }), ctx(savePage)),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.outcome === null,
  );
  assert.equal(clicks(savePage).length, 0);

  const deletePage = createFixturePage(postModel({
    controls: { deleted: false },
    elements: [
      { role: 'button', name: 'More options', scopeId: 'c1' },
      { role: 'button', name: 'Delete', scopeId: 'c1' },
      { role: 'button', name: 'Delete post', scopeId: 'c1' },
    ],
  }));
  await assert.rejects(
    adapters().prepare(op('delete_post', { fullname: 't3_abc123', kind: 't3' }), ctx(deletePage)),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'control_not_recognized',
  );
  assert.equal(clicks(deletePage).length, 0);
});

test('a t3 target whose post element is absent fails closed instead of reading page-wide state', async () => {
  const page = createFixturePage(postModel({ controls: {}, elements: [] }), {
    evaluate: async (fn, arg) => {
      if (arg?.kind !== 'controls') return { recognized: true, items: [], comments: [] };
      // A markup variant with no shreddit-post element: every state below is page-wide and must not
      // be attributed to the named target.
      return { canonicalId: 'abc123', saved: false, vote: 'none', deleted: true, focus: null, elements: [] };
    },
  });
  await assert.rejects(
    adapters().prepare(op('save_content', { fullname: 't3_abc123' }), ctx(page)),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'target_not_located',
  );
  assert.equal(clicks(page).length, 0);
});

test('browser operations on one profile are serialized through the shared task registry', async () => {
  const page = createFixturePage(postModel());
  const sessions = {
    async open() { return { id: PROFILE.id, visibility: 'visible', context: { pages: () => [page] } }; },
    async identity() { return { username: 'someone', accountKey: 'acct_1', accountId: 't2_abc', verified: true }; },
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const reads = {
    async read(operation) {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (started === 1) await gate;
        return { data: { tool: operation.tool, startedAt: started }, meta: {} };
      } finally {
        active -= 1;
      }
    },
  };
  const tasks = createBrowserTasks({ clock: () => 1_000, newId: () => `task_${started}` });
  const backend = createBrowserBackend({ snapshot: PROFILE, sessions, settings: {}, tasks, adapters: { reads } });
  const operation = { tool: 'get_reddit_post', kind: 'read', target: 't3_abc123', requiresIdentity: false, args: { id: 'abc123' } };

  const first = backend.read(operation, {});
  // Let the first operation reach its adapter, then enqueue the second.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tasks.hasActiveTask(PROFILE.id), true);
  const second = backend.read(operation, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, 'the second call waits for the first operation');
  release();
  const results = await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.deepEqual(results.map((result) => result.data.startedAt), [1, 2]);
  assert.equal(tasks.hasActiveTask(PROFILE.id), false);
});
