# MCP server

`reddit-api-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It exposes Reddit as 32 tools that Claude, or any MCP client, can call. It has two transports:

- **stdio** (the default). The host starts the server as a child process and talks to it over standard input and output. Claude Desktop and Claude Code do this. Stdio also exposes 11 local profile/browser helpers.
- **HTTP**. The server listens on a port, and every request must carry a bearer token. Use this for hosted setups, or for clients that connect over HTTP. HTTP exposes exactly the 32 Reddit tools.

The two transports differ on purpose. The browser and replay backends, the profile registry, and the
local helpers are available only to a local stdio process (and the CLI). HTTP, Docker, and the Claude
Desktop extension are API-only. See [browser-mode.md](browser-mode.md) and [deployment.md](deployment.md).

## Start it

```
npm run mcp                        # local stdio with browser/profile helpers
node src/mcp.js --api-only         # stdio with exactly the 32 API tools (bundle mode)
npm run mcp:http                   # HTTP, needs REDDIT_MCP_TOKEN
node src/mcp.js --generate-token   # prints a token for HTTP mode
```

`--api-only` is what the Claude Desktop bundle manifest uses: it registers the 32 Reddit tools and
never imports the local profile/browser helper modules or Playwright. Starting a bundle that lacks
those modules without the flag also degrades to this API-only surface instead of failing to start.

The stdio server prints nothing to standard output except protocol messages. Its startup message goes to standard error, so logs do not corrupt the stream.

## Connect Claude Desktop

Claude Desktop reads MCP servers from its configuration file, `claude_desktop_config.json`. Open Claude Desktop's developer settings to edit it. The file location depends on your version, so use the settings screen rather than a hard-coded path.

Add an entry. Use the absolute path to `src/mcp.js` in your checkout:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "node",
      "args": ["C:/path/to/reddit-api-mcp/src/mcp.js"],
      "env": {
        "REDDIT_AUTH_MODE": "oauth",
        "REDDIT_CLIENT_ID": "your-client-id",
        "REDDIT_USERNAME": "your-username"
      }
    }
  }
}
```

Restart Claude Desktop. The `reddit` server should show its tools. Add `REDDIT_REFRESH_TOKEN` to `env` if you do not want to use the keychain. For `password` or `app` mode, also add `REDDIT_AUTH_MODE`, `REDDIT_CLIENT_SECRET`, and (for `password`) `REDDIT_PASSWORD`.

The environment values in this file are readable by anyone who can read the file. For a shared machine, prefer the Claude Desktop extension, which keeps secrets in the keychain. See [extension.md](extension.md).

Named profiles and the experimental browser/replay backends need a local stdio server started from
your checkout (or the CLI) with access to `REDDIT_CLI_HOME` and an explicitly installed Playwright.
The Claude Desktop extension and HTTP distributions are API-only.

## Connect Claude Code

Claude Code adds servers with `claude mcp add`. Pass the environment with `-e`, then the command after `--`:

```
claude mcp add reddit \
  -e REDDIT_AUTH_MODE=oauth \
  -e REDDIT_CLIENT_ID=your-client-id \
  -e REDDIT_USERNAME=your-username \
  -- node /absolute/path/to/reddit-api-mcp/src/mcp.js
```

The `-e` values appear in your shell history. Keep the secret out of it: set `REDDIT_CLIENT_SECRET` and `REDDIT_REFRESH_TOKEN` in your shell environment instead, and omit the `-e` for them. Claude Code passes its own environment to the server.

## Connect over HTTP

Start the server with a token:

```
REDDIT_MCP_TOKEN=<token> npm run mcp:http
```

It listens on `http://127.0.0.1:3000/mcp`. Each request needs:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

This sends a protocol `initialize` request:

```
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer $REDDIT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Without the token you get `401`. Only `POST /mcp` is served. Other paths return `404`, and other methods return `405`. The server is stateless: every request is handled on its own, so it does not hold a session between calls.

HTTP exposes exactly the 32 Reddit tools. A `profile` or `backend` input that asks for `replay` or
`browser` is rejected as unsupported before any browser or registry work; no local helper is
registered. See [deployment.md](deployment.md).

The server binds to `127.0.0.1` by default. Anyone who can reach its port can act on the account, so keep it on localhost, or put it behind a TLS-terminating proxy with access control. See [deployment.md](deployment.md).

## Writes and confirmations

Application-level confirmation is **off by default for all 11 write tools, including deletes**, in
every transport and backend. That is an intentional change from older versions. Host permission
prompts remain independent and should stay on for write tools.

- `confirm: true` is optional evidence. It can make one call stricter. It is never proof of a user
  approval, and it cannot turn off a stored policy.
- A profile can require a global or per-tool confirmation. Then the call needs a trusted local
  approval, which MCP cannot mint. The CLI records it with a terminal prompt. A call without it fails
  with `APPROVAL_REQUIRED` before anything is sent.
- `reddit_settings_propose` records a settings proposal. It does not approve or apply it and returns
  no transferable approval secret. A person applies it with
  `reddit-cli profile approve-settings <proposal>`.
- Every write still passes the same account-level durable boundary as the CLI: spacing, duplicate
  check, hourly cap, one reservation, and one dispatch. See
  [how-it-works.md](how-it-works.md#the-write-boundary).

## Profile and backend inputs

Read and write tools accept two optional inputs:

| Input | Meaning |
|---|---|
| `profile` | Profile alias or id. Defaults to the saved default profile. No profile is chosen silently. |
| `backend` | `auto`, `api`, `replay`, or `browser`. `auto` follows the profile's preference over enabled backends. |

The selected profile, account, credential generation, and policy generation freeze at call entry. A
saved-default change affects later calls only. `auto` falls back only for an unsupported or
pre-dispatch-unavailable implementation. It never routes around an auth denial, throttle, CAPTCHA,
account restriction, or an unknown write outcome.

Paged reads also accept `continuation`, an opaque token from a previous browser-backed page. It is not
an API `after` cursor, and mixing the two is rejected. This build refuses to resume a continuation
with `CONTINUATION_INVALID` (`continuation_resume_unverified`) rather than silently re-reading page
one; no production token is produced today.

Results keep the legacy action data and add safe metadata: profile alias, verified username, backend,
completeness, `missingFields`, outcome, attempt id, cursor kind, and an optional UI continuation.
Secrets, page objects, cookies, and raw errors never appear.

## Local helpers (stdio only)

These 11 tools manage local profiles and browser tasks. They return no secrets, no home paths, and no
approval tokens. HTTP does not register them.

| Tool | Inputs | What it does |
|---|---|---|
| `reddit_profiles_list` | none | Lists aliases and the saved default. |
| `reddit_profile_current` | `profile` | The profile a call would use, its selection source, backends, and bound account state. |
| `reddit_profile_default_set` | `profile` (string or null) | Sets or clears the saved default. Operational configuration, not a security approval. |
| `reddit_settings_get` | `profile` | Non-secret runtime settings and the effective approval policy. |
| `reddit_settings_propose` | `profile`, `patch` | Records a settings proposal for trusted local approval. Never approves, applies, or returns an approval token. |
| `reddit_browser_status` | `profile` | Playwright/browser/profile diagnostics and open tasks. Never installs or downloads. |
| `reddit_browser_open` | `profile`, `visibility` | Opens an explicitly enabled browser profile, visible by default, and starts one bounded observation task. |
| `reddit_browser_observe` | `task_id`, `kind` (`page` or `controls`), `assist` | Returns a bounded, redacted observation. Sign-in or security screens require a human handoff. |
| `reddit_browser_step` | `task_id`, `observation_id`, `step`, `args` | Runs one allowlisted step: `navigate`, `scroll`, `sort`, `expand_branch`, or `prepare_field`. No arbitrary click, evaluate, or fetch. |
| `reddit_browser_handoff` | `task_id`, `reason` | Marks the task as waiting for a person. No solve or retry. |
| `reddit_browser_close` | `task_id`, `profile` | Closes one task, or every task and the browser session for a profile. |

Sampling is optional and off unless the server is configured to use it. The ordinary page/controls
observation is the baseline and works without sampling. No verified claim is made about Claude Code
sampling support.

## Try it first

Start with `test_reddit_mcp_server`. It makes one public read, and a `whoami` when the mode has a user, and it reports each check. If it passes, the connection and the credentials work.

## Tool reference

Parameters marked **required** must be given. A parameter without a default is optional. All read and
write tools also accept the optional `profile` and `backend` inputs described above; paged reads also
accept `continuation`.

### Reading

| Tool | Parameters | What it does |
|---|---|---|
| `get_me` | none | The logged-in account's name and karma. |
| `browse_subreddit` | `subreddit` **required**; `sort` (`hot`, `new`, `top`, `rising`, `controversial`; default `hot`); `time` (`hour`, `day`, `week`, `month`, `year`, `all`; for `top` and `controversial`); `limit` (1–100; default 25); `after`; `include_info` (boolean; default `false`) | Posts in a subreddit, with a cursor for paging. `include_info` adds the subreddit's details. |
| `get_top_posts` | `subreddit` **required**; `time` (default `day`); `limit` (default 10); `after` | Top posts in a subreddit for a time range. |
| `get_subreddit_info` | `subreddit` **required** | Subscriber count, title, and description. |
| `get_subreddit_rules` | `subreddit` **required** | The subreddit's rules. |
| `get_post_flairs` | `subreddit` **required** | The post flairs the subreddit offers. |
| `get_trending_subreddits` | `limit` (default 5) | Reddit's popular subreddits, the closest public list to trending. |
| `search_reddit` | `query` (default empty); `subreddit`; `sort` (`relevance`, `hot`, `top`, `new`, `comments`; default `relevance`); `time` (default `all`); `limit` (default 25); `type` (`link`, `sr`, `user`; default `link`); `author`; `flair`; `after` | Searches posts across Reddit, or inside one subreddit. |
| `get_reddit_post` | `post_id` **required**; `subreddit` | One post, without comments. Accepts a fullname, a bare id, or a reddit.com link. |
| `get_post_comments` | `post_id` **required**; `subreddit`; `sort` (`confidence`, `top`, `new`, `controversial`, `old`, `qa`; default `confidence`); `limit` (1–500; default 100); `depth` (1–10) | The comments on a post, threaded, plus the ids of the collapsed branches (`moreIds`). |
| `get_more_comments` | `post_id` **required** (a `t3_` fullname); `comment_ids` **required** (1–100 ids) | Expands collapsed branches named by `get_post_comments`. |
| `get_user_info` | `username` **required** | Karma, account age, and flags for a user. |
| `get_user_posts` | `username` **required**; `sort` (`hot`, `new`, `top`, `controversial`; default `new`); `time` (default `all`); `limit` (default 25); `after` | A user's posts. |
| `get_user_comments` | `username` **required**; `sort` (default `new`); `time` (default `all`); `limit` (default 25); `after` | A user's comments. |
| `user_analysis` | `username` **required** | A summary: karma, a sample of recent posts and comments, and the subreddits the user is most active in. |
| `get_my_overview` | `limit` (default 25); `after` | Your own posts and comments, newest first. Needs `history`. |
| `get_my_saved` | `limit` (default 25); `after` | Your saved posts and comments. Needs `history`. |
| `list_my_subreddits` | `limit` (default 100) | The subreddits you have joined. |
| `browse_subreddit_rss` | `subreddit` **required**; `sort` (default `hot`); `limit` (default 25) | A public feed with no Reddit app needed. Read-only, and without scores or comment counts. |
| `reddit_explain` | `term` **required** | A plain-language meaning for a Reddit term. Offline. |
| `test_reddit_mcp_server` | none | Checks the configuration: a public read, and a `whoami` where the mode has a user. |

### Writing

Every tool in this table accepts optional `confirm`, `profile`, and `backend` inputs. `confirm: true`
can only make the call stricter; it is not proof of approval. Application-level confirmation is off
by default; a profile may require a trusted local approval.

| Tool | Parameters | What it does |
|---|---|---|
| `create_post` | `subreddit` **required**; `title` **required**; `text` or `url` (give exactly one) | Submits a text post or a link post. |
| `reply_to_post` | `parent` **required** (`t3_` or `t1_`); `text` **required** | Replies to a post or a comment. |
| `edit_post` | `fullname` **required** (`t3_`); `text` **required** | Replaces the text of your own post. |
| `edit_comment` | `fullname` **required** (`t1_`); `text` **required** | Replaces the text of your own comment. |
| `delete_post` | `fullname` **required** (`t3_`) | Deletes your own post. This cannot be undone. |
| `delete_comment` | `fullname` **required** (`t1_`) | Deletes your own comment. This cannot be undone. |
| `save_content` | `fullname` **required** | Saves a post or comment. |
| `unsave_content` | `fullname` **required** | Removes a post or comment from your saved items. |
| `vote_on_thing` | `fullname` **required**; `direction` **required** (`up`, `down`, `clear`) | Votes on one post or comment, or clears your vote. |
| `subscribe_to_subreddit` | `subreddit` **required** | Joins a subreddit. |
| `unsubscribe_from_subreddit` | `subreddit` **required** | Leaves a subreddit. |

All 32 tools: 21 read and 11 write. The raw `api` command is in the CLI only. It is not exposed over MCP, because it could reach any endpoint.

## Tips for using these tools with Claude

- Ask for `test_reddit_mcp_server` first, and fix anything it reports before you ask for more.
- For a long thread, call `get_post_comments`, then `get_more_comments` with the `moreIds` it returned.
- Paging works the same way everywhere. Pass the `after` value from the last result to get the next page.
- Keep the host's approval prompt on for the write tools. Read every proposed text before you approve it.
