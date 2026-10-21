// Frozen-profile operation dispatcher.
//
// One entry point for every Reddit tool. It resolves and freezes a profile snapshot per call, routes
// offline and RSS operations before any profile work, selects a capability-aware backend
// (api -> replay -> browser in the profile's order), and sends every mutation through the single
// shared write boundary (src/write-boundary.js). Losing a response never causes a second backend to
// resubmit: fallback is limited to an eligible unsupported/unavailable implementation observed before
// dispatch.
//
// The dispatcher is transport-agnostic. `backendFactories` is injected; the production factories
// below load the official-API session code lazily and lazily import the experimental replay and
// rendered-UI modules, so an API-only HTTP/MCPB/Docker install never needs Playwright or those files.

import { createHash } from 'node:crypto';
import { createAttemptLedger, createCacheGeneration } from './attempts.js';
import { readLegacyApiConfig, readRuntimeSettings, VERSION } from './config.js';
import { normalizeBackendResult } from './continuations.js';
import { OperationError } from './errors.js';
import { lookupTerm } from './glossary.js';
import {
  describeOperation,
  WRITE_TOOL_NAMES,
} from './operations.js';
import { deriveAccountKey, isLegacyProfile, LEGACY_PROFILE_ID, resolveProfile, usernameKey } from './profiles.js';
import { browseSubredditRss } from './rss.js';
import { createWriteBoundary } from './write-boundary.js';

export const BACKEND_IDS = Object.freeze(['api', 'replay', 'browser']);
export const BACKEND_MODES = Object.freeze(['auto', ...BACKEND_IDS]);

const BACKEND_SET = new Set(BACKEND_IDS);
const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);
// Reads whose rendered-UI mapping can page. A continuation is only meaningful for these tools; every
// other tool (and every write) refuses it instead of treating it as a harmless extra argument.
const PAGED_READ_TOOLS = new Set([
  'browse_subreddit',
  'get_top_posts',
  'search_reddit',
  'get_user_posts',
  'get_user_comments',
  'get_my_overview',
  'get_my_saved',
]);

// A fallback may only advance to another backend when the previous one could not implement or load
// the operation at all. Authentication, throttling, permission, identity, and outcome errors are
// terminal: another route must never be used to get around a refusal.
const FALLBACK_CODES = new Set([
  'BACKEND_UNAVAILABLE',
  'UNSUPPORTED_OPERATION',
  'PARAMETER_UNSUPPORTED',
  'BROWSER_DEPENDENCY_MISSING',
  'BROWSER_BINARY_MISSING',
]);
const LOGIN_MESSAGE_RE = /not logged in|log ?in|token request failed|invalid_grant/i;
// The local client throttle (sliding window / x-ratelimit blockedUntil) throws a RedditError with no
// HTTP status and no outcome. It is still a Reddit refusal, so it must never be rerouted.
const THROTTLE_MESSAGE_RE = /rate limit|ratelimit|throttl/i;
// Durable admission refusals kept by src/attempts.js as plain coded errors (they are deliberately not
// in the canonical OPERATION_ERROR_CODES list). They are safe, actionable, and non-retryable, so the
// dispatcher preserves them instead of folding them into a generic backend failure.
const PASS_THROUGH_CODES = new Set([
  'DUPLICATE_WRITE',
  'ATTEMPT_NOT_READY',
  'ATTEMPT_STATE',
  'ATTEMPT_NOT_FOUND',
  'ATTEMPT_LEDGER_CORRUPT',
  'PROFILE_IN_USE',
]);
const NON_CANONICAL_SECRET_CODES = new Set([
  'INVALID_ARGUMENT',
  'SECRET_STORE_UNAVAILABLE',
  'SECRET_TOO_LARGE',
  'SESSION_STATE_INVALID',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cancelledError() {
  return new OperationError('USER_HANDOFF_REQUIRED', 'The operation was cancelled before dispatch; nothing was sent.', {
    safeDetails: { reason: 'cancelled' },
  });
}

// Profile confirmations are a per-tool boolean map plus an optional `global` key. Runtime settings are
// the approvals.js `{global, perAction}` string policy. Both forms are accepted at either source, and
// every value must be recognizable: an unrecognized key or value is refused rather than ignored, so a
// mis-shaped policy can never silently weaken an enabled confirmation.
function confirmationEnabled(value, source) {
  if (value === true || value === 'on') return true;
  if (value === false || value === 'off') return false;
  throw new TypeError(`${source} confirmation values must be true/false or "on"/"off"; got ${JSON.stringify(value)}.`);
}

function readConfirmationSource(raw, source) {
  const result = { global: false, perAction: {} };
  if (raw === undefined || raw === null) return result;
  if (!isPlainObject(raw)) throw new TypeError(`${source} confirmations must be an object.`);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'global') {
      result.global = confirmationEnabled(value, source);
    } else if (key === 'perAction') {
      if (!isPlainObject(value)) throw new TypeError(`${source} confirmations.perAction must be an object.`);
      for (const [tool, entry] of Object.entries(value)) {
        if (!WRITE_TOOL_SET.has(tool)) throw new TypeError(`${source} confirmations.perAction has an unknown write tool: ${tool}.`);
        result.perAction[tool] = confirmationEnabled(entry, source);
      }
    } else if (WRITE_TOOL_SET.has(key)) {
      result.perAction[key] = confirmationEnabled(value, source);
    } else {
      throw new TypeError(`${source} confirmations has an unknown key: ${key}.`);
    }
  }
  return result;
}

// Neither source may weaken the other: a policy is required when either source requires it, and an
// explicit false is never treated as an override of the other source.
export function effectiveApprovalPolicy(settings, profile = null) {
  const runtime = readConfirmationSource(settings?.confirmations, 'Runtime');
  const confirmations = readConfirmationSource(profile?.confirmations, 'Profile');
  const perAction = {};
  for (const tool of WRITE_TOOL_SET) {
    if (runtime.perAction[tool] || confirmations.perAction[tool]) perAction[tool] = 'on';
  }
  return Object.freeze({
    global: runtime.global || confirmations.global ? 'on' : 'off',
    perAction: Object.freeze(perAction),
  });
}

function enabledBackendsOf(profile) {
  if (isLegacyProfile(profile)) return ['api'];
  const enabled = Array.isArray(profile?.enabledBackends) ? profile.enabledBackends : ['api'];
  return BACKEND_IDS.filter((id) => enabled.includes(id));
}

function autoOrder(profile) {
  const enabled = new Set(enabledBackendsOf(profile));
  const order = [];
  const preference = Array.isArray(profile?.backendPreference) ? profile.backendPreference : [];
  for (const id of [...preference, ...BACKEND_IDS]) {
    if (BACKEND_SET.has(id) && enabled.has(id) && !order.includes(id)) order.push(id);
  }
  return order;
}

function selectCandidates(profile, requested) {
  if (requested !== 'auto') {
    if (!BACKEND_SET.has(requested)) {
      throw new TypeError(`backend must be auto, api, replay, or browser; got ${JSON.stringify(requested)}.`);
    }
    if (!enabledBackendsOf(profile).includes(requested)) {
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        `The ${requested} backend is not enabled for this profile. Enable it in the profile configuration first.`,
        { safeDetails: { backend: requested, enabledBackends: enabledBackendsOf(profile) } },
      );
    }
    return [requested];
  }
  return autoOrder(profile);
}

// UI cursors are bound to the exact account, backend, operation, and normalized query. This hash must
// match src/backends/browser.js's issuance or a token can never be redeemed for its own request.
function filterHashOf(operation) {
  return createHash('sha256').update(JSON.stringify(operation.args ?? {})).digest('hex');
}

// A continuation is an opaque capability for one frozen read. It is validated here, before any backend
// is constructed, and never falls back to a fresh read: silently restarting page one would make a
// partial result look like a successful continuation. The rendered-UI mappings do not yet implement
// resuming from stored state, so after binding validation this stays a typed refusal.
function continuationRefusal(message, reason, extra = {}) {
  return new OperationError('CONTINUATION_INVALID', message, { safeDetails: { reason, ...extra } });
}

function validateContinuation({ operation, snapshot, continuations, token }) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw continuationRefusal('A continuation token must be a non-empty string.', 'invalid_token');
  }
  if (!continuations || typeof continuations.resolve !== 'function') {
    throw continuationRefusal(
      'No UI continuation store is wired to this dispatcher build, so a continuation token cannot be used. Restart the read without a continuation.',
      'continuation_unavailable',
    );
  }
  if (operation.kind !== 'read' || !PAGED_READ_TOOLS.has(operation.tool)) {
    throw continuationRefusal(
      'This tool has no rendered-UI continuation. Remove the continuation token and run the operation normally.',
      'continuation_not_supported',
      { tool: operation.tool },
    );
  }
  continuations.resolve(token, {
    profileId: snapshot.id,
    accountKey: snapshot.accountKey,
    backend: 'browser',
    operation: operation.tool,
    filterHash: filterHashOf(operation),
    credentialGeneration: snapshot.credentialGeneration ?? 1,
  });
  throw continuationRefusal(
    'This build cannot resume a rendered-UI continuation yet. Restart the read without the continuation token; no page was re-read and nothing was sent.',
    'continuation_resume_unverified',
  );
}

// Classify a failure into a canonical public error and whether another backend may be tried. Reddit
// rejections are never rerouted; only a missing/unimplemented implementation is fallback-eligible.
function classifyError(error, { phase, backendId }) {
  if (error instanceof OperationError) {
    // An error that already carries an outcome may have reached Reddit: never reroute it.
    return {
      error,
      fallback: FALLBACK_CODES.has(error.code) && (error.outcome ?? null) === null,
    };
  }
  if (typeof error?.code === 'string' && PASS_THROUGH_CODES.has(error.code)) {
    return { error, fallback: false };
  }
  const status = Number(error?.status);
  const message = typeof error?.message === 'string' ? error.message : '';
  // The client's own sliding-window / blockedUntil refusal has no HTTP status and matches no status
  // branch below, so recognize a throttle by message before the generic fallback.
  if (THROTTLE_MESSAGE_RE.test(message)) {
    return {
      error: new OperationError('THROTTLED', 'Reddit is throttling this account. Wait, then try again.', {
        retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null,
        safeDetails: { backend: backendId },
      }),
      fallback: false,
    };
  }
  if (error?.name === 'RedditError' && Number.isFinite(status)) {
    if (status === 429) {
      return {
        error: new OperationError('THROTTLED', 'Reddit is throttling this account. Wait, then try again.', {
          retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null,
          safeDetails: { backend: backendId },
        }),
        fallback: false,
      };
    }
    if (status === 401) {
      return {
        error: new OperationError('LOGIN_REQUIRED', 'Reddit rejected this profile credentials. Sign in again locally.', {
          safeDetails: { backend: backendId },
        }),
        fallback: false,
      };
    }
    if (status === 403) {
      return {
        error: new OperationError(
          'USER_HANDOFF_REQUIRED',
          'Reddit refused this request for this account. A person needs to check the account or its permissions; no alternate backend was tried.',
          { safeDetails: { backend: backendId } },
        ),
        fallback: false,
      };
    }
    return {
      error: new OperationError('BACKEND_UNAVAILABLE', 'The backend could not complete this request.', {
        safeDetails: { backend: backendId, reason: 'request_failed' },
      }),
      fallback: false,
    };
  }
  if (LOGIN_MESSAGE_RE.test(message)) {
    return {
      error: new OperationError('LOGIN_REQUIRED', 'This profile is not signed in, or its credentials were rejected. Sign in again locally.', {
        safeDetails: { backend: backendId },
      }),
      fallback: false,
    };
  }
  return {
    error: new OperationError(
      'BACKEND_UNAVAILABLE',
      'The backend could not complete this operation. Nothing was sent if the failure happened before dispatch.',
      { safeDetails: { backend: backendId, reason: phase === 'read' ? 'read_failed' : 'operation_failed' } },
    ),
    // An error that already carries an outcome may have reached Reddit; it is never rerouted.
    fallback: (error?.outcome ?? null) === null,
  };
}

function normalizeBackendHandle(result, backendId) {
  const backend = typeof result?.read === 'function' ? result : result?.backend;
  if (!backend || typeof backend.read !== 'function' || typeof backend.prepareWrite !== 'function'
    || typeof backend.commitWrite !== 'function') {
    throw new OperationError('BACKEND_UNAVAILABLE', `The ${backendId} backend is misconfigured.`, {
      safeDetails: { backend: backendId, reason: 'backend_interface_mismatch' },
    });
  }
  const close = typeof result?.close === 'function'
    ? result.close.bind(result)
    : (typeof backend.close === 'function' ? backend.close.bind(backend) : null);
  return { backend, close };
}

// Probe shapes differ by adapter (`{username}` for the API, `{name}` for some UI identities). Normalize
// them to one identity, and let the shared account registry decide the account key when it already
// knows the account under another alias. An unverified probe never authorizes a write.
function normalizeProbe(probe) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return null;
  const username = typeof probe.username === 'string' && probe.username
    ? probe.username
    : (typeof probe.name === 'string' && probe.name ? probe.name : null);
  const rawId = probe.accountId ?? probe.id ?? null;
  const accountId = typeof rawId === 'string' && /^t2_[A-Za-z0-9]+$/.test(rawId) ? rawId : null;
  const suppliedKey = typeof probe.accountKey === 'string' && probe.accountKey ? probe.accountKey : null;
  const accountKey = suppliedKey ?? (username ? deriveAccountKey(usernameKey(username)) : null);
  return {
    appOnly: probe.appOnly === true,
    verified: probe.verified !== false,
    username,
    accountId,
    accountKey,
  };
}

// Production backend factories. Each returns a Backend (or `{backend, close}`) for one frozen
// snapshot. `api` uses the existing session module; `replay` and `browser` are imported lazily so an
// install that never selects them needs neither their files nor Playwright.
export function createBackendFactories({
  secretStore = null,
  browserSessions = null,
  continuations = null,
  tasks = null,
  fetch = globalThis.fetch,
  clock = () => Date.now(),
  legacyConfig = null,
} = {}) {
  async function importBackendModule(specifier, exportName, backendId) {
    let module;
    try {
      module = await import(specifier);
    } catch (error) {
      const notFound = error?.code === 'ERR_MODULE_NOT_FOUND'
        && String(error?.message ?? '').includes(specifier.replace('./', ''));
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        `The ${backendId} backend is not available in this installation. Nothing was installed or downloaded.`,
        { safeDetails: { backend: backendId, reason: notFound ? 'backend_module_missing' : 'backend_load_failed' } },
      );
    }
    const factory = module?.[exportName];
    if (typeof factory !== 'function') {
      throw new OperationError('BACKEND_UNAVAILABLE', `The ${backendId} backend is misconfigured.`, {
        safeDetails: { backend: backendId, reason: 'backend_interface_mismatch' },
      });
    }
    return factory;
  }

  async function api({ snapshot, settings, cacheGeneration, legacyConfig: resolvedLegacy = null }) {
    const { openApiSession, openSession } = await import('./session.js');
    const { createApiBackend } = await import('./backends/api.js');
    let client;
    let config;
    let close = null;
    if (isLegacyProfile(snapshot)) {
      const legacy = resolvedLegacy ?? legacyConfig ?? readLegacyApiConfig(process.env);
      const session = openSession(legacy);
      client = session.client;
      config = legacy;
    } else {
      if (!secretStore) {
        throw new OperationError(
          'BACKEND_UNAVAILABLE',
          'No profile secret store is configured, so this profile API credentials cannot be read.',
          { safeDetails: { backend: 'api', profileId: snapshot.id, reason: 'secret_store_unavailable' } },
        );
      }
      let session;
      try {
        session = await openApiSession({ snapshot, settings, secretStore, fetch, now: clock, cacheGeneration });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        if (NON_CANONICAL_SECRET_CODES.has(error?.code)) {
          throw new OperationError(
            'BACKEND_UNAVAILABLE',
            'This profile API credentials are unavailable or unreadable. Nothing was sent.',
            { safeDetails: { backend: 'api', profileId: snapshot.id, reason: 'profile_credentials_unavailable' } },
          );
        }
        throw error;
      }
      client = session.client;
      close = typeof session.close === 'function' ? session.close : null;
      config = {
        authMode: session.authMode,
        appOnly: session.appOnly,
        readOnly: session.appOnly,
        botFooter: session.botFooter ?? settings?.botFooter ?? '',
      };
    }
    const backend = createApiBackend({ snapshot, config, client });
    return { backend, close };
  }

  async function replay({ snapshot, settings, cacheGeneration }) {
    const createReplayBackend = await importBackendModule('./backends/replay.js', 'createReplayBackend', 'replay');
    if (!browserSessions) {
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        'The replay backend needs an open browser-profile session manager. Nothing was opened automatically.',
        { safeDetails: { backend: 'replay', profileId: snapshot.id, reason: 'session_manager_unavailable' } },
      );
    }
    return createReplayBackend({ snapshot, sessions: browserSessions, secretStore, settings, cacheGeneration, clock, fetch });
  }

  async function browser({ snapshot, settings }) {
    const createBrowserBackend = await importBackendModule('./backends/browser.js', 'createBrowserBackend', 'browser');
    if (!browserSessions) {
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        'The browser backend needs an open browser-profile session manager. Nothing was opened automatically.',
        { safeDetails: { backend: 'browser', profileId: snapshot.id, reason: 'session_manager_unavailable' } },
      );
    }
    // The continuation store is process-scope and optional: without it a paged read simply reports no
    // UI cursor. It is never a reason to open a browser or install anything.
    return createBrowserBackend({ snapshot, sessions: browserSessions, secretStore, settings, clock, fetch, continuations, tasks });
  }

  return Object.freeze({ api, replay, browser });
}

export function createDispatcher({
  registry = null,
  accounts = null,
  backendFactories = null,
  settings = null,
  approvals = null,
  leases = undefined,
  clock = () => Date.now(),
  env = process.env,
  fetch = globalThis.fetch,
  secretStore = null,
  browserSessions = null,
  continuations = null,
  tasks = null,
  sleep = undefined,
  legacyConfig = undefined,
  newId = undefined,
  legacyConfigLoader = readLegacyApiConfig,
} = {}) {
  const base = readRuntimeSettings(env);
  const runtimeSettings = Object.freeze({ ...base, ...(isPlainObject(settings) ? settings : {}) });
  if (typeof runtimeSettings.homeDir !== 'string' || runtimeSettings.homeDir.length === 0) {
    throw new TypeError('The dispatcher needs a home directory in its runtime settings.');
  }
  const factories = backendFactories ?? createBackendFactories({ secretStore, browserSessions, continuations, tasks, fetch, clock });

  const ledgerCache = new Map();
  const generationCache = new Map();
  const backendCache = new Map();
  let callCounter = 0;
  const nextCallId = typeof newId === 'function'
    ? newId
    : () => `call_${Date.now().toString(36)}_${(callCounter += 1).toString(36)}`;

  let legacyResolution = null;
  function legacyConfigState() {
    if (legacyConfig !== undefined) return { ok: true, config: legacyConfig };
    if (legacyResolution) return legacyResolution;
    try {
      legacyResolution = { ok: true, config: legacyConfigLoader(env) };
    } catch (error) {
      legacyResolution = { ok: false, error };
    }
    return legacyResolution;
  }

  async function resolveFor(explicitProfile) {
    const legacy = legacyConfigState();
    try {
      return await resolveProfile({
        registry,
        explicitProfile: explicitProfile ?? null,
        legacyConfigAvailable: legacy.ok,
      });
    } catch (error) {
      // With no registry at all, the old strict environment error (which names REDDIT_CLIENT_ID) is
      // more actionable than a generic PROFILE_REQUIRED.
      if (error?.code === 'PROFILE_REQUIRED' && !explicitProfile && !legacy.ok && !registry) {
        throw legacy.error;
      }
      throw error;
    }
  }

  function cacheGenerationFor(accountKey) {
    if (!generationCache.has(accountKey)) {
      generationCache.set(accountKey, createCacheGeneration({
        homeDir: runtimeSettings.homeDir,
        accountKey,
        leases,
        clock,
      }));
    }
    return generationCache.get(accountKey);
  }

  function ledgerFor(accountKey, cacheGeneration) {
    if (!ledgerCache.has(accountKey)) {
      ledgerCache.set(accountKey, createAttemptLedger({
        homeDir: runtimeSettings.homeDir,
        accountKey,
        leases,
        clock,
        cacheGeneration,
        limits: {
          minGapMs: runtimeSettings.minGapMs,
          maxWritesPerHour: runtimeSettings.maxWritesPerHour,
        },
      }));
    }
    return ledgerCache.get(accountKey);
  }

  async function closeEntry(entry) {
    if (!entry || typeof entry.close !== 'function') return;
    try {
      await entry.close();
    } catch {
      // Closing is maintenance; a backend that cannot close must not mask the caller's result.
    }
  }

  // One backend instance per profile, credential generation, and policy generation. A rotation or a
  // visibility/backend/confirmation change invalidates the old instance so the next call sees the
  // current snapshot rather than the one it was first built with.
  async function getBackend(backendId, snapshot, operation) {
    const generation = isLegacyProfile(snapshot) ? 0 : (snapshot.credentialGeneration ?? 1);
    const policyGeneration = isLegacyProfile(snapshot) ? 0 : (snapshot.policyGeneration ?? 0);
    const key = `${backendId}:${snapshot.id}:${generation}:${policyGeneration}`;
    if (backendCache.has(key)) return await backendCache.get(key);

    const factory = factories?.[backendId];
    if (typeof factory !== 'function') {
      throw new OperationError('BACKEND_UNAVAILABLE', `The ${backendId} backend is not available in this installation.`, {
        safeDetails: { backend: backendId, reason: 'backend_not_available' },
      });
    }
    const accountKey = !isLegacyProfile(snapshot) ? snapshot.accountKey : null;
    const promise = (async () => {
      const legacy = legacyConfigState();
      const result = await factory({
        snapshot,
        settings: runtimeSettings,
        operation,
        cacheGeneration: accountKey ? cacheGenerationFor(accountKey) : null,
        env,
        secretStore,
        browserSessions,
        tasks,
        fetch,
        clock,
        legacyConfig: legacy.ok ? legacy.config : null,
      });
      const entry = { ...normalizeBackendHandle(result, backendId), profileId: snapshot.id, generation };
      // Close any earlier instance for this backend/profile (for example, the previous credential
      // generation) after the replacement is ready.
      for (const [otherKey, other] of [...backendCache]) {
        if (otherKey === key) continue;
        if (!otherKey.startsWith(`${backendId}:${snapshot.id}:`)) continue;
        backendCache.delete(otherKey);
        await closeEntry(await other.catch(() => null));
      }
      return entry;
    })();
    backendCache.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      backendCache.delete(key);
      throw error;
    }
  }

  // The abort check runs on every revalidation, including the boundary's commit-phase check, so a
  // cancellation that arrives while a write waits for its slot still prevents the dispatch.
  function revalidateFor(snapshot, signal = null) {
    return async ({ phase }) => {
      if (signal?.aborted) throw cancelledError();
      if (!registry || isLegacyProfile(snapshot)) return;
      const check = await registry.checkSnapshot(snapshot);
      if (!check.exists) {
        throw new OperationError('PROFILE_NOT_FOUND', 'The profile was removed after this operation started; nothing was dispatched.', {
          safeDetails: { profileId: snapshot.id, phase },
        });
      }
      if (check.identityChanged) {
        throw new OperationError('IDENTITY_MISMATCH', 'The profile identity changed after this operation started; nothing was dispatched.', {
          safeDetails: { profileId: snapshot.id, phase },
        });
      }
      if (check.policyChanged || check.credentialChanged) {
        throw new OperationError('POLICY_CHANGED', 'The profile security or credentials changed after this operation started; nothing was dispatched.', {
          safeDetails: { profileId: snapshot.id, phase },
        });
      }
    };
  }

  function supportOf(capabilities, operation) {
    if (!capabilities || typeof capabilities !== 'object') return { supported: true, appOnly: false };
    const appOnly = capabilities.appOnly === true || capabilities.readOnly === true && operation.kind === 'write';
    const list = operation.kind === 'write' ? capabilities.writes : capabilities.reads;
    const supported = !Array.isArray(list) || list.includes(operation.tool);
    return { supported, appOnly };
  }

  async function executeOffline(operation) {
    const data = lookupTerm(operation.args.term);
    return normalizeBackendResult(data, { backend: 'offline', completeness: 'complete', missingFields: [], profile: null });
  }

  async function executeRss(operation) {
    const userAgent = typeof runtimeSettings.userAgent === 'string' && runtimeSettings.userAgent
      ? runtimeSettings.userAgent
      : `node:reddit-cli:${VERSION}`;
    let entries;
    try {
      entries = await browseSubredditRss({ ...operation.args, fetch, userAgent });
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : '';
      if (/throttl/i.test(message)) {
        throw new OperationError('THROTTLED', message, { safeDetails: { backend: 'rss' } });
      }
      throw new OperationError('BACKEND_UNAVAILABLE', message || 'The public feed request failed.', {
        safeDetails: { backend: 'rss' },
      });
    }
    return normalizeBackendResult(entries, {
      backend: 'rss',
      completeness: 'partial',
      missingFields: ['score', 'commentCount'],
      profile: null,
    });
  }

  function resultMeta(backendId, snapshot, extra = {}) {
    return {
      ...extra,
      backend: backendId,
      profile: extra.profile ?? snapshot.alias ?? null,
      username: extra.username ?? snapshot.username ?? snapshot.expectedUsername ?? null,
    };
  }

  function splitBackendResult(value) {
    if (isPlainObject(value) && Object.hasOwn(value, 'data') && Object.hasOwn(value, 'meta')) {
      return { data: value.data, meta: isPlainObject(value.meta) ? value.meta : {} };
    }
    return { data: value, meta: {} };
  }

  async function executeRead(backendId, handle, snapshot, operation, context, options) {
    const capabilities = typeof handle.backend.capabilities === 'function'
      ? await handle.backend.capabilities(context)
      : null;
    const support = supportOf(capabilities, operation);
    if (support.appOnly && !support.supported) {
      throw new OperationError(
        'APP_ONLY_READ_ONLY',
        'This app-only API profile has no user account for this read. It is not promoted to a browser session automatically.',
        { safeDetails: { backend: backendId } },
      );
    }
    if (!support.supported) {
      throw new OperationError('UNSUPPORTED_OPERATION', `The ${backendId} backend does not implement ${operation.tool}.`, {
        safeDetails: { backend: backendId, tool: operation.tool },
      });
    }
    await revalidateFor(snapshot, options.signal)({ phase: 'read' });
    if (options.signal?.aborted) throw cancelledError();
    const invoke = () => handle.backend.read(operation, context);
    // A browser backend exposes one serialized task queue per profile. Serializing the whole call
    // prevents a concurrent read from navigating the shared page under another call.
    const raw = typeof handle.backend.exclusive === 'function'
      ? await handle.backend.exclusive(invoke)
      : await invoke();
    const { data, meta } = splitBackendResult(raw);
    return normalizeBackendResult(data, resultMeta(backendId, snapshot, meta));
  }

  async function reconcileIdentity(probe, snapshot) {
    const normalized = normalizeProbe(probe);
    if (normalized?.appOnly) {
      throw new OperationError('APP_ONLY_READ_ONLY', 'This is an app-only API profile: it has no user account and cannot write.', {
        safeDetails: { backend: 'api' },
      });
    }
    if (!normalized || !normalized.accountKey || normalized.verified === false) {
      throw new OperationError('IDENTITY_UNVERIFIED', 'The backend could not verify a Reddit account for this write; nothing was sent.', {
        safeDetails: { profileId: snapshot.id },
      });
    }
    if (snapshot.accountKey && snapshot.accountKey !== normalized.accountKey) {
      throw new OperationError('IDENTITY_MISMATCH', 'The verified backend account does not match this profile; nothing was sent.', {
        safeDetails: { profileId: snapshot.id },
      });
    }
    let accountKey = normalized.accountKey;
    if (accounts && normalized.username) {
      const existing = await accounts.lookup({ accountId: normalized.accountId, username: normalized.username });
      if (existing?.accountKey) accountKey = existing.accountKey;
    }
    return { ...normalized, accountKey };
  }

  async function executeWrite(backendId, handle, snapshot, operation, baseContext, options) {
    if (options.signal?.aborted) throw cancelledError();
    const capabilities = typeof handle.backend.capabilities === 'function'
      ? await handle.backend.capabilities(baseContext)
      : null;
    const support = supportOf(capabilities, operation);
    if (support.appOnly) {
      throw new OperationError(
        'APP_ONLY_READ_ONLY',
        'This is an app-only API profile: it is read-only and is not promoted to a browser session to enable a write.',
        { safeDetails: { backend: backendId } },
      );
    }
    if (!support.supported) {
      throw new OperationError('UNSUPPORTED_OPERATION', `The ${backendId} backend does not implement ${operation.tool}.`, {
        safeDetails: { backend: backendId, tool: operation.tool },
      });
    }

    // Identity is a separate, classified step: profile status alone never proves who will perform a write.
    const account = await reconcileIdentity(await handle.backend.probe(baseContext), snapshot);

    const cacheGeneration = cacheGenerationFor(account.accountKey);
    const ledger = ledgerFor(account.accountKey, cacheGeneration);
    const policy = effectiveApprovalPolicy(runtimeSettings, snapshot);
    const boundary = createWriteBoundary({
      ledger,
      policy,
      approvalStore: approvals,
      revalidate: revalidateFor(snapshot, options.signal),
      clock,
      ...(sleep !== undefined ? { sleep } : {}),
      cacheGeneration,
    });
    const boundaryOperation = options.requestConfirmation
      ? Object.freeze({ ...operation, args: Object.freeze({ ...operation.args, confirm: true }) })
      : operation;
    const context = Object.freeze({
      ...baseContext,
      profile: snapshot,
      accountKey: account.accountKey,
      backendId,
      verified: true,
      username: account.username,
      authMode: 'oauth',
    });

    const runBoundary = () => boundary.run({
      operation: boundaryOperation,
      context,
      // The compatibility `confirm` flag is boundary evidence only; it is never passed to an adapter
      // as a form field.
      prepare: ({ operation: frozen }) => {
        const { confirm, ...args } = frozen.args ?? {};
        return handle.backend.prepareWrite(Object.freeze({ ...frozen, args: Object.freeze(args) }), context);
      },
      commit: (prepared) => handle.backend.commitWrite(prepared, context),
    });
    // A browser write holds its profile's serialized queue from preparation through the one commit,
    // so another call cannot navigate between the commit recheck and the click.
    const result = typeof handle.backend.exclusive === 'function'
      ? await handle.backend.exclusive(runBoundary)
      : await runBoundary();
    return Object.freeze(normalizeBackendResult(result.data, {
      ...result.meta,
      username: result.meta.username ?? account.username,
    }));
  }

  // The raw API escape hatch is official-API-only and still passes through the shared write
  // boundary. It is not a Reddit tool, so it has its own `raw_post` policy/admission key and no
  // capability advertisement beyond this explicit method.
  async function executeRaw({ method = 'POST', path, fields = {} } = {}, options = {}) {
    const verb = String(method ?? '').toUpperCase();
    if (verb !== 'POST') {
      throw new OperationError('UNSUPPORTED_OPERATION', 'The dispatcher raw route accepts only POST; use a read tool for GET.', {
        safeDetails: { reason: 'raw_method_unsupported' },
      });
    }
    if (!isPlainObject(options)) throw new TypeError('executeRaw options must be an object.');
    const { profile: explicitProfile = null, requestConfirmation = false, signal = null } = options;
    if (requestConfirmation !== false) {
      throw new OperationError('APPROVAL_REQUIRED', 'A local approval is prepared by the CLI, not by a requestConfirmation flag on a raw call.');
    }
    const operation = Object.freeze({
      tool: 'raw_post',
      action: 'raw',
      kind: 'write',
      policyKey: 'raw_post',
      target: `raw:POST:${String(path ?? '')}`,
      requiresIdentity: true,
      contentHash: null,
      args: Object.freeze({ method: 'POST', path, fields: Object.freeze({ ...fields }) }),
    });
    const snapshot = await resolveFor(explicitProfile);
    if (!enabledBackendsOf(snapshot).includes('api')) {
      throw new OperationError('BACKEND_UNAVAILABLE', 'The raw API command is official-API-only and the api backend is not enabled for this profile.', {
        safeDetails: { backend: 'api', profileId: snapshot.id },
      });
    }
    const callId = nextCallId();
    const baseContext = Object.freeze({ callId, profile: snapshot, operation, signal, accountKey: snapshot.accountKey ?? null, verified: false });
    const handle = await getBackend('api', snapshot, operation);
    const account = await reconcileIdentity(await handle.backend.probe(baseContext), snapshot);
    const cacheGeneration = cacheGenerationFor(account.accountKey);
    const ledger = ledgerFor(account.accountKey, cacheGeneration);
    const boundary = createWriteBoundary({
      ledger,
      policy: effectiveApprovalPolicy(runtimeSettings, snapshot),
      approvalStore: approvals,
      revalidate: revalidateFor(snapshot, signal),
      clock,
      ...(sleep !== undefined ? { sleep } : {}),
      cacheGeneration,
    });
    const context = Object.freeze({
      ...baseContext,
      profile: snapshot,
      accountKey: account.accountKey,
      backendId: 'api',
      verified: true,
      username: account.username,
      authMode: 'oauth',
    });
    const result = await boundary.run({
      operation,
      context,
      prepare: () => handle.backend.prepareWrite(operation, context),
      commit: (prepared) => handle.backend.commitWrite(prepared, context),
    });
    return Object.freeze(normalizeBackendResult(result.data, {
      ...result.meta,
      username: result.meta.username ?? account.username,
    }));
  }

  async function attempt(candidates, runOne, phase) {
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const backendId = candidates[index];
      const hasMore = index < candidates.length - 1;
      try {
        return await runOne(backendId);
      } catch (error) {
        const classified = classifyError(error, { phase, backendId });
        const preDispatch = (error?.outcome ?? null) === null;
        if (classified.fallback && preDispatch && hasMore) {
          lastError = classified.error;
          continue;
        }
        throw classified.error;
      }
    }
    throw lastError;
  }

  async function execute(tool, args = {}, options = {}) {
    if (!isPlainObject(options)) throw new TypeError('execute options must be an object.');
    const {
      profile: explicitProfile = null,
      backend: explicitBackend = null,
      requestConfirmation = false,
      continuation = null,
      signal = null,
    } = options;
    if (typeof requestConfirmation !== 'boolean') throw new TypeError('requestConfirmation must be a boolean.');
    if (continuation !== null && continuation !== undefined && typeof continuation !== 'string') {
      throw new TypeError('continuation must be a string token or null.');
    }
    // describeOperation produces the canonical UNSUPPORTED_OPERATION error for an unknown tool.
    const operation = describeOperation(tool, args, runtimeSettings);
    // An aborted call must not perform even a local read or a public feed request.
    if (signal?.aborted) throw cancelledError();
    // A continuation never applies to a write, an offline lookup, or a public feed.
    if (continuation !== null && continuation !== undefined && operation.kind !== 'read') {
      throw continuationRefusal(
        'Only a paged read accepts a UI continuation. Remove the token and run the operation normally.',
        'continuation_not_supported',
        { tool: operation.tool },
      );
    }
    if (operation.kind === 'offline') return executeOffline(operation);
    if (operation.kind === 'rss') return executeRss(operation);

    const snapshot = await resolveFor(explicitProfile);
    // Validate the token against this frozen profile and query before any backend is constructed.
    if (continuation !== null && continuation !== undefined) {
      validateContinuation({ operation, snapshot, continuations, token: continuation });
    }
    const requested = explicitBackend ?? runtimeSettings.backendPreference ?? 'auto';
    if (typeof requested !== 'string' || !BACKEND_MODES.includes(requested)) {
      throw new TypeError(`backend must be one of ${BACKEND_MODES.join(', ')}.`);
    }
    const candidates = selectCandidates(snapshot, requested);
    if (candidates.length === 0) {
      throw new OperationError('BACKEND_UNAVAILABLE', 'This profile has no enabled backend for this operation.', {
        safeDetails: { profileId: snapshot.id, enabledBackends: enabledBackendsOf(snapshot) },
      });
    }

    const callId = nextCallId();
    const baseContext = Object.freeze({ callId, profile: snapshot, operation, signal, accountKey: snapshot.accountKey ?? null, verified: false });

    // Validate the confirmation policy before any backend is constructed or called. A mis-shaped
    // policy fails closed here and is never converted into a retryable-looking backend failure.
    if (operation.kind === 'write') effectiveApprovalPolicy(runtimeSettings, snapshot);

    return attempt(candidates, async (backendId) => {
      if (signal?.aborted) throw cancelledError();
      const handle = await getBackend(backendId, snapshot, operation);
      if (operation.kind === 'write') {
        return executeWrite(backendId, handle, snapshot, operation, baseContext, { requestConfirmation, signal });
      }
      return executeRead(backendId, handle, snapshot, operation, baseContext, { signal });
    }, operation.kind === 'write' ? 'write' : 'read');
  }

  // A legacy snapshot has no bound account key, but an API write's ledger is keyed by the verified
  // username-derived key. Use the same derivation so pending uncertainty is not invisible.
  function accountKeyFor(snapshot) {
    if (typeof snapshot.accountKey === 'string' && snapshot.accountKey !== '') return snapshot.accountKey;
    const name = snapshot.username ?? snapshot.expectedUsername ?? null;
    return typeof name === 'string' && name.trim() !== '' ? deriveAccountKey(usernameKey(name)) : null;
  }

  async function pendingAttempts(selector = null) {
    const snapshot = await resolveFor(selector);
    const accountKey = accountKeyFor(snapshot);
    if (!accountKey) return Object.freeze([]);
    return ledgerFor(accountKey, cacheGenerationFor(accountKey)).listPending();
  }

  async function resolveAttempt(selector, attemptId, resolution) {
    const snapshot = await resolveFor(selector);
    const accountKey = accountKeyFor(snapshot);
    if (!accountKey) {
      throw new OperationError('IDENTITY_UNVERIFIED', 'This profile has no verified account key, so its pending writes cannot be resolved. Bind the account first.', {
        safeDetails: { profileId: snapshot.id },
      });
    }
    return ledgerFor(accountKey, cacheGenerationFor(accountKey)).resolveLocally(attemptId, resolution);
  }

  async function status(selector = null) {
    const snapshot = await resolveFor(selector);
    const policy = effectiveApprovalPolicy(runtimeSettings, snapshot);
    const accountKey = accountKeyFor(snapshot);
    let pending = [];
    if (accountKey) {
      pending = await ledgerFor(accountKey, cacheGenerationFor(accountKey)).listPending();
    }
    const defaultProfile = registry ? await registry.get(null) : null;
    return Object.freeze({
      profile: Object.freeze({
        id: snapshot.id,
        alias: snapshot.alias ?? null,
        isLegacy: isLegacyProfile(snapshot),
        isDefault: isLegacyProfile(snapshot) ? false : Boolean(snapshot.isDefault),
        expectedUsername: snapshot.expectedUsername ?? null,
        username: snapshot.username ?? null,
        accountKey: snapshot.accountKey ?? null,
        accountId: snapshot.accountId ?? null,
        bound: Boolean(snapshot.accountKey),
      }),
      defaultProfile: defaultProfile?.alias ?? null,
      enabledBackends: Object.freeze(enabledBackendsOf(snapshot)),
      backendPreference: Object.freeze([...(snapshot.backendPreference ?? [])]),
      visibility: snapshot.visibility ?? runtimeSettings.visibility,
      passwordLoginEnabled: snapshot.passwordLoginEnabled === true,
      confirmations: Object.freeze({ ...(snapshot.confirmations ?? {}) }),
      api: Object.freeze({
        clientId: snapshot.api?.clientId ?? null,
        appType: snapshot.api?.appType ?? null,
      }),
      approvalPolicy: policy,
      pendingAttempts: pending,
    });
  }

  async function closeProfile(selector) {
    const isLegacySelector = typeof selector === 'string'
      && selector.trim().toLowerCase() === LEGACY_PROFILE_ID;
    const profileId = isLegacySelector
      ? LEGACY_PROFILE_ID
      : (registry
        ? (await registry.snapshot(selector)).id
        : (typeof selector === 'string' ? selector : null));
    if (!profileId) throw new TypeError('closeProfile needs a profile id or alias.');
    const closedBackends = [];
    for (const [key, promise] of [...backendCache]) {
      const [backendName, entryProfileId] = key.split(':');
      if (entryProfileId !== profileId) continue;
      const entry = await promise.catch(() => null);
      if (!entry || entry.profileId !== profileId) continue;
      backendCache.delete(key);
      closedBackends.push(backendName);
      await closeEntry(entry);
    }
    let browser = null;
    if (browserSessions && typeof browserSessions.close === 'function') {
      try {
        browser = await browserSessions.close(profileId);
      } catch (error) {
        if (error?.code === 'PROFILE_IN_USE') throw error;
        throw new OperationError('BACKEND_UNAVAILABLE', 'The browser session for this profile could not be closed safely.', {
          safeDetails: { profileId, reason: 'close_failed' },
        });
      }
    }
    return Object.freeze({ profileId, closedBackends: Object.freeze(closedBackends), browser });
  }

  async function close() {
    const entries = [...backendCache.entries()];
    backendCache.clear();
    for (const [, promise] of entries) {
      await closeEntry(await promise.catch(() => null));
    }
    let browser = null;
    if (browserSessions && typeof browserSessions.closeAll === 'function') {
      browser = await browserSessions.closeAll();
    }
    return Object.freeze({ closed: true, backends: entries.length, browser });
  }

  // `continuationStore` tells a local surface (MCP) whether this dispatcher can validate a UI cursor.
  // It never makes resume itself available: validateContinuation still refuses with a typed reason
  // until the rendered-UI adapters can restore a bound page.
  return Object.freeze({ execute, executeRaw, status, pendingAttempts, resolveAttempt, closeProfile, close, continuationStore: Boolean(continuations) });
}
