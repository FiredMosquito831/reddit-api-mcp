import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MCP_PATH = '/mcp';

// True when the request carries the bearer token. The comparison takes the same time whatever the input.
function isAuthorized(header, token) {
  const given = Buffer.from(String(header ?? '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Streamable HTTP in stateless mode: each POST gets a fresh server and transport, and every request must
// carry the bearer token. Bind to 127.0.0.1 unless you mean to expose it.
export function startHttpMcpServer({ createMcpServer, host = '127.0.0.1', port = 3000, token }) {
  if (!token) {
    throw new Error('REDDIT_MCP_TOKEN is required for HTTP mode. Create one with: node src/mcp.js --generate-token');
  }
  const httpServer = createServer(async (req, res) => {
    if (req.url !== MCP_PATH) return sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
    if (!isAuthorized(req.headers.authorization, token)) {
      return sendJson(res, 401, { error: 'Missing or wrong bearer token.' });
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return sendJson(res, 405, { error: 'Only POST is supported in stateless mode.' });
    }
    try {
      const body = await readBody(req);
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error.message });
    }
  });
  return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer)));
}
