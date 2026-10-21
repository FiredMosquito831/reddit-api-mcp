import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHelpers } from '../src/mcp-browser.js';
import { createBrowserTasks } from '../src/browser/steps.js';

function fakePage(model) {
  return {
    async evaluate() {
      return model;
    },
    mouse: { async wheel() {} },
  };
}

function fakeSnapshot(overrides = {}) {
  return {
    id: 'p_work',
    alias: 'work',
    expectedUsername: 'alice',
    username: 'alice',
    accountKey: 'a_0123456789abcdef',
    enabledBackends: ['browser', 'api'],
    backendPreference: ['browser'],
    visibility: 'visible',
    policyGeneration: 2,
    credentialGeneration: 1,
    ...overrides,
  };
}

function fakeRegistry(snapshot) {
  return {
    async snapshot(selector) {
      if (selector === 'missing') {
        const error = new Error('no such profile');
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      }
      return snapshot;
    },
    async get() {
      return { ...snapshot, isDefault: true };
    },
    async list() {
      return [{ ...snapshot, isDefault: true }];
    },
    async setDefault(selector) {
      return selector === null ? null : snapshot;
    },
  };
}

function fakeDispatcher(overrides = {}) {
  const calls = [];
  return {
    calls,
    async status(selector = null) {
      return {
        profile: {
          id: 'p_work',
          alias: 'work',
          isLegacy: false,
          isDefault: true,
          expectedUsername: 'alice',
          username: 'alice',
          accountKey: 'a_0123456789abcdef',
          accountId: null,
          bound: true,
        },
        defaultProfile: 'work',
        enabledBackends: ['browser', 'api'],
        backendPreference: ['browser'],
        visibility: 'visible',
        passwordLoginEnabled: false,
        confirmations: {},
        api: { clientId: null, appType: null },
        approvalPolicy: { global: 'off', perAction: {} },
        pendingAttempts: [],
        ...overrides.status,
      };
    },
    async closeProfile(selector) {
      calls.push({ closeProfile: selector });
      return { profileId: selector, closedBackends: ['browser'], browser: { closed: true } };
    },
    ...overrides,
  };
}

function build(overrides = {}) {
  const page = overrides.page ?? fakePage({
    url: 'https://www.reddit.com/r/test/',
    title: 'r/test',
    observationText: 'A post',
    elements: [{ role: 'link', name: 'A post' }],
  });
  const snapshot = overrides.snapshot ?? fakeSnapshot();
  const registry = overrides.registry ?? fakeRegistry(snapshot);
  const dispatcher = overrides.dispatcher ?? fakeDispatcher();
  const tasks = overrides.tasks ?? createBrowserTasks();
  const sessions = Object.hasOwn(overrides, 'sessions') ? overrides.sessions : {
    open: async (opened, options = {}) => ({
      visibility: options.visibility ?? opened.visibility,
      context: { pages: () => [page] },
    }),
  };
  const helpers = createBrowserHelpers({
    dispatcher,
    registry,
    sessions,
    tasks,
    settings: overrides.settings ?? { homeDir: 'C:\\temp\\reddit-cli' },
    doctor: overrides.doctor ?? (async () => ({ ok: false, code: 'BROWSER_DEPENDENCY_MISSING', state: 'dependencies_missing' })),
    approvals: overrides.approvals ?? null,
    sampling: overrides.sampling ?? null,
  });
  return { helpers, dispatcher, tasks, sessions, registry, snapshot, page };
}

test('browser open starts one bounded task, observe is redacted, and close ends it', async () => {
  const { helpers, tasks, dispatcher } = build();
  const opened = await helpers.reddit_browser_open({ profile: 'work' });
  assert.equal(opened.visibility, 'visible');
  assert.equal(opened.taskId.startsWith('task_'), true);
  assert.equal(tasks.activeCount('p_work'), 1);

  const observation = await helpers.reddit_browser_observe({ task_id: opened.taskId, kind: 'page' });
  assert.equal(observation.title, 'r/test');
  assert.deepEqual(observation.elements, [{ role: 'link', name: 'A post' }]);

  const handoff = await helpers.reddit_browser_handoff({ task_id: opened.taskId, reason: 'login' });
  assert.equal(handoff.state, 'waiting_for_user');
  assert.equal(handoff.visibility, 'visible');

  const closed = await helpers.reddit_browser_close({ profile: 'work' });
  assert.equal(closed.sessionClosed, true);
  assert.deepEqual(closed.closedTasks, [opened.taskId]);
  assert.equal(tasks.activeCount('p_work'), 0);
  assert.deepEqual(dispatcher.calls, [{ closeProfile: 'p_work' }]);
});

test('browser steps refuse arbitrary mutation, off-origin navigation, and stale observations', async () => {
  const { helpers } = build();
  const opened = await helpers.reddit_browser_open({});
  const observation = await helpers.reddit_browser_observe({ task_id: opened.taskId });

  await assert.rejects(
    helpers.reddit_browser_step({ task_id: opened.taskId, observation_id: observation.observationId, step: 'click' }),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'step_not_allowed',
  );
  await assert.rejects(
    helpers.reddit_browser_step({
      task_id: opened.taskId,
      observation_id: observation.observationId,
      step: 'navigate',
      args: { url: 'https://evil.example/steal' },
    }),
    (error) => error.code === 'UNSUPPORTED_OPERATION' && error.safeDetails?.reason === 'redirect_not_allowed',
  );
  await assert.rejects(
    helpers.reddit_browser_step({ task_id: opened.taskId, observation_id: 'stale', step: 'scroll', args: { direction: 'down' } }),
    (error) => error.code === 'STEP_STALE',
  );
});

test('browser open is refused without a session manager or without the browser backend enabled', async () => {
  const noSessions = build({ sessions: null }).helpers;
  await assert.rejects(
    noSessions.reddit_browser_open({ profile: 'work' }),
    (error) => error.code === 'BACKEND_UNAVAILABLE' && error.safeDetails?.reason === 'local_stdio_only',
  );

  const disabled = build({ snapshot: fakeSnapshot({ enabledBackends: ['api'] }) }).helpers;
  await assert.rejects(
    disabled.reddit_browser_open({ profile: 'work' }),
    (error) => error.code === 'BACKEND_UNAVAILABLE' && error.safeDetails?.reason === 'backend_disabled',
  );

  const missing = build().helpers;
  await assert.rejects(
    missing.reddit_browser_open({ profile: 'missing' }),
    (error) => error.code === 'PROFILE_NOT_FOUND',
  );
});

test('browser status reports diagnostics and open tasks without installing anything', async () => {
  let doctorCalls = 0;
  const doctor = async ({ profile }) => {
    doctorCalls += 1;
    assert.equal(profile.alias, 'work');
    return {
      ok: false,
      code: 'BROWSER_DEPENDENCY_MISSING',
      state: 'dependencies_missing',
      commands: ['npm install playwright@1.64.1', 'npx playwright install chromium'],
      hints: ['Install explicitly.'],
    };
  };
  const { helpers } = build({ doctor });
  const opened = await helpers.reddit_browser_open({ profile: 'work' });
  const status = await helpers.reddit_browser_status({ profile: 'work' });
  assert.equal(doctorCalls, 1);
  assert.equal(status.doctor.code, 'BROWSER_DEPENDENCY_MISSING');
  assert.equal(status.profile.id, 'p_work');
  assert.deepEqual(status.openTasks.map((task) => task.taskId), [opened.taskId]);
  assert.equal(status.sessionManager, true);
  assert.match(status.note, /never install/i);
  assert.equal(JSON.stringify(status).includes('cookie'), false);
});

test('status still answers when no profile is configured', async () => {
  const { helpers } = build({
    registry: {
      async snapshot() {
        const error = new Error('none');
        error.code = 'PROFILE_NOT_FOUND';
        throw error;
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
    },
  });
  const status = await helpers.reddit_browser_status({});
  assert.equal(status.profile, null);
  assert.equal(status.profileError, 'PROFILE_REQUIRED');
  assert.equal(status.doctor.state, 'dependencies_missing');
});

test('helper metadata never returns a credential, and close requires a target', async () => {
  const { helpers } = build();
  await assert.rejects(helpers.reddit_browser_close({}), /task_id|profile/);
  const status = await helpers.reddit_settings_get({});
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('C:\\\\temp'), false);
});
