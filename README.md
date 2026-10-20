# reddit-api-mcp

Control your own Reddit account from the command line or from Claude.

It reads feeds, searches, opens threads with their full comment trees, looks up users, and writes: posts, replies, edits, deletes, votes, joining and leaving subreddits, and saving items. Every write is guarded: it asks first, it can be previewed, and it is spaced and capped.

It runs four ways:

- **`reddit-cli`**, a command-line tool.
- **An MCP server**, `reddit-api-mcp`, over stdio for Claude Desktop and Claude Code, or over HTTP behind a bearer token.
- **A Docker image** for the HTTP server.
- **A Claude Desktop extension** (`.mcpb`), built with `npm run mcpb`.

The feature set is ported from [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server), [karanb192/reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy), and [adhikasp/mcp-reddit](https://github.com/adhikasp/mcp-reddit). See [NOTICE.md](NOTICE.md).

> **Status.** The code is tested offline (104 tests), and the Docker image and the extension bundle were built and checked locally. It has **not** been run against Reddit's live API yet, because it needs a Reddit app. See [Status and limits](#status-and-limits).

## Quick start

1. **Get a Reddit app and its credentials.** Follow [docs/credentials.md](docs/credentials.md). It has every step, every link, and what to do when self-service app creation is closed.
2. **Install.** Requires Node 22.12 or newer.
   ```
   npm install
   cp .env.example .env          # on Windows: copy .env.example .env
   ```
3. **Fill in `.env`.** At minimum `REDDIT_CLIENT_ID` and `REDDIT_USERNAME`. See [docs/configuration.md](docs/configuration.md).
4. **Log in** (default `oauth` mode). Approve in the browser and paste the address back:
   ```
   node --env-file-if-exists=.env src/cli.js login
   ```
5. **Check it works:**
   ```
   node --env-file-if-exists=.env src/cli.js test
   node --env-file-if-exists=.env src/cli.js whoami
   ```
6. **Try a write safely.** Preview first, then send it to a community you own:
   ```
   node --env-file-if-exists=.env src/cli.js post YOUR_TEST_SUB --title "Hello" --text "A test" --dry-run
   ```

## Documentation

| Document | What's in it |
|---|---|
| [docs/credentials.md](docs/credentials.md) | Every step to get a Reddit app, its client ID and secret, and access to the API, with links |
| [docs/configuration.md](docs/configuration.md) | Every setting, the three auth modes, safety modes, and `.env` |
| [docs/cli.md](docs/cli.md) | Every command, its options, and examples |
| [docs/mcp.md](docs/mcp.md) | Connecting Claude Desktop, Claude Code, and HTTP clients, plus the tool reference (all 32 tools) |
| [docs/extension.md](docs/extension.md) | Building and installing the Claude Desktop extension |
| [docs/deployment.md](docs/deployment.md) | Docker and HTTP deployment |
| [docs/how-it-works.md](docs/how-it-works.md) | Architecture: OAuth flows, rate limits, caching, the write guard, scopes, and storage |
| [docs/security.md](docs/security.md) | What is sensitive, where it lives, the threats, and the controls |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Error messages and what to do about them |
| [docs/development.md](docs/development.md) | Repository layout, tests, scripts, and how to add a tool |

## What it does

**Reading** (no writes):

- Feeds in any sort (`hot`, `new`, `top`, `rising`, `controversial`), with paging and optional subreddit details.
- Subreddit info, rules, post flairs, and Reddit's popular subreddits.
- Search across Reddit or inside a subreddit, filtered by author or flair.
- A post with its full comment tree, and "load more" expansion for collapsed branches. Accepts a post ID, a fullname, or a reddit.com link.
- A user's karma and account details, their posts and comments, and a summary of where they are active.
- Your own overview, your saved items, and the subreddits you have joined.
- A public RSS fallback that needs no Reddit app (read-only, no scores).
- A glossary of Reddit terms (karma, AMA, ELI5, and more). Works offline.

**Writing** (every write is guarded):

- Create text or link posts; reply to posts and comments; edit and delete your own posts and comments.
- Vote (up, down, or clear), join and leave subreddits, save and unsave.
- Confirmation before each write, `--dry-run` for previews, 2 seconds between writes (5 in strict mode), an hourly cap (30, or 10 in strict mode), and a 24-hour block on identical text.
- An optional bot disclosure footer on posts, comments, and edits.

**Connecting to Claude:** 32 MCP tools, 21 read and 11 write. Each write needs `confirm: true`. See [docs/mcp.md](docs/mcp.md).

**Least privilege:** login requests nine scopes, each tied to a feature. `reddit-cli scopes` shows all of Reddit's scopes this project knows about, with the reason each one is left out. See [docs/security.md](docs/security.md).

## Auth modes at a glance

| Mode | You need | Stores | Can write | Best for |
|---|---|---|---|---|
| `oauth` (default) | A **installed** app's client ID, and a one-time browser login | A refresh token, in the OS keychain | Yes | Almost everyone |
| `password` | A **script** app's client ID and secret, plus your password | Nothing (the password comes from the environment) | Yes | Setups where a browser login is impossible. Carries a real risk, see [docs/security.md](docs/security.md) |
| `app` | A **script** or **web** app's client ID and secret | Nothing | No (read-only, public data) | Read-only use |

Details: [docs/configuration.md](docs/configuration.md#auth-modes) and [docs/how-it-works.md](docs/how-it-works.md#oauth-flows).

## Status and limits

- **Tested offline:** 104 tests. They use a fake `fetch`, a spawned stdio server, and a real HTTP server on an ephemeral port.
- **Not tested live:** nothing has been run against Reddit yet. The request shapes follow [PRAW](https://github.com/praw-dev/praw) and the other projects' code. Verify each capability on your own account before relying on it.
- **Docker:** the image builds, and the HTTP endpoint was checked in a running container (401 without the token, a successful `initialize` with it).
- **Extension:** builds on Windows, validates, unpacks, and serves its 32 tools over stdio. It has not been installed in Claude Desktop, and it is not signed.
- **Platform:** the keychain library is native, so an extension bundle works only on the operating system it was built on.
- **Scope changes** need a new login.
- **Not supported:** moderation tools, direct messages, reports, Reddit chat, and Reddit Answers.
- **Reddit's API policy is changing.** Read [docs/credentials.md](docs/credentials.md#reddits-api-policy) before you build on it.

## License and credits

The code in this repository is written from scratch. The feature set, endpoint choices, and several behaviors are credited in [NOTICE.md](NOTICE.md).
