import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease, withLease } from '../src/locks.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createAccountRegistry } from '../src/accounts.js';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-profile-concurrency-'));
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

async function readRegistry(homeDir) {
  return JSON.parse(await readFile(join(homeDir, 'profiles.json'), 'utf8'));
}

test('parallel adds never lose an update', async (t) => {
  const home = await tempHome(t);
  const a = registry(home);
  const b = registry(home);
  await Promise.all([
    a.add({ alias: 'alpha' }),
    b.add({ alias: 'beta' }),
    a.add({ alias: 'gamma' }),
    b.add({ alias: 'delta' }),
  ]);
  const raw = await readRegistry(home);
  assert.deepEqual(
    Object.values(raw.profiles).map((profile) => profile.alias).sort(),
    ['alpha', 'beta', 'delta', 'gamma'],
  );
});

test('competing adds of one alias produce exactly one winner', async (t) => {
  const home = await tempHome(t);
  const a = registry(home);
  const b = registry(home);
  const results = await Promise.allSettled([
    a.add({ alias: 'Shared' }),
    b.add({ alias: 'shared' }),
    a.add({ alias: 'SHARED' }),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  for (const result of rejected) assert.equal(result.reason.code, 'ALIAS_TAKEN');
  assert.equal((await readRegistry(home)).profiles[fulfilled[0].value.id].alias.toLowerCase(), 'shared');
});

test('competing default updates settle on one of the written values', async (t) => {
  const home = await tempHome(t);
  const a = registry(home);
  const b = registry(home);
  const one = await a.add({ alias: 'one' });
  const two = await a.add({ alias: 'two' });

  await Promise.all([a.setDefault(one.id), b.setDefault(two.id)]);
  const raw = await readRegistry(home);
  assert.ok([one.id, two.id].includes(raw.defaultProfileId));
  assert.equal((await b.snapshot()).id, raw.defaultProfileId);
  assert.equal(raw.profiles[one.id].isDefault, undefined);
  assert.equal(raw.profiles[two.id].isDefault, undefined);
});

test('expectedGeneration serializes competing updates', async (t) => {
  const home = await tempHome(t);
  const a = registry(home);
  const b = registry(home);
  const profile = await a.add({ alias: 'race' });

  const results = await Promise.allSettled([
    a.update(profile.id, { visibility: 'headless' }, { expectedGeneration: 1 }),
    b.update(profile.id, { visibility: 'ask' }, { expectedGeneration: 1 }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'POLICY_CHANGED');
  const raw = await readRegistry(home);
  assert.equal(raw.profiles[profile.id].generation, 2);
  assert.ok(['headless', 'ask'].includes(raw.profiles[profile.id].visibility));
});

test('account binding and registry updates do not deadlock each other', async (t) => {
  const home = await tempHome(t);
  const registryA = registry(home);
  const registryB = registry(home);
  const accountsA = createAccountRegistry({ registry: registryA });
  const accountsB = createAccountRegistry({ registry: registryB });
  const one = await registryA.add({ alias: 'one' });
  const two = await registryA.add({ alias: 'two' });

  const work = Promise.all([
    accountsA.bind({ profileId: one.id, accountId: 't2_one', username: 'Alice' }),
    registryB.update(two.id, { visibility: 'headless' }, { expectedGeneration: 1 }),
    accountsB.bind({ profileId: two.id, accountId: 't2_two', username: 'Bob' }),
    registryA.setDefault(two.id),
  ]);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 10_000));
  const [binding, updated] = await Promise.race([work, timeout]);
  assert.equal(binding.accountId, 't2_one');
  assert.equal(updated.visibility, 'headless');
  const raw = await readRegistry(home);
  assert.equal(raw.profiles[one.id].accountId, 't2_one');
  assert.equal(raw.profiles[two.id].accountId, 't2_two');
  assert.equal(raw.defaultProfileId, two.id);
});

test('registry mutations respect an existing foreign lease', async (t) => {
  const home = await tempHome(t);
  const lockPath = join(home, 'locks', 'profiles-registry');
  const held = await acquireLease(lockPath, {
    kind: 'profiles-registry',
    owner: 'other-process',
    timeoutMs: 0,
  });
  try {
    const r = registry(home, {
      leases: {
        withLease: (path, options, fn) => withLease(path, { ...options, timeoutMs: 0 }, fn),
      },
    });
    await assert.rejects(r.add({ alias: 'blocked' }), (error) => error.code === 'PROFILE_IN_USE');
    await assert.rejects(r.setDefault(null), (error) => error.code === 'PROFILE_IN_USE');
  } finally {
    await held.release();
  }
});

test('the registry lock is released after a failed mutation', async (t) => {
  const home = await tempHome(t);
  const r = registry(home);
  await assert.rejects(r.add({ alias: '../bad' }), (error) => error.code === 'INVALID_ARGUMENT');
  const added = await r.add({ alias: 'after-failure' });
  assert.equal((await r.get(added.id)).alias, 'after-failure');
});
