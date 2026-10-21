import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileRegistry } from '../src/profiles.js';
import {
  accountDir,
  createAccountRegistry,
  normalizeUsername,
  usernameKey,
} from '../src/accounts.js';

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-accounts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function setup(homeDir) {
  let next = 0;
  const registry = createProfileRegistry({
    homeDir,
    clock: () => 1_700_000_000_000,
    newId: () => `id${++next}`,
  });
  return { registry, accounts: createAccountRegistry({ registry }) };
}

test('two verified aliases for one account share one stable key', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const one = await registry.add({ alias: 'one', expectedUsername: 'Alice' });
  const two = await registry.add({ alias: 'two' });

  const a = await accounts.bind({ profileId: one.id, accountId: 't2_abc', username: 'Alice' });
  const b = await accounts.bind({ profileId: two.id, accountId: 't2_abc', username: 'alice' });
  assert.equal(a.accountKey, b.accountKey);
  assert.match(a.accountKey, /^acct_[0-9a-f]{32}$/);
  assert.equal(a.username, 'Alice');
  assert.equal(b.username, 'alice');

  const lookup = await accounts.lookup({ accountId: 't2_abc' });
  assert.equal(lookup.accountKey, a.accountKey);
  assert.deepEqual([...lookup.profileIds].sort(), [one.id, two.id].sort());

  const byName = await accounts.lookup({ username: 'u/ALICE' });
  assert.equal(byName.accountKey, a.accountKey);
  assert.equal(byName.accountId, 't2_abc');
});

test('username-only UI identity resolves through the same account registry', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const verified = await registry.add({ alias: 'verified' });
  const ui = await registry.add({ alias: 'ui' });

  const first = await accounts.bind({ profileId: verified.id, accountId: 't2_x1', username: 'Alice' });
  const second = await accounts.bind({ profileId: ui.id, username: 'alice' });
  assert.equal(second.accountKey, first.accountKey);
  assert.equal(second.accountId, 't2_x1');

  const snap = await registry.snapshot(ui.id);
  assert.equal(snap.accountKey, first.accountKey);
  assert.equal(snap.accountId, 't2_x1');
  assert.equal(snap.username, 'alice');
});

test('conflicting account id or username binding blocks rather than merges', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const one = await registry.add({ alias: 'one' });
  const two = await registry.add({ alias: 'two' });

  await accounts.bind({ profileId: one.id, accountId: 't2_abc', username: 'Alice' });

  await assert.rejects(
    accounts.bind({ profileId: two.id, accountId: 't2_different', username: 'Alice' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  await assert.rejects(
    accounts.bind({ profileId: two.id, accountId: 't2_abc', username: 'Bob' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  assert.equal((await registry.snapshot(two.id)).accountKey, null);
});

test('account ids compare and store case-insensitively', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const one = await registry.add({ alias: 'one' });
  const two = await registry.add({ alias: 'two' });

  const first = await accounts.bind({ profileId: one.id, accountId: 't2_ABC', username: 'Alice' });
  assert.equal(first.accountId, 't2_abc');
  assert.equal((await registry.snapshot(one.id)).accountId, 't2_abc');

  await assert.rejects(
    accounts.bind({ profileId: two.id, accountId: 't2_abc', username: 'Bob' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  const same = await accounts.bind({ profileId: two.id, accountId: 't2_aBc', username: 'alice' });
  assert.equal(same.accountKey, first.accountKey);
  assert.equal((await accounts.list()).length, 1);
});

test('lookup blocks when the account id and username disagree', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'lookup' });
  const binding = await accounts.bind({ profileId: profile.id, accountId: 't2_abc', username: 'Alice' });

  const both = await accounts.lookup({ accountId: 't2_ABC', username: 'u/Alice' });
  assert.equal(both.accountKey, binding.accountKey);

  await assert.rejects(
    accounts.lookup({ accountId: 't2_abc', username: 'TotallyDifferent' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
});

test('a username-only rebind keeps the profile account id when the account record is missing', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'keep' });
  await accounts.bind({ profileId: profile.id, accountId: 't2_keep', username: 'Alice' });

  const raw = JSON.parse(await readFile(join(home, 'profiles.json'), 'utf8'));
  raw.accounts = {};
  await writeFile(join(home, 'profiles.json'), JSON.stringify(raw));

  const again = await accounts.bind({ profileId: profile.id, username: 'Alice' });
  assert.equal(again.accountId, 't2_keep');
  assert.equal((await registry.snapshot(profile.id)).accountId, 't2_keep');
});

test('a profile cannot silently rebind to another account', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'bound' });
  await accounts.bind({ profileId: profile.id, accountId: 't2_one', username: 'Alice' });
  await assert.rejects(
    accounts.bind({ profileId: profile.id, accountId: 't2_two', username: 'Bob' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  assert.equal((await registry.snapshot(profile.id)).accountId, 't2_one');
});

test('expectedUsername must match the verified username case-insensitively', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'expected', expectedUsername: 'Alice' });
  await assert.rejects(
    accounts.bind({ profileId: profile.id, accountId: 't2_bad', username: 'Mallory' }),
    (error) => error.code === 'IDENTITY_MISMATCH',
  );
  const ok = await accounts.bind({ profileId: profile.id, accountId: 't2_good', username: 'ALICE' });
  assert.equal(ok.username, 'ALICE');
});

test('invalid account ids and usernames are rejected before storage', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'invalid' });
  for (const accountId of ['abc', 't2_', 't2_bad name', 42, '']) {
    await assert.rejects(
      accounts.bind({ profileId: profile.id, accountId, username: 'Alice' }),
      (error) => error.code === 'INVALID_ARGUMENT',
      String(accountId),
    );
  }
  for (const username of ['', '   ', 'u/', 42]) {
    await assert.rejects(
      accounts.bind({ profileId: profile.id, username }),
      (error) => error.code === 'INVALID_ARGUMENT',
      String(username),
    );
  }
  assert.equal((await registry.snapshot(profile.id)).accountKey, null);
});

test('binding an unknown profile is reported as PROFILE_NOT_FOUND', async (t) => {
  const home = await tempHome(t);
  const { accounts } = setup(home);
  await assert.rejects(
    accounts.bind({ profileId: 'p_missing', username: 'Alice' }),
    (error) => error.code === 'PROFILE_NOT_FOUND',
  );
});

test('account keys and directory names derive only from hashes', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const profile = await registry.add({ alias: 'private-alias' });
  const binding = await accounts.bind({ profileId: profile.id, accountId: 't2_hash', username: 'VisibleUser' });
  for (const secretish of ['private', 'alias', 'visible', 'user']) {
    assert.ok(!binding.accountKey.includes(secretish));
    assert.ok(!accounts.dirName(binding.accountKey).toLowerCase().includes(secretish));
  }
  assert.equal(accountDir(home, binding.accountKey), join(home, 'accounts', binding.accountKey));
  assert.equal(accounts.dirName(binding.accountKey), binding.accountKey);
  assert.throws(() => accounts.dirName('../escape'), (error) => error.code === 'INVALID_ARGUMENT');
});

test('normalizeUsername and usernameKey agree across formatting', () => {
  assert.equal(normalizeUsername('  u/Alice ').username, 'Alice');
  assert.equal(usernameKey('u/ALICE'), usernameKey('alice'));
  assert.equal(usernameKey('Alice'), 'alice');
  assert.throws(() => normalizeUsername(''), (error) => error.code === 'INVALID_ARGUMENT');
});

test('bindings are stable across registry reloads and account removal is clean', async (t) => {
  const home = await tempHome(t);
  const { registry, accounts } = setup(home);
  const one = await registry.add({ alias: 'one' });
  const two = await registry.add({ alias: 'two' });
  const first = await accounts.bind({ profileId: one.id, accountId: 't2_keep', username: 'Alice' });
  await accounts.bind({ profileId: two.id, accountId: 't2_keep', username: 'Alice' });

  const reloaded = setup(home);
  const again = await reloaded.accounts.bind({ profileId: one.id, accountId: 't2_keep', username: 'Alice' });
  assert.equal(again.accountKey, first.accountKey);

  await reloaded.registry.remove(two.id, { approved: true, source: 'local' });
  await reloaded.registry.remove(one.id, { approved: true, source: 'local' });
  assert.equal(await reloaded.accounts.lookup({ username: 'Alice' }), null);
  const raw = JSON.parse(await readFile(join(home, 'profiles.json'), 'utf8'));
  assert.deepEqual(raw.accounts, {});
});
