import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBrowserSessionManager } from '../src/browser/session.js';
import { createProfileSecretStore } from '../src/secrets.js';
import { deriveAccountKey, usernameKey } from '../src/accounts.js';

const HOME = join(tmpdir(), 'reddit-cli-browser-recovery-tests');
const PROFILE = Object.freeze({
  kind: 'profile',
  id: 'p_recover',
  alias: 'Recover',
  expectedUsername: null,
  accountKey: null,
  accountId: null,
  username: null,
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

const mePayload = (name, id = null) => ({ kind: 'User', data: id === null ? { name } : { name, id } });
const anonymous = () => jsonResponse({ kind: 'User', data: {} });

function scriptedRequest({ after = [] } = {}) {
  const state = { phase: 'before', after: [...after], calls: [] };
  return {
    state,
    calls: state.calls,
    async get(url, options) {
      state.calls.push({ url, options });
      if (state.phase === 'before') return anonymous();
      if (state.after.length === 0) return anonymous();
      const next = state.after.length > 1 ? state.after.shift() : state.after[0];
      if (typeof next === 'function') return next();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function fakePage(onClick = null, { urlAfterGoto = null, redirectTo = null } = {}) {
  const actions = [];
  let currentUrl = 'https://www.reddit.com/login/';
  const page = {
    actions,
    onClick,
    async goto(url, options) {
      actions.push({ kind: 'goto', url, options });
      currentUrl = redirectTo ?? urlAfterGoto ?? url;
    },
    url() { return currentUrl; },
    locator(selector) {
      const fillable = new Set(['input[name="username"]', 'input[name="password"]']);
      const clickable = new Set(['button[type="submit"]']);
      const locator = {
        async count() { return fillable.has(selector) || clickable.has(selector) ? 1 : 0; },
        first() { return locator; },
        async fill(value, options) { actions.push({ kind: 'fill', selector, value, options }); },
        async click(options) {
          actions.push({ kind: 'click', selector, options });
          if (page.onClick) await page.onClick();
        },
      };
      return locator;
    },
  };
  return page;
}

function fakeContext({ request, page }) {
  const state = { closes: 0 };
  return {
    state,
    request,
    pages: () => [page],
    async newPage() { return page; },
    async close() { state.closes += 1; },
  };
}

function fakePlaywright() {
  const calls = [];
  const contexts = [];
  return {
    calls,
    contexts,
    module: {
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          calls.push({ userDataDir, options });
          const context = fakeContext({
            request: options.__request ?? scriptedRequest(),
            page: options.__page ?? fakePage(),
          });
          contexts.push(context);
          return context;
        },
      },
    },
  };
}

function fakeLeases() {
  const log = [];
  let counter = 0;
  return {
    log,
    async acquire(path, options = {}) {
      log.push({ kind: 'acquire', path });
      const lease = {
        path,
        nonce: `nonce-${++counter}`,
        kind: options.kind,
        owner: options.owner,
        released: false,
        async assertHeld() { return true; },
        async heartbeat() { return 1; },
        async release() { lease.released = true; log.push({ kind: 'release', path }); return true; },
      };
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

function fakeAccounts() {
  const binds = [];
  return {
    binds,
    async bind(input) {
      binds.push(input);
      return {
        accountKey: deriveAccountKey(usernameKey(input.username)),
        accountId: input.accountId ?? null,
        username: input.username,
      };
    },
    async lookup() { return null; },
    async list() { return []; },
  };
}

let clockValue = 1_700_000_000_000;
function resetClock() { clockValue = 1_700_000_000_000; }
function clock() { return clockValue; }
function advance(ms) { clockValue += ms; }

function manager({ request, page, keyring = fakeKeyring(), accounts = fakeAccounts(), settings = {}, registry = null } = {}) {
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  const playwright = fakePlaywright();
  // Older tests may inject the fake context through a one-shot launcher override.
  if (request || page) {
    playwright.module.chromium.launchPersistentContext = async (dir, options) => {
      playwright.calls.push({ userDataDir: dir, options });
      const context = fakeContext({ request: request ?? scriptedRequest(), page: page ?? fakePage() });
      playwright.contexts.push(context);
      return context;
    };
  }
  const instance = createBrowserSessionManager({
    registry,
    accounts,
    secretStore,
    leases: fakeLeases(),
    loadPlaywright: async () => playwright.module,
    clock,
    settings: { homeDir: HOME, ...settings },
    protect: async () => {},
    sleep: async (ms) => { advance(ms); },
    interactive: false,
  });
  return { instance, playwright, secretStore, keyring, accounts };
}

function loginActions(page) {
  return page.actions.filter((action) => action.kind === 'fill' || action.kind === 'click');
}

// --- tests -------------------------------------------------------------------------------------

test('renew verifies the live session cookies before it would try a password', async (t) => {
  resetClock();
  const page = fakePage();
  const request = scriptedRequest({ after: [jsonResponse(mePayload('alice'))] });
  const { instance } = manager({ request, page });

  const session = await instance.open({ ...PROFILE, id: 'p_live' });
  // open() never reads identity, so this read is the first; the live profile's cookies authenticate
  // it, and renew must report the live session instead of attempting a password login.
  request.state.phase = 'after';
  const result = await instance.renew('p_live', { allowPasswordLogin: true });
  assert.equal(result.state, 'active');
  assert.equal(result.source, 'live_session');
  assert.equal(result.identity.username, 'alice');
  assert.equal(loginActions(page).length, 0);
  assert.equal(session.context.state.closes, 0);
  await instance.closeAll();
});

test('optional password login uses the stored profile secret exactly once and verifies identity', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'local-only-password');

  const page = fakePage();
  const request = scriptedRequest({
    after: [jsonResponse({ kind: 'User', data: {} }), jsonResponse(mePayload('alice', 'abc'))],
  });
  page.onClick = async () => { request.state.phase = 'after'; };

  const { instance } = manager({ request, page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });
  const result = await instance.renew(PROFILE.id, { allowPasswordLogin: true });

  assert.equal(result.state, 'renewed');
  assert.equal(result.source, 'password_login');
  assert.equal(result.identity.username, 'alice');
  const fills = page.actions.filter((action) => action.kind === 'fill');
  assert.equal(fills.length, 2, 'username and password are filled once each');
  assert.equal(fills.filter((action) => action.selector === 'input[name="password"]').length, 1);
  assert.equal(page.actions.filter((action) => action.kind === 'click').length, 1);
  assert.ok(page.actions.some((action) => action.kind === 'goto'
    && action.url === 'https://www.reddit.com/login/'));
  assert.ok(!JSON.stringify(result).includes('local-only-password'));
  await instance.closeAll();
  t.after(() => {});
});

test('a profile without stored-password opt-in never attempts password login', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'stored-but-disabled');

  const page = fakePage();
  const request = scriptedRequest();
  const { instance } = manager({ request, page, keyring });
  await instance.open(PROFILE);

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.outcome, 'WAITING_FOR_USER');
    assert.equal(error.safeDetails.reason, 'password_login_disabled');
    return true;
  });
  assert.equal(loginActions(page).length, 0);
  await instance.closeAll();
});

test('renew without allowPasswordLogin is a human handoff, never an automatic login', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'stored');
  const page = fakePage();
  const { instance } = manager({ request: scriptedRequest(), page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.safeDetails.reason, 'login_required');
    return true;
  });
  assert.equal(loginActions(page).length, 0);
  await instance.closeAll();
});

test('only one bounded password attempt is made before human handoff', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'wrong-password');

  const page = fakePage();
  const request = scriptedRequest();
  const { instance } = manager({ request, page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
    assert.equal(error.outcome, 'WAITING_FOR_USER');
    assert.equal(error.safeDetails.reason, 'login_not_accepted');
    return true;
  });
  assert.equal(page.actions.filter((action) => action.kind === 'click').length, 1);

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
    assert.equal(error.safeDetails.reason, 'password_login_already_attempted');
    return true;
  });
  assert.equal(page.actions.filter((action) => action.kind === 'click').length, 1, 'no resubmission');
  await instance.closeAll();
});

test('a challenge after the password submission stops recovery without resubmitting', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'password');

  const page = fakePage();
  const request = scriptedRequest({
    after: [htmlResponse('<html>Enter your two-factor authentication code</html>')],
  });
  page.onClick = async () => { request.state.phase = 'after'; };
  const { instance } = manager({ request, page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
    assert.equal(error.safeDetails.reason, 'two_factor');
    return true;
  });
  assert.equal(page.actions.filter((action) => action.kind === 'click').length, 1);
  await instance.closeAll();
});

test('CAPTCHA, 2FA, restriction and throttling stop recovery before any password attempt', async (t) => {
  resetClock();
  const cases = [
    { response: htmlResponse('<html>Please complete the CAPTCHA</html>'), code: 'USER_HANDOFF_REQUIRED', reason: 'challenge' },
    { response: htmlResponse('<html>Two-factor authentication required</html>'), code: 'USER_HANDOFF_REQUIRED', reason: 'two_factor' },
    { response: htmlResponse('<html>Account locked</html>', { status: 403 }), code: 'USER_HANDOFF_REQUIRED', reason: 'account_restricted' },
    { response: jsonResponse({ error: 429 }, { status: 429 }), code: 'THROTTLED', reason: null },
  ];

  for (const [index, entry] of cases.entries()) {
    const keyring = fakeKeyring();
    const secretStore = createProfileSecretStore({ keyring: keyring.factory });
    const profileId = `p_stop_${index}`;
    await secretStore.set(secretStore.ref(profileId, 'password'), 'password');
    const page = fakePage();
    const request = scriptedRequest();
    // The very first identity check inside renew sees the blocking page.
    request.state.phase = 'after';
    request.state.after = [entry.response];
    const { instance } = manager({ request, page, keyring });
    await instance.open({ ...PROFILE, id: profileId, passwordLoginEnabled: true });

    await assert.rejects(instance.renew(profileId, { allowPasswordLogin: true }), (error) => {
      assert.equal(error.code, entry.code);
      if (entry.reason) assert.equal(error.safeDetails.reason, entry.reason);
      return true;
    });
    assert.equal(loginActions(page).length, 0, 'no automatic solve or reroute');
    await instance.closeAll();
  }
  t.after(() => {});
});

test('a recovered session with a different account is rejected as IDENTITY_MISMATCH', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'password');

  const page = fakePage();
  const request = scriptedRequest({ after: [jsonResponse(mePayload('mallory'))] });
  page.onClick = async () => { request.state.phase = 'after'; };
  const { instance } = manager({ request, page, keyring });
  const session = await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'IDENTITY_MISMATCH');
    return true;
  });
  assert.equal(session.state, 'blocked');
  await instance.closeAll();
});

test('identity checks within one profile are serialized', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  let inFlight = 0;
  let maxInFlight = 0;
  const request = {
    async get() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse(mePayload('alice'));
    },
  };
  playwright.module.chromium.launchPersistentContext = async (dir, options) => {
    playwright.calls.push({ userDataDir: dir, options });
    const context = fakeContext({ request, page: fakePage() });
    playwright.contexts.push(context);
    return context;
  };
  const instance = createBrowserSessionManager({
    registry: null,
    accounts: fakeAccounts(),
    secretStore: createProfileSecretStore({ keyring: fakeKeyring().factory }),
    leases: fakeLeases(),
    loadPlaywright: async () => playwright.module,
    clock,
    settings: { homeDir: HOME },
    protect: async () => {},
    sleep: async (ms) => { advance(ms); },
    interactive: false,
  });

  await instance.open(PROFILE);
  await Promise.all([
    instance.identity(PROFILE.id),
    instance.identity(PROFILE.id),
    instance.identity(PROFILE.id),
  ]);
  assert.equal(maxInFlight, 1, 'profile operations run one at a time');
  assert.equal(playwright.calls.length, 1);
  await instance.closeAll();
});

test('an unavailable identity check is a safe BACKEND_UNAVAILABLE without raw details', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  const request = {
    async get() {
      throw new Error('ECONNRESET while contacting internal host session-detail');
    },
  };
  playwright.module.chromium.launchPersistentContext = async (dir, options) => {
    playwright.calls.push({ userDataDir: dir, options });
    const context = fakeContext({ request, page: fakePage() });
    playwright.contexts.push(context);
    return context;
  };
  const instance = createBrowserSessionManager({
    registry: null,
    accounts: fakeAccounts(),
    secretStore: createProfileSecretStore({ keyring: fakeKeyring().factory }),
    leases: fakeLeases(),
    loadPlaywright: async () => playwright.module,
    clock,
    settings: { homeDir: HOME },
    protect: async () => {},
    sleep: async (ms) => { advance(ms); },
    interactive: false,
  });

  await instance.open(PROFILE);
  await assert.rejects(instance.identity(PROFILE.id), (error) => {
    assert.equal(error.code, 'BACKEND_UNAVAILABLE');
    assert.ok(!error.message.includes('ECONNRESET'));
    assert.ok(!JSON.stringify(error.safeDetails ?? {}).includes('session-detail'));
    return true;
  });
  await instance.closeAll();
});

test('renew and identity on a closed session report the session is not open', async (t) => {
  resetClock();
  const { instance } = manager({ request: scriptedRequest(), page: fakePage() });
  await instance.open(PROFILE);
  await instance.close(PROFILE.id);

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'PROFILE_NOT_FOUND');
    assert.equal(error.safeDetails.sessionOpen, false);
    return true;
  });
  await assert.rejects(instance.identity(PROFILE.id), (error) => error.code === 'PROFILE_NOT_FOUND');
  await instance.closeAll();
  t.after(() => {});
});

test('password login refuses an off-origin redirect before typing the stored password', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'must-not-leak');

  const page = fakePage(null, { redirectTo: 'https://evil.example/login/' });
  const request = scriptedRequest();
  const { instance } = manager({ request, page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'USER_HANDOFF_REQUIRED');
    assert.equal(error.outcome, 'WAITING_FOR_USER');
    assert.equal(error.safeDetails.reason, 'login_form_unrecognized');
    assert.ok(!JSON.stringify(error).includes('must-not-leak'));
    return true;
  });
  assert.equal(loginActions(page).length, 0, 'no credential enters an off-origin page');
  await instance.closeAll();
});

test('password login refuses a non-HTTPS destination before typing the stored password', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'must-not-leak');

  const page = fakePage(null, { redirectTo: 'http://www.reddit.com/login/' });
  const { instance } = manager({ request: scriptedRequest(), page, keyring });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(
    instance.renew(PROFILE.id, { allowPasswordLogin: true }),
    (error) => error.code === 'USER_HANDOFF_REQUIRED' && error.safeDetails.reason === 'login_form_unrecognized',
  );
  assert.equal(loginActions(page).length, 0);
  await instance.closeAll();
});

test('renew re-reads the live profile before a stored-password attempt', async (t) => {
  resetClock();
  const keyring = fakeKeyring();
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  await secretStore.set(secretStore.ref(PROFILE.id, 'password'), 'password-after-revocation');

  const page = fakePage();
  const live = { calls: 0, async snapshot(id) { live.calls += 1; return { ...PROFILE, id, passwordLoginEnabled: false }; } };
  const { instance } = manager({ request: scriptedRequest(), page, keyring, registry: live });
  await instance.open({ ...PROFILE, expectedUsername: 'alice', passwordLoginEnabled: true });

  await assert.rejects(instance.renew(PROFILE.id, { allowPasswordLogin: true }), (error) => {
    assert.equal(error.code, 'LOGIN_REQUIRED');
    assert.equal(error.safeDetails.reason, 'password_login_disabled');
    return true;
  });
  assert.equal(live.calls, 1, 'the opt-in is revalidated against the live registry');
  assert.equal(loginActions(page).length, 0);
  await instance.closeAll();
});

test('an identity check queued behind close reports the session is gone', async (t) => {
  resetClock();
  const playwright = fakePlaywright();
  let releaseRead;
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const request = {
    async get() {
      readStarted();
      await gate;
      return jsonResponse(mePayload('alice'));
    },
  };
  playwright.module.chromium.launchPersistentContext = async (dir, options) => {
    playwright.calls.push({ userDataDir: dir, options });
    const context = fakeContext({ request, page: fakePage() });
    playwright.contexts.push(context);
    return context;
  };
  const instance = createBrowserSessionManager({
    registry: null,
    accounts: fakeAccounts(),
    secretStore: createProfileSecretStore({ keyring: fakeKeyring().factory }),
    leases: fakeLeases(),
    loadPlaywright: async () => playwright.module,
    clock,
    settings: { homeDir: HOME },
    protect: async () => {},
    sleep: async (ms) => { advance(ms); },
    interactive: false,
  });

  await instance.open(PROFILE);
  const slow = instance.identity(PROFILE.id);
  await started;
  const closing = instance.close(PROFILE.id);
  const queued = instance.identity(PROFILE.id);
  releaseRead();

  assert.equal((await slow).username, 'alice');
  assert.equal((await closing).closed, true);
  await assert.rejects(queued, (error) => {
    assert.equal(error.code, 'PROFILE_NOT_FOUND');
    assert.equal(error.safeDetails.sessionOpen, false);
    return true;
  });
  await instance.closeAll();
  t.after(() => {});
});
