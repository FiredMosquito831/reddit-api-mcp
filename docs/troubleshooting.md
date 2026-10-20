# Troubleshooting

Find the message you see below. Each entry says what causes it and what to do. Messages are quoted from the code, so they match what you see.

## Setup and configuration

**`Set REDDIT_CLIENT_ID to your Reddit app's client ID.`**
The client ID is missing or empty. Put it in `.env`, or in your MCP host's settings. See [configuration.md](configuration.md).

**`Set REDDIT_USERNAME to your Reddit username (3-20 letters, digits, _ or -).`**
The username is missing, or has characters Reddit does not allow. A leading `u/` is removed for you, so `u/alice` and `alice` both work.

**`REDDIT_AUTH_MODE must be oauth, password, or app.`**
The mode is misspelled. Check for a stray space or a capital letter.

**`REDDIT_AUTH_MODE=password needs REDDIT_PASSWORD. With two-factor on, put ":CODE" after the password.`**
Password mode needs your password in `REDDIT_PASSWORD`. See [security.md](security.md#password-mode).

**`REDDIT_AUTH_MODE=<mode> needs REDDIT_CLIENT_SECRET, which script and web apps have.`**
`password` and `app` modes need the secret from a script or web app. An installed app has no secret, so use `oauth` with an installed app. Or create a script app, as described in [credentials.md](credentials.md).

**`REDDIT_CLI_SAFE_MODE must be standard or strict.`**
Only those two safety modes exist. There is no "off" mode, on purpose.

**`Expected a whole number of at least N, got: X`**
A setting that takes a number got something else. For example, `REDDIT_CLI_MAX_WRITES_PER_HOUR` must be at least 1, and `REDDIT_CLI_MAX_RETRIES` at least 0.

**`<file> not found. Continuing without it.`**
A notice, not an error. `--env-file-if-exists` skipped a `.env` file that does not exist. Settings come from your shell instead.

## Login

**`Not logged in. Run "reddit-cli login" first.`**
No refresh token is available. Run `login`. In a container or the extension, check that `REDDIT_REFRESH_TOKEN` (or the setting) holds a token.

**`Access was not granted (access_denied).`**
You clicked **Cancel** or **Deny** on Reddit's page. Run `login` again and click **Allow**.

**`That is not a URL. Paste the full address your browser ended up on.`**
Paste the entire address from the address bar, starting with `http`. Do not paste only the code.

**`The state value does not match this login attempt. Run login again.`**
You pasted an address from an earlier attempt. Start a new `login` and use the address from that attempt.

**`The pasted URL has no authorization code.`**
The address has no `code` in it. This usually means the browser was on a different page. Start `login` again.

**`Reddit token request failed (HTTP 400, invalid_grant).`**
The code was already used or has expired. Codes are single-use and short-lived. Run `login` again and paste the new address promptly.

**`Reddit token request failed (HTTP 401, ...)`**
The client ID or secret is wrong for this app. Check the values against the app's card. For an installed app, leave the secret empty.

**`Reddit returned no refresh token. Check that the authorize URL included duration=permanent.`**
The login did not request a permanent grant. Run `login` with the tool's own URL, and do not edit the URL by hand.

**`You authorized u/X, but REDDIT_USERNAME is Y. The stored token was removed.`**
You approved the app while signed in as a different account. Sign in as the account in `REDDIT_USERNAME` in your browser, and run `login` again. Or change `REDDIT_USERNAME` to match the account you meant.

**`Revoking the token failed (HTTP N).`**
`logout` could not revoke the token with Reddit. The local copy is kept, so you can try again. Check your connection.

**`Only oauth mode has a refresh token.`** (from `token`)
`token` prints the OAuth refresh token, and only `oauth` mode has one.

**`No refresh token is stored. Run "reddit-cli login" first.`** (from `token`)
Run `login` first, then `token`.

**`This mode stores nothing, so there is nothing to remove.`** (from `logout`)
Nothing to log out of in `password` or `app` mode. Change the password on Reddit if you want to cut off `password` mode.

## Using the tools

**`This session is read-only (REDDIT_AUTH_MODE=app), so writes are disabled.`**
`app` mode reads public data only. Use `oauth` or `password` mode to write.

**`Refusing to write without confirm: true.`**
An MCP write tool was called without `confirm`. Your host normally sets this after you approve the call. If you are calling the tool yourself, pass `confirm: true`.

**`Identical text was already sent recently. Change it, or wait before sending it again.`**
The same text (ignoring case and extra spaces) was written in the last 24 hours, possibly in another subreddit. Change the text. This check is there to prevent spam, not to annoy you.

**`Hourly write limit reached (30). Wait, or raise REDDIT_CLI_MAX_WRITES_PER_HOUR.`**
You hit the cap for the hour. Wait, or raise the limit deliberately.

**`Confirmation needed: run in a terminal, or pass --yes.`**
A write needs your answer, and there is no terminal to ask in. Run it in a terminal, or add `--yes` if you are sure. Scripts must pass `--yes`.

**`Cancelled.`**
You answered anything other than `y` or `yes`. Nothing was sent.

**`This step needs an interactive terminal.`**
`login` and the confirmation prompts need a terminal. Run them there, not from a script.

**`Reddit refused the request (CODE): message`**
Reddit rejected the action, and the message says why. The code is Reddit's own name for the problem, such as `SUBREDDIT_NOTALLOWED` (you cannot post there). Read the message, fix the input, and try again.

**`Reddit rate limit reached. Try again in about N seconds.`**
You are sending requests faster than Reddit allows. The tool did not send this one. Wait the number of seconds shown.

**`Reddit is throttling this account. Try again in about N seconds.`**
Reddit asked the account to slow down, with a wait longer than the tool will sit through. Wait, then retry.

**`Reddit returned HTTP 403 for GET /...`** (and similar codes)
Reddit refused the request. Common causes: the subreddit is private or quarantined, you lack the scope the feature needs (see [security.md](security.md#scopes)), or the account is restricted. A 403 on `get_my_overview` or `get_my_saved` usually means you need the `history` scope: run `login` again after changing `REDDIT_SCOPES`.

**`Reddit returned HTTP 404 for ...`**
The thing does not exist, or has been removed. Check the subreddit name, the post id, or the username.

**`Reddit returned an unexpected response for X.`**
Reddit answered with something the tool did not expect. The raw response is in the error details. This can happen with private or banned communities. If it persists for a normal community, [open an issue](#reporting-a-problem).

**`Post X was not found or is not visible to this account.`**
The post id is wrong, or the post was removed or is private. Check the id, or use a reddit.com link.

**`Not a valid subreddit name: X`**
Subreddit names are 2 to 21 letters, digits, or underscores. A `r/` prefix is fine in the subreddit fields where it is accepted, but check the name.

**`Not a valid Reddit username: X`**
Usernames are 3 to 20 letters, digits, `_`, or `-`.

**`Expected a Reddit fullname such as t3_abc123, got: X`**
The argument needs a fullname with a type prefix. Posts are `t3_`, comments are `t1_`, and subreddits are `t5_`. A bare id works for `thread`, but `comment`, `edit`, `delete`, and `vote` need the prefix.

**`Give exactly one of --text or --url.`**
A post is either a text post or a link post. Use one.

**`A title is required.`**, **`Comment text is required.`**, **`New text is required.`**
A required field is empty.

**`Give a search query, an author, or a flair.`**
`search` needs something to look for.

**`Limit must be between 1 and 100.`**, **`Depth must be between 1 and 10.`**, **`Give between 1 and 100 comment ids.`**
A number is out of range. See the reference for each command.

**`Sort must be one of: hot, new, top, rising, controversial`**, and similar messages for other sorts and time ranges
Use one of the listed values.

**`Paths must start with "/", for example /api/v1/me.`** (from `api`)
The path needs a leading slash. In Git Bash, prefix the command with `MSYS_NO_PATHCONV=1`, because Git Bash rewrites paths that start with `/`.

**`Only GET and POST are supported.`**
`api` sends GET or POST only.

## Public feed (RSS)

**`Reddit is throttling public feed requests. Wait a minute, then try again.`**
The public feed is limited per IP address. Wait a minute.

**`Reddit did not return an Atom feed. The request may have been blocked.`**
Reddit sent a page that is not a feed. Try again later, or use the authenticated feed.

## HTTP server

**`REDDIT_MCP_TOKEN is required for HTTP mode. Create one with: node src/mcp.js --generate-token`**
Set the token before you start `--http`. See [deployment.md](deployment.md).

**`401` with `Missing or wrong bearer token.`**
The request is missing `Authorization: Bearer <token>`, or the token does not match. Check for a trailing newline or a stray space in the token.

**`404` with `Not found. The MCP endpoint is /mcp.`**
Only `/mcp` is served. Point the client at `http://host:port/mcp`.

**`405` with `Only POST is supported in stateless mode.`**
The endpoint takes POST only. Clients that open an event stream with GET will not work here. Use a client that sends POST.

**Connection refused, right after `docker run`**
Docker Desktop can take a few seconds to forward a new port. Wait, then try again. Check `docker logs`.

## The extension

**The server does not appear in Claude Desktop.**
Restart Claude Desktop. If it still does not appear, check that the required settings are filled in, and that Node 22.12 or newer is available.

**Logins worked, then stopped after a restart.**
Reddit may have issued a new refresh token, which replaced the one you saved. Run `login` and `token` again in the repository, and paste the new token into the setting. See [extension.md](extension.md#if-the-extension-stops-logging-in).

**The bundle fails to load on another computer.**
The bundle contains a native keychain library built for the system it was made on. Build the bundle on the computer where you will install it. See [extension.md](extension.md).

## Diagnosing from the command line

When a problem is unclear, start with the check command, then the smallest read:

```
node --env-file-if-exists=.env src/cli.js test
node --env-file-if-exists=.env src/cli.js whoami
node --env-file-if-exists=.env src/cli.js feed node --limit 1
```

If `test` passes but a write fails, check the write-specific messages above. If `test` fails, read its `FAIL` line, which names the failing step.

## Reporting a problem

Open an issue at [github.com/FiredMosquito831/reddit-api-mcp](https://github.com/FiredMosquito831/reddit-api-mcp/issues). For security problems, see [security.md](security.md#reporting-a-problem). Include the command, the mode, the message, and the version (`reddit-cli --version`). Never include a token, a password, or a client secret.
