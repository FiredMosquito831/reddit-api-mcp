import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpMcpServer } from '../src/http.js';
import { createRedditMcpServer } from '../src/mcp-server.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createDispatcher } from '../src/dispatch.js';

const TOKEN = 'test-token-123';
const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
};

async function withServer(run, createMcpServer = () => createRedditMcpServer({ getActions: () => ({}), transport: 'http' })) {
  const httpServer = await startHttpMcpServer({
    createMcpServer,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    return await run(base);
  } finally {
    httpServer.closeAllConnections();
    httpServer.close();
  }
}

test('HTTP mode refuses requests without the bearer token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(res.status, 401);
    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: 'Bearer nope' },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(wrong.status, 401);
  });
});

test('HTTP mode answers initialize with the server identity when the token is right', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.serverInfo.name, 'reddit-api-automation-mcp');
  });
});

test('HTTP mode serves only /mcp and only over POST', async () => {
  await withServer(async (base) => {
    const other = await fetch(`${base}/elsewhere`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(other.status, 404);
    const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
  });
});

test('HTTP mode will not start without a token', () => {
  assert.throws(
    () => startHttpMcpServer({
      createMcpServer: () => createRedditMcpServer({ getActions: () => ({}), transport: 'http' }),
      port: 0,
      token: '',
    }),
    /REDDIT_MCP_TOKEN is required/,
  );
});

async function postMcp(base, body) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

test('an HTTP factory passed the bare constructor still starts and serves requests', async () => {
  // Old callers wired `createMcpServer: createRedditMcpServer` directly; the HTTP layer now invokes
  // the factory with { transport: 'http' }, which must keep working without a dispatcher.
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.result.serverInfo.name, 'reddit-api-automation-mcp');
  }, createRedditMcpServer);
});

test('HTTP serves exactly the 32 Reddit tools, never the local helpers', async () => {
  await withServer(async (base) => {
    const payload = await postMcp(base, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    const names = payload.result.tools.map((tool) => tool.name);
    assert.equal(names.length, 32);
    assert.equal(names.includes('reddit_profiles_list'), false);
    assert.equal(names.includes('reddit_browser_open'), false);
    assert.equal(names.includes('api'), false);
  }, () => createRedditMcpServer({
    getActions: () => ({}),
    transport: 'http',
    // Even if a caller wrongly passes helpers, HTTP must not advertise them.
    browserHelpers: { reddit_profiles_list: async () => ({}) },
  }));
});

test('HTTP rejects an explicit browser backend without opening any browser session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-http-browser-'));
  try {
    const registry = createProfileRegistry({ homeDir: home });
    const profile = await registry.add({ alias: 'work', expectedUsername: 'alice' });
    await registry.update(profile.id, { enabledBackends: ['api', 'browser'], backendPreference: ['browser', 'api'] });
    await registry.setDefault(profile.id);
    const dispatcher = createDispatcher({
      registry,
      settings: { homeDir: home },
      browserSessions: null,
    });
    await withServer(async (base) => {
      const payload = await postMcp(base, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'get_me', arguments: { backend: 'browser' } },
      });
      assert.equal(payload.result.isError, true);
      assert.equal(payload.result.structuredContent.error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(JSON.stringify(payload.result).includes('playwright'), false);
    }, () => createRedditMcpServer({ dispatcher, transport: 'http' }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
