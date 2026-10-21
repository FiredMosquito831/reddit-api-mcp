# Development

This page is for working on the code: the layout, the tests, the scripts, and how to add a feature.

## Requirements

- Node.js 22.12 or newer. Development runs on Node 24.
- Git.
- Docker, only if you build the image.

No TypeScript and no build step. The source is plain JavaScript with ES modules.

## Layout

```
src/
  cli.js           command-line tool
  cli-profiles.js  profile, settings-approval, and write commands
  cli-browser.js   browser doctor, explicit setup, manual enrollment
  mcp.js           MCP entry point (stdio, --http, --generate-token)
  mcp-server.js    stable tool inventory, 32 Reddit tools, 11 stdio helpers
  mcp-browser.js   local profile/browser helper implementation
  http.js          stateless HTTP transport, bearer token, API-only inventory
  session.js       legacy account wiring; token sources by auth mode
  config.js        runtime settings and strict legacy API configuration
  operations.js    operation descriptors, tool inventory, policy keys
  errors.js        OperationError and outcome constants
  validation.js    shared input validators
  dispatch.js      frozen profile/backend selection and operation routing
  profiles.js      named-profile registry, default, generations
  accounts.js      verified account identity and account keys
  secrets.js       profile OS-store refs and redaction
  migration.js     explicit legacy import
  approvals.js     global/per-tool policy and trusted local approvals
  attempts.js      durable account attempt ledger and cache generation
  write-boundary.js one guarded write boundary for every backend
  secure-fs.js     atomic writes and Windows protection checks
  locks.js         nonce-owned cross-process leases
  continuations.js opaque UI continuation tokens
  coverage.js      the evidence ledger behind docs/backend-coverage.md
  oauth.js         OAuth endpoints: authorize, token, refresh, revoke, password, app
  client.js        official-API client: tokens, sliding window, retries, cache
  actions.js       one official-API action per tool
  backends/
    api.js         official-API backend adapter
    replay.js      finite request-replay backend
    browser.js     rendered-UI backend façade
  replay/
    mappings.js    pinned, finite request mappings
    transport.js   destination/path/method allowlist and credential binding
  browser/
    doctor.js      Playwright/browser diagnostics and explicit setup
    session.js     dedicated profile lifecycle, ownership, identity, recovery
    identity.js    verified account identity
    steps.js       task-bound, allowlisted UI steps and bounded controls
    adapters/
      reads.js     rendered-UI read parsers
      writes.js    rendered-UI write prepare/commit
  safety.js        legacy write guard helpers
  store.js         OS keychain
  rss.js           public RSS feed
  scopes.js        scope catalog
  glossary.js      Reddit terms
  util.js          small helpers
tests/             node:test suites; fakes in helpers.js, fake-client.js, fixtures/
scripts/
  build-mcpb.js    builds the Claude Desktop extension (API-only)
  rate-limit-check.js
docs/              this documentation
Dockerfile, .dockerignore, docker-compose.yml
.env.example       the settings, without values
```

## Scripts

| Command | What it does |
|---|---|
| `npm test` | Runs every test suite. Offline. |
| `npm run mcp` | Starts the stdio MCP server. |
| `npm run mcp:http` | Starts the HTTP MCP server. Needs `REDDIT_MCP_TOKEN`. |
| `npm run mcpb` | Builds `dist/reddit-api-automation-mcp.mcpb`. |
| `npm run rate-limit` | Sends a few live reads and prints Reddit's rate-limit headers. Needs a working setup. |

## Tests

The suites use `node:test` and `node:assert/strict`. None of them contacts Reddit.

| Suite | Covers |
|---|---|
| `actions.test.js` | Feeds, subreddit info, submissions, comments, votes, subscriptions, saves, the raw request path |
| `reads.test.js` | Threads and comment trees, `morechildren`, search, user lookups, overview and saved, rules, flairs, popular, paging |
| `writes.test.js` | Edits, deletes, and where the footer is applied |
| `misc.test.js` | Post links, glossary, search by author and flair, feed info, user activity, self-test |
| `client.test.js` | Token refresh, the 401 retry, `Retry-After`, RATELIMIT in 200 bodies, the sliding window, path checks |
| `auth.test.js` | Password and app grants, token caching, read-only mode, retry limits, rate-limit headers |
| `session.test.js` | Rotating refresh tokens, keychain storage, the environment token, the password grant |
| `oauth.test.js` | Authorize URL, redirect parsing and state checks, token exchange, revoke |
| `safety.test.js` | Duplicate detection, spacing, the hourly cap, failed writes not counted |
| `cache.test.js` | GET caching, expiry, invalidation on writes, the TTL of zero |
| `config.test.js`, `config-auth.test.js`, `placeholders.test.js` | Validation of each setting and mode, and template placeholders |
| `rss.test.js` | The Atom parser, entity decoding, throttling and error paths |
| `scopes.test.js` | The requested set, and the `scopes` command |
| `mcp.test.js` | Starts the real stdio server, and lists its tools |
| `http.test.js` | Starts the real HTTP server, and checks authentication, the routes, and the API-only inventory |
| `cli.test.js` | Help, configuration errors, and dry runs, from the real CLI |
| `operations.test.js`, `runtime-settings.test.js` | Operation inventory and independent runtime settings |
| `profiles.test.js`, `accounts.test.js`, `profile-concurrency.test.js`, `profile-switching.test.js` | Registry, default, aliases, account keys, and frozen selection |
| `profile-secrets.test.js`, `profile-migration.test.js` | OS-store refs, redaction, sealed state, explicit legacy import |
| `approvals.test.js`, `security-proposals.test.js` | Default-off policy, local approvals, proposals |
| `attempts.test.js`, `write-boundary.test.js`, `write-concurrency.test.js` | Durable admission, spacing, duplicates, quota, unknown outcomes |
| `api-backend.test.js`, `mutation-outcomes.test.js`, `account-cache.test.js` | Official-API adapter and conservative mutation handling |
| `dispatch.test.js`, `backend-capabilities.test.js` | Backend selection, fallback eligibility, capability errors |
| `browser-doctor.test.js`, `browser-session.test.js`, `browser-recovery.test.js` | Dependency states, ownership, identity, recovery |
| `browser-reads.test.js`, `browser-writes.test.js`, `browser-steps.test.js`, `browser-redaction.test.js` | Rendered-UI adapters, task steps, redaction |
| `replay-mappings.test.js`, `replay-transport.test.js` | Finite mappings, allowlists, identity, write verification |
| `coverage.test.js` | Ledger completeness, honest statuses, docs inventory, relative links |
| `packaging.test.js` | MCPB bundle plan excludes browser/replay and Playwright |
| `locks.test.js`, `secure-fs.test.js` | Cross-process ownership and Windows protection |

All suites are offline. They inject fake transport/session/keyring/browser modules and use a
temporary `REDDIT_CLI_HOME`; none reads or writes the real `~/.reddit-cli`. A Windows junction ACL
test and a symlink test may skip where the platform or load makes them unreliable.

To run one file:

```
node --test tests/client.test.js
```

## Adding a read

1. **Add an action** in `src/actions.js`. Follow the existing ones: validate the input first, call `client.request`, then shape the result. Use `expectData` for listings. Do not print from inside an action.
2. **Register a tool** in `src/mcp-server.js` with `registerTool(name, description, shape, run)`. Describe each parameter with a zod schema, and keep the names clear. Add the tool's name to the expected list in `tests/mcp.test.js`.
3. **Add a command** in `src/cli.js`, if it belongs on the command line.
4. **Test it** in the suite that matches. Use `fakeClient` from `tests/fake-client.js`, and check the path, the query, and the shape of the result.
5. **Document it** in [mcp.md](mcp.md) and [cli.md](cli.md).

## Adding a write

Follow the read steps, and in addition:

- Add an operation descriptor in `src/operations.js`. The policy key is the exact tool name.
- Send the write through the dispatcher's shared write boundary (`src/write-boundary.js`). Do not
  create a second guard, and do not call a backend's `commitWrite` outside the boundary.
- Register it as a write, so the profile policy and the host can gate it. `confirm` is optional
  evidence, not authorization.
- In the CLI, use `executeCliWrite`; it resolves profile policy and requests a trusted local
  approval when one is required. Add `--dry-run` as well.
- Add API, replay, and browser coverage only for what actually exists. A transport or helper is not
  an operation.
- Update `src/coverage.js` and `docs/backend-coverage.md` together; `tests/coverage.test.js` checks
  that every ledger row appears in the document and that no experimental row claims `live-verified`.

## Adding a replay mapping

1. Inspect primary upstream source and pin an exact commit/ref. Record the mechanism, path, method,
   credential scope, response shape, and error semantics in `docs/experiments/replay.md`.
2. Add a finite mapping in `src/replay/mappings.js`. Never add a generic proxy, arbitrary path, or
   guessed private endpoint.
3. Add a synthetic fixture, not a real capture. Test allowlists, redirects, refusal, ambiguity,
   identity mismatch, and missing mappings.
4. Keep the status `evidenced-unverified`/`upstream-routable-unverified` until an authorized live
   experiment records a result. Do not infer write support from a successful read.

## Adding a browser adapter

1. Add one finite navigation plus a parser for the bounded page model. Do not add arbitrary clicks,
   `evaluate`, `fetch`, header editing, or cookie access.
2. Writes prepare before dispatch and commit exactly once through the shared boundary. A state that
   cannot be verified is refused, not assumed.
3. Extend `tests/fixtures/browser/` and the adapter tests. Record missing fields and unsupported
   parameters explicitly; return `null` with metadata, never a fabricated zero.
4. Update the ledger. Selectors stay unverified live until Task 16's authorized experiment. See
   [experiments/browser-ui.md](experiments/browser-ui.md).

## Playwright

Playwright is an optional peer, pinned in `package.json` as `^1.64.1`, and dynamically imported only
by browser code. Never add it as a dependency, never install it from a tool call or from doctor, and
keep it out of the HTTP/Docker/MCPB graph. `tests/packaging.test.js` checks the bundle plan.

## Coverage and evidence

`src/coverage.js` is the single ledger. Every original tool needs an entry per backend with status,
platform, check date, missing fields, blockers, unsupported parameters, and an evidence ref.
`summarizeCoverage().noAppComplete` stays `false` until every tool has a live-verified experimental
route or its natural offline/RSS route. Offline adapters do not satisfy that target.

## Adding a scope

1. Add the scope to `SCOPE_CATALOG` in `src/scopes.js`, with `requested: true` only when a shipped feature needs it. Give a reason in every case.
2. Update the scope count in the tests in `tests/scopes.test.js`.
3. Document it in [security.md](security.md#scopes) and [how-it-works.md](how-it-works.md#scopes).
4. Tell users that a new scope needs a new `login`.

## Conventions

- ES modules. Keep imports at the top, and use `node:` for built-ins.
- Errors from the API are `RedditError`s, with the status and the details. Errors from bad input are plain `Error`s with a message that names the problem.
- Never log or return a secret. Never write one to disk.
- Keep the actions free of output. The CLI and the MCP server are the only places that print.
- Use `Object.hasOwn` for lookups in plain objects.
- Keep the tests offline. Use the fakes, and avoid the network, the keychain, and real time.
- Documentation changes go with the code change they describe.

## Releasing

1. Update the version in `package.json` and in `VERSION` in `src/config.js`. They must match.
2. Run `npm test`.
3. Run `npm run mcpb` and check the output.
4. Build the image with `docker build -t reddit-api-automation-mcp .`, and run the check in [deployment.md](deployment.md#check-that-it-works).
5. Commit, then push. Commit messages in this repository end with the owner's attribution line.

## Dependencies

- `@modelcontextprotocol/sdk`: the MCP server and its transports (installed 1.32.1).
- `zod`: tool input schemas.
- `@napi-rs/keyring`: the OS keychain. It is native, so it ships per platform.
- `commander`: the command-line parser (CLI only; excluded from the extension).
- `@anthropic-ai/mcpb`: the extension packager (development only).
- `playwright`: an **optional peer** (`^1.64.1`), dynamically imported by browser features only. It is
  never a runtime dependency and is not bundled.

Run `npm audit` after you change dependencies, and keep the lockfile in the commit.
