// Versioned, authoritative named-profile registry and account identity bindings.
// One file, <home>/profiles.json, owns the single default profile and every non-secret profile and
// account record. Mutations run under one short-lived cross-process lease so the default update is
// atomic and no profile metadata is duplicated into a second store. Secrets never enter this file:
// `api` holds public client/app metadata only, and secret references are derived by the secret lane.
//
// Plain JS on purpose. Public shapes are frozen snapshots so a caller that resolved a profile cannot
// observe a later registry change (a changed default never mutates an existing snapshot).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationError } from './errors.js';
import { withLease } from './locks.js';
import { WRITE_TOOL_NAMES } from './operations.js';
import { writeAtomic } from './secure-fs.js';

export const REGISTRY_FILE = 'profiles.json';
export const REGISTRY_VERSION = 1;
export const REGISTRY_LOCK = 'locks/profiles-registry';
export const LEGACY_PROFILE_ID = 'legacy';

const ALIAS_MAX = 48;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Reddit account ids are base36, so case is not significant; accept either case and normalize.
const ACCOUNT_ID_PATTERN = /^t2_[A-Za-z0-9]+$/;
const BACKENDS = new Set(['api', 'replay', 'browser']);
const VISIBILITIES = new Set(['visible', 'headless', 'ask']);
const APP_TYPES = new Set(['script', 'web', 'installed']);
const PATCH_KEYS = new Set([
  'alias',
  'enabledBackends',
  'backendPreference',
  'visibility',
  'confirmations',
  'api',
  'passwordLoginEnabled',
  'credentialRotation',
]);

const defaultFs = { readFile, mkdir, rename, unlink, writeFile };

// In-process mutation queue per registry path. The cross-process lease is authoritative, but its
// mkdir/metadata window is not observable atomically from two fibers of one process, so mutations
// from this process are serialized before they contend for the lease. Keyed by resolved lock path
// and shared by every registry instance in the process.
const localQueues = new Map();

function serialize(lockPath, task) {
  const prior = localQueues.get(lockPath) || Promise.resolve();
  const run = prior.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  localQueues.set(lockPath, settled);
  settled.then(() => {
    if (localQueues.get(lockPath) === settled) localQueues.delete(lockPath);
  });
  return run;
}

export const LEGACY_PROFILE = deepFreeze({
  kind: 'legacy',
  id: LEGACY_PROFILE_ID,
  alias: 'legacy-environment',
  isLegacy: true,
  isDefault: false,
  expectedUsername: null,
  accountKey: null,
  accountId: null,
  username: null,
  generation: 1,
  credentialGeneration: 1,
  policyGeneration: 1,
  enabledBackends: ['api'],
  backendPreference: ['api'],
  visibility: 'visible',
  confirmations: {},
  api: { clientId: null, appType: null },
  passwordLoginEnabled: false,
  createdAt: null,
  updatedAt: null,
});

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function invalid(message) {
  return codedError('INVALID_ARGUMENT', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Clone then freeze: a returned record is an independent immutable snapshot, never a live reference.
function freezeClone(value) {
  return deepFreeze(structuredClone(value));
}

function emptyState() {
  return {
    version: REGISTRY_VERSION,
    defaultProfileId: null,
    profiles: {},
    accounts: {},
    updatedAt: null,
  };
}

export function isLegacyProfile(value) {
  return Boolean(value && value.kind === 'legacy' && value.id === LEGACY_PROFILE_ID);
}

// --- aliases -----------------------------------------------------------------------------------

export function normalizeAlias(raw) {
  if (typeof raw !== 'string') throw invalid('A profile alias must be a string.');
  const alias = raw.trim();
  if (alias !== raw) throw invalid('A profile alias may not start or end with whitespace.');
  if (alias.length === 0) throw invalid('A profile alias may not be empty.');
  if (alias.length > ALIAS_MAX) throw invalid(`A profile alias may be at most ${ALIAS_MAX} characters.`);
  if (alias === '.' || alias === '..') throw invalid('A profile alias may not be a dot entry.');
  if (alias.includes('/') || alias.includes('\\')) throw invalid('A profile alias may not contain path separators.');
  if (alias.includes('..')) throw invalid('A profile alias may not contain traversal sequences.');
  if (/[\u0000-\u001f\u007f]/.test(alias)) throw invalid('A profile alias may not contain control characters.');
  if (/[<>:"|?*]/.test(alias)) throw invalid('A profile alias may not contain Windows-reserved characters.');
  if (alias.endsWith('.')) throw invalid('A profile alias may not end with a dot.');
  if (WINDOWS_DEVICE.test(alias)) throw invalid('A profile alias may not be a Windows device name.');
  if (alias.toLowerCase() === LEGACY_PROFILE_ID) throw invalid('The alias "legacy" is reserved.');
  return alias;
}

export function aliasKey(alias) {
  return normalizeAlias(alias).toLowerCase();
}

// --- usernames and account keys ----------------------------------------------------------------

// Display form: trimmed, one optional leading u/ removed, original case preserved.
export function normalizeUsername(raw) {
  if (typeof raw !== 'string') throw invalid('A username must be a string.');
  let username = raw.trim();
  if (username.toLowerCase().startsWith('u/')) username = username.slice(2).trim();
  if (!username) throw invalid('A username may not be empty.');
  if (!USERNAME_PATTERN.test(username)) throw invalid('A username must contain only letters, digits, _ and -.');
  return { username, key: username.toLowerCase().normalize('NFKC') };
}

export function usernameKey(raw) {
  return normalizeUsername(raw).key;
}

export function deriveAccountKey(key) {
  if (typeof key !== 'string' || !key) throw invalid('An account key needs a non-empty username key.');
  return `acct_${createHash('sha256').update(`reddit-account:user:${key}`).digest('hex').slice(0, 32)}`;
}

export function validateAccountId(raw) {
  if (typeof raw !== 'string' || !ACCOUNT_ID_PATTERN.test(raw)) {
    throw invalid('A Reddit account id must look like t2_<base36>.');
  }
  return raw.toLowerCase();
}

// --- record validation ------------------------------------------------------------------------

function validateBackends(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${field} must be a non-empty array of backend ids.`);
  }
  const seen = new Set();
  for (const backend of value) {
    if (!BACKENDS.has(backend)) throw invalid(`${field} contains an unknown backend: ${String(backend)}.`);
    if (seen.has(backend)) throw invalid(`${field} may not repeat a backend.`);
    seen.add(backend);
  }
  return [...value];
}

// A confirmation map may only name a real write tool (plus `global`). Accepting an arbitrary key would
// store a confirmation the dispatcher never reads, so a typo would silently leave the action unguarded.
const CONFIRMATION_KEYS = new Set([...WRITE_TOOL_NAMES, 'global']);

function validateConfirmations(value) {
  if (!isPlainObject(value)) throw invalid('confirmations must be an object of tool-name booleans.');
  const result = {};
  for (const [tool, enabled] of Object.entries(value)) {
    if (!CONFIRMATION_KEYS.has(tool)) throw invalid(`Unknown confirmation key: ${tool}.`);
    if (typeof enabled !== 'boolean') throw invalid(`confirmation ${tool} must be a boolean.`);
    result[tool] = enabled;
  }
  return result;
}

function validateApiMetadata(value, base) {
  if (!isPlainObject(value)) throw invalid('api must be an object of public client metadata.');
  const next = { ...base };
  for (const [key, entry] of Object.entries(value)) {
    if (!['clientId', 'appType'].includes(key)) {
      throw invalid(`api only accepts public clientId/appType metadata (rejected ${key}); secrets never enter the registry.`);
    }
    if (key === 'clientId') {
      if (entry !== null && (typeof entry !== 'string' || entry.length === 0 || entry.length > 128)) {
        throw invalid('api.clientId must be a short non-empty string or null.');
      }
      next.clientId = entry;
    } else {
      if (entry !== null && !APP_TYPES.has(entry)) throw invalid('api.appType must be script, web, installed, or null.');
      next.appType = entry;
    }
  }
  return next;
}

function approvalAccepted(approval) {
  return Boolean(isPlainObject(approval) && approval.approved === true);
}

// --- public record / snapshot ----------------------------------------------------------------

function publicProfile(state, profile) {
  return {
    kind: 'profile',
    id: profile.id,
    alias: profile.alias,
    expectedUsername: profile.expectedUsername,
    accountKey: profile.accountKey,
    accountId: profile.accountId,
    username: profile.username,
    generation: profile.generation,
    credentialGeneration: profile.credentialGeneration,
    policyGeneration: profile.policyGeneration,
    enabledBackends: profile.enabledBackends,
    backendPreference: profile.backendPreference,
    visibility: profile.visibility,
    confirmations: profile.confirmations,
    api: profile.api,
    passwordLoginEnabled: profile.passwordLoginEnabled,
    isDefault: state.defaultProfileId === profile.id,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// --- registry ---------------------------------------------------------------------------------

export function createProfileRegistry({
  homeDir,
  fs = defaultFs,
  clock = () => Date.now(),
  newId = randomUUID,
  leases = { withLease },
  lockTimeoutMs = 10_000,
} = {}) {
  if (typeof homeDir !== 'string' || !homeDir) throw new TypeError('createProfileRegistry needs a homeDir.');
  if (typeof newId !== 'function') throw new TypeError('newId must be a function.');

  const registryPath = join(homeDir, REGISTRY_FILE);
  const lockPath = join(homeDir, REGISTRY_LOCK);

  function assertProfile(profile, id) {
    if (!isPlainObject(profile) || profile.id !== id || typeof profile.aliasKey !== 'string') {
      throw codedError('REGISTRY_CORRUPT', `The profile record ${id} in ${registryPath} is malformed.`);
    }
  }

  function assertAccount(account, key) {
    const valid = isPlainObject(account)
      && account.accountKey === key
      && typeof account.username === 'string'
      && (account.accountId === null || typeof account.accountId === 'string');
    if (!valid) {
      throw codedError('REGISTRY_CORRUPT', `The account record ${key} in ${registryPath} is malformed.`);
    }
  }

  async function readState() {
    let text;
    try {
      text = await fs.readFile(registryPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    let state;
    try {
      state = JSON.parse(text);
    } catch {
      throw codedError('REGISTRY_CORRUPT', `The profile registry ${registryPath} is not valid JSON.`);
    }
    if (!state || state.version !== REGISTRY_VERSION || !isPlainObject(state.profiles) || !isPlainObject(state.accounts)) {
      throw codedError(
        'REGISTRY_CORRUPT',
        `The profile registry ${registryPath} has an unsupported or incomplete layout (expected version ${REGISTRY_VERSION}).`,
      );
    }
    for (const [id, profile] of Object.entries(state.profiles)) assertProfile(profile, id);
    for (const [key, account] of Object.entries(state.accounts)) assertAccount(account, key);
    if (state.defaultProfileId !== null && typeof state.defaultProfileId !== 'string') {
      throw codedError('REGISTRY_CORRUPT', `The profile registry ${registryPath} has an invalid defaultProfileId.`);
    }
    // A dangling default is treated as no default for reads; it is never silently repointed.
    if (state.defaultProfileId && !Object.hasOwn(state.profiles, state.defaultProfileId)) {
      state.defaultProfileId = null;
    }
    return state;
  }

  async function writeState(state) {
    await fs.mkdir(homeDir, { recursive: true });
    await writeAtomic(registryPath, `${JSON.stringify(state, null, 2)}\n`, { fs });
  }

  async function mutate(operation) {
    return serialize(lockPath, () => leases.withLease(
      lockPath,
      { kind: 'profiles-registry', owner: `reddit-cli profiles pid ${process.pid}`, timeoutMs: lockTimeoutMs },
      async () => {
        const state = await readState();
        const result = await operation(state);
        state.version = REGISTRY_VERSION;
        state.updatedAt = clock();
        await writeState(state);
        return result;
      },
    ));
  }

  function findIndex(state, selector) {
    if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
      // Own-property checks only: prototype-chain names (__proto__, constructor, toString) must never
      // resolve to a fabricated profile record.
      if (typeof selector.id === 'string') {
        return Object.hasOwn(state.profiles, selector.id) ? selector.id : null;
      }
      if (typeof selector.alias === 'string') selector = selector.alias;
      else throw invalid('A profile selector must be an id, an alias, or { id } / { alias }.');
    }
    if (selector === undefined || selector === null) return null;
    if (typeof selector !== 'string' || selector.length === 0) {
      throw invalid('A profile selector must be a non-empty string.');
    }
    if (Object.hasOwn(state.profiles, selector)) return selector;
    const wanted = selector.toLowerCase();
    for (const profile of Object.values(state.profiles)) {
      if (profile.aliasKey === wanted) return profile.id;
    }
    return null;
  }

  function requireProfile(state, selector) {
    const id = findIndex(state, selector);
    if (!id) throw profileNotFound(state, selector);
    return state.profiles[id];
  }

  function profileNotFound(state, selector) {
    return new OperationError('PROFILE_NOT_FOUND', `No profile matches ${JSON.stringify(selector)}.`, {
      safeDetails: { aliases: Object.values(state.profiles).map((profile) => profile.alias) },
    });
  }

  function profileRequired(state) {
    return new OperationError(
      'PROFILE_REQUIRED',
      'No profile was selected and no default profile is set. Name a profile explicitly or set a default.',
      { safeDetails: { aliases: Object.values(state.profiles).map((profile) => profile.alias) } },
    );
  }

  function uniqueAlias(state, alias, exceptId = null) {
    const key = aliasKey(alias);
    for (const profile of Object.values(state.profiles)) {
      if (profile.id !== exceptId && profile.aliasKey === key) {
        throw codedError('ALIAS_TAKEN', `A profile with the alias "${alias}" already exists.`);
      }
    }
    return key;
  }

  function validateExpectedUsername(raw) {
    if (raw === undefined || raw === null) return null;
    return normalizeUsername(raw).username;
  }

  async function list() {
    const state = await readState();
    return freezeClone(Object.values(state.profiles).map((profile) => publicProfile(state, profile)));
  }

  async function get(selector) {
    const state = await readState();
    if (selector === undefined || selector === null) {
      const defaultId = state.defaultProfileId;
      return defaultId && Object.hasOwn(state.profiles, defaultId)
        ? freezeClone(publicProfile(state, state.profiles[defaultId]))
        : null;
    }
    const profile = requireProfile(state, selector);
    return freezeClone(publicProfile(state, profile));
  }

  async function add(input = {}) {
    if (!isPlainObject(input)) throw invalid('add expects { alias, expectedUsername? }.');
    const cleanAlias = normalizeAlias(input.alias);
    const expectation = validateExpectedUsername(input.expectedUsername);
    return mutate((state) => {
      const key = uniqueAlias(state, cleanAlias);
      let id;
      do {
        id = `p_${newId()}`;
      } while (Object.hasOwn(state.profiles, id));
      const now = clock();
      state.profiles[id] = {
        id,
        alias: cleanAlias,
        aliasKey: key,
        expectedUsername: expectation,
        accountKey: null,
        accountId: null,
        username: null,
        identityVerifiedAt: null,
        generation: 1,
        credentialGeneration: 1,
        policyGeneration: 1,
        enabledBackends: ['api'],
        backendPreference: ['api'],
        visibility: 'visible',
        confirmations: {},
        api: { clientId: null, appType: null },
        passwordLoginEnabled: false,
        createdAt: now,
        updatedAt: now,
      };
      return freezeClone(publicProfile(state, state.profiles[id]));
    });
  }

  async function setDefault(selector) {
    return mutate((state) => {
      if (selector === null) {
        state.defaultProfileId = null;
        return null;
      }
      const profile = requireProfile(state, selector);
      state.defaultProfileId = profile.id;
      return freezeClone(publicProfile(state, profile));
    });
  }

  async function update(id, patch, { expectedGeneration, approval } = {}) {
    if (!isPlainObject(patch)) throw invalid('update expects a patch object.');
    const keys = Object.keys(patch);
    if (keys.length === 0) throw invalid('update requires at least one patch field.');
    for (const key of keys) {
      if (!PATCH_KEYS.has(key)) {
        throw invalid(`update does not accept "${key}"; identity, generations, and secrets are not patchable.`);
      }
    }
    return mutate((state) => {
      const profile = requireProfile(state, id);
      if (expectedGeneration !== undefined) {
        if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
          throw invalid('expectedGeneration must be a positive integer.');
        }
        if (profile.generation !== expectedGeneration) {
          throw new OperationError('POLICY_CHANGED', 'The profile changed after this operation resolved it.', {
            safeDetails: {
              expectedGeneration,
              currentGeneration: profile.generation,
              policyGeneration: profile.policyGeneration,
            },
          });
        }
      }

      const next = {
        ...profile,
        enabledBackends: [...profile.enabledBackends],
        backendPreference: [...profile.backendPreference],
        confirmations: { ...profile.confirmations },
        api: { ...profile.api },
      };
      let policyChanged = false;
      let credentialChanged = false;

      if ('alias' in patch) {
        const cleanAlias = normalizeAlias(patch.alias);
        next.aliasKey = uniqueAlias(state, cleanAlias, profile.id);
        next.alias = cleanAlias;
      }
      if ('enabledBackends' in patch) {
        next.enabledBackends = validateBackends(patch.enabledBackends, 'enabledBackends');
        policyChanged = true;
      }
      if ('backendPreference' in patch) {
        next.backendPreference = validateBackends(patch.backendPreference, 'backendPreference');
        policyChanged = true;
      }
      if ('visibility' in patch) {
        if (!VISIBILITIES.has(patch.visibility)) throw invalid('visibility must be visible, headless, or ask.');
        next.visibility = patch.visibility;
        policyChanged = true;
      }
      if ('confirmations' in patch) {
        next.confirmations = validateConfirmations(patch.confirmations);
        policyChanged = true;
      }
      if ('api' in patch) {
        next.api = validateApiMetadata(patch.api, next.api);
        credentialChanged = true;
      }
      if ('passwordLoginEnabled' in patch) {
        if (typeof patch.passwordLoginEnabled !== 'boolean') throw invalid('passwordLoginEnabled must be a boolean.');
        if (patch.passwordLoginEnabled && !approvalAccepted(approval)) {
          throw new OperationError(
            'APPROVAL_REQUIRED',
            'Enabling stored-password login needs a local settings approval; MCP cannot mint one.',
            { safeDetails: { setting: 'passwordLoginEnabled' } },
          );
        }
        next.passwordLoginEnabled = patch.passwordLoginEnabled;
        policyChanged = true;
        if (patch.passwordLoginEnabled) credentialChanged = true;
      }
      if ('credentialRotation' in patch) {
        if (patch.credentialRotation !== true) throw invalid('credentialRotation may only be true.');
        credentialChanged = true;
      }

      next.generation = profile.generation + 1;
      if (policyChanged) next.policyGeneration = profile.policyGeneration + 1;
      if (credentialChanged) next.credentialGeneration = profile.credentialGeneration + 1;
      next.updatedAt = clock();
      state.profiles[profile.id] = next;
      return freezeClone(publicProfile(state, next));
    });
  }

  async function remove(id, approval) {
    if (!approvalAccepted(approval)) {
      throw new OperationError(
        'APPROVAL_REQUIRED',
        'Deleting a profile is destructive and needs a local settings approval.',
        { safeDetails: { setting: 'profileDeletion' } },
      );
    }
    return mutate((state) => {
      const profile = requireProfile(state, id);
      delete state.profiles[profile.id];
      if (state.defaultProfileId === profile.id) state.defaultProfileId = null;
      if (profile.accountKey) {
        const stillBound = Object.values(state.profiles).some((entry) => entry.accountKey === profile.accountKey);
        if (!stillBound) delete state.accounts[profile.accountKey];
      }
      return null;
    });
  }

  async function snapshot(selector) {
    const state = await readState();
    let profile;
    if (selector === undefined || selector === null) {
      if (!state.defaultProfileId || !Object.hasOwn(state.profiles, state.defaultProfileId)) {
        throw profileRequired(state);
      }
      profile = state.profiles[state.defaultProfileId];
    } else if (selector && typeof selector === 'object' && selector.kind === 'profile' && selector.id) {
      // Accept an already resolved snapshot as a selector (resolveProfile chaining).
      profile = requireProfile(state, selector.id);
    } else {
      profile = requireProfile(state, selector);
    }
    return freezeClone(publicProfile(state, profile));
  }

  async function checkSnapshot(resolved) {
    if (!resolved || typeof resolved !== 'object' || typeof resolved.id !== 'string') {
      throw invalid('checkSnapshot expects a resolved profile snapshot.');
    }
    const state = await readState();
    const profile = Object.hasOwn(state.profiles, resolved.id) ? state.profiles[resolved.id] : null;
    if (!profile) {
      return freezeClone({
        ok: false,
        exists: false,
        reason: 'PROFILE_NOT_FOUND',
        identityChanged: false,
        policyChanged: false,
        credentialChanged: false,
        current: null,
      });
    }
    const current = publicProfile(state, profile);
    const identityChanged = Boolean(
      (resolved.accountKey ?? null) !== current.accountKey
      || (resolved.accountId ?? null) !== current.accountId
      || (resolved.username ?? null) !== current.username
      || (resolved.expectedUsername ?? null) !== current.expectedUsername,
    );
    const policyChanged = resolved.policyGeneration !== current.policyGeneration;
    const credentialChanged = resolved.credentialGeneration !== current.credentialGeneration;
    return freezeClone({
      ok: !identityChanged && !policyChanged && !credentialChanged,
      exists: true,
      reason: identityChanged
        ? 'IDENTITY_MISMATCH'
        : policyChanged
          ? 'POLICY_CHANGED'
          : credentialChanged
            ? 'CREDENTIAL_CHANGED'
            : null,
      identityChanged,
      policyChanged,
      credentialChanged,
      current,
    });
  }

  // Accounts lane entry point: bind a profile to one verified account. This is deliberately not in
  // the public update patch allowlist, so callers cannot rebind identity through `update`.
  async function bindIdentity(id, input) {
    if (!isPlainObject(input)) throw invalid('bindIdentity expects { username, accountId? }.');
    const { accountId = null, username, accountKey = null } = input;
    const normalized = normalizeUsername(username);
    const cleanAccountId = accountId === null || accountId === undefined ? null : validateAccountId(accountId);
    const key = deriveAccountKey(normalized.key);
    if (accountKey !== null && accountKey !== key) {
      throw invalid('The supplied accountKey does not match the verified username.');
    }
    return mutate((state) => {
      const profile = requireProfile(state, id);
      if (profile.expectedUsername && usernameKey(profile.expectedUsername) !== normalized.key) {
        throw new OperationError(
          'IDENTITY_MISMATCH',
          `The verified username does not match this profile's expected account.`,
          { safeDetails: { profileId: profile.id, expectedUsername: profile.expectedUsername } },
        );
      }
      if (profile.accountKey && profile.accountKey !== key) {
        throw new OperationError(
          'IDENTITY_MISMATCH',
          'This profile is already bound to a different verified account; re-enrollment is explicit.',
          { safeDetails: { profileId: profile.id } },
        );
      }
      const existing = Object.hasOwn(state.accounts, key) ? state.accounts[key] : null;
      if (profile.accountId && cleanAccountId && profile.accountId !== cleanAccountId) {
        throw new OperationError(
          'IDENTITY_MISMATCH',
          'This profile is already bound to a different verified Reddit account id.',
          { safeDetails: { profileId: profile.id } },
        );
      }
      if (existing) {
        if (existing.accountId && cleanAccountId && existing.accountId !== cleanAccountId) {
          throw new OperationError(
            'IDENTITY_MISMATCH',
            'This username is already bound to a different verified Reddit account id.',
            { safeDetails: { accountKey: key } },
          );
        }
      }
      if (cleanAccountId) {
        for (const [otherKey, record] of Object.entries(state.accounts)) {
          if (otherKey !== key && record.accountId && record.accountId === cleanAccountId) {
            throw new OperationError(
              'IDENTITY_MISMATCH',
              'This Reddit account id is already bound under a different username; refusing to merge.',
              { safeDetails: { accountKey: otherKey } },
            );
          }
        }
      }
      const now = clock();
      const resolvedAccountId = cleanAccountId || existing?.accountId || profile.accountId || null;
      state.accounts[key] = {
        accountKey: key,
        accountId: resolvedAccountId,
        username: existing?.username || normalized.username,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      state.profiles[profile.id] = {
        ...profile,
        accountKey: key,
        accountId: resolvedAccountId,
        username: normalized.username,
        identityVerifiedAt: now,
        generation: profile.generation + 1,
        updatedAt: now,
      };
      return freezeClone({
        accountKey: key,
        accountId: resolvedAccountId,
        username: normalized.username,
      });
    });
  }

  async function listAccounts() {
    const state = await readState();
    const records = Object.values(state.accounts).map((record) => ({
      accountKey: record.accountKey,
      accountId: record.accountId,
      username: record.username,
      profileIds: Object.values(state.profiles)
        .filter((profile) => profile.accountKey === record.accountKey)
        .map((profile) => profile.id),
    }));
    return freezeClone(records);
  }

  return {
    homeDir,
    path: registryPath,
    list,
    get,
    add,
    setDefault,
    update,
    snapshot,
    checkSnapshot,
    remove,
    bindIdentity,
    listAccounts,
  };
}

// Explicit > saved default > isolated legacy environment. Offline/RSS operations never call this.
export async function resolveProfile({ registry, explicitProfile = null, legacyConfigAvailable = false } = {}) {
  if (explicitProfile !== null && explicitProfile !== undefined) {
    if (!registry) {
      throw new OperationError('PROFILE_NOT_FOUND', 'A profile was named but no profile registry is configured.', {
        safeDetails: { aliases: [] },
      });
    }
    return registry.snapshot(explicitProfile);
  }
  if (!registry) {
    if (legacyConfigAvailable) return LEGACY_PROFILE;
    throw new OperationError(
      'PROFILE_REQUIRED',
      'No profile registry, no default profile, and no legacy configuration are available.',
      { safeDetails: { aliases: [] } },
    );
  }
  const profiles = await registry.list();
  const defaultProfile = profiles.find((profile) => profile.isDefault);
  if (defaultProfile) return registry.snapshot(defaultProfile.id);
  if (profiles.length === 0 && legacyConfigAvailable) return LEGACY_PROFILE;
  throw new OperationError(
    'PROFILE_REQUIRED',
    'Profiles exist but no default profile is set; name one explicitly or set a default.',
    { safeDetails: { aliases: profiles.map((profile) => profile.alias) } },
  );
}
