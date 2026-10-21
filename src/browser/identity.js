// Own-session identity verification for a dedicated browser profile.
//
// The primary evidence is Reddit's own-session `/api/me.json`, fetched through the live Playwright
// request context so cookies never leave the browser profile. A bounded, caller-supplied UI
// observer may be used when the request path is unavailable; this module never dumps page content,
// never evaluates page JavaScript, and never returns cookies, headers, or raw error messages.
//
// Classification here is deliberately conservative: a challenge, 2FA prompt, or account
// restriction is reported as its own handoff state, never retried as a transient failure and never
// treated as a signed-in or signed-out page.

import { normalizeUsername, validateAccountId } from '../profiles.js';

export const REDDIT_ORIGIN = 'https://www.reddit.com';
export const IDENTITY_PATH = '/api/me.json';
export const IDENTITY_URL = `${REDDIT_ORIGIN}${IDENTITY_PATH}`;
export const DEFAULT_IDENTITY_TIMEOUT_MS = 10_000;
// Only a small JSON document is ever read; the bound keeps an unexpected HTML/error page from
// becoming a large in-memory string or a log entry.
export const MAX_IDENTITY_BODY_BYTES = 200_000;

export const IDENTITY_STATES = Object.freeze([
  'authenticated',
  'anonymous',
  'challenge',
  'two_factor',
  'restricted',
  'throttled',
  'unavailable',
]);

const TWO_FACTOR_RE = /two[- ]?factor|2fa|verification code|one-time code|authenticator/i;
const CAPTCHA_RE = /captcha|are you a (?:human|robot)|verify you are human|security check|unusual (?:activity|traffic)/i;
const RESTRICTION_RE = /suspended|locked|banned|restricted|account (?:is )?disabled/i;
const LOGIN_URL_RE = /\/(?:login|register|account\/login|login\/?)(?:[/?#]|$)/i;
const HTML_RE = /^\s*<(!doctype|html|head|body)/i;

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      if (Array.isArray(value)) return value.join(', ');
      return typeof value === 'string' ? value : String(value ?? '');
    }
  }
  return '';
}

// A security prompt is recognized only by its own markers. A plain sign-in page is not a challenge.
function securityFromHtml(text) {
  if (TWO_FACTOR_RE.test(text)) return { state: 'two_factor', reason: 'two_factor' };
  if (CAPTCHA_RE.test(text)) return { state: 'challenge', reason: 'challenge' };
  if (RESTRICTION_RE.test(text)) return { state: 'restricted', reason: 'account_restricted' };
  return null;
}

const LOGIN_FORM_RE = /name=["']password["']|id=["']login-password["']|id=["']login-username["']/i;

// Pure classification of one identity response. `status` may be a number; `url` is the response URL.
// The result carries no body content, only a state and a short machine-readable reason.
export function classifyIdentityResponse({ status, contentType = '', url = '', body = '' } = {}) {
  const numeric = Number(status);
  const text = typeof body === 'string' ? body.slice(0, MAX_IDENTITY_BODY_BYTES) : '';
  const type = String(contentType).toLowerCase();
  const finalUrl = typeof url === 'string' ? url : '';
  const isHtml = type.includes('text/html') || HTML_RE.test(text);
  const security = isHtml ? securityFromHtml(text) : null;

  if (numeric === 429) return { state: 'throttled', reason: 'rate_limited' };
  if (numeric === 401) return { state: 'anonymous', reason: 'unauthenticated' };
  if (numeric === 403) {
    if (security) return security;
    // Reddit's own `/api/me.json` answers a signed-out request with a JSON 403 (or a bare 403),
    // not an account-security page. Only the security markers above are a restriction, so a merely
    // expired session stays renewable instead of becoming a permanent handoff.
    if (text.trim() === '' || text.trim().startsWith('{')) {
      return { state: 'anonymous', reason: 'forbidden' };
    }
    return { state: 'restricted', reason: 'forbidden' };
  }
  if (numeric >= 300 && numeric < 400) return { state: 'anonymous', reason: 'redirected' };
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 500) {
    return { state: 'unavailable', reason: 'server_error' };
  }

  let pathname = '';
  if (finalUrl) {
    try {
      pathname = new URL(finalUrl, REDDIT_ORIGIN).pathname;
    } catch {
      return { state: 'unavailable', reason: 'unexpected_location' };
    }
  }

  // A security prompt wins even when it is served on `/login`, because 2FA often lives there.
  if (security) return security;
  // An ordinary login page (or a redirect to it) means "not signed in".
  if (LOGIN_URL_RE.test(pathname)) return { state: 'anonymous', reason: 'login_redirect' };

  if (isHtml) {
    if (security) return security;
    if (LOGIN_FORM_RE.test(text)) return { state: 'anonymous', reason: 'login_page' };
    return { state: 'challenge', reason: 'html_instead_of_json' };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { state: 'unavailable', reason: 'invalid_json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { state: 'unavailable', reason: 'unexpected_payload' };
  }
  return { state: 'identity_payload', reason: null };
}

// Normalize a Reddit user payload (`{ kind: 'User', data: { name, id } }`) to safe identity fields.
// Reddit's JSON `id` is base36 without the `t2_` prefix; both spellings are accepted. A present but
// malformed id makes the payload unusable rather than silently dropping the account id.
export function normalizeIdentityPayload(payload) {
  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.name !== 'string') return null;

  let normalized;
  try {
    normalized = normalizeUsername(data.name);
  } catch {
    return null;
  }

  let accountId = null;
  if (data.id !== undefined && data.id !== null && data.id !== '') {
    if (typeof data.id !== 'string') return null;
    const raw = data.id.trim().toLowerCase();
    try {
      accountId = validateAccountId(raw.startsWith('t2_') ? raw : `t2_${raw}`);
    } catch {
      return null;
    }
  }

  return { username: normalized.username, usernameKey: normalized.key, accountId };
}

// Normalize the safe value returned by an injected UI observer. The observer is a caller-supplied
// bounded probe (for example, a known profile-drawer locator); this module never reads the DOM.
export function normalizeObservedIdentity(observed) {
  if (!observed || typeof observed !== 'object') return null;
  if (typeof observed.username !== 'string') return null;
  let normalized;
  try {
    normalized = normalizeUsername(observed.username);
  } catch {
    return null;
  }
  let accountId = null;
  if (typeof observed.accountId === 'string' && observed.accountId.trim() !== '') {
    const raw = observed.accountId.trim().toLowerCase();
    try {
      accountId = validateAccountId(raw.startsWith('t2_') ? raw : `t2_${raw}`);
    } catch {
      return null;
    }
  }
  return { username: normalized.username, usernameKey: normalized.key, accountId };
}

function safeResponseFacts(response) {
  const status = typeof response?.status === 'function' ? response.status() : 0;
  const url = typeof response?.url === 'function' ? response.url() : '';
  const contentType = headerValue(
    typeof response?.headers === 'function' ? response.headers() : null,
    'content-type',
  );
  return {
    status: Number.isFinite(Number(status)) ? Number(status) : 0,
    url: typeof url === 'string' ? url : '',
    contentType,
  };
}

// Read and classify the signed-in identity through the live request context, with an optional
// bounded UI fallback when the request transport itself is unavailable.
export async function readSessionIdentity({
  requestContext,
  uiIdentity,
  clock = () => Date.now(),
  timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS,
} = {}) {
  const checkedAt = clock();
  if (!requestContext || typeof requestContext.get !== 'function') {
    return await uiFallback({ uiIdentity, clock, timeoutMs, checkedAt, reason: 'no_request_context' });
  }

  let response;
  try {
    response = await requestContext.get(IDENTITY_URL, {
      maxRedirects: 0,
      timeout: timeoutMs,
      headers: { accept: 'application/json' },
    });
  } catch {
    return await uiFallback({ uiIdentity, clock, timeoutMs, checkedAt, reason: 'request_failed' });
  }

  const { status, url, contentType } = safeResponseFacts(response);
  let body = '';
  try {
    body = String(await response.text()).slice(0, MAX_IDENTITY_BODY_BYTES);
  } catch {
    return { state: 'unavailable', reason: 'response_unreadable', checkedAt };
  }

  const classified = classifyIdentityResponse({ status, contentType, url, body });
  if (classified.state === 'identity_payload') {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { state: 'unavailable', reason: 'invalid_json', checkedAt };
    }
    const identity = normalizeIdentityPayload(payload);
    if (!identity) {
      const data = payload && typeof payload === 'object' ? payload.data : null;
      const hasName = data && typeof data === 'object' && typeof data.name === 'string';
      if (!hasName) return { state: 'anonymous', reason: 'no_signed_in_user', checkedAt };
      return { state: 'unavailable', reason: 'malformed_identity', checkedAt };
    }
    return { state: 'authenticated', source: 'api', ...identity, checkedAt };
  }

  if (classified.state === 'unavailable') {
    return await uiFallback({ uiIdentity, clock, timeoutMs, checkedAt, reason: classified.reason });
  }
  return { ...classified, checkedAt };
}

async function uiFallback({ uiIdentity, clock, timeoutMs, checkedAt, reason }) {
  if (typeof uiIdentity !== 'function') return { state: 'unavailable', reason, checkedAt };
  let observed;
  try {
    observed = await uiIdentity({ timeoutMs, identityUrl: IDENTITY_URL });
  } catch {
    return { state: 'unavailable', reason, checkedAt };
  }
  const identity = normalizeObservedIdentity(observed);
  if (!identity) return { state: 'unavailable', reason, checkedAt };
  return { state: 'authenticated', source: 'ui', ...identity, checkedAt: clock() };
}
