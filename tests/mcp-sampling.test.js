import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSamplingAssist, createBrowserHelpers } from '../src/mcp-browser.js';
import { createBrowserTasks } from '../src/browser/steps.js';

function fakeServer({ capabilities = {}, answer = 'Looks like a subreddit feed.', throws = false } = {}) {
  const requests = [];
  return {
    requests,
    getClientCapabilities() {
      return capabilities;
    },
    async createMessage(params, options) {
      requests.push({ params, options });
      if (throws) throw new Error('declined: raw SDK text that must not leak');
      return { model: 'fake', content: { type: 'text', text: answer } };
    },
  };
}

test('sampling is off by default and never asks the client', async () => {
  const server = fakeServer({ capabilities: { sampling: {} } });
  const sampling = createSamplingAssist({ enabled: false, getServer: () => server });
  assert.deepEqual(sampling.status(), {
    enabled: false,
    capabilityDetected: false,
    requestsUsed: 0,
    maxRequests: 4,
    protocolVersion: '2025-11-25',
    note: sampling.status().note,
  });
  const result = await sampling.assist({ observation: { title: 'x', text: 'y' } });
  assert.deepEqual(result, { used: false, reason: 'sampling_disabled' });
  assert.equal(server.requests.length, 0);
});

test('sampling is skipped unless the initialized client actually declares it', async () => {
  const noCapability = fakeServer({ capabilities: {} });
  const sampling = createSamplingAssist({ enabled: true, getServer: () => noCapability });
  const result = await sampling.assist({ observation: { title: 'x', text: 'y' } });
  assert.deepEqual(result, { used: false, reason: 'client_sampling_unavailable' });
  assert.equal(noCapability.requests.length, 0);
  assert.equal(sampling.status().capabilityDetected, false);

  const noServer = createSamplingAssist({ enabled: true, getServer: () => null });
  assert.deepEqual(await noServer.assist({ observation: {} }), { used: false, reason: 'client_sampling_unavailable' });
});

test('a successful sample is bounded, advisory, and explicitly untrusted', async () => {
  const server = fakeServer({ capabilities: { sampling: {} }, answer: 'A feed. token=abc123' });
  const sampling = createSamplingAssist({ enabled: true, getServer: () => server, maxRequests: 1, timeoutMs: 1_234 });
  const result = await sampling.assist({
    observation: { title: 'r/test', text: 'visible text that is untrusted' },
  });
  assert.equal(result.used, true);
  assert.equal(result.advisory, true);
  assert.equal(result.trusted, false);
  assert.match(result.note, /cannot authorize/i);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].options.timeout, 1_234);
  assert.equal(server.requests[0].params.maxTokens, 300);
  assert.match(server.requests[0].params.systemPrompt, /never approve/i);
  assert.match(server.requests[0].params.messages[0].content.text, /untrusted/i);

  const again = await sampling.assist({ observation: { title: 'r/test', text: 'more' } });
  assert.deepEqual(again, { used: false, reason: 'sampling_budget_exhausted' });
  assert.equal(server.requests.length, 1, 'the per-process budget is enforced');
});

test('a decline, timeout, or unavailable protocol returns the ordinary observation without leaking the error', async () => {
  const server = fakeServer({ capabilities: { sampling: {} }, throws: true });
  const sampling = createSamplingAssist({ enabled: true, getServer: () => server });
  const result = await sampling.assist({ observation: { title: 'x', text: 'y' } });
  assert.deepEqual(result, { used: false, reason: 'sampling_unavailable' });
  assert.equal(JSON.stringify(result).includes('declined'), false);
  assert.equal(sampling.status().protocolVersion, '2025-11-25');
});

test('observation assistance is attached only when asked and enabled; the observation still returns otherwise', async () => {
  const tasks = createBrowserTasks();
  const tasksApi = {
    ...tasks,
    async observe() {
      return { taskId: 't1', observationId: 'o1', url: 'https://www.reddit.com/r/test/', title: 'r/test', elements: [], text: 'visible' };
    },
  };
  const page = {};
  const snapshot = {
    id: 'p_work',
    alias: 'work',
    accountKey: 'a_1',
    enabledBackends: ['browser'],
    backendPreference: ['browser'],
    visibility: 'visible',
    policyGeneration: 1,
    credentialGeneration: 1,
  };
  const registry = {
    async snapshot() { return snapshot; },
    async get() { return snapshot; },
  };
  const dispatcher = { async status() { return { profile: { id: snapshot.id } }; } };
  const samples = [];
  const sampling = {
    async assist({ observation }) {
      samples.push(observation);
      return { used: true, advisory: true, trusted: false, text: 'summary' };
    },
    status() { return { enabled: true }; },
  };
  const helpers = createBrowserHelpers({
    dispatcher,
    registry,
    sessions: { open: async () => ({ visibility: 'visible', context: { pages: () => [page] } }) },
    tasks: tasksApi,
    doctor: false,
    sampling,
  });

  const plain = await helpers.reddit_browser_observe({ task_id: 't1' });
  assert.equal(plain.assistance, undefined);
  assert.equal(samples.length, 0);

  const assisted = await helpers.reddit_browser_observe({ task_id: 't1', assist: true });
  assert.equal(assisted.assistance.used, true);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].title, 'r/test');
});
