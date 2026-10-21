// Public error and outcome contract for the operation dispatcher. Backends never throw raw SDK, DOM,
// or HTTP objects at callers: they throw an OperationError with a canonical code and an optional outcome.
// `safeDetails` must contain only data that is safe to show to the caller (no secrets or session state).

export const OUTCOMES = Object.freeze({
  PREPARED: 'PREPARED',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  DISPATCHED: 'DISPATCHED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED_KNOWN: 'FAILED_KNOWN',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
});

export const OPERATION_ERROR_CODES = Object.freeze([
  'PROFILE_REQUIRED',
  'PROFILE_NOT_FOUND',
  'PROFILE_IN_USE',
  'IDENTITY_MISMATCH',
  'IDENTITY_UNVERIFIED',
  'BACKEND_UNAVAILABLE',
  'UNSUPPORTED_OPERATION',
  'PARAMETER_UNSUPPORTED',
  'APP_ONLY_READ_ONLY',
  'APPROVAL_REQUIRED',
  'POLICY_CHANGED',
  'LOGIN_REQUIRED',
  'USER_HANDOFF_REQUIRED',
  'THROTTLED',
  'CONTINUATION_INVALID',
  'CONTINUATION_EXPIRED',
  'CURSOR_CONFLICT',
  'STEP_STALE',
  'BROWSER_DEPENDENCY_MISSING',
  'BROWSER_BINARY_MISSING',
  'OUTCOME_UNKNOWN',
]);

const CODE_SET = new Set(OPERATION_ERROR_CODES);
const OUTCOME_SET = new Set(Object.values(OUTCOMES));

export function isOperationErrorCode(code) {
  return typeof code === 'string' && CODE_SET.has(code);
}

export function isOutcome(value) {
  return typeof value === 'string' && OUTCOME_SET.has(value);
}

// `outcome` is null when the failure happened before an operation outcome was meaningful (for example
// invalid input). Callers that know how far the operation got must set it.
export class OperationError extends Error {
  constructor(code, message, { outcome = null, retryAfterMs = null, safeDetails = null } = {}) {
    if (!isOperationErrorCode(code)) throw new TypeError(`Unknown operation error code: ${code}`);
    if (outcome !== null && !isOutcome(outcome)) throw new TypeError(`Unknown operation outcome: ${outcome}`);
    super(String(message));
    this.name = 'OperationError';
    this.code = code;
    this.outcome = outcome;
    this.retryAfterMs = retryAfterMs;
    this.safeDetails = safeDetails;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      outcome: this.outcome,
      retryAfterMs: this.retryAfterMs,
      safeDetails: this.safeDetails,
    };
  }
}
