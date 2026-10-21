import { OUTCOMES } from './errors.js';
import { refreshAccessToken } from './oauth.js';
import { parseJson } from './util.js';

export const API_BASE = 'https://oauth.reddit.com';

const REFRESH_MARGIN_MS = 60_000;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;
// Waits up to this long are slept through; longer ones come back to the caller as an error.
const MAX_AUTO_WAIT_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

// `outcome` classifies a failed request for the write boundary: FAILED_KNOWN only when the server
// conclusively refused before doing anything, OUTCOME_UNKNOWN when the request may have been applied.
// Reads leave it null.
export class RedditError extends Error {
  constructor(message, { status, details, outcome = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'RedditError';
    this.status = status;
    this.details = details;
    this.outcome = outcome;
    this.retryAfterMs = retryAfterMs;
  }
}

// "You're doing that too much. Try again in 3 minutes." -> 180000
export function parseWaitMs(message = '') {
  const match = /try again in (\d+) (second|minute|hour)s?/i.exec(message);
  if (!match) return WINDOW_MS;
  const unitMs = { second: 1_000, minute: 60_000, hour: 3_600_000 }[match[2].toLowerCase()];
  return Number(match[1]) * unitMs;
}

// Milliseconds to wait before retrying, or null when the response is not a throttle.
function retryDelayMs(res, data) {
  if (res.status === 429) {
    const retryAfter = Number.parseFloat(res.headers.get('retry-after'));
    if (retryAfter >= 0) return retryAfter * 1000;
    const reset = Number.parseFloat(res.headers.get('x-ratelimit-reset'));
    if (reset >= 0) return reset * 1000;
    return WINDOW_MS;
  }
  // Write endpoints report throttling inside a 200 response body.
  const throttled = data?.json?.errors?.find(([code]) => code === 'RATELIMIT');
  return throttled ? parseWaitMs(throttled[1]) : null;
}

// A response that definitely did not apply the mutation: the server answered before accepting it.
// A timeout or a server-side failure may have happened after Reddit committed the change.
function statusOutcome(status) {
  return status === 408 || status === 425 || status >= 500 ? OUTCOMES.OUTCOME_UNKNOWN : OUTCOMES.FAILED_KNOWN;
}

export function createRedditClient({
  clientId,
  clientSecret = '',
  userAgent,
  store,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestsPerMinute = 60,
  cacheTtlMs = 60_000,
  maxAttempts = MAX_ATTEMPTS,
  obtainToken = null,
  readOnly = false,
  // Account-scoped cross-process invalidation. `current()` is awaited before every cached read;
  // `bump()` is awaited after a write succeeded or became uncertain.
  cacheGeneration = null,
  // Distinguishes one profile/account's cached responses from another's.
  cacheNamespace = null,
}) {
  let accessToken = null;
  let expiresAt = 0;
  let blockedUntil = 0;
  const sentAt = [];
  const cache = new Map();
  let lastRate = { remaining: null, reset: null, used: null };

  // Read the account generation without letting an unreadable generation file turn into stale hits.
  async function currentGeneration() {
    if (!cacheGeneration) return { ok: true, value: null };
    if (typeof cacheGeneration.current !== 'function') {
      throw new TypeError('cacheGeneration must expose current() and bump().');
    }
    try {
      return { ok: true, value: await cacheGeneration.current() };
    } catch {
      return { ok: false, value: null };
    }
  }

  // GET responses are reused for cacheTtlMs, but never across an account-generation change.
  function remember(key, data, generation) {
    if (cacheTtlMs <= 0) return;
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: now() + cacheTtlMs, generation });
  }

  async function cachedValue(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    const state = await currentGeneration();
    if (!state.ok) {
      cache.delete(key);
      return null;
    }
    if (state.value !== null && entry.generation !== state.value) {
      cache.delete(key);
      return null;
    }
    if (now() >= entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  // Drop every cached GET and, when an account generation is wired, advance it so other backends and
  // processes serving this account discard their copies too.
  async function invalidate({ bump = true } = {}) {
    cache.clear();
    if (!bump || !cacheGeneration) return null;
    if (typeof cacheGeneration.bump !== 'function') throw new TypeError('cacheGeneration must expose bump().');
    return cacheGeneration.bump();
  }

  async function currentToken({ force = false } = {}) {
    if (!force && accessToken && now() < expiresAt - REFRESH_MARGIN_MS) return accessToken;
    if (obtainToken) {
      const tokens = await obtainToken();
      accessToken = tokens.accessToken;
      expiresAt = now() + tokens.expiresIn * 1000;
      return accessToken;
    }
    const refreshToken = await store.getRefreshToken();
    if (!refreshToken) throw new RedditError('Not logged in. Run "reddit-cli login" first.');
    const tokens = await refreshAccessToken({ fetch, clientId, clientSecret, userAgent, refreshToken });
    if (tokens.refreshToken) await store.setRefreshToken(tokens.refreshToken);
    accessToken = tokens.accessToken;
    expiresAt = now() + tokens.expiresIn * 1000;
    return accessToken;
  }

  // Sliding one-minute window: a burst of calls waits instead of exceeding the cap.
  async function takeSlot() {
    for (;;) {
      const windowStart = now() - WINDOW_MS;
      while (sentAt.length > 0 && sentAt[0] <= windowStart) sentAt.shift();
      if (sentAt.length < requestsPerMinute) break;
      await sleep(sentAt[0] + WINDOW_MS - now());
    }
    sentAt.push(now());
  }

  function recordRate(res) {
    const remaining = Number.parseFloat(res.headers.get('x-ratelimit-remaining'));
    const reset = Number.parseFloat(res.headers.get('x-ratelimit-reset'));
    lastRate = { remaining, reset, used: Number.parseFloat(res.headers.get('x-ratelimit-used')) };
    if (remaining <= 0 && reset > 0) blockedUntil = now() + reset * 1000;
  }

  function knownFailure(message, details) {
    return new RedditError(message, { ...details, outcome: OUTCOMES.FAILED_KNOWN });
  }

  // A path is resolved against the API base, but WHATWG URL treats "\" as a slash and strips tab and
  // newline characters before parsing, so `/\host` or `/<tab>/host` would resolve to another origin and
  // the request would carry the bearer token there. Require a single leading slash, no backslash or
  // control characters, and the API origin itself.
  function apiUrl(path, method) {
    const invalid = () => new RedditError(
      `Path must start with a single slash and stay on ${API_BASE}: ${path}`,
      method === 'GET' ? {} : { outcome: OUTCOMES.FAILED_KNOWN },
    );
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw invalid();
    if (path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) throw invalid();
    const url = new URL(path, API_BASE);
    if (url.origin !== new URL(API_BASE).origin) throw invalid();
    return url;
  }

  // Invalidate cache best-effort while a failure is already being reported.
  async function failUnknown(error) {
    try {
      await invalidate();
    } catch {
      // The cache store is secondary to the canonical unknown outcome.
    }
    throw error;
  }

  async function readRequest(method, url, cacheKey) {
    if (method === 'GET') {
      const cached = await cachedValue(cacheKey);
      if (cached !== null) return cached;
    }

    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      const untilReset = blockedUntil - now();
      if (untilReset > 0) {
        if (untilReset > MAX_AUTO_WAIT_MS) {
          throw new RedditError(`Reddit rate limit reached. Try again in about ${Math.ceil(untilReset / 1000)} seconds.`);
        }
        await sleep(untilReset);
      }
      await takeSlot();
      const generation = method === 'GET' ? (await currentGeneration()).value : null;
      const token = await currentToken();
      const res = await fetch(url, {
        method,
        headers: { authorization: `bearer ${token}`, 'user-agent': userAgent, accept: 'application/json' },
      });
      const data = parseJson(await res.text());
      recordRate(res);

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await currentToken({ force: true });
        continue;
      }

      const waitMs = retryDelayMs(res, data);
      if (waitMs !== null) {
        if (attempt < maxAttempts && waitMs <= MAX_AUTO_WAIT_MS) {
          await sleep(waitMs);
          continue;
        }
        throw new RedditError(
          `Reddit is throttling this account. Try again in about ${Math.ceil(waitMs / 1000)} seconds.`,
          { status: res.status, details: data },
        );
      }
      if (!res.ok) {
        throw new RedditError(`Reddit returned HTTP ${res.status} for ${method} ${url.pathname}.`, {
          status: res.status,
          details: data,
        });
      }
      if (method === 'GET') remember(cacheKey, data, generation);
      return data;
    }
  }

  // A mutation is sent exactly once. There is no 401 refresh-resend, no throttle retry, and no 5xx
  // retry: after the request leaves this process, a second send could duplicate a write Reddit already
  // applied. Every failure carries the boundary's outcome classification instead.
  async function mutationRequest(method, url, form) {
    try {
      if (readOnly && method !== 'GET') {
        throw knownFailure('This session is read-only (REDDIT_AUTH_MODE=app), so writes are disabled.');
      }
      const untilReset = blockedUntil - now();
      if (untilReset > 0) {
        if (untilReset > MAX_AUTO_WAIT_MS) {
          throw knownFailure(
            `Reddit rate limit reached. Try again in about ${Math.ceil(untilReset / 1000)} seconds. Nothing was sent.`,
          );
        }
        await sleep(untilReset);
      }
      await takeSlot();

      let token;
      try {
        token = await currentToken();
      } catch (error) {
        if (error instanceof RedditError) {
          if (error.outcome === null) error.outcome = OUTCOMES.FAILED_KNOWN;
          throw error;
        }
        throw knownFailure(error?.message ?? 'The API session could not obtain a token; nothing was sent.');
      }

      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { authorization: `bearer ${token}`, 'user-agent': userAgent, accept: 'application/json' },
          body: form ? new URLSearchParams(form) : undefined,
        });
      } catch {
        return failUnknown(new RedditError(
          `The ${method} request to ${url.pathname} could not reach Reddit, so its outcome is unknown.`,
          { outcome: OUTCOMES.OUTCOME_UNKNOWN },
        ));
      }

      const text = await res.text();
      const data = parseJson(text);
      recordRate(res);

      if (typeof data === 'string' && text.trim() !== '') {
        // A successful status with an unparseable body cannot establish completion; a refusal is known.
        const outcome = res.ok ? OUTCOMES.OUTCOME_UNKNOWN : statusOutcome(res.status);
        const error = new RedditError(
          outcome === OUTCOMES.OUTCOME_UNKNOWN
            ? `Reddit's reply to ${method} ${url.pathname} could not be parsed, so the outcome is unknown.`
            : `Reddit returned HTTP ${res.status} for ${method} ${url.pathname}.`,
          { status: res.status, outcome },
        );
        if (outcome === OUTCOMES.OUTCOME_UNKNOWN) return failUnknown(error);
        throw error;
      }

      if (!res.ok) {
        // A rejected mutation is never resent, but a 401 means the cached access token is stale: drop
        // it so the next independent call renews it instead of failing the same way.
        if (res.status === 401) accessToken = null;
        const outcome = statusOutcome(res.status);
        const waitMs = retryDelayMs(res, data);
        const message = res.status === 429
          ? `Reddit is throttling this account. Try again in about ${Math.ceil((waitMs ?? WINDOW_MS) / 1000)} seconds. Nothing was sent.`
          : `Reddit returned HTTP ${res.status} for ${method} ${url.pathname}.`;
        const error = new RedditError(message, {
          status: res.status,
          details: data,
          outcome,
          retryAfterMs: waitMs,
        });
        if (outcome === OUTCOMES.OUTCOME_UNKNOWN) return failUnknown(error);
        throw error;
      }

      const errors = Array.isArray(data?.json?.errors) ? data.json.errors : [];
      if (errors.length > 0) {
        const [code, message] = errors[0];
        if (code === 'RATELIMIT') {
          const waitMs = parseWaitMs(message);
          throw knownFailure(
            `Reddit is throttling this account. Try again in about ${Math.ceil(waitMs / 1000)} seconds. Nothing was sent.`,
            { status: res.status, details: errors, retryAfterMs: waitMs },
          );
        }
        throw knownFailure(`Reddit refused the request (${code}): ${message ?? 'no details given'}`, {
          status: res.status,
          details: errors,
        });
      }

      // The write itself succeeded. Drop this client's copies, but never let a cache-generation store
      // failure turn an accepted write into an unknown outcome; the next successful bump catches up.
      try {
        await invalidate();
      } catch {
        cache.clear();
      }
      return data;
    } catch (error) {
      if (error instanceof RedditError && error.outcome === null) error.outcome = OUTCOMES.FAILED_KNOWN;
      throw error;
    }
  }

  async function request(method, path, { query = {}, form } = {}) {
    if (readOnly && method !== 'GET') {
      throw new RedditError('This session is read-only (REDDIT_AUTH_MODE=app), so writes are disabled.', {
        outcome: OUTCOMES.FAILED_KNOWN,
      });
    }
    const url = apiUrl(path, method);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const cacheKey = `${cacheNamespace ?? ''}\n${url.toString()}`;
    if (method === 'GET') return readRequest(method, url, cacheKey);
    return mutationRequest(method, url, form);
  }

  return { request, rateLimit: () => ({ ...lastRate }), invalidate };
}
