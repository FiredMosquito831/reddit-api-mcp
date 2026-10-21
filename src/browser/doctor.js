// Optional Playwright dependency diagnostics and explicit local setup.
//
// This module is deliberately independent of the operation dispatcher and the rest of the runtime:
// it must be importable (and testable) when the foundation modules or the optional peer are absent.
// Playwright itself is only ever loaded through a caller-supplied loader or a dynamic import inside
// browserDoctor(); merely importing this module must not load it, and doctor never installs anything.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned to the declared optional peer range (`^1.64.1` in package.json). Doctor and setup print
// commands for exactly this version; this is a setup recommendation, not a claim that the version
// has been live-tested in this repository (see the plan's Task 9 Step 5).
export const PINNED_PLAYWRIGHT_VERSION = '1.64.1';

// The directory containing this tool's package.json. Derived from the module URL so agent-supplied
// input can never choose where npm installs: both the doctor command text and the default runner
// use this root. In a bundled extension this is the bundle root, which also holds package.json.
export const TOOL_PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// A bounded install/ browser-download window. Explicit setup never hangs forever, and doctor itself
// never starts a process at all.
export const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60 * 1000;

export const BROWSER_DOCTOR_CODES = Object.freeze([
  'BROWSER_DEPENDENCY_MISSING',
  'BROWSER_BINARY_MISSING',
  'BROWSER_CHANNEL_UNSUPPORTED',
  'INVALID_DOCTOR_OPTIONS',
  'INVALID_SETUP_OPTIONS',
  'SETUP_FAILED',
]);

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Safe, non-secret fields from a flat ProfileSnapshot. The snapshot exposes identifiers, secret
// references, and confirmation policy objects; none of those belong in a diagnostic result. There
// is no nested `metadata` object on a ProfileSnapshot, so only these top-level fields are copied.
const SAFE_PROFILE_FIELDS = new Set([
  'generation',
  'credentialGeneration',
  'policyGeneration',
  'enabledBackends',
  'backendPreference',
  'visibility',
  'passwordLoginEnabled',
]);

// An independent error type with a stable .code so callers do not have to import the dispatcher's
// error contract just to diagnose installation problems.
export class BrowserDoctorError extends Error {
  constructor(code, message, safeDetails = null) {
    super(String(message));
    this.name = 'BrowserDoctorError';
    this.code = code;
    this.safeDetails = safeDetails;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, safeDetails: this.safeDetails };
  }
}

function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return VERSION_RE.test(trimmed) ? trimmed : null;
}

function versionFromSettings(settings) {
  if (!settings || typeof settings !== 'object') return null;
  return normalizeVersion(settings.playwrightVersion);
}

function pinnedVersionFrom(version, settings) {
  return normalizeVersion(version) ?? versionFromSettings(settings) ?? PINNED_PLAYWRIGHT_VERSION;
}

function packageVersionFromDisk() {
  // Executed only after a successful dynamic import, and only as a best-effort fallback.
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('playwright/package.json');
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function isModuleNotFound(error) {
  const code = error?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  return /cannot find (?:package|module)/i.test(String(error?.message ?? ''));
}

function sanitizeProfile(profile) {
  if (profile === undefined || profile === null) {
    return { provided: false, id: null, alias: null, exists: null, metadata: {} };
  }

  if (typeof profile === 'string') {
    return { provided: true, id: profile, alias: null, exists: null, metadata: {} };
  }

  if (typeof profile !== 'object') {
    return { provided: false, id: null, alias: null, exists: null, metadata: {} };
  }

  const id = typeof profile.id === 'string' ? profile.id : null;
  const alias = typeof profile.alias === 'string' ? profile.alias : null;
  const exists = typeof profile.exists === 'boolean' ? profile.exists : null;
  const metadata = {};

  for (const key of SAFE_PROFILE_FIELDS) {
    if (!Object.hasOwn(profile, key)) continue;
    const value = profile[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      metadata[key] = [...value];
    }
  }

  return { provided: true, id, alias, exists, metadata };
}

function installCommands(version, platform) {
  const packageCommand = `npm install --no-save --package-lock=false playwright@${version}`;
  const browserArgs = platform === 'win32'
    ? ['playwright', 'install', 'chromium']
    : ['playwright', 'install', '--with-deps', 'chromium'];
  const browserCommand = `npx ${browserArgs.join(' ')}`;
  return { packageCommand, browserCommand, browserArgs };
}

async function pathExists(fs, path) {
  if (typeof fs === 'function') return Boolean(await fs(path));
  if (fs && typeof fs.existsSync === 'function') return Boolean(fs.existsSync(path));
  if (fs && typeof fs.exists === 'function') return Boolean(await fs.exists(path));
  throw new TypeError('A filesystem probe must be a function or expose existsSync/exists.');
}

export async function browserDoctor({
  settings = {},
  profile,
  loadPlaywright,
  fs = { existsSync },
  channel = 'chromium',
  platform = process.platform,
  version,
} = {}) {
  if (loadPlaywright !== undefined && typeof loadPlaywright !== 'function') {
    throw new BrowserDoctorError('INVALID_DOCTOR_OPTIONS', 'loadPlaywright must be a function.');
  }
  if (typeof channel !== 'string' || channel === '') {
    throw new BrowserDoctorError('INVALID_DOCTOR_OPTIONS', 'channel must be a non-empty string.');
  }
  if (version !== undefined && normalizeVersion(version) === null) {
    throw new BrowserDoctorError('INVALID_DOCTOR_OPTIONS', 'version must be an exact semantic version.');
  }

  const pinnedVersion = pinnedVersionFrom(version, settings);
  const { packageCommand, browserCommand } = installCommands(pinnedVersion, platform);

  const hints = [];
  const commands = [packageCommand, browserCommand];
  const status = {
    ok: false,
    code: null,
    state: 'unknown',
    channel,
    platform,
    // installed: the Playwright package itself imports. ready: package plus a usable browser binary.
    // Keeping them separate means a package-only install never reads as ready.
    installed: false,
    ready: false,
    pinnedVersion,
    package: { installed: false, version: null, reason: null },
    binary: { installed: false, pathKnown: false, reason: null },
    profile: sanitizeProfile(profile),
    hints,
    commands,
  };

  let playwright = null;
  try {
    const load = loadPlaywright ?? (() => import('playwright'));
    playwright = await load();
  } catch (error) {
    status.code = 'BROWSER_DEPENDENCY_MISSING';
    status.state = 'dependencies_missing';
    status.package.reason = isModuleNotFound(error) ? 'not_installed' : 'import_failed';
    hints.push('Playwright is an optional peer dependency and is not installed; API and RSS modes do not need it.');
    hints.push('Run the package command in the reddit-api-automation-mcp install directory, then run browser doctor again. Nothing is downloaded automatically.');
    hints.push('The pinned version shown is a setup recommendation, not a recorded live-tested version.');
    if (platform === 'win32') {
      hints.push('On Windows, do not pass --with-deps; install any required system component yourself.');
    }
    return status;
  }

  status.package.installed = true;
  status.installed = true;
  const diskVersion = packageVersionFromDisk();
  const reportedVersion = typeof playwright?.version === 'string'
    ? playwright.version
    : (typeof playwright?._version === 'string' ? playwright._version : diskVersion);
  status.package.version = reportedVersion ?? null;

  const browserType = playwright?.[channel];
  if (!browserType || typeof browserType.executablePath !== 'function') {
    status.code = 'BROWSER_CHANNEL_UNSUPPORTED';
    status.state = 'channel_unsupported';
    status.binary.reason = 'channel_unavailable';
    hints.push(`Playwright is installed but does not expose the requested ${channel} browser type.`);
    hints.push(`Use the "chromium" channel, or install a Playwright version that supports ${channel}.`);
    return status;
  }

  let executablePath = null;
  try {
    executablePath = await browserType.executablePath();
  } catch {
    status.code = 'BROWSER_BINARY_MISSING';
    status.state = 'binary_missing';
    status.binary.reason = 'executable_path_failed';
    hints.push('Playwright is installed but could not resolve the browser executable path.');
    hints.push('Run the browser install command explicitly; doctor never downloads it.');
    return status;
  }

  const pathIsUsable = typeof executablePath === 'string' && executablePath !== '';
  status.binary.pathKnown = pathIsUsable;
  let present = false;
  if (pathIsUsable) {
    try {
      present = await pathExists(fs, executablePath);
    } catch {
      status.code = 'BROWSER_BINARY_MISSING';
      status.state = 'binary_missing';
      status.binary.reason = 'check_failed';
      hints.push('Playwright resolved a browser path, but its presence could not be checked safely.');
      hints.push('Run the browser install command explicitly; doctor never downloads it.');
      return status;
    }
  }

  if (!present) {
    status.code = 'BROWSER_BINARY_MISSING';
    status.state = 'binary_missing';
    status.binary.reason = pathIsUsable ? 'not_found' : 'no_executable_path';
    hints.push(`Playwright is installed but the ${channel} browser binary is missing.`);
    hints.push('Run the browser install command explicitly; doctor never downloads it.');
    hints.push('The pinned version shown is a setup recommendation, not a recorded live-tested version.');
    return status;
  }

  status.ok = true;
  status.ready = true;
  status.code = null;
  status.state = 'ready';
  status.binary.installed = true;
  hints.push(`Playwright ${status.package.version ?? '(version unknown)'} and the ${channel} browser binary are installed.`);
  hints.push('Browser automation still requires an explicit local profile, a visible or headless choice, and a verified login.');
  hints.push('The pinned version shown is a setup recommendation, not a recorded live-tested version.');
  return status;
}

// Resolve a Windows npm/npx CLI script so the installer can run as `node <cli> ...` without a shell.
// Spawning a .cmd file directly is refused by modern Node, and `shell: true` would turn the argument
// list into a command string. These paths come from the running Node installation, never from input.
function windowsCliScript(command) {
  const script = command === 'npm'
    ? 'npm-cli.js'
    : (command === 'npx' ? 'npx-cli.js' : null);
  if (script === null) return null;
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', script);
  return existsSync(candidate) ? candidate : null;
}

// Build the exact spawn plan used by defaultRunner, exported so tests can verify the safety
// properties (controlled cwd, bounded timeout, no shell, argument array preserved) without running
// an installer. All arguments stay an array; nothing is concatenated into a shell string.
export function buildSetupSpawnPlan({
  command,
  args,
  platform = process.platform,
  cwd = TOOL_PACKAGE_ROOT,
  timeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
} = {}) {
  if (typeof command !== 'string' || command === '') {
    throw new TypeError('command must be a non-empty string.');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings.');
  }
  if (typeof cwd !== 'string' || cwd === '') {
    throw new TypeError('cwd must be a non-empty string.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer.');
  }

  let executable = command;
  let spawnArgs = [...args];
  if (platform === 'win32') {
    const cli = windowsCliScript(command);
    if (cli !== null) {
      executable = process.execPath;
      spawnArgs = [cli, ...args];
    }
  }

  return {
    command: executable,
    args: spawnArgs,
    cwd,
    timeoutMs,
    shell: false,
    windowsHide: true,
  };
}

export async function defaultRunner({
  command,
  args,
  platform = process.platform,
  cwd = TOOL_PACKAGE_ROOT,
  timeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
}) {
  let plan;
  try {
    plan = buildSetupSpawnPlan({ command, args, platform, cwd, timeoutMs });
  } catch {
    return { status: null, timedOut: false };
  }

  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // Killing a process that already exited is harmless.
      }
      finish({ status: null, timedOut: true });
    }, plan.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        shell: plan.shell,
        stdio: 'inherit',
        windowsHide: plan.windowsHide,
      });
    } catch {
      finish({ status: null, timedOut: false });
      return;
    }

    child.once('error', () => finish({ status: null, timedOut: false }));
    child.once('close', (code) => finish({
      status: typeof code === 'number' ? code : null,
      timedOut: false,
    }));
  });
}

export async function setupBrowser({
  installPackage = false,
  installBrowser = false,
  runner,
  version,
  platform = process.platform,
} = {}) {
  const pinnedVersion = normalizeVersion(version) ?? PINNED_PLAYWRIGHT_VERSION;
  if (version !== undefined && normalizeVersion(version) === null) {
    throw new BrowserDoctorError('INVALID_SETUP_OPTIONS', 'version must be an exact semantic version.');
  }
  if (runner !== undefined && typeof runner !== 'function') {
    throw new BrowserDoctorError('INVALID_SETUP_OPTIONS', 'runner must be a function.');
  }

  const { packageCommand, browserCommand, browserArgs } = installCommands(pinnedVersion, platform);
  const requested = {
    package: installPackage === true,
    browser: installBrowser === true,
  };
  const report = {
    ok: true,
    code: null,
    skipped: !requested.package && !requested.browser,
    requested,
    performed: [],
    failedAt: null,
    pinnedVersion,
    platform,
    cwd: TOOL_PACKAGE_ROOT,
    timeoutMs: DEFAULT_SETUP_TIMEOUT_MS,
    commands: [packageCommand, browserCommand],
    hints: [],
  };

  if (report.skipped) {
    report.hints.push('No setup steps requested; nothing was installed and no process was started.');
    report.hints.push('Re-run setup with an explicit package and/or browser flag to install locally.');
    return report;
  }

  const run = runner ?? defaultRunner;
  const steps = [];
  if (requested.package) {
    steps.push({
      kind: 'package',
      command: 'npm',
      args: ['install', '--no-save', '--package-lock=false', `playwright@${pinnedVersion}`],
    });
  }
  if (requested.browser) {
    steps.push({ kind: 'browser', command: 'npx', args: browserArgs });
  }

  for (const step of steps) {
    let result;
    try {
      result = await run({
        kind: step.kind,
        command: step.command,
        args: [...step.args],
        platform,
        cwd: TOOL_PACKAGE_ROOT,
        timeoutMs: DEFAULT_SETUP_TIMEOUT_MS,
      });
    } catch {
      result = { status: null, timedOut: false };
    }
    const rawStatus = result?.status ?? result?.code ?? null;
    const exitStatus = typeof rawStatus === 'number' ? rawStatus : null;
    const timedOut = result?.timedOut === true;
    report.performed.push({
      kind: step.kind,
      command: step.command,
      args: [...step.args],
      status: exitStatus,
      timedOut,
    });

    if (exitStatus !== 0) {
      report.ok = false;
      report.code = 'SETUP_FAILED';
      report.failedAt = step.kind;
      if (timedOut) {
        report.hints.push(`The ${step.kind} setup step timed out after ${DEFAULT_SETUP_TIMEOUT_MS} ms and was stopped.`);
      } else {
        report.hints.push(`The ${step.kind} setup step did not complete successfully.`);
      }
      report.hints.push('Nothing further was run; fix the reported problem and run setup again explicitly.');
      return report;
    }
  }

  report.hints.push('Only the explicitly requested setup steps were run.');
  report.hints.push(`The package was installed in the reddit-api-automation-mcp install directory (${TOOL_PACKAGE_ROOT}).`);
  if (platform === 'win32') {
    report.hints.push('On Windows, no --with-deps argument was used.');
  }
  return report;
}
