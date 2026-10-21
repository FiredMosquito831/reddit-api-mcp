// Experimental replay backend.
//
// This adapter composes the finite request mappings (src/replay/mappings.js) with the scoped session
// transport (src/replay/transport.js). It never opens a browser itself, installs anything, or retries
// a mutation. Reads preserve the existing action result shapes; responses are normalized explicitly
// rather than passed through.
//
// The dispatcher supplies `{snapshot, sessions, secretStore, settings, cacheGeneration, clock, fetch}`
// to the production factory; the plan-level shape `{transport, mappings, boundary}` is also accepted,
// which keeps the adapter testable without a live browser.

import { OperationError } from '../errors.js';
import { OPERATION_DESCRIPTORS } from '../operations.js';
import {
  REPLAY_MAPPINGS,
  UNSUPPORTED_REPLAY_OPERATIONS,
  normalizeReplayRead,
  replayCapabilities,
  verifyReplayWrite,
} from '../replay/mappings.js';
import { createReplayTransport } from '../replay/transport.js';

export const REPLAY_BACKEND_ID = 'replay';

const PLANS = new WeakMap();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unsupported(tool, reason, message = `The replay backend does not implement ${tool}.`) {
  return new OperationError('UNSUPPORTED_OPERATION', message, {
    safeDetails: { backend: REPLAY_BACKEND_ID, reason, tool },
  });
}

function descriptorFor(operation, kind) {
  if (!isObject(operation)) throw new TypeError('An operation descriptor is required.');
  if (operation.kind !== kind) {
    throw new OperationError('UNSUPPORTED_OPERATION', `The replay backend cannot ${kind === 'write' ? 'mutate' : 'read'} a ${operation.kind ?? 'non-' + kind} operation.`);
  }
  const descriptor = Object.hasOwn(OPERATION_DESCRIPTORS, operation.tool)
    ? OPERATION_DESCRIPTORS[operation.tool]
    : null;
  if (!descriptor || descriptor.kind !== kind) throw unsupported(operation.tool, 'operation_descriptor_missing');
  return descriptor;
}

function mappingFor(tool) {
  if (Object.hasOwn(UNSUPPORTED_REPLAY_OPERATIONS, tool)) {
    return { unsupported: UNSUPPORTED_REPLAY_OPERATIONS[tool] };
  }
  if (!Object.hasOwn(REPLAY_MAPPINGS, tool)) return { unsupported: null };
  return { mapping: REPLAY_MAPPINGS[tool] };
}

function meta(extra = {}) {
  return Object.freeze({
    backend: REPLAY_BACKEND_ID,
    completeness: 'unknown',
    // Completion metadata requires a list whenever the key is present; replay proves no field of a
    // result is complete, so it reports an empty list rather than null.
    missingFields: [],
    ...extra,
  });
}

export function createReplayBackend({
  transport = null,
  mappings = REPLAY_MAPPINGS,
  boundary = null,
  snapshot = null,
  sessions = null,
  secretStore = null,
  settings = {},
  cacheGeneration = null,
  clock = () => Date.now(),
  fetch = globalThis.fetch,
  requestFactory = null,
  allowedDestinations = undefined,
  timeoutMs = undefined,
} = {}) {
  if (mappings !== REPLAY_MAPPINGS) {
    throw new TypeError('createReplayBackend accepts only the checked-in finite mappings.');
  }
  if (boundary !== null && (typeof boundary !== 'object' || typeof boundary.run !== 'function')) {
    throw new TypeError('createReplayBackend boundary must expose run().');
  }
  let adapter = transport;
  if (!adapter) {
    if (!sessions && typeof requestFactory !== 'function') {
      throw new TypeError('createReplayBackend needs a transport, a browser session manager, or a request factory.');
    }
    adapter = createReplayTransport({
      sessionManager: sessions,
      secretStore,
      requestFactory,
      settings,
      clock,
      ...(allowedDestinations !== undefined ? { allowedDestinations } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  if (!adapter || typeof adapter.request !== 'function') {
    throw new TypeError('The replay transport must expose request().');
  }
  const footer = typeof settings?.botFooter === 'string' ? settings.botFooter : '';

  function profileOf(context) {
    return context?.profile ?? snapshot;
  }

  async function verifyIdentity(context, options = {}) {
    if (typeof adapter.probe === 'function') return await adapter.probe(context, options);
    // A caller-injected transport without probe() is not allowed to authorize a write.
    throw new OperationError('IDENTITY_UNVERIFIED', 'The replay transport cannot verify a Reddit account for this operation; nothing was sent.', {
      safeDetails: { backend: REPLAY_BACKEND_ID, reason: 'identity_probe_missing' },
    });
  }

  async function capabilities() {
    return replayCapabilities();
  }

  async function probe(context = {}) {
    // The dispatcher reconciles this identity before a write reserves its durable admission, so it
    // must be the live session, not a value cached from an earlier account.
    const identity = await verifyIdentity(context, { fresh: true });
    return {
      backend: REPLAY_BACKEND_ID,
      identity: 'user',
      verified: identity.verified !== false,
      appOnly: false,
      readOnly: false,
      username: identity.username ?? null,
      accountId: identity.accountId ?? null,
      accountKey: identity.accountKey ?? null,
    };
  }

  async function send(tool, args, context, options = {}) {
    const mapping = REPLAY_MAPPINGS[tool];
    if (!mapping) throw unsupported(tool, 'mapping_missing');
    return await adapter.request(mapping, args, context, options);
  }

  async function readComposite(tool, operation, context) {
    if (tool === 'user_analysis') {
      const username = operation.args.username;
      const [accountPayload, postsPayload, commentsPayload] = [
        await send('get_user_info', { username }, context),
        await send('get_user_posts', { username, options: { limit: 100 } }, context),
        await send('get_user_comments', { username, options: { limit: 100 } }, context),
      ];
      const data = REPLAY_MAPPINGS.user_analysis.normalize({
        account: normalizeReplayRead('get_user_info', accountPayload.json),
        posts: normalizeReplayRead('get_user_posts', postsPayload.json),
        comments: normalizeReplayRead('get_user_comments', commentsPayload.json),
      });
      return { data, meta: meta() };
    }

    if (tool === 'test_reddit_mcp_server') {
      const started = clock();
      const checkAccount = operation.args?.checkAccount !== false;
      let popular;
      try {
        const response = await send('get_trending_subreddits', { limit: 1 }, context);
        popular = { ok: true, data: normalizeReplayRead('get_trending_subreddits', response.json) };
      } catch (error) {
        popular = { ok: false, error: error?.code ?? 'BACKEND_UNAVAILABLE' };
      }
      let me = { ok: false, error: 'IDENTITY_UNVERIFIED' };
      if (checkAccount) {
        try {
          const identity = await verifyIdentity(context);
          me = { ok: true, data: { name: identity.username } };
        } catch (error) {
          me = { ok: false, error: error?.code ?? 'IDENTITY_UNVERIFIED' };
        }
      }
      const data = REPLAY_MAPPINGS.test_reddit_mcp_server.normalize({
        popular,
        me,
        checkAccount,
        elapsedMs: Math.max(0, clock() - started),
      });
      return { data, meta: meta() };
    }
    return null;
  }

  async function read(operation, context = {}) {
    descriptorFor(operation, 'read');
    const found = mappingFor(operation.tool);
    if (found.unsupported) throw unsupported(operation.tool, found.unsupported.reason);
    if (!found.mapping) throw unsupported(operation.tool, 'mapping_missing');

    const composite = await readComposite(operation.tool, operation, context);
    if (composite) return composite;

    const options = {};
    // Own-account listings need the verified session username; it is read from the session, never
    // from caller input.
    if (found.mapping.steps === undefined && (operation.tool === 'get_my_overview'
      || operation.tool === 'get_my_saved')) {
      const identity = await verifyIdentity(context);
      if (typeof identity.username !== 'string' || identity.username.length === 0) {
        throw unsupported(operation.tool, 'username_required');
      }
      options.username = identity.username;
    }

    const response = await send(operation.tool, operation.args ?? {}, context, options);
    const data = found.mapping.normalize(response.json, operation.args ?? {}, options);

    if (operation.tool === 'browse_subreddit' && operation.args?.includeInfo === true) {
      const infoResponse = await send('get_subreddit_info', { subreddit: operation.args.subreddit }, context, options);
      data.info = normalizeReplayRead('get_subreddit_info', infoResponse.json);
    }

    return { data, meta: meta() };
  }

  async function prepareWrite(operation, context = {}) {
    const descriptor = descriptorFor(operation, 'write');
    if (descriptor.requiresIdentity === false) {
      throw new OperationError('UNSUPPORTED_OPERATION', 'A replay write must require a verified identity.');
    }
    const found = mappingFor(operation.tool);
    if (found.unsupported) throw unsupported(operation.tool, found.unsupported.reason);
    if (!found.mapping || found.mapping.kind !== 'write') throw unsupported(operation.tool, 'write_mapping_missing');

    // Building the request performs no network work, so the shared boundary can record its durable
    // admission before commitWrite sends exactly one request.
    const built = found.mapping.build(operation.args ?? {}, { footer });
    const prepared = Object.freeze({
      backend: REPLAY_BACKEND_ID,
      tool: operation.tool,
      policyKey: descriptor.policyKey,
      method: built.method,
      path: built.path,
      form: built.form,
    });
    PLANS.set(prepared, { mapping: found.mapping, built, tool: operation.tool });
    return prepared;
  }

  async function commitWrite(prepared, context = {}) {
    const plan = PLANS.get(prepared);
    if (!plan) throw new TypeError('commitWrite needs a prepared plan from this replay backend.');
    // One transport request per commit. The transport itself never follows a mutation redirect, and
    // the backend never retries.
    const singleMapping = Object.freeze({ ...plan.mapping, build: () => plan.built });
    const response = await adapter.request(singleMapping, {}, context);
    return verifyReplayWrite(plan.tool, response.json);
  }

  async function write(operation, context = {}) {
    if (!boundary) {
      throw new TypeError('This replay backend has no write boundary; use prepareWrite and commitWrite through the dispatcher.');
    }
    return boundary.run({
      operation,
      context,
      prepare: ({ operation: frozen }) => prepareWrite(frozen, context),
      commit: (prepared) => commitWrite(prepared, context),
    });
  }

  async function close() {
    if (typeof adapter.close === 'function') await adapter.close();
  }

  return Object.freeze({
    id: REPLAY_BACKEND_ID,
    capabilities,
    probe,
    read,
    prepareWrite,
    commitWrite,
    write,
    close,
  });
}
