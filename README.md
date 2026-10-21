# reddit-api-mcp

Control your own Reddit account from the command line or from Claude.

It reads feeds, searches, opens threads with their full comment trees, looks up users, and writes:
posts, replies, edits, deletes, votes, joining and leaving subreddits, and saving items. Every write
is guarded: it can be previewed, it is spaced and capped, and it can require a local confirmation.

It runs four ways:

- **`reddit-cli`**, a command-line tool.
- **An MCP server**, `reddit-api-mcp`, over stdio for Claude Desktop and Claude Code, or over HTTP
  behind a bearer token.
- **A Docker image** for the HTTP server.
- **A Claude Desktop extension** (`.mcpb`), built with `npm run mcpb`.

Three backends can carry the same 32 tools. The **official Reddit API** is preferred. Two
**experimental** routes work through a dedicated, locally enrolled browser profile: **request replay**
and the **rendered Playwright UI**. They are Windows local CLI/stdio features only; HTTP, Docker, and
the extension remain API-only. See [browser-mode.md](docs/browser-mode.md).

The feature set is ported from [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server), [karanb192/reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy), and [adhikasp/mcp-reddit](https://github.com/adhikasp/mcp-reddit). See [NOTICE.md](NOTICE.md).

> **Status.** All code is tested offline; no Reddit API call, browser, Playwright install, or live
> account operation has been performed. The API route is the mature one. Replay and browser UI are
> implemented from inspected upstream evidence and synthetic fixtures, and every experimental row is
> still `implemented-offline-tested`, never `live-verified`. See
> [docs/backend-coverage.md](docs/backend-coverage.md).

## Quick start: official API

1. **Get a Reddit app and its credentials.** Follow [docs/credentials.md](docs/credentials.md). It has
   every step, every link, and what to do when self-service app creation is closed.
2. **Install.** Requires Node 22.12 or newer.
   ```
   npm install
   cp .env.example .env          # on Windows: copy .env.example .env
   ```
3. **Fill in `.env`.** At minimum `REDDIT_CLIENT_ID` and `REDDIT_USERNAME`. See
   [docs/configuration.md](docs/configuration.md).
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

## Quick start: experimental browser profile

Playwright is an optional peer, installed explicitly. Nothing installs it for you.

```
node src/cli.js profile add work --username your_username
node src/cli.js profile configure work --enable-backends api,replay,browser --preference api,replay,browser
node src/cli.js browser doctor
node src/cli.js browser setup --install-package --install-browser --yes
node src/cli.js browser login work
node src/cli.js profile default work
node src/cli.js feed node --limit 3 --backend browser
```

Read [docs/browser-mode.md](docs/browser-mode.md) before enabling either experimental backend. None
of these steps has been verified against a live Reddit account in this repository.

## Documentation

| Document | What's in it |
|---|---|
| [docs/credentials.md](docs/credentials.md) | Every step to get a Reddit app, its client ID and secret, and access to the API, with links |
| [docs/configuration.md](docs/configuration.md) | Every setting, the three auth modes, safety modes, profiles, backends, visibility, and confirmations |
| [docs/cli.md](docs/cli.md) | Every command, its options, and examples |
| [docs/mcp.md](docs/mcp.md) | Connecting Claude Desktop, Claude Code, and HTTP clients, the 32 tools, and the 11 local helpers |
| [docs/browser-mode.md](docs/browser-mode.md) | Profile enrollment, Playwright setup, replay versus UI, recovery, and disabling a session |
| [docs/backend-coverage.md](docs/backend-coverage.md) | The evidence ledger: every tool and backend, its status, missing fields, and blockers |
| [docs/extension.md](docs/extension.md) | Building and installing the Claude Desktop extension (API-only) |
| [docs/deployment.md](docs/deployment.md) | Docker and HTTP deployment (API-only) |
| [docs/how-it-works.md](docs/how-it-works.md) | Architecture: dispatcher, backends, profiles, write boundary, caching, scopes, and storage |
| [docs/security.md](docs/security.md) | What is sensitive, where it lives, the threats, and the controls |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Error messages and what to do about them |
| [docs/development.md](docs/development.md) | Repository layout, tests, scripts, and how to add a feature |
| [docs/experiments/replay.md](docs/experiments/replay.md) | Pinned upstream evidence and the finite replay mappings |
| [docs/experiments/browser-ui.md](docs/experiments/browser-ui.md) | Rendered-UI steps, limits, and the future live-experiment record |

## What it does

**Reading** (no writes):

- Feeds in any sort (`hot`, `new`, `top`, `rising`, `controversial`), with paging and optional
  subreddit details.
- Subreddit info, rules, post flairs, and Reddit's popular subreddits.
- Search across Reddit or inside a subreddit, filtered by author or flair.
- A post with its comment tree, and "load more" expansion for collapsed branches. Accepts a post ID,
  a fullname, or a reddit.com link.
- A user's karma and account details, their posts and comments, and a summary of where they are active.
- Your own overview, your saved items, and the subreddits you have joined.
- A public RSS fallback that needs no Reddit app (read-only, no scores).
- A glossary of Reddit terms (karma, AMA, ELI5, and more). Works offline.

**Writing** (every write is guarded):

- Create text or link posts; reply to posts and comments; edit and delete your own posts and comments.
- Vote (up, down, or clear), join and leave subreddits, save and unsave.
- `--dry-run` for previews, 2 seconds between writes (5 in strict mode), an hourly cap (30, or 10 in
  strict mode), and a 24-hour block on identical text.
- Application-level confirmations default **off** for all 11 write tools, including deletes. A
  profile can require a global or per-tool trusted local approval; `confirm: true` is optional
  evidence and never a substitute for that approval. Host permission prompts are separate.
- An optional bot disclosure footer on posts, comments, and edits.

**Connecting to Claude:** 32 MCP tools (21 read, 11 write) plus 11 local profile/browser helpers over
stdio. HTTP exposes exactly the 32 Reddit tools. See [docs/mcp.md](docs/mcp.md).

**Least privilege:** login requests nine scopes, each tied to a feature. `reddit-cli scopes` shows all
of Reddit's scopes this project knows about, with the reason each one is left out. See
[docs/security.md](docs/security.md).

## Auth modes at a glance

| Mode | You need | Stores | Can write | Best for |
|---|---|---|---|---|
| `oauth` (default) | An **installed** app's client ID, and a one-time browser login | A refresh token, in the OS keychain | Yes | Almost everyone |
| `password` | A **script** app's client ID and secret, plus your password | Nothing (the password comes from the environment) | Yes | Setups where a browser login is impossible. Carries a real risk, see [docs/security.md](docs/security.md) |
| `app` | A **script** or **web** app's client ID and secret | Nothing | No (read-only, public data) | Read-only use |

Details: [docs/configuration.md](docs/configuration.md#auth-modes) and
[docs/how-it-works.md](docs/how-it-works.md#official-api-flows).

## Backends at a glance

| Backend | Transport | Needs | Status |
|---|---|---|---|
| `api` | `oauth.reddit.com` | Reddit app credentials | Implemented offline; no live call here |
| `replay` | Finite `www.reddit.com` requests with the profile's browser cookies | Dedicated enrolled profile, Playwright to own the session | Experimental, upstream-evidenced only |
| `browser` | Rendered desktop `www.reddit.com` | Playwright, dedicated enrolled profile | Experimental, fixture-tested only |
| `rss` | Public Atom feed | Nothing | Implemented offline |

Backend fallback is only for an unsupported or pre-dispatch-unavailable implementation, never for an
auth denial, throttle, challenge, or unknown write. The selection is frozen per call. See
[docs/browser-mode.md](docs/browser-mode.md).

## Status and limits

- **Tested offline:** the full suite runs with a fake `fetch`, fake Playwright/session, fake keyring,
  spawned stdio server, real HTTP server on an ephemeral port, and temporary `REDDIT_CLI_HOME`
  directories. Nothing contacts Reddit.
- **Not tested live:** no Reddit API call, browser launch, Playwright install, keyring operation, or
  account experiment has been performed. Replay and browser coverage rows stay unverified.
- **Browser gaps:** `get_post_flairs` is unsupported on both experimental backends; the browser also
  cannot implement `get_more_comments`; UI paging is not an API cursor and its continuation resume is
  not implemented. See [docs/backend-coverage.md](docs/backend-coverage.md).
- **Distributions:** HTTP, Docker, and the `.mcpb` extension are API-only. The extension excludes the
  CLI and the browser/replay modules by construction.
- **Docker:** the image builds, and the HTTP endpoint was checked in a running container (401 without
  the token, a successful `initialize` with it).
- **Extension:** builds on Windows, validates, unpacks, and serves its 32 tools over stdio. It has
  not been installed in Claude Desktop, and it is not signed.
- **Platform:** the keychain library is native, so an extension bundle works only on the operating
  system it was built on. Browser backends target Windows local CLI/stdio first.
- **Scope changes** need a new login.
- **Not supported:** moderation tools, direct messages, reports, Reddit chat, and Reddit Answers.
- **Reddit's API policy is changing.** Read [docs/credentials.md](docs/credentials.md#reddits-api-policy) before you build on it.

## License and credits

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE).

The code in this repository is written from scratch. The feature set, endpoint choices, and several behaviors are credited in [NOTICE.md](NOTICE.md).
