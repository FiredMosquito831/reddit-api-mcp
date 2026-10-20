import { parseJson } from './util.js';
import { REQUESTED_SCOPES } from './scopes.js';

export const AUTHORIZE_URL = 'https://www.reddit.com/api/v1/authorize';
export const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
export const REVOKE_URL = 'https://www.reddit.com/api/v1/revoke_token';

// The scopes login requests: every scope a shipped feature needs, nothing else. See scopes.js for the reasons.
// REDDIT_SCOPES overrides this list; granted scopes are fixed per login, so a change needs a new login.
export const DEFAULT_SCOPES = REQUESTED_SCOPES;

export function parseScopes(value = '') {
  return value.split(/[\s,]+/).filter(Boolean);
}

export function createAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    state,
    redirect_uri: redirectUri,
    // Without duration=permanent Reddit issues no refresh token, so the login lasts about an hour.
    duration: 'permanent',
    scope: scopes.join(' '),
  });
  return `${AUTHORIZE_URL}?${params}`;
}

// After approval the browser lands on the redirect URI with ?code=...&state=... in its address bar.
export function parseRedirectUrl(pasted, expectedState) {
  let url;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error('That is not a URL. Paste the full address your browser ended up on.');
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Access was not granted (${error}).`);
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('The state value does not match this login attempt. Run login again.');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The pasted URL has no authorization code.');
  return code;
}

// Installed apps have no client secret, so their Basic auth password is empty. Script and web apps send theirs.
function basicAuth(clientId, clientSecret = '') {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function postToken({ fetch, clientId, clientSecret, userAgent, form }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(clientId, clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent,
    },
    body: new URLSearchParams(form),
  });
  const data = parseJson(await res.text()) ?? {};
  if (!res.ok || !data.access_token) {
    throw new Error(`Reddit token request failed (HTTP ${res.status}${data.error ? `, ${data.error}` : ''}).`);
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    refreshToken: data.refresh_token ?? null,
    scopes: parseScopes(data.scope),
  };
}

export function exchangeCode({ fetch = globalThis.fetch, clientId, clientSecret, userAgent, redirectUri, code }) {
  return postToken({
    fetch,
    clientId,
    clientSecret,
    userAgent,
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  });
}

export function refreshAccessToken({ fetch = globalThis.fetch, clientId, clientSecret, userAgent, refreshToken }) {
  return postToken({
    fetch,
    clientId,
    clientSecret,
    userAgent,
    form: { grant_type: 'refresh_token', refresh_token: refreshToken },
  });
}

// Password grant (script apps only). Your password is sent with each token request and stored nowhere.
// If two-factor is on, the password is "password:CODE".
export function passwordGrant({ fetch = globalThis.fetch, clientId, clientSecret, userAgent, username, password }) {
  return postToken({
    fetch,
    clientId,
    clientSecret,
    userAgent,
    form: { grant_type: 'password', username, password },
  });
}

// App-only token (script and web apps). It reads public data as the app, not as a user.
export function clientCredentialsGrant({ fetch = globalThis.fetch, clientId, clientSecret, userAgent }) {
  return postToken({
    fetch,
    clientId,
    clientSecret,
    userAgent,
    form: { grant_type: 'client_credentials' },
  });
}

export async function revokeToken({ fetch = globalThis.fetch, clientId, clientSecret, userAgent, refreshToken }) {
  const res = await fetch(REVOKE_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(clientId, clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': userAgent,
    },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Revoking the token failed (HTTP ${res.status}).`);
}
