# Configuration

Configuration has two layers:

- **Environment variables**, read by the process. They cover the official API, safety, caching, and
  HTTP hosting.
- **Local named profiles**, managed by `reddit-cli profile`. They cover account identity, API
  credentials, enabled backends, visibility, and confirmation policy.

Environment variables can be set in your shell, in the configuration of your MCP host, or in a
`.env` file loaded with `--env-file-if-exists=.env`.

```
node --env-file-if-exists=.env src/cli.js whoami
node --env-file-if-exists=.env src/mcp.js --http
```

`--env-file-if-exists` is a Node flag (Node 22.9 and newer). It reads the file when it exists, and
quietly continues when it does not. Variables already set in the shell win over the file.

Keep `.env` out of version control. The repository ignores it, and `.env.example` lists every setting
without real values.

## Required for the official API route

| Variable | Meaning |
|---|---|
| `REDDIT_CLIENT_ID` | Your Reddit app's client ID. Any mode. |
| `REDDIT_USERNAME` | The Reddit account the tool acts for. 3 to 20 letters, digits, `_` or `-`. A leading `u/` is removed. Used in the User-Agent, and checked at login. |

The environment path remains an isolated legacy profile. It never supplies credentials to a named
profile. Browser and replay operations require a named, enrolled profile and do not read these values.

## Auth

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_AUTH_MODE` | `oauth` | `oauth`, `password`, or `app`. See [Auth modes](#auth-modes). |
| `REDDIT_CLIENT_SECRET` | empty | The app's secret. Required for `password` and `app`. Used for script and web apps. Leave it empty for installed apps. |
| `REDDIT_PASSWORD` | empty | Your Reddit password. Required for `password`. With two-factor on, write `password:CODE`. |
| `REDDIT_REFRESH_TOKEN` | empty | An OAuth refresh token supplied directly. When set, the keychain is not used, and nothing is written. |
| `REDDIT_REDIRECT_URI` | `http://localhost:8080` | The redirect URI registered with the app. Must match exactly. |
| `REDDIT_SCOPES` | the nine scopes | Space- or comma-separated scopes to request at login. A change needs a new `login`. See [security.md](security.md#scopes). |
| `REDDIT_USER_AGENT` | `node:reddit-cli:0.1.0 (by /u/<username>)` | Replaces the User-Agent this tool sends. Keep it descriptive. |

### Auth modes

**`oauth`** (default). The app is an installed app, with no secret. `reddit-cli login` runs a one-time
browser approval. The refresh token is stored in the OS keychain under the service `reddit-cli`, with
the lowercase username as the account. Access tokens last about an hour, and the tool refreshes them
itself. The password is never stored. Use this unless you have a reason not to.

**`password`**. The app is a script app, and it has a secret. Your password is read from
`REDDIT_PASSWORD` for each token request. Nothing is written to disk, and no refresh token is kept.
`reddit-cli login` in this mode checks the credentials and stores nothing. This mode trades a real
risk for convenience: anything that can read the environment can read your password. Read
[security.md](security.md#password-mode) first.

**`app`**. The app is a script or web app, with a secret. The tool gets a token that acts as the app,
not as you. It reads public data and refuses every write before anything is sent. Login is not needed.

## Named profiles

A profile is one expected Reddit account with its own public app metadata, OS-store secret
references, enabled backends, and policy. Profiles live under `REDDIT_CLI_HOME`:

```
<home>/profiles.json                         registry and the single saved default
<home>/profiles/<opaque-id>/metadata.json    non-secret profile record
<home>/profiles/<opaque-id>/browser/         dedicated browser profile directory
<home>/accounts/<account-key-hash>/          write ledger, attempts, cache generation
<home>/locks/                                profile and registry ownership
```

Commands:

```
reddit-cli profile add work --username alice
reddit-cli profile list
reddit-cli profile default work
reddit-cli profile default --clear
reddit-cli profile status work
reddit-cli profile configure work --enable-backends api,replay,browser --preference api,replay,browser
reddit-cli profile configure work --visibility visible
reddit-cli profile credentials work --password-login on
reddit-cli profile approve-settings <proposal>
reddit-cli profile logout work
reddit-cli profile remove work
```

Profile fields that affect behavior:

| Field | Default | Meaning |
|---|---|---|
| `enabledBackends` | `[api]` | Backends that may run for this profile. Enabling `replay` or `browser` is an explicit experimental opt-in. |
| `backendPreference` | `[api]` | Order used by `--backend auto`; the dispatcher still filters by enablement and operation capability. |
| `visibility` | `visible` | `visible`, `headless`, or `ask`. Applied at the next safe launch, never mid-write. |
| `confirmations` | `{}` | Per-profile global/per-tool confirmation map. An empty map uses the runtime default (off). |
| `passwordLoginEnabled` | `false` | Opt-in stored-password browser re-login. Requires local approval to enable. |

The runtime `readRuntimeSettings()` defaults confirmations to `global: 'off'` plus `off` for each of
the 11 write tools. A profile map can turn some or all of them on; the dispatcher unions policy from
the runtime settings and the frozen profile snapshot and rejects unknown keys before dispatch.

### Precedence

1. An explicit `--profile` or tool-call `profile`.
2. The saved default profile.
3. The environment-only legacy profile, when no named registry is configured.
4. Otherwise `PROFILE_REQUIRED`, with a safe list of aliases. The tool never picks the first profile.

The profile snapshot, account, backend, credential generation, and policy generation are frozen at
call entry. Changing the default affects later calls only. A changed credential/security generation
cancels a queued write before dispatch.

### Backend selection

`--backend` accepts `auto`, `api`, `replay`, `browser`. `auto` tries the profile's preference order
over enabled backends (default `api`, `replay`, `browser`). Fallback happens only for an unsupported
or pre-dispatch-unavailable implementation, never for a configured-invalid credential, denied scope,
throttle, CAPTCHA/security challenge, account restriction, or unknown write. RSS is a separate
public read and is not part of `auto`.

## Confirmations

This is an intentional change from earlier versions: application-level confirmation is **off by
default for all 11 write tools, including `delete_post` and `delete_comment`**, on every backend and
for the environment-only legacy path. Host permission prompts remain independent and should stay on
for writes.

- `confirm: true` in MCP, `--confirm` in the CLI, or `requestConfirmation` is optional evidence. It
  can make one call stricter. It never satisfies a required policy and is never proof of user
  approval.
- `--yes` is accepted for compatibility. It skips a prompt that those older flows used to show; it
  does not weaken a stored or requested confirmation policy.
- A required confirmation needs an interactive terminal and a trusted local approval record bound to
  profile, account, tool, target hash, content hash, policy generation, and expiry. Without a
  terminal the write fails with `APPROVAL_REQUIRED` and nothing is sent.
- MCP cannot mint an approval. `reddit_settings_propose` records a proposal; a person applies it with
  `reddit-cli profile approve-settings <proposal>`.
- Every write still passes the shared durable write admission boundary: spacing, duplicate check,
  hourly cap by account, and one dispatch. Those are not confirmations and cannot be disabled.

## Safety

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLI_SAFE_MODE` | `standard` | `standard` or `strict`. See the table below. |
| `REDDIT_CLI_MAX_WRITES_PER_HOUR` | per mode | Overrides the hourly cap. A whole number of at least 1. |
| `REDDIT_CLI_BOT_FOOTER` | empty | Empty turns the footer off. `auto` adds `I am a bot, posted with reddit-cli.` Any other text is used as the footer. Applied to posts, comments, and edits. |

| Mode | Gap between writes | Writes per hour |
|---|---|---|
| `standard` | 2 seconds | 30 |
| `strict` | 5 seconds | 10 |

Identical text, ignoring case and extra spaces, is refused for 24 hours. The per-account ledger at
`<home>/accounts/<key>/attempts.json` keeps hashes, timestamps, and outcomes only, never the text.
How the boundary works: [how-it-works.md](how-it-works.md#the-write-boundary).

## Performance and retries

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLI_CACHE` | `on` | `on` keeps GET responses for 60 seconds. `off` sends every read to Reddit. Writes invalidate the account cache. |
| `REDDIT_CLI_MAX_RETRIES` | `3` | How many times to retry a throttled read. `0` turns retries off. Mutations are never retried through another backend. |

## Storage and HTTP

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLI_HOME` | `~/.reddit-cli` | Registry, profiles, ledgers, locks, and caches. Use a temporary directory in tests. |
| `REDDIT_MCP_TOKEN` | required for `--http` | The bearer token every HTTP request must carry. Create one with `node src/mcp.js --generate-token`. |
| `REDDIT_MCP_HOST` | `127.0.0.1` | The address the HTTP server binds to. Set `0.0.0.0` only inside a container. |
| `REDDIT_MCP_PORT` | `3000` | The HTTP port. |

HTTP, Docker, and the `.mcpb` bundle are API-only. They do not load Playwright, open a browser
profile, or serve the local helper tools. See [deployment.md](deployment.md) and
[extension.md](extension.md).

## Playwright

Playwright is an optional peer pinned to `^1.64.1`, dynamically imported only by browser features.
API, RSS, and offline tools do not need it. It is never installed by a tool call or by `doctor`. The
exact explicit install commands are in [browser-mode.md](browser-mode.md#install-playwright-optional-explicit).

## Placeholders

Some hosts fill settings from their own configuration, and they can leave the placeholder text in
place when the user left a field empty. For example, a value can arrive as the literal text
`${user_config.refresh_token}`. The tool treats any value that is only a placeholder as empty. A
leftover placeholder can never become a token, a password, or a footer.

## Validation

The tool checks the environment when a command starts, and reports the first problem it finds:

- `REDDIT_AUTH_MODE must be oauth, password, or app.`
- `REDDIT_CLIENT_ID` or `REDDIT_USERNAME` missing or malformed, when the API route is used.
- `REDDIT_AUTH_MODE=password` without `REDDIT_PASSWORD`, or `password` and `app` without
  `REDDIT_CLIENT_SECRET`.
- `REDDIT_CLI_SAFE_MODE` other than `standard` or `strict`.
- Numbers that are not whole numbers in range.

`readRuntimeSettings` and `readLegacyApiConfig` are separate: runtime settings work without API
credentials so a browser-only profile or an offline command can start. The full list of messages is
in [troubleshooting.md](troubleshooting.md).

## Example `.env` for each mode

**oauth:**

```
REDDIT_CLIENT_ID=abc123def456
REDDIT_USERNAME=your_username
```

**password:**

```
REDDIT_AUTH_MODE=password
REDDIT_CLIENT_ID=abc123def456
REDDIT_CLIENT_SECRET=secret-from-the-app-card
REDDIT_USERNAME=your_username
REDDIT_PASSWORD=your-password-or-password:123456
```

**app:**

```
REDDIT_AUTH_MODE=app
REDDIT_CLIENT_ID=abc123def456
REDDIT_CLIENT_SECRET=secret-from-the-app-card
REDDIT_USERNAME=your_username
```

The values above are examples. Use your own, and never commit them.
