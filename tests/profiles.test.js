import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_PROFILE,
  createProfileRegistry,
  isLegacyProfile,
  resolveProfile,
} from '../src/profiles.js';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-profiles-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function registry(homeDir, overrides = {}) {
  let next = 0;
  return createProfileRegistry({
    homeDir,
    clock: () => 1_700_000_000_000,
    newId: () => `id${++next}`,
    ...overrides,
  });
}

function deepFrozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), 'expected a frozen object');
    for (const child of Object.values(value)) deepFrozen(child);
  }
}

test('aliases are case-insensitively unique and resolvable by alias and id', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const one = await r.add({ alias: 'Work' });
  const two = await r.add({ alias: 'play' });

  await assert.rejects(r.add({ alias: 'work' }), (error) => error.code === 'ALIAS_TAKEN');
  assert.equal((await r.get('WORK')).id, one.id);
  assert.equal((await r.get('play')).id, two.id);
  assert.equal((await r.get(one.id)).alias, 'Work');
  assert.equal((await r.get({ alias: 'PLAY' })).id, two.id);
  assert.equal((await r.get({ id: two.id })).alias, 'play');

  const listed = await r.list();
  assert.deepEqual(listed.map((entry) => entry.alias), ['Work', 'play']);
});

test('aliases reject empty, traversal, separator, control, and Windows device names', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const bad = [
    '', '   ', '.', '..', '../escape', 'a/b', 'a\\b', 'C:temp', 'CON', 'con',
    'NUL', 'nul.txt', 'COM1', 'LPT9', 'lpt9.json', 'trail.', 'trail ', ' lead',
    'bad<name', 'bad>name', 'bad|name', 'bad?name', 'bad*name', 'bad"name',
    'bad:name', 'nul\u0000byte', 'x'.repeat(49), 'legacy', 'LEGACY',
  ];
  for (const alias of bad) {
    await assert.rejects(r.add({ alias }), (error) => error.code === 'INVALID_ARGUMENT', `alias ${JSON.stringify(alias)}`);
  }
  assert.equal((await r.list()).length, 0);
});

test('profile ids are opaque and never derived from aliases', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'My Account' });
  assert.match(profile.id, /^p_[A-Za-z0-9_-]+$/);
  assert.ok(!profile.id.toLowerCase().includes('my'));
  assert.ok(!profile.id.toLowerCase().includes('account'));

  const raw = JSON.parse(await readFile(join(home, 'profiles.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.profiles[profile.id].alias, 'My Account');
  assert.equal(Object.keys(raw.profiles).length, 1);
  // A single authoritative file: no per-profile metadata copy.
  await assert.rejects(readFile(join(home, 'profiles', profile.id, 'metadata.json'), 'utf8'));
});

test('registry file contains no secret fields', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'safe' });
  await r.update(profile.id, { api: { clientId: 'public-client' } }, { expectedGeneration: 1 });
  const raw = await readFile(join(home, 'profiles.json'), 'utf8');
  const forbidden = new Set(['password', 'clientSecret', 'refreshToken', 'accessToken', 'authorization', 'secret']);
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `registry leaked field ${key}`);
      walk(child);
    }
  };
  walk(JSON.parse(raw));
});

test('default set and clear propagate atomically across instances', async (t) => {
  const home = await tempHome(t);
  const a = registry(home);
  const b = registry(home);
  const one = await a.add({ alias: 'one' });
  const two = await a.add({ alias: 'two' });

  await a.setDefault(two.id);
  assert.equal((await b.snapshot(undefined)).id, two.id);
  assert.equal((await b.snapshot()).id, two.id);
  assert.equal((await b.list()).filter((entry) => entry.isDefault).length, 1);

  await b.setDefault('ONE');
  assert.equal((await a.snapshot()).id, one.id);

  await a.setDefault(null);
  assert.equal((await b.list()).filter((entry) => entry.isDefault).length, 0);
  await assert.rejects(b.snapshot(null), (error) => error.code === 'PROFILE_REQUIRED');
  await assert.rejects(a.setDefault('missing'), (error) => error.code === 'PROFILE_NOT_FOUND');
});

test('snapshots are immutable and changed defaults do not mutate them', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const one = await r.add({ alias: 'one', expectedUsername: 'Alice' });
  const two = await r.add({ alias: 'two' });
  await r.setDefault(one.id);

  const first = await r.snapshot();
  deepFrozen(first);
  assert.equal(first.id, one.id);
  assert.equal(first.alias, 'one');
  assert.equal(first.expectedUsername, 'Alice');
  assert.equal(first.accountKey, null);
  assert.equal(first.accountId, null);
  assert.equal(first.username, null);
  assert.equal(first.generation, 1);
  assert.equal(first.credentialGeneration, 1);
  assert.equal(first.policyGeneration, 1);
  assert.deepEqual(first.enabledBackends, ['api']);
  assert.deepEqual(first.backendPreference, ['api']);
  assert.equal(first.visibility, 'visible');
  assert.deepEqual(first.confirmations, {});
  assert.deepEqual(first.api, { clientId: null, appType: null });
  assert.equal(first.passwordLoginEnabled, false);
  assert.equal(first.kind, 'profile');

  await r.setDefault(two.id);
  await r.update(one.id, { alias: 'renamed' }, { expectedGeneration: 1 });
  assert.equal(first.alias, 'one');
  assert.equal(first.generation, 1);
  const fresh = await r.snapshot(one.id);
  assert.equal(fresh.alias, 'renamed');
  assert.equal(fresh.generation, 2);
});

test('credential and policy generations advance independently', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'gen' });

  const policy = await r.update(
    profile.id,
    { confirmations: { create_post: true }, visibility: 'headless' },
    { expectedGeneration: 1 },
  );
  assert.equal(policy.generation, 2);
  assert.equal(policy.policyGeneration, 2);
  assert.equal(policy.credentialGeneration, 1);

  const credential = await r.update(
    profile.id,
    { api: { clientId: 'abc', appType: 'script' } },
    { expectedGeneration: 2 },
  );
  assert.equal(credential.generation, 3);
  assert.equal(credential.policyGeneration, 2);
  assert.equal(credential.credentialGeneration, 2);

  await assert.rejects(
    r.update(profile.id, { visibility: 'ask' }, { expectedGeneration: 2 }),
    (error) => error.code === 'POLICY_CHANGED',
  );
});

test('update rejects identity rebinding, secret fields, and unknown keys', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'guard' });
  const cases = [
    { accountKey: 'acct_x' }, { accountId: 't2_x' }, { username: 'someone' },
    { id: 'p_other' }, { generation: 99 }, { credentialGeneration: 9 },
    { policyGeneration: 9 }, { clientSecret: 's' }, { refreshToken: 't' },
    { password: 'p' }, { accessToken: 'a' }, { expectedUsername: 'other' },
    { api: { clientSecret: 's' } }, { api: { clientId: 'x', token: 'y' } },
    { enabledBackends: ['api', 'telepathy'] }, { visibility: 'invisible' },
    { backendPreference: 'api' }, { confirmations: { create_post: 'yes' } },
    { passwordLoginEnabled: true },
  ];
  for (const patch of cases) {
    await assert.rejects(
      r.update(profile.id, patch, { expectedGeneration: 1 }),
      (error) => error.code === 'INVALID_ARGUMENT' || error.code === 'APPROVAL_REQUIRED',
      JSON.stringify(patch),
    );
  }
  assert.equal((await r.get(profile.id)).generation, 1);
});

test('the public patch allowlist applies its documented fields', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'patch' });
  const updated = await r.update(profile.id, {
    alias: 'patched',
    enabledBackends: ['api', 'browser'],
    backendPreference: ['api', 'browser'],
    passwordLoginEnabled: true,
  }, { expectedGeneration: 1, approval: { approved: true, source: 'local' } });
  assert.equal(updated.alias, 'patched');
  assert.deepEqual(updated.enabledBackends, ['api', 'browser']);
  assert.equal(updated.passwordLoginEnabled, true);
  assert.equal(updated.credentialGeneration, 2);
  assert.equal(updated.policyGeneration, 2);

  const rotation = await r.update(profile.id, { credentialRotation: true }, { expectedGeneration: 2 });
  assert.equal(rotation.credentialGeneration, 3);
  assert.equal(rotation.policyGeneration, 2);
  assert.equal(rotation.generation, 3);
});

test('checkSnapshot reports removal, policy, credential, and identity changes', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'check', expectedUsername: 'Alice' });
  await r.bindIdentity(profile.id, { username: 'Alice', accountId: 't2_abc' });
  const snap = await r.snapshot(profile.id);

  assert.deepEqual(
    { ok: (await r.checkSnapshot(snap)).ok },
    { ok: true },
  );

  await r.update(profile.id, { confirmations: { create_post: true } }, { expectedGeneration: snap.generation });
  const policy = await r.checkSnapshot(snap);
  assert.equal(policy.ok, false);
  assert.equal(policy.policyChanged, true);
  assert.equal(policy.credentialChanged, false);
  assert.equal(policy.exists, true);
  assert.equal(policy.current.policyGeneration, 2);

  const credSnap = policy.current;
  await r.update(profile.id, { api: { clientId: 'c' } }, { expectedGeneration: credSnap.generation });
  const cred = await r.checkSnapshot(credSnap);
  assert.equal(cred.credentialChanged, true);
  assert.equal(cred.policyChanged, false);

  const current = await r.snapshot(profile.id);
  await r.remove(profile.id, { approved: true, source: 'local' });
  const gone = await r.checkSnapshot(current);
  assert.equal(gone.ok, false);
  assert.equal(gone.exists, false);
  assert.equal(gone.reason, 'PROFILE_NOT_FOUND');
});

test('remove requires approval and clears the default without choosing another', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const one = await r.add({ alias: 'one' });
  const two = await r.add({ alias: 'two' });
  await r.setDefault(one.id);

  await assert.rejects(r.remove(one.id), (error) => error.code === 'APPROVAL_REQUIRED');
  await assert.rejects(r.remove(one.id, {}), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.equal((await r.get(one.id)).id, one.id);

  await assert.rejects(r.remove('missing', { approved: true }), (error) => error.code === 'PROFILE_NOT_FOUND');
  await r.remove(one.id, { approved: true, source: 'local' });
  await assert.rejects(r.get(one.id), (error) => error.code === 'PROFILE_NOT_FOUND');
  assert.equal((await r.list()).length, 1);
  assert.equal((await r.list())[0].isDefault, false);
  await assert.rejects(r.snapshot(null), (error) => error.code === 'PROFILE_REQUIRED');
});

test('resolveProfile follows explicit, default, isolated legacy precedence', async (t) => {
  const home = await tempHome(t);
  const empty = registry(home);
  const legacy = await resolveProfile({ registry: empty, explicitProfile: null, legacyConfigAvailable: true });
  assert.equal(legacy, LEGACY_PROFILE);
  assert.equal(isLegacyProfile(legacy), true);
  assert.equal(Object.isFrozen(legacy), true);

  await assert.rejects(
    resolveProfile({ registry: empty, explicitProfile: null, legacyConfigAvailable: false }),
    (error) => error.code === 'PROFILE_REQUIRED',
  );
  await assert.rejects(
    resolveProfile({ registry: empty, explicitProfile: 'work', legacyConfigAvailable: true }),
    (error) => error.code === 'PROFILE_NOT_FOUND',
  );

  const r = registry(home);
  const one = await r.add({ alias: 'one' });
  const two = await r.add({ alias: 'two' });
  await r.setDefault(two.id);

  const byDefault = await resolveProfile({ registry: r, explicitProfile: null, legacyConfigAvailable: true });
  assert.equal(byDefault.id, two.id);
  const explicit = await resolveProfile({
    registry: r,
    explicitProfile: 'ONE',
    legacyConfigAvailable: true,
  });
  assert.equal(explicit.id, one.id);
  const bySnapshot = await resolveProfile({
    registry: r,
    explicitProfile: byDefault,
    legacyConfigAvailable: false,
  });
  assert.equal(bySnapshot.id, two.id);
});

test('profiles without a default never fall back to legacy', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  await r.add({ alias: 'only' });
  await assert.rejects(
    resolveProfile({ registry: r, explicitProfile: null, legacyConfigAvailable: true }),
    (error) => error.code === 'PROFILE_REQUIRED' && Array.isArray(error.safeDetails?.aliases),
  );
});

test('offline registry use requires no profile and no Reddit configuration', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  assert.deepEqual(await r.list(), []);
  assert.equal(await r.get(undefined), null);
  await assert.rejects(r.snapshot(undefined), (error) => error.code === 'PROFILE_REQUIRED');
});

test('prototype-chain keys are rejected as profile selectors', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'real' });
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    await assert.rejects(r.get(key), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.get({ id: key }), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.setDefault(key), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.snapshot(key), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.update(key, { visibility: 'ask' }), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.remove(key, { approved: true }), (error) => error.code === 'PROFILE_NOT_FOUND', key);
    await assert.rejects(r.bindIdentity(key, { username: 'Alice' }), (error) => error.code === 'PROFILE_NOT_FOUND', key);
  }
  const listed = await r.list();
  assert.deepEqual(listed.map((entry) => entry.id), [profile.id]);
  const raw = JSON.parse(await readFile(join(home, 'profiles.json'), 'utf8'));
  assert.deepEqual(Object.keys(raw.profiles), [profile.id]);
});

test('a corrupt accounts map fails closed', async (t) => {
  const home = await tempHome(t);
  await writeFile(join(home, 'profiles.json'), JSON.stringify({
    version: 1, defaultProfileId: null, profiles: {}, accounts: { bad: null },
  }));
  const r = registry(home);
  await assert.rejects(r.list(), (error) => error.code === 'REGISTRY_CORRUPT');
  await assert.rejects(r.listAccounts(), (error) => error.code === 'REGISTRY_CORRUPT');
  await assert.rejects(r.add({ alias: 'x' }), (error) => error.code === 'REGISTRY_CORRUPT');

  const other = await tempHome(t);
  await writeFile(join(other, 'profiles.json'), JSON.stringify({
    version: 1,
    defaultProfileId: null,
    profiles: {},
    accounts: { acct_x: { accountKey: 'acct_other', accountId: null, username: 'Alice' } },
  }));
  await assert.rejects(registry(other).listAccounts(), (error) => error.code === 'REGISTRY_CORRUPT');

  const third = await tempHome(t);
  await writeFile(join(third, 'profiles.json'), JSON.stringify({
    version: 1,
    defaultProfileId: null,
    profiles: { p_x: { id: 'p_y', alias: 'x', aliasKey: 'x' } },
    accounts: {},
  }));
  await assert.rejects(registry(third).list(), (error) => error.code === 'REGISTRY_CORRUPT');
});

test('a corrupt registry fails closed', async (t) => {
  const home = await tempHome(t);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'profiles.json'), '{not json');
  const r = registry(home);
  await assert.rejects(r.list(), (error) => error.code === 'REGISTRY_CORRUPT');
  await assert.rejects(r.add({ alias: 'x' }), (error) => error.code === 'REGISTRY_CORRUPT');
  assert.equal(await readFile(join(home, 'profiles.json'), 'utf8'), '{not json');
});

test('expectedUsername is validated and stored for later identity checks', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  const profile = await r.add({ alias: 'exp', expectedUsername: ' u/Alice ' });
  assert.equal(profile.expectedUsername, 'Alice');
  await assert.rejects(r.add({ alias: 'empty', expectedUsername: '   ' }), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(r.add({ alias: 'nope', expectedUsername: 42 }), (error) => error.code === 'INVALID_ARGUMENT');
});
