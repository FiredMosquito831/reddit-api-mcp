import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = { REDDIT_CLIENT_ID: 'client-1', REDDIT_USERNAME: 'alice' };

test('oauth is the default auth mode and needs no secret', () => {
  assert.equal(loadConfig(BASE).authMode, 'oauth');
});

test('password mode needs a client secret and a password, and reads both from the environment', () => {
  assert.throws(
    () => loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'password', REDDIT_PASSWORD: 'x' }),
    /REDDIT_CLIENT_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'password', REDDIT_CLIENT_SECRET: 's' }),
    /REDDIT_PASSWORD/,
  );
  const config = loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'password', REDDIT_CLIENT_SECRET: 's', REDDIT_PASSWORD: 'pw' });
  assert.equal(config.password, 'pw');
  assert.equal(config.clientSecret, 's');
});

test('app mode needs a client secret', () => {
  assert.throws(() => loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'app' }), /REDDIT_CLIENT_SECRET/);
  assert.equal(loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'app', REDDIT_CLIENT_SECRET: 's' }).authMode, 'app');
});

test('unknown auth modes are rejected', () => {
  assert.throws(() => loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'anonymous' }), /oauth, password, or app/);
});

test('cache, retries, user agent, and refresh token settings come from the environment', () => {
  const off = loadConfig({ ...BASE, REDDIT_CLI_CACHE: 'off', REDDIT_CLI_MAX_RETRIES: '0' });
  assert.equal(off.cacheTtlMs, 0);
  assert.equal(off.maxAttempts, 1);
  assert.equal(loadConfig(BASE).maxAttempts, 4);
  assert.equal(loadConfig({ ...BASE, REDDIT_USER_AGENT: 'custom/1.0' }).userAgent, 'custom/1.0');
  assert.equal(loadConfig({ ...BASE, REDDIT_REFRESH_TOKEN: ' rt ' }).refreshToken, 'rt');
});
