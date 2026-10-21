import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLease, inspectLease, withLease } from '../src/locks.js';

const LOCKS_MODULE = new URL('../src/locks.js', import.meta.url).href;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reddit-locks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClock(start = 10_000) {
  const clock = { time: start, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

function options(clock, overrides = {}) {
  return {
    kind: 'profile',
    owner: 'test-owner',
    fs: nodeFs,
    clock: clock.now,
    sleep: clock.sleep,
    timeoutMs: 0,
    ...overrides,
  };
}

function writeMeta(dir, meta) {
  return writeFile(join(dir, 'lock.json'), JSON.stringify({
    version: 1,
    nonce: 'stale-nonce',
    pid: 424242,
    kind: 'profile',
    owner: 'crashed-owner',
    createdAt: 1_000,
    heartbeatAt: 1_000,
    ...meta,
  }));
}

function readMeta(dir) {
  return readFile(join(dir, 'lock.json'), 'utf8').then(JSON.parse);
}

async function listLockSiblings(root) {
  return readdir(root);
}

test('acquireLease creates nonce-owned metadata and releases it', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'locks', 'profile-abc');
  const clock = fakeClock(5_000);

  const lease = await acquireLease(path, options(clock, { newId: () => 'nonce-1' }));

  assert.equal(lease.nonce, 'nonce-1');
  assert.equal(lease.pid, process.pid);
  const meta = await readMeta(path);
  assert.deepEqual(meta, {
    version: 1,
    nonce: 'nonce-1',
    pid: process.pid,
    kind: 'profile',
    owner: 'test-owner',
    createdAt: 5_000,
    heartbeatAt: 5_000,
  });
  assert.equal(await lease.assertHeld(), true);

  assert.equal(await lease.release(), true);
  await assert.rejects(readFile(join(path, 'lock.json')), { code: 'ENOENT' });
  await assert.rejects(readdir(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), ['locks'], 'no quarantined lock directory is left behind');
  assert.equal(await lease.release(), false, 'release is idempotent');
});

test('a live owner is refused with a bounded wait and PROFILE_IN_USE', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock();
  const holder = await acquireLease(path, options(clock, { newId: () => 'held' }));

  await assert.rejects(
    acquireLease(path, options(clock, { owner: 'second', timeoutMs: 100, pollMs: 25, isAlive: () => true })),
    (error) => {
      assert.equal(error.code, 'PROFILE_IN_USE');
      assert.equal(error.details.pid, process.pid);
      assert.match(error.message, /in use/i);
      return true;
    },
  );

  assert.ok(clock.sleeps.length > 0, 'the waiter polls instead of spinning');
  assert.ok(clock.sleeps.length <= 4 + 1, 'the number of waits is bounded');
  assert.ok(clock.time - 10_000 <= 125, 'the wait is bounded by timeoutMs');
  assert.equal((await readMeta(path)).nonce, 'held');
  assert.equal(await holder.assertHeld(), true);
  await holder.release();
});

test('a stale lock is reclaimed only when its owner is verified dead', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  await mkdir(path);
  await writeMeta(path, {});

  const clock = fakeClock();
  const lease = await acquireLease(path, options(clock, {
    isAlive: (pid) => {
      assert.equal(pid, 424242);
      return false;
    },
    newId: () => 'fresh-nonce',
  }));

  assert.equal(lease.nonce, 'fresh-nonce');
  assert.equal((await readMeta(path)).nonce, 'fresh-nonce');
  assert.deepEqual(await listLockSiblings(root), ['lock'], 'the stale directory is not left behind');
  await lease.release();
});

test('an alive owner is never reclaimed even with a very old heartbeat (PID reuse)', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  await mkdir(path);
  await writeMeta(path, { pid: 1234, heartbeatAt: 0 });

  const clock = fakeClock(1_000_000);
  await assert.rejects(
    acquireLease(path, options(clock, { isAlive: () => true, timeoutMs: 0 })),
    (error) => error.code === 'PROFILE_IN_USE',
  );

  assert.equal((await readMeta(path)).nonce, 'stale-nonce');
  assert.equal((await readMeta(path)).pid, 1234);
});

test('an old lock with no metadata is never deleted (interrupted acquisition)', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  await mkdir(path);
  // Older than the transient-acquisition grace: no live acquisition can still be writing here.
  const stale = new Date(Date.now() - 60_000);
  await utimes(path, stale, stale);
  const clock = fakeClock();

  await assert.rejects(
    acquireLease(path, options(clock, { isAlive: () => false, timeoutMs: 0 })),
    (error) => error.code === 'LOCK_CORRUPT' && /metadata/i.test(error.message),
  );

  assert.equal((await readdir(path)).length, 0, 'the unverifiable lock directory is preserved');
});

test('a freshly created lock directory without metadata is a transient acquisition, not LOCK_CORRUPT', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  // Another process has just created the directory and has not written lock.json yet.
  await mkdir(path);
  const clock = fakeClock();

  await assert.rejects(
    acquireLease(path, options(clock, { isAlive: () => false, timeoutMs: 30, pollMs: 10 })),
    (error) => {
      assert.notEqual(error.code, 'LOCK_CORRUPT', 'an in-progress acquisition must not be reported as corrupt');
      assert.equal(error.code, 'PROFILE_IN_USE');
      return true;
    },
  );

  assert.equal((await readdir(path)).length, 0, 'the in-progress lock directory is not deleted or altered');
});

test('a concurrent acquisition that is still writing its metadata never fails a second acquirer with LOCK_CORRUPT', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');

  let delayed = false;
  const slowFs = {
    ...nodeFs,
    writeFile: async (...args) => {
      if (!delayed) {
        delayed = true;
        await new Promise((done) => setTimeout(done, 120));
      }
      return nodeFs.writeFile(...args);
    },
  };

  const holderPromise = acquireLease(path, { kind: 'profile', owner: 'slow-owner', fs: slowFs });
  // Let the holder create the directory; its metadata is deliberately still pending.
  await new Promise((done) => setTimeout(done, 20));

  const waiter = acquireLease(path, { kind: 'profile', owner: 'waiter', timeoutMs: 40, pollMs: 10 });
  const waiterResult = await waiter.then(
    (lease) => ({ lease }),
    (error) => ({ error }),
  );

  assert.equal(delayed, true, 'the slow writer took the delayed path');
  assert.ok(waiterResult.error, 'the waiter must not silently share the lease');
  assert.notEqual(waiterResult.error.code, 'LOCK_CORRUPT', 'a live, mid-acquisition owner is not a corrupt lock');
  assert.equal(waiterResult.error.code, 'PROFILE_IN_USE');

  const holder = await holderPromise;
  assert.equal((await readMeta(path)).nonce, holder.nonce);
  assert.equal(await holder.assertHeld(), true);
  await holder.release();
});

test('the metadata grace is configurable and an expired grace still preserves the lock', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  await mkdir(path);
  const clock = fakeClock();

  await assert.rejects(
    acquireLease(path, options(clock, { timeoutMs: 0, metadataGraceMs: 0 })),
    (error) => error.code === 'LOCK_CORRUPT',
  );
  assert.equal((await readdir(path)).length, 0, 'the lock directory is preserved for review');
});

test('a changed nonce during reclaim is restored, never deleted', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  await mkdir(path);
  await writeMeta(path, {});

  let mutated = false;
  const renames = [];
  const fs = {
    readFile: nodeFs.readFile,
    writeFile: nodeFs.writeFile,
    mkdir: nodeFs.mkdir,
    rm: nodeFs.rm,
    stat: nodeFs.stat,
    unlink: nodeFs.unlink,
    rename: async (from, to) => {
      renames.push([from, to]);
      if (!mutated && to.includes('.stale-')) {
        // Simulate a new owner winning the reclaim race between our read and our rename.
        mutated = true;
        const meta = await readMeta(from);
        await writeFile(join(from, 'lock.json'), JSON.stringify({
          ...meta,
          nonce: 'active-replacement',
          pid: process.pid,
          heartbeatAt: Date.now(),
        }));
      }
      return nodeFs.rename(from, to);
    },
  };

  const clock = fakeClock();
  await assert.rejects(
    acquireLease(path, options(clock, { fs, isAlive: () => false, timeoutMs: 0 })),
    (error) => error.code === 'PROFILE_IN_USE',
  );

  assert.equal(mutated, true);
  assert.equal((await readMeta(path)).nonce, 'active-replacement', 'the replacement owner keeps its lock');
  assert.deepEqual(await listLockSiblings(root), ['lock'], 'no quarantined copy is left behind');
  assert.ok(renames.length >= 2, 'the quarantined lock was restored');
});

test('release with a wrong nonce leaves the other owner lock untouched', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock();
  const lease = await acquireLease(path, options(clock, { newId: () => 'mine' }));

  const takenOver = { ...(await readMeta(path)), nonce: 'other-owner', pid: 999 };
  await writeFile(join(path, 'lock.json'), JSON.stringify(takenOver));

  assert.equal(await lease.release(), false);
  assert.deepEqual(await readMeta(path), takenOver);
  await assert.rejects(lease.assertHeld(), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(lease.heartbeat(), (error) => error.code === 'LEASE_LOST');
  assert.deepEqual(await readMeta(path), takenOver, 'heartbeat never rewrites another owner lock');
});

test('release retries a transient Windows busy rename instead of leaking the lock', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock();
  let busyRemaining = 3;
  // Windows can refuse to rename a directory while another process has a file inside it open (an
  // approval waiter polling lock.json). The owner still knows the nonce is its own, so release must
  // retry briefly rather than leave a permanently unacquirable lock behind.
  const flakyFs = {
    ...nodeFs,
    rename: async (from, to) => {
      // Only the lock-directory quarantine rename is relevant; atomic metadata writes use their own
      // temporary files and are already retried by secure-fs.
      if (String(to).includes('.stale-') && busyRemaining > 0) {
        busyRemaining -= 1;
        const error = new Error('resource busy');
        error.code = 'EBUSY';
        throw error;
      }
      return nodeFs.rename(from, to);
    },
  };
  const lease = await acquireLease(path, options(clock, { fs: flakyFs, newId: () => 'mine' }));

  assert.equal(await lease.release(), true);
  assert.equal(busyRemaining, 0);
  await assert.rejects(readdir(path), { code: 'ENOENT' }, 'the released lock directory is gone');
});

test('heartbeat only updates the heartbeat time of its own lock', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock(2_000);
  const lease = await acquireLease(path, options(clock, { newId: () => 'mine' }));

  clock.time = 9_000;
  await lease.heartbeat();

  const meta = await readMeta(path);
  assert.equal(meta.nonce, 'mine');
  assert.equal(meta.createdAt, 2_000);
  assert.equal(meta.heartbeatAt, 9_000);
  await lease.release();
});

test('a missing lock is reported as a lost lease', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock();
  const lease = await acquireLease(path, options(clock));

  await rm(path, { recursive: true, force: true });

  await assert.rejects(lease.assertHeld(), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(lease.heartbeat(), (error) => error.code === 'LEASE_LOST');
  assert.equal(await lease.release(), false);
});

test('withLease releases the lock on success and on failure', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'lock');
  const clock = fakeClock();

  const result = await withLease(path, options(clock), async (lease) => {
    assert.equal(await lease.assertHeld(), true);
    return 42;
  });
  assert.equal(result, 42);
  await assert.rejects(readdir(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);

  await assert.rejects(
    withLease(path, options(clock), async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  await assert.rejects(readdir(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);

  const again = await acquireLease(path, options(clock));
  assert.equal(await again.release(), true);
});

test('lease arguments are validated', async (t) => {
  const root = await tempDir(t);
  const clock = fakeClock();
  const path = join(root, 'lock');

  await assert.rejects(acquireLease('relative/lock', options(clock)), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(acquireLease(path, options(clock, { kind: '' })), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(acquireLease(path, options(clock, { owner: '' })), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(acquireLease(path, options(clock, { timeoutMs: -1 })), (error) => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(acquireLease(path, options(clock, { metadataGraceMs: -1 })), (error) => error.code === 'INVALID_ARGUMENT');
});

test('two spawned processes never overlap inside the lease', async (t) => {
  const root = await tempDir(t);
  const lockPath = join(root, 'locks', 'profile-shared');
  const eventsFile = join(root, 'events.jsonl');
  await writeFile(eventsFile, '');

  const script = `
    import { acquireLease } from ${JSON.stringify(LOCKS_MODULE)};
    import { appendFile } from 'node:fs/promises';
    const lease = await acquireLease(process.env.LOCK_PATH, {
      kind: 'profile',
      owner: 'spawned-' + process.pid,
      timeoutMs: 20000,
      pollMs: 5,
    });
    await appendFile(process.env.EVENTS_FILE, JSON.stringify({ type: 'enter', pid: process.pid }) + '\\n');
    await new Promise((done) => setTimeout(done, Number(process.env.HOLD_MS)));
    await lease.heartbeat();
    await appendFile(process.env.EVENTS_FILE, JSON.stringify({ type: 'exit', pid: process.pid }) + '\\n');
    await lease.release();
  `;

  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env,
        LOCK_PATH: lockPath,
        EVENTS_FILE: eventsFile,
        HOLD_MS: '120',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });

  await Promise.all([runChild(), runChild()]);

  const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 4, `expected two enter/exit pairs, got ${JSON.stringify(events)}`);
  assert.deepEqual(events.map((event) => event.type), ['enter', 'exit', 'enter', 'exit']);
  assert.equal(events[0].pid, events[1].pid);
  assert.equal(events[2].pid, events[3].pid);
  assert.notEqual(events[0].pid, events[2].pid);
  assert.equal(events[0].pid === process.pid, false);
  await assert.rejects(readdir(lockPath), { code: 'ENOENT' }, 'both processes released the lock');
});

test('inspectLease reports a missing, live, stale, or corrupt lock without deleting it', async (t) => {
  const root = await tempDir(t);
  const path = join(root, 'locks', 'profile-abc');

  assert.deepEqual(await inspectLease(path, { fs: nodeFs }), { held: false });

  await mkdir(path, { recursive: true });
  await writeMeta(path, { pid: process.pid, nonce: 'live-nonce' });
  const live = await inspectLease(path, { fs: nodeFs });
  assert.equal(live.held, true);
  assert.equal(live.live, true);
  assert.equal(live.pid, process.pid);
  assert.equal(live.nonce, 'live-nonce');
  assert.deepEqual(await readMeta(path), await readMeta(path), 'inspection does not modify the lock');

  await writeMeta(path, { pid: 424242, nonce: 'dead-nonce' });
  const stale = await inspectLease(path, { fs: nodeFs, isAlive: (pid) => pid === process.pid });
  assert.equal(stale.held, true);
  assert.equal(stale.live, false);
  assert.equal(stale.nonce, 'dead-nonce');

  await writeFile(join(path, 'lock.json'), '{not json');
  const corrupt = await inspectLease(path, { fs: nodeFs });
  assert.equal(corrupt.held, true);
  assert.equal(corrupt.live, true);
  assert.equal(corrupt.corrupt, true);
  assert.equal((await readdir(path)).includes('lock.json'), true);
});
