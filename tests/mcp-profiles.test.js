import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRedditMcpServer, toolInventory } from '../src/mcp-server.js';
import { createBrowserHelpers, LOCAL_TOOL_NAMES } from '../src/mcp-browser.js';
import { createProfileRegistry } from '../src/profiles.js';
import { createApprovalStore } from '../src/approvals.js';
import { createDispatcher } from '../src/dispatch.js';
import { createBrowserTasks } from '../src/browser/steps.js';
import { REDDIT_TOOL_NAMES } from '../src/operations.js';

async function withTempHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'reddit-mcp-profiles-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function connect(server, capabilities = {}) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function fakeDispatcher(status = {}) {
  const calls = [];
  return {
    calls,
    async status(selector = null) {
      return {
        profile: {
          id: 'p_test',
          alias: 'work',
          isLegacy: false,
          isDefault: true,
          expectedUsername: 'alice',
          username: 'alice',
          accountKey: 'a_0123456789abcdef',
          accountId: null,
          bound: true,
        },
        defaultProfile: 'work',
        enabledBackends: ['api'],
        backendPreference: ['api'],
        visibility: 'visible',
        passwordLoginEnabled: false,
        confirmations: {},
        api: { clientId: null, appType: null },
        approvalPolicy: { global: 'off', perAction: {} },
        pendingAttempts: [],
        ...status,
      };
    },
    async execute(tool, args, options) {
      calls.push({ tool, args, options });
      return { data: { tool, args }, meta: { backend: 'api', completeness: 'complete', missingFields: [] } };
    },
    async closeProfile() {
      return { profileId: 'p_test', closedBackends: [], browser: null };
    },
  };
}

function textOf(result) {
  return result.content.find((item) => item.type === 'text')?.text ?? '';
}

test('stdio exposes the 32 Reddit tools plus exactly the 11 local helpers; HTTP exposes only the 32', async () => {
  assert.deepEqual([...toolInventory({ transport: 'http' })], [...REDDIT_TOOL_NAMES]);
  assert.deepEqual([...toolInventory({ transport: 'stdio' })], [...REDDIT_TOOL_NAMES, ...LOCAL_TOOL_NAMES]);
  assert.equal(LOCAL_TOOL_NAMES.length, 11);

  const dispatcher = fakeDispatcher();
  const helpers = createBrowserHelpers({ dispatcher, registry: null, tasks: createBrowserTasks() });
  const stdio = await connect(createRedditMcpServer({ dispatcher, transport: 'stdio', browserHelpers: helpers }));
  const stdioTools = (await stdio.listTools()).tools;
  assert.equal(stdioTools.length, 43);
  assert.deepEqual(stdioTools.map((tool) => tool.name).sort(), [...REDDIT_TOOL_NAMES, ...LOCAL_TOOL_NAMES].sort());

  const http = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
  const httpTools = (await http.listTools()).tools;
  assert.equal(httpTools.length, 32);
  assert.equal(httpTools.some((tool) => LOCAL_TOOL_NAMES.includes(tool.name)), false);

  // The legacy function injection still works and never exposes browser helpers.
  const legacy = await connect(createRedditMcpServer(() => ({})));
  assert.equal((await legacy.listTools()).tools.length, 32);
});

test('confirm is an optional input on all 11 writes, and profile/backend are optional on every tool', async () => {
  const dispatcher = fakeDispatcher();
  const server = createRedditMcpServer({ dispatcher, transport: 'http' });
  const client = await connect(server);
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  for (const name of REDDIT_TOOL_NAMES) {
    const tool = tools.get(name);
    assert.ok(tool, `missing ${name}`);
    assert.ok(tool.inputSchema.properties.profile, `${name} accepts a profile`);
    assert.ok(tool.inputSchema.properties.backend, `${name} accepts a backend`);
    assert.equal(tool.annotations?.readOnlyHint, !/create_post|reply_to_post|edit_|delete_|save_|unsave_|vote_|subscribe_|unsubscribe_/.test(name), `${name} annotation`);
  }
  for (const name of ['create_post', 'reply_to_post', 'edit_post', 'edit_comment', 'delete_post', 'delete_comment',
    'save_content', 'unsave_content', 'vote_on_thing', 'subscribe_to_subreddit', 'unsubscribe_from_subreddit']) {
    const schema = tools.get(name).inputSchema;
    assert.ok(schema.properties.confirm, `${name} has an optional confirm field`);
    assert.equal(schema.required?.includes('confirm') ?? false, false, `${name} does not require confirm`);
  }
  // The continuation input exists only on the seven paged reads.
  const paged = ['browse_subreddit', 'get_top_posts', 'search_reddit', 'get_user_posts', 'get_user_comments', 'get_my_overview', 'get_my_saved'];
  for (const [name, tool] of tools) {
    assert.equal(Boolean(tool.inputSchema.properties.continuation), paged.includes(name), `${name} continuation input`);
  }
});

test('the legacy function adapter still serves the offline glossary and public RSS reads', async () => {
  // The injected actions deliberately have no explain method: HEAD did not route these two tools
  // through the actions object at all, so the compatibility adapter must not either.
  const client = await connect(createRedditMcpServer(() => ({})));

  const explained = await client.callTool({ name: 'reddit_explain', arguments: { term: 'karma' } });
  assert.equal(explained.isError, undefined);
  assert.match(textOf(explained), /karma/i);
  assert.ok(explained.structuredContent.data);

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(
      '<?xml version="1.0"?><feed><entry><id>t3_abc</id><title>Hello</title>'
        + '<author><name>/u/alice</name></author>'
        + '<link href="https://www.reddit.com/r/test/comments/abc/x/"/>'
        + '<updated>2026-10-21T00:00:00Z</updated></entry></feed>',
      { status: 200, headers: { 'content-type': 'application/atom+xml' } },
    );
  };
  try {
    const feed = await client.callTool({
      name: 'browse_subreddit_rss',
      arguments: { subreddit: 'test', sort: 'new', limit: 5 },
    });
    assert.equal(feed.isError, undefined);
    const entries = JSON.parse(textOf(feed));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Hello');
    assert.match(requests[0].url, /\/r\/test\/new\/\.rss\?limit=5$/);
    assert.match(requests[0].init.headers['user-agent'], /reddit-cli/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the legacy function adapter still refuses a write without confirm: true', async () => {
  const calls = [];
  const client = await connect(createRedditMcpServer(() => ({
    async submitPost(args) {
      calls.push(args);
      return { id: 't3_ok' };
    },
  })));
  const refused = await client.callTool({
    name: 'create_post',
    arguments: { subreddit: 'test', title: 'hi', text: 'body' },
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'APPROVAL_REQUIRED');
  assert.equal(calls.length, 0);

  const sent = await client.callTool({
    name: 'create_post',
    arguments: { subreddit: 'test', title: 'hi', text: 'body', confirm: true },
  });
  assert.equal(sent.isError, undefined);
  assert.equal(calls.length, 1);
});

test('the legacy adapter refuses a profile or non-API backend instead of pretending API served it', async () => {
  const calls = [];
  const client = await connect(createRedditMcpServer(() => ({
    async whoami() {
      calls.push('whoami');
      return { name: 'alice' };
    },
  })));
  const byBackend = await client.callTool({ name: 'get_me', arguments: { backend: 'browser' } });
  assert.equal(byBackend.isError, true);
  assert.equal(byBackend.structuredContent.error.code, 'UNSUPPORTED_OPERATION');
  const byProfile = await client.callTool({ name: 'get_me', arguments: { profile: 'work' } });
  assert.equal(byProfile.isError, true);
  assert.equal(byProfile.structuredContent.error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(calls.length, 0, 'nothing was executed for the refused calls');
});

test('the no-argument constructor serves the offline tools without any credential', async () => {
  const client = await connect(createRedditMcpServer());
  const explained = await client.callTool({ name: 'reddit_explain', arguments: { term: 'cake day' } });
  assert.equal(explained.isError, undefined);
  assert.match(textOf(explained), /cake day/i);
});

test('the constructor keeps its pre-profile defaults for compatibility callers', async () => {
  // HEAD accepted no argument (and an empty options object), lazily opening the environment session.
  // Construction must still succeed; credentials stay lazy, so listing tools does not touch them.
  const noArgument = await connect(createRedditMcpServer());
  assert.equal((await noArgument.listTools()).tools.length, 32);

  const emptyOptions = await connect(createRedditMcpServer({ transport: 'http' }));
  assert.equal((await emptyOptions.listTools()).tools.length, 32);
});

test('a supplied continuation is refused with a typed error instead of being silently dropped', async () => {
  const dispatcher = fakeDispatcher();
  const client = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
  const result = await client.callTool({ name: 'browse_subreddit', arguments: { subreddit: 'test', continuation: 'opaque' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'CONTINUATION_INVALID');
  assert.equal(dispatcher.calls.length, 0);
});

test('a dispatcher with a continuation store receives the token instead of a silent restart', async () => {
  const base = fakeDispatcher();
  const dispatcher = { ...base, continuationStore: true };
  const client = await connect(createRedditMcpServer({ dispatcher, transport: 'stdio' }));
  const result = await client.callTool({
    name: 'browse_subreddit',
    arguments: { subreddit: 'test', continuation: 'opaque' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(base.calls.length, 1);
  assert.equal(base.calls[0].args.subreddit, 'test');
  assert.equal(base.calls[0].options.continuation, 'opaque');
});

test('global-on approval policy dispatches zero writes without a trusted local approval, even with confirm:true', async () => {
  await withTempHome(async (home) => {
    const registry = createProfileRegistry({ homeDir: home });
    const profile = await registry.add({ alias: 'work', expectedUsername: 'alice' });
    await registry.setDefault(profile.id);
    let commits = 0;
    const backend = {
      async capabilities() {
        return { reads: [], writes: ['create_post'], appOnly: false };
      },
      async probe() {
        return { username: 'alice', verified: true };
      },
      async read() {
        return {};
      },
      async prepareWrite() {
        return { prepared: true };
      },
      async commitWrite() {
        commits += 1;
        return { data: { ok: true } };
      },
      async close() {},
    };
    const dispatcher = createDispatcher({
      registry,
      settings: { homeDir: home, confirmations: { global: 'on', perAction: {} } },
      backendFactories: { api: async () => backend },
    });
    const client = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
    const result = await client.callTool({
      name: 'create_post',
      arguments: { subreddit: 'sandbox', title: 'A post', text: 'Body', confirm: true },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'APPROVAL_REQUIRED');
    assert.equal(commits, 0, 'no write may be dispatched without a trusted approval');
  });
});

test('default-off confirmations let the same write through with no confirm field', async () => {
  await withTempHome(async (home) => {
    const registry = createProfileRegistry({ homeDir: home });
    const profile = await registry.add({ alias: 'work', expectedUsername: 'alice' });
    await registry.setDefault(profile.id);
    let commits = 0;
    const backend = {
      async capabilities() {
        return { reads: [], writes: ['create_post'], appOnly: false };
      },
      async probe() {
        return { username: 'alice', verified: true };
      },
      async read() {
        return {};
      },
      async prepareWrite() {
        return {};
      },
      async commitWrite() {
        commits += 1;
        return { id: 't3_new' };
      },
      async close() {},
    };
    const dispatcher = createDispatcher({
      registry,
      settings: { homeDir: home, confirmations: { global: 'off', perAction: {} } },
      backendFactories: { api: async () => backend },
    });
    const client = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
    const result = await client.callTool({
      name: 'create_post',
      arguments: { subreddit: 'sandbox', title: 'A post', text: 'Body' },
    });
    assert.equal(result.isError, undefined);
    assert.equal(commits, 1);
    const parsed = JSON.parse(textOf(result));
    assert.deepEqual(parsed, { id: 't3_new' }, 'legacy JSON data is preserved');
    assert.equal(result.structuredContent.meta.outcome, 'SUCCEEDED');
  });
});

test('profile helpers list, select, and read non-secret state from a temporary home', async () => {
  await withTempHome(async (home) => {
    const registry = createProfileRegistry({ homeDir: home });
    const first = await registry.add({ alias: 'work', expectedUsername: 'alice' });
    await registry.add({ alias: 'home', expectedUsername: 'bob' });
    await registry.setDefault(first.id);
    await registry.bindIdentity(first.id, { username: 'alice' });
    const dispatcher = fakeDispatcher();
    const helpers = createBrowserHelpers({
      dispatcher,
      registry,
      settings: {
        safeMode: 'standard',
        maxWritesPerHour: 12,
        botFooter: 'footer',
        cacheTtlMs: 60_000,
        maxAttempts: 4,
        backendPreference: 'auto',
        enabledBackends: ['api'],
        visibility: 'visible',
        confirmations: { global: 'off' },
        browser: { enabled: true, passwordLoginEnabled: false },
        sampling: { enabled: false },
        homeDir: 'C:\\secret-looking-home',
      },
      tasks: createBrowserTasks(),
    });
    const client = await connect(createRedditMcpServer({ dispatcher, transport: 'stdio', browserHelpers: helpers }));

    const listed = JSON.parse(textOf(await client.callTool({ name: 'reddit_profiles_list', arguments: {} })));
    assert.equal(listed.count, 2);
    assert.equal(listed.defaultProfile, 'work');

    const current = JSON.parse(textOf(await client.callTool({ name: 'reddit_profile_current', arguments: {} })));
    assert.equal(current.profile.id, 'p_test');
    assert.equal(current.approvalPolicy.global, 'off');

    const changed = JSON.parse(textOf(await client.callTool({
      name: 'reddit_profile_default_set',
      arguments: { profile: 'home' },
    })));
    assert.equal(changed.defaultProfile, 'home');

    const settings = JSON.parse(textOf(await client.callTool({ name: 'reddit_settings_get', arguments: { profile: 'work' } })));
    assert.equal(settings.settings.maxWritesPerHour, 12);
    assert.equal(JSON.stringify(settings).includes('secret-looking-home'), false, 'the home path is not exposed');
    assert.equal(JSON.stringify(settings).toLowerCase().includes('password"'), false);
  });
});

test('a settings proposal is pending only: no approval token, and secret-bearing patches are refused', async () => {
  await withTempHome(async (home) => {
    const registry = createProfileRegistry({ homeDir: home });
    const profile = await registry.add({ alias: 'work', expectedUsername: 'alice' });
    await registry.setDefault(profile.id);
    await registry.bindIdentity(profile.id, { username: 'alice' });
    const approvals = createApprovalStore({ homeDir: home });
    const helpers = createBrowserHelpers({
      dispatcher: fakeDispatcher(),
      registry,
      settings: { homeDir: home },
      approvals,
      tasks: createBrowserTasks(),
    });
    const client = await connect(createRedditMcpServer({ dispatcher: fakeDispatcher(), transport: 'stdio', browserHelpers: helpers }));

    const proposed = await client.callTool({
      name: 'reddit_settings_propose',
      arguments: { profile: 'work', patch: { confirmations: { global: 'on' } } },
    });
    assert.equal(proposed.isError, undefined);
    const payload = JSON.parse(textOf(proposed));
    assert.equal(payload.status, 'pending');
    assert.equal(payload.classification, 'security');
    assert.equal(/token|approvalId|approved/i.test(JSON.stringify(payload)), false);
    assert.ok(payload.risks.length > 0);

    const secret = await client.callTool({
      name: 'reddit_settings_propose',
      arguments: { profile: 'work', patch: { botFooter: 'x', password: 'hunter2' } },
    });
    assert.equal(secret.isError, true);
    assert.equal(/hunter2/.test(textOf(secret)), false, 'the secret value is never echoed');
  });
});

test('profile, backend, and confirm are transport options, not Reddit arguments', async () => {
  const dispatcher = fakeDispatcher();
  const client = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
  const result = await client.callTool({
    name: 'create_post',
    arguments: { subreddit: 'sandbox', title: 'T', text: 'B', profile: 'work', backend: 'replay', confirm: true },
  });
  assert.equal(result.isError, undefined);
  assert.equal(dispatcher.calls.length, 1);
  assert.deepEqual(dispatcher.calls[0].args, { subreddit: 'sandbox', title: 'T', text: 'B' });
  assert.equal(dispatcher.calls[0].options.profile, 'work');
  assert.equal(dispatcher.calls[0].options.backend, 'replay');
  assert.equal(dispatcher.calls[0].options.requestConfirmation, true);
  assert.equal('confirm' in dispatcher.calls[0].args, false, 'confirm never reaches a backend as an argument');
});

test('invalid Reddit arguments are refused with a typed safe error before any backend work', async () => {
  const dispatcher = fakeDispatcher();
  const client = await connect(createRedditMcpServer({ dispatcher, transport: 'http' }));
  const result = await client.callTool({ name: 'create_post', arguments: { subreddit: 'sandbox', title: 'T' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'UNSUPPORTED_OPERATION');
  assert.match(result.content[0].text, /exactly one/i);
  assert.equal(dispatcher.calls.length, 0);
});
