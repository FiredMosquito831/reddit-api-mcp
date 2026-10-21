import { randomBytes } from 'node:crypto';
import { OperationError, isOutcome } from './errors.js';

// Every dimension that identifies "where the next page lives". The token itself is opaque; the binding
// is kept server-side so a cursor cannot be replayed against another account, backend, or query.
const BINDING_KEYS = ['profileId', 'accountKey', 'backend', 'operation', 'filterHash', 'credentialGeneration'];
// Public envelope keys. Anything else in a caller's metadata object is dropped rather than echoed.
const META_KEYS = ['profile', 'username', 'backend', 'completeness', 'missingFields', 'outcome', 'attemptId'];

function invalid(message, details = null) {
  return new OperationError('CONTINUATION_INVALID', message, { safeDetails: details });
}

// Bindings and task IDs are compared with `!==`, so they must be copied by value: an object would
// compare by reference, never match after a round trip, and could carry a mutable session object.
function isBindingValue(value) {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'boolean';
}

function requireBinding(binding) {
  if (binding === null || typeof binding !== 'object') {
    throw invalid('A continuation binding with an account, backend, and query is required.');
  }
  for (const key of BINDING_KEYS) {
    if (!isBindingValue(binding[key])) {
      throw invalid(`Continuation binding requires ${key}.`, { field: key });
    }
  }
}

function cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    // Never include the state value in the message: page content and tokens can live there.
    throw invalid('Continuation state must be plain cloneable data.');
  }
}

// UI cursors are short-lived capabilities bound to the original account, backend, and filters.
export function createContinuationStore({ clock = Date.now, newId = () => randomBytes(24).toString('hex'), ttlMs = 300_000, maxEntries = 200 } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('Continuation TTL and capacity must be positive whole numbers.');
  }
  const entries = new Map();
  // Tombstones keep an expired token expired instead of "unknown" and stop it from being reissued.
  // The set is bounded so a long-lived process cannot accumulate dead tokens without limit.
  const expired = new Set();
  const rememberExpired = (token) => {
    expired.add(token);
    // Trim only above capacity: `>=` would delete the tombstone just added when maxEntries is 1,
    // leaving the expired token reissuable by a colliding generator.
    while (expired.size > maxEntries) expired.delete(expired.values().next().value);
  };
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value)) throw new TypeError('Continuation clock must return a finite timestamp.');
    return value;
  };
  const sweep = (at) => {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= at) {
        entries.delete(token);
        rememberExpired(token);
      }
    }
  };
  return {
    issue(input) {
      if (input === null || typeof input !== 'object') {
        throw invalid('A continuation request object is required.');
      }
      requireBinding(input);
      if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
        throw invalid('Continuation requires an active task.', { field: 'taskId' });
      }
      const at = now();
      sweep(at);
      if (entries.size >= maxEntries) {
        // Refuse rather than evict a live task's cursor: silent eviction would strand a task that is
        // still open and could make a retried read restart under a different page.
        throw invalid('Too many active continuations. Close a task before starting another.');
      }
      const token = newId();
      if (typeof token !== 'string' || token.length === 0 || entries.has(token) || expired.has(token)) {
        throw invalid('Could not issue a unique continuation.');
      }
      entries.set(token, {
        binding: Object.fromEntries(BINDING_KEYS.map((key) => [key, input[key]])),
        taskId: input.taskId,
        state: cloneState(input.state),
        issuedAt: at,
        expiresAt: at + ttlMs,
      });
      return token;
    },
    resolve(token, binding) {
      if (typeof token !== 'string' || token.length === 0) {
        throw invalid('A continuation token is required.');
      }
      // Validate the binding before looking anything up so a malformed request cannot be mistaken
      // for an expired or foreign continuation.
      requireBinding(binding);
      if (expired.has(token)) {
        throw new OperationError('CONTINUATION_EXPIRED', 'This continuation expired. Restart the read operation.');
      }
      const entry = entries.get(token);
      if (!entry) {
        throw invalid('This continuation is not available. Restart the read operation.');
      }
      if (BINDING_KEYS.some((key) => entry.binding[key] !== binding[key])) {
        throw invalid('This continuation does not belong to the selected account, backend, or query.');
      }
      if (entry.expiresAt <= now()) {
        entries.delete(token);
        rememberExpired(token);
        throw new OperationError('CONTINUATION_EXPIRED', 'This continuation expired. Restart the read operation.');
      }
      return structuredClone(entry);
    },
    // Closing a task ends its capabilities the same way expiry does: resolve reports EXPIRED, and the
    // tombstone keeps a colliding id generator from reissuing the token to another task.
    expireTask(taskId) {
      for (const [token, entry] of entries) {
        if (entry.taskId === taskId) {
          entries.delete(token);
          rememberExpired(token);
        }
      }
    },
  };
}

function checkMetaString(meta, key, { nullable = false } = {}) {
  const value = meta[key];
  if (value === undefined) return;
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0) {
    // Name the field only; never echo the value, which is the caller's to keep.
    throw new TypeError(`Result metadata ${key} must be a${nullable ? ' null or' : ''} non-empty string.`);
  }
}

function checkCompletion(meta) {
  checkMetaString(meta, 'profile', { nullable: true });
  checkMetaString(meta, 'username', { nullable: true });
  checkMetaString(meta, 'backend');
  checkMetaString(meta, 'completeness');
  checkMetaString(meta, 'attemptId', { nullable: true });
  if (meta.outcome !== undefined && !isOutcome(meta.outcome)) {
    throw new TypeError('Result metadata outcome must be a known operation outcome.');
  }
  if (meta.missingFields !== undefined) {
    if (!Array.isArray(meta.missingFields) || meta.missingFields.some((field) => typeof field !== 'string' || field.length === 0)) {
      throw new TypeError('Result metadata missingFields must be a list of field names.');
    }
  }
}

// Preserve action data; add only explicitly supported, non-secret metadata.
export function normalizeBackendResult(data, metadata = {}) {
  if (metadata === null || typeof metadata !== 'object') {
    throw new TypeError('Result metadata must be an object.');
  }
  // Validate the allowlisted fields before cloning so a malformed value fails with a field name
  // rather than a generic clone error.
  checkCompletion(metadata);
  const meta = {};
  for (const key of META_KEYS) {
    if (metadata[key] !== undefined) meta[key] = structuredClone(metadata[key]);
  }
  const apiBackend = metadata.backend === 'api';
  const { continuation } = metadata;
  if (continuation !== undefined && continuation !== null) {
    if (apiBackend) {
      // The API path has exact `after` cursors; a UI token there would be a caller bug and could
      // later be forwarded to Reddit as an `after` value.
      throw new OperationError('CURSOR_CONFLICT', 'The API backend uses exact after cursors, not UI continuations.');
    }
    if (data?.after !== undefined && data.after !== null) {
      throw new OperationError('CURSOR_CONFLICT', 'UI continuation and API after cursor cannot be mixed.');
    }
    if (typeof continuation !== 'object' || typeof continuation.token !== 'string' || continuation.token.length === 0) {
      throw invalid('A UI continuation requires an opaque token.');
    }
    meta.cursorKind = 'ui-opaque';
    // Rebuild the object from allowlisted fields: cookies, page state, or debug URLs in the caller's
    // continuation object are never serialized into the public envelope.
    meta.continuation = { token: continuation.token, kind: 'ui-opaque' };
    for (const key of ['issuedAt', 'ttlMs']) {
      const value = continuation[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`Continuation ${key} must be a finite non-negative number.`);
      }
      meta.continuation[key] = value;
    }
  } else {
    meta.cursorKind = apiBackend ? 'exact' : 'none';
  }
  // An API response with no declared completeness is legacy-complete. A UI/replay result that does
  // not say is unknown: visible DOM is not proof that the whole listing was read.
  meta.completeness ??= apiBackend ? 'complete' : 'unknown';
  meta.missingFields ??= meta.completeness === 'complete' ? [] : null;
  return { data, meta };
}
