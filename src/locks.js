// Cross-process leases for local profile/account ownership.
// A lease is a directory containing lock.json: nonce, PID, owner and heartbeat metadata.
// Reclaiming a stale lease requires verified owner death AND an unchanged nonce; a lease that
// changed while we were claiming it is restored to its new owner, never deleted.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { writeAtomic } from './secure-fs.js';

const defaultFs = { mkdir, readFile, rename, rm, stat, unlink, writeFile };
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));
const RETRYABLE_REMOVE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BUSY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
// A release we own may lose the directory rename to a transient Windows handle (a waiter polling
// lock.json). Bounded retries clear that window; otherwise the lock would leak until the process exits.
const RELEASE_BUSY_RETRIES = 20;
const RELEASE_BUSY_RETRY_MS = 10;
const METADATA_FILE = 'lock.json';
const MAX_IMMEDIATE_RETRIES = 5;
// A second process can observe the lock directory during the short window between the owner's
// mkdir and its metadata write. Such a directory is a live acquisition, not a corrupt lock.
const DEFAULT_METADATA_GRACE_MS = 2_000;

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else: never treat that as dead.
    return error.code === 'EPERM';
  }
}

function validateMetadata(meta, path) {
  const valid = meta && typeof meta === 'object'
    && isNonEmptyString(meta.nonce, 256)
    && Number.isInteger(meta.pid) && meta.pid > 0
    && isNonEmptyString(meta.kind, 64)
    && isNonEmptyString(meta.owner, 200)
    && Number.isFinite(meta.createdAt)
    && Number.isFinite(meta.heartbeatAt);
  if (!valid) {
    throw codedError('LOCK_CORRUPT', `The lock at ${path} has malformed owner metadata.`);
  }
}

async function readMetadata(path, fs) {
  const raw = await fs.readFile(join(path, METADATA_FILE), 'utf8');
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw codedError('LOCK_CORRUPT', `The lock at ${path} has unreadable owner metadata.`);
  }
  validateMetadata(meta, path);
  return meta;
}

async function quietRm(fs, path) {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch {
    // The directory is already unusable to callers; do not mask the original failure.
  }
}

// Only remove a directory we still own (or that vanished / never got metadata). A reclaiming
// process may have moved ours aside and created its own in the meantime, and that lock must stay.
async function cleanupOwnLock(fs, path, nonce) {
  let ours = false;
  try {
    const meta = await readMetadata(path, fs);
    ours = meta.nonce === nonce;
  } catch (error) {
    ours = error.code === 'ENOENT' || error.code === 'LOCK_CORRUPT';
  }
  if (ours) await quietRm(fs, path);
}

async function removeBounded(path, fs, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE_REMOVE.has(error.code) || attempt >= 3) throw error;
      await sleep(10);
    }
  }
}

// Move the lock directory aside atomically, then verify it is the exact owner the caller saw.
// Only a verified match is deleted; anything else is restored or deliberately left alone.
async function takeOwnedLockDir(path, expectedNonce, { fs, newId, sleep }) {
  const quarantine = `${path}.stale-${newId()}`;
  try {
    await fs.rename(path, quarantine);
  } catch (error) {
    if (error.code === 'ENOENT') return { taken: false, reason: 'missing' };
    // Windows refuses to rename a directory that another handle has open. That is a live owner
    // from our point of view: wait or refuse, but never delete it to "repair" the lock.
    if (BUSY_RENAME.has(error.code)) return { taken: false, reason: 'busy' };
    throw error;
  }

  let moved = null;
  try {
    moved = await readMetadata(quarantine, fs);
  } catch {
    moved = null;
  }
  if (!moved || moved.nonce !== expectedNonce) {
    // A different owner replaced the lock while we were claiming it. Put it back; if the path was
    // recreated in the meantime, leave the quarantine in place rather than deleting an unverified
    // owner's lock (that owner detects the loss and fails closed).
    try {
      await fs.rename(quarantine, path);
    } catch {
      // Deliberately not removed.
    }
    return { taken: false, reason: 'changed' };
  }

  await removeBounded(quarantine, fs, sleep);
  return { taken: true };
}

function leaseLostError(path) {
  return codedError('LEASE_LOST', `The lease for ${path} is no longer owned by this process; stop and reacquire it.`);
}

function inUseError(path, meta, now) {
  const held = meta
    ? ` by PID ${meta.pid} (${meta.kind}, ${meta.owner})`
    : '';
  return codedError(
    'PROFILE_IN_USE',
    `The protected lock ${path} is in use${held}. Close the owning process or wait, then retry.`,
    meta
      ? { path, pid: meta.pid, kind: meta.kind, owner: meta.owner, heldForMs: Math.max(0, now - meta.heartbeatAt) }
      : { path },
  );
}

async function readMetadataForLease(path, fs) {
  try {
    return await readMetadata(path, fs);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'LOCK_CORRUPT') throw leaseLostError(path);
    throw error;
  }
}

// Decide whether a directory without readable metadata is still being acquired. The directory's
// modification time is used because an in-process age cannot distinguish "created a moment ago by
// another process" from "left behind by a crashed process".
async function inspectMissingMetadata(path, fs, mtimeNow, graceMs) {
  let stats;
  try {
    stats = await fs.stat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false };
    throw error;
  }
  const mtime = typeof stats?.mtimeMs === 'number' ? stats.mtimeMs : null;
  const ageMs = mtime === null ? null : Math.max(0, mtimeNow() - mtime);
  return {
    present: true,
    ageMs,
    // Unknown age is not trusted: the caller may remove it only on explicit confirmation.
    transient: ageMs !== null && ageMs < graceMs,
  };
}

function corruptLockError(path, ageMs, graceMs) {
  const age = ageMs === null
    ? 'an unknown time'
    : `${Math.round(ageMs)} ms (grace ${Math.round(graceMs)} ms)`;
  return codedError(
    'LOCK_CORRUPT',
    `The lock at ${path} has no readable owner metadata and is older than ${age}. `
      + 'A previous process may have stopped while acquiring it. Confirm that no process is using '
      + 'this profile, then remove that directory.',
  );
}

function createLease({ path, meta, nonce, pid, fs, clock, sleep, newId }) {
  let released = false;

  return {
    path,
    nonce,
    pid,
    kind: meta.kind,
    owner: meta.owner,

    async assertHeld() {
      const current = await readMetadataForLease(path, fs);
      if (current.nonce !== nonce) throw leaseLostError(path);
      return true;
    },

    // Heartbeat is advisory: reclaim decisions use verified owner death, not age. It still refuses
    // to touch a lock whose nonce no longer matches, and re-reads immediately before writing.
    async heartbeat() {
      const current = await readMetadataForLease(path, fs);
      if (current.nonce !== nonce) throw leaseLostError(path);
      const confirmed = await readMetadataForLease(path, fs);
      if (confirmed.nonce !== nonce) throw leaseLostError(path);
      const next = { ...confirmed, heartbeatAt: clock() };
      await writeAtomic(join(path, METADATA_FILE), JSON.stringify(next), { fs, sleep, newId });
      return next.heartbeatAt;
    },

    async release() {
      if (released) return false;
      for (let attempt = 0; ; attempt += 1) {
        let current;
        try {
          current = await readMetadata(path, fs);
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'LOCK_CORRUPT') {
            released = true;
            return false;
          }
          throw error;
        }
        if (current.nonce !== nonce) return false;
        const claim = await takeOwnedLockDir(path, nonce, { fs, newId, sleep });
        if (claim.taken) {
          released = true;
          return true;
        }
        // 'changed' means another owner is there now: never touch it. 'busy' is a transient Windows
        // handle on our own directory, so re-read the nonce and try again a bounded number of times.
        if (claim.reason !== 'busy' || attempt >= RELEASE_BUSY_RETRIES) return false;
        await sleep(RELEASE_BUSY_RETRY_MS);
      }
    },
  };
}

export async function acquireLease(path, options = {}) {
  const {
    kind,
    owner,
    fs = defaultFs,
    clock = () => Date.now(),
    isAlive = defaultIsAlive,
    timeoutMs = 10_000,
    pollMs = 25,
    sleep = defaultSleep,
    newId = randomUUID,
    metadataGraceMs = DEFAULT_METADATA_GRACE_MS,
    mtimeNow = () => Date.now(),
  } = options;

  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw codedError('INVALID_ARGUMENT', 'A lease path must be an absolute local directory path.');
  }
  if (!isNonEmptyString(kind, 64)) {
    throw codedError('INVALID_ARGUMENT', 'A lease kind must be a short non-empty string.');
  }
  if (!isNonEmptyString(owner, 200)) {
    throw codedError('INVALID_ARGUMENT', 'A lease owner must be a short non-empty descriptor (not a secret).');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw codedError('INVALID_ARGUMENT', 'timeoutMs must be a non-negative number of milliseconds.');
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw codedError('INVALID_ARGUMENT', 'pollMs must be a positive number of milliseconds.');
  }
  if (!Number.isFinite(metadataGraceMs) || metadataGraceMs < 0) {
    throw codedError('INVALID_ARGUMENT', 'metadataGraceMs must be a non-negative number of milliseconds.');
  }

  const nonce = newId();
  const pid = process.pid;
  const deadline = clock() + timeoutMs;
  await fs.mkdir(dirname(path), { recursive: true });

  let immediate = 0;
  let lastMeta = null;

  const waitOnce = async () => {
    const now = clock();
    if (now >= deadline) throw inUseError(path, lastMeta, now);
    await sleep(Math.min(pollMs, deadline - now));
  };

  for (;;) {
    let created = false;
    try {
      await fs.mkdir(path);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    if (created) {
      const meta = {
        version: 1,
        nonce,
        pid,
        kind,
        owner,
        createdAt: clock(),
        heartbeatAt: clock(),
      };
      try {
        await writeAtomic(join(path, METADATA_FILE), JSON.stringify(meta), { fs, sleep, newId });
        const stored = await readMetadata(path, fs);
        if (stored.nonce !== nonce) {
          throw codedError('PROFILE_IN_USE', `The protected lock ${path} was taken while it was being created.`);
        }
      } catch (error) {
        await cleanupOwnLock(fs, path, nonce);
        throw error;
      }
      return createLease({ path, meta, nonce, pid, fs, clock, sleep, newId });
    }

    let meta = null;
    try {
      meta = await readMetadata(path, fs);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'LOCK_CORRUPT') throw error;

      // Either the directory was released between our mkdir and this read, it exists without
      // metadata because a concurrent acquisition is still writing it, or a previous acquisition
      // stopped midway. Only the last case is a corrupt lock.
      const observed = await inspectMissingMetadata(path, fs, mtimeNow, metadataGraceMs);
      if (!observed.present) {
        immediate += 1;
        if (immediate > MAX_IMMEDIATE_RETRIES) await waitOnce();
        else continue;
      } else if (observed.transient) {
        await waitOnce();
        continue;
      } else {
        throw corruptLockError(path, observed.ageMs, metadataGraceMs);
      }
    }

    if (meta) {
      lastMeta = meta;
      if (!isAlive(meta.pid)) {
        // Confirm the owner and nonce right before the claim to shrink the reclaim race window.
        let confirm = null;
        try {
          confirm = await readMetadata(path, fs);
        } catch {
          confirm = null;
        }
        if (confirm && confirm.nonce === meta.nonce && !isAlive(confirm.pid)) {
          const claim = await takeOwnedLockDir(path, meta.nonce, { fs, newId, sleep });
          if (claim.taken || claim.reason === 'missing') {
            immediate += 1;
            if (immediate > MAX_IMMEDIATE_RETRIES) await waitOnce();
            else continue;
          }
          // 'changed' or 'busy': treat as held by whoever is there now.
          if (claim.reason === 'changed') lastMeta = await readMetadata(path, fs).catch(() => lastMeta);
        }
      }
    }

    await waitOnce();
  }
}

// Read-only lease inspection for callers that do not own the profile in this process (for example a
// CLI profile removal). It never creates, reclaims, or deletes a lock. A corrupt lock is reported as
// held/live so a caller fails closed rather than deleting owner metadata behind a live browser.
export async function inspectLease(path, { fs = defaultFs, isAlive = defaultIsAlive } = {}) {
  let meta;
  try {
    meta = await readMetadata(path, fs);
  } catch (error) {
    if (error.code === 'ENOENT') return { held: false };
    return { held: true, live: true, corrupt: true, path };
  }
  const live = isAlive(meta.pid);
  return {
    held: true,
    live,
    stale: !live,
    pid: meta.pid,
    kind: meta.kind,
    owner: meta.owner,
    nonce: meta.nonce,
    heartbeatAt: meta.heartbeatAt,
    path,
  };
}

export async function withLease(path, options, fn) {
  const lease = await acquireLease(path, options);
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}
