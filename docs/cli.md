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
- **Writes** ask for confirmation first. `--dry-run` prints the request and sends nothing. `--yes` skips the prompt, which scripts need, because a prompt cannot be answered there.
- **Errors** go to standard error as `Error: <message>`, and the command exits with status 1. `test` also exits 1 when any check fails.
- **Git Bash** rewrites arguments that start with `/`. Put `MSYS_NO_PATHCONV=1` before the command when you pass an API path.

## Account

### `login`

```
reddit-cli login
```

For `oauth` mode. Prints an authorize URL. Open it while signed in as the right account, approve, copy the full address from the address bar of the page that fails to load, and paste it back. The refresh token goes to the OS keychain. The command confirms that the account matches `REDDIT_USERNAME`, and it prints the scopes you were granted.

In `password` mode it checks the credentials and stores nothing. In `app` mode it says no login is needed.

### `logout`

```
reddit-cli logout
```

Revokes the refresh token with Reddit, and removes it from the keychain. If `REDDIT_REFRESH_TOKEN` is set, it is revoked too, and you should remove it from your environment.

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
reddit-cli token [--yes]
```

Prints the refresh token, for the Claude Desktop extension. It is a secret, and anyone who has it can act as your account. The command asks for confirmation unless you pass `--yes`. It works only in `oauth` mode.

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

## Reading

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

Every command in this section asks for confirmation unless you pass `--yes`, and each one accepts `--dry-run`.

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
- For POST, each `-f` becomes a form field. POST asks for confirmation.

```
reddit-cli api GET /api/v1/me
reddit-cli api GET /r/popular/hot -f limit=3
```

Use `api` for endpoints this CLI does not wrap yet. Read Reddit's current API documentation for the endpoint and its parameters first.

## Exit status and output

- Standard output carries the results. Standard error carries `Error:` messages.
- Status `0` means success. Status `1` means an error, or a failed check in `test`.
- Lists print one item per line. Objects print as JSON, so you can pipe them to `jq`.
