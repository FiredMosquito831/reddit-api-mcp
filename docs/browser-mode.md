# Browser mode: profiles, replay, and the rendered UI

This page is the setup and operations guide for the two experimental backends: **request replay** and
**Playwright UI**. Both act only through a dedicated browser profile that you enroll and sign in to
yourself. The official API remains the preferred route. Replay and UI are Windows local CLI/stdio
features; they are not available over HTTP, Docker, or the Claude Desktop extension.

> **Status.** These backends are implemented and covered by offline tests only. No live Reddit
> account, browser, or Playwright install was used while building them. Treat every result as
> experimental until the coverage ledger records a live-verified row. See
> [backend-coverage.md](backend-coverage.md).

## Which backend does what

| Backend | How it works | Needs | Maturity |
|---|---|---|---|
| `api` | Official OAuth Reddit API through `oauth.reddit.com` | A Reddit app client ID | Existing, offline-tested, not live-verified here |
| `replay` | Sends a finite, allowlisted set of `www.reddit.com` requests with the enrolled browser session's cookies | An enrolled, signed-in dedicated profile | Experimental, upstream-evidenced only |
| `browser` | Navigates and reads/operates the rendered `www.reddit.com` UI | Playwright plus an enrolled, signed-in profile | Experimental, fixture-tested only |
| `rss` | Public Atom feed, read-only, no account | Nothing | Existing, offline-tested |

Replay is not "headless Playwright". It is a separate request transport, although it borrows the
browser profile's live cookie jar. It does not promise eternal authentication: if the session
expires, it reports `LOGIN_REQUIRED`, and you sign in again in the profile.

`auto` only falls back for an unsupported or pre-dispatch-unavailable implementation, in the
profile's preference order (default `api`, then `replay`, then `browser`). It never routes around an
authentication denial, throttle, CAPTCHA, account restriction, or an unknown write outcome. Those stop
the operation.

## Install Playwright (optional, explicit)

The API, RSS, and offline glossary never load Playwright. Browser features dynamically import it.
It is declared as an optional peer pinned to `^1.64.1`; that version is a setup recommendation and has
not been live-tested in this repository.

Check what is present. `doctor` reads only; it installs and downloads nothing:

```
node src/cli.js browser doctor
node src/cli.js browser doctor --profile work --json
```

If the package or browser is missing, install it deliberately. Either use the CLI's explicit setup
flags, or run the exact commands yourself from the repository root:

```
node src/cli.js browser setup --install-package --install-browser --yes

# the same steps, without the CLI:
npm install --no-save --package-lock=false playwright@1.64.1
npx playwright install chromium
```

`--no-save` keeps the optional peer out of `package.json`. Do not add Playwright as a runtime
dependency, and do not expect a tool call or a doctor call to install it. On Windows the browser
install command is `npx playwright install chromium`; the non-Windows variant adds `--with-deps`.

## Create and enroll a profile

1. Add a named profile. The alias is local and case-insensitively unique; `--username` records the
   expected Reddit account:

   ```
   node src/cli.js profile add work --username alice
   node src/cli.js profile list
   ```

2. Decide which backends may run. New profiles start with only `api` enabled. Enabling the
   experimental backends is an explicit local choice:

   ```
   node src/cli.js profile configure work --enable-backends api,replay,browser \
     --preference api,replay,browser --visibility visible
   ```

   `--visibility` is `visible` (default), `headless`, or `ask`. Visibility applies at the next safe
   launch; a browser is never restarted in the middle of a write to change it.

3. Enroll the browser profile. This opens a dedicated, visible window. Sign in to Reddit yourself;
   the command never types your password, reads cookies, or solves a challenge:

   ```
   node src/cli.js browser login work
   ```

   Identity is verified before the profile is marked ready. If the browser is signed in as a
   different account than the profile expects, authenticated operations are blocked with
   `IDENTITY_MISMATCH`; re-enroll rather than guessing.

4. Make it the saved default if you want, or pass `--profile work` on each call:

   ```
   node src/cli.js profile default work
   node src/cli.js profile status work
   ```

Profiles are stored as non-secret metadata under `<REDDIT_CLI_HOME>/profiles.json` and
`<REDDIT_CLI_HOME>/profiles/<opaque-id>/`. Secrets live in the OS credential store under a
profile-specific service. Browser directories are sensitive even though no cookie-export file is
created. See [security.md](security.md#browser-profiles-and-sessions).

## Select a backend

```
node src/cli.js feed node --limit 3 --profile work --backend browser
node src/cli.js thread t3_abc123 --profile work --backend replay
node src/cli.js post YOUR_TEST_SUB --title "Hello" --text "Test" --profile work --backend api --dry-run
```

`--backend` accepts `auto`, `api`, `replay`, `browser`. Without `--profile`, the saved default is
used; without a default and without a legacy environment setup, the call fails with
`PROFILE_REQUIRED` rather than choosing a profile for you. The profile and backend selection freeze
at call entry, so a change to the default while a call is queued does not move it to another account.

## Confirmations

Application-level confirmations now default **off for all 11 write tools, including deletes**, on
every backend. Host permission prompts are independent and should stay on for writes. `confirm: true`
is optional evidence and never proves a user approval; it can only make a call stricter.

A configured stricter policy still requires a trusted local approval:

```
node src/cli.js profile configure work --confirmation-global on
node src/cli.js profile configure work --confirmation delete_post=on
```

In a terminal, the CLI shows the tool, target, and risks, and asks locally. Without a terminal it
refuses with `APPROVAL_REQUIRED`. The approval is single-use, expires, and is bound to the profile,
account, tool, target hash, content hash, and policy generation. MCP can only propose a settings
change; it cannot approve one. See [configuration.md](configuration.md#confirmations).

## What still works without a browser

- `api` reads and writes need only the profile's API credentials.
- `rss` needs no account.
- `reddit_explain` is offline.
- The API and RSS features start even when Playwright is absent. Only a browser/replay call
  reports `BROWSER_DEPENDENCY_MISSING` or `BACKEND_UNAVAILABLE`.

## Replay versus rendered UI

| Question | Replay | Rendered UI |
|---|---|---|
| Needs Playwright loaded | Yes, to own/renew the profile session, unless a host injects a browserless transport | Yes |
| Returns structured API-shaped data | Mostly; missing fields are disclosed | Partly; rendered pages lack some API fields |
| Exact API paging cursor | Yes, where the mapping supports it | No: `after` is `null`; a separate opaque UI continuation may be issued |
| Writes | All 11 mapped through `/api/*`, unverified live | All 11 fixture-tested, unverified live |
| Unknown write outcome | Stop, no retry | Stop, no retry |
| Social/UI variants | Independent of markup | Markup-dependent; an unrecognized variant fails closed |

The finite replay mappings and their pinned upstream evidence are in
[experiments/replay.md](experiments/replay.md). Browser selectors, steps, and experiment records are
in [experiments/browser-ui.md](experiments/browser-ui.md).

## Diagnostics and recovery

```
node src/cli.js browser doctor --json
node src/cli.js profile status work
node src/cli.js browser close work        # if a task is open
node src/cli.js profile logout work
```

Common results:

| Result | Meaning | What to do |
|---|---|---|
| `BROWSER_DEPENDENCY_MISSING` | Playwright is not installed | Run the explicit setup commands above |
| `BROWSER_BINARY_MISSING` | The package loads but Chromium is absent | Run `npx playwright install chromium` |
| `PROFILE_IN_USE` | Another CLI/MCP process owns the profile | Close that task/process; never attach to a debug port |
| `LOGIN_REQUIRED` | The session expired or was never verified | Run `browser login <name>` again |
| `IDENTITY_MISMATCH` | The profile is signed in as another account | Re-enroll the intended account |
| `USER_HANDOFF_REQUIRED` | CAPTCHA, 2FA, or a security screen | Finish it yourself in the visible window; nothing is retried |
| `CONTINUATION_INVALID` | A UI continuation cannot be resumed in this build | Restart the read without the token |
| `OUTCOME_UNKNOWN` | A write may or may not have reached Reddit | Check the account in a browser; do not retry blindly |

A visible window is left open for a human handoff when safe. Do not close the window that contains a
challenge. The tool does not implement a CAPTCHA solver, stealth, fingerprint spoofing, or an
alternate route around a refusal.

## Optional stored-password recovery

Automatic re-login is off by default and never uses a password from an MCP argument or chat. You may
store a password locally in the OS credential store after explicit local opt-in:

```
node src/cli.js profile credentials work --password-login on
```

The command prompts for the password with hidden input and, for the setting change, a separate local
approval. A single bounded login attempt is made at most once per session lifetime; failure becomes a
human handoff. Disabling the opt-in blocks later attempts. See
[security.md](security.md#browser-password-opt-in).

## Disable, log out, or remove

- **Disable a backend:** `profile configure work --enable-backends api` (or a shorter list). Existing
  open sessions are not a security policy; generations are checked before dispatch.
- **Log out:** `profile logout work` closes the owned browser session, revokes the profile's API
  token when one exists, and reports local removal separately from any remote result. A remote logout
  is not assumed.
- **Remove the profile:** `profile remove work` requires a typed local confirmation, deletes the
  profile's local secrets and metadata, and does not claim to delete the Reddit account or its
  remote sessions. It refuses with `PROFILE_IN_USE` while another local process holds the profile
  lease; close that owner first.
- **Uninstall Playwright:** remove the package and its browser cache with npm/Playwright's own
  commands. The tool never deletes browser binaries for you.

## Limits

- All 32 tools are a target, not a verified claim. Two browser reads are unsupported
  (`get_post_flairs`, `get_more_comments`), and replay does not implement `get_post_flairs`.
- No HTTP, Docker, or `.mcpb` browser support. Those distributions are API-only by construction.
- No live verification of any replay mapping, browser selector, cookie acceptance, or write commit.
- No bulk engagement, account rotation, new moderation/DM/report tools, or borrowing another client's
  identity.
