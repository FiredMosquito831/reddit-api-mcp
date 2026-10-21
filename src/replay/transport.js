// Experimental replay transport: one scoped request at a time against the profile's own Reddit web
// session. It is deliberately not a general HTTP client.
//
// * Destinations are limited to the configured first-party origin(s), and paths to the finite
//   prefixes used by the evidenced mappings.
// * Credentials come only from the live Playwright request context (its cookie jar) and, for writes,
//   the X-Modhash value read from that same session's /api/me.json. The modhash is read afresh for
//   every mutation.
// * The session identity is checked before every request. A write always re-probes the live session
//   immediately before its single mutation; a read may reuse a recent verification for a bounded
//   window. A session that the session manager closed (idle sweep) is detected and reopened once for
//   an idempotent GET; a mutation is never resent.
// * Callers cannot supply a path, method, header, cookie, or body outside the mapping's own builders.
// * Redirects are handled manually and only for GET; a mutation redirect is never followed, so a
//   single write is never dispatched twice.
// * Errors carry canonical codes and small machine-readable details. Response bodies, cookies,
//   Set-Cookie headers, and modhash values never enter an error, result, or log.

import { deriveAccountKey, usernameKey } from '../accounts.js';
import { OperationError, OUTCOMES } from '../errors.js';
import { REPLAY_ORIGIN } from './mappings.js';

export const DEFAULT_REPLAY_TIMEOUT_MS = 15_000;
// A read reuses one verified identity for a bounded window. Writes never reuse it: they re-probe the
// live session immediately before the single mutation, because a visible profile can be signed out
// and back in as another account between operations.
export const DEFAULT_IDENTITY_TTL_MS = 60_000;
export const MAX_REPLAY_REDIRECTS = 3;
export const MAX_REPLAY_BODY_BYTES = 4_000_000;

const ALLOWED_PATH_PREFIXES = Object.freeze(['/api/', '/r/', '/u/', '/user/', '/comments/', '/subreddits/']);
const ALLOWED_EXACT_PATHS = new Set(['/', '/.json', '/search.json']);
const FORBIDDEN_MAPPING_KEYS = Object.freeze(['path', 'query', 'form', 'headers', 'cookies', 'authorization']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.join(', ');
    return typeof value === 'string' ? value : String(value ?? '');
  }
  return '';
}

function replayError(code, message, { outcome = null, reason, tool = null, status = null, retryAfterMs = null } = {}) {
  return new OperationError(code, message, {
    outcome,
    retryAfterMs,
    safeDetails: { backend: 'replay', reason, ...(tool ? { tool } : {}), ...(status ? { status } : {}) },
  });
}

function unsupported(message, reason = 'mapping_not_allowed') {
  return replayError('UNSUPPORTED_OPERATION', message, { reason });
}

function unknownWrite(message, reason, { tool = null, status = null } = {}) {
  return replayError('OUTCOME_UNKNOWN', message, {
    outcome: OUTCOMES.OUTCOME_UNKNOWN,
    reason,
    tool,
    status,
  });
}

function normalizeOrigins(allowedDestinations) {
  const input = allowedDestinations === undefined ? [REPLAY_ORIGIN] : allowedDestinations;
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('allowedDestinations must be a non-empty array of HTTPS origins.');
  }
  const origins = new Set();
  for (const value of input) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('allowedDestinations entries must be absolute HTTPS origins.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
      throw new TypeError('allowedDestinations entries must be bare HTTPS origins such as https://www.reddit.com.');
    }
    origins.add(url.origin);
  }
  return origins;
}

function parseAllowedUrl(raw, origins, { outcome = null, tool = null } = {}) {
  let url;
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw));
  } catch {
    throw replayError('UNSUPPORTED_OPERATION', 'The replay destination was not a valid URL.', {
      outcome,
      reason: 'destination_invalid',
      tool,
    });
  }
  if (url.protocol !== 'https:' || !origins.has(url.origin) || url.username || url.password || url.hash) {
    throw replayError('UNSUPPORTED_OPERATION', 'The replay destination is outside the first-party allowlist.', {
      outcome,
      reason: 'destination_not_allowed',
      tool,
    });
  }
  const path = url.pathname;
  const lowered = path.toLowerCase();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').includes('..') || lowered.includes('%2e%2e') || lowered.includes('%2f') || lowered.includes('%5c')) {
    throw replayError('UNSUPPORTED_OPERATION', 'The replay path is outside the finite allowlist.', {
      outcome,
      reason: 'path_not_allowed',
      tool,
    });
  }
  if (!ALLOWED_EXACT_PATHS.has(path) && !ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw replayError('UNSUPPORTED_OPERATION', 'The replay path is outside the finite allowlist.', {
      outcome,
      reason: 'path_not_allowed',
      tool,
    });
  }
  url.hash = '';
  return url;
}

function mappingRequest(mapping, input, options) {
  if (!isObject(mapping) || typeof mapping.build !== 'function') {
    throw unsupported('The replay transport only accepts an explicit mapping object.');
  }
  if (mapping.method !== 'GET' && mapping.method !== 'POST') {
    throw unsupported('The replay transport only supports mapped GET and POST requests.');
  }
  for (const key of FORBIDDEN_MAPPING_KEYS) {
    if (Object.hasOwn(mapping, key)) {
      throw unsupported('A replay mapping may not carry caller-supplied transport fields.');
    }
  }
  const built = mapping.build(input ?? {}, options ?? {});
  if (!isObject(built)) throw unsupported('A replay mapping must build one request.');
  const method = String(built.method ?? '').toUpperCase();
  if (method !== mapping.method || (method !== 'GET' && method !== 'POST')) {
    throw unsupported('A replay mapping must build the method it declares.');
  }
  if (typeof built.path !== 'string' || !built.path.startsWith('/')
    || built.path.includes('?') || built.path.includes('#')) {
    throw unsupported('A replay mapping must build a single absolute path without a query or fragment.');
  }
  if (built.form !== undefined && built.form !== null && !isObject(built.form)) {
    throw unsupported('A replay mapping form must be a flat object.');
  }
  if (method === 'GET' && built.form) throw unsupported('A replay GET mapping may not carry a form body.');
  const query = built.query ?? {};
  if (!isObject(query)) throw unsupported('A replay mapping query must be an object.');
  for (const value of Object.values(query)) {
    if (typeof value !== 'string') throw unsupported('A replay mapping query value must be a string.');
  }
  return { method, path: built.path, query, form: built.form ?? null, origin: built.origin };
}

function classifyStatus(response, { method, tool }) {
  const status = Number(response.status);
  const contentType = String(response.contentType ?? '').toLowerCase();
  const text = typeof response.text === 'string' ? response.text : '';
  const isHtml = contentType.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(text);
  const isWrite = method !== 'GET';
  const retryAfterMs = (() => {
    const raw = headerValue(response.headers, 'retry-after');
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  })();

  if (status === 429) {
    return replayError('THROTTLED', 'Reddit is throttling this session. Wait, then try again; the operation was not rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'rate_limited',
      tool,
      status,
      retryAfterMs,
    });
  }
  if (status === 401) {
    return replayError('LOGIN_REQUIRED', 'The replay session is no longer signed in. Sign in again in the visible browser window; nothing was rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'session_expired',
      tool,
      status,
    });
  }
  if (status === 403) {
    if (isHtml) {
      return replayError('USER_HANDOFF_REQUIRED', 'Reddit showed a security challenge or block page. A person must complete it in the visible browser; no automatic solve or alternate route was attempted.', {
        outcome: OUTCOMES.FAILED_KNOWN,
        reason: 'security_challenge',
        tool,
        status,
      });
    }
    return replayError('BACKEND_UNAVAILABLE', 'Reddit rejected this replay request. It was not rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'server_rejection',
      tool,
      status,
    });
  }
  if (status >= 500) {
    if (isWrite) {
      return unknownWrite('Reddit returned a server error to the replay write. Its outcome is unknown and it will not be resent.', 'server_error', { tool, status });
    }
    return replayError('BACKEND_UNAVAILABLE', 'Reddit returned a server error to the replay request. It was not rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'server_error',
      tool,
      status,
    });
  }
  if (status === 404) {
    return replayError('BACKEND_UNAVAILABLE', 'The replay request found no matching Reddit content. It was not rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'not_found',
      tool,
      status,
    });
  }
  if (status < 200 || status >= 300) {
    return replayError('BACKEND_UNAVAILABLE', 'The replay request was rejected before it could complete.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'request_rejected',
      tool,
      status,
    });
  }
  if (isHtml) {
    if (isWrite) {
      return unknownWrite('The replay write received an HTML page instead of JSON. Its outcome is unknown and it will not be resent.', 'unexpected_html', { tool, status });
    }
    return replayError('USER_HANDOFF_REQUIRED', 'The replay response was an HTML page instead of Reddit JSON. Use the visible browser window to inspect it; nothing was rerouted.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'unexpected_html',
      tool,
      status,
    });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (isWrite) {
      return unknownWrite('The replay write response was not valid JSON. Its outcome is unknown and it will not be resent.', 'invalid_response', { tool, status });
    }
    return replayError('BACKEND_UNAVAILABLE', 'The replay response was not valid JSON. Nothing was retried through another route.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'invalid_response',
      tool,
      status,
    });
  }
  return { status, json };
}

async function readResponse(response) {
  const status = typeof response?.status === 'function' ? response.status() : response?.status;
  const headers = typeof response?.headers === 'function' ? (response.headers() ?? {}) : (response?.headers ?? {});
  let text = '';
  if (typeof response?.text === 'function') {
    text = await response.text();
  } else if (typeof response?.body === 'function') {
    const body = await response.body();
    text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  }
  if (typeof text !== 'string') text = String(text ?? '');
  return {
    status,
    headers,
    contentType: headerValue(headers, 'content-type'),
    text: text.slice(0, MAX_REPLAY_BODY_BYTES),
  };
}

function validateRequestContext(context) {
  if (!context) return null;
  if (typeof context.fetch === 'function') return context;
  if (typeof context.get === 'function' || typeof context.post === 'function') return context;
  return null;
}

export function createReplayTransport({
  sessionManager = null,
  secretStore = null,
  allowedDestinations,
  requestFactory = null,
  settings = {},
  clock = () => Date.now(),
  timeoutMs = DEFAULT_REPLAY_TIMEOUT_MS,
  identityTtlMs = DEFAULT_IDENTITY_TTL_MS,
} = {}) {
  if (!sessionManager && typeof requestFactory !== 'function') {
    throw new TypeError('createReplayTransport needs a session manager or a request instance factory.');
  }
  if (sessionManager !== null && (typeof sessionManager !== 'object' || typeof sessionManager.open !== 'function')) {
    throw new TypeError('sessionManager must expose open().');
  }
  if (requestFactory !== null && typeof requestFactory !== 'function') {
    throw new TypeError('requestFactory must be a function.');
  }
  if (secretStore !== null && typeof secretStore !== 'object') {
    throw new TypeError('secretStore must be an object when supplied.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number.');
  if (!Number.isFinite(identityTtlMs) || identityTtlMs < 0) throw new TypeError('identityTtlMs must be a non-negative number.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');

  const origins = normalizeOrigins(allowedDestinations);
  let cachedContext = null;
  let cachedIdentity = null;
  let identityCheckedAt = null;
  let identityPromise = null;

  // Every cached value belongs to one live session. A session that closed (for example the session
  // manager's idle sweep) invalidates all of it, including the modhash, so the next operation
  // reopens through the session manager instead of reusing a disposed Playwright context.
  function resetSessionCache() {
    cachedContext = null;
    cachedIdentity = null;
    identityCheckedAt = null;
    identityPromise = null;
  }

  function profileOf(context) {
    const profile = context?.profile;
    if (!isObject(profile) || typeof profile.id !== 'string' || profile.id.length === 0) {
      throw replayError('PROFILE_REQUIRED', 'The replay transport needs the frozen profile context.', {
        reason: 'profile_required',
      });
    }
    return profile;
  }

  function visibilityOf(profile) {
    const requested = profile.visibility ?? settings?.visibility ?? 'visible';
    return typeof requested === 'string' && requested.length > 0 ? requested : 'visible';
  }

  async function ensureContext(context) {
    if (cachedContext) return cachedContext;
    const profile = profileOf(context);
    let raw = null;
    if (typeof requestFactory === 'function') {
      try {
        raw = await requestFactory({ profileId: profile.id, profile, context });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw replayError('BACKEND_UNAVAILABLE', 'The configured replay request session could not be opened. Nothing was installed or retried.', {
          reason: 'request_session_unavailable',
        });
      }
    } else {
      let session;
      try {
        session = await sessionManager.open(profile, { visibility: visibilityOf(profile) });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw replayError('BACKEND_UNAVAILABLE', 'The dedicated browser profile could not be opened for replay. Nothing was installed automatically.', {
          reason: 'session_unavailable',
        });
      }
      raw = session?.requestContext ?? null;
    }
    const valid = validateRequestContext(raw);
    if (!valid) {
      throw replayError('BROWSER_DEPENDENCY_MISSING', 'The browser session has no request context, so the replay transport cannot reuse its cookies. Nothing was installed automatically.', {
        reason: 'request_context_missing',
      });
    }
    cachedContext = valid;
    return cachedContext;
  }

  function verifyIdentity(profile, identity) {
    const expected = profile.expectedUsername ?? profile.username ?? null;
    if (typeof expected === 'string' && expected.length > 0
      && (typeof identity.username !== 'string' || usernameKey(expected) !== usernameKey(identity.username))) {
      throw replayError('IDENTITY_MISMATCH', "The signed-in Reddit account does not match this profile's expected account. Nothing was sent.", {
        reason: 'identity_mismatch',
      });
    }
    if (typeof profile.accountKey === 'string' && profile.accountKey.length > 0
      && typeof identity.accountKey === 'string' && identity.accountKey.length > 0
      && profile.accountKey !== identity.accountKey) {
      throw replayError('IDENTITY_MISMATCH', 'The signed-in Reddit account is bound to a different profile account. Nothing was sent.', {
        reason: 'identity_mismatch',
      });
    }
  }

  async function invoke(context, url, options) {
    try {
      if (typeof context.fetch === 'function') return await context.fetch(url, options);
      if (options.method === 'GET' && typeof context.get === 'function') {
        const { method, ...rest } = options;
        return await context.get(url, rest);
      }
      if (options.method === 'POST' && typeof context.post === 'function') {
        const { method, ...rest } = options;
        return await context.post(url, rest);
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      const isWrite = options.method !== 'GET';
      if (isWrite) {
        throw unknownWrite('The replay write request failed before a response could be read. Its outcome is unknown and it will not be resent.', 'transport_error');
      }
      throw replayError('BACKEND_UNAVAILABLE', 'The replay request failed before a response could be read. It was not retried through another route.', {
        outcome: OUTCOMES.FAILED_KNOWN,
        reason: 'transport_error',
      });
    }
    throw replayError('BROWSER_DEPENDENCY_MISSING', 'The browser request context cannot issue this method. Nothing was sent.', {
      reason: 'request_context_unsupported',
    });
  }

  async function sendOnce(context, method, url, { headers = {}, form = null } = {}) {
    const options = {
      method,
      headers,
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: timeoutMs,
    };
    if (form) options.form = form;
    const raw = await invoke(context, url.toString(), options);
    return await readResponse(raw);
  }

  async function send(context, method, url, request = {}) {
    let current = url;
    for (let hop = 0; hop <= MAX_REPLAY_REDIRECTS; hop += 1) {
      const response = await sendOnce(context, method, current, request);
      const status = Number(response.status);
      if (!(status >= 300 && status < 400)) return response;
      const location = headerValue(response.headers, 'location');
      const isWrite = method !== 'GET';
      if (isWrite) {
        // Never resend a mutation. A 3xx does not prove whether the server applied it.
        throw replayError('OUTCOME_UNKNOWN', 'The replay write received a redirect. It was not resent, so its outcome is unknown.', {
          outcome: OUTCOMES.OUTCOME_UNKNOWN,
          reason: 'mutation_redirect',
          status,
        });
      }
      if (!location) {
        throw replayError('BACKEND_UNAVAILABLE', 'The replay request redirected without a usable location. It was not followed.', {
          outcome: OUTCOMES.FAILED_KNOWN,
          reason: 'redirect_not_allowed',
          status,
        });
      }
      let next;
      try {
        next = parseAllowedUrl(new URL(location, current), origins, { outcome: OUTCOMES.FAILED_KNOWN });
      } catch {
        throw replayError('BACKEND_UNAVAILABLE', 'The replay request redirected outside the first-party allowlist. It was not followed.', {
          outcome: OUTCOMES.FAILED_KNOWN,
          reason: 'redirect_not_allowed',
          status,
        });
      }
      if (next.pathname === current.pathname && next.search === current.search) {
        throw replayError('BACKEND_UNAVAILABLE', 'The replay request redirected to itself. It was not followed repeatedly.', {
          outcome: OUTCOMES.FAILED_KNOWN,
          reason: 'redirect_loop',
          status,
        });
      }
      current = next;
    }
    throw replayError('BACKEND_UNAVAILABLE', 'The replay request exceeded its redirect limit. It was not followed further.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      reason: 'redirect_not_allowed',
    });
  }

  async function readMe(context) {
    const url = parseAllowedUrl(`${REPLAY_ORIGIN}/api/me.json`, origins);
    const response = await send(context, 'GET', url, { headers: { accept: 'application/json' } });
    const parsed = classifyStatus(response, { method: 'GET', tool: 'get_me' });
    if (parsed instanceof OperationError) throw parsed;
    const data = parsed?.json?.data;
    if (!data || typeof data.name !== 'string' || data.name.length === 0) {
      throw replayError('LOGIN_REQUIRED', 'The replay session is not signed in to Reddit. Sign in in the visible browser window; nothing was retried.', {
        reason: 'anonymous',
        tool: 'get_me',
      });
    }
    return data;
  }

  async function probeIdentity(context, { fresh = false } = {}) {
    const now = clock();
    if (!fresh && cachedIdentity && identityCheckedAt !== null && now - identityCheckedAt < identityTtlMs) {
      return cachedIdentity;
    }
    if (!identityPromise) {
      identityPromise = (async () => {
        const profile = profileOf(context);
        const active = await ensureContext(context);
        let identity;
        if (typeof sessionManager?.identity === 'function') {
          const raw = await sessionManager.identity(profile.id);
          identity = {
            username: raw?.username ?? null,
            accountId: raw?.accountId ?? null,
            accountKey: raw?.accountKey ?? null,
          };
          if (typeof identity.username !== 'string' || identity.username.length === 0) {
            throw replayError('IDENTITY_UNVERIFIED', 'The browser session did not report a verified Reddit username. Nothing was sent.', {
              reason: 'identity_unverified',
            });
          }
        } else {
          const data = await readMe(active);
          identity = {
            username: data.name,
            accountId: typeof data.id === 'string' ? `t2_${data.id}` : null,
            accountKey: null,
          };
        }
        verifyIdentity(profile, identity);
        identity.accountKey = identity.accountKey ?? deriveAccountKey(usernameKey(identity.username));
        const record = Object.freeze({ ...identity, verified: true, appOnly: false, identity: 'user' });
        cachedIdentity = record;
        identityCheckedAt = clock();
        return record;
      })().catch((error) => {
        identityPromise = null;
        throw error;
      });
    }
    try {
      return await identityPromise;
    } finally {
      identityPromise = null;
    }
  }

  // The modhash is read from this session's own /api/me.json for every mutation. It is never cached:
  // a cached value belongs to whichever account was signed in when it was read.
  async function modhashFor(context) {
    const data = await readMe(context);
    return typeof data.modhash === 'string' && data.modhash.length > 0 ? data.modhash : null;
  }

  function buildUrl(built) {
    const base = parseAllowedUrl(`${REPLAY_ORIGIN}${built.path}`, origins);
    for (const [key, value] of Object.entries(built.query)) base.searchParams.set(key, value);
    return parseAllowedUrl(base, origins);
  }

  // A cached request context or identity is only as live as the browser session behind it. The
  // session manager may close an idle session at any time, which disposes the Playwright context.
  // These are the failures that prove the session is gone rather than Reddit refusing the request.
  function isDeadSessionError(error) {
    if (!(error instanceof OperationError)) return false;
    if (error.code === 'PROFILE_NOT_FOUND') return true;
    return error.code === 'BACKEND_UNAVAILABLE' && error.safeDetails?.reason === 'transport_error';
  }

  async function performRequest(built, url, context, tool) {
    const activeContext = await ensureContext(context);
    // Every mapped request is tied to the profile's verified session identity, including get_me, so
    // a wrong-account browser profile can never return or mutate as this profile. A write re-probes
    // the live session immediately before it is sent; a read may reuse a recent verification.
    const isWrite = built.method !== 'GET';
    await probeIdentity(context, { fresh: isWrite });

    const headers = { accept: 'application/json' };
    if (isWrite) {
      const sessionModhash = await modhashFor(activeContext);
      if (!sessionModhash) {
        throw replayError('USER_HANDOFF_REQUIRED', 'The replay session has no modhash, so a web write cannot be authenticated. Complete sign-in in the visible browser window; nothing was sent.', {
          reason: 'modhash_unavailable',
          tool,
        });
      }
      headers['X-Modhash'] = sessionModhash;
    }

    const response = await send(activeContext, built.method, url, { headers, form: built.form });
    const parsed = classifyStatus(response, { method: built.method, tool });
    if (parsed instanceof OperationError) throw parsed;
    return Object.freeze({ status: parsed.status, json: parsed.json });
  }

  async function request(mapping, input = {}, context = {}, options = {}) {
    const built = mappingRequest(mapping, input, options);
    // A mapping's declared origin is part of the finite destination allowlist. The built URL is
    // validated independently below, so neither metadata nor a forged builder can widen access.
    if (mapping.origin !== undefined && !origins.has(String(mapping.origin))) {
      throw unsupported('The replay mapping declares a destination outside the first-party allowlist.', 'destination_not_allowed');
    }
    if (built.origin !== undefined && !origins.has(String(built.origin))) {
      throw unsupported('The replay mapping built a destination outside the first-party allowlist.', 'destination_not_allowed');
    }
    const tool = typeof mapping.tool === 'string' ? mapping.tool : null;
    const url = buildUrl(built);
    const isWrite = built.method !== 'GET';

    try {
      return await performRequest(built, url, context, tool);
    } catch (error) {
      if (!isDeadSessionError(error)) throw error;
      resetSessionCache();
      // A GET is idempotent, so one reopen is safe. A mutation is never retried: a dead context can
      // mean the request never left this process, but it cannot prove that, so the error stands and
      // only the next operation gets a fresh session.
      if (isWrite) throw error;
      return await performRequest(built, url, context, tool);
    }
  }

  return Object.freeze({
    request,
    probe: probeIdentity,
    // Kept internal to this transport: no cookie, token, or request context is exposed.
    close: async () => {
      resetSessionCache();
    },
  });
}
