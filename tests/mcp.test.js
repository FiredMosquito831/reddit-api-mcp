import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

function waitFor(predicate, timeoutMs = 5_000) {
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

test('the MCP server exposes the imported tools, and writes carry a confirm field', async () => {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, REDDIT_CLIENT_ID: 'client-1', REDDIT_USERNAME: 'smoke_user' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      }
    }
  });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    })}\n`);
    await waitFor(() => replies.has(1));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    await waitFor(() => replies.has(2));

    const tools = replies.get(2).result.tools;
    const names = tools.map((tool) => tool.name);
    const expected = [
      'get_me', 'browse_subreddit', 'get_top_posts', 'get_subreddit_info', 'get_subreddit_rules',
      'get_post_flairs', 'get_trending_subreddits', 'search_reddit', 'get_reddit_post', 'get_post_comments',
      'get_more_comments', 'get_user_info', 'get_user_posts', 'get_user_comments', 'get_my_overview',
      'get_my_saved', 'list_my_subreddits', 'browse_subreddit_rss', 'create_post', 'reply_to_post',
      'edit_post', 'edit_comment', 'delete_post', 'delete_comment', 'save_content', 'unsave_content',
      'vote_on_thing', 'subscribe_to_subreddit', 'unsubscribe_from_subreddit',
      'user_analysis', 'reddit_explain', 'test_reddit_mcp_server',
    ];
    for (const name of expected) assert.ok(names.includes(name), `missing tool ${name}`);
    const createPost = tools.find((tool) => tool.name === 'create_post');
    assert.ok(createPost.inputSchema.properties.confirm, 'create_post has a confirm field');
    assert.ok(!names.includes('api'), 'the raw api escape hatch is not exposed over MCP');
  } finally {
    child.kill();
  }
});
