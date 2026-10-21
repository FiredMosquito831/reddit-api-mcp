// Official-API backend adapter.
//
// Reads call the existing action methods unchanged, so their validation, shaping, and exact `after`
// cursors stay identical to the CLI's direct path. Writes are split into a network-free
// `prepareWrite` and a single sending `commitWrite`, and are invoked only inside the shared write
// boundary (src/write-boundary.js). This module never guards a write itself: the boundary owns the
// one reservation, one approval, and one dispatch per logical write.
//
// Mutations are sent exactly once by src/client.js. A definite rejection is FAILED_KNOWN; a lost,
// timed-out, 5xx, or unparseable completion is OUTCOME_UNKNOWN and is never resent here or elsewhere.

import { deriveAccountKey, usernameKey } from '../accounts.js';
import { planMutation, planRawMutation, createActions } from '../actions.js';
import { OperationError } from '../errors.js';
import { OPERATION_DESCRIPTORS } from '../operations.js';

export const API_BACKEND_ID = 'api';

// How each read descriptor's normalized arguments reach its action method. The action signatures are
// documented in src/operations.js; this is the one place that knows the positional ones.
const READ_INVOCATIONS = Object.freeze({
  whoami: (actions) => () => actions.whoami(),
  feed: (actions) => (args) => actions.feed(args),
  topPosts: (actions) => (args) => actions.topPosts(args),
  subreddit: (actions) => (args) => actions.subreddit(args.subreddit),
  rules: (actions) => (args) => actions.rules(args.subreddit),
  flairs: (actions) => (args) => actions.flairs(args.subreddit),
  popular: (actions) => (args) => actions.popular(args),
  search: (actions) => (args) => actions.search(args),
  readPost: (actions) => (args) => actions.readPost(args),
  moreComments: (actions) => (args) => actions.moreComments(args),
  userInfo: (actions) => (args) => actions.userInfo(args.username),
  userPosts: (actions) => (args) => actions.userPosts(args.username, args.options),
  userComments: (actions) => (args) => actions.userComments(args.username, args.options),
  userActivity: (actions) => (args) => actions.userActivity(args.username),
  overview: (actions) => (args) => actions.overview(args),
  saved: (actions) => (args) => actions.saved(args),
  mySubscriptions: (actions) => (args) => actions.mySubscriptions(args),
  selfTest: (actions) => (args) => actions.selfTest(args),
});

const SUPPORTED_READS = Object.freeze(
  Object.values(OPERATION_DESCRIPTORS)
    .filter((descriptor) => descriptor.kind === 'read')
    .map((descriptor) => descriptor.tool),
);

const API_WRITE_TOOLS = Object.freeze(
  Object.values(OPERATION_DESCRIPTORS)
    .filter((descriptor) => descriptor.kind === 'write')
    .map((descriptor) => descriptor.tool),
);

// Prepared write plans stay opaque to callers: the completion verifier is kept here, not copied into
// a result object a caller could inspect or reuse.
const PLANS = new WeakMap();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function appOnlyOf(config) {
  return config?.appOnly === true || config?.readOnly === true || config?.authMode === 'app';
}

function writeOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('An operation descriptor is required.');
  }
  if (operation.kind !== 'write') {
    throw new OperationError('UNSUPPORTED_OPERATION', `The API backend cannot mutate a ${operation.kind ?? 'non-write'} operation.`);
  }
  if (operation.requiresIdentity === false) {
    throw new OperationError('UNSUPPORTED_OPERATION', 'A write operation must require a verified identity.');
  }
  return operation;
}

export function createApiBackend({ snapshot, config, client, boundary = null } = {}) {
  if (!client || typeof client.request !== 'function') {
    throw new TypeError('createApiBackend needs a Reddit client.');
  }
  if (!config || typeof config !== 'object') throw new TypeError('createApiBackend needs a profile API config.');
  if (snapshot !== null && snapshot !== undefined && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
    throw new TypeError('createApiBackend needs a profile snapshot or nothing.');
  }
  if (boundary !== null && (typeof boundary !== 'object' || typeof boundary.run !== 'function')) {
    throw new TypeError('createApiBackend boundary must expose run().');
  }

  const appOnly = appOnlyOf(config);
  const footer = typeof config.botFooter === 'string' ? config.botFooter : '';
  const actions = createActions({ client, footer, authMode: config.authMode ?? 'oauth' });
  const invokers = Object.fromEntries(
    Object.entries(READ_INVOCATIONS).map(([action, build]) => [action, build(actions)]),
  );

  function refuseIdentity() {
    throw new OperationError(
      'APP_ONLY_READ_ONLY',
      'This is an app-only API session: it has no user account and cannot read account-specific data or write.',
    );
  }

  async function capabilities() {
    return Object.freeze({
      backend: API_BACKEND_ID,
      identity: appOnly ? 'app-only' : 'user',
      appOnly,
      readOnly: appOnly,
      reads: appOnly
        ? Object.freeze(SUPPORTED_READS.filter((tool) => !OPERATION_DESCRIPTORS[tool].requiresIdentity))
        : SUPPORTED_READS,
      writes: appOnly ? Object.freeze([]) : API_WRITE_TOOLS,
      completeness: 'complete',
    });
  }

  // Verified identity is established by a real read, never by profile status alone. For an app-only
  // session there is no user identity to verify, and /api/v1/me must not be attempted.
  async function probe() {
    if (appOnly) {
      return {
        backend: API_BACKEND_ID,
        identity: 'app-only',
        verified: false,
        appOnly: true,
        readOnly: true,
        username: null,
        accountKey: null,
      };
    }
    const me = await actions.whoami();
    const expected = snapshot?.expectedUsername ?? config.username ?? null;
    if (expected) {
      if (usernameKey(expected) !== usernameKey(me.name)) {
        throw new OperationError('IDENTITY_MISMATCH', 'The authorized Reddit account does not match this profile.', {
          safeDetails: { expected, actual: me.name },
        });
      }
    }
    const accountKey = deriveAccountKey(usernameKey(me.name));
    if (snapshot?.accountKey && snapshot.accountKey !== accountKey) {
      throw new OperationError('IDENTITY_MISMATCH', 'The authorized Reddit account is bound to a different profile account.', {
        safeDetails: { username: me.name },
      });
    }
    return {
      backend: API_BACKEND_ID,
      identity: 'user',
      verified: true,
      appOnly: false,
      readOnly: false,
      username: me.name,
      accountKey,
    };
  }

  async function read(operation) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new TypeError('An operation descriptor is required.');
    }
    if (operation.kind !== 'read') {
      throw new OperationError('UNSUPPORTED_OPERATION', `The API backend cannot read a ${operation.kind ?? 'non-read'} operation.`);
    }
    // The action, identity requirement, and policy key come from the tool's own descriptor, never from
    // caller-supplied metadata on the operation object.
    const descriptor = Object.hasOwn(OPERATION_DESCRIPTORS, operation.tool)
      ? OPERATION_DESCRIPTORS[operation.tool]
      : null;
    if (!descriptor || descriptor.kind !== 'read') {
      throw new OperationError('UNSUPPORTED_OPERATION', `The API backend has no read mapping for ${operation.tool}.`);
    }
    const invoke = invokers[descriptor.action];
    if (!invoke) {
      throw new OperationError('UNSUPPORTED_OPERATION', `The API backend has no read mapping for ${operation.tool}.`);
    }
    if (appOnly && descriptor.requiresIdentity) refuseIdentity();
    // An app-only session has no account to check, so selfTest is never allowed to ask for whoami.
    const args = appOnly && descriptor.tool === 'test_reddit_mcp_server'
      ? Object.freeze({ ...(operation.args ?? {}), checkAccount: false })
      : operation.args;
    return invoke(args);
  }

  // No external action happens here. The plan is built from already-validated arguments, and the
  // shared boundary records its durable mark before calling commitWrite.
  async function prepareWrite(operation) {
    const op = writeOperation(operation);
    if (appOnly) refuseIdentity();

    const raw = op.tool === 'raw_post' || op.policyKey === 'raw_post';
    // A shipped tool's action and policy key come from its descriptor, so a caller cannot pair one
    // tool's name with another action or borrow a different tool's approval entry.
    const descriptor = raw
      ? null
      : (Object.hasOwn(OPERATION_DESCRIPTORS, op.tool) ? OPERATION_DESCRIPTORS[op.tool] : null);
    if (!raw && (!descriptor || descriptor.kind !== 'write')) {
      throw new OperationError('UNSUPPORTED_OPERATION', `The API backend has no write mapping for ${op.tool}.`);
    }
    if (raw && String(op.args?.method ?? 'POST').toUpperCase() !== 'POST') {
      throw new OperationError('UNSUPPORTED_OPERATION', 'The API backend only commits raw POST operations.');
    }
    const plan = raw
      ? planRawMutation(op.args ?? {})
      : planMutation(descriptor.action, op.args ?? {}, { footer });

    const prepared = Object.freeze({
      backend: API_BACKEND_ID,
      tool: op.tool,
      policyKey: descriptor ? descriptor.policyKey : 'raw_post',
      method: plan.method,
      path: plan.path,
      form: plan.form,
    });
    PLANS.set(prepared, { complete: plan.complete, tool: op.tool });
    return prepared;
  }

  async function commitWrite(prepared) {
    const plan = PLANS.get(prepared);
    if (!plan) throw new TypeError('commitWrite needs a prepared plan from this API backend.');
    const response = await client.request(prepared.method, prepared.path, { form: prepared.form });
    return plan.complete(response);
  }

  // Convenience for a dispatcher that already owns the boundary. Exactly one boundary.run per call.
  async function write(operation, context = {}) {
    if (!boundary) {
      throw new TypeError('This API backend has no write boundary; use prepareWrite and commitWrite through the dispatcher.');
    }
    return boundary.run({
      operation,
      context,
      prepare: ({ operation: frozen }) => prepareWrite(frozen),
      commit: (prepared) => commitWrite(prepared),
    });
  }

  async function close() {
    // No owned resources: the HTTP client holds only in-memory tokens and cache entries.
  }

  return Object.freeze({
    id: API_BACKEND_ID,
    capabilities,
    probe,
    read,
    prepareWrite,
    commitWrite,
    write,
    close,
  });
}

export { API_WRITE_TOOLS, SUPPORTED_READS };
