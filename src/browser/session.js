// Dedicated Playwright profile sessions: single ownership, verified identity, bounded recovery.
//
// One browser context is launched per named profile from that profile's own persistent directory
// (`<home>/profiles/<opaque-id>/browser`) and is owned by this process through an exclusive local
// lease until close, logout, shutdown, or a 15-minute idle period with no registered task. Profiles
// are independent, so different profiles may be open at the same time while operations on one
// profile are serialized. The internal session object (context, request context, account, credential
// generation) is deliberately not a tool result: callers must not serialize it.
//
// Integration: work in progress must be registered in the returned session's `tasks` Set (or through
// the manager's injected `tasks` tracker) for its lifetime. Idle close and `close()` never tear down
// a profile with a registered task; explicit `closeAll()` is the shutdown path.
//
// Playwright is an optional peer, loaded with a dynamic import only when a session is opened. This
// module never installs a package or browser, never attaches to a remote-debugging endpoint, and
// never uses stealth/impersonation launch flags. Password login is an explicit, per-profile,
// OS-store opt-in with one bounded attempt; the process-wide legacy environment password is never
// read here. Challenge, 2FA, restriction and throttling pages always become human handoff.

import { isAbsolute, join } from 'node:path';

import { createAccountRegistry, deriveAccountKey } from '../accounts.js';
import { OperationError } from '../errors.js';
import { acquireLease, inspectLease } from '../locks.js';
import { ensureProtectedRoot } from '../secure-fs.js';
import { usernameKey } from '../profiles.js';
import {
  DEFAULT_IDENTITY_TIMEOUT_MS,
  readSessionIdentity,
} from './identity.js';

export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_IDLE_CHECK_INTERVAL_MS = 60 * 1000;
export const DEFAULT_ENROLLMENT_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_CREDENTIALS_TIMEOUT_MS = 20 * 1000;
export const LOGIN_URL = 'https://www.reddit.com/login/';
export const LOGOUT_URL = 'https://www.reddit.com/logout';
export const VISIBILITIES = Object.freeze(['visible', 'headless', 'ask']);
export const PASSWORD_SECRET_NAME = 'password';

const VISIBILITY_SET = new Set(VISIBILITIES);
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LOGIN_HOST = 'www.reddit.com';
const LOGIN_PATH_PREFIX = '/login';

function invalid(message) {
  return new TypeError(message);
}

function sessionNotFound(profileId) {
  return new OperationError(
    'PROFILE_NOT_FOUND',
    'No browser session is open for this profile in this process.',
    { safeDetails: { profileId, sessionOpen: false } },
  );
}

function loginRequired(profileId, reason, { visibility = 'visible' } = {}) {
  return new OperationError(
    'LOGIN_REQUIRED',
    'This browser profile is not signed in to Reddit. Open it visible and sign in as the expected account; nothing was submitted automatically.',
    {
      outcome: 'WAITING_FOR_USER',
      safeDetails: { profileId, reason, visibility, visibleRequired: visibility !== 'visible' },
    },
  );
}

function handoffRequired(profileId, reason, { visibility = 'visible' } = {}) {
  return new OperationError(
    'USER_HANDOFF_REQUIRED',
    'Reddit is asking for a person to finish signing in or verify this account. Use the visible browser window to complete it; no automatic solve, retry, or alternate route was attempted.',
    {
      outcome: 'WAITING_FOR_USER',
      safeDetails: {
        profileId,
        reason,
        visibility,
        visibleRequired: visibility !== 'visible' || reason === 'challenge' || reason === 'two_factor',
      },
    },
  );
}

function throttled(profileId) {
  return new OperationError(
    'THROTTLED',
    'Reddit rate-limited the browser session check. Wait before retrying; the operation was not rerouted through another backend.',
    { safeDetails: { profileId } },
  );
}

function unavailable(profileId, reason) {
  return new OperationError(
    'BACKEND_UNAVAILABLE',
    'The browser session could not be checked safely right now.',
    { safeDetails: { profileId, reason } },
  );
}

function dependencyMissing(profileId) {
  return new OperationError(
    'BROWSER_DEPENDENCY_MISSING',
    'Playwright is not installed. Browser backends are optional and nothing was downloaded automatically.',
    {
      safeDetails: {
        profileId,
        next: 'Run the explicit local browser setup (browser doctor, then browser setup) and retry. API, RSS, and offline operations do not need Playwright.',
      },
    },
  );
}

function binaryMissing(profileId) {
  return new OperationError(
    'BROWSER_BINARY_MISSING',
    'Playwright is installed, but its browser binary is missing or unusable. Nothing was downloaded automatically.',
    {
      safeDetails: {
        profileId,
        next: 'Run the explicit local browser setup to install the Chromium browser, then retry.',
      },
    },
  );
}

function launchUnavailable(profileId) {
  return new OperationError(
    'BACKEND_UNAVAILABLE',
    'The dedicated browser profile could not be started. No credential was read and no alternate browser was opened.',
    { safeDetails: { profileId, reason: 'launch_failed' } },
  );
}

function isModuleNotFound(error) {
  const code = error?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  return /cannot find (?:package|module)/i.test(String(error?.message ?? ''));
}

// Browsers that are absent produce long Playwright installation instructions. Match only the
// recognizable cause and replace the message so a local path or internal stack never leaves here.
function launchErrorCode(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toLowerCase();
  if (/executable (?:doesn't|does not) exist|browser(?:s)? (?:is|are)? ?not installed|playwright install|enoent.*(?:chrome|chromium|headless_shell)/.test(text)) {
    return 'BROWSER_BINARY_MISSING';
  }
  return 'BACKEND_UNAVAILABLE';
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw invalid('open/enroll needs a resolved profile snapshot object.');
  }
  if (typeof snapshot.id !== 'string' || !PROFILE_ID_PATTERN.test(snapshot.id)) {
    throw invalid('A profile snapshot needs an opaque id of 1-128 letters, digits, _ or -.');
  }
  return snapshot;
}

function assertProfileId(profileId) {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw invalid('A profile id must be 1-128 letters, digits, _ or -.');
  }
  return profileId;
}

function resolveVisibility(requested, interactive) {
  const value = requested ?? 'visible';
  if (!VISIBILITY_SET.has(value)) throw invalid('visibility must be visible, headless, or ask.');
  if (value === 'ask') {
    if (interactive === true) return 'visible';
    throw new OperationError(
      'USER_HANDOFF_REQUIRED',
      'Browser visibility is set to ask, and this channel cannot ask interactively. Choose visible or headless explicitly.',
      {
        outcome: 'WAITING_FOR_USER',
        safeDetails: { reason: 'visibility_choice_required', choices: ['visible', 'headless'] },
      },
    );
  }
  return value;
}

function expectedUsernameOf(snapshot) {
  if (typeof snapshot.expectedUsername === 'string' && snapshot.expectedUsername) return snapshot.expectedUsername;
  if (typeof snapshot.username === 'string' && snapshot.username) return snapshot.username;
  return null;
}

function touch(session) {
  session.lastUsedAt = session.clock();
}

function identityRecord(session, status) {
  return Object.freeze({
    profileId: session.id,
    verified: true,
    username: session.account.username,
    accountId: session.account.accountId ?? null,
    accountKey: session.account.accountKey,
    source: status.source,
    checkedAt: status.checkedAt ?? session.clock(),
    visibility: session.visibility,
  });
}

function mismatchError(session) {
  return new OperationError(
    'IDENTITY_MISMATCH',
    "The signed-in Reddit account does not match this profile's expected account. Authenticated operations are blocked until explicit re-enrollment.",
    {
      safeDetails: {
        profileId: session.id,
        expectedUsername: expectedUsernameOf(session.snapshot),
      },
    },
  );
}

function markBlocked(session) {
  session.state = 'blocked';
  session.blockedReason = 'identity_mismatch';
  return mismatchError(session);
}

function assertNotBlocked(session) {
  if (session.state === 'blocked') throw mismatchError(session);
}

function classifyBlockingStatus(session, status) {
  const visibility = session.visibility;
  switch (status.state) {
    case 'anonymous':
      session.state = 'needs_login';
      return loginRequired(session.id, 'login_required', { visibility });
    case 'challenge':
      session.state = 'handoff';
      return handoffRequired(session.id, 'challenge', { visibility });
    case 'two_factor':
      session.state = 'handoff';
      return handoffRequired(session.id, 'two_factor', { visibility });
    case 'restricted':
      session.state = 'handoff';
      return handoffRequired(session.id, 'account_restricted', { visibility });
    case 'throttled':
      return throttled(session.id);
    default:
      return unavailable(session.id, status.reason ?? 'identity_unavailable');
  }
}

async function firstLocator(page, selectors) {
  if (!page || typeof page.locator !== 'function') return null;
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      if (!locator) continue;
      if (typeof locator.count === 'function') {
        const count = await locator.count();
        if (count > 0) return typeof locator.first === 'function' ? locator.first() : locator;
        continue;
      }
      return locator;
    } catch {
      // An unknown selector on an unfamiliar page is not an error; try the next known one.
    }
  }
  return null;
}

// The stored password may only enter Reddit's own HTTPS login page. A navigation that is
// redirected elsewhere (or downgraded to HTTP) is rejected before any field is filled.
function isRedditLoginDestination(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== LOGIN_HOST) return false;
  if (url.port !== '') return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.pathname === LOGIN_PATH_PREFIX || url.pathname.startsWith(`${LOGIN_PATH_PREFIX}/`);
}

// Reddit's login form is addressed only through known field names. No other element is inspected,
// no page content is read, and the password is never returned or attached to an error.
async function performPasswordLogin(session, { username, password, timeoutMs }) {
  const page = await currentPage(session);
  if (!page || typeof page.locator !== 'function') {
    return { ok: false, reason: 'login_form_unrecognized' };
  }
  let navigationFailed = false;
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    navigationFailed = true;
  }
  if (navigationFailed) return { ok: false, reason: 'login_navigation_failed' };

  // Playwright follows redirects. Validate the final destination before the secret is typed.
  const finalUrl = typeof page.url === 'function' ? page.url() : '';
  if (!isRedditLoginDestination(finalUrl)) return { ok: false, reason: 'login_form_unrecognized' };

  const userField = await firstLocator(page, ['input[name="username"]', '#login-username']);
  if (!userField || typeof userField.fill !== 'function') return { ok: false, reason: 'login_form_unrecognized' };
  const passwordField = await firstLocator(page, ['input[name="password"]', '#login-password']);
  if (!passwordField || typeof passwordField.fill !== 'function') return { ok: false, reason: 'login_form_unrecognized' };
  const submit = await firstLocator(page, ['button[type="submit"]', '#login-submit']);
  if (!submit || typeof submit.click !== 'function') return { ok: false, reason: 'login_form_unrecognized' };

  try {
    await userField.fill(username, { timeout: timeoutMs });
    await passwordField.fill(password, { timeout: timeoutMs });
    await submit.click({ timeout: timeoutMs });
  } catch {
    return { ok: false, reason: 'login_form_unrecognized' };
  }
  return { ok: true };
}

async function currentPage(session) {
  try {
    const pages = typeof session.context?.pages === 'function' ? session.context.pages() : [];
    if (Array.isArray(pages) && pages.length > 0) return pages[0];
    if (typeof session.context?.newPage === 'function') return await session.context.newPage();
  } catch {
    return null;
  }
  return null;
}

export function createBrowserSessionManager({
  registry = null,
  accounts = null,
  secretStore = null,
  leases,
  loadPlaywright,
  clock = () => Date.now(),
  settings = {},
  protect = ensureProtectedRoot,
  sleep = DEFAULT_SLEEP,
  interactive = null,
  uiIdentity = null,
  tasks = null,
} = {}) {
  if (typeof clock !== 'function') throw invalid('clock must be a function.');
  if (typeof settings !== 'object' || settings === null) throw invalid('settings must be an object.');
  if (typeof settings.homeDir !== 'string' || !isAbsolute(settings.homeDir)) {
    throw invalid('settings.homeDir must be an absolute path.');
  }
  if (typeof sleep !== 'function') throw invalid('sleep must be a function.');
  if (protect !== null && typeof protect !== 'function') throw invalid('protect must be a function or null.');
  if (loadPlaywright !== undefined && typeof loadPlaywright !== 'function') throw invalid('loadPlaywright must be a function.');
  if (uiIdentity !== null && typeof uiIdentity !== 'function') throw invalid('uiIdentity must be a function or null.');
  if (secretStore !== null && (typeof secretStore?.ref !== 'function' || typeof secretStore?.get !== 'function')) {
    throw invalid('secretStore must expose ref() and get().');
  }

  const leaseApi = leases ?? { acquire: acquireLease };
  const acquire = typeof leaseApi.acquire === 'function'
    ? leaseApi.acquire.bind(leaseApi)
    : (typeof leaseApi.acquireLease === 'function' ? leaseApi.acquireLease.bind(leaseApi) : null);
  if (!acquire) throw invalid('leases must expose acquire() or acquireLease().');
  const inspect = typeof leaseApi.inspect === 'function'
    ? leaseApi.inspect.bind(leaseApi)
    : inspectLease;

  const accountRegistry = accounts ?? (registry ? createAccountRegistry({ registry }) : null);
  const loader = loadPlaywright ?? (() => import('playwright'));
  const browserSettings = settings.browser && typeof settings.browser === 'object' ? settings.browser : {};
  const idleTimeoutMs = Number.isFinite(browserSettings.idleTimeoutMs) && browserSettings.idleTimeoutMs > 0
    ? browserSettings.idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  const idleCheckIntervalMs = Number.isFinite(browserSettings.idleCheckIntervalMs) && browserSettings.idleCheckIntervalMs > 0
    ? browserSettings.idleCheckIntervalMs
    : Math.min(idleTimeoutMs, DEFAULT_IDLE_CHECK_INTERVAL_MS);
  const identityTimeoutMs = Number.isFinite(browserSettings.identityTimeoutMs) && browserSettings.identityTimeoutMs > 0
    ? browserSettings.identityTimeoutMs
    : DEFAULT_IDENTITY_TIMEOUT_MS;
  const navigationTimeoutMs = Number.isFinite(browserSettings.navigationTimeoutMs) && browserSettings.navigationTimeoutMs > 0
    ? browserSettings.navigationTimeoutMs
    : 30_000;
  const enrollmentTimeoutMs = Number.isFinite(browserSettings.enrollmentTimeoutMs) && browserSettings.enrollmentTimeoutMs > 0
    ? browserSettings.enrollmentTimeoutMs
    : DEFAULT_ENROLLMENT_TIMEOUT_MS;
  const credentialsTimeoutMs = Number.isFinite(browserSettings.credentialsTimeoutMs) && browserSettings.credentialsTimeoutMs > 0
    ? browserSettings.credentialsTimeoutMs
    : DEFAULT_CREDENTIALS_TIMEOUT_MS;
  const lockTimeoutMs = Number.isFinite(browserSettings.lockTimeoutMs) && browserSettings.lockTimeoutMs >= 0
    ? browserSettings.lockTimeoutMs
    : 0;
  const channel = typeof browserSettings.channel === 'string' && browserSettings.channel
    ? browserSettings.channel
    : 'chromium';
  const resolveInteractive = () => {
    if (interactive !== null) return interactive === true;
    if (typeof browserSettings.interactive === 'boolean') return browserSettings.interactive;
    return false;
  };

  // `sessions` holds live sessions by profile id; `queues` serializes operations per profile.
  const sessions = new Map();
  const queues = new Map();
  let timer = null;

  function enqueue(profileId, task) {
    const prior = queues.get(profileId) || Promise.resolve();
    const run = prior.then(task, task);
    const settled = run.then(() => undefined, () => undefined);
    queues.set(profileId, settled);
    settled.then(() => {
      if (queues.get(profileId) === settled) queues.delete(profileId);
    });
    return run;
  }

  function profileDir(profileId) {
    return join(settings.homeDir, 'profiles', profileId, 'browser');
  }

  // Resolve the live session at the moment the queued task runs. A caller that captured a session
  // before enqueueing must not use it if the session was closed while the task waited.
  function requireLiveSession(profileId) {
    const session = sessions.get(profileId);
    if (!session || session.state === 'closed') throw sessionNotFound(profileId);
    return session;
  }

  function leasePath(profileId) {
    return join(settings.homeDir, 'locks', `profile-${profileId}`);
  }

  function ensureIdleTimer() {
    if (timer !== null) return;
    timer = setInterval(() => {
      sweepIdle().catch(() => undefined);
    }, idleCheckIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopIdleTimerIfEmpty() {
    if (timer !== null && sessions.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  function hasActiveTask(session) {
    if (session.tasks.size > 0) return true;
    if (typeof tasks === 'function') {
      try { return tasks(session.id) === true; } catch { return true; }
    }
    if (tasks && typeof tasks === 'object') {
      try {
        if (typeof tasks.hasActiveTask === 'function') return tasks.hasActiveTask(session.id) === true;
        if (typeof tasks.activeCount === 'function') return Number(tasks.activeCount(session.id)) > 0;
      } catch {
        return true;
      }
    }
    return false;
  }

  // Idle close is an internal maintenance step: it never closes a profile with a registered task
  // or a queued operation, and it is safe to call before every public entry point.
  async function sweepIdle() {
    const now = clock();
    for (const session of [...sessions.values()]) {
      if (queues.has(session.id)) continue;
      if (hasActiveTask(session)) continue;
      if (now - session.lastUsedAt < idleTimeoutMs) continue;
      await closeInternal(session, { logout: false }).catch(() => undefined);
    }
  }

  async function loadOptionalPlaywright(profileId) {
    let playwright;
    try {
      playwright = await loader();
    } catch (error) {
      // Only an absent package is an install hint. A present but broken install (parse error,
      // native-load failure) is a backend failure and must not be reported as "not installed".
      if (isModuleNotFound(error)) throw dependencyMissing(profileId);
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        'Playwright is installed but could not be loaded. Nothing was installed or downloaded automatically.',
        { safeDetails: { profileId, reason: 'dependency_load_failed' } },
      );
    }
    const browserType = playwright?.[channel];
    if (!browserType || typeof browserType.launchPersistentContext !== 'function') {
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        `The installed Playwright package does not expose a usable ${channel} launcher.`,
        { safeDetails: { profileId, reason: 'channel_unsupported' } },
      );
    }
    return playwright;
  }

  async function launchContext(profileId, visibility) {
    const dir = profileDir(profileId);
    if (typeof protect === 'function') {
      try {
        await protect(dir);
      } catch (error) {
        // The storage guard reports its own coded errors (UNSAFE_LOCATION, PROTECTION_FAILED,
        // UNSUPPORTED_PLATFORM). Public methods expose only the canonical operation codes.
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'BACKEND_UNAVAILABLE',
          'The dedicated browser profile cannot be protected safely on this machine, so no browser was opened.',
          { safeDetails: { profileId, reason: 'protection_failed' } },
        );
      }
    }

    let lease;
    try {
      lease = await acquire(leasePath(profileId), {
        kind: 'browser-profile',
        owner: `reddit-cli browser pid ${process.pid}`,
        timeoutMs: lockTimeoutMs,
      });
    } catch (error) {
      if (error?.code === 'PROFILE_IN_USE') throw error;
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        'The dedicated browser profile could not be locked for this process.',
        { safeDetails: { profileId, reason: 'lock_failed' } },
      );
    }

    let context;
    let playwright = null;
    try {
      playwright = await loadOptionalPlaywright(profileId);
      const browserType = playwright[channel];
      context = await browserType.launchPersistentContext(dir, {
        headless: visibility === 'headless',
        acceptDownloads: false,
      });
    } catch (error) {
      await lease.release().catch(() => undefined);
      if (error instanceof OperationError) throw error;
      throw launchErrorCode(error) === 'BROWSER_BINARY_MISSING'
        ? binaryMissing(profileId)
        : launchUnavailable(profileId);
    }

    // The live browser context owns the profile cookies. Prefer its request context so reads share
    // the session without exporting state; fall back to a snapshot-bound request context only when
    // the installed Playwright does not expose one.
    let requestContext = context?.request ?? null;
    let ownsRequestContext = false;
    if (!requestContext && typeof playwright?.request?.newContext === 'function') {
      try {
        const storageState = typeof context?.storageState === 'function'
          ? await context.storageState()
          : undefined;
        requestContext = await playwright.request.newContext(storageState === undefined ? {} : { storageState });
        ownsRequestContext = true;
      } catch {
        requestContext = null;
      }
    }
    return { context, requestContext, ownsRequestContext, lease };
  }

  async function ensureOpen(snapshot, visibility) {
    const existing = sessions.get(snapshot.id);
    if (existing) {
      touch(existing);
      if (existing.visibility !== visibility) existing.pendingVisibility = visibility;
      return existing;
    }

    const launched = await launchContext(snapshot.id, visibility);
    const session = {
      id: snapshot.id,
      profileId: snapshot.id,
      snapshot: { ...snapshot },
      visibility,
      pendingVisibility: null,
      context: launched.context,
      requestContext: launched.requestContext,
      account: null,
      credentialGeneration: snapshot.credentialGeneration ?? null,
      lease: launched.lease,
      state: 'open',
      blockedReason: null,
      identity: null,
      passwordAttempts: 0,
      tasks: new Set(),
      openedAt: clock(),
      lastUsedAt: clock(),
      clock,
      enrollment: false,
      ownsRequestContext: launched.ownsRequestContext,
    };
    sessions.set(session.id, session);
    ensureIdleTimer();
    return session;
  }

  async function readCurrentIdentity(session) {
    return await readSessionIdentity({
      requestContext: session.requestContext,
      uiIdentity: uiIdentity ?? undefined,
      clock,
      timeoutMs: identityTimeoutMs,
    });
  }

  // Verification is read-only for a session probe. Only explicit enrollment persists the binding,
  // so a routine identity check cannot mutate the registry (and its generations) mid-operation.
  async function verifyIdentity(session, status, { bind = false } = {}) {
    const snapshot = session.snapshot;
    const foundKey = status.usernameKey ?? usernameKey(status.username);
    const expected = expectedUsernameOf(snapshot);
    if (expected && usernameKey(expected) !== foundKey) throw markBlocked(session);
    if (snapshot.accountKey && deriveAccountKey(foundKey) !== snapshot.accountKey) throw markBlocked(session);
    if (snapshot.accountId && status.accountId && snapshot.accountId !== status.accountId) throw markBlocked(session);

    if (accountRegistry && bind === true) {
      try {
        session.account = await accountRegistry.bind({
          profileId: snapshot.id,
          username: status.username,
          accountId: status.accountId ?? null,
        });
      } catch (error) {
        if (error?.code === 'IDENTITY_MISMATCH') throw markBlocked(session);
        throw error;
      }
      // Keep the frozen session consistent with the one-time bind so repeated checks do not bind
      // again and a later mismatch is still detected against the verified account.
      session.snapshot = {
        ...snapshot,
        accountKey: session.account.accountKey,
        accountId: session.account.accountId ?? null,
        username: session.account.username,
      };
    } else if (accountRegistry && snapshot.accountKey) {
      session.account = {
        accountKey: snapshot.accountKey,
        accountId: status.accountId ?? snapshot.accountId ?? null,
        username: status.username,
      };
    } else {
      // Resolve an already-recorded account without writing. A username-only observation resolves
      // through the shared registry so the quota identity matches an API-verified account.
      let existing = null;
      if (accountRegistry) {
        try {
          existing = await accountRegistry.lookup({
            accountId: status.accountId ?? null,
            username: status.username,
          });
        } catch (error) {
          if (error?.code === 'IDENTITY_MISMATCH') throw markBlocked(session);
          throw error;
        }
      }
      session.account = existing ?? {
        accountKey: deriveAccountKey(foundKey),
        accountId: status.accountId ?? snapshot.accountId ?? null,
        username: status.username,
      };
    }

    session.state = 'open';
    session.blockedReason = null;
    session.identity = identityRecord(session, status);
    return session.identity;
  }

  async function applyStatus(session, status) {
    if (status.state === 'authenticated') return await verifyIdentity(session, status);
    throw classifyBlockingStatus(session, status);
  }

  async function readStoredPassword(session) {
    if (!secretStore) return null;
    try {
      const value = await secretStore.get(secretStore.ref(session.id, PASSWORD_SECRET_NAME));
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      throw unavailable(session.id, 'secret_store_unavailable');
    }
  }

  async function waitForIdentity(session, { intervalMs = 500, maxPolls = 20, timeMs = credentialsTimeoutMs } = {}) {
    const deadline = clock() + timeMs;
    let status = await readCurrentIdentity(session);
    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (status.state !== 'anonymous' && status.state !== 'unavailable') break;
      if (clock() >= deadline) break;
      await sleep(intervalMs);
      touch(session);
      status = await readCurrentIdentity(session);
    }
    return status;
  }

  // Stored-password login is a security-sensitive opt-in. A profile snapshot is frozen when the
  // caller resolves it, so the live registry is consulted again immediately before the attempt;
  // disabling the setting after open must stop the attempt.
  async function livePasswordLoginEnabled(session) {
    if (!registry || typeof registry.snapshot !== 'function') {
      return session.snapshot.passwordLoginEnabled === true;
    }
    let live;
    try {
      live = await registry.snapshot(session.id);
    } catch (error) {
      if (error?.code === 'PROFILE_NOT_FOUND') throw sessionNotFound(session.id);
      throw unavailable(session.id, 'profile_lookup_failed');
    }
    if (!live || typeof live !== 'object') throw unavailable(session.id, 'profile_lookup_failed');
    const enabled = live.passwordLoginEnabled === true;
    session.snapshot = { ...session.snapshot, passwordLoginEnabled: enabled };
    return enabled;
  }

  async function recoverWithPassword(session, allowPasswordLogin) {
    if (allowPasswordLogin !== true) {
      session.state = 'needs_login';
      throw loginRequired(session.id, 'login_required', { visibility: session.visibility });
    }
    if (await livePasswordLoginEnabled(session) !== true) {
      session.state = 'needs_login';
      throw loginRequired(session.id, 'password_login_disabled', { visibility: session.visibility });
    }
    if (session.passwordAttempts >= 1) {
      session.state = 'handoff';
      throw handoffRequired(session.id, 'password_login_already_attempted', { visibility: session.visibility });
    }
    const username = expectedUsernameOf(session.snapshot) ?? session.account?.username ?? null;
    if (!username) {
      session.state = 'needs_login';
      throw loginRequired(session.id, 'username_unknown', { visibility: session.visibility });
    }
    const password = await readStoredPassword(session);
    if (!password) {
      session.state = 'needs_login';
      throw loginRequired(session.id, 'stored_password_missing', { visibility: session.visibility });
    }

    // One bounded attempt. The attempt is recorded before anything is typed so a transport error
    // cannot cause a hidden second submission.
    session.passwordAttempts += 1;
    const attempt = await performPasswordLogin(session, {
      username,
      password,
      timeoutMs: navigationTimeoutMs,
    });
    if (!attempt.ok) {
      session.state = 'handoff';
      throw handoffRequired(session.id, attempt.reason, { visibility: session.visibility });
    }

    const after = await waitForIdentity(session, { timeMs: credentialsTimeoutMs });
    if (after.state === 'authenticated') {
      const identity = await verifyIdentity(session, after);
      return { state: 'renewed', source: 'password_login', identity };
    }
    if (after.state === 'anonymous' || after.state === 'unavailable') {
      session.state = 'handoff';
      throw handoffRequired(session.id, 'login_not_accepted', { visibility: session.visibility });
    }
    throw classifyBlockingStatus(session, after);
  }

  async function closeInternal(session, { logout = false } = {}) {
    if (sessions.get(session.id) === session) sessions.delete(session.id);
    session.state = 'closed';

    let remoteLogoutRequested = false;
    let remoteLogoutFailed = false;
    if (logout === true) {
      remoteLogoutRequested = true;
      try {
        const page = await currentPage(session);
        if (!page || typeof page.goto !== 'function') throw new Error('no page');
        await page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
      } catch {
        remoteLogoutFailed = true;
      }
    }

    if (session.ownsRequestContext && typeof session.requestContext?.dispose === 'function') {
      try { await session.requestContext.dispose(); } catch { /* cleanup is best-effort */ }
    }
    if (typeof session.context?.close === 'function') {
      try { await session.context.close({ reason: 'reddit-cli-session-close' }); } catch { /* best-effort */ }
    }
    if (typeof session.lease?.release === 'function') {
      try { await session.lease.release(); } catch { /* best-effort */ }
    }
    stopIdleTimerIfEmpty();

    return {
      closed: true,
      profileId: session.id,
      localOnly: logout !== true,
      remoteLogoutRequested,
      remoteLogoutFailed,
    };
  }

  async function open(snapshot, { visibility } = {}) {
    assertSnapshot(snapshot);
    const resolved = resolveVisibility(visibility ?? snapshot.visibility ?? 'visible', resolveInteractive());
    await sweepIdle();
    return await enqueue(snapshot.id, async () => {
      const session = await ensureOpen(snapshot, resolved);
      touch(session);
      return session;
    });
  }

  async function identity(profileId) {
    assertProfileId(profileId);
    await sweepIdle();
    if (!sessions.has(profileId)) throw sessionNotFound(profileId);
    return await enqueue(profileId, async () => {
      const session = requireLiveSession(profileId);
      touch(session);
      assertNotBlocked(session);
      const status = await readCurrentIdentity(session);
      return await applyStatus(session, status);
    });
  }

  async function renew(profileId, { allowPasswordLogin = false } = {}) {
    assertProfileId(profileId);
    await sweepIdle();
    if (!sessions.has(profileId)) throw sessionNotFound(profileId);
    return await enqueue(profileId, async () => {
      const session = requireLiveSession(profileId);
      touch(session);
      assertNotBlocked(session);
      const status = await readCurrentIdentity(session);
      if (status.state === 'authenticated') {
        return { state: 'active', source: 'live_session', identity: await verifyIdentity(session, status) };
      }
      if (status.state !== 'anonymous') throw classifyBlockingStatus(session, status);
      return await recoverWithPassword(session, allowPasswordLogin === true);
    });
  }

  async function enroll(snapshot, { visibility = 'visible', timeoutMs } = {}) {
    assertSnapshot(snapshot);
    if (visibility !== 'visible') {
      throw handoffRequired(snapshot.id, 'enrollment_requires_visible', { visibility: 'visible' });
    }
    await sweepIdle();
    return await enqueue(snapshot.id, async () => {
      // Enrollment is a manual login and must be observable. An existing headless session is
      // replaced by a visible one; it is never reused for enrollment.
      const existing = sessions.get(snapshot.id);
      if (existing && existing.state !== 'closed' && existing.visibility !== 'visible') {
        if (hasActiveTask(existing)) {
          throw new OperationError(
            'PROFILE_IN_USE',
            'This browser profile has a task in progress in a non-visible session. Finish that task before enrollment can open a visible window.',
            { safeDetails: { profileId: snapshot.id, reason: 'task_in_progress' } },
          );
        }
        await closeInternal(existing, {});
      }
      const session = await ensureOpen(snapshot, 'visible');
      session.enrollment = true;
      touch(session);
      const deadline = clock() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : enrollmentTimeoutMs);
      let status = await readCurrentIdentity(session);
      for (let poll = 0; poll < 120; poll += 1) {
        if (status.state !== 'anonymous' && status.state !== 'unavailable') break;
        if (clock() >= deadline) break;
        await sleep(1000);
        touch(session);
        status = await readCurrentIdentity(session);
      }

      if (status.state === 'authenticated') {
        const identity = await verifyIdentity(session, status, { bind: true });
        session.enrollment = false;
        return {
          profileId: session.id,
          state: 'ready',
          visibility: session.visibility,
          identity,
          instructions: ['Keep this visible browser window signed in; close it when enrollment is finished.'],
        };
      }

      if (status.state === 'anonymous' || status.state === 'unavailable') {
        session.state = 'needs_login';
        return {
          profileId: session.id,
          state: 'waiting_for_login',
          visibility: session.visibility,
          instructions: [
            'Sign in to the expected Reddit account in the visible browser window, then run enrollment again.',
            'Enrollment never reads the password or any cookie value.',
          ],
        };
      }

      session.state = 'handoff';
      return {
        profileId: session.id,
        state: status.state,
        reason: status.reason ?? null,
        visibility: session.visibility,
        instructions: [
          'Finish the Reddit sign-in or verification in the visible browser window, then run enrollment again.',
          'No automatic solve, retry, or alternate route was attempted.',
        ],
      };
    });
  }

  async function close(profileId, { logout = false, force = false } = {}) {
    assertProfileId(profileId);
    await sweepIdle();
    const session = sessions.get(profileId);
    if (!session) {
      // No session in this process does not mean the profile is unowned. A second CLI process may be
      // holding the cross-process lease, and profile removal must not delete metadata/secrets out
      // from under it. A stale lock (verified dead owner) does not block removal.
      let lease = { held: false };
      try {
        lease = await inspect(leasePath(profileId));
      } catch {
        // An unreadable lock is treated conservatively as owned.
        lease = { held: true, live: true, corrupt: true };
      }
      if (lease?.held && lease.live) {
        throw new OperationError(
          'PROFILE_IN_USE',
          'Another local process owns this browser profile. Close it there first (reddit-cli profile logout or browser close), then retry; nothing was deleted.',
          {
            safeDetails: {
              profileId,
              reason: 'other_process',
              pid: lease.pid ?? null,
              owner: typeof lease.owner === 'string' ? lease.owner : null,
            },
          },
        );
      }
      return {
        closed: false,
        profileId,
        localOnly: true,
        remoteLogoutRequested: false,
        remoteLogoutFailed: false,
      };
    }
    return await enqueue(profileId, async () => {
      const live = sessions.get(profileId);
      if (!live || live !== session || live.state === 'closed') {
        return {
          closed: false,
          profileId,
          localOnly: true,
          remoteLogoutRequested: false,
          remoteLogoutFailed: false,
        };
      }
      if (hasActiveTask(live) && force !== true) {
        throw new OperationError(
          'PROFILE_IN_USE',
          'This browser profile has a task in progress. Finish or close that task before closing the session.',
          { safeDetails: { profileId, reason: 'task_in_progress' } },
        );
      }
      return await closeInternal(live, { logout: logout === true });
    });
  }

  async function closeAll() {
    await sweepIdle();
    const pending = [...sessions.values()];
    const results = [];
    for (const session of pending) {
      results.push(await enqueue(session.id, async () => {
        const live = sessions.get(session.id);
        if (!live || live !== session || live.state === 'closed') {
          return {
            closed: false,
            profileId: session.id,
            localOnly: true,
            remoteLogoutRequested: false,
            remoteLogoutFailed: false,
          };
        }
        return await closeInternal(live, {});
      }));
    }
    return results;
  }

  return Object.freeze({
    open,
    identity,
    renew,
    close,
    closeAll,
    enroll,
  });
}
