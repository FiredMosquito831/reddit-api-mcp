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
  mcp.js           MCP entry point (stdio, --http, --generate-token)
  mcp-server.js    builds the MCP server and its 32 tools
  http.js          stateless HTTP transport, bearer token
  session.js       per-account wiring; token sources by auth mode
  config.js        environment reading and validation
  oauth.js         OAuth endpoints: authorize, token, refresh, revoke, password, app
  client.js        Reddit client: tokens, sliding window, retries, cache
  actions.js       one function per action
  safety.js        write guard and its log
  store.js         OS keychain
  rss.js           public RSS feed
  scopes.js        scope catalog
  glossary.js      Reddit terms
  util.js          small helpers
tests/             node:test suites; fakes in helpers.js and fake-client.js
scripts/
  build-mcpb.js    builds the Claude Desktop extension
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
| `npm run mcpb` | Builds `dist/reddit-api-mcp.mcpb`. |
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
| `http.test.js` | Starts the real HTTP server, and checks authentication and the routes |
| `cli.test.js` | Help, configuration errors, and dry runs, from the real CLI |

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

- Send the write through `guard.run({ text, perform })`. Pass the text the user wrote, so the duplicate check sees it. Pass `text: undefined` for a write with no text.
- Register it with `registerWrite`, so it requires `confirm: true`.
- In the CLI, add `addWriteOptions` and a confirmation message. Add `--dry-run` as well.
- Check that the write is spaced and counted, by testing through the guard.

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
4. Build the image with `docker build -t reddit-api-mcp .`, and run the check in [deployment.md](deployment.md#check-that-it-works).
5. Commit, then push. Commit messages in this repository end with the owner's attribution line.

## Dependencies

- `@modelcontextprotocol/sdk`: the MCP server and its transports.
- `zod`: tool input schemas.
- `@napi-rs/keyring`: the OS keychain. It is native, so it ships per platform.
- `commander`: the command-line parser (CLI only; excluded from the extension).
- `@anthropic-ai/mcpb`: the extension packager (development only).

Run `npm audit` after you change dependencies, and keep the lockfile in the commit.
