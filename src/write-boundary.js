// The single cross-backend write boundary. Every mutating route (official API, experimental replay,
// rendered UI) enters here exactly once per logical write; there is no second guard inside a backend
// and no recursive re-entry.
//
// Order of effects:
//   1. preflight: operation shape, verified account, app-only refusal, approval policy, revalidation
//   2. reserve a durable account-scoped attempt and scheduling slot (src/attempts.js)
//   3. wait for the slot without holding the account lock; recheck spacing
//   4. prepare the backend payload (no external mutation) and revalidate the frozen context
//   5. consume a trusted local approval binding when policy requires one
//   6. durably mark DISPATCHED, then perform the one allowed commit
//   7. settle SUCCEEDED / FAILED_KNOWN / OUTCOME_UNKNOWN and invalidate same-account caches on
//      success and unknown
//
// A prep, approval, or revalidation refusal cancels the reservation, so it never consumes quota or
// blocks the duplicate check. After the durable mark there is no retry path: an ambiguous failure is
// recorded as unknown and no backend is asked to try again.

import { createHash } from 'node:crypto';
import { resolveApprovalPolicy } from './approvals.js';
import { OperationError, OUTCOMES } from './errors.js';
import { WRITE_TOOL_NAMES } from './operations.js';

const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);
const MAX_SCHEDULE_CYCLES = 1_000;
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

function isNonEmptyString(value, maxLength = 500) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function preflightError(message) {
  return new OperationError('UNSUPPORTED_OPERATION', message);
}

// Policy resolution stays in approvals.js for the 11 shipped write tools. A future raw mutation key
// (Task 7's raw_post) has no per-action approval entry yet, so the global switch still applies and a
// one-call confirmation request may only add strictness.
function requiresApproval(policy, operation) {
  const requestConfirmation = operation.args?.confirm === true;
  if (WRITE_TOOL_SET.has(operation.policyKey)) {
    return resolveApprovalPolicy(policy, operation.policyKey, { requestConfirmation });
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('The approval policy must be an object.');
  }
  const global = policy.global ?? 'off';
  if (global !== 'off' && global !== 'on') throw new TypeError('The global approval policy must be "off" or "on".');
  return requestConfirmation || global === 'on';
}

function appOnly(context) {
  return context.authMode === 'app'
    || context.readOnly === true
    || context.profile?.api?.authMode === 'app'
    || context.profile?.readOnly === true;
}

function assertVerifiedAccount(ledger, operation, context) {
  const accountKey = ledger?.accountKey;
  if (!isNonEmptyString(accountKey, 200)) {
    throw new TypeError('The write boundary needs a ledger bound to one verified account.');
  }
  if (operation.requiresIdentity === false) {
    throw preflightError('A write operation cannot skip identity verification.');
  }
  const contextKey = context.accountKey;
  if (contextKey === undefined || contextKey === null || contextKey === '') {
    throw new OperationError('IDENTITY_UNVERIFIED', 'A write needs a verified account; this call has none.');
  }
  if (contextKey !== accountKey || (context.profile?.accountKey && context.profile.accountKey !== accountKey)) {
    throw new OperationError('IDENTITY_MISMATCH', 'The call context does not belong to the ledger account; refusing the write.');
  }
  if (context.verified === false) {
    throw new OperationError('IDENTITY_UNVERIFIED', 'The account identity was not verified; refusing the write.');
  }
}

function approvalBinding(operation, context, accountKey) {
  const profileId = context.profile?.id ?? context.profileId;
  if (!isNonEmptyString(profileId, 200)) {
    throw new OperationError('APPROVAL_REQUIRED', 'A stored profile is required before a trusted local approval can be bound to this write.');
  }
  const policyGeneration = Number.isInteger(context.profile?.policyGeneration)
    ? context.profile.policyGeneration
    : (Number.isInteger(context.policyGeneration) ? context.policyGeneration : 0);
  return {
    profileId,
    accountKey,
    tool: operation.policyKey,
    // The approval store binds canonical hashes, never raw targets or content.
    targetHash: createHash('sha256').update(operation.target).digest('hex'),
    contentHash: operation.contentHash ?? null,
    policyGeneration,
  };
}

function classifyCommitFailure(error) {
  if (error?.outcome === OUTCOMES.FAILED_KNOWN) return OUTCOMES.FAILED_KNOWN;
  // Everything else after this point may have reached Reddit: a lost response, unparseable
  // completion, stale UI, or an unattributed error is unknown, never a free retry.
  return OUTCOMES.OUTCOME_UNKNOWN;
}

function unknownFailure(error, attempt) {
  const details = { attemptId: attempt?.id ?? null, outcome: OUTCOMES.OUTCOME_UNKNOWN };
  if (error instanceof OperationError) {
    // Keep the canonical unknown error but still attach the attempt id, matching the other paths.
    if (error.outcome === OUTCOMES.OUTCOME_UNKNOWN) return withAttempt(error, attempt);
    return new OperationError(error.code, error.message, {
      outcome: OUTCOMES.OUTCOME_UNKNOWN,
      retryAfterMs: error.retryAfterMs,
      safeDetails: { ...(error.safeDetails ?? {}), ...details },
    });
  }
  return new OperationError(
    'OUTCOME_UNKNOWN',
    'The write may have reached Reddit, but its completion could not be established. '
      + 'It is recorded as uncertain and will not be resent automatically; reconcile or resolve it locally.',
    { outcome: OUTCOMES.OUTCOME_UNKNOWN, safeDetails: details },
  );
}

function withAttempt(error, attempt) {
  if (error instanceof OperationError) {
    return new OperationError(error.code, error.message, {
      outcome: error.outcome,
      retryAfterMs: error.retryAfterMs,
      safeDetails: { ...(error.safeDetails ?? {}), attemptId: attempt?.id ?? null },
    });
  }
  return error;
}

export function createWriteBoundary({
  ledger,
  policy = { global: 'off', perAction: {} },
  approvalStore = null,
  revalidate = null,
  clock = () => Date.now(),
  sleep = defaultSleep,
  limits = undefined,
  cacheGeneration = null,
} = {}) {
  if (!ledger || typeof ledger.reserve !== 'function' || typeof ledger.markDispatched !== 'function' || typeof ledger.settle !== 'function') {
    throw new TypeError('createWriteBoundary needs a durable attempt ledger (reserve/markDispatched/settle).');
  }
  if (revalidate !== null && typeof revalidate !== 'function') throw new TypeError('revalidate must be a function or null.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function.');
  if (limits !== undefined && (limits === null || typeof limits !== 'object' || Array.isArray(limits))) {
    throw new TypeError('limits must be an object when supplied.');
  }

  async function cancel(attempt, error) {
    if (attempt && typeof ledger.cancel === 'function') {
      // A failure to release must not replace the actionable refusal. A live-process preparation is
      // still governed by the prepared TTL; a dispatched mark is never cancelled here.
      try {
        await ledger.cancel(attempt.id);
      } catch {
        // Kept for reconciliation; the original error is what the caller must see.
      }
    }
    throw withAttempt(error, attempt);
  }

  async function waitForSlot(attempt) {
    if (typeof ledger.recheckSlot !== 'function') {
      const waitMs = Math.max(0, (attempt.scheduledAt ?? 0) - clock());
      if (waitMs > 0) await sleep(waitMs);
      return;
    }
    for (let cycle = 0; cycle < MAX_SCHEDULE_CYCLES; cycle += 1) {
      const slot = await ledger.recheckSlot(attempt.id);
      if (!slot || slot.ready) return;
      if (!(slot.waitMs > 0)) return;
      await sleep(slot.waitMs);
    }
    throw new OperationError('THROTTLED', 'The account write schedule did not clear; try again later.');
  }

  // The ledger rechecks spacing and the scheduled slot inside markDispatched's lock: preparation and
  // an approval prompt can both outlive the slot checked before them. When the slot has moved, wait
  // and ask again; the mark itself is atomic, so only one of two racing attempts can take a slot.
  async function markWhenReady(attempt, afterWait = null) {
    for (let cycle = 0; cycle < MAX_SCHEDULE_CYCLES; cycle += 1) {
      try {
        return await ledger.markDispatched(attempt.id);
      } catch (error) {
        if (error?.code !== 'ATTEMPT_NOT_READY') throw error;
        const waitMs = Number(error.details?.waitMs);
        if (!(waitMs > 0)) throw error;
        // A dispatch that had to wait is dispatched against a later generation than the one checked
        // before the approval prompt, so revalidate the frozen context before retrying the mark.
        await sleep(waitMs);
        if (afterWait) await afterWait();
      }
    }
    throw new OperationError('THROTTLED', 'The account write schedule did not clear; try again later.');
  }

  async function invalidateCaches() {
    if (!cacheGeneration) return null;
    if (typeof cacheGeneration.bump !== 'function') throw new TypeError('cacheGeneration must expose bump().');
    return cacheGeneration.bump();
  }

  async function run({ operation, context = {}, prepare, commit } = {}) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new TypeError('run needs an operation descriptor.');
    }
    if (operation.kind !== 'write') {
      throw preflightError(`Only write operations pass the write boundary; got ${operation.kind ?? 'no kind'}.`);
    }
    if (!isNonEmptyString(operation.policyKey, 200) || !isNonEmptyString(operation.target, 500)) {
      throw preflightError('The write operation is missing its policy key or canonical target.');
    }
    if (typeof commit !== 'function') throw new TypeError('run needs a commit function.');
    if (prepare !== undefined && typeof prepare !== 'function') throw new TypeError('prepare must be a function when supplied.');

    assertVerifiedAccount(ledger, operation, context);
    if (appOnly(context)) {
      throw new OperationError('APP_ONLY_READ_ONLY', 'An app-only session is read-only; it cannot perform writes.');
    }
    // Policy preflight happens before any durable reservation, so a malformed policy records nothing.
    const approvalRequired = requiresApproval(policy, operation);

    if (revalidate) await revalidate({ operation, context, phase: 'preflight' });

    const attempt = await ledger.reserve(operation, context, limits ? { limits } : {});

    let prepared;
    try {
      await waitForSlot(attempt);
      if (prepare) prepared = await prepare({ operation, context, attempt });
      // Identity, credential, and policy generations are checked immediately before dispatch.
      if (revalidate) await revalidate({ operation, context, phase: 'commit' });
      if (approvalRequired) {
        if (!approvalStore || typeof approvalStore.consume !== 'function') {
          throw new OperationError('APPROVAL_REQUIRED', 'This action requires a trusted local approval, and no local approval store is available.');
        }
        await approvalStore.consume(approvalBinding(operation, context, ledger.accountKey));
      }
      await markWhenReady(
        attempt,
        revalidate ? async () => revalidate({ operation, context, phase: 'commit' }) : null,
      );
    } catch (error) {
      return cancel(attempt, error);
    }

    let committed;
    try {
      committed = await commit(prepared, context);
    } catch (error) {
      const outcome = classifyCommitFailure(error);
      await ledger.settle(attempt.id, outcome);
      if (outcome === OUTCOMES.FAILED_KNOWN) throw withAttempt(error, attempt);
      // The durable unknown is already recorded. A cache-store failure must not replace the caller's
      // outage classification with an unrelated storage error; the stale generation is retried by the
      // next successful bump. (The success path deliberately surfaces bump errors: there is no write
      // failure to report instead.)
      try {
        await invalidateCaches();
      } catch {
        // Keep the canonical OUTCOME_UNKNOWN below.
      }
      throw unknownFailure(error, attempt);
    }

    await ledger.settle(attempt.id, OUTCOMES.SUCCEEDED);
    const generation = await invalidateCaches();

    const committedData = committed !== null && typeof committed === 'object'
      && Object.hasOwn(committed, 'data') && Object.hasOwn(committed, 'meta')
      ? committed.data
      : committed;
    const committedMeta = committed !== null && typeof committed === 'object'
      && Object.hasOwn(committed, 'data') && Object.hasOwn(committed, 'meta')
      ? committed.meta
      : null;

    const meta = {
      ...(committedMeta ?? {}),
      attemptId: attempt.id,
      outcome: OUTCOMES.SUCCEEDED,
      backend: context.backendId ?? null,
      accountKey: ledger.accountKey,
      profileId: context.profile?.id ?? null,
      profile: context.profile?.alias ?? null,
      username: context.profile?.username ?? context.profile?.expectedUsername ?? null,
    };
    if (generation !== null) meta.cacheGeneration = generation;
    return Object.freeze({ data: committedData, meta: Object.freeze(meta) });
  }

  return Object.freeze({ run });
}
