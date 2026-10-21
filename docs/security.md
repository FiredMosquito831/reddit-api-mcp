# Security

This page covers what is sensitive in this project, where each secret lives, what can go wrong, and what to do about it. Read the password section before you choose an auth mode.

## What is sensitive

| Value | Why it matters |
|---|---|
| **Refresh token** (`oauth` mode) | Anyone with it can act as your account, until it is revoked. |
| **Client secret** (script and web apps) | Lets someone pose as your app. Less dangerous than a token, but still a credential. |
| **Reddit password** (`password` mode, or opt-in browser re-login) | The master key to your account, and it may be reused elsewhere. |
| **Bearer token** (`--http` mode) | Anyone with it can call every tool, and so act on your account. |
| **Browser profile directory** | Contains the enrolled Reddit session cookies. Anyone who can read it may be able to act as that account until the session ends. |
| **Per-profile encryption key** | Protects an optional encrypted session export. There is no export file by default. |
| **`writes.json` / `attempts.json`** | A record of when you wrote, with text fingerprints and outcomes. It holds no text, but it is personal. |

The client ID is not secret. It is printed in the authorize URL, and in the extension's logs if you turn them on.

## Where each secret lives

| Setup | Refresh token | Client secret | Password | Bearer token |
|---|---|---|---|---|
| CLI, `oauth` | OS keychain | not used | not used | not used |
| CLI, `oauth` with `REDDIT_REFRESH_TOKEN` | Environment | not used | not used | not used |
| CLI or stdio server, `password` | not used | Environment | Environment | not used |
| CLI or stdio server, `app` | not used | Environment | not used | not used |
| Named profile | OS keychain, profile-specific service | OS keychain | Optional OS-store browser password, opt-in | not used |
| Browser/replay profile | Reddit cookies in the protected profile directory | not used | as above | not used |
| HTTP server | as above | as above | as above | Environment (`REDDIT_MCP_TOKEN`) |
| Claude Desktop extension | Claude Desktop stores it, as a sensitive setting | likewise | likewise | not used |
| Docker | Environment (you pass it in) | Environment | Environment | Environment |

The tool never writes a password, a client secret, or an environment-supplied token to disk, and it
never prints them to the log. The one exception is `token`, which prints an API refresh token to your
terminal after you confirm, and nothing else. No command prints a browser cookie or session state.

## Browser profiles and sessions

Named profiles use a dedicated Chromium directory per profile, never your everyday browser profile.
The design layers are:

- **OS-store secrets.** Profile API secrets and an optional browser password live in the operating
  system credential store under a profile-specific service, not in `profiles.json` and not in the
  browser directory.
- **Location checks.** Storage must be a local NTFS path. UNC, shared, and roaming locations are
  refused, and the directory ACL is verified or tightened at setup. A user-home path alone is not
  treated as safe.
- **Exclusive ownership.** A CLI or stdio process acquires an atomic local lock for a profile and
  holds it while using that profile. A second process gets `PROFILE_IN_USE`, not a second cookie
  copy. Different profiles may run independently. No Chromium remote-debugging port is exposed.
- **Account binding.** A profile is bound to one verified Reddit account. An alias for the same
  verified account shares one account guard, attempt ledger, and cache generation. A conflicting
  identity blocks authenticated work; the tool never merges or guesses.
- **Local versus remote logout.** `profile logout` closes the local session and reports local
  removal separately from any API revoke attempt. It does not claim to sign other devices out.
  `profile remove` deletes local metadata and secrets only, after a typed confirmation, and refuses
  while another process owns the browser profile lease.

The session has more authority than an OAuth token: browser cookies are not limited to the nine
requested scopes, and Reddit may treat them as a full web session. Treat the profile directory as a
credential. Same-user local processes can read it, and this design does not claim protection from
malware running as you.

Host-visible page observations may contain account content (feeds, comments, usernames). Redacting
credentials does not mean content never reaches the host model provider. Observations are bounded to
the task, and sign-in, password, 2FA, and recovery screens are refused for automated capture.

## Browser password opt-in

Automatic browser re-login is off by default. Enabling `passwordLoginEnabled` requires a separate
local approval, and the password is entered with hidden local input, then stored in the OS credential
store. It is never accepted as an MCP argument, never printed, and never placed in a proposal.

At most one bounded automatic login attempt is made per session lifetime. A CAPTCHA, 2FA, or
account-security screen always becomes a human handoff. A recovered session does not authorize
repeating an uncertain write. Disabling the opt-in blocks later attempts and leaves manual login
available.

## Password mode

`password` mode is a real trade-off, and both projects that inspired this one offer it for the same reason: a browser login is not always possible.

**What it does.** Your password is read from `REDDIT_PASSWORD` each time the tool needs a token. It is sent to Reddit with the client secret, and nothing else keeps it.

**What it costs.**

- It lives in an environment variable for as long as the process runs. Every process you start from that environment inherits it. A debugging tool, a crash report, or a child process can expose it.
- It is the account's master password, not a revocable grant. Revoking it means changing the password, which signs you out elsewhere too.
- With two-factor authentication on, the value is `password:CODE`. The code expires in under a minute, so the value is only good for the moment you set it, and the tool cannot refresh the token with it later.

**What to do.** Use `oauth` unless you cannot use a browser login. If you use `password`, keep the environment variable out of shell history and out of shared files, prefer your host's secret store, and use a dedicated password you can change without side effects. Remove the variable when you stop.

## Scopes

Login asks for the least that the features need. This is deliberate:

- Reddit's app review checks requested scopes against the use you described.
- A token with every scope does far more harm if it leaks or a bug misfires.
- A scope that no feature uses is a scope nobody has tested.

The scopes requested are `identity`, `read`, `history`, `mysubreddits`, `subscribe`, `vote`, `submit`, `edit`, and `save`. The scopes left out are below. Each has a reason, and `reddit-cli scopes` prints the same table.

| Left out | Why |
|---|---|
| `creddits` | Spends Reddit coins. No feature needs it. |
| `flair` | Changes your user flair. No feature needs it. |
| `livemanage` | Manages live threads. No feature needs it. |
| `modconfig`, `modcontributors`, `modflair`, `modlog`, `modmail`, `modothers`, `modposts`, `modself`, `modwiki` | Moderation. This project does no moderation, and these act on communities other people run. |
| `privatemessages` | Direct messages. Excluded on purpose. |
| `report` | Filing reports can be used to brigade. No feature needs it. |
| `structuredstyles` | Subreddit styling. Not used. |
| `wikiedit`, `wikiread` | Wiki pages. Not used. |

`REDDIT_SCOPES` can request a different set. The granted scopes are fixed when you log in, so a change needs a new login. Asking for more than the features need is the first step toward a token that can do more damage than it should.

## Threats and controls

**A prompt-injected instruction makes Claude post, delete, or vote.** A web page, a document, a comment, or a tool result can contain instructions meant for Claude. Controls: every write still passes the durable account boundary; a profile can require a trusted local approval for any or all of the 11 write tools; the host's approval prompt should stay on for writes. Application-level confirmation is off by default, so do not rely on `confirm: true` as a security gate. Reddit page text is data: it cannot change the account, target, policy, or approval requirement. Read a proposed post or reply before you approve it. Deletes cannot be undone, so treat them with extra care.

**A write's response is lost.** Controls: a durable attempt is recorded before the send, exactly one dispatch is made, and an ambiguous result becomes `OUTCOME_UNKNOWN`. It is never retried through the same or another backend, and the cache generation is invalidated. Check the account in a browser before trying again. A restart does not reopen or silently resend an unknown write. The pending attempt stays visible in `profile status`/`profile attempts`; after you verify the result, `profile resolve <name> <attempt-id> succeeded|failed` records it without resending anything.

**An approval is replayed or borrowed.** Controls: approvals are single-use, short-lived, and bound to profile, account, tool, target hash, content hash, and policy generation. MCP cannot approve its own proposal, and no approval secret is returned in a tool result. Approval is a local trusted action; a conversation transcript is not one.

**A settings change quietly weakens security.** Controls: approval-policy changes and enabling stored-password login need a local settings approval. A changed policy or credential generation cancels queued writes before dispatch rather than applying new, weaker rules to an in-flight operation. User-instructed backend/profile/visibility selection is operational configuration and cannot enable a backend that was never enrolled.

**A token leaks.** Controls: the keychain for the refresh token; no secret in logs or in tool results; `token` asks for confirmation. If you suspect a leak, revoke the token with `logout`, and check your account's recent activity on Reddit.

**Your password leaks in `password` mode.** Change it on Reddit. This also signs you out of other sessions. Then remove the variable from every place it was set.

**A bearer token leaks in HTTP mode.** Anyone with the token can call every tool. Rotate it: generate a new token with `node src/mcp.js --generate-token`, set it, and restart the server. Rotating it does not revoke your Reddit access, so also revoke or rotate the Reddit credentials if the leak reached them.

**The HTTP server is reachable from outside.** The default bind is `127.0.0.1`. If you widen it, anyone who can reach the port can use the tools, if they also have the token. Put a TLS-terminating proxy and access control in front. Do not expose the plain HTTP port to the internet. See [deployment.md](deployment.md).

**Abuse of the account.** Controls: no bulk voting, no bulk posting, no moderation, no direct messages. Writes are spaced, capped, and checked for duplicates. These are backstops for your judgment, not a substitute for it.

**Supply chain.** Dependencies are pinned by `package-lock.json`, which is committed. The runtime dependencies are the MCP SDK, zod, `@napi-rs/keyring`, and commander (CLI only). The packager `@anthropic-ai/mcpb` is a development dependency. Run `npm audit` after you update.

**Data handling.** Reddit's rules limit what you may do with its data. Do not use Reddit content to train models, and do not keep content that people have deleted. This project does neither.

**The extension runs with your user's permissions.** It can do anything your account can do, and it can read any file you can. The account is the real limit. Keep the approval prompts on.

## Revoking and cleaning up

- **Remove the OAuth grant:** `node --env-file-if-exists=.env src/cli.js logout`. This revokes the refresh token with Reddit, and removes it from the keychain.
- **Remove a profile:** `reddit-cli profile logout <name>` closes the owned browser session and revokes its API token when possible; `reddit-cli profile remove <name>` then deletes local metadata and OS-store secrets after a typed confirmation. Removal refuses with `PROFILE_IN_USE` while another local process holds the profile's browser lease, so a live session is never deleted out from under its owner. Neither command claims to end Reddit sessions on other devices.
- **Remove the password:** change it on Reddit, and remove `REDDIT_PASSWORD` from every environment that had it. Disable browser password opt-in with `profile credentials <name> --password-login off`.
- **Change or remove the app:** use [old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps/). Changing the client secret, or deleting the app, stops every token it issued from working.
- **Clear the write history:** delete the account directory's `attempts.json`/`writes.json` in `REDDIT_CLI_HOME`. This also resets the duplicate check and the hourly count.
- **Remove the extension:** uninstall it from Claude Desktop, and remove the stored settings with it.

## Checklist

- [ ] The auth mode is `oauth`, unless you have a reason not to.
- [ ] `.env` and any file with secrets are git-ignored, and never shared.
- [ ] Secrets are not in shell history, screenshots, or chat transcripts.
- [ ] The scopes requested are the nine in this document, or a set you chose deliberately.
- [ ] The HTTP server, if you run it, has a strong token, binds to localhost, and sits behind a TLS proxy if it is reachable at all.
- [ ] Host approval prompts are on for write tools. Application confirmation is off by default; turn on a profile global or per-tool policy if you want a second local gate.
- [ ] Experimental backends are enabled only on a dedicated profile, and its directory is treated as a credential.
- [ ] You have tested writes in a community you own before you trust them.
- [ ] You know how to revoke: `logout`, `profile logout/remove`, a password change, or the app's page.

## Reporting a problem

This repository is public. Report security problems to the repository owner privately, not in a public issue. Do not put secrets, tokens, or passwords in the report.
