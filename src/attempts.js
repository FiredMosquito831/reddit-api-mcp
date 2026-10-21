// Durable per-account write admission and outcome ledger.
//
// One verified Reddit account owns one ledger, shared by every profile alias and every backend
// (API, replay, rendered UI). Each logical write reserves a scheduled slot before any external
// action, records a durable DISPATCHED mark immediately before the final send/click, and settles as
// SUCCEEDED, FAILED_KNOWN, or OUTCOME_UNKNOWN. A crash between the mark and a settlement leaves a
// DISPATCHED attempt that stays uncertain: it keeps blocking duplicates and consuming quota until a
// read-only reconciliation or an explicit local resolution. Pending uncertainty is never truncated.
//
// The file holds hashes, identifiers, states, and timestamps only: never post text, targets' content,
// or any secret. Admission, scheduling, marking, and settlement run under the cross-process account
// lock (src/locks.js), so two CLI/MCP processes and two aliases of one account cannot bypass limits
// or overwrite each other's outcomes. The lock is never held while waiting for a scheduled slot,
// preparing a page, prompting a human, or talking to Reddit.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accountDirName } from './accounts.js';
import { OperationError, OUTCOMES } from './errors.js';
import { withLease } from './locks.js';
import { assertHourlyCap, spacingDelay } from './safety.js';
import { writeAtomic } from './secure-fs.js';

export const ATTEMPTS_FILE = 'attempts.json';
export const CACHE_GENERATION_FILE = 'cache-generation.json';
export const LEDGER_VERSION = 1;
const ACCOUNT_LOCK = join('locks', 'account-write');

const PENDING_STATES = new Set(['PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN']);
const SETTLED_STATES = new Set([OUTCOMES.SUCCEEDED, OUTCOMES.FAILED_KNOWN, OUTCOMES.OUTCOME_UNKNOWN]);

export const DEFAULT_LIMITS = Object.freeze({
  minGapMs: 2_000,
  duplicateWindowMs: 24 * 60 * 60 * 1000,
  maxWritesPerHour: 30,
});

// State names are the public outcome contract; PREPARED/DISPATCHED are intermediate states.
const TERMINAL_OUTCOMES = new Set([OUTCOMES.SUCCEEDED, OUTCOMES.FAILED_KNOWN, OUTCOMES.OUTCOME_UNKNOWN]);

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isNonEmptyString(value, maxLength = 500) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Verified account keys use the accounts.js naming scheme. Anything else is still folded into the
// same filesystem-safe shape deterministically rather than trusted as a path component.
export function accountStateDir(homeDir, accountKey) {
  if (!isNonEmptyString(homeDir, 4096)) throw codedError('INVALID_ARGUMENT', 'An attempt ledger needs a home directory.');
  if (!isNonEmptyString(accountKey, 200)) throw codedError('INVALID_ARGUMENT', 'An attempt ledger needs an account key.');
  try {
    const name = accountDirName(accountKey);
    return join(homeDir, 'accounts', name);
  } catch {
    const digest = createHash('sha256').update(accountKey).digest('hex').slice(0, 32);
    return join(homeDir, 'accounts', `acct_${digest}`);
  }
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function normalizeState(raw, accountKey) {
  if (!raw || typeof raw !== 'object' || raw.version !== LEDGER_VERSION) {
    throw codedError('ATTEMPT_LEDGER_CORRUPT', 'The local attempt ledger has an unsupported format.');
  }
  if (raw.accountKey !== accountKey || !Array.isArray(raw.attempts)) {
    throw codedError('ATTEMPT_LEDGER_CORRUPT', 'The local attempt ledger does not belong to this account.');
  }
  return raw;
}

// A stored attempt is a small receipt: identifiers, hashes, state and timestamps. No text or secrets.
function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('An attempt descriptor must be an operation object.');
  }
  if (descriptor.kind !== undefined && descriptor.kind !== 'write') {
    throw new TypeError('Only write operations are reserved in the attempt ledger.');
  }
  if (!isNonEmptyString(descriptor.policyKey, 200)) {
    throw new TypeError('An attempt descriptor needs a policyKey.');
  }
  if (!isNonEmptyString(descriptor.target, 500)) {
    throw new TypeError('An attempt descriptor needs a canonical target.');
  }
  const contentHash = descriptor.contentHash ?? null;
  if (contentHash !== null && !isNonEmptyString(contentHash, 256)) {
    throw new TypeError('descriptor.contentHash must be a hash string or null.');
  }
  return {
    tool: isNonEmptyString(descriptor.tool, 200) ? descriptor.tool : descriptor.policyKey,
    action: isNonEmptyString(descriptor.action, 200) ? descriptor.action : null,
    policyKey: descriptor.policyKey,
    target: descriptor.target,
    contentHash,
  };
}

// Two attempts conflict when they name the same operation on the same target with the same content.
// A null content hash (deletes) conflicts on tool + target alone; votes and saves carry a directional
// hash, so opposite directions remain distinct and sane.
function conflicts(a, b) {
  if (a.policyKey !== b.policyKey || a.target !== b.target) return false;
  if (a.contentHash !== null && b.contentHash !== null) return a.contentHash === b.contentHash;
  return true;
}

function activityAt(attempt) {
  return attempt.dispatchedAt ?? attempt.scheduledAt ?? attempt.createdAt ?? 0;
}

function countsTowardLimits(attempt) {
  return attempt.state !== OUTCOMES.FAILED_KNOWN;
}

function pendingState(state) {
  return PENDING_STATES.has(state);
}

function limitEntry(attempt) {
  return { at: attempt.createdAt ?? 0 };
}

function spacingEntry(attempt) {
  return { at: activityAt(attempt) };
}

function receipt(attempt) {
  const copy = clone(attempt);
  if (copy.state === 'DISPATCHED') copy.uncertain = true;
  return Object.freeze(copy);
}

export function createAttemptLedger({
  homeDir,
  accountKey,
  leases = null,
  clock = () => Date.now(),
  newId = randomUUID,
  isAlive = defaultIsAlive,
  fs: injectedFs = null,
  pid = process.pid,
  limits = {},
  preparedTtlMs = 15 * 60 * 1000,
  maxAttempts = 500,
  cacheGeneration = null,
} = {}) {
  if (!Number.isFinite(preparedTtlMs) || preparedTtlMs < 0) throw new TypeError('preparedTtlMs must be a non-negative number.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');

  const dir = accountStateDir(homeDir, accountKey);
  const ledgerPath = join(dir, ATTEMPTS_FILE);
  const lockPath = join(dir, ACCOUNT_LOCK);
  const lock = typeof leases?.withLease === 'function' ? leases.withLease : withLease;
  const fsOps = injectedFs ?? { readFile, mkdir };
  const baseLimits = { ...DEFAULT_LIMITS, ...limits };

  async function readState() {
    let text;
    try {
      text = await fsOps.readFile(ledgerPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: LEDGER_VERSION, accountKey, attempts: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw codedError('ATTEMPT_LEDGER_CORRUPT', 'The local attempt ledger is not readable JSON.');
    }
    return normalizeState(parsed, accountKey);
  }

  async function writeState(state) {
    await fsOps.mkdir(dir, { recursive: true });
    await writeAtomic(ledgerPath, JSON.stringify(state, null, 2), injectedFs ? { fs: injectedFs } : {});
  }

  async function locked(fn) {
    await fsOps.mkdir(dir, { recursive: true });
    return lock(lockPath, { kind: 'account-write', owner: `pid-${process.pid}`, timeoutMs: 10_000 }, fn);
  }

  // A preparation whose owning process died before dispatch is provably unsent. It may expire after a
  // grace period; a live process's preparation is never stolen. Settled receipts age out with the
  // duplicate window. Pending uncertainty (dispatched/unknown) is never dropped here.
  function prune(state, now, limits) {
    state.attempts = state.attempts.filter((attempt) => {
      if (attempt.state === 'PREPARED') {
        return isAlive(attempt.pid) || now - attempt.createdAt < preparedTtlMs;
      }
      if (pendingState(attempt.state)) return true;
      return now - activityAt(attempt) <= limits.duplicateWindowMs;
    });

    if (state.attempts.length <= maxAttempts) return;
    const excess = state.attempts.length - maxAttempts;
    const settledIds = new Set(
      state.attempts
        .filter((attempt) => !pendingState(attempt.state))
        .slice(0, excess)
        .map((attempt) => attempt.id),
    );
    if (settledIds.size > 0) {
      state.attempts = state.attempts.filter((attempt) => !settledIds.has(attempt.id));
    }
  }

  function nextSlot(state, now, limits) {
    const active = state.attempts.filter(countsTowardLimits);
    assertHourlyCap(active.map(limitEntry), now, limits.maxWritesPerHour);
    const waitMs = spacingDelay(active.map(spacingEntry), now, limits.minGapMs);
    return now + waitMs;
  }

  async function reserve(descriptor, context = {}, options = {}) {
    const fields = validateDescriptor(descriptor);
    if (context === null || typeof context !== 'object') throw new TypeError('Attempt context must be an object.');
    const contextKey = context.accountKey;
    if (contextKey === undefined || contextKey === null || contextKey === '') {
      throw new OperationError('IDENTITY_UNVERIFIED', 'A write attempt needs a verified account key before it can be reserved.');
    }
    if (contextKey !== accountKey) {
      throw new OperationError('IDENTITY_MISMATCH', 'The call context does not belong to this attempt ledger account.');
    }
    const limits = { ...baseLimits, ...(options.limits ?? {}) };

    return locked(async () => {
      const now = clock();
      const state = await readState();
      prune(state, now, limits);

      // Duplicate detection runs before quota and spacing, so a caller can distinguish "this exact
      // write is already in flight or uncertain" from "the account has no budget left".
      const duplicate = state.attempts.find((attempt) => {
        if (!conflicts(attempt, fields)) return false;
        // An in-flight preparation always blocks. Uncertainty and a recent success block inside the
        // documented duplicate window; a known rejection freed the fingerprint at settlement.
        if (attempt.state === 'PREPARED') return true;
        if (attempt.state === 'DISPATCHED' || attempt.state === OUTCOMES.OUTCOME_UNKNOWN
          || attempt.state === OUTCOMES.SUCCEEDED) {
          return now - activityAt(attempt) < limits.duplicateWindowMs;
        }
        return false;
      });
      if (duplicate) {
        throw codedError(
          'DUPLICATE_WRITE',
          'An identical write is already prepared, dispatched, or its outcome is unknown. Wait for reconciliation or resolve it locally; it is not resent automatically.',
          { attemptId: duplicate.id, state: duplicate.state },
        );
      }

      // Existing active reservations hold their scheduled slots, so a concurrent reservation lands
      // after them instead of both claiming "now". The slot is rechecked against real activity just
      // before dispatch.
      const scheduledAt = nextSlot(state, now, limits);

      const attempt = {
        id: newId(),
        state: 'PREPARED',
        tool: fields.tool,
        action: fields.action,
        policyKey: fields.policyKey,
        target: fields.target,
        contentHash: fields.contentHash,
        pid,
        createdAt: now,
        scheduledAt,
        // The spacing rule in force when the slot was taken; another process must apply the same
        // rule to this attempt even if its own configured limits differ.
        minGapMs: limits.minGapMs,
        callId: isNonEmptyString(context.callId, 200) ? context.callId : null,
        profileId: isNonEmptyString(context.profile?.id, 200) ? context.profile.id : null,
        backendId: isNonEmptyString(context.backendId, 100) ? context.backendId : null,
      };
      state.attempts.push(attempt);
      await writeState(state);
      return receipt(attempt);
    });
  }

  async function markDispatched(id) {
    assertId(id);
    return locked(async () => {
      const now = clock();
      const state = await readState();
      const attempt = findAttempt(state, id);
      if (attempt.state === 'DISPATCHED') {
        throw codedError('ATTEMPT_STATE', 'This attempt is already durably marked as dispatched.');
      }
      if (attempt.state !== 'PREPARED') {
        throw codedError('ATTEMPT_STATE', `Only a prepared attempt can be marked dispatched (state: ${attempt.state}).`);
      }

      // This is the durable dispatch point, so the scheduling rules are enforced here under the same
      // lock that records the mark. A slow preparation, a human approval prompt, or another process's
      // dispatch can all move the actual send past the slot checked before prepare; marking anyway
      // would let two writes leave inside minGapMs.
      const gapMs = attempt.minGapMs ?? baseLimits.minGapMs;
      const dispatched = state.attempts.filter(
        (other) => other.id !== id && other.dispatchedAt !== undefined && countsTowardLimits(other),
      );
      const waitFromDispatches = spacingDelay(dispatched.map((other) => ({ at: other.dispatchedAt })), now, gapMs);
      const readyAt = Math.max(now + waitFromDispatches, attempt.scheduledAt ?? now);
      if (readyAt > now) {
        if (readyAt !== attempt.scheduledAt) {
          attempt.scheduledAt = readyAt;
          await writeState(state);
        }
        throw codedError(
          'ATTEMPT_NOT_READY',
          'The account write slot has not cleared yet; wait before dispatching.',
          { waitMs: readyAt - now, scheduledAt: readyAt },
        );
      }

      attempt.state = 'DISPATCHED';
      attempt.dispatchedAt = now;
      // Persisted before the caller sends anything: a crash after this point stays uncertain.
      await writeState(state);
      return receipt(attempt);
    });
  }

  async function settle(id, outcome) {
    assertId(id);
    if (!TERMINAL_OUTCOMES.has(outcome)) {
      throw new TypeError('A settlement outcome must be SUCCEEDED, FAILED_KNOWN, or OUTCOME_UNKNOWN.');
    }
    return locked(async () => {
      const now = clock();
      const state = await readState();
      const attempt = findAttempt(state, id);
      if (attempt.state === outcome && attempt.settledAt !== undefined) return receipt(attempt);
      // Settlement is a receipt for an external effect. A PREPARED attempt was never sent, so recording
      // success, a known failure, or uncertainty for it would fabricate history and release quota. The
      // only pre-dispatch release is cancel().
      if (attempt.state !== 'DISPATCHED') {
        throw codedError(
          'ATTEMPT_STATE',
          `Only a dispatched attempt can be settled (state: ${attempt.state}); cancel a preparation instead.`,
        );
      }
      attempt.state = outcome;
      attempt.outcome = outcome;
      attempt.settledAt = now;
      await writeState(state);
      return receipt(attempt);
    });
  }

  // Release a pre-dispatch reservation (policy, approval, preparation, or revalidation refusal).
  // This is never used after markDispatched: those outcomes are settled as unknown instead.
  async function cancel(id) {
    assertId(id);
    return locked(async () => {
      const state = await readState();
      const index = state.attempts.findIndex((attempt) => attempt.id === id);
      if (index === -1) return null;
      const attempt = state.attempts[index];
      if (attempt.state !== 'PREPARED') {
        throw codedError('ATTEMPT_STATE', `Only a prepared attempt can be cancelled (state: ${attempt.state}).`);
      }
      state.attempts.splice(index, 1);
      await writeState(state);
      return receipt(attempt);
    });
  }

  async function listPending() {
    const state = await readState();
    return Object.freeze(state.attempts.filter((attempt) => pendingState(attempt.state)).map(receipt));
  }

  // Explicit user resolution of an uncertain attempt. Reconciliation is read-only; this records what
  // the user (or an evidenced read) established, and never resubmits the write.
  async function resolveLocally(id, resolution) {
    assertId(id);
    const normalized = typeof resolution === 'string'
      ? { outcome: resolution }
      : { outcome: resolution?.outcome, note: resolution?.note };
    if (normalized.outcome !== 'succeeded' && normalized.outcome !== 'failed') {
      throw new TypeError('A local resolution must be "succeeded", "failed", or { outcome, note }.');
    }
    if (normalized.note !== undefined && !isNonEmptyString(normalized.note, 200)) {
      throw new TypeError('A resolution note must be a short non-empty string.');
    }
    const resolved = await locked(async () => {
      const now = clock();
      const state = await readState();
      const attempt = findAttempt(state, id);
      if (attempt.state !== 'DISPATCHED' && attempt.state !== OUTCOMES.OUTCOME_UNKNOWN) {
        throw codedError('ATTEMPT_STATE', `Only an uncertain attempt can be resolved locally (state: ${attempt.state}).`);
      }
      attempt.state = normalized.outcome === 'succeeded' ? OUTCOMES.SUCCEEDED : OUTCOMES.FAILED_KNOWN;
      attempt.outcome = attempt.state;
      attempt.resolution = 'local';
      attempt.resolvedAt = now;
      if (normalized.note !== undefined) attempt.resolutionNote = normalized.note;
      await writeState(state);
      return receipt(attempt);
    });

    // A crash left a DISPATCHED attempt outside the boundary, so no settlement ever invalidated the
    // account caches. When an operator confirms the write landed, the same-account cache generation
    // must advance even though the ledger is now settled. A failed resolution frees the reservation
    // without changing cached reads. The bump runs after the account lock is released, because it
    // takes the same non-reentrant lock itself.
    if (resolved.state !== OUTCOMES.SUCCEEDED || !cacheGeneration) return resolved;
    if (typeof cacheGeneration.bump !== 'function') throw new TypeError('cacheGeneration must expose bump().');
    const generation = await cacheGeneration.bump();
    return Object.freeze({ ...resolved, cacheGeneration: generation });
  }

  // Called after a scheduled sleep, before dispatch: another process may have dispatched since this
  // slot was reserved, so the spacing rule is rechecked against actual activity and the slot is moved.
  async function recheckSlot(id) {
    assertId(id);
    return locked(async () => {
      const now = clock();
      const state = await readState();
      const attempt = findAttempt(state, id);
      if (attempt.state !== 'PREPARED') {
        throw codedError('ATTEMPT_STATE', `Only a prepared attempt holds a scheduling slot (state: ${attempt.state}).`);
      }
      // Only actual dispatches set the spacing baseline. A later reservation's future slot must not
      // be treated as activity, or two queued attempts could chase each other's schedules forever.
      const dispatched = state.attempts.filter(
        (other) => other.id !== id && other.dispatchedAt !== undefined && countsTowardLimits(other),
      );
      const gapMs = attempt.minGapMs ?? baseLimits.minGapMs;
      const waitFromDispatches = spacingDelay(dispatched.map((other) => ({ at: other.dispatchedAt })), now, gapMs);
      const readyAt = Math.max(now + waitFromDispatches, attempt.scheduledAt ?? now);
      if (readyAt > now) {
        if (readyAt !== attempt.scheduledAt) {
          attempt.scheduledAt = readyAt;
          await writeState(state);
        }
        return { ready: false, waitMs: readyAt - now, scheduledAt: readyAt };
      }
      return { ready: true, waitMs: 0, scheduledAt: attempt.scheduledAt };
    });
  }

  return Object.freeze({
    accountKey,
    homeDir,
    path: ledgerPath,
    limits: Object.freeze({ ...baseLimits }),
    reserve,
    markDispatched,
    settle,
    cancel,
    listPending,
    resolveLocally,
    recheckSlot,
  });
}

function assertId(id) {
  if (!isNonEmptyString(id, 200)) throw new TypeError('An attempt id is required.');
}

function findAttempt(state, id) {
  const attempt = state.attempts.find((entry) => entry.id === id);
  if (!attempt) throw codedError('ATTEMPT_NOT_FOUND', `No attempt with id ${id} exists in this account ledger.`);
  return attempt;
}

// Cross-process cache generation for one verified account. Any backend serving a cached read for this
// account compares its captured generation before reuse; success and unknown outcomes bump it, so a
// stale same-account cache in this or another process is discarded.
export function createCacheGeneration({
  homeDir,
  accountKey,
  leases = null,
  clock = () => Date.now(),
} = {}) {
  const dir = accountStateDir(homeDir, accountKey);
  const path = join(dir, CACHE_GENERATION_FILE);
  const lockPath = join(dir, ACCOUNT_LOCK);
  const lock = typeof leases?.withLease === 'function' ? leases.withLease : withLease;

  async function read() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: LEDGER_VERSION, accountKey, generation: 0, updatedAt: null };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw codedError('CACHE_GENERATION_CORRUPT', 'The account cache generation file is not readable JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== LEDGER_VERSION || parsed.accountKey !== accountKey
      || !Number.isInteger(parsed.generation) || parsed.generation < 0) {
      throw codedError('CACHE_GENERATION_CORRUPT', 'The account cache generation file has an unsupported format.');
    }
    return parsed;
  }

  return {
    accountKey,
    path,
    async current() {
      return (await read()).generation;
    },
    async bump() {
      await mkdir(dir, { recursive: true });
      return lock(lockPath, { kind: 'account-write', owner: `pid-${process.pid}`, timeoutMs: 10_000 }, async () => {
        const state = await read();
        state.generation += 1;
        state.updatedAt = clock();
        await writeAtomic(path, JSON.stringify(state, null, 2));
        return state.generation;
      });
    },
  };
}
