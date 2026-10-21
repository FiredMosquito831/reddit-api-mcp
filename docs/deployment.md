# Deployment: Docker and HTTP

This page covers running the HTTP server, with Docker or without it. For the stdio server that Claude Desktop and Claude Code start themselves, see [mcp.md](mcp.md).

## When to use HTTP

Use the HTTP server when the client cannot start a local process, or when you want one server that several clients share. For a single machine, stdio is simpler and has fewer moving parts.

## Browser and replay backends are not available here

HTTP, Docker, and the Claude Desktop extension are **API-only** by design. The image copies `src/`
without the CLI or the browser/replay modules, and Playwright is an optional peer that is never
installed by a tool call. A request that selects `backend: "replay"` or `backend: "browser"` is
rejected before any browser or profile work. The 32 Reddit tools are served; the 11 local
profile/browser helpers are not registered. Use the local CLI or a local stdio server for the
experimental backends. See [browser-mode.md](browser-mode.md).

## The image

The `Dockerfile` builds a small image:

- Base image `node:24-alpine`.
- Installs the production dependencies with `npm ci --omit=dev`, from the committed lockfile.
- Copies `src/` only. Tests, scripts, docs, and `.env` are excluded by `.dockerignore`.
- Runs as the unprivileged `node` user.
- Listens on port 3000, bound to `0.0.0.0` inside the container.
- Starts with `node src/mcp.js --http`.

Build it from the repository root:

```
docker build -t reddit-api-automation-mcp .
```

## Run with Docker

```
docker run -d --name reddit-api-automation-mcp \
  -p 127.0.0.1:3000:3000 \
  -e REDDIT_AUTH_MODE=app \
  -e REDDIT_CLIENT_ID=your-client-id \
  -e REDDIT_CLIENT_SECRET=your-secret \
  -e REDDIT_USERNAME=your-username \
  -e REDDIT_MCP_TOKEN=your-bearer-token \
  reddit-api-automation-mcp
```

The port mapping binds to `127.0.0.1` on your machine. Without that prefix, Docker publishes the port on every interface, which exposes the server to your network.

Docker Desktop can take a few seconds to forward a new port after `docker run`. If the first request fails, wait a moment and try again. Check the container with `docker logs reddit-api-automation-mcp`. A healthy start prints `reddit-api-automation-mcp listening on http://0.0.0.0:3000/mcp`.

## Run with Compose

`docker-compose.yml` runs the same image with settings from your environment. Compose reads a `.env` file in the same folder for substitution. Put the values there, or export them:

```
REDDIT_CLIENT_ID=your-client-id
REDDIT_USERNAME=your-username
REDDIT_MCP_TOKEN=your-bearer-token
REDDIT_AUTH_MODE=app                 # the default in compose
REDDIT_CLIENT_SECRET=your-secret     # for app and password modes
```

Then:

```
docker compose up -d
docker compose logs -f
docker compose down
```

Compose requires `REDDIT_CLIENT_ID`, `REDDIT_USERNAME`, and `REDDIT_MCP_TOKEN` to be set, and it stops with a message if one is missing. The default `REDDIT_AUTH_MODE` in compose is `app`, which is read-only. Set `oauth` or `password` deliberately if you want writes.

## Auth in a container

A container has no OS keychain, so the `oauth` mode needs its refresh token from the environment:

1. On your own machine, from the repository, run `node --env-file-if-exists=.env src/cli.js login`, then `node --env-file-if-exists=.env src/cli.js token`.
2. Set `REDDIT_REFRESH_TOKEN` to that value for the container.

Reddit may issue a new refresh token when one is used. The container keeps the newest one in memory while it runs. When it restarts, it uses the value you set. If that value has since been replaced, run `login` and `token` again, and update the variable. Plan for this before you rely on `oauth` in a container.

`password` mode needs no keychain, and works well in a container, with the password from the environment. The trade-offs are in [security.md](security.md#password-mode).

## Check that it works

```
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $REDDIT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A reply containing `"serverInfo":{"name":"reddit-api-automation-mcp"...}` means the server is up and the token is right. A `401` means the token is wrong or missing. A connection error right after `docker run` means the port is still being forwarded.

## Without Docker

```
REDDIT_MCP_TOKEN=your-bearer-token npm run mcp:http
```

Or, with a `.env` file:

```
node --env-file-if-exists=.env src/mcp.js --http
```

The server binds to `127.0.0.1:3000` by default. Set `REDDIT_MCP_HOST` and `REDDIT_MCP_PORT` to change that.

## Exposing it beyond your machine

The defaults are chosen so you do not expose the server by accident. If you need access from another machine:

- **Keep the token.** Every request needs it, and it should be long and random. `node src/mcp.js --generate-token` makes one.
- **Use TLS.** The bearer token travels in every request header, so it must not cross the network in clear text. Put a reverse proxy that terminates TLS in front of the server. Choose one you know how to run, and keep the upstream on localhost.
- **Restrict access.** A firewall rule or a VPN is better than a public port. The tool has no IP allow-list of its own.
- **Remember what it can do.** Anyone who gets through can act on your Reddit account, as far as its scopes allow.

## Logs and health

- Logs go to standard error, which Docker records. `docker logs` shows them.
- There is no separate health endpoint. The `initialize` request above is the check.
- The server prints no per-request logs of its own, to keep tokens and content out of them.

## Updating and stopping

```
docker build -t reddit-api-automation-mcp .          # after a git pull
docker compose up -d --build              # with Compose
docker stop reddit-api-automation-mcp && docker rm reddit-api-automation-mcp
docker compose down
```
