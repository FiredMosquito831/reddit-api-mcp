// Approval policy and trusted local approvals for writes and settings proposals.
//
// Two separate jobs live here:
//   1. resolveApprovalPolicy: pure, persisted-policy resolution over the exact 11 write tool names.
//      Default is off for every write, including deletes. Global-on is a floor; a per-action entry or a
//      one-call request can only make an action stricter, never weaker. A model-supplied `confirm: true`
//      is not accepted here at all: it is not evidence of a user approval.
//   2. createApprovalStore: durable proposals and single-use local approvals. An MCP tool may propose an
//      action or a settings patch, but only a trusted local prompt passed by the CLI can approve it.
//      There is deliberately no stdin reader in this module, and no approval token, code, or secret is
//      ever returned. Consumption is bound to the canonical binding hash (profile, account, tool,
//      target, content, policy generation) plus the approval's expiry.
//
// Settings patches are strongly allowlisted and split into operational and security changes. Any
// secret-bearing key is rejected recursively; Reddit passwords never appear in proposals. Changing the
// approval policy or enabling stored-password login is a security change and always needs local
// approval.
//
// Trust boundary: this design cannot defend against an assistant that already has unrestricted shell
// access as the same Windows user. Such a process can read this store or invoke the CLI directly.
// Local approval protects against remote/MCP callers and prompt-injected model output, not against the
// account owner's own shell.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationError } from './errors.js';
import { withLease } from './locks.js';
import { writeAtomic } from './secure-fs.js';
import { WRITE_TOOL_NAMES } from './operations.js';

export const APPROVAL_TTL_MS = 120_000;
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;
export const WRITE_TOOL_POLICY_KEYS = WRITE_TOOL_NAMES;

const POLICY_VALUES = new Set(['off', 'on']);
const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);
const STORE_FILE = 'approvals.json';
const LOCK_DIR = 'approvals.lock';
const STORE_VERSION = 1;
const MAX_RECORDS = 500;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

const BACKEND_IDS = new Set(['api', 'replay', 'browser']);
const BACKEND_PREFERENCES = new Set(['auto', 'api', 'replay', 'browser']);
const VISIBILITIES = new Set(['visible', 'hidden']);
const SAFE_MODES = new Set(['standard', 'strict']);

export const SETTINGS_PATCH_KEYS = Object.freeze([
  'safeMode',
  'maxWritesPerHour',
  'botFooter',
  'cacheTtlMs',
  'maxAttempts',
  'backendPreference',
  'enabledBackends',
  'visibility',
  'confirmations',
  'browser',
  'sampling',
]);

const SETTINGS_PATCH_KEY_SET = new Set(SETTINGS_PATCH_KEYS);
const SECRET_KEY_RE = /(password|passwd|secret|token|cookie|credential|private.?key|passphrase|refresh)/i;
// The one settings key whose name contains "password" but whose value is a boolean policy flag, never
// a credential. The exemption is confined to the one allowlisted location, `patch.browser`, so a future
// free-form setting cannot let a real credential through under this name at any other depth.
const SECRET_SHAPED_SETTING_KEYS = new Set(['passwordLoginEnabled']);
const SECRET_EXEMPT_PATH = 'patch.browser';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value, maxLength = 500) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

// Stable JSON: keys are sorted at every level so a hash never depends on argument order.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)])));
  }
  return value;
}

// A patch must be JSON-safe plain data. Anything else (functions, class instances, cycles, bigints)
// is refused so the persisted store and the canonical hash can never disagree with what was shown.
function assertJsonSafe(value, path = 'patch') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw codedError('INVALID_PATCH', `${path} must be a finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) throw codedError('INVALID_PATCH', `${path} must contain only plain JSON values.`);
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw codedError('INVALID_PATCH', `${path} contains a forbidden key.`);
    const secretExempt = path === SECRET_EXEMPT_PATH && SECRET_SHAPED_SETTING_KEYS.has(key);
    if (SECRET_KEY_RE.test(key) && !secretExempt) {
      throw codedError('INVALID_PATCH', `${path} contains a secret field (${key}); secrets are never part of a proposal.`);
    }
    assertJsonSafe(entry, `${path}.${key}`);
  }
}

function validateMode(value, label) {
  if (!POLICY_VALUES.has(value)) {
    throw new TypeError(`${label} must be "off" or "on".`);
  }
}

// Pure policy resolution. Per-action "off" is treated as no override, because the generated defaults
// fill every key with "off": an explicit per-action entry only ever adds a requirement.
export function resolveApprovalPolicy(policy = {}, tool, options = {}) {
  if (!isPlainObject(policy)) throw new TypeError('Approval policy must be an object.');
  if (!WRITE_TOOL_SET.has(tool)) {
    throw new TypeError(`Approval policy covers only the 11 write tools; got ${JSON.stringify(tool)}.`);
  }
  if (!isPlainObject(options)) throw new TypeError('Approval options must be an object.');
  const requestConfirmation = options.requestConfirmation ?? false;
  if (typeof requestConfirmation !== 'boolean') {
    throw new TypeError('requestConfirmation must be a boolean.');
  }

  const global = policy.global ?? 'off';
  validateMode(global, 'The global approval policy');
  const perAction = policy.perAction ?? {};
  if (!isPlainObject(perAction)) throw new TypeError('perAction must be an object keyed by write tool name.');
  for (const [key, value] of Object.entries(perAction)) {
    if (!WRITE_TOOL_SET.has(key)) throw new TypeError(`perAction has an unknown write tool key: ${key}.`);
    validateMode(value, `The per-action policy for ${key}`);
  }

  if (requestConfirmation) return true;
  if (perAction[tool] === 'on') return true;
  return global === 'on';
}

function validateConfirmations(patch) {
  if (!isPlainObject(patch)) throw codedError('INVALID_PATCH', 'confirmations must be an object.');
  for (const key of Object.keys(patch)) {
    if (key !== 'global' && key !== 'perAction') {
      throw codedError('INVALID_PATCH', `confirmations has an unknown key: ${key}.`);
    }
  }
  if (patch.global !== undefined) {
    if (!POLICY_VALUES.has(patch.global)) throw codedError('INVALID_PATCH', 'confirmations.global must be "off" or "on".');
  }
  if (patch.perAction !== undefined) {
    if (!isPlainObject(patch.perAction)) throw codedError('INVALID_PATCH', 'confirmations.perAction must be an object.');
    for (const [tool, value] of Object.entries(patch.perAction)) {
      if (!WRITE_TOOL_SET.has(tool)) {
        throw codedError('INVALID_PATCH', `confirmations.perAction has an unknown write tool key: ${tool}.`);
      }
      if (!POLICY_VALUES.has(value)) {
        throw codedError('INVALID_PATCH', `confirmations.perAction.${tool} must be "off" or "on".`);
      }
    }
  }
}

function validateNamedBooleans(patch, name, allowed) {
  if (!isPlainObject(patch)) throw codedError('INVALID_PATCH', `${name} must be an object.`);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) throw codedError('INVALID_PATCH', `${name} has an unknown key: ${key}.`);
    if (typeof value !== 'boolean') throw codedError('INVALID_PATCH', `${name}.${key} must be a boolean.`);
  }
}

function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) throw new TypeError('A settings proposal patch must be a plain object.');
  assertJsonSafe(patch);
  const keys = Object.keys(patch);
  if (keys.length === 0) throw codedError('INVALID_PATCH', 'A settings proposal must change at least one setting.');
  for (const key of keys) {
    if (!SETTINGS_PATCH_KEY_SET.has(key)) {
      throw codedError('INVALID_PATCH', `The setting ${key} is not allowlisted for local proposals.`);
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'safeMode':
        if (!SAFE_MODES.has(value)) throw codedError('INVALID_PATCH', 'safeMode must be standard or strict.');
        break;
      case 'maxWritesPerHour':
        if (!Number.isInteger(value) || value < 1) throw codedError('INVALID_PATCH', 'maxWritesPerHour must be an integer of at least 1.');
        break;
      case 'cacheTtlMs':
        if (!Number.isInteger(value) || value < 0) throw codedError('INVALID_PATCH', 'cacheTtlMs must be a non-negative integer.');
        break;
      case 'maxAttempts':
        if (!Number.isInteger(value) || value < 1) throw codedError('INVALID_PATCH', 'maxAttempts must be an integer of at least 1.');
        break;
      case 'botFooter':
        if (typeof value !== 'string' || value.length > 10_000) throw codedError('INVALID_PATCH', 'botFooter must be a string.');
        break;
      case 'backendPreference':
        if (!BACKEND_PREFERENCES.has(value)) throw codedError('INVALID_PATCH', 'backendPreference must be auto, api, replay, or browser.');
        break;
      case 'enabledBackends':
        if (!Array.isArray(value) || value.length === 0) throw codedError('INVALID_PATCH', 'enabledBackends must be a non-empty array.');
        for (const entry of value) {
          if (!BACKEND_IDS.has(entry)) throw codedError('INVALID_PATCH', `Unknown backend id: ${entry}.`);
        }
        if (new Set(value).size !== value.length) throw codedError('INVALID_PATCH', 'enabledBackends must not repeat a backend.');
        break;
      case 'visibility':
        if (!VISIBILITIES.has(value)) throw codedError('INVALID_PATCH', 'visibility must be visible or hidden.');
        break;
      case 'confirmations':
        validateConfirmations(value);
        break;
      case 'browser':
        validateNamedBooleans(value, 'browser', ['enabled', 'passwordLoginEnabled']);
        break;
      case 'sampling':
        validateNamedBooleans(value, 'sampling', ['enabled']);
        break;
      default:
        throw codedError('INVALID_PATCH', `The setting ${key} is not allowlisted for local proposals.`);
    }
  }
}

function collectSecurity(prefix, value) {
  const found = [];
  if (prefix === 'confirmations') found.push('confirmations');
  if (prefix === 'browser' && value?.passwordLoginEnabled === true) found.push('browser.passwordLoginEnabled');
  return found;
}

export function classifySettingsPatch(patch) {
  validateSettingsPatch(patch);
  const keys = Object.keys(patch).sort();
  const securityKeys = keys.flatMap((key) => collectSecurity(key, patch[key]));
  return Object.freeze({
    classification: securityKeys.length > 0 ? 'security' : 'operational',
    keys: Object.freeze(keys),
    securityKeys: Object.freeze(securityKeys),
    affectsApprovals: securityKeys.length > 0,
  });
}

function risksFor(classification, keys, securityKeys) {
  const risks = [];
  if (classification === 'security') {
    risks.push('This changes the trust boundary or approval requirements for future writes.');
    if (securityKeys.some((key) => key.startsWith('confirmations'))) {
      risks.push('Changing confirmations can make writes easier to dispatch without a local prompt.');
    }
    if (securityKeys.includes('browser.passwordLoginEnabled')) {
      risks.push('Enabling stored-password login lets a saved Reddit password sign the browser profile in.');
    }
  } else {
    risks.push('This changes normal operation only; it does not change approval or credential policy.');
  }
  risks.push(`Settings changed: ${keys.join(', ')}.`);
  return Object.freeze(risks);
}

function validateBinding(binding, { settings = false } = {}) {
  if (!isPlainObject(binding)) throw new TypeError('An approval binding must be a plain object.');
  assertJsonSafe(binding, 'binding');
  if (!isNonEmptyString(binding.profileId)) throw new TypeError('binding.profileId must be a non-empty string.');
  if (!isNonEmptyString(binding.accountKey)) throw new TypeError('binding.accountKey must be a non-empty string.');
  if (!isNonEmptyString(binding.tool)) throw new TypeError('binding.tool must be a non-empty string.');
  if (settings) {
    if (binding.tool !== 'settings') throw new TypeError('A settings proposal binding must use tool "settings".');
  } else if (!WRITE_TOOL_SET.has(binding.tool)) {
    throw new TypeError(`An action approval must target one of the 11 write tools; got ${binding.tool}.`);
  }
  for (const field of ['targetHash', 'contentHash']) {
    const value = binding[field];
    if (value !== null && value !== undefined && typeof value !== 'string') {
      throw new TypeError(`binding.${field} must be a string or null.`);
    }
  }
  if (!Number.isInteger(binding.policyGeneration) || binding.policyGeneration < 0) {
    throw new TypeError('binding.policyGeneration must be a non-negative integer.');
  }
  if (binding.expiresAt !== undefined && !Number.isFinite(binding.expiresAt)) {
    throw new TypeError('binding.expiresAt must be a finite timestamp when present.');
  }
  return binding;
}

function canonicalFields(binding) {
  return {
    profileId: binding.profileId,
    accountKey: binding.accountKey,
    tool: binding.tool,
    targetHash: binding.targetHash ?? null,
    contentHash: binding.contentHash ?? null,
    policyGeneration: binding.policyGeneration,
  };
}

function hashBinding(binding) {
  return hash(canonicalFields(binding));
}

function sameOperation(a, b) {
  return a.profileId === b.profileId
    && a.accountKey === b.accountKey
    && a.tool === b.tool
    && (a.targetHash ?? null) === (b.targetHash ?? null)
    && (a.contentHash ?? null) === (b.contentHash ?? null);
}

function approvalRequired(message) {
  return new OperationError('APPROVAL_REQUIRED', message);
}

function normalizeState(raw) {
  if (!isPlainObject(raw) || raw.version !== STORE_VERSION) {
    throw codedError('APPROVAL_STORE_CORRUPT', 'The local approval store has an unsupported format.');
  }
  if (!Array.isArray(raw.proposals) || !Array.isArray(raw.approvals)) {
    throw codedError('APPROVAL_STORE_CORRUPT', 'The local approval store is missing its proposal lists.');
  }
  return raw;
}

function prune(state, now) {
  state.proposals = state.proposals
    .filter((proposal) => now - (proposal.createdAt ?? 0) <= PRUNE_AGE_MS)
    .slice(-MAX_RECORDS);
  state.approvals = state.approvals
    .filter((approval) => now - (approval.createdAt ?? 0) <= PRUNE_AGE_MS)
    .slice(-MAX_RECORDS);
}

export function createApprovalStore(options = {}) {
  const { homeDir, clock = () => Date.now(), newId = randomUUID, leases = null } = options;
  if (!isNonEmptyString(homeDir, 4096)) throw new TypeError('createApprovalStore needs a homeDir.');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function.');
  if (typeof newId !== 'function') throw new TypeError('newId must be a function.');

  const storePath = join(homeDir, STORE_FILE);
  const lockPath = join(homeDir, LOCK_DIR);
  const lock = typeof leases?.withLease === 'function' ? leases.withLease : withLease;

  async function readState() {
    let text;
    try {
      text = await readFile(storePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: STORE_VERSION, proposals: [], approvals: [] };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw codedError('APPROVAL_STORE_CORRUPT', 'The local approval store is not readable JSON.');
    }
    return normalizeState(parsed);
  }

  async function writeState(state, now) {
    prune(state, now);
    await mkdir(homeDir, { recursive: true });
    await writeAtomic(storePath, JSON.stringify(state, null, 2));
  }

  async function locked(fn) {
    await mkdir(homeDir, { recursive: true });
    // A lock directory is created a moment before its metadata file appears; a competing acquirer can
    // observe that window as LOCK_CORRUPT. Retry briefly, bounded, rather than declaring real corruption
    // from one instantaneous view. Only a failure observed before the callback starts is retried: a
    // LOCK_CORRUPT raised from inside the callback means the mutation may already have happened, and
    // replaying it would double-apply it.
    for (let attempt = 1; ; attempt += 1) {
      let entered = false;
      try {
        return await lock(lockPath, { kind: 'approvals', owner: `pid-${process.pid}`, timeoutMs: 10_000 }, async (lease) => {
          entered = true;
          return fn(lease);
        });
      } catch (error) {
        if (error?.code === 'PROFILE_IN_USE' && !entered) {
          throw codedError(
            'PROFILE_IN_USE',
            'The local approvals store lock is held by another process; try again shortly.',
            error.details,
          );
        }
        if (error?.code !== 'LOCK_CORRUPT' || entered || attempt >= 40) throw error;
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  }

  function proposalStatus(proposal, now) {
    if (proposal.consumedAt) return 'consumed';
    if (proposal.rejectedAt) return 'rejected';
    if (now > proposal.expiresAt) return 'expired';
    if (proposal.approvedAt) {
      return proposal.approvalExpiresAt !== undefined && now > proposal.approvalExpiresAt ? 'expired' : 'approved';
    }
    return 'pending';
  }

  function summary(proposal, status) {
    const out = {
      id: proposal.id,
      kind: proposal.kind,
      status,
      tool: proposal.binding.tool,
      profileId: proposal.binding.profileId,
      accountKey: proposal.binding.accountKey,
      targetHash: proposal.binding.targetHash ?? null,
      contentHash: proposal.binding.contentHash ?? null,
      policyGeneration: proposal.binding.policyGeneration,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      binding: proposal.binding,
      risks: proposal.risks,
    };
    if (proposal.kind === 'settings') {
      out.classification = proposal.classification;
      out.keys = proposal.keys;
      out.patch = proposal.patch;
    }
    if (proposal.approvedAt) out.approvedAt = proposal.approvedAt;
    if (proposal.approvalExpiresAt) out.approvalExpiresAt = proposal.approvalExpiresAt;
    if (proposal.rejectedAt) out.rejectedAt = proposal.rejectedAt;
    return deepFreeze(out);
  }

  async function propose(binding, patch) {
    const isSettings = patch !== undefined;
    validateBinding(binding, { settings: isSettings });

    let canonicalBinding;
    let classified = null;
    let storedPatch = null;

    if (isSettings) {
      classified = classifySettingsPatch(patch);
      storedPatch = deepFreeze(JSON.parse(JSON.stringify(patch)));
      canonicalBinding = {
        profileId: binding.profileId,
        accountKey: binding.accountKey,
        tool: 'settings',
        targetHash: hash({ settings: classified.keys }),
        contentHash: hash(storedPatch),
        policyGeneration: binding.policyGeneration,
        ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
      };
    } else {
      canonicalBinding = {
        profileId: binding.profileId,
        accountKey: binding.accountKey,
        tool: binding.tool,
        targetHash: binding.targetHash ?? null,
        contentHash: binding.contentHash ?? null,
        policyGeneration: binding.policyGeneration,
        ...(binding.expiresAt !== undefined ? { expiresAt: binding.expiresAt } : {}),
      };
    }

    const now = clock();
    if (canonicalBinding.expiresAt !== undefined && now > canonicalBinding.expiresAt) {
      throw approvalRequired('The operation binding has already expired; start the action again.');
    }
    const risks = isSettings
      ? risksFor(classified.classification, classified.keys, classified.securityKeys)
      : Object.freeze(['This action needs a local approval before it can be dispatched.']);

    const record = {
      id: `ap_${newId()}`,
      kind: isSettings ? 'settings' : 'action',
      binding: canonicalBinding,
      patch: storedPatch,
      classification: classified?.classification ?? 'action',
      keys: classified?.keys ?? Object.freeze([canonicalBinding.tool]),
      securityKeys: classified?.securityKeys ?? Object.freeze([]),
      risks,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
      approvedAt: null,
      consumedAt: null,
    };

    await locked(async () => {
      const state = await readState();
      state.proposals.push(record);
      await writeState(state, now);
    });

    return summary(record, 'pending');
  }

  async function approveLocally(proposalId, approvalOptions = {}) {
    if (!isNonEmptyString(proposalId)) throw new TypeError('A proposal id is required.');
    if (!isPlainObject(approvalOptions)) throw new TypeError('Local approval options must be an object.');
    const { prompt } = approvalOptions;
    if (typeof prompt !== 'function') {
      throw new TypeError('A trusted local prompt function is required; this module never reads stdin or approves from tool output.');
    }

    // Time is sampled inside the lock: an acquisition wait must count against the proposal's life.
    const proposal = await locked(async () => {
      const state = await readState();
      const now = clock();
      const found = state.proposals.find((entry) => entry.id === proposalId);
      if (!found) throw approvalRequired('That settings/action proposal is no longer available; prepare it again.');
      if (found.consumedAt) throw approvalRequired('That proposal has already been used; prepare it again.');
      if (found.rejectedAt) throw approvalRequired('That proposal was declined; prepare it again.');
      if (now > found.expiresAt) throw approvalRequired('That proposal has expired; prepare it again.');
      if (found.approvedAt) throw approvalRequired('That proposal is already approved; it cannot be approved twice.');
      return found;
    });

    const request = deepFreeze({
      id: proposal.id,
      kind: proposal.kind,
      tool: proposal.binding.tool,
      profileId: proposal.binding.profileId,
      accountKey: proposal.binding.accountKey,
      targetHash: proposal.binding.targetHash ?? null,
      contentHash: proposal.binding.contentHash ?? null,
      policyGeneration: proposal.binding.policyGeneration,
      classification: proposal.classification,
      keys: proposal.keys,
      patch: proposal.patch,
      risks: proposal.risks,
      expiresAt: proposal.expiresAt,
    });

    const answer = await prompt(request);
    const accepted = answer === true || (isPlainObject(answer) && answer.approved === true);

    return locked(async () => {
      const state = await readState();
      // Sampled after the second lock: a proposal that expired while the user was deciding, or while
      // the lock was held, must not be recorded as approved with an expiry already in the past.
      const decidedAt = clock();
      const current = state.proposals.find((entry) => entry.id === proposalId);
      if (!current) throw approvalRequired('That proposal disappeared while waiting for local approval.');
      if (current.consumedAt) throw approvalRequired('That proposal was consumed while waiting for local approval.');
      if (current.rejectedAt) throw approvalRequired('That proposal was declined; prepare it again.');
      if (decidedAt > current.expiresAt) throw approvalRequired('That proposal expired while waiting for local approval.');
      if (current.approvedAt) throw approvalRequired('That proposal is already approved; it cannot be approved twice.');

      if (!accepted) {
        current.rejectedAt = decidedAt;
        await writeState(state, decidedAt);
        return deepFreeze({ id: proposalId, kind: proposal.kind, status: 'rejected', rejectedAt: decidedAt });
      }

      const approvedAt = decidedAt;
      const ttlExpiry = approvedAt + APPROVAL_TTL_MS;
      let expiresAt = Math.min(ttlExpiry, current.expiresAt);
      if (current.binding.expiresAt !== undefined) expiresAt = Math.min(expiresAt, current.binding.expiresAt);

      const approval = {
        id: `av_${newId()}`,
        proposalId: current.id,
        kind: current.kind,
        bindingHash: hashBinding(current.binding),
        binding: current.binding,
        patch: current.patch,
        classification: current.classification,
        createdAt: approvedAt,
        expiresAt,
        consumedAt: null,
      };
      state.approvals.push(approval);
      current.approvedAt = approvedAt;
      current.approvalExpiresAt = expiresAt;
      await writeState(state, approvedAt);

      const result = {
        id: proposalId,
        kind: current.kind,
        status: 'approved',
        expiresAt,
        classification: current.classification,
      };
      if (current.kind === 'settings') {
        result.keys = current.keys;
        result.patch = current.patch;
      }
      return deepFreeze(result);
    });
  }

  async function consume(binding) {
    validateBinding(binding, { settings: binding?.tool === 'settings' });
    const wantedHash = hashBinding(binding);
    const wanted = canonicalFields(binding);

    return locked(async () => {
      // Sampled inside the lock: a lease wait must count against both the binding and the approval, and
      // consumedAt must not predate the write it authorizes.
      const now = clock();
      if (binding.expiresAt !== undefined && now > binding.expiresAt) {
        throw approvalRequired('The operation binding has expired; start the action again.');
      }
      const state = await readState();
      const matching = state.approvals.filter((approval) => approval.bindingHash === wantedHash);
      const usable = matching.find((approval) => approval.consumedAt === null && now <= approval.expiresAt);

      if (!usable) {
        // The exact binding was approved before but is now consumed or expired: a replay, not a
        // policy change. Only a same-operation binding with a different generation is POLICY_CHANGED.
        if (matching.length > 0) {
          throw approvalRequired('That approval was already used, or it expired; prepare the action again.');
        }
        if (state.approvals.some((approval) => sameOperation(approval.binding, wanted))) {
          throw new OperationError(
            'POLICY_CHANGED',
            'The approval was bound to a different policy generation or account state; re-evaluate and prepare the action again.',
          );
        }
        throw approvalRequired('No local approval matches this operation, account, target, and content.');
      }

      usable.consumedAt = now;
      const proposal = state.proposals.find((entry) => entry.id === usable.proposalId);
      if (proposal) proposal.consumedAt = now;
      await writeState(state, now);

      const result = {
        approved: true,
        proposalId: usable.proposalId,
        kind: usable.kind,
        classification: usable.classification,
      };
      if (usable.kind === 'settings') result.patch = usable.patch;
      return deepFreeze(result);
    });
  }

  // Reads share the store lock with every writer, so a read can never observe a half-written state.
  // An optional {profileId, accountKey} scope hides a proposal that belongs to another account.
  async function status(id, scope = {}) {
    if (!isNonEmptyString(id)) throw new TypeError('A proposal id is required.');
    if (!isPlainObject(scope)) throw new TypeError('Status scope must be an object.');
    const { profileId, accountKey } = scope;
    if (profileId !== undefined && !isNonEmptyString(profileId)) throw new TypeError('scope.profileId must be a non-empty string.');
    if (accountKey !== undefined && !isNonEmptyString(accountKey)) throw new TypeError('scope.accountKey must be a non-empty string.');

    return locked(async () => {
      const state = await readState();
      const proposal = state.proposals.find((entry) => entry.id === id);
      if (!proposal) return deepFreeze({ id, status: 'missing' });
      if (profileId !== undefined && proposal.binding.profileId !== profileId) {
        return deepFreeze({ id, status: 'missing' });
      }
      if (accountKey !== undefined && proposal.binding.accountKey !== accountKey) {
        return deepFreeze({ id, status: 'missing' });
      }
      return summary(proposal, proposalStatus(proposal, clock()));
    });
  }

  return Object.freeze({ propose, approveLocally, consume, status });
}
