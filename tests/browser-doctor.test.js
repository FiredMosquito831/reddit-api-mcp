import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  browserDoctor,
  setupBrowser,
  buildSetupSpawnPlan,
  PINNED_PLAYWRIGHT_VERSION,
  DEFAULT_SETUP_TIMEOUT_MS,
  TOOL_PACKAGE_ROOT,
} from '../src/browser/doctor.js';

const SECRET_PATH = 'C:/secret/user-data/chromium.exe';
const DOCTOR_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'browser', 'doctor.js');

function missingModule() {
  const error = new Error("Cannot find package 'playwright' imported from nowhere");
  error.code = 'ERR_MODULE_NOT_FOUND';
  return error;
}

function fakePlaywright({ version = '1.64.1', executablePath = () => SECRET_PATH } = {}) {
  return {
    version,
    chromium: { executablePath },
  };
}

const existsWhen = (target) => ({ existsSync: (path) => path === target });
const existsNever = { existsSync: () => false };

test('pinned version matches the declared playwright peer range', () => {
  const pkg = JSON.parse(readFileSync(join(TOOL_PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.peerDependencies.playwright, /^\^?1\.64\.1$/);
  assert.equal(PINNED_PLAYWRIGHT_VERSION, '1.64.1');
});

test('missing package is reported as BROWSER_DEPENDENCY_MISSING without throwing', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
  });

  assert.equal(status.ok, false);
  assert.equal(status.code, 'BROWSER_DEPENDENCY_MISSING');
  assert.equal(status.state, 'dependencies_missing');
  assert.equal(status.installed, false, 'top-level installed means the package is present');
  assert.equal(status.ready, false);
  assert.equal(status.package.installed, false);
  assert.equal(status.package.version, null);
  assert.equal(status.binary.installed, false);
  assert.ok(status.hints.length > 0);
  assert.ok(status.hints.some((hint) => /optional/i.test(hint)));
  assert.ok(status.commands.some((command) => /npm install .*playwright@/.test(command)));
});

test('an unexpected import failure is still dependency missing but labeled import_failed', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => { throw new Error('boom with internal stack details'); },
    fs: existsNever,
  });

  assert.equal(status.code, 'BROWSER_DEPENDENCY_MISSING');
  assert.equal(status.package.reason, 'import_failed');
  assert.equal(status.installed, false);
  assert.ok(!JSON.stringify(status).includes('internal stack details'));
});

test('installed package with a missing browser binary is BROWSER_BINARY_MISSING', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: existsNever,
  });

  assert.equal(status.ok, false);
  assert.equal(status.ready, false);
  assert.equal(status.code, 'BROWSER_BINARY_MISSING');
  assert.equal(status.state, 'binary_missing');
  assert.equal(status.installed, true, 'the package is installed even though the browser is not');
  assert.equal(status.package.installed, true);
  assert.equal(status.package.version, '1.64.1');
  assert.equal(status.binary.installed, false);
  assert.ok(status.commands.some((command) => /playwright install/.test(command)));
  assert.ok(status.hints.some((hint) => /binary/i.test(hint)));
});

test('ready status never exposes the binary path', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: existsWhen(SECRET_PATH),
  });

  assert.equal(status.ok, true);
  assert.equal(status.ready, true);
  assert.equal(status.installed, true);
  assert.equal(status.code, null);
  assert.equal(status.state, 'ready');
  assert.equal(status.binary.installed, true);
  assert.equal(status.binary.pathKnown, true);
  assert.equal(Object.hasOwn(status.binary, 'path'), false);
  assert.ok(!JSON.stringify(status).includes(SECRET_PATH));
  assert.ok(!JSON.stringify(status).includes('chromium.exe'));
});

test('executablePath is consulted and existence checked with the returned path', async () => {
  let seenPath = null;
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: { existsSync: (path) => { seenPath = path; return true; } },
  });

  assert.equal(seenPath, SECRET_PATH);
  assert.equal(status.binary.installed, true);
});

test('an executablePath failure is reported as BROWSER_BINARY_MISSING', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright({ executablePath: () => { throw new Error(SECRET_PATH); } }),
    fs: existsNever,
  });

  assert.equal(status.code, 'BROWSER_BINARY_MISSING');
  assert.equal(status.binary.reason, 'executable_path_failed');
  assert.equal(status.installed, true);
  assert.equal(status.ready, false);
  assert.ok(!JSON.stringify(status).includes(SECRET_PATH));
});

test('a filesystem probe that throws is reported safely as BROWSER_BINARY_MISSING', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: { existsSync: () => { throw new Error(`probe failed at ${SECRET_PATH}`); } },
  });

  assert.equal(status.code, 'BROWSER_BINARY_MISSING');
  assert.equal(status.binary.reason, 'check_failed');
  assert.equal(status.installed, true);
  assert.equal(status.ready, false);
  assert.ok(!JSON.stringify(status).includes(SECRET_PATH));
});

test('an unsupported channel is reported distinctly', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: existsWhen(SECRET_PATH),
    channel: 'firefox',
  });

  assert.equal(status.ok, false);
  assert.equal(status.code, 'BROWSER_CHANNEL_UNSUPPORTED');
  assert.equal(status.state, 'channel_unsupported');
  assert.equal(status.installed, true);
  assert.ok(status.hints.some((hint) => /firefox/.test(hint)));
});

test('an async exists function is supported', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: async (path) => path === SECRET_PATH,
  });

  assert.equal(status.binary.installed, true);
});

test('invalid doctor options are rejected with INVALID_DOCTOR_OPTIONS', async () => {
  await assert.rejects(
    browserDoctor({ loadPlaywright: 'not-a-function' }),
    (error) => error.code === 'INVALID_DOCTOR_OPTIONS',
  );
  await assert.rejects(
    browserDoctor({ channel: '' }),
    (error) => error.code === 'INVALID_DOCTOR_OPTIONS',
  );
  await assert.rejects(
    browserDoctor({ version: '1.64.1 && rm -rf /' }),
    (error) => error.code === 'INVALID_DOCTOR_OPTIONS',
  );
});

test('profile snapshot is read from flat top-level fields, not nested metadata', async () => {
  const snapshot = {
    id: 'work',
    alias: 'Work profile',
    expectedUsername: 'private-account',
    accountKey: 'SECRET_ACCOUNT_KEY',
    accountId: 'SECRET_ACCOUNT_ID',
    generation: 7,
    credentialGeneration: 3,
    policyGeneration: 2,
    enabledBackends: ['api', 'browser'],
    backendPreference: 'browser',
    visibility: 'visible',
    passwordLoginEnabled: false,
    confirmations: { delete_post: 'required' },
    api: { clientId: 'SECRET_CLIENT_ID', secretRef: 'SECRET_REF' },
    metadata: { backend: 'nested-should-not-be-read' },
    cookie: 'session=SECRETCOOKIE',
    directory: 'C:/Users/private/AppData/profile',
  };

  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: existsWhen(SECRET_PATH),
    profile: snapshot,
  });

  const serialized = JSON.stringify(status);
  assert.equal(status.profile.provided, true);
  assert.equal(status.profile.id, 'work');
  assert.equal(status.profile.alias, 'Work profile');
  assert.equal(status.profile.metadata.generation, 7);
  assert.equal(status.profile.metadata.credentialGeneration, 3);
  assert.equal(status.profile.metadata.policyGeneration, 2);
  assert.deepEqual(status.profile.metadata.enabledBackends, ['api', 'browser']);
  assert.equal(status.profile.metadata.backendPreference, 'browser');
  assert.equal(status.profile.metadata.visibility, 'visible');
  assert.equal(status.profile.metadata.passwordLoginEnabled, false);
  assert.equal(Object.hasOwn(status.profile.metadata, 'backend'), false, 'nested metadata is not read');
  for (const key of ['expectedUsername', 'accountKey', 'accountId', 'confirmations', 'api']) {
    assert.equal(Object.hasOwn(status.profile.metadata, key), false, `${key} must not be exposed`);
  }
  assert.ok(!serialized.includes('SECRET'));
  assert.ok(!serialized.includes('private-account'));
  assert.ok(!serialized.includes('AppData'));
});

test('a string profile name is accepted', async () => {
  const status = await browserDoctor({
    loadPlaywright: async () => fakePlaywright(),
    fs: existsWhen(SECRET_PATH),
    profile: 'default',
  });

  assert.deepEqual(status.profile, { provided: true, id: 'default', alias: null, exists: null, metadata: {} });
});

test('doctor never invokes a runner and never installs', async () => {
  const calls = [];
  const status = await browserDoctor({
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
    runner: async (request) => { calls.push(request); return { status: 0 }; },
  });

  assert.equal(calls.length, 0);
  assert.equal(status.installed, false);
  assert.equal(status.ready, false);
  assert.equal(status.code, 'BROWSER_DEPENDENCY_MISSING');
});

test('pinned commands follow the platform and omit --with-deps on Windows', async () => {
  const win = await browserDoctor({
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
    platform: 'win32',
  });
  assert.ok(win.commands.includes(`npm install --no-save --package-lock=false playwright@${PINNED_PLAYWRIGHT_VERSION}`));
  assert.ok(!win.commands.some((command) => command.includes('--save-optional')));
  assert.ok(win.commands.includes('npx playwright install chromium'));
  assert.ok(!win.commands.some((command) => command.includes('--with-deps')));
  assert.ok(win.hints.some((hint) => /--with-deps/.test(hint)));

  const linux = await browserDoctor({
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
    platform: 'linux',
  });
  assert.ok(linux.commands.includes(`npm install --no-save --package-lock=false playwright@${PINNED_PLAYWRIGHT_VERSION}`));
  assert.ok(linux.commands.includes('npx playwright install --with-deps chromium'));
});

test('the top-level version option pins the printed commands', async () => {
  const status = await browserDoctor({
    version: '1.62.3',
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
  });

  assert.equal(status.pinnedVersion, '1.62.3');
  assert.ok(status.commands.includes('npm install --no-save --package-lock=false playwright@1.62.3'));
});

test('settings may pin the Playwright version used by the printed commands', async () => {
  const status = await browserDoctor({
    settings: { playwrightVersion: '1.58.2' },
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
  });

  assert.equal(status.pinnedVersion, '1.58.2');
  assert.ok(status.commands.includes('npm install --no-save --package-lock=false playwright@1.58.2'));
});

test('an explicit version option wins over settings', async () => {
  const status = await browserDoctor({
    version: '1.64.1',
    settings: { playwrightVersion: '1.58.2' },
    loadPlaywright: async () => { throw missingModule(); },
    fs: existsNever,
  });

  assert.equal(status.pinnedVersion, '1.64.1');
});

test('importing the doctor module does not load playwright', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-import-'));
  try {
    const sentinel = join(dir, 'playwright-loaded.txt');
    writeFileSync(join(dir, 'resolve-hook.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      'export async function resolve(specifier, context, next) {',
      "  if (specifier === 'playwright') {",
      "    writeFileSync(process.env.DOCTOR_SENTINEL, 'loaded');",
      "    throw new Error('playwright must not load at import time');",
      '  }',
      '  return next(specifier, context);',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'register-hook.mjs'), [
      "import { register } from 'node:module';",
      "register(new URL('./resolve-hook.mjs', import.meta.url));",
      '',
    ].join('\n'));

    const script = `await import(${JSON.stringify(pathToFileURL(DOCTOR_FILE).href)}); console.log('imported');`;
    const result = spawnSync(process.execPath, [
      '--no-warnings',
      '--import', pathToFileURL(join(dir, 'register-hook.mjs')).href,
      '--input-type=module',
      '--eval', script,
    ], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, DOCTOR_SENTINEL: sentinel },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /imported/);
    assert.equal(spawnSentinelExists(sentinel), false, 'playwright was loaded eagerly by the import');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function spawnSentinelExists(sentinel) {
  try {
    readFileSync(sentinel);
    return true;
  } catch {
    return false;
  }
}

test('setup with no explicit flags does nothing and never runs a runner', async () => {
  const calls = [];
  const report = await setupBrowser({
    runner: async (request) => { calls.push(request); return { status: 0 }; },
  });

  assert.equal(calls.length, 0);
  assert.equal(report.ok, true);
  assert.equal(report.skipped, true);
  assert.deepEqual(report.performed, []);
  assert.ok(report.commands.length > 0);
});

test('setup only installs what the explicit boolean flags request', async () => {
  const calls = [];
  const runner = async (request) => { calls.push(request); return { status: 0 }; };

  const falsy = await setupBrowser({ installPackage: 'true', runner, platform: 'win32' });
  assert.equal(calls.length, 0);
  assert.equal(falsy.ok, true);

  const pkg = await setupBrowser({ installPackage: true, runner, platform: 'win32' });
  assert.equal(calls.length, 1);
  assert.equal(pkg.ok, true);
  assert.equal(pkg.performed.length, 1);
  assert.equal(pkg.performed[0].kind, 'package');
  assert.deepEqual(calls[0].args, ['install', '--no-save', '--package-lock=false', `playwright@${PINNED_PLAYWRIGHT_VERSION}`]);
  assert.equal(calls[0].cwd, TOOL_PACKAGE_ROOT);
  assert.equal(calls[0].timeoutMs, DEFAULT_SETUP_TIMEOUT_MS);

  calls.length = 0;
  const browser = await setupBrowser({ installBrowser: true, runner, platform: 'win32', version: '1.61.0' });
  assert.equal(calls.length, 1);
  assert.equal(browser.performed[0].kind, 'browser');
  assert.deepEqual(calls[0].args, ['playwright', 'install', 'chromium']);
  assert.equal(browser.pinnedVersion, '1.61.0');
  assert.equal(calls[0].cwd, TOOL_PACKAGE_ROOT);
});

test('setup installs the package before the browser and stops on failure', async () => {
  const calls = [];
  const report = await setupBrowser({
    installPackage: true,
    installBrowser: true,
    platform: 'linux',
    runner: async (request) => {
      calls.push(request);
      return { status: request.kind === 'package' ? 1 : 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'SETUP_FAILED');
  assert.equal(report.failedAt, 'package');
  assert.equal(report.performed[0].status, 1);
  assert.deepEqual(calls[0].args, ['install', '--no-save', '--package-lock=false', `playwright@${PINNED_PLAYWRIGHT_VERSION}`]);
});

test('setup reports a timeout as SETUP_FAILED without leaking runner details', async () => {
  const report = await setupBrowser({
    installBrowser: true,
    platform: 'linux',
    runner: async () => ({ status: null, timedOut: true }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.code, 'SETUP_FAILED');
  assert.equal(report.failedAt, 'browser');
  assert.equal(report.performed[0].timedOut, true);
  assert.ok(report.hints.some((hint) => /timed out/i.test(hint)));
});

test('setup reports a throwing runner safely without stack or secrets', async () => {
  const report = await setupBrowser({
    installBrowser: true,
    platform: 'linux',
    runner: async () => { throw new Error('spawn failed at C:/private/token'); },
  });

  assert.equal(report.ok, false);
  assert.equal(report.code, 'SETUP_FAILED');
  assert.equal(report.failedAt, 'browser');
  assert.ok(!JSON.stringify(report).includes('C:/private/token'));
  assert.ok(!JSON.stringify(report).includes('at Object'));
});

test('setup rejects an unsafe version string instead of building a command', async () => {
  let calls = 0;
  await assert.rejects(
    setupBrowser({ installPackage: true, version: '1.0.0 && rm -rf /', runner: async () => { calls += 1; return { status: 0 }; } }),
    (error) => error.code === 'INVALID_SETUP_OPTIONS',
  );
  assert.equal(calls, 0);
});

test('setup rejects a non-function runner', async () => {
  await assert.rejects(
    setupBrowser({ installPackage: true, runner: 'npm' }),
    (error) => error.code === 'INVALID_SETUP_OPTIONS',
  );
});

test('spawn plan uses the controlled tool package root and a bounded timeout', () => {
  const plan = buildSetupSpawnPlan({
    command: 'npm',
    args: ['install', '--no-save', '--package-lock=false', 'playwright@1.64.1'],
    platform: 'linux',
  });

  assert.equal(plan.command, 'npm');
  assert.deepEqual(plan.args, ['install', '--no-save', '--package-lock=false', 'playwright@1.64.1']);
  assert.equal(plan.cwd, TOOL_PACKAGE_ROOT);
  assert.equal(plan.timeoutMs, DEFAULT_SETUP_TIMEOUT_MS);
  assert.ok(Number.isInteger(DEFAULT_SETUP_TIMEOUT_MS) && DEFAULT_SETUP_TIMEOUT_MS > 0);
  assert.equal(plan.shell, false, 'no shell means no command injection surface');
  assert.equal(plan.windowsHide, true);
});

test('spawn plan on Windows runs npm/npx through node instead of a shell', () => {
  const npmPlan = buildSetupSpawnPlan({
    command: 'npm',
    args: ['install', '--no-save', '--package-lock=false', 'playwright@1.64.1'],
    platform: 'win32',
  });
  assert.equal(npmPlan.shell, false);
  assert.equal(npmPlan.command, process.execPath);
  assert.ok(npmPlan.args[0].endsWith('npm-cli.js'));
  assert.deepEqual(npmPlan.args.slice(1), ['install', '--no-save', '--package-lock=false', 'playwright@1.64.1']);

  const npxPlan = buildSetupSpawnPlan({
    command: 'npx',
    args: ['playwright', 'install', 'chromium'],
    platform: 'win32',
  });
  assert.equal(npxPlan.shell, false);
  assert.equal(npxPlan.command, process.execPath);
  assert.ok(npxPlan.args[0].endsWith('npx-cli.js'));
  assert.deepEqual(npxPlan.args.slice(1), ['playwright', 'install', 'chromium']);
});

test('spawn plan preserves arguments as an array so metadata cannot inject a command', () => {
  const malicious = 'playwright@1.64.1; rm -rf /';
  const plan = buildSetupSpawnPlan({
    command: 'npm',
    args: ['install', '--no-save', '--package-lock=false', malicious],
    platform: 'win32',
  });

  assert.equal(plan.shell, false);
  assert.equal(plan.args.at(-1), malicious);
  assert.equal(plan.args.filter((arg) => arg === malicious).length, 1);
  assert.ok(!plan.args.some((arg) => arg.includes('&&') || arg.includes('|')));
});

test('spawn plan rejects malformed input', () => {
  assert.throws(() => buildSetupSpawnPlan({ command: 'npm', args: 'install' }), TypeError);
  assert.throws(() => buildSetupSpawnPlan({ command: 'npm', args: ['x', 1] }), TypeError);
  assert.throws(() => buildSetupSpawnPlan({ command: 'npm', args: [], cwd: '' }), TypeError);
  assert.throws(() => buildSetupSpawnPlan({ command: 'npm', args: [], timeoutMs: 0 }), TypeError);
});
