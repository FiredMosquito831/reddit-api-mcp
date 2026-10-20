import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthorizeUrl,
  exchangeCode,
  parseRedirectUrl,
  parseScopes,
  refreshAccessToken,
  revokeToken,
  TOKEN_URL,
} from '../src/oauth.js';
import { jsonResponse, recordingFetch } from './helpers.js';

test('the authorize URL asks for a permanent code grant with the requested scopes', () => {
  const url = new URL(createAuthorizeUrl({
    clientId: 'abc',
    redirectUri: 'http://localhost:8080',
    scopes: ['identity', 'vote'],
    state: 's1',
  }));
  assert.equal(url.origin + url.pathname, 'https://www.reddit.com/api/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('duration'), 'permanent');
  assert.equal(url.searchParams.get('scope'), 'identity vote');
  assert.equal(url.searchParams.get('state'), 's1');
});

test('parseRedirectUrl returns the code when the state matches', () => {
  assert.equal(parseRedirectUrl('http://localhost:8080/?state=s1&code=CODE123', 's1'), 'CODE123');
});

test('parseRedirectUrl rejects a mismatched state', () => {
  assert.throws(() => parseRedirectUrl('http://localhost:8080/?state=other&code=x', 's1'), /state value/);
});

test('parseRedirectUrl reports a denied authorization', () => {
  assert.throws(
    () => parseRedirectUrl('http://localhost:8080/?state=s1&error=access_denied', 's1'),
    /access_denied/,
  );
});

test('parseRedirectUrl rejects text that is not a URL', () => {
  assert.throws(() => parseRedirectUrl('just some words', 's1'), /not a URL/);
});

test('parseScopes accepts space- or comma-separated lists', () => {
  assert.deepEqual(parseScopes('identity,read  vote'), ['identity', 'read', 'vote']);
});

test('exchangeCode posts the code with Basic auth and an empty secret', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({
    access_token: 'AT',
    expires_in: 3600,
    refresh_token: 'RT',
    scope: 'identity read',
  }));
  const tokens = await exchangeCode({
    fetch,
    clientId: 'abc',
    userAgent: 'UA/1',
    redirectUri: 'http://localhost:8080',
    code: 'CODE',
  });
  const [call] = calls;
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.init.headers.authorization, `Basic ${Buffer.from('abc:').toString('base64')}`);
  assert.equal(call.init.headers['user-agent'], 'UA/1');
  assert.deepEqual(call.body, {
    grant_type: 'authorization_code',
    code: 'CODE',
    redirect_uri: 'http://localhost:8080',
  });
  assert.deepEqual(tokens, {
    accessToken: 'AT',
    expiresIn: 3600,
    refreshToken: 'RT',
    scopes: ['identity', 'read'],
  });
});

test('script and web apps send their client secret in Basic auth', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'AT', expires_in: 3600 }));
  await refreshAccessToken({ fetch, clientId: 'abc', clientSecret: 'shh', userAgent: 'UA/1', refreshToken: 'RT' });
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('abc:shh').toString('base64')}`);
});

test('refreshAccessToken sends the refresh token and tolerates a response without a new one', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'AT2', expires_in: 3600 }));
  const tokens = await refreshAccessToken({ fetch, clientId: 'abc', userAgent: 'UA/1', refreshToken: 'RT' });
  assert.deepEqual(calls[0].body, { grant_type: 'refresh_token', refresh_token: 'RT' });
  assert.equal(tokens.accessToken, 'AT2');
  assert.equal(tokens.refreshToken, null);
});

test('a failed token request throws with the HTTP status and Reddit error code', async () => {
  const { fetch } = recordingFetch(() => jsonResponse({ error: 'invalid_grant' }, { status: 400 }));
  await assert.rejects(
    exchangeCode({ fetch, clientId: 'abc', userAgent: 'UA/1', redirectUri: 'x', code: 'bad' }),
    /invalid_grant/,
  );
});

test('revokeToken posts the refresh token for revocation', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse(undefined, { status: 204 }));
  await revokeToken({ fetch, clientId: 'abc', userAgent: 'UA/1', refreshToken: 'RT' });
  assert.match(calls[0].url, /revoke_token$/);
  assert.deepEqual(calls[0].body, { token: 'RT', token_type_hint: 'refresh_token' });
});
