// Browser CLI commands: read-only doctor, explicit-only setup through the injected doctor runner,
// and manual enrollment. No Playwright import, download, browser launch, or real profile is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { addBrowserCommands } from '../src/cli-browser.js';
import { readRuntimeSettings } from '../src/config.js';
import { createProfileRegistry } from '../src/profiles.js';

function doctorStatus(overrides = {}) {
  return {
    ok: false,
    code: 'BROWSER_DEPENDENCY_MISSING',
    state: 'dependencies_missing',
    channel: 'chromium',
    platform: 'win32',
    installed: false,
    ready: false,
    pinnedVersion: '1.64.1',
    package: { installed: false, version: null, reason: 'not_installed' },
    binary: { installed: false, pathKnown: false, reason: null },
    profile: { provided: false, id: null, alias: null, exists: null, metadata: {} },
    hints: ['Playwright is an optional peer dependency and is not installed.'],
    commands: ['npm install --no-save --package-lock=false playwright@1.64.1', 'npx playwright install chromium'],
    ...overrides,
  };
}

async function harness({ interactive = true, doctor, setup, enroll } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'reddit-cli-browser-'));
  const settings = readRuntimeSettings({ REDDIT_CLI_HOME: home });
  const registry = createProfileRegistry({ homeDir: home });
  const lines = [];
  const questions = [];
  const doctorCalls = [];
  const setupCalls = [];
  const enrollCalls = [];
  const browserSessions = {
    async enroll(snapshot, options) {
      enrollCalls.push({ snapshot, options });
      if (enroll) return await enroll(snapshot, options);
      return {
        profileId: snapshot.id,
        state: 'waiting_for_login',
        visibility: options?.visibility ?? 'visible',
        instructions: ['Sign in to the expected Reddit account in the visible browser window, then run enrollment again.'],
      };
    },
  };
  const deps = {
    services: () => ({ registry, browserSessions, settings, homeDir: home }),
    settings: () => settings,
    out: (line) => lines.push(String(line)),
    err: (line) => lines.push(String(line)),
    interactive: () => interactive,
    askText: async (question) => {
      questions.push(question);
      return 'y';
    },
    doctor: async (options) => {
      doctorCalls.push(options);
      return doctor ? await doctor(options) : doctorStatus();
    },
    setup: async (options) => {
      setupCalls.push(options);
      if (setup) return await setup(options);
      return {
        ok: true,
        code: null,
        skipped: !options.installPackage && !options.installBrowser,
        requested: { package: options.installPackage === true, browser: options.installBrowser === true },
        performed: [],
        failedAt: null,
        pinnedVersion: '1.64.1',
        platform: 'win32',
        hints: [],
        commands: [],
      };
    },
  };
  const cleanup = () => rm(home, { recursive: true, force: true });
  return { home, settings, registry, deps, lines, questions, doctorCalls, setupCalls, enrollCalls, cleanup };
}

function programFor(deps) {
  const program = new Command().name('t');
  program.exitOverride();
  addBrowserCommands(program, deps);
  return program;
}

async function run(deps, args) {
  return await programFor(deps).parseAsync(['node', 't', ...args]);
}

test('browser doctor reports readiness, commands, and hints without installing anything', async () => {
  const previous = process.exitCode;
  const h = await harness();
  try {
    process.exitCode = 0;
    await run(h.deps, ['browser', 'doctor']);
    assert.equal(h.doctorCalls.length, 1);
    assert.equal(h.setupCalls.length, 0);
    assert.ok(h.lines.some((line) => line.includes('not ready')));
    assert.ok(h.lines.some((line) => line.includes('BROWSER_DEPENDENCY_MISSING')));
    assert.ok(h.lines.some((line) => /never installs/i.test(line)));
    assert.equal(process.exitCode, 1);
    assert.deepEqual(await h.registry.list(), []);
  } finally {
    process.exitCode = previous;
    await h.cleanup();
  }
});

test('browser doctor --json prints the full report and --profile resolves profile metadata', async () => {
  const previous = process.exitCode;
  const h = await harness({ doctor: async (options) => doctorStatus({
    ok: true,
    code: null,
    state: 'ready',
    installed: true,
    ready: true,
    package: { installed: true, version: '1.64.1', reason: null },
    binary: { installed: true, pathKnown: true, reason: null },
    profile: { provided: true, id: options.profile?.id ?? null, alias: options.profile?.alias ?? null, exists: true, metadata: {} },
  }) });
  try {
    await h.registry.add({ alias: 'alice' });
    await run(h.deps, ['browser', 'doctor', '--profile', 'alice', '--json']);
    const report = JSON.parse(h.lines.join('\n'));
    assert.equal(report.ok, true);
    assert.equal(report.profile.alias, 'alice');
    assert.equal(h.setupCalls.length, 0);
    assert.ok(process.exitCode === previous || process.exitCode === 0);
  } finally {
    process.exitCode = previous;
    await h.cleanup();
  }
});

test('browser doctor with an unknown profile does not fall back to an install or anonymous run', async () => {
  const h = await harness();
  try {
    await assert.rejects(run(h.deps, ['browser', 'doctor', '--profile', 'missing']), /No profile matches/);
    assert.equal(h.doctorCalls.length, 0);
    assert.equal(h.setupCalls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('browser setup with no flags runs nothing and says so', async () => {
  const h = await harness();
  try {
    await run(h.deps, ['browser', 'setup']);
    assert.equal(h.setupCalls.length, 1);
    assert.deepEqual(h.setupCalls[0], { installPackage: false, installBrowser: false });
    assert.ok(h.lines.some((line) => line.includes('nothing ran')));
    assert.equal(h.questions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('browser setup refuses implicit installs in a non-interactive shell without --yes', async () => {
  const h = await harness({ interactive: false });
  try {
    await assert.rejects(
      run(h.deps, ['browser', 'setup', '--install-package']),
      /needs --yes/,
    );
    assert.equal(h.setupCalls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('browser setup runs only the explicitly requested steps through the injected runner', async () => {
  const h = await harness({
    interactive: false,
    setup: async (options) => ({
      ok: true,
      requested: { package: options.installPackage, browser: options.installBrowser },
      performed: [
        { kind: 'package', command: 'npm', args: ['install', 'playwright@1.64.1'], status: 0, timedOut: false },
      ],
      failedAt: null,
      hints: ['Only the explicitly requested setup steps were run.'],
    }),
  });
  try {
    await run(h.deps, ['browser', 'setup', '--install-package', '--version', '1.64.1', '--yes']);
    assert.equal(h.setupCalls.length, 1);
    assert.deepEqual(h.setupCalls[0], { installPackage: true, installBrowser: false, version: '1.64.1' });
    assert.ok(h.lines.some((line) => line.includes('package: npm install playwright@1.64.1')));
    assert.equal(h.questions.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('browser setup asks for confirmation interactively and stops when declined', async () => {
  const h = await harness({ interactive: true });
  try {
    h.deps.askText = async (question) => {
      h.questions.push(question);
      return 'n';
    };
    await assert.rejects(run(h.deps, ['browser', 'setup', '--install-browser']), /Cancelled/);
    assert.equal(h.setupCalls.length, 0);
    assert.equal(h.questions.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('browser login opens a visible profile by default and reports manual instructions', async () => {
  const h = await harness();
  try {
    const record = await h.registry.add({ alias: 'alice' });
    await run(h.deps, ['browser', 'login', 'alice']);
    assert.equal(h.enrollCalls.length, 1);
    assert.equal(h.enrollCalls[0].snapshot.id, record.id);
    assert.deepEqual(h.enrollCalls[0].options, { visibility: 'visible' });
    assert.ok(h.lines.some((line) => line.includes('waiting_for_login')));
    assert.ok(h.lines.some((line) => line.includes('Sign in')));
  } finally {
    await h.cleanup();
  }
});

test('browser login honors an explicit visibility and --json', async () => {
  const h = await harness({
    enroll: async (snapshot, options) => ({
      profileId: snapshot.id,
      state: 'ready',
      visibility: options.visibility,
      identity: { username: 'alice' },
      instructions: [],
    }),
  });
  try {
    await h.registry.add({ alias: 'alice' });
    await run(h.deps, ['browser', 'login', 'alice', '--visibility', 'headless', '--json']);
    assert.deepEqual(h.enrollCalls[0].options, { visibility: 'headless' });
    const report = JSON.parse(h.lines.join('\n'));
    assert.equal(report.state, 'ready');
  } finally {
    await h.cleanup();
  }
});
