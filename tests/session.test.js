import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenSourceFor } from '../src/session.js';
import { jsonResponse, memoryStore, recordingFetch } from './helpers.js';

const config = (overrides = {}) => ({
  authMode: 'oauth',
  clientId: 'abc',
  clientSecret: '',
  userAgent: 'UA/1',
  username: 'alice',
  refreshToken: '',
  password: '',
  ...overrides,
});

test('a rotated refresh token is used for the next refresh, even when it came from the environment', async () => {
  let rounds = 0;
  const { fetch, calls } = recordingFetch(() => {
    rounds += 1;
    return jsonResponse({ access_token: `a${rounds}`, expires_in: 3600, refresh_token: `rt${rounds + 1}` });
  });
  const source = tokenSourceFor(config({ refreshToken: 'rt1' }), memoryStore(null), fetch);
  await source();
  await source();
  assert.equal(calls[0].body.refresh_token, 'rt1');
  assert.equal(calls[1].body.refresh_token, 'rt2');
});

test('keychain mode stores a rotated refresh token, and never writes an environment token', async () => {
  const store = memoryStore('rt1');
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'a', expires_in: 3600, refresh_token: 'rt2' }));
  await tokenSourceFor(config(), store, fetch)();
  assert.equal(calls[0].body.refresh_token, 'rt1');
  assert.equal(store.value, 'rt2');

  const envStore = memoryStore('kept');
  const env = recordingFetch(() => jsonResponse({ access_token: 'a', expires_in: 3600, refresh_token: 'rt9' }));
  await tokenSourceFor(config({ refreshToken: 'from-env' }), envStore, env.fetch)();
  assert.equal(envStore.value, 'kept');
});

test('with no refresh token anywhere, the source says to log in', async () => {
  const source = tokenSourceFor(config(), memoryStore(null), async () => {
    throw new Error('should not fetch');
  });
  await assert.rejects(source(), /reddit-cli login/);
});

test('password mode builds a password grant from the configured values', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ access_token: 'p', expires_in: 3600 }));
  const source = tokenSourceFor(
    config({ authMode: 'password', clientSecret: 's', password: 'pw' }),
    memoryStore(null),
    fetch,
  );
  const tokens = await source();
  assert.equal(tokens.accessToken, 'p');
  assert.deepEqual(calls[0].body, { grant_type: 'password', username: 'alice', password: 'pw' });
});
