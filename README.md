# reddit-api-mcp

Control your own Reddit account from the command line or from Claude. Read feeds, search, open threads and their comments, post, reply, edit, delete, vote, join and leave subreddits, and save items.

It ships four ways to run:

- `reddit-cli`: a command-line tool.
- `reddit-api-mcp`: an MCP server, over stdio for Claude Desktop and Claude Code, or over Streamable HTTP behind a bearer token.
- A Docker image for the HTTP server.
- A Claude Desktop extension (`.mcpb`), built with `npm run mcpb`.

The feature set is ported from [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server), [karanb192/reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy), and [adhikasp/mcp-reddit](https://github.com/adhikasp/mcp-reddit). See [NOTICE.md](NOTICE.md).

## Setup

1. Create a Reddit app at `https://old.reddit.com/prefs/apps/`, or ask Reddit's Developer Support if self-service is closed for your account. Use an **installed app** for the default `oauth` mode, which has no secret. Use a **script** app for `password` and `app` modes, which need the client secret. Set the redirect URI to `http://localhost:8080`.
2. Put the client ID (and the secret, for script apps) into your environment.
3. Pick an auth mode (below). Then run `node src/cli.js test` to check the configuration end to end.

Requires Node 22.12 or newer.

## Auth modes

| Mode | Set | Stores | Can write |
|---|---|---|---|
| `oauth` (default) | `REDDIT_CLIENT_ID`, `REDDIT_USERNAME`, then `reddit-cli login` | The refresh token in the OS keychain, or `REDDIT_REFRESH_TOKEN` if you set it | Yes |
| `password` | `REDDIT_AUTH_MODE=password`, `REDDIT_CLIENT_SECRET`, `REDDIT_PASSWORD` | Nothing | Yes |
| `app` | `REDDIT_AUTH_MODE=app`, `REDDIT_CLIENT_SECRET` | Nothing | No (read-only, public data) |

**Password mode is a real security trade-off.** Your Reddit password sits in an environment variable for as long as the process runs. Anything that can read the environment can read it. Prefer `oauth`, which never holds your password. With two-factor on, put `:CODE` after the password.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `REDDIT_CLIENT_ID` | required | Your Reddit app's client ID |
| `REDDIT_USERNAME` | required | Your Reddit username (used in the User-Agent) |
| `REDDIT_CLIENT_SECRET` | empty | Required for `password` and `app`, and for script and web apps |
| `REDDIT_AUTH_MODE` | `oauth` | `oauth`, `password`, or `app` |
| `REDDIT_PASSWORD` | empty | Required for `password` |
| `REDDIT_REFRESH_TOKEN` | empty | An OAuth refresh token supplied directly (nothing is stored) |
| `REDDIT_REDIRECT_URI` | `http://localhost:8080` | Must match the app's redirect URI |
| `REDDIT_SCOPES` | the nine scopes below | Overrides the requested scopes; a change needs a new login |
| `REDDIT_USER_AGENT` | `node:reddit-cli:<version> (by /u/<username>)` | Overrides the User-Agent |
| `REDDIT_CLI_SAFE_MODE` | `standard` | `standard` (2 s between writes, 30 writes an hour) or `strict` (5 s, 10 an hour) |
| `REDDIT_CLI_MAX_WRITES_PER_HOUR` | per mode | Overrides the hourly cap |
| `REDDIT_CLI_BOT_FOOTER` | off | `auto` adds a bot disclosure to posts, comments, and edits; any other text is used as the footer |
| `REDDIT_CLI_CACHE` | `on` | `off` sends every read to Reddit |
| `REDDIT_CLI_MAX_RETRIES` | `3` | Retries on throttling responses |
| `REDDIT_CLI_HOME` | `~/.reddit-cli` | Where the write log lives |
| `REDDIT_MCP_TOKEN` | required for HTTP | Bearer token for HTTP mode |
| `REDDIT_MCP_HOST` / `REDDIT_MCP_PORT` | `127.0.0.1` / `3000` | HTTP bind address and port |

A setting left as an unfilled template, such as `${user_config.refresh_token}`, counts as empty.

## Command line

```
reddit-cli login                      # oauth mode: approve in the browser, paste the address back
reddit-cli token                      # print the stored refresh token (for the Claude Desktop extension)
reddit-cli test                       # check the configuration end to end
reddit-cli whoami
reddit-cli feed node --sort top --time week --limit 5 --info
reddit-cli search "rust async" --subreddit rust --author alice
reddit-cli thread https://www.reddit.com/r/node/comments/abc123/
reddit-cli user alice                 # karma and account details
reddit-cli activity alice             # karma plus where they are active
reddit-cli explain karma
reddit-cli post node --title "Hello" --text "First post" --dry-run
reddit-cli comment t3_abc123 --text "Nice"
reddit-cli edit t1_abc123 --text "Corrected"
reddit-cli delete t1_abc123
reddit-cli vote t3_abc123 up
reddit-cli subscribe node
reddit-cli scopes                     # every scope, what login requests, and why the rest are left out
reddit-cli rss node                   # public feed, no login (read-only)
reddit-cli api GET /api/v1/me         # any GET or POST endpoint
```

Every write asks for confirmation unless you pass `--yes`, and `--dry-run` prints the request without sending it.

## MCP server

Claude Desktop or Claude Code, over stdio:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "node",
      "args": ["/absolute/path/to/reddit-api-mcp/src/mcp.js"],
      "env": {
        "REDDIT_AUTH_MODE": "oauth",
        "REDDIT_CLIENT_ID": "your-client-id",
        "REDDIT_USERNAME": "your-username"
      }
    }
  }
}
```

Over HTTP:

```
node src/mcp.js --generate-token     # prints a token; keep it secret
REDDIT_MCP_TOKEN=<token> npm run mcp:http
```

The endpoint is `http://127.0.0.1:3000/mcp`. Every request needs `Authorization: Bearer <token>`. It binds to localhost unless you set `REDDIT_MCP_HOST`, and anyone who can reach it can act on the account.

There are 32 tools: 21 reads (`browse_subreddit`, `search_reddit`, `get_reddit_post`, `get_post_comments`, `user_analysis`, `reddit_explain`, `test_reddit_mcp_server`, and more) and 11 writes. Every write needs `confirm: true`. The raw `api` escape hatch is CLI-only.

## Docker

```
docker build -t reddit-api-mcp .
docker compose up -d                  # listens on 127.0.0.1:3000
```

The container has no OS keychain, so use `password` or `app` mode, or `oauth` with `REDDIT_REFRESH_TOKEN`.

## Claude Desktop extension

```
npm run mcpb                          # writes dist/reddit-api-mcp.mcpb
```

Open the `.mcpb` file with Claude Desktop, or drag it onto the app, and fill in the settings it asks for. Claude Desktop stores the sensitive ones; they are not in the file. For `oauth` mode, run `node src/cli.js login` and then `node src/cli.js token` in this repo, and paste the token into **Refresh token**.

The extension runs on your machine on purpose: your credentials stay local instead of on a hosted server. The keychain binding is native, so build the bundle on each operating system you use. The bundle is not signed. Node 22.12 or newer is required.

## Scopes

Login requests nine scopes: `identity`, `read`, `history`, `mysubreddits`, `subscribe`, `vote`, `submit`, `edit`, `save`. Each one is needed by a feature. `reddit-cli scopes` lists the rest and says why they are left out.

## Development

```
npm test                 # offline: a fake fetch, a spawned MCP server, and a real HTTP server
npm run rate-limit       # sends a few live reads and prints Reddit's rate-limit headers
npm run mcpb             # builds the Claude Desktop extension bundle
```

## License

The project's code is written from scratch. The feature set and endpoint choices are credited in [NOTICE.md](NOTICE.md).
