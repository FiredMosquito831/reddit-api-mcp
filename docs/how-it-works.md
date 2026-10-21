# How it works

This page explains what happens inside the project: how a command or a tool call becomes a Reddit
action, how profiles and backends are selected, how logins work, and why the safety features exist.

## Overview

```
          ┌────────────── entry points ──────────────┐
          │  reddit-cli (src/cli.js)                 │
          │  reddit-api-mcp (src/mcp.js)             │
          │    stdio: 32 tools + 11 local helpers    │
          │    HTTP: 32 tools, API-only, bearer      │
          └───────────────────┬──────────────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ dispatcher (src/dispatch)│  freeze profile, account,
                 │ operation + backend      │  policy, and backend per call
                 └────────────┬────────────┘
                              │ reads / writes
        ┌─────────────────────┼─────────────────────────────┐
        ▼                     ▼                             ▼
  api backend           replay backend               browser backend
  (src/backends/api)    (finite mappings,            (rendered UI,
  official OAuth        profile cookie jar)          Playwright)
        │                     │                             │
        └─────────────────────┼─────────────────────────────┘
                              │ writes only
                 ┌────────────▼────────────┐
                 │ write boundary          │  durable attempt, spacing,
                 │ (src/write-boundary.js) │  duplicates, hourly cap,
                 └────────────┬────────────┘  one dispatch, cache generation
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
             oauth.reddit.com      www.reddit.com
             (official API)        (authorize, token, revoke, RSS,
                                    replay, rendered UI)
```

Each layer has one job. The dispatcher resolves the profile and operation once. A backend says how the
action is performed. The shared write boundary decides whether a mutation may happen now and records
its outcome. The official-API client gets a valid token and respects Reddit's limits.

The dispatcher rebuilds a cached backend when a profile's credential or policy generation changes, so
a visibility or backend change applies at the next call. The rendered-UI backend serializes all
operations for one profile, holds that queue from write preparation through the one commit, and
registers each whole operation with the shared task registry; a concurrent call cannot navigate the
page under a commit recheck, and an idle/close sweep sees a queued write as busy.

## The main files

| File | Role |
|---|---|
| `src/cli.js` | The command-line tool. |
| `src/cli-profiles.js` | Profile commands, policy-aware write execution, local approvals. |
| `src/cli-browser.js` | Browser doctor, explicit setup, and manual enrollment. |
| `src/mcp.js` | The MCP entry point: stdio by default, `--http`, and `--generate-token`. |
| `src/mcp-server.js` | The stable inventory: 32 Reddit tools, plus 11 stdio helpers. |
| `src/mcp-browser.js` | Local profile and browser helper behavior. |
| `src/http.js` | Stateless HTTP transport and the bearer-token check. |
| `src/dispatch.js` | Frozen profile/account/backend selection and operation routing. |
| `src/operations.js` | Operation descriptors, the 32 tool names, and policy keys. |
| `src/errors.js` | `OperationError`, canonical codes, and outcome states. |
| `src/profiles.js` | Named-profile registry, saved default, and generations. |
| `src/accounts.js` | Verified account identity and shared account keys. |
| `src/approvals.js` | Global/per-tool policy and trusted local approval records. |
| `src/attempts.js` | Durable admission, outcomes, and per-account cache generation. |
| `src/write-boundary.js` | The one guarded write path every backend uses. |
| `src/continuations.js` | Opaque, account/backend-bound UI paging tokens. |
| `src/coverage.js` | The evidence ledger behind `docs/backend-coverage.md`. |
| `src/backends/{api,replay,browser}.js` | Backend adapters. |
| `src/replay/` | Finite mappings and the allowlisted request transport. |
| `src/browser/` | Session ownership, identity, doctor, task steps, and UI adapters. |
| `src/config.js` | Runtime settings and strict legacy API configuration. |
| `src/oauth.js` | The authorize URL, code exchange, refresh, revoke, and grants. |
| `src/client.js` | Official-API requests: tokens, sliding window, retries, cache. |
| `src/actions.js` | Official-API action functions, with input checks. |
| `src/session.js` | The environment-only legacy account wiring. |
| `src/secure-fs.js`, `src/locks.js` | Atomic files, Windows protection, process-owned locks. |
| `src/secrets.js`, `src/migration.js`, `src/store.js` | OS-store refs, explicit import, keychain. |
| `src/rss.js` | The public RSS fallback and its parser. |
| `src/scopes.js`, `src/glossary.js` | Scope catalog and offline definitions. |

## Request lifecycle

Take `reddit-cli feed node --limit 5 --profile work --backend auto` as the example.

1. **Parse.** Commander reads the command and its options.
2. **Settings.** `readRuntimeSettings()` reads safety, cache, and other process settings. It does not
   require API credentials, so a browser-only profile or an offline command can start.
3. **Resolve.** The dispatcher freezes the explicit profile, or the saved default, or the isolated
   legacy profile. If none applies it returns `PROFILE_REQUIRED`.
4. **Describe and validate.** `describeOperation` normalizes the tool and arguments and checks them
   before any backend work.
5. **Select.** `auto` builds the enabled backend order from the profile preference (default `api`,
   `replay`, `browser`) and asks capabilities. A backend is replaced only before dispatch, and only
   for an unsupported or unavailable implementation.
6. **Probe identity.** Authenticated work verifies the account; a profile record alone is not proof.
7. **Read.** The backend returns legacy-shaped data plus safe metadata: backend, profile alias,
   username, completeness, `missingFields`, outcome, and possibly a UI continuation.
8. **Print.** The CLI prints a line per item, or JSON. The MCP server returns the data and additive
   structured metadata.

A write inserts the shared write boundary between steps 4 and 7. The CLI may also request a trusted
local approval before calling the dispatcher, based on the profile policy.

## Profiles and account binding

A profile is a non-secret registry record plus OS-store secret references. Its snapshot contains
`enabledBackends`, `backendPreference`, `visibility`, `confirmations`, `passwordLoginEnabled`, and
independent credential and policy generations. The registry holds one `defaultProfileId`; it never
duplicates mutable metadata in a second file.

A verified account gets an `accountKey`. Two aliases for the same verified account share one key, and
therefore one write ledger, duplicate/quota state, and cache generation. A changed browser identity
blocks authenticated work; it never silently rebinds. A legacy write history is associated only
through an explicit, verified import.

## The write boundary

Every mutation goes through `createWriteBoundary().run()`, in this order:

1. **Policy and approval.** A required confirmation needs a trusted local approval bound to profile,
   account, tool, target hash, content hash, policy generation, and expiry. `confirm: true` is not an
   approval.
2. **Reserve.** A durable attempt is recorded under the account lock: spacing slot, duplicate check,
   hourly cap. Text is hashed, never stored. Unknown or in-flight duplicates block.
3. **Prepare.** The backend validates the target and prepares locally; no external mutation happens.
   Rendered-UI post and comment writes are scoped to the named target element, and a missing target is
   unsupported rather than a page-wide control.
4. **Mark.** The attempt becomes `DISPATCHED` (as `WAITING_FOR_USER` if a human step is needed) before
   the final network send or UI commit.
5. **Commit.** Exactly one dispatch. The boundary never retries a mutation through another backend.
6. **Settle.** A definite rejection is `FAILED_KNOWN`; an ambiguous or lost response is
   `OUTCOME_UNKNOWN`. Success and unknown both bump the account cache generation.

An unknown write keeps its budget and duplicate state until read-only reconciliation or explicit user
resolution. `profile attempts` lists it, and `profile resolve <name> <attempt-id> succeeded|failed`
records what a person verified without resending it. A restart cannot turn it into a new write. Spacing uses the account-level slot, not a
per-process clock, so two profiles for one account cannot bypass it.

## Confirmations and dry runs

- **Default.** Application-level confirmation is off for all 11 write tools, including deletes, on
  every backend and the legacy path. This intentionally changes older behavior.
- **CLI.** If the profile policy requires it, the CLI prints the target and risks and asks locally.
  Without a terminal it fails with `APPROVAL_REQUIRED` and sends nothing. `--confirm` requests the
  same local approval for one call. `--yes` is compatibility only.
- **`--dry-run`.** Prints the request and sends nothing. It creates no attempt.
- **MCP.** `confirm: true` is optional evidence only. A required policy needs a local approval that MCP
  cannot mint; `reddit_settings_propose` only records a proposal.

## Official API flows

### `oauth` (installed app, the default)

**Login (once):**

1. `reddit-cli login` makes a random `state` value, and builds the authorize URL:
   `https://www.reddit.com/api/v1/authorize` with `client_id`, `response_type=code`, `state`,
   `redirect_uri`, `duration=permanent`, and `scope`.
2. You open the URL, sign in, and click **Allow**.
3. Reddit redirects to `redirect_uri` with `?code=…&state=…`. The page fails to load, as expected.
4. You paste the address back. The tool checks `state`, reads `code`, and rejects an `error`.
5. It exchanges the code at `https://www.reddit.com/api/v1/access_token` with HTTP Basic
   authentication, using the client ID and an empty secret for an installed app.
6. Reddit answers with an access token and, because of `permanent`, a refresh token.
7. The refresh token goes to the keychain (environment entry or named profile), then the tool verifies
   the account matches the expected username. A mismatch removes the token and stops.

**Every later run:** the cached access token is used while it has more than a minute left; otherwise
the client refreshes with the newest refresh token. A rotated refresh token is kept for the process
and written back when the tool owns it; an environment token is never written. A 401 forces one
refresh and one retry for reads.

**Logout:** the tool asks Reddit to revoke the refresh token, then removes the local copy.

### `password` (script app)

The client requests a token with `grant_type=password`, the username, and the password, authenticated
with the client ID and secret. There is no refresh token. Your password is read from the environment
for each request and never written by this project. With 2FA the value is `password:CODE`, and the
code must be current.

### `app` (script or web app)

The client requests `grant_type=client_credentials`. The token belongs to the app, not to you. Public
reads work. The session is read-only, and every non-GET request is refused before anything is sent.
An app-only identity is never promoted into a browser user session to enable a write.

## Token lifecycle

| Event | What happens |
|---|---|
| More than 60 seconds left | The cached token is used. |
| Missing or 60 seconds or less | A refresh (oauth) or a fresh grant (password, app) runs first. |
| A read gets 401 | One forced refresh, then one retry. |
| A write gets 401/429/RATELIMIT | No automatic resend; classify and report. A preflight token refresh is still allowed. |
| Reddit returns a new refresh token | The newest one is kept; the keychain copy is updated when the tool owns it. |
| The process restarts | The tool starts from the keychain, a profile secret, `REDDIT_REFRESH_TOKEN`, or the grant mode. |

## Rate limits and retries

The client keeps a sliding window of at most 60 requests in any rolling minute. Reddit's answers are
respected: `x-ratelimit-remaining: 0` pauses until reset; 429 waits for `Retry-After` or the reset;
an in-body `RATELIMIT` is handled; waits over 60 seconds become errors. The number of read attempts is
`REDDIT_CLI_MAX_RETRIES` plus one. Mutations are never resent by the generic retry loop.

## Caching

GET responses are cached for 60 seconds, keyed by the full URL including query, up to 200 entries.
Any successful mutation invalidates the account cache. A per-account cache generation is durable and
shared across processes, so a write through one backend/profile invalidates same-account reads in
another. The cache never serves one account's response to another.

## The MCP server

The inventory is deterministic. It does not change because a default profile changed, Playwright is
missing, or login expired. Stdio registers the 32 Reddit tools plus 11 local helpers; HTTP registers
exactly the 32 Reddit tools and rejects browser/replay selection.

**stdio** is the default. The host starts the process and talks over standard input and output.
Standard error carries startup messages and logs, so the protocol stream stays clean.

**HTTP** is stateless Streamable HTTP. Each `POST /mcp` builds a fresh server and transport, handles
one request, and closes them. The bearer token is compared in constant time, only `/mcp` is served,
and the server binds to `127.0.0.1` by default.

## Browser and replay backends

A dedicated persistent Chromium profile per named profile owns the Reddit session. A process takes an
atomic local lock; a second process gets `PROFILE_IN_USE` instead of a second cookie copy. Identity is
verified before authenticated work, and a mismatch blocks.

- **Replay** sends only finite, pinned mappings to `https://www.reddit.com` with the profile's live
  cookie jar. It has no generic proxy. Reads may reuse a recent identity check for one minute; every
  write re-probes and re-reads the modhash immediately before its single mutation. The details are in
  [experiments/replay.md](experiments/replay.md).
- **Browser UI** uses task-bound observations and allowlisted steps (`navigate`, `scroll`, `sort`,
  `expand_branch`, `prepare_field`). It has no unrestricted click, evaluate, fetch, or cookie tool.
  Mutations commit only inside the shared boundary. See
  [experiments/browser-ui.md](experiments/browser-ui.md).

Neither backend is live-verified in this repository. The coverage ledger records that honestly.

## Scopes

Login asks Reddit for nine scopes, each needed by a feature:

| Scope | Used for |
|---|---|
| `identity` | `whoami`, `get_me`, and the account check at login |
| `read` | Feeds, posts, comments, search, users, rules, flairs, and popular subreddits |
| `history` | Your saved items and your overview |
| `mysubreddits` | Listing the subreddits you have joined |
| `subscribe` | Joining and leaving subreddits |
| `vote` | Votes |
| `submit` | Posts and comments |
| `edit` | Editing and deleting your own content |
| `save` | Saving and unsaving |

`src/scopes.js` lists every scope it knows, each with a decision and a reason. `reddit-cli scopes`
prints the same table. Omitted scopes are covered in [security.md](security.md#scopes).

Browser cookies are not OAuth scopes. An enrolled session may have more authority than this token;
treat the profile directory as a credential.

## Storage and files

| Where | What | Notes |
|---|---|---|
| OS keychain, service `reddit-cli`, account = lowercase username | The environment-path OAuth refresh token | Windows Credential Manager, macOS Keychain, or libsecret. |
| OS keychain, profile-specific service | Profile API secrets and an optional browser password | Values never enter the registry. |
| `<REDDIT_CLI_HOME>/profiles.json` and `profiles/<id>/` | Profile metadata and a dedicated browser directory | Non-secret metadata; the browser directory is sensitive. |
| `<REDDIT_CLI_HOME>/accounts/<key>/attempts.json` | Durable attempts, hashes, timestamps, outcomes | Never text or secrets. |
| `<REDDIT_CLI_HOME>/accounts/<key>/cache-generation.json` | Shared same-account cache generation | Cross-process invalidation. |
| `<REDDIT_CLI_HOME>/writes.json` | Legacy write-guard fingerprints | Migrated conservatively, never reassigned by guessing. |
| `<REDDIT_CLI_HOME>/locks/` | Profile and registry ownership | Non-secret PID/owner-nonce metadata. |
| Environment variables | Secrets in password, app, or environment-token setups | Visible to processes that can read the environment. |
| `.env` (you create it) | Settings for the CLI and HTTP server | Git-ignored. |
| `dist/` | The extension bundle | Git-ignored. |

## What is sent to Reddit

- **API:** `oauth.reddit.com`, with a bearer token and the descriptive User-Agent.
- **Replay:** only allowlisted `www.reddit.com` paths and methods, with the profile's own cookies; a
  write adds `X-Modhash` from the same session.
- **Browser:** normal HTTPS traffic from the dedicated Chromium profile.
- **RSS:** public `www.reddit.com` feeds, with no account.
- **Bodies:** only what the action needs. API writes are form-encoded with `api_type=json`.

## The extension build

`npm run mcpb` runs `scripts/build-mcpb.js`:

1. Clears `dist/mcpb`.
2. Copies the official-API source, excluding the CLI modules and the browser/replay backends.
3. Writes `dist/mcpb/server/package.json` with `"type": "module"` and the runtime dependencies,
   without `commander` or Playwright.
4. Runs `npm install --omit=dev` in the server folder, and removes the lockfile.
5. Writes `manifest.json`: the server entry point, environment mapping, settings, and platform.
6. Validates the manifest with `@anthropic-ai/mcpb`, and packs `dist/reddit-api-mcp.mcpb`.

The bundle is API-only by construction.

## Design decisions

- **Official API first.** It has real scopes, structured responses, and a supported path. Replay and
  the rendered UI are experimental additions for accounts without app credentials, not replacements.
- **One dispatcher, one write boundary.** Every backend uses the same frozen selection and the same
  durable mutation path, so behavior cannot drift and no route has an unguarded write.
- **Offline evidence is labeled.** The ledger never turns fixture tests into a live claim.
- **A profile is one account.** Aliases for the same verified account share limits; a conflicting
  identity blocks rather than merges.
- **Stateless HTTP, local browser.** HTTP has no session to leak; the browser backends stay on the
  local CLI/stdio distribution.
- **Plain JavaScript.** No build step is needed to run the tool. The only compiled code is the native
  keychain binding.
- **JSON out.** Objects print as JSON, lists one item per line, so people and scripts can both use it.
