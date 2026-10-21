# Command-line reference

`reddit-cli` is the command-line tool. Run it from the project folder as `node src/cli.js <command>`, or run `npm link` once and use `reddit-cli <command>` anywhere.

Every example below assumes a `.env` file. Add `--env-file-if-exists=.env` to the command, or export the variables yourself. See [configuration.md](configuration.md).

```
node --env-file-if-exists=.env src/cli.js <command> [options]
```

## Conventions

- **Examples** show the shape of the output. The values in them are illustrative.
- **Fullnames** identify things. `t1_` is a comment, `t3_` a post, `t5_` a subreddit, and `t2_` a user. You can pass a bare id where a post is expected, such as `abc123`, or a reddit.com link to `thread`.
- **Cursors.** Listing commands print `Next page: --after <cursor>` when there is more. Pass that value with `--after` to continue.
- **Writes** do not prompt by default. A profile can require a global or per-tool confirmation; then the CLI asks locally and requires a terminal. `--confirm` requests that local confirmation for one call, and `--yes` is accepted for compatibility but never weakens a stored policy. `--dry-run` prints the request and sends nothing.
- **Profiles and backends.** Reads and writes accept `--profile <name>` and `--backend auto|api|replay|browser`. Without `--profile`, the saved default is used. Without either, the environment-only legacy setup is used when present; otherwise the command fails with `PROFILE_REQUIRED`.
- **JSON.** Commands that support `--json` print one structured document and send human lines to standard error where the command needs them.
- **Errors** go to standard error as `Error: <message>`, and the command exits with status 1. `test` also exits 1 when any check fails.
- **Git Bash** rewrites arguments that start with `/`. Put `MSYS_NO_PATHCONV=1` before the command when you pass an API path.

## Account

### `login`

```
reddit-cli login [--profile <name>]
```

For `oauth` mode. Prints an authorize URL. Open it while signed in as the right account, approve, copy the full address from the address bar of the page that fails to load, and paste it back. The refresh token goes to the OS keychain, under the environment entry or the named profile. The command confirms that the account matches the expected username, and it prints the scopes you were granted.

In `password` mode it checks the credentials and stores nothing. In `app` mode it says no login is needed.

### `logout`

```
reddit-cli logout [--profile <name>] [--json]
```

Revokes the refresh token with Reddit, and removes it from the keychain. If `REDDIT_REFRESH_TOKEN` is set, it is revoked too, and you should remove it from your environment. With `--profile`, it reports local removal and the remote result separately; it never assumes a remote logout succeeded.

### `whoami`

```
reddit-cli whoami
```

Prints the account the token belongs to, with its link and comment karma:

```
u/alice  link karma 1204  comment karma 5310
```

### `token`

```
reddit-cli token [--profile <name>] [--yes]
```

Prints an API refresh token, for the Claude Desktop extension. It is a secret, and anyone who has it can act as your account. The command asks for confirmation unless you pass `--yes`. It works only in `oauth` mode. It never prints a browser session cookie, and it cannot export a browser session.

### `test`

```
reddit-cli test
```

Checks the setup end to end. It makes one public read, and a `whoami` in the modes that have a user. Each check prints `ok` or `FAIL`:

```
ok    read: popular subreddits: pics
ok    account: whoami: alice
All checks passed in 412 ms.
```

### `scopes`

```
reddit-cli scopes
```

Lists every OAuth scope this project knows about. Each line says whether login requests it, and why the others are left out. It needs no configuration.

## Profiles and browser setup

Named profiles are local metadata plus OS-store secret references. They let one machine hold several accounts without sharing tokens, and they are required for the experimental replay and browser backends. See [browser-mode.md](browser-mode.md).

### `profile add`

```
reddit-cli profile add <name> [--username <reddit-user>] [--api-client-id <id>] [--app-type script|web|installed] [--json]
```

Adds a case-insensitively unique alias. `--username` records the expected Reddit account. The client ID and app type are public metadata; secrets are never stored in the registry. New profiles enable only the `api` backend.

### `profile list`, `profile default`, `profile status`

```
reddit-cli profile list [--json]
reddit-cli profile default [<name>] [--clear] [--json]
reddit-cli profile status [<name>] [--json]
reddit-cli profile attempts [<name>] [--json]
reddit-cli profile resolve <name> <attempt-id> <succeeded|failed> [--note <text>] [--json]
```

`list` shows aliases and the saved default. `default` with no name prints the current default; with a name it sets it; `--clear` removes it. There is no automatic fallback to another profile. `status` shows the resolved profile, enabled backends, preference, confirmation policy, bound account state, and pending writes, without secrets.

`attempts` lists the prepared, dispatched, and unknown writes recorded for the profile's account. `resolve` records what you verified after checking Reddit yourself, marking an uncertain attempt as `succeeded` or `failed`. It never resends the write and never clears an unknown outcome automatically; a successful resolution also advances that account's cache generation. Use the exact attempt id printed by `status` or `attempts`.

### `profile configure`

```
reddit-cli profile configure <name> [--alias <name>] [--enable-backends app,replay,browser]
  [--preference auto-order] [--visibility visible|headless|ask]
  [--confirmation <tool=on|off> ...] [--confirmation-global <on|off>]
  [--password-login <on|off>] [--dry-run] [--json]
```

Changes non-secret operational settings. `--enable-backends` is a comma-separated subset of
`api,replay,browser`; `--preference` is an order such as `api,replay,browser`. Confirmation keys must
be real write tool names. Enabling stored-password login and changing confirmation policy require a
separate local security approval. `--dry-run` shows the patch and classification without changing
anything.

### `profile approve-settings`

```
reddit-cli profile approve-settings <proposal> [--json]
```

Applies a pending settings proposal with a trusted local prompt. Proposals are recorded by
`reddit_settings_propose` over MCP or prepared by `profile configure`; this command is the only place
one is approved. It applies only settings keys, and it refuses an action approval instead of burning
it. Rotating `--password-login` writes the registry only after the local prompt.

### `profile credentials`

```
reddit-cli profile credentials <name> [--password-login <on|off>] [--json]
```

Stores this profile's API secrets (client secret and/or refresh token) with hidden local prompts, and
optionally enables or disables stored browser-password recovery. Values never appear in argv, output,
or JSON; the JSON reports only which secret names were stored.

### `profile logout`, `profile remove`

```
reddit-cli profile logout <name> [--json]
reddit-cli profile remove <name> [--json]
```

`logout` closes the owned browser session, revokes the profile's API token when possible, and reports
local deletion separately from remote state. `remove` deletes the profile's local metadata and
secrets after a typed local confirmation. If another local process still owns that browser profile
(its cross-process lease is live), `remove` refuses with `PROFILE_IN_USE` and leaves both metadata and
secrets untouched; close the owner first. Neither command claims to close Reddit sessions elsewhere.

### `browser doctor`

```
reddit-cli browser doctor [--profile <name>] [--json]
```

Reports whether the Playwright package and a Chromium binary are present, which pinned version the
project recommends, and the exact install commands. It is read-only: it installs and downloads
nothing, and it never opens a browser.

### `browser setup`

```
reddit-cli browser setup [--install-package] [--install-browser] [--version <exact>] [--yes] [--json]
```

Runs only the install steps you name. `--install-package` installs the pinned Playwright package
without saving it to `package.json`; `--install-browser` runs Playwright's Chromium installer. Without
either flag it is a no-op report. It is a local CLI command only; no MCP tool reaches it.

### `browser login`

```
reddit-cli browser login <name> [--visibility visible|headless|ask] [--json]
```

Opens the dedicated profile so you can sign in by hand, then verifies the account. It never types a
password, reads cookies, or solves a challenge. Passwords for optional automatic recovery are entered
only through `profile credentials`.

## Reading

Every read accepts `--profile <name>` and `--backend auto|api|replay|browser`. A browser-backed paged read prints its normal output; its `--json` form carries result metadata, including `backend`, `completeness`, `missingFields`, and, when one was issued, an opaque `continuation` token. That token is not an API `after` cursor, and this build refuses to resume one (`CONTINUATION_INVALID`) rather than silently restarting page one.

### `feed`

```
reddit-cli feed <subreddit> [--sort hot] [--time <range>] [--limit 10] [--info] [--after <cursor>]
```

Lists posts. `--sort` is `hot`, `new`, `top`, `rising`, or `controversial`. `--time` (`hour`, `day`, `week`, `month`, `year`, or `all`) applies to `top` and `controversial`. `--limit` is 1 to 100. `--info` prints the subreddit's details first.

```
$ reddit-cli feed node --sort top --time week --limit 3
   412  t3_1abcd1     Node 24 is out
   188  t3_1abcd2     Why streams still confuse people
    97  t3_1abcd3     Weekly help thread

Next page: --after t3_1abcd3
```

Each line is the score, the fullname, and the title.

### `top`

```
reddit-cli top <subreddit> [--time day] [--limit 10] [--after <cursor>]
```

The same as `feed --sort top`, with `--time` defaulting to `day`.

### `subreddit`

```
reddit-cli subreddit <name>
```

Prints the subreddit's subscriber count, title, and public description.

### `rules`

```
reddit-cli rules <subreddit>
```

Prints each rule as `- Short name: description`.

### `flairs`

```
reddit-cli flairs <subreddit>
```

Prints the post flairs the subreddit offers, as `id  text`. Use the id when you need a flair.

### `popular`

```
reddit-cli popular [--limit 5]
```

Prints Reddit's popular subreddits, which is the closest public list to trending. `--limit` is 1 to 100.

### `search`

```
reddit-cli search [query...] [--subreddit <name>] [--sort relevance] [--time all] [--type link]
                  [--author <name>] [--flair <text>] [--limit 25] [--after <cursor>]
```

Searches posts. Give a query, an `--author`, a `--flair`, or any mix. `--sort` is `relevance`, `hot`, `top`, `new`, or `comments`. `--type` is `link`, `sr` (subreddits), or `user`. `--subreddit` limits the search to one community.

```
reddit-cli search "rust async" --subreddit rust --author alice --limit 5
```

### `thread`

```
reddit-cli thread <id> [--subreddit <name>] [--sort confidence] [--limit 100] [--depth <n>]
```

Shows one post and its comments, as JSON:

- `post`: the post's details.
- `comments`: a flat list in reading order, each with a `depth`.
- `moreIds`: the comment ids Reddit collapsed. Pass them to `more`.

`<id>` can be a bare id, a fullname, or a reddit.com link. `--sort` is `confidence` (Reddit's "Best"), `top`, `new`, `controversial`, `old`, or `qa`. `--limit` is 1 to 500. `--depth` is 1 to 10. Giving `--subreddit` makes the lookup faster.

### `more`

```
reddit-cli more <postFullname> <commentIds...>
```

Expands collapsed comments from `thread`'s `moreIds`. Pass the post's fullname (`t3_...`) and up to 100 ids. The ids can be bare or `t1_` prefixed. It prints the comments as JSON.

### `user`

```
reddit-cli user <name>
```

Prints a user's karma, account age, and flags, as JSON.

### `activity`

```
reddit-cli activity <name>
```

Prints a summary as JSON: the account details, how many recent posts and comments were sampled, and the ten subreddits the user is most active in.

### `user-posts` and `user-comments`

```
reddit-cli user-posts <name> [--sort new] [--time all] [--limit 25] [--after <cursor>]
reddit-cli user-comments <name> [--sort new] [--time all] [--limit 25] [--after <cursor>]
```

Lists a user's posts or comments. `--sort` is `hot`, `new`, `top`, or `controversial`.

### `overview`

```
reddit-cli overview [--limit 25] [--after <cursor>]
```

Lists your own posts and comments, newest first. Needs the `history` scope.

### `saved`

```
reddit-cli saved [--limit 25] [--after <cursor>]
```

Lists your saved posts and comments. Needs the `history` scope.

### `mine`

```
reddit-cli mine
```

Lists the subreddits you have joined, as `r/name`.

### `rss`

```
reddit-cli rss <subreddit> [--sort hot] [--limit 25]
```

Reads a public feed. It needs no Reddit app and no login, and it is read-only. Each line is the fullname, the title, and the author. The feed has no scores or comment counts, and Reddit may throttle it per IP.

### `explain`

```
reddit-cli explain <term>
```

Gives a plain-language meaning for a Reddit term, such as `karma`, `cake day`, `AMA`, `ELI5`, `OP`, `TIL`, `upvote`, `flair`, `mod`, `megathread`, or `quarantine`. It works offline.

## Writing

Application-level confirmation is off by default for every command in this section, including
`delete`. If the profile requires a global or per-tool confirmation, the CLI asks locally and needs a
terminal; without one it refuses with `APPROVAL_REQUIRED` and sends nothing. `--confirm` requests that
local confirmation for one call. `--yes` is accepted but never weakens a stored or requested policy.
Each command accepts `--dry-run`, which sends nothing and creates no attempt. Every write also passes
the account-level spacing, duplicate, and hourly-cap boundary; those are not optional.

All write commands accept `--profile <name>` and `--backend auto|api|replay|browser`. A backend is a
way to perform the action, never a way to choose another account. An unknown write outcome stops the
operation; it is never retried through another backend.

### `post`

```
reddit-cli post <subreddit> --title <title> [--text <body> | --url <link>]
```

Submits a text post with `--text`, or a link post with `--url`. Give exactly one of the two. The output is `Posted: <url>`.

```
reddit-cli post rust --title "Show: my crate" --text "What I built and why." --dry-run
```

### `comment`

```
reddit-cli comment <parent> --text <body>
```

Replies to a post (`t3_...`) or to a comment (`t1_...`). The output is the new comment's permalink.

### `edit`

```
reddit-cli edit <fullname> --text <new body>
```

Replaces the text of your own post (`t3_...`) or comment (`t1_...`).

### `delete`

```
reddit-cli delete <fullname>
```

Deletes your own post or comment. This cannot be undone. Use `--dry-run` first.

### `vote`

```
reddit-cli vote <fullname> <up|down|clear>
```

Votes on one post or comment, or clears your vote. Votes are single, deliberate actions. Scripting votes in bulk is not what this tool is for.

### `subscribe` and `unsubscribe`

```
reddit-cli subscribe <subreddit>
reddit-cli unsubscribe <subreddit>
```

Joins or leaves a subreddit.

### `save` and `unsave`

```
reddit-cli save <fullname>
reddit-cli unsave <fullname>
```

Saves or unsaves a post or comment to or from your saved items.

## Raw requests

### `api`

```
reddit-cli api <GET|POST> <path> [-f key=value ...] [--yes] [--dry-run]
```

Sends any authenticated GET or POST request, and prints the JSON response. The path must start with `/`.

- For GET, each `-f` becomes a query parameter.
- For POST, each `-f` becomes a form field. A POST is a mutation and passes through the shared
  write boundary with its own `raw_post` admission key. `--yes` is its legacy local confirmation; a
  stored global confirmation policy still requires the trusted local approval, and `--yes` can never
  weaken it.

```
reddit-cli api GET /api/v1/me
reddit-cli api GET /r/popular/hot -f limit=3
```

Use `api` for endpoints this CLI does not wrap yet. Read Reddit's current API documentation for the endpoint and its parameters first. `api` is official-API only: it never uses the replay or browser backend, cannot reach a browser session, and remains available only from the local CLI, not MCP.

## Exit status and output

- Standard output carries the results. Standard error carries `Error:` messages.
- Status `0` means success. Status `1` means an error, or a failed check in `test`.
- Lists print one item per line. Objects print as JSON, so you can pipe them to `jq`.
