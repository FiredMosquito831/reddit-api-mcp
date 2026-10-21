// Rendered-UI backend adapter.
//
// The backend is the dispatcher-facing façade for the browser UI: capabilities, a verified-session
// probe, reads, and the prepare/commit pair used by the shared write boundary. The session manager
// (src/browser/session.js) owns the dedicated profile; this module never installs, enrolls, signs in,
// or opens a second browser. Every read/write runs inside a server-generated task
// (src/browser/steps.js) that expires and that the local helper tools can observe.
//
// The write boundary is never created here: the dispatcher owns exactly one guarded boundary per
// logical write. This backend performs no external action during prepareWrite, and commitWrite is
// called once.

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { deriveAccountKey, usernameKey } from '../accounts.js';
import { OperationError } from '../errors.js';
import { BROWSER_READ_TOOLS, createReadAdapters } from '../browser/adapters/reads.js';
import { BROWSER_WRITE_TOOLS, createWriteAdapters } from '../browser/adapters/writes.js';
import { createBrowserTasks, REDDIT_ORIGIN } from '../browser/steps.js';

export const BROWSER_BACKEND_ID = 'browser';

// Reads that page through a listing and can therefore carry a UI continuation token.
const PAGED_READS = new Set([
  'browse_subreddit',
  'get_top_posts',
  'search_reddit',
  'get_user_posts',
  'get_user_comments',
  'get_my_overview',
  'get_my_saved',
]);

const PREPARED_TASKS = new WeakMap();

function loginRequired(profileId, reason) {
  return new OperationError(
    'LOGIN_REQUIRED',
    'This browser profile is not open or has no verified Reddit account. Open the dedicated profile and sign in locally; nothing was opened automatically.',
    { safeDetails: { profileId, reason } },
  );
}

function sessionError(error, profileId) {
  if (error instanceof OperationError) return error;
  if (error?.code === 'PROFILE_NOT_FOUND') return loginRequired(profileId, 'session_not_open');
  return new OperationError('BACKEND_UNAVAILABLE', 'The browser session could not be used.', {
    safeDetails: { profileId, reason: 'session_unavailable' },
  });
}

function filterHashOf(operation) {
  return createHash('sha256').update(JSON.stringify(operation.args ?? {})).digest('hex');
}

export function createBrowserBackend({
  snapshot,
  sessions,
  settings = {},
  clock = () => Date.now(),
  tasks = null,
  continuations = null,
  adapters = null,
  sleep = undefined,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string' || snapshot.id === '') {
    throw new TypeError('createBrowserBackend needs a profile snapshot.');
  }
  if (!sessions || typeof sessions.open !== 'function' || typeof sessions.identity !== 'function') {
    throw new TypeError('createBrowserBackend needs a browser session manager with open() and identity().');
  }
  if (settings !== null && (typeof settings !== 'object' || Array.isArray(settings))) {
    throw new TypeError('Browser backend settings must be an object.');
  }
  if (continuations !== null && (typeof continuations?.issue !== 'function' || typeof continuations?.expireTask !== 'function')) {
    throw new TypeError('continuations must expose issue() and expireTask().');
  }

  const taskManager = tasks ?? createBrowserTasks({ clock });
  const readAdapters = adapters?.reads ?? createReadAdapters();
  const writeAdapters = adapters?.writes ?? createWriteAdapters(sleep === undefined ? {} : { sleep });
  const footer = typeof settings?.botFooter === 'string' ? settings.botFooter : '';

  let live = null;
  // One serialized browser queue per profile/backend instance. Reads, preparation, and the final
  // commit never share a page concurrently, and a write keeps the queue from preparation through
  // commit so another call cannot navigate between its recheck and its click.
  let tail = Promise.resolve();
  const exclusiveToken = {};
  const exclusiveContext = new AsyncLocalStorage();

  function exclusive(fn) {
    // Nested calls (the dispatcher already holds the queue) run inline; only an unrelated call
    // waits. AsyncLocalStorage distinguishes the current operation from a concurrent caller, so a
    // whole-operation wrap cannot deadlock on its own adapter calls.
    if (exclusiveContext.getStore() === exclusiveToken) return fn();
    const start = async () => {
      const end = typeof taskManager.beginOperation === 'function'
        ? taskManager.beginOperation(snapshot.id)
        : () => {};
      try {
        return await exclusiveContext.run(exclusiveToken, fn);
      } finally {
        end();
      }
    };
    const run = tail.then(start, start);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function pageOf(session) {
    const pages = typeof session?.context?.pages === 'function' ? session.context.pages() : [];
    if (Array.isArray(pages) && pages.length > 0) return pages[pages.length - 1];
    if (typeof session?.context?.newPage === 'function') return await session.context.newPage();
    throw new OperationError('BACKEND_UNAVAILABLE', 'The dedicated browser profile has no usable page.', {
      safeDetails: { reason: 'page_unavailable' },
    });
  }

  // Opening an already-enrolled profile is the normal browser-backend path; it is not enrollment,
  // dependency installation, or a password login.
  async function ensureSession() {
    if (live) return live;
    let session;
    try {
      session = await sessions.open(snapshot, {});
    } catch (error) {
      throw sessionError(error, snapshot.id);
    }
    live = { session, page: await pageOf(session) };
    return live;
  }

  async function verifiedIdentity() {
    try {
      return await sessions.identity(snapshot.id);
    } catch (error) {
      throw sessionError(error, snapshot.id);
    }
  }

  async function capabilities() {
    return Object.freeze({
      backend: BROWSER_BACKEND_ID,
      identity: 'user',
      appOnly: false,
      readOnly: false,
      reads: BROWSER_READ_TOOLS,
      writes: BROWSER_WRITE_TOOLS,
      completeness: 'partial',
      visibility: snapshot.visibility ?? settings?.visibility ?? 'visible',
      requires: Object.freeze({ playwright: true, enrolledProfile: true }),
    });
  }

  // Verified identity is a real session check, not profile status. A missing session is a classified
  // login requirement, never an automatic enrollment.
  async function probe() {
    await ensureSession();
    const identity = await verifiedIdentity();
    const username = typeof identity?.username === 'string' && identity.username !== '' ? identity.username : null;
    if (!username) throw loginRequired(snapshot.id, 'identity_unverified');
    return {
      backend: BROWSER_BACKEND_ID,
      identity: 'user',
      verified: identity.verified !== false,
      appOnly: false,
      readOnly: false,
      username,
      accountId: typeof identity.accountId === 'string' ? identity.accountId : null,
      accountKey: typeof identity.accountKey === 'string' && identity.accountKey !== ''
        ? identity.accountKey
        : deriveAccountKey(usernameKey(username)),
    };
  }

  async function readInner(operation, context = {}) {
    if (!operation || operation.kind !== 'read') {
      throw new OperationError('UNSUPPORTED_OPERATION', `The browser backend cannot read a ${operation?.kind ?? 'non-read'} operation.`);
    }
    const { session, page } = await ensureSession();
    const account = await verifiedIdentity();
    if (operation.requiresIdentity && !account?.username) throw loginRequired(snapshot.id, 'identity_unverified');

    const task = taskManager.create({
      profileId: snapshot.id,
      accountKey: typeof account?.accountKey === 'string' ? account.accountKey : snapshot.accountKey ?? null,
      operation,
      policyGeneration: snapshot.policyGeneration,
      credentialGeneration: snapshot.credentialGeneration,
      visibility: session.visibility ?? snapshot.visibility ?? 'visible',
      page,
    });

    let result;
    try {
      result = await readAdapters.read(operation, {
        page,
        account,
        session,
        taskId: task.taskId,
        signal: context?.signal ?? null,
      });
    } catch (error) {
      await closeTask(task.taskId);
      throw error;
    }

    const meta = { ...(result.meta ?? {}) };
    const state = meta.continuationState ?? null;
    delete meta.continuationState;
    if (continuations && state && PAGED_READS.has(operation.tool) && account?.accountKey) {
      try {
        const issuedAt = clock();
        const ttlMs = 300_000;
        const token = continuations.issue({
          profileId: snapshot.id,
          accountKey: account.accountKey,
          backend: BROWSER_BACKEND_ID,
          operation: operation.tool,
          filterHash: filterHashOf(operation),
          credentialGeneration: snapshot.credentialGeneration ?? 1,
          taskId: task.taskId,
          state,
        });
        meta.continuation = { token, issuedAt, ttlMs };
        // The task stays alive so the token's bound page can be paged; expiry/close invalidates it.
        if (typeof continuations.ttlMs === 'number') meta.continuation.ttlMs = continuations.ttlMs;
      } catch {
        // A continuation is an optional convenience: a failed issuance must not turn a completed read
        // into an error. The result simply has no UI cursor.
        await closeTask(task.taskId);
      }
    } else {
      await closeTask(task.taskId);
    }
    return { data: result.data, meta: { ...meta, backend: BROWSER_BACKEND_ID } };
  }

  async function closeTask(taskId) {
    try {
      await taskManager.close(taskId);
    } catch {
      // Task close is maintenance and must not mask the operation result.
    }
  }

  // No external action: navigate, verify, read recognized control state, prepare fields only.
  async function prepareWriteInner(operation, context = {}) {
    if (!operation || operation.kind !== 'write') {
      throw new OperationError('UNSUPPORTED_OPERATION', 'Only a write operation can be prepared here.');
    }
    const { session, page } = await ensureSession();
    const account = await verifiedIdentity();
    const task = taskManager.create({
      profileId: snapshot.id,
      accountKey: typeof account?.accountKey === 'string' ? account.accountKey : snapshot.accountKey ?? null,
      operation,
      policyGeneration: snapshot.policyGeneration,
      credentialGeneration: snapshot.credentialGeneration,
      visibility: session.visibility ?? snapshot.visibility ?? 'visible',
      page,
    });
    try {
      const prepared = await writeAdapters.prepare(operation, {
        page,
        account,
        footer,
        taskId: task.taskId,
        signal: context?.signal ?? null,
      });
      PREPARED_TASKS.set(prepared, task.taskId);
      return prepared;
    } catch (error) {
      await closeTask(task.taskId);
      throw error;
    }
  }

  // Called exactly once by the shared boundary after its durable dispatch mark.
  async function commitWriteInner(prepared, context = {}) {
    const taskId = PREPARED_TASKS.get(prepared);
    if (!taskId) throw new TypeError('commitWrite needs a prepared operation from this browser backend.');
    try {
      return await writeAdapters.commit(prepared, {
        page: live?.page ?? null,
        footer,
        taskId,
        signal: context?.signal ?? null,
        verifyIdentity: () => verifiedIdentity(),
      });
    } finally {
      await closeTask(taskId);
      PREPARED_TASKS.delete(prepared);
    }
  }

  function read(operation, context = {}) {
    return exclusive(() => readInner(operation, context));
  }

  function prepareWrite(operation, context = {}) {
    return exclusive(() => prepareWriteInner(operation, context));
  }

  function commitWrite(prepared, context = {}) {
    return exclusive(() => commitWriteInner(prepared, context));
  }

  function close() {
    return exclusive(async () => {
      taskManager.closeAll();
      live = null;
    });
  }

  return Object.freeze({
    id: BROWSER_BACKEND_ID,
    origin: REDDIT_ORIGIN,
    capabilities,
    probe,
    read,
    prepareWrite,
    commitWrite,
    exclusive,
    close,
  });
}
