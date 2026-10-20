# How it works

This page explains what happens inside the project: how a command or a tool call becomes a Reddit request, how logins work, and why the safety features exist.

## Overview

```
          ┌────────────── entry points ──────────────┐
          │  reddit-cli (src/cli.js)                 │
          │  reddit-api-mcp (src/mcp.js)             │
          │    stdio  |  HTTP + bearer token         │
          └───────────────────┬──────────────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ actions (src/actions.js)│   one function per action;
                 │ validate, then perform  │   checks input before any request
                 └────────────┬────────────┘
                              │ writes only
                 ┌────────────▼────────────┐
                 │ write guard             │   spacing, duplicates, hourly cap
                 │ (src/safety.js)         │   log: <home>/writes.json
                 └────────────┬────────────┘
                              │
                 ┌────────────▼────────────┐
                 │ Reddit client           │   tokens, sliding window,
                 │ (src/client.js)        │   retries, cache, read-only mode
                 └────────────┬────────────┘
                              │ HTTPS
              ┌───────────────┴────────────────┐
              ▼                                ▼
     oauth.reddit.com                 www.reddit.com
     (the API)                        (authorize, token, revoke, RSS)
```

Each layer has one job. The actions say what a request means. The guard decides whether a write may happen now. The client gets a valid token, respects Reddit's limits, and sends the request.

## The main files

| File | Role |
|---|---|
| `src/cli.js` | The command-line tool. The only file that prompts. |
| `src/mcp.js` | The MCP entry point: stdio by default, `--http`, and `--generate-token`. |
| `src/mcp-server.js` | Builds the MCP server and registers all 32 tools. |
| `src/http.js` | The stateless HTTP transport and the bearer-token check. |
| `src/session.js` | Builds one account's client, guard, and actions, and picks the token source for the auth mode. |
| `src/config.js` | Reads and checks the environment. |
| `src/oauth.js` | The authorize URL, the code exchange, refresh, revoke, and the password and app grants. |
| `src/client.js` | Requests to the API: tokens, the sliding window, retries, the cache, and read-only mode. |
| `src/actions.js` | One function per action, with input checks. |
| `src/safety.js` | The write guard and its log. |
| `src/store.js` | The OS keychain, through `@napi-rs/keyring`. |
| `src/rss.js` | The public RSS fallback and its parser. |
| `src/scopes.js` | The scope catalog, and the set login requests. |
| `src/glossary.js` | Definitions for `reddit_explain` and `reddit-cli explain`. |

## Request lifecycle

Take `reddit-cli feed node --limit 5` as the example.

1. **Parse.** Commander reads the command and its options.
2. **Configure.** `loadConfig()` reads the environment. A missing or malformed setting stops the command here, with a message naming it.
3. **Open a session.** The session builds the token source for the auth mode, the client, the guard, and the actions.
4. **Validate.** `actions.feed` checks the subreddit name, the sort, the limit, and the time range. Anything wrong is rejected before a request is made.
5. **Request.** The client builds the URL on `https://oauth.reddit.com`, gets a valid access token, waits for a free slot in the sliding window, and sends the request with the bearer token and the User-Agent.
6. **Handle the response.** Throttling is retried. A 401 triggers one token refresh and one retry. Failures become `RedditError`s with Reddit's status and details.
7. **Shape.** The actions turn Reddit's listing into a small object, with the fields people use.
8. **Print.** The CLI prints a line per item, or JSON. The MCP server returns the same object as the tool result.

A write adds the guard between steps 4 and 5, and clears the cache after step 6.

## OAuth flows

### `oauth` (installed app, the default)

**Login (once):**

1. `reddit-cli login` makes a random `state` value, and builds the authorize URL: `https://www.reddit.com/api/v1/authorize` with `client_id`, `response_type=code`, `state`, `redirect_uri`, `duration=permanent`, and `scope` (the requested scopes, space-separated).
2. You open the URL, sign in, and click **Allow**.
3. Reddit redirects the browser to `redirect_uri` with `?code=…&state=…`. The page fails to load, because nothing listens there. That is expected.
4. You paste that address back. The tool checks that `state` matches the one it made, and reads `code`. An `error` parameter ends the login with a message.
5. The tool exchanges the code at `https://www.reddit.com/api/v1/access_token`, with `grant_type=authorization_code`, the code, and the redirect URI. It authenticates with HTTP Basic: the client ID, then a colon, then the secret. An installed app has no secret, so the password part is empty.
6. Reddit answers with an access token (valid about an hour), and with a refresh token because the request asked for `permanent`.
7. The tool stores the refresh token in the keychain, then asks Reddit who the token belongs to. If that name is not `REDDIT_USERNAME`, the tool removes the token and stops.

**Every later run:**

1. When the client needs a token, it uses the cached access token if that token has more than a minute left. Otherwise it refreshes: `grant_type=refresh_token`, with the newest refresh token it knows.
2. If Reddit returns a new refresh token, the tool keeps it in memory for the rest of the process, and writes it to the keychain. A token from `REDDIT_REFRESH_TOKEN` is never written anywhere.
3. A 401 from the API forces one refresh and one retry.

**Logout:** the tool posts the refresh token to `https://www.reddit.com/api/v1/revoke_token`, then removes it from the keychain.

### `password` (script app)

The client asks for a token with `grant_type=password`, the username, and the password, authenticated with the client ID and secret. The response has an access token and no refresh token. The tool asks again when the token runs out. Your password is read from the environment each time, and it is never written by this project. With two-factor authentication on, the password is `password:CODE`, and the code must be current when the token is requested.

### `app` (script or web app)

The client asks for a token with `grant_type=client_credentials`, authenticated with the client ID and secret. The token belongs to the app, not to you. Reads of public data work. The client is in read-only mode, so every non-GET request is refused before anything is sent.

## Token lifecycle

| Event | What happens |
|---|---|
| The token has more than 60 seconds left | The cached token is used. |
| The token is missing, or has 60 seconds or less left | A refresh (oauth) or a fresh grant (password, app) runs first. |
| The API answers 401 | One forced refresh, then one retry. |
| Reddit returns a new refresh token | The newest one is kept; the keychain copy is updated when the tool owns it. |
| The process restarts | The tool starts from the keychain, or from `REDDIT_REFRESH_TOKEN`. |

## Rate limits and retries

The client keeps its own sliding window. It sends at most 60 requests in any rolling minute. When the window is full, it waits for the oldest request to age out.

Reddit's answers are respected too:

- **`x-ratelimit-remaining` of 0** sets a pause until `x-ratelimit-reset` seconds have passed.
- **HTTP 429** waits for `Retry-After` seconds, or `x-ratelimit-reset`, or 60 seconds if neither is given.
- **A RATELIMIT error inside a 200 response** (write endpoints report throttling this way) waits for the time in the message, such as "try again in 3 minutes".
- A wait of **60 seconds or less** is slept through, and the request is retried. A longer wait is not slept through. The error tells you how many seconds to wait.
- The number of attempts is `REDDIT_CLI_MAX_RETRIES` plus one, so 4 by default.

The last rate-limit headers are available through `client.rateLimit()`. `npm run rate-limit` prints them, with the cache off, so you can see your real budget.

## Caching

GET responses are cached for 60 seconds, keyed by the full URL including its query. The cache holds up to 200 entries, and evicts the oldest first. Any successful write clears the whole cache, so a read after a write is never stale. Set `REDDIT_CLI_CACHE=off` to turn it off.

The cache matters most for the long-running MCP server. Each CLI command is its own process, so it starts with an empty cache.

## The write guard

Every write goes through `guard.run()`, in this order:

1. **Hourly cap.** Writes in the log from the last hour are counted. At the cap, the write is refused, with the limit and the setting to raise it.
2. **Duplicate check.** If the write has text, the text is normalized (trimmed, lowercased, spaces collapsed) and hashed with SHA-256. If the same hash was written in the last 24 hours, the write is refused. The check covers every subreddit, so the same text posted in two places is caught.
3. **Spacing.** The guard waits until 2 seconds have passed since the last write (5 in strict mode).
4. **Perform.** The request is sent.
5. **Record.** Only after success, the tool appends the hash and the timestamp to the log. A failed write is not recorded, so it does not use up the cap.

The log is `writes.json` in `REDDIT_CLI_HOME` (default `~/.reddit-cli`). It keeps at most 500 entries, and never the text.

The limits are per mode. Standard allows 30 writes an hour, with 2 seconds between them. Strict allows 10, with 5 seconds. Neither mode has an "off" switch.

## Confirmation and dry runs

- **CLI:** each write prints a question, and waits for `y`. `--yes` skips it. Without a terminal, a write fails unless `--yes` is given.
- **`--dry-run`:** prints the request as JSON, and sends nothing.
- **MCP:** every write tool needs `confirm: true`. A call without it is refused before anything is sent.

## The MCP server

The server has the same tools whichever transport you use. `src/mcp-server.js` registers them with zod schemas, which the MCP SDK turns into the input schemas that clients see.

**stdio** is the default. The host starts `node src/mcp.js` and talks over standard input and output. Standard error carries the startup message, so logs cannot corrupt the stream.

**HTTP** is stateless Streamable HTTP. Each `POST /mcp` builds a fresh server and transport, handles one request, and closes them. The bearer token is compared in constant time. The server binds to `127.0.0.1` unless told otherwise, and it serves only `/mcp`.

## Scopes

Login asks Reddit for nine scopes. Each is needed by a feature:

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

`src/scopes.js` lists every scope in PRAW's source, plus `creddits`, each with a decision and a reason. `reddit-cli scopes` prints the same table. The reasons for omission are covered in [security.md](security.md#scopes).

## Storage and files

| Where | What | Notes |
|---|---|---|
| OS keychain, service `reddit-cli`, account = lowercase username | The OAuth refresh token | Windows Credential Manager on Windows, Keychain on macOS, libsecret on Linux. |
| `<REDDIT_CLI_HOME>/writes.json` | Fingerprints and timestamps of recent writes | Never the text. Deleting it resets the duplicate check and the hourly count. |
| Environment variables | Secrets in password, app, or environment-token setups | Visible to processes that can read the environment. |
| `.env` (you create it) | The same settings, for the CLI and the HTTP server | Git-ignored. The tool reads it through Node's `--env-file-if-exists`. |
| `dist/` | The extension bundle | Git-ignored. |

## What is sent to Reddit

- **Hosts:** `oauth.reddit.com` for the API, and `www.reddit.com` for the authorize, token, and revoke endpoints, and for the public RSS feed.
- **Headers:** the bearer token, and the User-Agent `node:reddit-cli:<version> (by /u/<username>)`. Reddit's rules ask for a descriptive User-Agent, and this one names the app and the account it acts for.
- **Bodies:** only what the action needs. Writes are form-encoded, and they set `api_type=json`, so Reddit answers in JSON.

## The extension build

`npm run mcpb` runs `scripts/build-mcpb.js`:

1. Clears `dist/mcpb`.
2. Copies every file in `src/` except `cli.js` into `dist/mcpb/server/src`.
3. Writes `dist/mcpb/server/package.json` with `"type": "module"` and the runtime dependencies, without `commander`.
4. Runs `npm install --omit=dev` in the server folder, and removes the lockfile it creates.
5. Writes `manifest.json`: the server entry point, the mapping from the user's settings to environment variables, the settings themselves, and the platform of this build.
6. Validates the manifest with `@anthropic-ai/mcpb`, and packs `dist/reddit-api-mcp.mcpb`.

## Design decisions

- **Browser login over a stored password.** `oauth` never asks for your password, and it can be revoked from the CLI. The password mode exists because two projects ported it, and it is opt-in for that reason.
- **One set of actions, two front ends.** The CLI and the MCP server call the same functions, so their behavior cannot drift apart.
- **Guards in the write path, not the UI.** A write has to pass the guard, whichever front end sends it.
- **Stateless HTTP.** There are no sessions to leak or to expire, and each request carries its own credential.
- **Plain JavaScript.** No build step is needed to run the tool. The only compiled code is the native keychain binding, which ships prebuilt.
- **JSON out.** Objects are printed as JSON, and lists as one item per line, so both people and scripts can use the output.
