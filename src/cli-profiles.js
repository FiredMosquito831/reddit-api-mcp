// Named-profile CLI controls and the shared plumbing the CLI uses with the dispatcher.
//
// Everything here is injectable. The real command line passes `createCliServices()`, the terminal
// prompt helpers, and the browser doctor/setup functions; tests pass fakes bound to a temporary home
// directory so no test reaches the OS keychain, a browser, Reddit, or the real ~/.reddit-cli.
//
// Two rules shape this module:
//   * A stored confirmation policy is mandatory. `--yes` is a legacy convenience for the raw API
//     escape hatch only; it never satisfies a configured confirmation. When the effective policy (or
//     an explicit one-call request) requires a confirmation, only a trusted local terminal prompt can
//     approve it, and the approval is bound to the operation, account, target, content, and policy
//     generation through src/approvals.js.
//   * Secrets never travel through argv, environment variables, or printed output. Public API
//     metadata (client id, app type) may be arguments; secrets are read from a hidden terminal prompt
//     and written straight to the profile's OS-store entry.

import { createHash } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { createAccountRegistry } from './accounts.js';
import { createApprovalStore, classifySettingsPatch } from './approvals.js';
import { createBrowserSessionManager } from './browser/session.js';
import { createBrowserTasks } from './browser/steps.js';
import { readLegacyApiConfig, readRuntimeSettings } from './config.js';
import { createDispatcher } from './dispatch.js';
import { OperationError } from './errors.js';
import { WRITE_TOOL_NAMES, describeOperation } from './operations.js';
import { createProfileRegistry, deriveAccountKey, usernameKey } from './profiles.js';
import { createProfileSecretStore } from './secrets.js';

const BACKEND_MODES = Object.freeze(['auto', 'api', 'replay', 'browser']);
const VISIBILITIES = Object.freeze(['visible', 'headless', 'ask']);
const APP_TYPES = Object.freeze(['script', 'web', 'installed']);
const SECRET_NAMES = Object.freeze(['clientSecret', 'refreshToken', 'password']);
const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);

function out(deps) {
  return deps.out ?? ((line) => console.log(line));
}

function isInteractive(deps) {
  if (typeof deps.interactive === 'function') return deps.interactive() === true;
  if (typeof deps.interactive === 'boolean') return deps.interactive;
  return process.stdin.isTTY === true;
}

function requireServices(deps) {
  if (typeof deps.services !== 'function') {
    throw new TypeError('CLI dependencies must expose services() returning the shared services.');
  }
  const services = deps.services();
  if (!services || typeof services !== 'object') {
    throw new TypeError('CLI services are not configured.');
  }
  return services;
}

function parseList(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} needs a comma-separated list.`);
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length === 0) throw new Error(`${label} needs at least one value.`);
  return entries;
}

function parseConfirmation(value) {
  const index = value.indexOf('=');
  if (index < 1) throw new Error(`Expected tool=on|off, got: ${value}`);
  const tool = value.slice(0, index).trim();
  const state = value.slice(index + 1).trim().toLowerCase();
  if (!WRITE_TOOL_SET.has(tool)) throw new Error(`Unknown write tool: ${tool}`);
  if (state !== 'on' && state !== 'off') throw new Error(`Confirmation state must be on or off, got: ${state}`);
  return [tool, state === 'on'];
}

function parseOnOff(value, label) {
  const state = String(value ?? '').trim().toLowerCase();
  if (state === 'on' || state === 'true' || state === 'yes') return true;
  if (state === 'off' || state === 'false' || state === 'no') return false;
  throw new Error(`${label} must be on or off.`);
}

function backendPreferenceFrom(list) {
  // Stored as an ordered array of backend ids; "auto" is a per-call mode, not a listed backend.
  return parseList(list, '--preference').map((entry) => {
    if (!BACKEND_MODES.includes(entry) || entry === 'auto') throw new Error(`Unknown backend: ${entry}`);
    return entry;
  });
}

function enabledBackendsFrom(list) {
  return parseList(list, '--enable-backends').map((entry) => {
    if (!BACKEND_MODES.includes(entry) || entry === 'auto') throw new Error(`Unknown backend: ${entry}`);
    return entry;
  });
}

// The account key an approval is bound to. A bound profile has one; an enrolled-but-unbound profile
// derives the same key the dispatcher's identity probe will derive. Anything else cannot be bound,
// and the caller refuses rather than guessing.
export function approvalAccountKeyFor(profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (typeof profile.accountKey === 'string' && profile.accountKey.length > 0) return profile.accountKey;
  const name = profile.expectedUsername ?? profile.username ?? null;
  if (typeof name === 'string' && name.length > 0) return deriveAccountKey(usernameKey(name));
  return null;
}

// Same canonical hash the write boundary builds, so a local approval prepared here is the one the
// dispatcher consumes. Never includes the raw target or content.
export function buildApprovalBinding({ profile, operation, policyGeneration = 0 }) {
  if (!profile || typeof profile.id !== 'string') throw new TypeError('An approval binding needs a resolved profile.');
  if (!operation || typeof operation.target !== 'string') throw new TypeError('An approval binding needs an operation descriptor.');
  const accountKey = approvalAccountKeyFor(profile);
  if (!accountKey) return null;
  return {
    profileId: profile.id,
    accountKey,
    tool: operation.policyKey,
    targetHash: createHash('sha256').update(operation.target).digest('hex'),
    contentHash: operation.contentHash ?? null,
    policyGeneration,
  };
}

// The account key the dispatcher will use for this call, resolved without probing Reddit. A bound
// profile carries one. For the environment-only legacy profile the dispatcher reports no identity, but
// its backend probe derives the key from the configured username, so the CLI must derive the same one
// or its approval can never be consumed.
async function resolveApprovalAccountKey(services, profile) {
  if (!profile || typeof profile !== 'object') return null;
  if (typeof profile.accountKey === 'string' && profile.accountKey.length > 0) return profile.accountKey;
  let username = profile.expectedUsername ?? profile.username ?? null;
  if ((typeof username !== 'string' || username.length === 0) && profile.isLegacy) {
    try {
      const legacy = readLegacyApiConfig(services.env ?? {});
      username = legacy?.username ?? null;
    } catch {
      return null;
    }
  }
  if (typeof username !== 'string' || username.length === 0) return null;
  // Mirror the dispatcher: an account the registry already knows keeps its canonical key.
  if (services.accounts && typeof services.accounts.lookup === 'function') {
    try {
      const existing = await services.accounts.lookup({ username });
      if (existing?.accountKey) return existing.accountKey;
    } catch {
      // An unresolved identity falls back to the key the backend probe will derive.
    }
  }
  return deriveAccountKey(usernameKey(username));
}

// The write boundary binds legacy approvals to `LEGACY_PROFILE.policyGeneration` (1), and to the
// resolved profile's generation otherwise. A hard zero here produced approvals that could never match.
async function policyGenerationFor(services, profile) {
  if (Number.isInteger(profile.policyGeneration)) return profile.policyGeneration;
  if (profile.isLegacy) return 1;
  if (!services.registry || typeof services.registry.snapshot !== 'function') return 0;
  const snapshot = await services.registry.snapshot(profile.id);
  return Number.isInteger(snapshot.policyGeneration) ? snapshot.policyGeneration : 0;
}

function approvalPolicyOf(status) {
  const policy = status?.approvalPolicy;
  if (!policy || typeof policy !== 'object') return { global: 'off', perAction: {} };
  return {
    global: policy.global === 'on' ? 'on' : 'off',
    perAction: policy.perAction && typeof policy.perAction === 'object' ? policy.perAction : {},
  };
}

// A write runs through the dispatcher and, when policy requires it, through a trusted local
// approval. `--yes` is deliberately absent: it cannot be passed as an approval here at all.
export async function executeCliWrite(deps, {
  tool,
  args = {},
  profile = null,
  backend = null,
  confirm = false,
} = {}) {
  if (!WRITE_TOOL_SET.has(tool)) throw new Error(`Not a write tool: ${tool}`);
  const services = requireServices(deps);
  const dispatcher = services.dispatcher;
  if (!dispatcher || typeof dispatcher.execute !== 'function' || typeof dispatcher.status !== 'function') {
    throw new TypeError('CLI services need a dispatcher with execute() and status().');
  }

  const status = await dispatcher.status(profile);
  const policy = approvalPolicyOf(status);
  const required = confirm === true || policy.global === 'on' || policy.perAction[tool] === 'on';
  if (required) {
    const settings = services.settings ?? {};
    const operation = describeOperation(tool, args, settings);
    await ensureLocalApproval(deps, services, status, operation);
  }

  return dispatcher.execute(tool, args, {
    profile,
    backend,
    requestConfirmation: confirm === true,
  });
}

// One trusted local approval path for a policy-covered tool and for the raw API escape hatch. The
// returned proposal is bound to the exact operation, account, target, content, and policy generation.
async function ensureLocalApproval(deps, services, status, operation) {
  if (!isInteractive(deps)) {
    throw new OperationError(
      'APPROVAL_REQUIRED',
      'This action requires a trusted local confirmation, which needs an interactive terminal. Nothing was sent.',
    );
  }
  if (!services.approvals || typeof services.approvals.propose !== 'function') {
    throw new OperationError('APPROVAL_REQUIRED', 'This action requires a local approval store, and none is configured.');
  }
  const accountKey = await resolveApprovalAccountKey(services, status.profile);
  const binding = buildApprovalBinding({
    // The status profile is frozen and omits the legacy identity, so bind with the resolved key.
    profile: accountKey ? { ...status.profile, accountKey } : status.profile,
    operation,
    policyGeneration: await policyGenerationFor(services, status.profile),
  });
  if (!binding) {
    throw new OperationError(
      'PROFILE_REQUIRED',
      'This profile is not bound to a verified Reddit account yet, so a local approval cannot be bound to it. '
        + 'Sign in or enroll the profile first. Nothing was sent.',
    );
  }
  const proposal = await services.approvals.propose(binding);
  const write = out(deps);
  write(`Local confirmation required for ${operation.policyKey} on profile "${status.profile.alias ?? status.profile.id}".`);
  write(`Target: ${operation.target}`);
  for (const risk of proposal.risks ?? []) write(`Risk: ${risk}`);
  const approved = await services.approvals.approveLocally(proposal.id, {
    prompt: async (request) => {
      const answer = await deps.promptApproval(request);
      return answer === true || (answer && answer.approved === true);
    },
  });
  if (approved?.status !== 'approved') {
    throw new OperationError('APPROVAL_REQUIRED', 'The local confirmation was declined. Nothing was sent.');
  }
}

// Raw POST is not one of the 32 tools, but it uses the same durable boundary with its own
// `raw_post` key. --yes remains the legacy local confirmation for a raw POST when no stricter
// stored policy is configured; a global "on" policy still needs the trusted local approval.
export async function executeCliRaw(deps, {
  method = 'POST',
  path,
  fields = {},
  profile = null,
  yes = false,
} = {}) {
  const services = requireServices(deps);
  const dispatcher = services.dispatcher;
  if (!dispatcher || typeof dispatcher.executeRaw !== 'function') {
    throw new TypeError('CLI services need a dispatcher with executeRaw().');
  }
  const status = await dispatcher.status(profile);
  const policy = approvalPolicyOf(status);
  if (yes !== true || policy.global === 'on') {
    await ensureLocalApproval(deps, services, status, {
      tool: 'raw_post',
      action: 'raw',
      kind: 'write',
      policyKey: 'raw_post',
      target: `raw:POST:${path}`,
      requiresIdentity: true,
      contentHash: null,
      args: { method: 'POST', path, fields: { ...fields } },
    });
  }
  return dispatcher.executeRaw({ method, path, fields }, { profile });
}

// Reads (and offline/RSS operations) share one dispatcher entry point so profile freezing, backend
// selection, and error classification are identical to MCP.
export async function executeCliRead(deps, { tool, args = {}, profile = null, backend = null } = {}) {
  const services = requireServices(deps);
  if (!services.dispatcher || typeof services.dispatcher.execute !== 'function') {
    throw new TypeError('CLI services need a dispatcher with execute().');
  }
  return services.dispatcher.execute(tool, args, { profile, backend });
}

// Logs one profile out and reports, separately, what was done locally and what was attempted
// remotely. Browser cookies are closed/cleared by the session manager; no cookie is ever exported.
export async function logoutProfile(deps, name, { print = true } = {}) {
  const services = requireServices(deps);
  const write = out(deps);
  const { registry, secretStore, browserSessions } = services;
  const snapshot = await registry.snapshot(name);
  const result = {
    profile: snapshot.alias,
    api: { localRemoved: false, remoteLogoutRequested: false, remoteLogoutFailed: false, reason: null },
    browser: null,
  };

  const tokenRef = secretStore.ref(snapshot.id, 'refreshToken');
  let refreshToken = null;
  try {
    refreshToken = await secretStore.get(tokenRef);
  } catch {
    refreshToken = null;
  }
  if (refreshToken) {
    let clientSecret = '';
    try {
      clientSecret = (await secretStore.get(secretStore.ref(snapshot.id, 'clientSecret'))) ?? '';
    } catch {
      clientSecret = '';
    }
    const clientId = snapshot.api?.clientId ?? null;
    if (clientId && clientSecret && typeof deps.revokeToken === 'function') {
      result.api.remoteLogoutRequested = true;
      try {
        await deps.revokeToken({
          clientId,
          clientSecret,
          userAgent: services.settings?.userAgent ?? `node:reddit-cli:${snapshot.alias}`,
          refreshToken,
        });
      } catch {
        result.api.remoteLogoutFailed = true;
      }
    } else {
      result.api.reason = 'no_client_credentials_for_revoke';
    }
    await secretStore.delete(tokenRef);
    result.api.localRemoved = true;
  }

  if (browserSessions && typeof browserSessions.close === 'function') {
    try {
      const closed = await browserSessions.close(snapshot.id, { logout: true });
      if (closed && (closed.closed || closed.remoteLogoutRequested || closed.localOnly)) {
        result.browser = {
          closed: closed.closed === true,
          localOnly: closed.localOnly === true,
          remoteLogoutRequested: closed.remoteLogoutRequested === true,
          remoteLogoutFailed: closed.remoteLogoutFailed === true,
        };
      }
    } catch (error) {
      if (error?.code === 'PROFILE_IN_USE') throw error;
      result.browser = { closed: false, localOnly: false, remoteLogoutRequested: false, remoteLogoutFailed: true };
    }
  }

  if (!print) return result;
  write(`Profile: ${result.profile}`);
  if (result.api.localRemoved) {
    write(`API token: removed from local storage${result.api.remoteLogoutRequested ? '; Reddit revocation requested' : '; no remote revocation was possible'}.`);
    if (result.api.remoteLogoutFailed) write('API token: remote revocation failed. The local copy is gone; Reddit may still honor it until it expires.');
  } else {
    write('API token: no local refresh token was stored.');
  }
  if (result.browser) {
    write(`Browser session: local close=${result.browser.closed ? 'done' : 'none'}, `
      + `remote logout requested=${result.browser.remoteLogoutRequested ? 'yes' : 'no'}`
      + `${result.browser.remoteLogoutFailed ? ', remote logout failed' : ''}.`);
    if (result.browser.localOnly) write('Browser session: only local state existed; no remote logout was possible.');
  } else {
    write('Browser session: nothing to close.');
  }
  return result;
}

function printProfileLine(write, profile) {
  const marker = profile.isDefault ? '*' : ' ';
  const account = profile.username ? `u/${profile.username}` : (profile.accountId ?? 'unbound');
  const api = profile.api?.clientId ? ` api=${profile.api.clientId}` : '';
  write(
    `${marker} ${profile.alias.padEnd(20)} ${account.padEnd(24)} `
      + `backends=${(profile.enabledBackends ?? []).join(',') || '-'} `
      + `preference=${(profile.backendPreference ?? []).join(',') || '-'}${api}`,
  );
}

// ---- commands ---------------------------------------------------------------------------------

export function addBackendOptions(command, { json = true } = {}) {
  command
    .option('--profile <name>', 'use this named profile instead of the saved default')
    .option('--backend <mode>', `backend: ${BACKEND_MODES.join(', ')}`);
  if (json) command.option('--json', 'print the full structured result');
  return command;
}

export function addProfileCommands(program, deps) {
  const write = out(deps);
  const profile = program
    .command('profile')
    .description('Manage named Reddit account profiles (local metadata and OS-store secrets)');

  profile
    .command('add <name>')
    .description('Add a named profile; API client id and app type are public metadata')
    .option('--username <username>', 'the expected Reddit account for this profile')
    .option('--api-client-id <id>', 'this profile Reddit app client id (public metadata)')
    .option('--app-type <type>', 'script, web, or installed')
    .option('--json', 'print the stored profile record')
    .action(async (name, options) => {
      if (options.appType !== undefined && !APP_TYPES.includes(options.appType)) {
        throw new Error('--app-type must be script, web, or installed.');
      }
      const { registry } = requireServices(deps);
      let record = await registry.add({ alias: name, expectedUsername: options.username });
      if (options.apiClientId !== undefined || options.appType !== undefined) {
        record = await registry.update(record.id, {
          api: {
            ...(options.apiClientId !== undefined ? { clientId: options.apiClientId } : {}),
            ...(options.appType !== undefined ? { appType: options.appType } : {}),
          },
        });
      }
      if (options.json) {
        write(JSON.stringify(record, null, 2));
        return;
      }
      write(`Added profile "${record.alias}" (${record.id}).`);
      write('Next: store this profile API secrets with "profile credentials", or enroll a browser session with "browser login".');
    });

  profile
    .command('list')
    .description('List named profiles and the saved default')
    .option('--json', 'print profiles as JSON')
    .action(async (options) => {
      const { registry } = requireServices(deps);
      const profiles = await registry.list();
      if (options.json) {
        write(JSON.stringify({ profiles }, null, 2));
        return;
      }
      if (profiles.length === 0) {
        write('No named profiles. The environment-only configuration is used only while no profile registry exists.');
        return;
      }
      for (const entry of profiles) printProfileLine(write, entry);
    });

  profile
    .command('default [name]')
    .description('Show or set the saved default profile')
    .option('--clear', 'remove the saved default')
    .option('--json', 'print JSON')
    .action(async (name, options) => {
      const { registry } = requireServices(deps);
      if (name === undefined && !options.clear) {
        const current = await registry.get(null);
        if (options.json) {
          write(JSON.stringify({ defaultProfile: current?.alias ?? null }, null, 2));
        } else {
          write(current ? `Default profile: ${current.alias}` : 'No default profile is set.');
        }
        return;
      }
      if (options.clear && name !== undefined) throw new Error('Give a name or --clear, not both.');
      const record = await registry.setDefault(options.clear ? null : name);
      if (options.json) {
        write(JSON.stringify({ defaultProfile: record?.alias ?? null }, null, 2));
      } else {
        write(record ? `Default profile: ${record.alias}` : 'Default profile cleared.');
      }
    });

  profile
    .command('status [name]')
    .description('Show the resolved profile, backends, confirmation policy, and pending writes')
    .option('--json', 'print the full status object')
    .action(async (name, options) => {
      const { dispatcher } = requireServices(deps);
      const status = await dispatcher.status(name ?? null);
      if (options.json) {
        write(JSON.stringify(status, null, 2));
        return;
      }
      const p = status.profile;
      write(`Profile: ${p.alias ?? p.id}${p.isLegacy ? ' (environment-only legacy)' : ''}`);
      write(`Account: ${p.username ? `u/${p.username}` : (p.accountId ?? 'unbound')}${p.bound ? '' : ' (not verified)'}`);
      write(`Default: ${status.defaultProfile ?? 'none'}`);
      write(`Backends: enabled=${status.enabledBackends.join(',') || '-'} preference=${status.backendPreference.join(',') || '-'}`);
      write(`Visibility: ${status.visibility}`);
      write(`Stored-password login: ${status.passwordLoginEnabled ? 'on' : 'off'}`);
      const enabledConfirmations = Object.entries(status.confirmations ?? {})
        .filter(([, value]) => value === true || value === 'on')
        .map(([key]) => key);
      write(`Profile confirmations: ${enabledConfirmations.length > 0 ? enabledConfirmations.join(',') : 'none'}`);
      write(`Effective approval policy: global=${status.approvalPolicy.global} `
        + `perAction=${Object.keys(status.approvalPolicy.perAction).join(',') || 'none'}`);
      write(`API app: ${status.api.clientId ?? 'not configured'}${status.api.appType ? ` (${status.api.appType})` : ''}`);
      write(`Pending writes: ${status.pendingAttempts.length}`);
      for (const attempt of status.pendingAttempts) {
        write(`  ${attempt.id}  ${attempt.tool ?? attempt.operation?.tool ?? '?'}  ${attempt.state ?? ''}`);
      }
    });

  profile
    .command('attempts [name]')
    .description('List prepared, dispatched, or unknown writes for a profile without resubmitting them')
    .option('--json', 'print the pending attempts as JSON')
    .action(async (name, options) => {
      const { dispatcher } = requireServices(deps);
      const pending = await dispatcher.pendingAttempts(name ?? null);
      if (options.json) {
        write(JSON.stringify(pending, null, 2));
        return;
      }
      if (pending.length === 0) {
        write('No pending or unknown writes.');
        return;
      }
      for (const attempt of pending) {
        const tool = attempt.tool ?? attempt.operation?.tool ?? '?';
        write(`${attempt.id}  ${tool}  ${attempt.state ?? ''}  ${attempt.dispatchedAt ? 'dispatched' : 'not dispatched'}`);
      }
      write('Resolve one after checking Reddit: reddit-cli profile resolve <name> <attempt-id> <succeeded|failed> --note "...".');
    });

  profile
    .command('resolve <name> <attempt-id> <outcome>')
    .description('Record what a person verified for an uncertain write; never resubmits it')
    .option('--note <text>', 'short note describing how the outcome was verified')
    .option('--json', 'print the resolved attempt as JSON')
    .action(async (name, attemptId, outcome, options) => {
      const { dispatcher } = requireServices(deps);
      const normalized = String(outcome ?? '').trim().toLowerCase();
      if (normalized !== 'succeeded' && normalized !== 'failed') {
        throw new Error('Outcome must be "succeeded" or "failed". Nothing was changed.');
      }
      const result = await dispatcher.resolveAttempt(name, attemptId, {
        outcome: normalized,
        ...(options.note !== undefined ? { note: options.note } : {}),
      });
      if (options.json) {
        write(JSON.stringify(result, null, 2));
        return;
      }
      write(`Attempt ${result.id} recorded as ${result.state} (${result.resolution}). Nothing was resent.`);
    });

  profile
    .command('configure <name>')
    .description('Change non-secret operational settings; approval-policy changes need a local confirmation')
    .option('--alias <name>', 'rename the profile alias')
    .option('--enable-backends <list>', 'comma-separated backend ids that may run')
    .option('--preference <list>', 'comma-separated backend order, e.g. api,replay,browser')
    .option('--visibility <mode>', 'visible, headless, or ask')
    .option('--confirmation <tool=on|off>', 'set one write tool confirmation (repeatable)', (value, previous) => [...previous, value], [])
    .option('--confirmation-global <on|off>', 'set the profile-wide confirmation default')
    .option('--password-login <on|off>', 'allow stored-password browser login (needs approval)')
    .option('--dry-run', 'show the patch and classification without changing anything')
    .option('--json', 'print JSON')
    .action(async (name, options) => {
      const services = requireServices(deps);
      const { registry, approvals } = services;
      const snapshot = await registry.snapshot(name);
      const patch = {};
      if (options.alias !== undefined) patch.alias = options.alias;
      if (options.enableBackends !== undefined) patch.enabledBackends = enabledBackendsFrom(options.enableBackends);
      if (options.preference !== undefined) patch.backendPreference = backendPreferenceFrom(options.preference);
      if (options.visibility !== undefined) {
        if (!VISIBILITIES.includes(options.visibility)) throw new Error('--visibility must be visible, headless, or ask.');
        patch.visibility = options.visibility;
      }
      const confirmationEntries = options.confirmation ?? [];
      if (confirmationEntries.length > 0 || options.confirmationGlobal !== undefined) {
        const confirmations = { ...(snapshot.confirmations ?? {}) };
        for (const entry of confirmationEntries) {
          const [tool, on] = parseConfirmation(entry);
          confirmations[tool] = on;
        }
        if (options.confirmationGlobal !== undefined) {
          confirmations.global = parseOnOff(options.confirmationGlobal, '--confirmation-global');
        }
        patch.confirmations = confirmations;
      }
      if (options.passwordLogin !== undefined) {
        patch.passwordLoginEnabled = parseOnOff(options.passwordLogin, '--password-login');
      }
      if (Object.keys(patch).length === 0) throw new Error('Give at least one setting to change.');
      const classification = securityClassificationFor(patch);

      if (options.dryRun) {
        write(`Dry run: profile "${snapshot.alias}" would be updated. Nothing was written.`);
        write(`Classification: ${classification.classification}`);
        write(`Settings: ${classification.keys.join(', ')}`);
        write(JSON.stringify(patch, null, 2));
        return;
      }

      if (classification.classification === 'security') {
        await approveSettingsPatchLocally(deps, services, snapshot, patch, classification);
      }
      // Revalidate at write time: a concurrent settings change must not be silently overwritten by
      // the map this process read before its local prompt.
      const updated = await registry.update(snapshot.id, patch, {
        expectedGeneration: snapshot.generation,
        approval: { approved: true },
      });
      if (options.json) {
        write(JSON.stringify(updated, null, 2));
        return;
      }
      write(`Updated profile "${updated.alias}". Classification: ${classification.classification}.`);
    });

  profile
    .command('approve-settings <proposal>')
    .description('Approve a pending security-settings proposal with a trusted local prompt')
    .option('--json', 'print JSON')
    .action(async (proposalId, options) => {
      const services = requireServices(deps);
      const { approvals } = services;
      if (!isInteractive(deps)) {
        throw new Error('A settings approval needs an interactive terminal. Nothing was approved.');
      }
      const pending = await approvals.status(proposalId);
      if (!pending || pending.status !== 'pending') {
        throw new Error(`Proposal ${proposalId} is ${pending?.status ?? 'missing'}; nothing was approved.`);
      }
      // An action approval belongs to a dispatch; consuming it here would burn an approval this
      // command cannot use, so only settings proposals are accepted.
      if (pending.kind !== 'settings' || !pending.patch) {
        throw new Error(`Proposal ${proposalId} is not a settings proposal; only settings proposals are approved here.`);
      }
      const request = {
        id: pending.id,
        kind: pending.kind,
        tool: pending.tool,
        profileId: pending.profileId,
        classification: pending.classification,
        keys: pending.keys,
        patch: pending.patch,
        risks: pending.risks,
      };
      if (!options.json) {
        write(`Proposal ${pending.id} (${pending.kind}) for profile ${pending.profileId}.`);
        write(`Proposed settings: ${JSON.stringify(pending.patch)}`);
        for (const risk of pending.risks ?? []) write(`Risk: ${risk}`);
      }
      const result = await approvals.approveLocally(proposalId, {
        prompt: async () => {
          const answer = await deps.promptApproval(request);
          return answer === true || (answer && answer.approved === true);
        },
      });
      let applied = null;
      if (result.status === 'approved') {
        applied = await applyApprovedSettings(services, pending);
        if (!options.json) {
          if (applied.applied.length > 0) {
            write(`Applied to profile "${applied.profile}": ${applied.applied.join(', ')}.`);
          } else {
            write(`Approved locally; no stored profile setting changed for "${applied.profile}".`);
          }
          if (applied.notApplied.length > 0) {
            write(`Not applicable to this named profile (runtime or environment level): ${applied.notApplied.join(', ')}.`);
          }
          write('The approval is consumed and cannot authorize a second application.');
        }
      } else if (!options.json) {
        write('The proposal was declined. Nothing was changed.');
      }
      if (options.json) {
        write(JSON.stringify(applied ? { ...result, applied } : result, null, 2));
      }
    });

  profile
    .command('credentials <name>')
    .description('Enter profile API secrets or the optional browser password with hidden local prompts')
    .option('--password-login <on|off>', 'enable or disable stored-password browser login (needs approval)')
    .option('--json', 'print which secret names were stored, never their values')
    .action(async (name, options) => {
      const services = requireServices(deps);
      const { registry, secretStore } = services;
      if (!isInteractive(deps)) {
        throw new Error('Credentials are entered only at an interactive terminal. Nothing was read or stored.');
      }
      const snapshot = await registry.snapshot(name);
      const stored = [];

      if (options.passwordLogin !== undefined) {
        const enable = parseOnOff(options.passwordLogin, '--password-login');
        if (enable) {
          // Read the secret first: a blank entry must not leave stored-password login enabled with no
          // password to use, and nothing is approved or written until a password exists.
          const password = await deps.askHidden(`Reddit password for u/${snapshot.username ?? snapshot.expectedUsername ?? snapshot.alias}: `);
          if (typeof password !== 'string' || password === '') {
            throw new Error('No password was entered; stored-password login was not enabled and nothing was stored.');
          }
          await approveSettingsPatchLocally(deps, services, snapshot, { passwordLoginEnabled: true });
          const passwordRef = secretStore.ref(snapshot.id, 'password');
          await secretStore.set(passwordRef, password);
          try {
            await registry.update(snapshot.id, { passwordLoginEnabled: true }, {
              expectedGeneration: snapshot.generation,
              approval: { approved: true },
            });
          } catch (error) {
            // Do not leave a secret for an enable that did not take effect.
            await secretStore.delete(passwordRef).catch(() => {});
            throw error;
          }
          stored.push('password');
        } else {
          await registry.update(snapshot.id, { passwordLoginEnabled: false }, {
            expectedGeneration: snapshot.generation,
            approval: { approved: true },
          });
          await secretStore.delete(secretStore.ref(snapshot.id, 'password'));
          stored.push('password (cleared)');
        }
      } else {
        const clientSecret = await deps.askHidden('Profile app client secret (blank keeps the current value): ');
        if (typeof clientSecret === 'string' && clientSecret !== '') {
          await secretStore.set(secretStore.ref(snapshot.id, 'clientSecret'), clientSecret);
          stored.push('clientSecret');
        }
        const refreshToken = await deps.askHidden('Refresh token (blank keeps the current value): ');
        if (typeof refreshToken === 'string' && refreshToken !== '') {
          await secretStore.set(secretStore.ref(snapshot.id, 'refreshToken'), refreshToken);
          stored.push('refreshToken');
        }
      }

      if (options.json) {
        write(JSON.stringify({ profile: snapshot.alias, stored }, null, 2));
        return;
      }
      write(stored.length > 0
        ? `Stored for profile "${snapshot.alias}": ${stored.join(', ')}. Values are never printed.`
        : `Nothing was stored for profile "${snapshot.alias}".`);
    });

  profile
    .command('logout <name>')
    .description('Log out this profile: revoke the API token when possible, then report local and remote state')
    .option('--json', 'print the local/remote result')
    .action(async (name, options) => {
      const result = await logoutProfile(deps, name, { print: options.json !== true });
      if (options.json) write(JSON.stringify(result, null, 2));
    });

  profile
    .command('remove <name>')
    .description('Delete a profile and its local secrets after a typed local confirmation')
    .option('--json', 'print JSON')
    .action(async (name, options) => {
      const services = requireServices(deps);
      const { registry, secretStore, browserSessions } = services;
      const snapshot = await registry.snapshot(name);
      if (!isInteractive(deps)) {
        throw new Error('Deleting a profile needs an interactive terminal. Nothing was deleted.');
      }
      const typed = await deps.askText(`Type the alias "${snapshot.alias}" to delete this profile and its local secrets: `);
      const answer = String(typed ?? '').trim();
      if (answer !== snapshot.alias) throw new Error('The alias did not match. Nothing was deleted.');

      if (browserSessions && typeof browserSessions.close === 'function') {
        try {
          await browserSessions.close(snapshot.id);
        } catch (error) {
          if (error?.code === 'PROFILE_IN_USE') {
            throw new OperationError(
              'PROFILE_IN_USE',
              `${error.message} The profile and its local secrets were not removed.`,
              { safeDetails: { profileId: snapshot.id, reason: 'removal_requires_owner_close' } },
            );
          }
          // Other close failures are local cleanup problems; the explicit removal can continue
          // without deleting browser files, which are left in place below.
        }
      }
      await registry.remove(snapshot.id, { approved: true });
      const cleared = [];
      for (const secretName of SECRET_NAMES) {
        try {
          await secretStore.delete(secretStore.ref(snapshot.id, secretName));
          cleared.push(secretName);
        } catch {
          // Missing entries are already the desired state.
        }
      }
      const result = {
        removed: true,
        profile: snapshot.alias,
        localSecretsCleared: cleared,
        browserFilesKept: `${services.homeDir ?? '<home>'}/profiles/${snapshot.id}/browser`,
      };
      if (options.json) {
        write(JSON.stringify(result, null, 2));
        return;
      }
      write(cleared.length > 0
        ? `Removed profile "${snapshot.alias}". Local OS-store secrets cleared: ${cleared.join(', ')}.`
        : `Removed profile "${snapshot.alias}". No local OS-store secrets were present (or the store was unavailable).`);
      write(`Browser profile files, if any, were left in place: ${result.browserFilesKept}`);
    });
}

// The approvals module speaks its own settings vocabulary: confirmation policies are
// {global, perAction} strings, and stored-password login lives under browser.passwordLoginEnabled.
// The profile registry speaks per-tool booleans plus a passwordLoginEnabled flag. Convert at this
// boundary so a proposal is always validated and hashed in the canonical settings shape.
function approvalConfirmationsFrom(confirmations) {
  const policy = { perAction: {} };
  for (const [key, value] of Object.entries(confirmations ?? {})) {
    const mode = value === true || value === 'on' ? 'on' : 'off';
    if (key === 'global') policy.global = mode;
    else policy.perAction[key] = mode;
  }
  return policy;
}

function proposalPatchFor(patch) {
  const proposal = {};
  if (patch.confirmations !== undefined) proposal.confirmations = approvalConfirmationsFrom(patch.confirmations);
  if (patch.passwordLoginEnabled === true) proposal.browser = { passwordLoginEnabled: true };
  return proposal;
}

// Security classification over the profile-shaped patch. Only changing confirmation policy or
// enabling stored-password login is security-sensitive; everything else is operational.
function securityClassificationFor(patch) {
  const keys = Object.keys(patch).sort();
  const securityKeys = [];
  if (patch.confirmations !== undefined) securityKeys.push('confirmations');
  if (patch.passwordLoginEnabled === true) securityKeys.push('browser.passwordLoginEnabled');
  const classification = securityKeys.length > 0 ? 'security' : 'operational';
  // Validate the canonical shape before anything is written or proposed.
  const proposalPatch = proposalPatchFor(patch);
  if (Object.keys(proposalPatch).length > 0) classifySettingsPatch(proposalPatch);
  return Object.freeze({ classification, keys: Object.freeze(keys), securityKeys: Object.freeze(securityKeys) });
}

// Translate an approved canonical settings patch into what this registry can actually store. Runtime
// settings (safe mode, retry budget, footer, sampling, per-call backend preference) belong to the
// environment or harness, not a profile record, so they are reported instead of silently discarded.
function profilePatchFromSettings(canonical, snapshot) {
  const patch = {};
  const notApplied = [];
  for (const [key, value] of Object.entries(canonical ?? {})) {
    if (key === 'confirmations') {
      const merged = { ...(snapshot.confirmations ?? {}) };
      for (const [tool, mode] of Object.entries(value?.perAction ?? {})) {
        merged[tool] = mode === 'on' || mode === true;
      }
      if (value?.global !== undefined) merged.global = value.global === 'on' || value.global === true;
      patch.confirmations = merged;
    } else if (key === 'browser') {
      if (typeof value?.passwordLoginEnabled === 'boolean') patch.passwordLoginEnabled = value.passwordLoginEnabled;
      if (value?.enabled !== undefined) notApplied.push('browser.enabled');
    } else if (key === 'visibility') {
      // The canonical vocabulary says "hidden"; a stored profile calls that "headless".
      patch.visibility = value === 'hidden' ? 'headless' : value;
    } else if (key === 'enabledBackends') {
      patch.enabledBackends = [...value];
    } else {
      notApplied.push(key);
    }
  }
  return { patch, notApplied };
}

// Applies an approved MCP-originated settings proposal. The approval is consumed first so it is
// single-use, mirroring the write boundary; the registry update then revalidates the generation.
async function applyApprovedSettings(services, pending) {
  const { approvals, registry } = services;
  if (!registry || typeof registry.snapshot !== 'function' || typeof registry.update !== 'function') {
    throw new Error('A settings proposal needs a profile registry to apply to.');
  }
  const snapshot = await registry.snapshot(pending.profileId);
  const expectedPolicy = Number.isInteger(pending.policyGeneration)
    ? pending.policyGeneration
    : snapshot.policyGeneration;
  if (snapshot.policyGeneration !== expectedPolicy) {
    throw new OperationError(
      'POLICY_CHANGED',
      'The profile policy changed after this proposal was created; nothing was applied. Create a new proposal.',
    );
  }
  await approvals.consume(pending.binding);
  const { patch, notApplied } = profilePatchFromSettings(pending.patch, snapshot);
  const applied = Object.keys(patch);
  if (applied.length === 0) {
    return { profile: snapshot.alias, applied, notApplied };
  }
  const updated = await registry.update(snapshot.id, patch, { expectedGeneration: snapshot.generation });
  return { profile: updated.alias, applied, notApplied };
}

// A settings change classified as security is proposed, bound to this profile and patch, shown with
// its risks, approved by a trusted local prompt, and then consumed so it cannot be replayed.
async function approveSettingsPatchLocally(deps, services, snapshot, patch, classification = null) {
  const change = classification ?? securityClassificationFor(patch);
  const { approvals } = services;
  if (!isInteractive(deps)) {
    throw new Error('Changing the confirmation policy or stored-password login needs an interactive local approval. Nothing was changed.');
  }
  if (!approvals || typeof approvals.propose !== 'function') {
    throw new OperationError('APPROVAL_REQUIRED', 'This change needs a local approval store, and none is configured.');
  }
  const accountKey = approvalAccountKeyFor(snapshot) ?? `profile:${snapshot.id}`;
  const proposal = await approvals.propose({
    profileId: snapshot.id,
    accountKey,
    tool: 'settings',
    policyGeneration: Number.isInteger(snapshot.policyGeneration) ? snapshot.policyGeneration : 0,
  }, proposalPatchFor(patch));
  const write = out(deps);
  write(`Security settings change for profile "${snapshot.alias}" (${change.classification}).`);
  write(`Settings: ${change.keys.join(', ')}`);
  for (const risk of proposal.risks ?? []) write(`Risk: ${risk}`);
  const result = await approvals.approveLocally(proposal.id, {
    prompt: async () => {
      const answer = await deps.promptApproval({
        id: proposal.id,
        kind: proposal.kind,
        tool: 'settings',
        profileId: snapshot.id,
        classification: proposal.classification,
        keys: proposal.keys,
        patch: proposal.patch,
        risks: proposal.risks,
      });
      return answer === true || (answer && answer.approved === true);
    },
  });
  if (result.status !== 'approved') throw new Error('The settings change was declined. Nothing was changed.');
  await approvals.consume(proposal.binding);
  return result;
}

// ---- real services for the command line -------------------------------------------------------

// Builds the shared service graph lazily, so --help, offline commands, and dry runs never touch the
// OS keychain, a browser, or the profile registry. The dispatcher is the single execution path for
// reads and writes; profile management uses the same registry, approval store, and secret store.
export function createCliServices({
  env = process.env,
  keyring = undefined,
  fetch = globalThis.fetch,
  clock = () => Date.now(),
  browserSessions = undefined,
  loadPlaywright = undefined,
  createBrowserSessions = true,
  leases = undefined,
} = {}) {
  let instances = null;
  let settings = null;

  function runtime() {
    if (!settings) settings = readRuntimeSettings(env);
    return settings;
  }

  function build() {
    const base = runtime();
    const homeDir = isAbsolute(base.homeDir) ? base.homeDir : resolvePath(base.homeDir);
    const resolved = Object.freeze({ ...base, homeDir });
    const registry = createProfileRegistry({ homeDir });
    const accounts = createAccountRegistry({ registry });
    const approvals = createApprovalStore({ homeDir, clock });
    const secretStore = createProfileSecretStore({ keyring });
    // Process-scope task registry shared by the session manager and the dispatcher, so a browser
    // operation in progress blocks an idle/close teardown and is visible to browser status.
    const tasks = createBrowserTasks({ clock });
    let sessions = browserSessions;
    if (sessions === undefined && createBrowserSessions) {
      sessions = createBrowserSessionManager({
        registry,
        accounts,
        secretStore,
        settings: resolved,
        clock,
        tasks,
        ...(loadPlaywright !== undefined ? { loadPlaywright } : {}),
        ...(leases !== undefined ? { leases } : {}),
      });
    }
    const rawDispatcher = createDispatcher({
      registry,
      accounts,
      approvals,
      secretStore,
      browserSessions: sessions ?? null,
      settings: resolved,
      env,
      fetch,
      clock,
      tasks,
    });
    // The CLI always constructs a registry, so the dispatcher's legacy fallback check cannot tell
    // "no profiles at all" from "profiles without a default". Restore the old, actionable
    // environment error when nothing is selected and the environment itself is not configured.
    const legacyErrorFor = async (error, explicitProfile) => {
      if (explicitProfile !== null && explicitProfile !== undefined) return error;
      if (error?.code !== 'PROFILE_REQUIRED') return error;
      const profiles = await registry.list().catch(() => null);
      if (profiles === null || profiles.length > 0) return error;
      try {
        readLegacyApiConfig(env);
        return error;
      } catch (legacyError) {
        return legacyError;
      }
    };
    const dispatcher = Object.freeze({
      async execute(tool, args, options) {
        try {
          return await rawDispatcher.execute(tool, args, options);
        } catch (error) {
          throw await legacyErrorFor(error, options?.profile ?? null);
        }
      },
      async executeRaw(args, options) {
        try {
          return await rawDispatcher.executeRaw(args, options);
        } catch (error) {
          throw await legacyErrorFor(error, options?.profile ?? null);
        }
      },
      async status(selector) {
        try {
          return await rawDispatcher.status(selector);
        } catch (error) {
          throw await legacyErrorFor(error, selector ?? null);
        }
      },
      async pendingAttempts(selector) {
        try {
          return await rawDispatcher.pendingAttempts(selector);
        } catch (error) {
          throw await legacyErrorFor(error, selector ?? null);
        }
      },
      async resolveAttempt(selector, attemptId, resolution) {
        try {
          return await rawDispatcher.resolveAttempt(selector, attemptId, resolution);
        } catch (error) {
          throw await legacyErrorFor(error, selector ?? null);
        }
      },
      closeProfile: (selector) => rawDispatcher.closeProfile(selector),
      close: () => rawDispatcher.close(),
    });
    return Object.freeze({
      homeDir,
      env,
      settings: resolved,
      registry,
      accounts,
      approvals,
      secretStore,
      browserSessions: sessions ?? null,
      tasks,
      dispatcher,
    });
  }

  return Object.freeze({
    settings: runtime,
    get() {
      if (!instances) instances = build();
      return instances;
    },
  });
}

export const CLI_BACKEND_MODES = BACKEND_MODES;
export const CLI_VISIBILITIES = VISIBILITIES;
