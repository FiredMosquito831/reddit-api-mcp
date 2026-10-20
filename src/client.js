import { refreshAccessToken } from './oauth.js';
import { parseJson } from './util.js';

export const API_BASE = 'https://oauth.reddit.com';

const REFRESH_MARGIN_MS = 60_000;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;
// Waits up to this long are slept through; longer ones come back to the caller as an error.
const MAX_AUTO_WAIT_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

export class RedditError extends Error {
  constructor(message, { status, details } = {}) {
    super(message);
    this.name = 'RedditError';
    this.status = status;
    this.details = details;
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
}) {
  let accessToken = null;
  let expiresAt = 0;
  let blockedUntil = 0;
  const sentAt = [];
  const cache = new Map();
  let lastRate = { remaining: null, reset: null, used: null };

  // GET responses are reused for cacheTtlMs. A successful write clears the whole cache.
  function remember(key, data) {
    if (cacheTtlMs <= 0) return;
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { data, expiresAt: now() + cacheTtlMs });
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

  async function request(method, path, { query = {}, form } = {}) {
    if (readOnly && method !== 'GET') {
      throw new RedditError('This session is read-only (REDDIT_AUTH_MODE=app), so writes are disabled.');
    }
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new RedditError(`Path must start with a single slash: ${path}`);
    }
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (method === 'GET' && cached && now() < cached.expiresAt) return cached.data;

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
      const token = await currentToken();
      const res = await fetch(url, {
        method,
        headers: { authorization: `bearer ${token}`, 'user-agent': userAgent, accept: 'application/json' },
        body: form ? new URLSearchParams(form) : undefined,
      });
      const data = parseJson(await res.text());

      const remaining = Number.parseFloat(res.headers.get('x-ratelimit-remaining'));
      const reset = Number.parseFloat(res.headers.get('x-ratelimit-reset'));
      lastRate = { remaining, reset, used: Number.parseFloat(res.headers.get('x-ratelimit-used')) };
      if (remaining <= 0 && reset > 0) blockedUntil = now() + reset * 1000;

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
      if (method === 'GET') remember(cacheKey, data);
      else cache.clear(); // a write may change anything that was cached
      return data;
    }
  }

  return { request, rateLimit: () => ({ ...lastRate }) };
}
