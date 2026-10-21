import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import { createBrowserSessionManager } from '../src/browser/session.js';
import { classifyIdentityResponse, normalizeIdentityPayload } from '../src/browser/identity.js';
import { createProfileSecretStore } from '../src/secrets.js';
import { deriveAccountKey, usernameKey } from '../src/accounts.js';

const HOME = join(tmpdir(), 'reddit-cli-browser-session-tests');
const PROFILE = Object.freeze({
  kind: 'profile',
  id: 'p_alpha',
  alias: 'Alpha Account',
  expectedUsername: null,
  accountKey: null,
  accountId: null,
  username: null,
  generation: 1,
  credentialGeneration: 1,
  policyGeneration: 1,
  enabledBackends: ['browser', 'api'],
  backendPreference: ['api', 'browser'],
  visibility: 'visible',
  confirmations: {},
  api: { clientId: null, appType: null },
  passwordLoginEnabled: false,
});

// --- fakes -------------------------------------------------------------------------------------

function jsonResponse(payload, { status = 200, url = 'https://www.reddit.com/api/me.json' } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status: () => status,
    url: () => url,
    headers: () => ({ 'content-type': 'application/json' }),
    async text() { return text; },
  };
}

function htmlResponse(text, { status = 200, url = 'https://www.reddit.com/api/me.json' } = {}) {
  return {
    status: () => status,
    url: () => url,
    headers: () => ({ 'content-type': 'text/html' }),
    async text() { return text; },
  };
}

function mePayload(name, id = null) {
  return {
    kind: 'User',
    data: id === null ? { name } : { name, id },
  };
}

function sequenceRequest(responses) {
  const calls = [];
  return {
    calls,
    async get(url, options) {
      calls.push({ url, options });
      const index = Math.min(calls.length - 1, responses.length - 1);
      const next = responses[index];
      if (typeof next === 'function') return next(url, options);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function fakePage() {
  const actions = [];
  const page = {
    actions,
    async goto(url, options) { actions.push({ kind: 'goto', url, options }); },
    url() { return 'https://www.reddit.com/login/'; },
    locator(selector) {
      const known = new Set([
        'input[name="username"]',
        '#login-username',
        'input[name="password"]',
        '#login-password',
        'button[type="submit"]',
        '#login-submit',
      ]);
      const locator = {
        async count() { return known.has(selector) ? 1 : 0; },
        first() { return locator; },
        async fill(value, options) { actions.push({ kind: 'fill', selector, value, options }); },
        async click(options) { actions.push({ kind: 'click', selector, options }); },
        async press() { actions.push({ kind: 'press', selector }); },
      };
      return locator;
    },
  };
  return page;
}

function fakeContext({ request, page = fakePage() } = {}) {
  const state = { closes: 0, newPages: 0 };
  const pages = [page];
  return {
    state,
    request: request ?? null,
    pages: () => pages,
    async newPage() { state.newPages += 1; return page; },
    async close() { state.closes += 1; },
  };
}

function fakePlaywright({ launchError = null } = {}) {
  const calls = [];
  const contexts = [];
  return {
    calls,
    contexts,
    module: {
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          calls.push({ userDataDir, options });
          if (launchError) throw launchError;
          const context = fakeContext();
          contexts.push(context);
          return context;
        },
      },
    },
  };
}

function fakeLeases({ failWith = null, onAcquire = null } = {}) {
  const held = new Map();
  const log = [];
  let counter = 0;
  return {
    held,
    log,
    async acquire(path, options = {}) {
      log.push({ kind: 'acquire', path, options });
      if (failWith) throw failWith;
      if (onAcquire) await onAcquire(path);
      const lease = {
        path,
        nonce: `nonce-${++counter}`,
        kind: options.kind,
        owner: options.owner,
        released: false,
        async assertHeld() { return true; },
        async heartbeat() { return 1; },
        async release() {
          if (lease.released) return false;
          lease.released = true;
          held.delete(path);
          log.push({ kind: 'release', path });
          return true;
        },
      };
      held.set(path, lease);
      return lease;
    },
  };
}

function fakeKeyring() {
  const values = new Map();
  return {
    values,
    factory: (service, account) => {
      const key = `${service}\u0000${account}`;
      return {
        getPassword() { return values.has(key) ? values.get(key) : null; },
        setPassword(value) { values.set(key, value); },
        deletePassword() { return values.delete(key); },
      };
    },
  };
}

function fakeAccounts(bindings = []) {
  const binds = [];
  return {
    binds,
    async bind(input) {
      binds.push(input);
      const existing = bindings.find((entry) => entry.username === input.username);
      const accountKey = existing?.accountKey ?? deriveAccountKey(usernameKey(input.username));
      const record = {
        accountKey,
        accountId: input.accountId ?? existing?.accountId ?? null,
        username: input.username,
      };
      bindings.push(record);
      return record;
    },
    async lookup() { return null; },
    async list() { return bindings; },
  };
}

let clockValue = 1_700_000_000_000;
function resetClock() { clockValue = 1_700_000_000_000; }
function fakeClock() { return clockValue; }
function advanceClock(ms) { clockValue += ms; }

function manager({
  loadPlaywright,
  leases = fakeLeases(),
  accounts = fakeAccounts(),
  keyring = fakeKeyring(),
  protect = null,
  settings = {},
  interactive = null,
} = {}) {
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  const protectCalls = [];
  const instance = createBrowserSessionManager({
    registry: null,
    accounts,
    secretStore,
    leases,
    loadPlaywright,
    clock: fakeClock,
    settings: { homeDir: HOME, ...settings },
    protect: async (path) => { protectCalls.push(path); if (protect) await protect(path); },
    sleep: async (ms) => { advanceClock(ms); },
    interactive,
  });
  return { instance, secretStore, protectCalls, leases, accounts, keyring };
}

function loader(playwright) {
  const calls = [];
  return {
    calls,
    async load() { calls.push('load'); return playwright.module; },
  };
}

// --- tests -------------------------------------------------------------------------------------

test('open loads the optional Playwright peer only at launch and retains one owner', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const load = loader(playwright);
  const { instance } = manager({ loadPlaywright: load.load });
  assert.equal(load.calls.length, 0, 'importing and constructing must not load Playwright');

  const first = await instance.open(PROFILE);
  assert.equal(load.calls.length, 1);
  assert.equal(playwright.calls.length, 1);
  assert.equal(first.context, playwright.contexts[0]);
  assert.equal(first.requestContext, playwright.contexts[0].request);
  assert.equal(first.account, null);
  assert.equal(first.credentialGeneration, 1);

  const second = await instance.open(PROFILE);
  assert.equal(second, first, 'the retained owner is returned, not relaunched');
  assert.equal(playwright.calls.length, 1);
  t.after(() => instance.closeAll());
});

test('the profile directory is derived from the opaque id, never from the alias', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const { instance } = manager({ loadPlaywright: loader(playwright).load });
  await instance.open(PROFILE);
  const dir = playwright.calls[0].userDataDir;
  assert.ok(dir.startsWith(HOME + sep));
  assert.ok(dir.includes(`${sep}p_alpha${sep}`), `expected the opaque id in ${dir}`);
  assert.ok(!dir.toLowerCase().includes('alpha account'));
  t.after(() => instance.closeAll());
});

test('the protected root is established before the browser launches', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const order = [];
  const { instance, protectCalls } = manager({
    loadPlaywright: loader(playwright).load,
    protect: async () => { order.push('protect'); },
  });
  const originalLaunch = playwright.module.chromium.launchPersistentContext;
  playwright.module.chromium.launchPersistentContext = async (...args) => {
    order.push('launch');
    return originalLaunch(...args);
  };
  await instance.open(PROFILE);
  assert.equal(protectCalls.length, 1);
  assert.ok(protectCalls[0].includes(`${sep}p_alpha${sep}`));
  assert.deepEqual(order, ['protect', 'launch']);
  t.after(() => instance.closeAll());
});

test('visible is the default, headless is selectable, and ask without a channel is handoff', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open(PROFILE);
  await instance.open({ ...PROFILE, id: 'p_beta' }, { visibility: 'headless' });
  assert.equal(playwright.calls[0].options.headless, false);
  assert.equal(playwright.calls[1].options.headless, true);

  let asked = null;
  try {
    await instance.open({ ...PROFILE, id: 'p_ask' }, { visibility: 'ask' });
  } catch (error) {
    asked = error;
  }
  assert.ok(asked, 'ask without an interactive channel must not guess');
  assert.equal(asked.code, 'USER_HANDOFF_REQUIRED');
  assert.equal(asked.outcome, 'WAITING_FOR_USER');
  assert.equal(asked.safeDetails.reason, 'visibility_choice_required');
  assert.equal(playwright.calls.length, 2, 'no browser is launched before the visibility choice');
  t.after(() => instance.closeAll());
});

test('missing Playwright reports BROWSER_DEPENDENCY_MISSING without installing anything', async () => {
  resetClock();
  const missing = new Error("Cannot find package 'playwright' imported from session.js");
  missing.code = 'ERR_MODULE_NOT_FOUND';
  const { instance } = manager({ loadPlaywright: async () => { throw missing; } });
  await assert.rejects(instance.open(PROFILE), (error) => {
    assert.equal(error.code, 'BROWSER_DEPENDENCY_MISSING');
    assert.equal(error.outcome, null);
    assert.ok(!JSON.stringify(error.safeDetails ?? {}).includes('Cannot find package'));
    return true;
  });
});

test('a missing browser binary is BROWSER_BINARY_MISSING and hides the raw executable path', async () => {
  resetClock();
  const launchError = new Error(
    "browserType.launchPersistentContext: Executable doesn't exist at C:\\Users\\secret\\AppData\\ms-playwright\\chrome.exe\n"
      + 'Please run the following command to download new browsers: npx playwright install',
  );
  const playwright = fakePlaywright({ launchError });
  const { instance, leases } = manager({ loadPlaywright: loader(playwright).load });
  await assert.rejects(instance.open(PROFILE), (error) => {
    assert.equal(error.code, 'BROWSER_BINARY_MISSING');
    assert.ok(!error.message.includes('ms-playwright'));
    assert.ok(!JSON.stringify(error.safeDetails ?? {}).includes('ms-playwright'));
    return true;
  });
  assert.equal(leases.held.size, 0, 'the lease is released when the launch fails');
});

test('a profile owned by another process is PROFILE_IN_USE', async () => {
  resetClock();
  const inUse = Object.assign(new Error('the protected lock is in use'), { code: 'PROFILE_IN_USE' });
  const playwright = fakePlaywright();
  const { instance } = manager({
    loadPlaywright: loader(playwright).load,
    leases: fakeLeases({ failWith: inUse }),
  });
  await assert.rejects(instance.open(PROFILE), (error) => error.code === 'PROFILE_IN_USE');
  assert.equal(playwright.calls.length, 0);
});

test('an anonymous live session is LOGIN_REQUIRED and is kept for a visible handoff', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const context = fakeContext({ request: sequenceRequest([jsonResponse({ kind: 'User', data: {} })]) });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open(PROFILE);
  await assert.rejects(instance.identity(PROFILE.id), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.outcome, 'WAITING_FOR_USER');
    assert.equal(error.safeDetails.profileId, PROFILE.id);
    assert.equal(error.safeDetails.visibility, 'visible');
    return true;
  });
  assert.equal(context.state.closes, 0, 'a handoff keeps the visible session usable');
  t.after(() => instance.closeAll());
});

test('plain login pages stay signed-out while security prompts are handoff, even on the login path', () => {
  const loginPage = htmlResponse('<html><form><input name="username"><input name="password"></form></html>', {
    url: 'https://www.reddit.com/login/',
  });
  assert.deepEqual(
    classifyIdentityResponse({
      status: loginPage.status(),
      contentType: 'text/html',
      url: loginPage.url(),
      body: '<html><form><input name="username"><input name="password"></form></html>',
    }),
    { state: 'anonymous', reason: 'login_redirect' },
  );
  assert.deepEqual(
    classifyIdentityResponse({
      status: 200,
      contentType: 'text/html',
      url: 'https://www.reddit.com/login/',
      body: '<html>Enter your two-factor authentication code</html>',
    }),
    { state: 'two_factor', reason: 'two_factor' },
  );
  assert.deepEqual(
    classifyIdentityResponse({
      status: 200,
      contentType: 'text/html',
      url: 'https://www.reddit.com/api/me.json',
      body: '<html><body>Something unfamiliar</body></html>',
    }),
    { state: 'challenge', reason: 'html_instead_of_json' },
  );
  assert.equal(normalizeIdentityPayload({ kind: 'User', data: { name: 'Alice_1', id: 'abc123' } }).accountId, 't2_abc123');
  assert.equal(normalizeIdentityPayload({ kind: 'User', data: { name: 'Alice_1', id: 'not valid!' } }), null);
});

test('a JSON 403 from the own-session endpoint is a signed-out session, not an account restriction', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const context = fakeContext({ request: sequenceRequest([jsonResponse({ message: 'Forbidden', error: 403 }, { status: 403 })]) });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open({ ...PROFILE, id: 'p_json_403' });
  await assert.rejects(instance.identity('p_json_403'), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.outcome, 'WAITING_FOR_USER');
    return true;
  });
  t.after(() => instance.closeAll());
});

test('a verified own-session identity is normalized, resolved without a registry write, and exposes no session data', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const context = fakeContext({
    request: sequenceRequest([
      jsonResponse(mePayload('Alice_1', 'abc123')),
      jsonResponse(mePayload('Alice_1', 'abc123')),
    ]),
  });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const accounts = fakeAccounts();
  const { instance } = manager({ loadPlaywright: loader(playwright).load, accounts });

  const session = await instance.open(PROFILE);
  const first = await instance.identity(PROFILE.id);
  const second = await instance.identity(PROFILE.id);

  assert.equal(first.verified, true);
  assert.equal(first.username, 'Alice_1');
  assert.equal(first.accountId, 't2_abc123');
  assert.match(first.accountKey, /^acct_[0-9a-f]{32}$/);
  assert.equal(first.source, 'api');
  assert.equal(second.accountKey, first.accountKey);
  assert.equal(first.accountKey, deriveAccountKey(usernameKey('Alice_1')));
  assert.equal(accounts.binds.length, 0, 'an identity probe resolves the account without writing the registry');
  assert.equal(session.account.accountKey, first.accountKey);
  assert.equal(session.state, 'open');
  const serialized = JSON.stringify(first);
  assert.ok(!/cookie|token|authorization|secret/i.test(serialized));
  assert.ok(!JSON.stringify(session).includes('secret'));
  t.after(() => instance.closeAll());
});

test('a different signed-in account blocks the session with IDENTITY_MISMATCH', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const context = fakeContext({ request: sequenceRequest([jsonResponse(mePayload('Mallory'))]) });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  const session = await instance.open({ ...PROFILE, expectedUsername: 'alice' });
  await assert.rejects(instance.identity(PROFILE.id), (error) => {
    assert.equal(error.code, 'IDENTITY_MISMATCH');
    assert.equal(error.outcome, null);
    assert.equal(error.safeDetails.expectedUsername, 'alice');
    return true;
  });
  assert.equal(session.state, 'blocked');
  await assert.rejects(instance.identity(PROFILE.id), (error) => error.code === 'IDENTITY_MISMATCH');
  await assert.rejects(
    instance.renew(PROFILE.id, { allowPasswordLogin: true }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  t.after(() => instance.closeAll());
});

test('challenge, 2FA, restriction and throttling become classified human handoff', async (t) => {
  resetClock();
  const cases = [
    { response: htmlResponse('<html><title>Verify you are human</title></html>'), reason: 'challenge' },
    { response: htmlResponse('<html>Enter your two-factor authentication code</html>'), reason: 'two_factor' },
    { response: htmlResponse('<html>This account has been suspended</html>', { status: 403 }), reason: 'account_restricted' },
    { response: jsonResponse({ error: 429 }, { status: 429 }), reason: 'throttled' },
  ];

  for (const [index, entry] of cases.entries()) {
    const playwright = fakePlaywright();
    const page = fakePage();
    const context = fakeContext({ request: sequenceRequest([entry.response]), page });
    playwright.module.chromium.launchPersistentContext = async () => context;
    const { instance } = manager({ loadPlaywright: loader(playwright).load });
    const profile = { ...PROFILE, id: `p_handoff_${index}` };
    await instance.open(profile);
    await assert.rejects(instance.identity(profile.id), (error) => {
      if (entry.reason === 'throttled') {
        assert.equal(error.code, 'THROTTLED');
        return true;
      }
      assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
      assert.equal(error.outcome, 'WAITING_FOR_USER');
      assert.equal(error.safeDetails.reason, entry.reason);
      return true;
    });
    assert.equal(page.actions.length, 0, 'no automatic interaction with a security page');
    await instance.closeAll();
  }
  t.after(() => {});
});

test('the 15-minute idle close runs only when no task is registered', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  const idle = await instance.open(PROFILE);
  const busy = await instance.open({ ...PROFILE, id: 'p_busy' });
  busy.tasks.add('task-1');

  advanceClock(14 * 60_000);
  await instance.open({ ...PROFILE, id: 'p_other' });
  assert.equal(idle.lease.released, false, 'still inside the idle window');

  advanceClock(2 * 60_000);
  await instance.open({ ...PROFILE, id: 'p_another' });
  assert.equal(idle.lease.released, true, 'idle session was closed');
  assert.equal(idle.context.state.closes, 1);
  assert.equal(busy.lease.released, false, 'an active task keeps the session alive');
  t.after(() => instance.closeAll());
});

test('close is a local cleanup that distinguishes remote logout', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const page = fakePage();
  const context = fakeContext({ request: sequenceRequest([jsonResponse(mePayload('alice'))]), page });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance, leases } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open(PROFILE);
  const result = await instance.close(PROFILE.id);
  assert.deepEqual(result, {
    closed: true,
    profileId: PROFILE.id,
    localOnly: true,
    remoteLogoutRequested: false,
    remoteLogoutFailed: false,
  });
  assert.equal(context.state.closes, 1);
  assert.equal(leases.held.size, 0);
  assert.equal(page.actions.length, 0);
  await assert.rejects(instance.identity(PROFILE.id), (error) => error.code === 'PROFILE_NOT_FOUND');

  // Closing a session that is already gone is a safe, non-throwing no-op.
  const again = await instance.close(PROFILE.id);
  assert.equal(again.closed, false);
  t.after(() => instance.closeAll());
});

test('remote logout is requested explicitly and reported separately from local cleanup', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const page = fakePage();
  const context = fakeContext({ request: sequenceRequest([jsonResponse(mePayload('alice'))]), page });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open(PROFILE);
  const result = await instance.close(PROFILE.id, { logout: true });
  assert.equal(result.localOnly, false);
  assert.equal(result.remoteLogoutRequested, true);
  assert.equal(result.remoteLogoutFailed, false);
  assert.deepEqual(page.actions.map((action) => action.url), ['https://www.reddit.com/logout']);
  t.after(() => instance.closeAll());
});

test('close refuses to kill a session while a task is active', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const { instance } = manager({ loadPlaywright: loader(playwright).load });
  const session = await instance.open(PROFILE);
  session.tasks.add('task-1');

  await assert.rejects(instance.close(PROFILE.id), (error) => error.code === 'PROFILE_IN_USE');
  assert.equal(session.lease.released, false);

  session.tasks.delete('task-1');
  const result = await instance.close(PROFILE.id);
  assert.equal(result.closed, true);
  t.after(() => instance.closeAll());
});

test('several profiles own independent sessions and leases, and closeAll releases both', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const { instance, leases } = manager({ loadPlaywright: loader(playwright).load });

  const one = await instance.open(PROFILE);
  const two = await instance.open({ ...PROFILE, id: 'p_two', alias: 'Two' });
  assert.equal(playwright.calls.length, 2);
  assert.equal(leases.held.size, 2);
  assert.notEqual(one.lease.path, two.lease.path);

  const results = await instance.closeAll();
  assert.deepEqual(results.map((entry) => entry.closed), [true, true]);
  assert.equal(leases.held.size, 0);
  assert.equal(playwright.contexts[0].state.closes, 1);
  assert.equal(playwright.contexts[1].state.closes, 1);
});

test('password login is never driven by an environment password', async (t) => {
  resetClock();
  const previous = process.env.REDDIT_PASSWORD;
  process.env.REDDIT_PASSWORD = 'legacy-environment-password';
  t.after(() => {
    if (previous === undefined) delete process.env.REDDIT_PASSWORD;
    else process.env.REDDIT_PASSWORD = previous;
  });

  const playwright = fakePlaywright();
  const page = fakePage();
  const context = fakeContext({ request: sequenceRequest([jsonResponse({ kind: 'User', data: {} })]), page });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });
  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.safeDetails.reason, 'stored_password_missing');
    return true;
  });
  assert.equal(page.actions.length, 0, 'the legacy environment password is never read or typed');
  t.after(() => instance.closeAll());
});

test('enrollment opens a visible session, observes the login, and never touches credential fields', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const page = fakePage();
  const context = fakeContext({
    request: sequenceRequest([
      jsonResponse({ kind: 'User', data: {} }),
      jsonResponse(mePayload('carol')),
    ]),
    page,
  });
  playwright.module.chromium.launchPersistentContext = async (dir, options) => {
    playwright.calls.push({ userDataDir: dir, options });
    return context;
  };
  const accounts = fakeAccounts();
  const { instance, protectCalls } = manager({ loadPlaywright: loader(playwright).load, accounts });

  const result = await instance.enroll({ ...PROFILE, id: 'p_enroll', expectedUsername: 'carol' });
  assert.equal(result.state, 'ready');
  assert.equal(result.visibility, 'visible');
  assert.equal(result.identity.username, 'carol');
  assert.equal(playwright.calls[0].options.headless, false, 'enrollment is visible by default');
  assert.equal(protectCalls.length, 1, 'protection is established at enrollment');
  assert.equal(accounts.binds.length, 1);
  assert.equal(page.actions.length, 0, 'enrollment never harvests a password field');
  assert.ok(!/cookie|token|secret/i.test(JSON.stringify(result)));

  await assert.rejects(
    instance.enroll({ ...PROFILE, id: 'p_enroll_headless' }, { visibility: 'headless' }),
    (error) => error.code === 'USER_HANDOFF_REQUIRED' && error.safeDetails.reason === 'enrollment_requires_visible',
  );
  t.after(() => instance.closeAll());
});

test('enrollment reports a mismatch instead of rebinding the expected account', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const context = fakeContext({ request: sequenceRequest([jsonResponse(mePayload('mallory'))]) });
  playwright.module.chromium.launchPersistentContext = async () => context;
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  await assert.rejects(
    instance.enroll({ ...PROFILE, id: 'p_enroll_mismatch', expectedUsername: 'carol' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  t.after(() => instance.closeAll());
});

test('enrollment never completes inside an already-open headless session', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const page = fakePage();
  const context = fakeContext({
    request: sequenceRequest([jsonResponse(mePayload('carol'))]),
    page,
  });
  playwright.module.chromium.launchPersistentContext = async (dir, options) => {
    playwright.calls.push({ userDataDir: dir, options });
    return options.headless ? fakeContext({ request: sequenceRequest([jsonResponse(mePayload('carol'))]), page: fakePage() }) : context;
  };
  const { instance } = manager({ loadPlaywright: loader(playwright).load });

  const openSession = await instance.open({ ...PROFILE, id: 'p_enroll_headless_open' }, { visibility: 'headless' });
  assert.equal(openSession.visibility, 'headless');
  assert.equal(playwright.calls[0].options.headless, true);

  const result = await instance.enroll({ ...PROFILE, id: 'p_enroll_headless_open', expectedUsername: 'carol' });
  assert.equal(result.state, 'ready');
  assert.equal(result.visibility, 'visible', 'enrollment reports a visible session');
  assert.equal(playwright.calls.length, 2, 'the headless session is replaced by a visible one');
  assert.equal(playwright.calls[1].options.headless, false, 'manual login must be observable');
  t.after(() => instance.closeAll());
});

test('a protected-root failure becomes a canonical BACKEND_UNAVAILABLE without raw details', async () => {
  resetClock();
  const playwright = fakePlaywright();
  const protection = Object.assign(new Error('Protected storage cannot live on a UNC path'), { code: 'UNSAFE_LOCATION' });
  const { instance } = manager({
    loadPlaywright: loader(playwright).load,
    protect: async () => { throw protection; },
  });
  await assert.rejects(instance.open(PROFILE), (error) => {
    assert.equal(error.name, 'OperationError');
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.equal(error.safeDetails.reason, 'protection_failed');
    assert.ok(!JSON.stringify(error).includes('UNC'));
    return true;
  });
  assert.equal(playwright.calls.length, 0, 'no browser launches when the profile root is unsafe');
});

test('a Playwright install that fails to load is BACKEND_UNAVAILABLE, not a missing dependency', async () => {
  resetClock();
  const broken = new SyntaxError('Unexpected token in installed package');
  const { instance } = manager({ loadPlaywright: async () => { throw broken; } });
  await assert.rejects(instance.open(PROFILE), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.equal(error.safeDetails.reason, 'dependency_load_failed');
    assert.ok(!JSON.stringify(error).includes('Unexpected token'));
    return true;
  });
});

test('close refuses a profile owned by another live process even when this process has no session', async () => {
  const leases = Object.assign(fakeLeases(), {
    async inspect() {
      return { held: true, live: true, pid: 9001, kind: 'browser', owner: 'other-process', nonce: 'n1' };
    },
  });
  const { instance } = manager({ leases });
  await assert.rejects(
    instance.close(PROFILE.id),
    (error) => error.code === 'PROFILE_IN_USE' && error.safeDetails?.reason === 'other_process',
  );
});

test('close proceeds when the other-process lease is stale', async () => {
  const leases = Object.assign(fakeLeases(), {
    async inspect() {
      return { held: true, live: false, stale: true, pid: 9001, nonce: 'n1' };
    },
  });
  const { instance } = manager({ leases });
  const result = await instance.close(PROFILE.id);
  assert.equal(result.closed, false);
});
