# Configuration

Every setting comes from the environment. Set them in your shell, in the configuration of your MCP host, or in a `.env` file loaded with `--env-file-if-exists=.env`.

```
node --env-file-if-exists=.env src/cli.js whoami
node --env-file-if-exists=.env src/mcp.js --http
```

`--env-file-if-exists` is a Node flag (Node 22.9 and newer). It reads the file when it exists, and quietly continues when it does not. Variables already set in the shell win over the file.

Keep `.env` out of version control. The repository ignores it, and `.env.example` lists every setting without real values.

## Required

| Variable | Meaning |
|---|---|
| `REDDIT_CLIENT_ID` | Your Reddit app's client ID. Any mode. |
| `REDDIT_USERNAME` | The Reddit account the tool acts for. 3 to 20 letters, digits, `_` or `-`. A leading `u/` is removed. Used in the User-Agent, and checked at login. |

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

**`oauth`** (default). The app is an installed app, with no secret. `reddit-cli login` runs a one-time browser approval. The refresh token is stored in the OS keychain under the service `reddit-cli`, with the lowercase username as the account. Access tokens last about an hour, and the tool refreshes them itself. The password is never stored. Use this unless you have a reason not to.

**`password`**. The app is a script app, and it has a secret. Your password is read from `REDDIT_PASSWORD` for each token request. Nothing is written to disk, and no refresh token is kept. `reddit-cli login` in this mode checks the credentials and stores nothing. This mode trades a real risk for convenience: anything that can read the environment can read your password. Read [security.md](security.md#password-mode) first.

**`app`**. The app is a script or web app, with a secret. The tool gets a token that acts as the app, not as you. It reads public data and refuses every write before anything is sent. Login is not needed.

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

Identical text, ignoring case and extra spaces, is refused for 24 hours. The write log at `~/.reddit-cli/writes.json` keeps fingerprints and timestamps only, never the text. How the guard works: [how-it-works.md](how-it-works.md#the-write-guard).

## Performance and retries

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLI_CACHE` | `on` | `on` keeps GET responses for 60 seconds. `off` sends every read to Reddit. Writes always clear the cache. |
| `REDDIT_CLI_MAX_RETRIES` | `3` | How many times to retry a throttled request. `0` turns retries off. |

## Storage and HTTP

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLI_HOME` | `~/.reddit-cli` | Where `writes.json` lives. |
| `REDDIT_MCP_TOKEN` | required for `--http` | The bearer token every HTTP request must carry. Create one with `node src/mcp.js --generate-token`. |
| `REDDIT_MCP_HOST` | `127.0.0.1` | The address the HTTP server binds to. Set `0.0.0.0` only inside a container. |
| `REDDIT_MCP_PORT` | `3000` | The HTTP port. |

## Placeholders

Some hosts fill settings from their own configuration, and they can leave the placeholder text in place when the user left a field empty. For example, a value can arrive as the literal text `${user_config.refresh_token}`. The tool treats any value that is only a placeholder as empty. A leftover placeholder can never become a token, a password, or a footer.

## Validation

The tool checks the environment when a command starts, and reports the first problem it finds:

- `REDDIT_AUTH_MODE must be oauth, password, or app.`
- `REDDIT_CLIENT_ID` or `REDDIT_USERNAME` missing or malformed.
- `REDDIT_AUTH_MODE=password` without `REDDIT_PASSWORD`, or `password` and `app` without `REDDIT_CLIENT_SECRET`.
- `REDDIT_CLI_SAFE_MODE` other than `standard` or `strict`.
- Numbers that are not whole numbers in range.

The full list of messages is in [troubleshooting.md](troubleshooting.md).

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
