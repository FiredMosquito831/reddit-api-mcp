import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileRegistry } from '../src/profiles.js';
import { createAccountRegistry } from '../src/accounts.js';
import { createProfileSecretStore } from '../src/secrets.js';
import { importLegacyProfile } from '../src/migration.js';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeKeyring({ failOnSet = 0, errorText = 'store unavailable' } = {}) {
  const values = new Map();
  let sets = 0;
  const factory = (service, account) => {
    const key = `${service}\u0000${account}`;
    return {
      getPassword: () => (values.has(key) ? values.get(key) : null),
      setPassword(value) {
        sets += 1;
        if (failOnSet > 0 && sets === failOnSet) throw new Error(errorText);
        values.set(key, value);
      },
      deletePassword: () => values.delete(key),
    };
  };
  return { factory, values, sets: () => sets };
}

function memoryLegacyStore(value) {
  return {
    value,
    fail: false,
    async getRefreshToken() {
      if (this.fail) throw new Error('legacy keychain unavailable');
      return this.value;
    },
    async setRefreshToken(token) {
      this.value = token;
    },
    async clear() {
      this.value = null;
    },
  };
}

async function setup(t, { keyringOptions } = {}) {
  const homeDir = await tempHome(t);
  let next = 0;
  const registry = createProfileRegistry({
    homeDir,
    clock: () => 1_700_000_000_000,
    newId: () => `id${++next}`,
  });
  const accounts = createAccountRegistry({ registry });
  const keyring = fakeKeyring(keyringOptions);
  const secretStore = createProfileSecretStore({ keyring: keyring.factory });
  return { homeDir, registry, accounts, keyring, secretStore };
}

function legacyConfig(overrides = {}) {
  return {
    authMode: 'oauth',
    clientId: 'legacy-client',
    clientSecret: '',
    username: 'Alice',
    password: '',
    refreshToken: '',
    redirectUri: 'http://localhost:8080',
    scopes: ['identity', 'read'],
    userAgent: 'node:reddit-cli:0.1.0 (by /u/Alice)',
    homeDir: 'C:\\legacy-home',
    ...overrides,
  };
}

function verifier(result = { username: 'Alice', accountId: 't2_abc' }, onVerify) {
  return async (input) => {
    if (onVerify) await onVerify(input);
    return result;
  };
}

test('a successful import copies profile-owned credentials and preserves the legacy source', async (t) => {
  const { homeDir, registry, accounts, secretStore } = await setup(t);
  const writesPath = join(homeDir, 'writes.json');
  const history = '[{"fp":"abc","at":1700000000000}]';
  await writeFile(writesPath, history);

  const legacyStore = memoryLegacyStore('legacy-refresh');
  const profileId = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ clientSecret: 'legacy-secret' }),
    legacyStore,
    verifyIdentity: verifier({ username: 'Alice', accountId: 't2_abc' }, async () => {
      // Verification runs before any mutation, while the legacy token is still in place.
      assert.equal((await registry.list()).length, 0);
      assert.equal(legacyStore.value, 'legacy-refresh');
    }),
  });

  const profile = await registry.get(profileId);
  assert.equal(profile.alias, 'Alice');
  assert.equal(profile.username, 'Alice');
  assert.equal(profile.accountId, 't2_abc');
  assert.equal(profile.expectedUsername, 'Alice');
  assert.equal(profile.api.clientId, 'legacy-client');
  assert.equal(profile.api.appType, 'script');
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'refreshToken')), 'legacy-refresh');
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'clientSecret')), 'legacy-secret');
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'password')), null);

  // The original keychain value and the legacy write history stay exactly as they were.
  assert.equal(legacyStore.value, 'legacy-refresh');
  assert.equal(await readFile(writesPath, 'utf8'), history);
  assert.equal(await registry.get(), null, 'import must not silently change the default profile');
  const accountsList = await registry.listAccounts();
  assert.equal(accountsList.length, 1);
  assert.equal(accountsList[0].accountKey, profile.accountKey);

  const raw = await readFile(join(homeDir, 'profiles.json'), 'utf8');
  for (const secret of ['legacy-refresh', 'legacy-secret']) {
    assert.ok(!raw.includes(secret), `registry leaked ${secret}`);
  }
});

test('an environment refresh token wins over the legacy keychain, and is copied once', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const legacyStore = memoryLegacyStore('from-keychain');
  const profileId = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ refreshToken: 'from-environment' }),
    legacyStore,
    verifyIdentity: verifier(),
  });
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'refreshToken')), 'from-environment');
  assert.equal(legacyStore.value, 'from-keychain');
});

test('a refresh token rotated during verification is the one migrated', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const legacyStore = memoryLegacyStore('stale-refresh');
  const profileId = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig(),
    legacyStore,
    verifyIdentity: verifier({ username: 'Alice' }, async () => {
      await legacyStore.setRefreshToken('rotated-refresh');
    }),
  });
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'refreshToken')), 'rotated-refresh');
  assert.equal(legacyStore.value, 'rotated-refresh');
});

test('an environment token still wins over a token rotated during verification', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const legacyStore = memoryLegacyStore('keychain-refresh');
  const profileId = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ refreshToken: 'environment-refresh' }),
    legacyStore,
    verifyIdentity: verifier({ username: 'Alice' }, async () => {
      await legacyStore.setRefreshToken('rotated-refresh');
    }),
  });
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'refreshToken')), 'environment-refresh');
});

test('re-importing the same alias after the client id changed does not silently succeed', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const first = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig(),
    legacyStore: memoryLegacyStore('legacy-refresh'),
    verifyIdentity: verifier(),
  });
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ clientId: 'changed-client' }),
      legacyStore: memoryLegacyStore('legacy-refresh'),
      verifyIdentity: verifier(),
    }),
    (error) => error.code === 'ALIAS_TAKEN',
  );
  const profile = await registry.get(first);
  assert.equal(profile.api.clientId, 'legacy-client');
  assert.equal(await secretStore.get(secretStore.ref(first, 'refreshToken')), 'legacy-refresh');
});

test('a failed identity check leaves profiles, secrets, legacy storage, and history untouched', async (t) => {
  const { homeDir, registry, accounts, secretStore, keyring } = await setup(t);
  const writesPath = join(homeDir, 'writes.json');
  await writeFile(writesPath, '[]');
  const legacyStore = memoryLegacyStore('legacy-refresh');

  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ clientSecret: 'legacy-secret' }),
      legacyStore,
      verifyIdentity: verifier({ username: 'Bob', accountId: 't2_other' }),
    }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );

  assert.equal((await registry.list()).length, 0);
  assert.equal(keyring.values.size, 0);
  assert.equal(legacyStore.value, 'legacy-refresh');
  assert.equal(await readFile(writesPath, 'utf8'), '[]');
});

test('a verifier that throws or returns nothing mutates nothing', async (t) => {
  const { registry, accounts, secretStore, keyring } = await setup(t);
  const legacyStore = memoryLegacyStore('legacy-refresh');

  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig(),
      legacyStore,
      verifyIdentity: async () => {
        throw new Error('network down');
      },
    }),
    /network down/,
  );
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig(),
      legacyStore,
      verifyIdentity: async () => null,
    }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  assert.equal((await registry.list()).length, 0);
  assert.equal(keyring.values.size, 0);
  assert.equal(legacyStore.value, 'legacy-refresh');
});

test('an account binding conflict rolls back the newly added profile and its secrets', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const existing = await registry.add({ alias: 'existing' });
  await accounts.bind({ profileId: existing.id, accountId: 't2_abc', username: 'Bob' });

  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ clientSecret: 'legacy-secret' }),
      legacyStore: memoryLegacyStore('legacy-refresh'),
      verifyIdentity: verifier({ username: 'Alice', accountId: 't2_abc' }),
    }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );

  const profiles = await registry.list();
  assert.deepEqual(profiles.map((profile) => profile.alias), ['existing']);
  assert.equal((await registry.listAccounts()).length, 1);
  assert.equal((await registry.listAccounts())[0].username, 'Bob');
});

test('a failed secret write rolls back registry and account changes', async (t) => {
  const { registry, accounts, secretStore, keyring } = await setup(t, { keyringOptions: { failOnSet: 1 } });
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ refreshToken: 'legacy-refresh' }),
      legacyStore: memoryLegacyStore('legacy-refresh'),
      verifyIdentity: verifier(),
    }),
    (error) => error.code === 'SECRET_STORE_UNAVAILABLE',
  );
  assert.equal((await registry.list()).length, 0);
  assert.equal((await registry.listAccounts()).length, 0);
  assert.equal(keyring.values.size, 0);
});

test('a partially written secret import does not leave an orphaned profile', async (t) => {
  const { registry, accounts, secretStore } = await setup(t, { keyringOptions: { failOnSet: 2 } });
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ clientSecret: 'legacy-secret' }),
      legacyStore: memoryLegacyStore('legacy-refresh'),
      verifyIdentity: verifier(),
    }),
    (error) => error.code === 'SECRET_STORE_UNAVAILABLE',
  );
  assert.equal((await registry.list()).length, 0);
  assert.equal((await registry.listAccounts()).length, 0);
});

test('legacy passwords are never copied into the OS store or the registry', async (t) => {
  const { homeDir, registry, accounts, secretStore, keyring } = await setup(t);
  const profileId = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ authMode: 'password', clientSecret: 'legacy-secret', password: 'legacy-password' }),
    legacyStore: memoryLegacyStore(null),
    verifyIdentity: verifier(),
  });
  for (const [key, value] of keyring.values) {
    assert.ok(!String(value).includes('legacy-password'), `password leaked into ${key}`);
  }
  assert.equal(await secretStore.get(secretStore.ref(profileId, 'password')), null);
  const raw = await readFile(join(homeDir, 'profiles.json'), 'utf8');
  assert.ok(!raw.includes('legacy-password'));
  // A machine-readable error from a later failure must not echo it either.
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ username: 'Alice', password: 'legacy-password' }),
      legacyStore: memoryLegacyStore(null),
      verifyIdentity: verifier({ username: 'Bob' }),
    }),
    (error) => !JSON.stringify(error).includes('legacy-password'),
  );
});

test('two aliases for one verified account share one account record and key', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const first = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig(),
    legacyStore: memoryLegacyStore('token-one'),
    verifyIdentity: verifier({ username: 'Alice', accountId: 't2_abc' }),
  });
  const second = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ username: 'alice' }),
    legacyStore: memoryLegacyStore('token-two'),
    alias: 'Second Alias',
    verifyIdentity: verifier({ username: 'alice', accountId: 't2_abc' }),
  });

  const one = await registry.get(first);
  const two = await registry.get(second);
  assert.equal(one.accountKey, two.accountKey);
  assert.equal((await registry.listAccounts()).length, 1);
  assert.deepEqual([...(await registry.listAccounts())[0].profileIds].sort(), [first, second].sort());
  assert.equal(await secretStore.get(secretStore.ref(first, 'refreshToken')), 'token-one');
  assert.equal(await secretStore.get(secretStore.ref(second, 'refreshToken')), 'token-two');
});

test('re-importing the same alias and account is idempotent', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const input = () => ({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig(),
    legacyStore: memoryLegacyStore('legacy-refresh'),
    verifyIdentity: verifier(),
  });
  const first = await importLegacyProfile(input());
  const second = await importLegacyProfile(input());
  assert.equal(second, first);
  assert.equal((await registry.list()).length, 1);
});

test('app type can be supplied explicitly, and an unverified identity never mutates', async (t) => {
  const { registry, accounts, secretStore } = await setup(t);
  const id = await importLegacyProfile({
    registry,
    accounts,
    secretStore,
    legacyConfig: legacyConfig({ clientSecret: 'legacy-secret' }),
    legacyStore: memoryLegacyStore(null),
    alias: 'Web App',
    appType: 'web',
    verifyIdentity: verifier({ username: 'Alice' }),
  });
  const profile = await registry.get(id);
  assert.equal(profile.api.appType, 'web');
  assert.equal(profile.alias, 'Web App');

  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig({ username: 'Alice' }),
      legacyStore: memoryLegacyStore(null),
      alias: 'Should Not Exist',
      verifyIdentity: async () => ({ username: 'Alice', accountId: 'not-an-id' }),
    }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
  assert.equal((await registry.list()).some((entry) => entry.alias === 'Should Not Exist'), false);
});

test('migration requires a verifier and does not write secrets from a failed legacy read', async (t) => {
  const { registry, accounts, secretStore, keyring } = await setup(t);
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig(),
      legacyStore: memoryLegacyStore(null),
      verifyIdentity: null,
    }),
    TypeError,
  );
  const failingStore = memoryLegacyStore(null);
  failingStore.fail = true;
  await assert.rejects(
    importLegacyProfile({
      registry,
      accounts,
      secretStore,
      legacyConfig: legacyConfig(),
      legacyStore: failingStore,
      verifyIdentity: verifier(),
    }),
    /legacy keychain unavailable/,
  );
  assert.equal((await registry.list()).length, 0);
  assert.equal(keyring.values.size, 0);
});
