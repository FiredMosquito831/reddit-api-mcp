# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`reddit-api-mcp`: a Node.js client for Reddit that acts for the user's own account, in four forms: a command-line tool (`src/cli.js`), an MCP server over stdio or Streamable HTTP (`src/mcp.js`), a Docker image for the HTTP server, and a Claude Desktop extension (`.mcpb`). The feature set is ported from jordanburke/reddit-mcp-server, karanb192/reddit-mcp-buddy, and adhikasp/mcp-reddit (credited in `NOTICE.md`). It is plain JavaScript (ES modules), not TypeScript.

The repository is `FiredMosquito831/reddit-api-mcp` on GitHub, private at creation.

## Commands

- `npm test`: `node --test` over `tests/`. Everything runs offline: a fake `fetch`, a spawned stdio server, and a real HTTP server on an ephemeral port. Nothing contacts Reddit.
- `node src/cli.js --help`, or `npm link` once and then `reddit-cli --help`.
- `npm run mcp` (stdio, for Claude Desktop or Claude Code) and `npm run mcp:http` (Streamable HTTP, needs `REDDIT_MCP_TOKEN`).
- `node src/mcp.js --generate-token`: prints a random bearer token for HTTP mode.
- `npm run mcpb`: builds `dist/reddit-api-mcp.mcpb` for the platform it runs on. The bundle contains `src/` (without the CLI) and the production dependencies, plus a generated manifest. Validation and packing use `@anthropic-ai/mcpb`.
- `npm run rate-limit`: sends a few live reads with the cache off, and prints Reddit's rate-limit headers.
- `docker build -t reddit-api-mcp .` and `docker compose up -d`: the HTTP server on `127.0.0.1:3000`.
- `reddit-cli login` (oauth mode only) and `reddit-cli token`: `token` prints the stored refresh token, behind a confirmation, for the Claude Desktop extension.
- `reddit-cli scopes`: every OAuth scope, whether login requests it, and why the rest are omitted. Needs no configuration.
- Git Bash rewrites a leading `/` in arguments. Prefix commands with `MSYS_NO_PATHCONV=1` when passing API paths.

## Environment

- `REDDIT_CLIENT_ID` and `REDDIT_USERNAME` are always required.
- `REDDIT_AUTH_MODE`: `oauth` (default), `password`, or `app`.
- `REDDIT_CLIENT_SECRET`: required for `password` and `app`, and for script and web apps.
- `REDDIT_PASSWORD`: required for `password`.
- `REDDIT_REFRESH_TOKEN`: an OAuth refresh token supplied directly. Nothing is written when it is set.
- `REDDIT_REDIRECT_URI` (default `http://localhost:8080`), `REDDIT_SCOPES` (overrides the requested set), `REDDIT_USER_AGENT` (overrides the User-Agent).
- `REDDIT_CLI_SAFE_MODE` (`standard` or `strict`), `REDDIT_CLI_MAX_WRITES_PER_HOUR`, `REDDIT_CLI_BOT_FOOTER` (`auto`, custom text, or empty), `REDDIT_CLI_CACHE` (`on` or `off`), `REDDIT_CLI_MAX_RETRIES` (default 3), `REDDIT_CLI_HOME` (default `~/.reddit-cli`).
- `REDDIT_MCP_TOKEN` (required for HTTP), `REDDIT_MCP_HOST` (default `127.0.0.1`), `REDDIT_MCP_PORT` (default 3000).
- A setting still holding template text such as `${user_config.refresh_token}` counts as empty. This guards against a host that leaves unfilled settings unexpanded.

## Auth modes

- `oauth`: installed-app authorization-code flow. The authorize URL carries `duration=permanent`, and the `state` is checked. The refresh token goes to the OS keychain, or comes from `REDDIT_REFRESH_TOKEN`. The password is never stored.
- `password`: script-app password grant. The password is read from the environment on every token request and is never stored by this project. This is an opt-in trade-off, documented in the README.
- `app`: client-credentials grant. Read-only public data. The session refuses writes before anything is sent.

## Status

- 100 offline tests pass. Live behavior is unverified because there is no Reddit client ID yet.
- Docker image builds. The HTTP endpoint was smoke-tested in the container: `initialize` with the token succeeds, a request without it gets a 401, and `tools/list` answers.
- The MCPB bundle builds (win32 here), validates, unpacks, and lists 32 tools over stdio with no raw `api` tool. It has not been installed in Claude Desktop, and it is not signed.
- Endpoint paths and form fields were cross-checked against PRAW's `praw/endpoints.py` and call sites, and the read endpoints against jordanburke's code. reddit.com is unreachable from the dev tooling, so nothing was checked against Reddit's live reference.
- Logins made before the scope change have only the old scopes. Run `reddit-cli login` again to get `history` and `edit`.

## Scopes

- Login requests nine scopes: `identity`, `read`, `history`, `mysubreddits`, `subscribe`, `vote`, `submit`, `edit`, `save`. Each is needed by a shipped feature.
- `src/scopes.js` lists every scope with a decision and a reason. Omitted: `creddits`, `flair`, `livemanage`, the `mod*` scopes, `privatemessages`, `report`, `structuredstyles`, `wikiedit`, and `wikiread`.
- Don't request a scope unless a feature needs it. Add it with the feature, and update `src/scopes.js`.

## Architecture

- `src/cli.js`: commander wiring. The only module that prompts or prints, apart from `src/mcp.js`'s startup messages.
- `src/mcp.js`: entry point. Stdio by default, `--http` for Streamable HTTP, `--generate-token` to print a token.
- `src/mcp-server.js`: builds the MCP server with all 32 tools. Stdio and HTTP both use it. Writes refuse to run without `confirm: true`. The raw `api` command is not exposed.
- `src/http.js`: stateless Streamable HTTP. A fresh server and transport per request, a bearer token compared in constant time, and `/mcp` only.
- `src/session.js`: picks the token source for each auth mode, and builds the keychain store, client, write guard, and actions for one account.
- `src/config.js`: reads and validates the environment, and treats template placeholders as empty.
- `src/oauth.js`: authorize URL, code exchange, refresh, revoke, password grant, and client-credentials grant.
- `src/client.js`: `request(method, path, {query, form})` against `https://oauth.reddit.com`. Takes an `obtainToken` source, refreshes a minute before expiry, retries once on 401, honors `Retry-After` and `x-ratelimit-*`, and handles RATELIMIT errors inside 200 bodies. Waits over 60 seconds come back as errors. A sliding one-minute window caps requests at 60. GET responses are cached for 60 seconds (up to 200 entries), and a successful write clears the cache. `readOnly` refuses non-GET requests. `rateLimit()` reports the last response's headers.
- `src/actions.js`: one function per action, with input validation before anything is sent. Post links are parsed into ids. Search takes author and flair. Feeds can include subreddit info. Covers user activity, self-test, and all writes. The footer is appended to text posts, comments, and edits.
- `src/safety.js`: the write guard. Every write goes through `guard.run()`: spacing, a 24-hour duplicate check on text, and the hourly cap. The log at `<REDDIT_CLI_HOME>/writes.json` keeps SHA-256 fingerprints and timestamps only.
- `src/rss.js`: public Atom feed fallback, read-only, no client ID.
- `src/glossary.js`: offline definitions for `reddit_explain`.
- `src/scopes.js`: the scope catalog and the requested set.
- `src/store.js`: keychain access through `@napi-rs/keyring`.
- `scripts/build-mcpb.js`: builds the extension: copies `src/` minus the CLI, writes a package.json with `"type": "module"`, installs production dependencies, writes the manifest (platform from the host, user config as shown), validates, and packs.
- `scripts/rate-limit-check.js`: the live rate-limit probe.
- `tests/`: `node:test`. `helpers.js` and `fake-client.js` are the fakes. `mcp.test.js` runs the stdio server and `http.test.js` runs the HTTP server.

## Rules that shape the code

- Official API with the user's own OAuth grant, or the password grant the user opts into. No scraping, no undocumented web, mobile, or GraphQL endpoints, no browser cookies, and no borrowed client IDs. The RSS fallback is the one exception, and it is public and read-only.
- Never store the Reddit password. Password mode reads it from the environment, every time, and never writes it. Secrets are never logged or returned in tool results.
- Send the descriptive User-Agent. Never spoof another client or a browser.
- Votes and subscriptions are single actions on a target the user names. No loops, batch voting, or automatic engagement. The guard and confirmations are backstops, not permission.
- No moderation, no direct messages, and no reports. Those would need scopes this project does not request.
- The HTTP server requires a bearer token and binds to localhost by default. The Claude Desktop extension runs locally so credentials stay on the user's machine.
- Don't use Reddit content for model training, and don't keep content users have deleted.

## Git and GitHub

- The repository has a git history. Commit messages end with the line `by FiredMosquito831`.
- `.gitignore` excludes `node_modules/`, `.remember/` (plugin state), `.env`, `*.log`, and `dist/`.
- The GitHub repository was created with the `gh` CLI as private. Publishing it is a separate decision.

## Open questions

- A client ID is required for any live call. Reddit reportedly closed self-service app creation in November 2025, and new access goes through its Developer Support form. Apps created before then still work.
- A Reddit changelog dated October 8, 2026 reportedly stops accepting new public API applications on October 31, 2026, and ends public API access in March 2027. The search summaries could not be checked against the page, so verify before relying on the public API.
- Once a client ID exists, verify in this order: `reddit-cli login`, `reddit-cli test`, then a `--dry-run`, then one real post to a sandbox subreddit. Check each newly imported read against a live account, then install the extension in Claude Desktop.
- Believed but unverified: saved and overview listings need `history`, and edit and delete need `edit`. The `morechildren` verb (GET here, matching jordanburke's code) is unverified against PRAW.
- The Claude Desktop extension is untested in Claude Desktop itself, and it is unsigned.
- Chat and Reddit Answers appear to be outside the public API. This is unconfirmed.
- Reddit is reportedly steering developers toward Devvit and has a 2026 app migration program. Read those terms before depending on the public API long term.
