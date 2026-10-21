# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`reddit-api-mcp`: a Node.js client for Reddit that acts for the user's own account, in four forms: a command-line tool (`src/cli.js`), an MCP server over stdio or Streamable HTTP (`src/mcp.js`), a Docker image for the HTTP server, and a Claude Desktop extension (`.mcpb`). Three backends can carry the same 32 tools: the official API (preferred), experimental request replay, and an experimental rendered Playwright UI. The feature set is ported from jordanburke/reddit-mcp-server, karanb192/reddit-mcp-buddy, and adhikasp/mcp-reddit (credited in `NOTICE.md`). It is plain JavaScript (ES modules), not TypeScript.

The repository is `FiredMosquito831/reddit-api-mcp` on GitHub. It was created private and made public on 2026-10-20.

## Commands

- `npm test`: `node --test` over `tests/`. Everything runs offline: fake transport/session/keyring/browser modules, a spawned stdio server, a real HTTP server on an ephemeral port, and temporary `REDDIT_CLI_HOME` directories. Nothing contacts Reddit or the real `~/.reddit-cli`.
- `node src/cli.js --help`, or `npm link` once and then `reddit-cli --help`.
- `npm run mcp` (stdio, for Claude Desktop or Claude Code) and `npm run mcp:http` (Streamable HTTP, needs `REDDIT_MCP_TOKEN`).
- `node src/mcp.js --generate-token`: prints a random bearer token for HTTP mode.
- `npm run mcpb`: builds `dist/reddit-api-mcp.mcpb` for the platform it runs on. The bundle is API-only: it excludes the CLI modules and the browser/replay backends, and never includes Playwright.
- `npm run rate-limit`: sends a few live reads with the cache off, and prints Reddit's rate-limit headers. Needs a working API setup.
- `docker build -t reddit-api-mcp .` and `docker compose up -d`: the API-only HTTP server on `127.0.0.1:3000`.
- `reddit-cli login|logout|token` accept `--profile <name>` to act on a named profile instead of the environment keychain entry.
- `reddit-cli scopes`: every OAuth scope, whether login requests it, and why the rest are omitted. Needs no configuration.
- Profiles: `profile add|list|default|status|configure|approve-settings|credentials|logout|remove`.
- Browser: `browser doctor` (read-only), `browser setup --install-package --install-browser` (explicit install only), `browser login <name>` (manual visible enrollment).
- All reads/writes accept `--profile` and `--backend auto|api|replay|browser`. Git Bash rewrites a leading `/` in arguments; prefix commands with `MSYS_NO_PATHCONV=1` when passing API paths.

## Environment

- `REDDIT_CLIENT_ID` and `REDDIT_USERNAME` are required for the environment-only official-API route, not for browser-only or offline commands. `readRuntimeSettings` and `readLegacyApiConfig` are separate.
- `REDDIT_AUTH_MODE`: `oauth` (default), `password`, or `app`.
- `REDDIT_CLIENT_SECRET`: required for `password` and `app`, and for script and web apps.
- `REDDIT_PASSWORD`: required for `password`.
- `REDDIT_REFRESH_TOKEN`: an OAuth refresh token supplied directly. Nothing is written when it is set.
- `REDDIT_REDIRECT_URI` (default `http://localhost:8080`), `REDDIT_SCOPES` (overrides the requested set), `REDDIT_USER_AGENT` (overrides the User-Agent).
- `REDDIT_CLI_SAFE_MODE` (`standard` or `strict`), `REDDIT_CLI_MAX_WRITES_PER_HOUR`, `REDDIT_CLI_BOT_FOOTER` (`auto`, custom text, or empty), `REDDIT_CLI_CACHE` (`on` or `off`), `REDDIT_CLI_MAX_RETRIES` (default 3), `REDDIT_CLI_HOME` (default `~/.reddit-cli`).
- `REDDIT_MCP_TOKEN` (required for HTTP), `REDDIT_MCP_HOST` (default `127.0.0.1`), `REDDIT_MCP_PORT` (default 3000).
- A setting still holding template text such as `${user_config.refresh_token}` counts as empty. This guards against a host that leaves unfilled settings unexpanded.
- Profiles, enabled backends, preference order, visibility, and confirmation policy are local profile settings, not environment variables.

## Auth modes

- `oauth`: installed-app authorization-code flow. The authorize URL carries `duration=permanent`, and the `state` is checked. The refresh token goes to the OS keychain (environment entry or named profile), or comes from `REDDIT_REFRESH_TOKEN`. Reddit may issue a new refresh token on each refresh, so the newest one is kept for the process and written back when the tool owns it; an environment token is never written. `logout` revokes whichever token is in use. The password is never stored.
- `password`: script-app password grant. The password is read from the environment on every token request and is never stored by this project. This is an opt-in trade-off, documented in the README.
- `app`: client-credentials grant. Read-only public data. The session refuses writes before anything is sent.
- Browser password re-login is a separate, explicit opt-in stored in the OS credential store after a local approval; it is never an environment or MCP argument.

## Status

- The full offline suite passes (see the latest run in the plan's integration section). Live behavior is unverified because there is no Reddit client ID and no browser/account experiment is authorized.
- All three backends exist behind the dispatcher. API adapters are offline-tested. Replay mappings are finite and pinned to Apollo-Reborn commit `32745d3450f4291845220e0d9a6deee33ee6eacf`; browser adapters use synthetic fixtures. Every experimental row in `src/coverage.js` and `docs/backend-coverage.md` remains `implemented-offline-tested`, never `live-verified`. `summarizeCoverage().noAppComplete` is `false`.
- Docker image builds. The HTTP endpoint was smoke-tested in the container: `initialize` with the token succeeds, a request without it gets a 401, and `tools/list` answers with exactly the 32 API tools.
- The MCPB bundle builds (win32 here), validates, unpacks, and lists 32 tools over stdio with no raw `api` tool and no browser/replay/CLI modules. It has not been installed in Claude Desktop, and it is not signed.
- Known honest gaps: replay and browser both leave `get_post_flairs` unsupported; browser also cannot implement `get_more_comments`; UI paging is not an API cursor, and continuation resume is refused (`continuation_resume_unverified`) because no live next-page state exists.
- Endpoint paths and form fields were cross-checked against PRAW's `praw/endpoints.py` and call sites, and the read endpoints against jordanburke's code. reddit.com is unreachable from the dev tooling, so nothing was checked against Reddit's live reference.
- Logins made before the scope change have only the old scopes. Run `reddit-cli login` again to get `history` and `edit`.

## Scopes

- Login requests nine scopes: `identity`, `read`, `history`, `mysubreddits`, `subscribe`, `vote`, `submit`, `edit`, `save`. Each is needed by a shipped feature.
- `src/scopes.js` lists every scope with a decision and a reason. Omitted: `creddits`, `flair`, `livemanage`, the `mod*` scopes, `privatemessages`, `report`, `structuredstyles`, `wikiedit`, and `wikiread`.
- Don't request a scope unless a feature needs it. Add it with the feature, and update `src/scopes.js`.

## Architecture

- `src/cli.js`: commander wiring. `src/cli-profiles.js` holds profile commands and policy-aware write execution; `src/cli-browser.js` holds doctor/setup/enrollment. These are the modules that prompt or print.
- `src/mcp.js`: entry point. Stdio by default, `--http` for Streamable HTTP, `--generate-token` to print a token. It creates the process-scope continuation store and browser services.
- `src/mcp-server.js`: builds the MCP server with the deterministic inventory: 32 Reddit tools, plus 11 local helpers on stdio only. HTTP exposes exactly 32. Writes accept optional `confirm` evidence but default to no application confirmation; `src/approvals.js` and the dispatcher enforce any stricter profile policy. The raw `api` command is not exposed.
- `src/mcp-browser.js`: local profile/browser helper implementations. No install, login, or cookie export.
- `src/http.js`: stateless Streamable HTTP. A fresh server and transport per request, a bearer token compared in constant time, `/mcp` only, and API-only routing.
- `src/dispatch.js`: freezes the profile snapshot, account, policy generation, and backend at call entry; validates operations and policy before constructing a backend; allows fallback only for pre-dispatch unsupported/unavailable implementations. Exposes `continuationStore: boolean`.
- `src/operations.js`, `src/errors.js`, `src/validation.js`: 32-tool/11-write descriptors, canonical `OperationError` codes and outcomes, shared validators.
- `src/profiles.js`, `src/accounts.js`: authoritative `<REDDIT_CLI_HOME>/profiles.json` with one default; aliases for one verified account share an account key; independent credential/policy generations.
- `src/approvals.js`: global/per-tool confirmation policy, proposals, and single-use trusted local approvals.
- `src/attempts.js`, `src/write-boundary.js`: durable account admission (spacing, 24-hour duplicate, hourly cap, one reservation), `DISPATCHED` before the external action, `OUTCOME_UNKNOWN` on ambiguity, and per-account cache generation. Unknown writes are never retried.
- `src/backends/api.js`: official-API adapter. It derives kind/action/policy key from the operation descriptor and uses the shared boundary exactly once.
- `src/backends/replay.js`, `src/replay/{mappings,transport}.js`: finite allowlisted mappings, pinned evidence, per-write identity/modhash re-check, no generic proxy.
- `src/backends/browser.js`, `src/browser/{session,identity,steps,doctor}.js`, `src/browser/adapters/*`: dedicated profile ownership, verified identity, task-bound steps, bounded page model, fixture-tested read/write adapters.
- `src/continuations.js`, `src/coverage.js`: opaque account/backend-bound UI paging and the evidence ledger.
- `src/secure-fs.js`, `src/locks.js`: atomic replacement, Windows location/ACL checks, nonce-owned process leases.
- `src/secrets.js`, `src/migration.js`, `src/store.js`: profile OS-store refs, redaction, optional sealed state, explicit legacy import, keychain access.
- `src/session.js`, `src/config.js`: environment-only legacy account wiring and independent runtime settings.
- `src/oauth.js`: authorize URL, code exchange, refresh, revoke, password grant, and client-credentials grant.
- `src/client.js`: `request(method, path, {query, form})` against `https://oauth.reddit.com`. Takes an `obtainToken` source, refreshes a minute before expiry, retries reads once on 401, honors `Retry-After` and `x-ratelimit-*`, and handles RATELIMIT inside 200 bodies. Waits over 60 seconds become errors. A sliding one-minute window caps requests at 60. GET cache is 60 seconds (up to 200 entries); a mutation invalidates it. `readOnly` refuses non-GET. It rejects off-origin paths before sending.
- `src/actions.js`: one official-API function per action, with validation before anything is sent. Completion evidence is operation-specific; an empty response is not generic success.
- `src/safety.js`: legacy guard helpers retained for the environment path; new writes use the shared boundary.
- `src/rss.js`, `src/glossary.js`, `src/scopes.js`: public feed fallback, offline definitions, scope catalog.
- `scripts/build-mcpb.js`: builds the API-only extension: copies official-API source without CLI/browser/replay, writes a package.json with `"type": "module"`, installs production dependencies, writes the manifest, validates, and packs.
- `scripts/rate-limit-check.js`: the live rate-limit probe.
- `tests/`: `node:test`. `helpers.js`, `fake-client.js`, and `tests/fixtures/{browser,replay}/` are the fakes. `mcp.test.js` runs the stdio server, `http.test.js` the HTTP server, and `coverage.test.js` checks the ledger and documentation links.

## Rules that shape the code

- Prefer the official API with the user's own grant. The owner approved `docs/superpowers/specs/2026-10-21-browser-backends-design.md` and its implementation plan: narrowly permit experimental own-session replay and Playwright UI operations in explicitly enrolled, dedicated local profiles. Implement only evidenced operation mappings, not a generic private-endpoint proxy. No borrowed client IDs, harvesting everyday browser profiles, stealth/fingerprint spoofing, or bypass of challenges, locks, throttles, or permission denials. RSS remains a separate public read-only path.
- Legacy password mode keeps its environment-only behavior. Optional browser re-login may store a locally entered password in the OS credential store only after explicit local user opt-in. Session exports, if needed, must be encrypted with a separately protected key. Secrets never enter logs, prompts, screenshots, or tool results.
- Browser-backend implementation is authorized; live Reddit/account experiments, commits, and pushes still need separate authorization. All implementation/review delegates use Sonnet and the approved dynamic-workflow task ownership. Ordinary app-level confirmations default off with configurable global/per-action policy; trusted security-setting approvals and account-bound write guards remain mandatory. Never retry an uncertain write through another backend.
- Workflow preference from the owner: one encompassing dynamic workflow for a piece of work. Never run parallel dynamic workflows; encode parallel agents, dependencies, integration, reviews, and repairs inside a single coordinator. Already-running disjoint runs may finish if safe.
- Send the descriptive User-Agent. Never spoof another client or a browser.
- Votes and subscriptions are single actions on a target the user names. No loops, batch voting, or automatic engagement. The guard and confirmations are backstops, not permission.
- No moderation, no direct messages, and no reports. Those would need scopes this project does not request.
- The HTTP server requires a bearer token and binds to localhost by default. HTTP/Docker/MCPB are API-only; browser and replay are local CLI/stdio.
- Playwright is an optional peer (`^1.64.1`), dynamically imported, installed only by an explicit local setup command. Never install or download it from a tool call or doctor run.
- Don't use Reddit content for model training, and don't keep content users have deleted.

## Documentation

- `README.md`: the overview, quick starts, backend summary, and status.
- `docs/credentials.md`: every step to get a Reddit app and access, with links.
- `docs/configuration.md`: every setting, auth modes, profiles, backend selection, confirmation policy, and `.env`.
- `docs/cli.md` and `docs/mcp.md`: the command and tool references. The tool table and the 11 local helper names must match `src/mcp-server.js`; `tests/coverage.test.js` checks inventories and links.
- `docs/browser-mode.md`: Playwright setup, profile enrollment, replay vs UI, recovery, and teardown.
- `docs/backend-coverage.md`: the rendered evidence ledger from `src/coverage.js`; update both together.
- `docs/experiments/replay.md`, `docs/experiments/browser-ui.md`: pinned upstream evidence, mappings, steps, and the future live-experiment record.
- `docs/extension.md`, `docs/deployment.md`: the API-only extension and HTTP/Docker setup.
- `docs/how-it-works.md`, `docs/security.md`, `docs/troubleshooting.md`, `docs/development.md`.
- `.env.example` lists every setting without values. Load a `.env` with `node --env-file-if-exists=.env`.

## Git and GitHub

- The repository has a git history. Commit messages end with the line `by FiredMosquito831`.
- `.gitignore` excludes `node_modules/`, `.remember/` (plugin state), `.env`, `*.log`, and `dist/`.
- The GitHub repository is public. It was created private with the `gh` CLI and made public on 2026-10-20, by the owner's decision.
- Pre-existing untracked `.claude/` and `bash.exe.stackdump` are preserved and never staged by a broad `git add -A`.

## Open questions

- A client ID is required for any live API call. Reddit reportedly closed self-service app creation in November 2025, and new access goes through its Developer Support form. Apps created before then still work.
- A Reddit changelog dated October 8, 2026 reportedly stops accepting new public API applications on October 31, 2026, and ends public API access in March 2027. The search summaries could not be checked against the page, so verify before relying on the public API.
- Once a client ID exists, verify in this order: `reddit-cli login`, `reddit-cli test`, then a `--dry-run`, then one real post to a sandbox subreddit. Check each newly imported read against a live account, then install the extension in Claude Desktop.
- Live replay/browser verification needs a separate, scoped authorization naming the profile/account, read targets, sandbox subreddit, allowed mutation count, and network-observation permission. None exists today. Every selector, cookie acceptance, and write commit path is unverified.
- Believed but unverified: saved and overview listings need `history`, and edit and delete need `edit`. The `morechildren` verb (GET here, matching jordanburke's code) is unverified against PRAW.
- UI continuation issuance is wired, but no production token is produced and resume always refuses. Implementing real resume needs a live page that yields next-page state.
- The Claude Desktop extension is untested in Claude Desktop itself, and it is unsigned.
- Chat and Reddit Answers appear to be outside the public API. This is unconfirmed.
- Reddit is reportedly steering developers toward Devvit and has a 2026 app migration program. Read those terms before depending on the public API long term.
