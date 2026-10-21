# Claude Desktop extension

The extension packages the MCP server as a single `.mcpb` file. You install it once, fill in a few settings, and Claude Desktop runs the server for you. Your secrets are stored by Claude Desktop, in the operating system's keychain, and they are not written into the file.

## What you get

- One file, `dist/reddit-api-mcp.mcpb`, built from this repository.
- The 32 official-API tools from [mcp.md](mcp.md).
- Settings for the client ID, your username, the auth mode, and the secrets, with the sensitive ones marked as such.

The extension runs on your machine, on purpose. Your credentials stay local instead of living on a hosted server.

The extension is **API-only**. It does not include the CLI, the local profile/browser helpers, the
replay backend, or the browser backend, and it never needs Playwright. The manifest starts the server
with `--api-only`, which registers exactly the 32 Reddit tools and no local helper. Browser and replay
are local CLI/stdio features; see [browser-mode.md](browser-mode.md).

## Before you build

- Node.js 22.12 or newer. The manifest declares this requirement.
- A checkout of this repository, with `npm install` run.
- Build on the operating system you will install on. The keychain library is native, so a bundle works only on the system it was built on. The build records that system in the manifest.
- The build is not signed.

## Build

```
npm install
npm run mcpb
```

The script:

1. Copies `src/` into a staging folder, except the command-line modules, the local browser helper,
   and the browser/replay backends, which the extension never runs. The planned bundle is
   self-contained; a smoke test starts it over stdio and checks the 32-tool inventory.
2. Writes a `package.json` with `"type": "module"` next to the code, and keeps only the runtime dependencies. Playwright is not included.
3. Installs those dependencies for this platform, and drops the lockfile.
4. Writes `manifest.json`, with the settings described below.
5. Validates the manifest with `@anthropic-ai/mcpb`, and packs the bundle.

The output is `dist/reddit-api-mcp.mcpb`, about 4 MB. The `dist/` folder is git-ignored.

## Install

Open the `.mcpb` file with Claude Desktop, or drag it onto the application. Claude Desktop shows the settings below. Fill in the required ones, and save.

Restart Claude Desktop if the server does not appear. Then ask Claude to run `test_reddit_mcp_server`.

## Settings

| Setting | Required | Sensitive | Default | What to enter |
|---|---|---|---|---|
| **Reddit app client ID** | yes | no | | The client ID from your app's card. See [credentials.md](credentials.md). |
| **Reddit username** | yes | no | | The account the extension acts for. |
| **Auth mode** | no | no | `oauth` | `oauth`, `password`, or `app`. |
| **Client secret** | no | yes | | Required for `password` and `app`, and for script and web apps. Leave empty for installed apps. |
| **Reddit password** | no | yes | | Only for `password` mode. With two-factor on, add `:CODE`. Read [security.md](security.md#password-mode) first. |
| **Refresh token** | no | yes | | Only for `oauth` mode. Get it as described below. |
| **Write safety** | no | no | `standard` | `standard` (2 seconds between writes, 30 an hour) or `strict` (5 seconds, 10 an hour). |
| **Bot footer** | no | no | empty | Empty for none, `auto` for the standard disclosure, or your own text. |
| **Read cache** | no | no | `on` | `on` (60 seconds) or `off`. |

Settings you leave empty are treated as unset. A placeholder that the host did not fill in is treated as empty too.

## Getting the refresh token (oauth mode)

The extension cannot run the browser login itself, so do it once in the repository and paste the result in.

1. In the repository, create a `.env` file with `REDDIT_CLIENT_ID` and `REDDIT_USERNAME`. See [configuration.md](configuration.md).
2. Log in:
   ```
   node --env-file-if-exists=.env src/cli.js login
   ```
   Approve in the browser, and paste the address back.
3. Print the token:
   ```
   node --env-file-if-exists=.env src/cli.js token
   ```
   Confirm when asked. The command prints the token.
4. Paste the token into **Refresh token** in the extension's settings.

The token is a secret. Anyone who has it can act as your account. Do not paste it into a chat, a file in the repository, or a screenshot.

### If the extension stops logging in

Reddit may issue a new refresh token each time one is used. The extension keeps the newest one for as long as it runs. When it restarts, it uses the value you saved. If that value has been replaced by Reddit since, the extension cannot log in. Run `login` and then `token` again, and paste the new token. Using the keychain avoids this, which is why the default flow stores the token there.

## Safety

- The extension uses the same guarded official-API write path as the CLI: per-account spacing,
  duplicate check, hourly cap, one durable attempt, and one dispatch.
- Application-level confirmation is **off by default for all 11 write tools, including deletes**.
  `confirm: true` is optional evidence, never proof of approval. Keep Claude Desktop's approval
  prompts on for write tools; that host prompt is the gate you rely on here.
- The bundle runs with your user's permissions, so it can do whatever the account can do. The account is the real limit.

## Updating

When the code changes, run `npm run mcpb` again and install the new `.mcpb` file. Settings you already filled in are kept when the new version has the same settings.

## Limitations

- The bundle has not been installed in Claude Desktop by its authors yet. It was built and checked locally: the manifest validates, the bundle unpacks, and it serves 32 tools over stdio.
- It is not signed. Claude Desktop may show an unsigned-extension warning.
- One bundle works on one operating system. Build a separate one for each system you use.
- Node.js 22.12 or newer must be available to Claude Desktop.
- It is API-only: no browser, replay, profile registry, or local helper tools. Use a local checkout for those.
