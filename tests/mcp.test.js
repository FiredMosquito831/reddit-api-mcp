import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the MCP server.'));
      }
    }, 25);
  });
}

// Spawn the real stdio entry point with no API credentials and a temporary home. Every stdout line
// must be a JSON-RPC message: the helpers and diagnostics never write to stdout.
async function withStdioServer(env, run) {
  const child = spawn(process.execPath, [MCP], {
    env: { ...env, REDDIT_CLI_HOME: env.REDDIT_CLI_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  const lines = [];
  let buffered = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      lines.push(line);
      const message = JSON.parse(line);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  let nextId = 1;
  const send = (method, params = {}) => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  try {
    const initId = send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    await waitFor(() => replies.has(initId));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return await run({
      replies,
      lines,
      stderr: () => stderr,
      send,
      wait: (id) => waitFor(() => replies.has(id)),
      callTool: async (name, args = {}) => {
        const id = send('tools/call', { name, arguments: args });
        await waitFor(() => replies.has(id));
        return replies.get(id).result;
      },
    });
  } finally {
    child.kill();
  }
}

function cleanEnv(home, extra = {}) {
  const env = { ...process.env, REDDIT_CLI_HOME: home, ...extra };
  delete env.REDDIT_CLIENT_ID;
  delete env.REDDIT_USERNAME;
  delete env.REDDIT_CLIENT_SECRET;
  delete env.REDDIT_PASSWORD;
  delete env.REDDIT_REFRESH_TOKEN;
  delete env.REDDIT_AUTH_MODE;
  return env;
}

test('stdio starts with no credentials and missing Playwright, and lists 32 tools plus 11 local helpers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-mcp-stdio-'));
  try {
    await withStdioServer(cleanEnv(home), async ({ send, wait, replies, lines }) => {
      const listId = send('tools/list', {});
      await wait(listId);
      const tools = replies.get(listId).result.tools;
      const names = tools.map((tool) => tool.name);
      assert.equal(tools.length, 43);
      for (const name of [
        'reddit_profiles_list', 'reddit_profile_current', 'reddit_profile_default_set',
        'reddit_settings_get', 'reddit_settings_propose', 'reddit_browser_status',
        'reddit_browser_open', 'reddit_browser_observe', 'reddit_browser_step',
        'reddit_browser_handoff', 'reddit_browser_close',
      ]) {
        assert.ok(names.includes(name), `missing helper ${name}`);
      }
      assert.ok(!names.includes('api'), 'the raw api escape hatch is not exposed');
      const createPost = tools.find((tool) => tool.name === 'create_post');
      assert.ok(createPost.inputSchema.properties.confirm, 'create_post keeps an optional confirm field');
      assert.equal(createPost.inputSchema.required?.includes('confirm') ?? false, false);
      // Every stdout line was parseable JSON-RPC; the loop above would have thrown otherwise.
      assert.ok(lines.length >= 2);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('offline and profile diagnostics work before any profile or credential exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-mcp-offline-'));
  try {
    await withStdioServer(cleanEnv(home), async ({ callTool }) => {
      const explained = await callTool('reddit_explain', { term: 'karma' });
      assert.equal(explained.isError, undefined);
      assert.match(explained.content[0].text, /karma/i);
      assert.equal(explained.structuredContent.meta.backend, 'offline');

      const profiles = await callTool('reddit_profiles_list', {});
      assert.equal(profiles.isError, undefined);
      const payload = JSON.parse(profiles.content[0].text);
      assert.deepEqual(payload.profiles, []);
      assert.equal(payload.defaultProfile, null);

      const current = await callTool('reddit_profile_current', {});
      assert.equal(current.isError, true);
      assert.equal(current.structuredContent.error.code, 'PROFILE_REQUIRED');

      // Doctor must report the missing optional dependency, not install it.
      const status = await callTool('reddit_browser_status', {});
      assert.equal(status.isError, undefined);
      const doctor = JSON.parse(status.content[0].text);
      assert.equal(doctor.doctor.profile.provided, false);
      assert.ok(['BROWSER_DEPENDENCY_MISSING', 'BROWSER_BINARY_MISSING', 'BROWSER_CHANNEL_UNSUPPORTED'].includes(doctor.doctor.code)
        || doctor.doctor.ok === true);
      assert.equal(doctor.doctor.commands.some((command) => /playwright/.test(command)), true);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a missing profile yields a typed safe error, not a raw SDK or filesystem dump', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reddit-mcp-errors-'));
  try {
    await withStdioServer(cleanEnv(home), async ({ callTool }) => {
      const result = await callTool('get_me', { profile: 'no-such-profile' });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'PROFILE_NOT_FOUND');
      assert.equal(result.content[0].text.includes(home), false, 'absolute paths are not echoed');
      assert.equal(JSON.stringify(result.structuredContent).includes(home), false);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
