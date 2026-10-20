import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpMcpServer } from '../src/http.js';
import { createRedditMcpServer } from '../src/mcp-server.js';

const TOKEN = 'test-token-123';
const ACCEPT = 'application/json, text/event-stream';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
};

async function withServer(run) {
  const httpServer = await startHttpMcpServer({
    createMcpServer: () => createRedditMcpServer(() => ({})),
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
    assert.equal(payload.result.serverInfo.name, 'reddit-api-mcp');
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
    () => startHttpMcpServer({ createMcpServer: () => createRedditMcpServer(() => ({})), port: 0, token: '' }),
    /REDDIT_MCP_TOKEN is required/,
  );
});
