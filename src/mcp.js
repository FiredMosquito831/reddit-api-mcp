#!/usr/bin/env node
// Process entry point.
//
// Stdio is the local surface: it owns one process-scope browser task manager and session manager, and
// registers the local profile/browser helpers. HTTP stays exactly the 32-tool API server: it never
// imports a browser module, never constructs a session manager, never registers helpers, and never
// loads Playwright.
//
// All services are cheap to construct and lazy in the parts that can fail (credentials, keyring,
// Playwright), so the server starts without an account, a registry, or an optional browser dependency.

import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpMcpServer } from './http.js';
import { createRedditMcpServer } from './mcp-server.js';
import { readRuntimeSettings } from './config.js';
import { createProfileRegistry } from './profiles.js';
import { createAccountRegistry } from './accounts.js';
import { createProfileSecretStore } from './secrets.js';
import { createApprovalStore } from './approvals.js';
import { createContinuationStore } from './continuations.js';
import { createDispatcher } from './dispatch.js';

const args = process.argv.slice(2);

// Process-scope services for one selected transport. Browser modules are imported only when the
// local stdio surface asks for them, so HTTP never even loads the browser session code.
async function createLocalServices({ browser }) {
  const settings = readRuntimeSettings(process.env);
  const registry = createProfileRegistry({ homeDir: settings.homeDir });
  const accounts = createAccountRegistry({ registry });
  const secretStore = createProfileSecretStore();
  const approvals = createApprovalStore({ homeDir: settings.homeDir });

  if (!browser) {
    return {
      settings,
      registry,
      accounts,
      secretStore,
      approvals,
      sessions: null,
      tasks: null,
      continuations: null,
      browserServices: false,
      dispatcher: createDispatcher({
        registry,
        accounts,
        secretStore,
        approvals,
        settings,
        browserSessions: null,
      }),
    };
  }

  const [{ createBrowserSessionManager }, { createBrowserTasks }, { createBrowserHelpers, createSamplingAssist }] = await Promise.all([
    import('./browser/session.js'),
    import('./browser/steps.js'),
    import('./mcp-browser.js'),
  ]);

  const tasks = createBrowserTasks();
  let manager = null;
  // A lazy proxy keeps construction cheap but still gives the dispatcher a real manager by the time a
  // browser or replay backend calls open(). Constructing the manager never imports Playwright.
  const sessions = {
    open: (...callArgs) => sessionManager().open(...callArgs),
    identity: (...callArgs) => sessionManager().identity(...callArgs),
    renew: (...callArgs) => sessionManager().renew(...callArgs),
    close: (...callArgs) => sessionManager().close(...callArgs),
    enroll: (...callArgs) => sessionManager().enroll(...callArgs),
    closeAll: (...callArgs) => sessionManager().closeAll(...callArgs),
  };
  function sessionManager() {
    manager ??= createBrowserSessionManager({
      registry,
      accounts,
      secretStore,
      settings,
      tasks,
      interactive: process.stdin.isTTY === true,
    });
    return manager;
  }

  // Process-scope UI continuations: a paged browser read can return an opaque token that stays bound
  // to this process, profile, account, backend, and query until it expires or its task closes.
  const continuations = createContinuationStore();
  const dispatcher = createDispatcher({
    registry,
    accounts,
    secretStore,
    approvals,
    settings,
    browserSessions: sessions,
    continuations,
    tasks,
  });
  return {
    settings,
    registry,
    accounts,
    secretStore,
    approvals,
    sessions,
    tasks,
    continuations,
    browserServices: true,
    dispatcher,
    createBrowserHelpers,
    createSamplingAssist,
  };
}

function missingBrowserModules(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND'
    && /(?:^|[\\/])(?:browser[\\/]|mcp-browser\.js)/.test(String(error?.message ?? ''));
}

if (args.includes('--generate-token')) {
  console.log(randomBytes(32).toString('hex'));
} else if (args.includes('--http')) {
  const host = process.env.REDDIT_MCP_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.REDDIT_MCP_PORT?.trim() || 3000);
  // API-only by construction: no browser sessions, no local helpers.
  const services = await createLocalServices({ browser: false });
  const httpServer = await startHttpMcpServer({
    createMcpServer: () => createRedditMcpServer({
      dispatcher: services.dispatcher,
      transport: 'http',
    }),
    host,
    port,
    token: process.env.REDDIT_MCP_TOKEN?.trim(),
  });
  console.error(`reddit-api-mcp listening on http://${host}:${httpServer.address().port}/mcp`);
} else {
  // `--api-only` is the API-only stdio surface used by the Claude Desktop bundle: 32 Reddit tools,
  // no local profile/browser helpers, no Playwright. A source/local stdio install uses the browser
  // surface. If an API-only bundle is started without the flag, missing browser modules degrade to
  // the same API-only surface instead of failing before initialize.
  let services;
  const apiOnly = args.includes('--api-only');
  if (apiOnly) {
    services = await createLocalServices({ browser: false });
  } else {
    try {
      services = await createLocalServices({ browser: true });
    } catch (error) {
      if (!missingBrowserModules(error)) throw error;
      console.error('Browser modules are not bundled in this installation; starting the API-only stdio server.');
      services = await createLocalServices({ browser: false });
    }
  }
  const samplingEnabled = services.browserServices === true && services.settings.sampling?.enabled === true;
  let server = null;
  let browserHelpers = null;
  if (services.browserServices === true) {
    const sampling = services.createSamplingAssist({
      enabled: samplingEnabled,
      getServer: () => server?.server ?? null,
    });
    browserHelpers = services.createBrowserHelpers({
      dispatcher: services.dispatcher,
      registry: services.registry,
      settings: services.settings,
      sessions: services.sessions,
      tasks: services.tasks,
      approvals: services.approvals,
      sampling,
    });
  }
  server = createRedditMcpServer({
    dispatcher: services.dispatcher,
    transport: 'stdio',
    ...(browserHelpers ? { browserHelpers } : {}),
    samplingEnabled,
  });
  await server.connect(new StdioServerTransport());
}
