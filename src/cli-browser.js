// Browser doctor, explicit setup, and manual enrollment for the local CLI.
//
// Doctor is read-only: it reports whether Playwright and a browser binary are present, and prints the
// exact commands a person can run. Setup runs only the steps named by explicit flags and only through
// the injected doctor runner; nothing here downloads anything implicitly, and an MCP call never
// reaches this module.
//
// Enrollment opens a visible dedicated profile so the person signs in themselves. The command never
// types a password, solves a challenge, or reads cookies. A password login exists only as an opted-in
// recovery path in the session manager, never as an argument to this command.

import { PINNED_PLAYWRIGHT_VERSION, TOOL_PACKAGE_ROOT } from './browser/doctor.js';

function out(deps) {
  return deps.out ?? ((line) => console.log(line));
}

function isInteractive(deps) {
  if (typeof deps.interactive === 'function') return deps.interactive() === true;
  if (typeof deps.interactive === 'boolean') return deps.interactive;
  return process.stdin.isTTY === true;
}

function requireServices(deps) {
  if (typeof deps.services !== 'function') throw new TypeError('CLI dependencies must expose services().');
  const services = deps.services();
  if (!services || typeof services !== 'object') throw new TypeError('CLI services are not configured.');
  return services;
}

async function defaultDoctor(options) {
  const { browserDoctor } = await import('./browser/doctor.js');
  return await browserDoctor(options);
}

async function defaultSetup(options) {
  const { setupBrowser } = await import('./browser/doctor.js');
  return await setupBrowser(options);
}

async function profileForDoctor(deps, alias) {
  if (alias === undefined || alias === null) return undefined;
  const { registry } = requireServices(deps);
  return await registry.snapshot(alias);
}

export function addBrowserCommands(program, deps) {
  const write = out(deps);
  const browser = program
    .command('browser')
    .description('Check or set up the optional local Playwright browser, and enroll a profile by hand');

  browser
    .command('doctor')
    .description('Report Playwright and browser readiness; installs and downloads nothing')
    .option('--profile <name>', 'include one profile non-secret metadata in the report')
    .option('--json', 'print the full doctor report')
    .action(async (options) => {
      const settings = typeof deps.settings === 'function' ? deps.settings() : {};
      const profile = await profileForDoctor(deps, options.profile);
      const doctor = deps.doctor ?? defaultDoctor;
      const status = await doctor({ settings, profile });
      if (options.json) {
        write(JSON.stringify(status, null, 2));
      } else {
        write(`Browser backend: ${status.ok ? 'ready' : 'not ready'} (${status.state}${status.code ? `, ${status.code}` : ''})`);
        if (status.profile?.provided) {
          write(`Profile: ${status.profile.alias ?? status.profile.id ?? '(unknown)'}`);
        }
        write(`Pinned Playwright: ${status.pinnedVersion ?? PINNED_PLAYWRIGHT_VERSION}`);
        write(`Package installed: ${status.package?.installed ? 'yes' : 'no'}`
          + `${status.package?.version ? ` (${status.package.version})` : ''}`
          + `${status.package?.reason ? ` [${status.package.reason}]` : ''}`);
        write(`Browser binary: ${status.binary?.installed ? 'present' : 'missing'}`
          + `${status.binary?.reason ? ` [${status.binary.reason}]` : ''}`);
        for (const hint of status.hints ?? []) write(`- ${hint}`);
        for (const command of status.commands ?? []) write(`  ${command}`);
        write('Doctor never installs or downloads anything. Use "browser setup" with explicit flags when you want that.');
      }
      if (!status.ok) process.exitCode = 1;
    });

  browser
    .command('setup')
    .description('Explicitly install the Playwright package and/or browser in this tool directory')
    .option('--install-package', 'run the pinned npm install for Playwright')
    .option('--install-browser', 'run the Playwright browser installer')
    .option('--version <version>', 'exact Playwright version to install')
    .option('--yes', 'confirm the explicit local install without a prompt')
    .option('--json', 'print the setup report')
    .action(async (options) => {
      const installPackage = options.installPackage === true;
      const installBrowser = options.installBrowser === true;
      const setup = deps.setup ?? defaultSetup;
      if (!installPackage && !installBrowser) {
        const report = await setup({ installPackage: false, installBrowser: false });
        if (options.json) {
          write(JSON.stringify(report, null, 2));
          return;
        }
        write('No setup steps were requested, so nothing ran. Re-run with --install-package and/or --install-browser.');
        return;
      }
      if (!isInteractive(deps) && options.yes !== true) {
        throw new Error('Browser setup needs --yes in a non-interactive shell. Nothing was installed.');
      }
      if (options.yes !== true) {
        const answer = await deps.askText(
          `Install into ${TOOL_PACKAGE_ROOT}? This runs npm/npx locally and downloads what Playwright needs. [y/N] `,
        );
        if (!/^y(es)?$/i.test(String(answer ?? '').trim())) throw new Error('Cancelled. Nothing was installed.');
      }
      const report = await setup({
        installPackage,
        installBrowser,
        ...(options.version !== undefined ? { version: options.version } : {}),
      });
      if (options.json) {
        write(JSON.stringify(report, null, 2));
      } else {
        write(`Setup ${report.ok ? 'completed' : 'stopped'} (requested: ${Object.entries(report.requested ?? {})
          .filter(([, value]) => value).map(([key]) => key).join(', ') || 'none'}).`);
        for (const step of report.performed ?? []) {
          write(`  ${step.kind}: ${step.command} ${step.args.join(' ')} -> ${step.status ?? 'no status'}${step.timedOut ? ' (timed out)' : ''}`);
        }
        for (const hint of report.hints ?? []) write(`- ${hint}`);
      }
      if (!report.ok) process.exitCode = 1;
    });

  browser
    .command('login <name>')
    .description('Open a visible dedicated browser profile so you can sign in by hand')
    .option('--visibility <mode>', 'visible, headless, or ask', 'visible')
    .option('--json', 'print the enrollment result')
    .action(async (name, options) => {
      const services = requireServices(deps);
      const { registry, browserSessions } = services;
      if (!browserSessions || typeof browserSessions.enroll !== 'function') {
        throw new Error('The browser session manager is not available in this installation. Nothing was opened.');
      }
      const snapshot = await registry.snapshot(name);
      const result = await browserSessions.enroll(snapshot, { visibility: options.visibility });
      if (options.json) {
        write(JSON.stringify(result, null, 2));
        return;
      }
      write(`Profile "${snapshot.alias}" enrollment: ${result.state}`);
      for (const instruction of result.instructions ?? []) write(`- ${instruction}`);
      if (result.identity?.username) write(`Signed in as u/${result.identity.username}.`);
    });
}
