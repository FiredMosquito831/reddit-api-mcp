#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpMcpServer } from './http.js';
import { createRedditMcpServer } from './mcp-server.js';

const args = process.argv.slice(2);

if (args.includes('--generate-token')) {
  console.log(randomBytes(32).toString('hex'));
} else if (args.includes('--http')) {
  const host = process.env.REDDIT_MCP_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.REDDIT_MCP_PORT?.trim() || 3000);
  const httpServer = await startHttpMcpServer({
    createMcpServer: () => createRedditMcpServer(),
    host,
    port,
    token: process.env.REDDIT_MCP_TOKEN?.trim(),
  });
  console.error(`reddit-api-mcp listening on http://${host}:${httpServer.address().port}/mcp`);
} else {
  await createRedditMcpServer().connect(new StdioServerTransport());
}
