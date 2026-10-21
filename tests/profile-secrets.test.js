import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  MAX_SECRET_BYTES,
  createProfileSecretStore,
  openSessionState,
  readProfileApiConfig,
  redactSecrets,
  sealSession,
} from '../src/secrets.js';
import { createProfileTokenStore } from '../src/store.js';
import { DEFAULT_SCOPES } from '../src/oauth.js';

// An injectable OS-store stand-in. It records service/account names and can fail on demand, but
// never touches the real Credential Manager.
function fakeKeyring({ fail = null, errorText = 'store unavailable' } = {}) {
  const values = new Map();
  const calls = [];
  const factory = (service, account) => {
    calls.push({ service, account });
    const key = `${service}\u0000${account}`;
    return {
      getPassword() {
        if (fail === 'get') throw new Error(errorText);
        return values.has(key) ? values.get(key) : null;
      },
      setPassword(value) {
        if (fail === 'set') throw new Error(errorText);
        values.set(key, value);
      },
      deletePassword() {
        if (fail === 'delete') throw new Error(errorText);
        return values.delete(key);
      },
    };
  };
  return { factory, values, calls };
}

function setup(options = {}) {
  const keyring = fakeKeyring(options);
  return { keyring, store: createProfileSecretStore({ keyring: keyring.factory }) };
}

const snapshot = (overrides = {}) => ({
  kind: 'profile',
  id: 'p_one',
  alias: 'one',
  accountKey: null,
  accountId: null,
  username: null,
  generation: 1,
  credentialGeneration: 1,
  policyGeneration: 1,
  api: { clientId: 'client-one', appType: 'installed' },
  ...overrides,
});

const settings = (overrides = {}) => ({
  homeDir: 'C:\\temp\\reddit-cli-test',
  safeMode: 'standard',
  minGapMs: 2_000,
  maxWritesPerHour: 30,
  botFooter: '',
  cacheTtlMs: 60_000,
  maxAttempts: 4,
  ...overrides,
});

test('secret refs are deterministic, namespaced per profile, and never contain values', () => {
  const { store } = setup();
  const first = store.ref('p_one', 'refreshToken');
  assert.equal(typeof first, 'string');
  assert.equal(first, store.ref('p_one', 'refreshToken'));
  assert.notEqual(first, store.ref('p_two', 'refreshToken'));
  assert.notEqual(first, store.ref('p_one', 'clientSecret'));
  assert.match(first, /p_one/);
  assert.match(first, /refreshToken/);
});

test('secret refs reject traversal, empty, and foreign namespaces', () => {
  const { store } = setup();
  const bad = [
    ['', 'refreshToken'],
    ['p/one', 'refreshToken'],
    ['p_one', '../refreshToken'],
    ['p_one', ''],
    ['p_one', 'Refresh Token'],
    [null, 'refreshToken'],
    ['p_one', 'x'.repeat(65)],
  ];
  for (const [profileId, name] of bad) {
    assert.throws(() => store.ref(profileId, name), (error) => error.code === 'INVALID_ARGUMENT');
  }
  assert.throws(() => store.ref('p_one', 'client secret'), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => store.ref('p_one', 'a:b'), (error) => error.code === 'INVALID_ARGUMENT');
});

test('get, set, and delete are namespaced and isolated between profiles', async () => {
  const { store, keyring } = setup();
  const one = store.ref('p_one', 'refreshToken');
  const two = store.ref('p_two', 'refreshToken');
  assert.equal(await store.get(one), null);

  await store.set(one, 'token-one');
  await store.set(two, 'token-two');
  assert.equal(await store.get(one), 'token-one');
  assert.equal(await store.get(two), 'token-two');

  assert.equal(await store.delete(one), true);
  assert.equal(await store.get(one), null);
  assert.equal(await store.get(two), 'token-two');
  assert.equal(await store.delete(one), false);

  // A separate OS service keeps profile secrets out of the legacy username-keyed entry.
  assert.ok(keyring.calls.length > 0);
  for (const call of keyring.calls) {
    assert.notEqual(call.service, 'reddit-cli');
    assert.match(call.service, /profile/i);
    assert.match(call.account, /p_(one|two)/);
  }
});

test('get and set refuse refs from another namespace', async () => {
  const { store, keyring } = setup();
  await assert.rejects(store.get('reddit-cli:alice'), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(store.set('reddit-cli:alice', 'x'), (error) => error.code === 'INVALID_ARGUMENT');
  assert.equal(keyring.calls.length, 0);
});

test('a full browser session payload is refused by the small-secret store', async () => {
  const { store, keyring } = setup();
  const ref = store.ref('p_one', 'sessionKey');
  assert.equal(MAX_SECRET_BYTES <= 4096, true);
  const huge = 'c'.repeat(MAX_SECRET_BYTES + 1);
  await assert.rejects(store.set(ref, huge), (error) => error.code === 'SECRET_TOO_LARGE');
  assert.equal(keyring.values.size, 0);

  const exact = 'k'.repeat(MAX_SECRET_BYTES);
  await store.set(ref, exact);
  assert.equal(await store.get(ref), exact);
});

test('empty values and non-strings are rejected for small secrets', async () => {
  const { store } = setup();
  const ref = store.ref('p_one', 'refreshToken');
  for (const value of ['', null, undefined, 42, {}, Buffer.from('x')]) {
    await assert.rejects(store.set(ref, value), (error) => error.code === 'INVALID_ARGUMENT');
  }
});

test('OS-store failures never echo the secret value', async () => {
  const secret = 'super-secret-refresh-token';
  const { store } = setup({ fail: 'set', errorText: `failed writing ${secret}` });
  const ref = store.ref('p_one', 'refreshToken');
  await assert.rejects(store.set(ref, secret), (error) => {
    assert.equal(error.code, 'SECRET_STORE_UNAVAILABLE');
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});

test('opening a sealed session needs the same profile, version, and key', () => {
  const key = randomBytes(32);
  const value = { cookies: [{ name: 'session', value: 'abc' }], origins: [] };
  const sealed = sealSession(value, { key, profileId: 'p_one', version: 1 });
  assert.ok(Buffer.isBuffer(sealed));
  assert.ok(!sealed.includes(Buffer.from('session', 'utf8')));
  assert.deepEqual(openSessionState(sealed, { key, profileId: 'p_one', version: 1 }), value);
  assert.deepEqual(openSessionState(sealed, { key, profileId: 'p_one' }), value);

  assert.throws(
    () => openSessionState(sealed, { key: randomBytes(32), profileId: 'p_one', version: 1 }),
    (error) => error.code === 'SESSION_STATE_INVALID'
      && !error.message.includes('abc')
      && !error.message.includes('cookies'),
  );
  assert.throws(
    () => openSessionState(sealed, { key, profileId: 'p_two', version: 1 }),
    (error) => error.code === 'SESSION_STATE_INVALID',
  );
  assert.throws(
    () => openSessionState(sealed, { key, profileId: 'p_one', version: 2 }),
    (error) => error.code === 'SESSION_STATE_INVALID',
  );
});

test('tampered ciphertext, nonce, tag, and header fail closed', () => {
  const key = randomBytes(32);
  const sealed = sealSession({ a: 1 }, { key, profileId: 'p_one', version: 1 });
  for (const index of [0, 5, 10, sealed.length - 1]) {
    const copy = Buffer.from(sealed);
    copy[index] ^= 0xff;
    assert.throws(
      () => openSessionState(copy, { key, profileId: 'p_one', version: 1 }),
      (error) => error.code === 'SESSION_STATE_INVALID',
    );
  }
});

test('sealing uses a fresh nonce and rejects malformed keys and versions', () => {
  const key = randomBytes(32);
  const first = sealSession({ a: 1 }, { key, profileId: 'p_one', version: 1 });
  const second = sealSession({ a: 1 }, { key, profileId: 'p_one', version: 1 });
  assert.notDeepEqual(first, second);

  for (const badKey of [randomBytes(16), randomBytes(31), randomBytes(33), 'not-a-key', null]) {
    assert.throws(
      () => sealSession({ a: 1 }, { key: badKey, profileId: 'p_one', version: 1 }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  }
  for (const version of [0, -1, 1.5, 256, '1', null]) {
    assert.throws(
      () => sealSession({ a: 1 }, { key, profileId: 'p_one', version }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  }
  assert.throws(
    () => sealSession([], { key, profileId: 'p_one', version: 1 }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('redaction removes literal secrets and common credential spellings', () => {
  const text = 'Authorization: Bearer abc.def password=hunter2 refresh_token=rt1 client_secret=cs1';
  const redacted = redactSecrets(text, ['hunter2', 'rt1']);
  for (const secret of ['hunter2', 'rt1', 'abc.def', 'cs1']) {
    assert.ok(!redacted.includes(secret), `leaked ${secret}`);
  }
  assert.match(redacted, /REDACTED/);
  assert.equal(redactSecrets('ordinary text', []), 'ordinary text');
});

test('redaction covers JSON-shaped credential fields and every cookie pair', () => {
  const json = '{"refresh_token":"rt-value","clientSecret":"cs-value",'
    + '"accessToken":"at-value","password":"pw-value","note":"kept"}';
  const redacted = redactSecrets(json);
  for (const secret of ['rt-value', 'cs-value', 'at-value', 'pw-value']) {
    assert.ok(!redacted.includes(secret), `leaked ${secret}`);
  }
  assert.match(redacted, /kept/);

  const cookie = 'Cookie: a=1; b=2; session=zzz';
  const cookieRedacted = redactSecrets(cookie);
  for (const value of ['a=1', 'b=2', 'zzz']) {
    assert.ok(!cookieRedacted.includes(value), `leaked cookie ${value}`);
  }

  for (const header of [
    'Set-Cookie: sid=secret; Path=/; HttpOnly',
    'set-cookie="sid=secret; Path=/"',
  ]) {
    const output = redactSecrets(header);
    assert.ok(!output.includes('sid=secret'), `leaked ${header}`);
    assert.match(output, /REDACTED/);
  }
});

test('the secret store accepts the Entry class and an { Entry } module shape', async () => {
  class FakeEntry {
    static values = new Map();
    constructor(service, account) {
      this.key = `${service}\u0000${account}`;
    }
    getPassword() {
      return FakeEntry.values.has(this.key) ? FakeEntry.values.get(this.key) : null;
    }
    setPassword(value) {
      FakeEntry.values.set(this.key, value);
    }
    deletePassword() {
      return FakeEntry.values.delete(this.key);
    }
  }

  for (const keyring of [FakeEntry, { Entry: FakeEntry }]) {
    FakeEntry.values.clear();
    const store = createProfileSecretStore({ keyring });
    const secretRef = store.ref('p_one', 'refreshToken');
    assert.equal(await store.get(secretRef), null);
    await store.set(secretRef, 'class-token');
    assert.equal(await store.get(secretRef), 'class-token');
    assert.equal(await store.delete(secretRef), true);
  }
});

test('named profiles never inherit process-wide legacy credentials', async () => {
  const { store } = setup();
  const previous = {
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_USERNAME: process.env.REDDIT_USERNAME,
    REDDIT_REFRESH_TOKEN: process.env.REDDIT_REFRESH_TOKEN,
    REDDIT_PASSWORD: process.env.REDDIT_PASSWORD,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
  };
  process.env.REDDIT_CLIENT_ID = 'env-client';
  process.env.REDDIT_USERNAME = 'env-user';
  process.env.REDDIT_REFRESH_TOKEN = 'env-refresh';
  process.env.REDDIT_PASSWORD = 'env-password';
  process.env.REDDIT_CLIENT_SECRET = 'env-secret';
  try {
    const config = await readProfileApiConfig(snapshot(), { secretStore: store, settings: settings() });
    assert.equal(config.clientId, 'client-one');
    assert.equal(config.clientSecret, '');
    assert.equal(config.refreshToken, '');
    assert.equal(config.password, '');
    assert.equal(config.username, null);
    assert.equal(config.authMode, 'oauth');
    assert.deepEqual(config.scopes, DEFAULT_SCOPES);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('profile API config reads only profile-owned secrets and never a stored password', async () => {
  const { store, keyring } = setup();
  await store.set(store.ref('p_one', 'clientSecret'), 'profile-secret');
  await store.set(store.ref('p_one', 'refreshToken'), 'profile-refresh');
  await store.set(store.ref('p_one', 'password'), 'stored-browser-password');
  keyring.calls.length = 0;

  const config = await readProfileApiConfig(
    snapshot({ username: 'alice', accountKey: 'acct_abc' , api: { clientId: 'client-one', appType: 'script' } }),
    { secretStore: store, settings: settings() },
  );
  assert.equal(config.authMode, 'oauth');
  assert.equal(config.clientSecret, 'profile-secret');
  assert.equal(config.refreshToken, 'profile-refresh');
  assert.equal(config.password, '');
  assert.equal(config.username, 'alice');
  assert.equal(config.readOnly, false);
  assert.equal(config.profileId, 'p_one');
  assert.equal(config.accountKey, 'acct_abc');
  assert.ok(keyring.calls.every((call) => !call.account.endsWith(':password')));
});

test('same app credentials stay shared while refresh tokens stay profile-bound', async () => {
  const { store } = setup();
  await store.set(store.ref('p_one', 'clientSecret'), 'shared-secret');
  await store.set(store.ref('p_two', 'clientSecret'), 'shared-secret');
  await store.set(store.ref('p_one', 'refreshToken'), 'token-one');
  await store.set(store.ref('p_two', 'refreshToken'), 'token-two');

  const one = await readProfileApiConfig(
    snapshot({ id: 'p_one', api: { clientId: 'shared', appType: 'script' } }),
    { secretStore: store, settings: settings() },
  );
  const two = await readProfileApiConfig(
    snapshot({ id: 'p_two', api: { clientId: 'shared', appType: 'script' } }),
    { secretStore: store, settings: settings() },
  );
  assert.equal(one.clientId, two.clientId);
  assert.equal(one.clientSecret, two.clientSecret);
  assert.equal(one.refreshToken, 'token-one');
  assert.equal(two.refreshToken, 'token-two');
});

test('an app-only profile metadata record yields a read-only app config', async () => {
  const { store } = setup();
  await store.set(store.ref('p_app', 'clientSecret'), 'app-secret');
  const config = await readProfileApiConfig(
    snapshot({ id: 'p_app', username: null, accountKey: null, api: { clientId: 'app-client', appType: 'script' } }),
    { secretStore: store, settings: settings() },
  );
  assert.equal(config.authMode, 'app');
  assert.equal(config.readOnly, true);
  assert.equal(config.refreshToken, '');
  assert.equal(config.appOnly, true);
});

test('a missing client id fails as unavailable instead of using the environment', async () => {
  const { store } = setup();
  await assert.rejects(
    readProfileApiConfig(snapshot({ api: { clientId: null, appType: null } }), {
      secretStore: store,
      settings: settings(),
    }),
    (error) => error.code === 'BACKEND_UNAVAILABLE' && /client ID/.test(error.message),
  );
});

test('confidential app types require a stored client secret', async () => {
  const { store } = setup();
  await assert.rejects(
    readProfileApiConfig(
      snapshot({ api: { clientId: 'client-one', appType: 'script' } }),
      { secretStore: store, settings: settings() },
    ),
    (error) => error.code === 'BACKEND_UNAVAILABLE' && /client secret/.test(error.message),
  );
});

test('runtime settings flow into the profile API config without credentials', async () => {
  const { store } = setup();
  const config = await readProfileApiConfig(snapshot(), {
    secretStore: store,
    settings: settings({ maxWritesPerHour: 7, cacheTtlMs: 0, maxAttempts: 2, botFooter: '\n\nfooter' }),
  });
  assert.equal(config.homeDir, 'C:\\temp\\reddit-cli-test');
  assert.equal(config.maxWritesPerHour, 7);
  assert.equal(config.cacheTtlMs, 0);
  assert.equal(config.maxAttempts, 2);
  assert.equal(config.botFooter, '\n\nfooter');
  assert.equal(Object.hasOwn(config, 'safeMode'), true);
});

test('the profile token adapter implements the legacy token store shape', async () => {
  const { store } = setup();
  const tokens = createProfileTokenStore({ secretStore: store, profileId: 'p_one' });
  assert.equal(await tokens.getRefreshToken(), null);
  await tokens.setRefreshToken('rotated');
  assert.equal(await tokens.getRefreshToken(), 'rotated');
  await tokens.clear();
  assert.equal(await tokens.getRefreshToken(), null);
});
