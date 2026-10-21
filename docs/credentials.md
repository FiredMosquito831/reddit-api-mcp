# Getting Reddit credentials

This guide covers every step from "I have a Reddit account" to "the tool can act for it". Each step has the link you need.

Reddit's developer rules change, and I could not open Reddit's own pages while writing this. The links below are the pages Reddit publishes. Read the policy pages yourself before you apply for anything.

## Which credentials you need

| Mode | Credentials | Where they come from |
|---|---|---|
| `oauth` (default) | A client ID from an **installed app**, your username, and a one-time browser login | Step 3, then `login` |
| `password` | A client ID **and secret** from a **script** app, your username, and your password | Step 3, plus your Reddit password |
| `app` | A client ID **and secret** from a **script** or **web** app | Step 3 |

Your Reddit password is never stored by this project. The `oauth` mode never needs it.

## Step 1: Pick the account

Every action the tool takes is done as one Reddit account. Choose it deliberately, because posts and votes come from it.

1. Sign in at [reddit.com](https://www.reddit.com).
2. If you use two-factor authentication, read Reddit's help article on whether it works with third-party apps: [Does Reddit's two-factor authentication work with third-party apps?](https://support.reddithelp.com/hc/en-us/articles/360058446991-Does-Reddit-s-two-factor-authentication-work-with-third-party-apps). In `password` mode you will put `:CODE` after your password.

## Step 2: Check whether you can create an app yourself

Reddit's app page is at **[old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps/)** (the same page is also at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)). Signed in, scroll to the bottom and look for **"create another app..."**.

- **If the form opens**, go to Step 3.
- **If there is no button, or it sends you to a policy page**, self-service creation is probably closed for your account. Go to Step 5.
- **If the form opens and create app still does nothing after you complete the check** (Step 3), self-service is closed for your account. Go to Step 5.

The sources disagree. The [jordanburke/reddit-mcp-server README](https://github.com/jordanburke/reddit-mcp-server) says Reddit closed self-service app creation in November 2025, and sends new developers to the Developer Support form in Step 5. The [karanb192/reddit-mcp-buddy README](https://github.com/karanb192/reddit-mcp-buddy) and [PRAW's authentication guide](https://praw.readthedocs.io/en/latest/getting_started/authentication.html) still describe the self-service path. None of these is a Reddit source, so treat them as reports.

## Step 3: Create the app

Fill in the form:

| Field | Value |
|---|---|
| **name** | Anything, for example `reddit-api-mcp-personal`. Reddit shows it to you when you approve access. |
| **app type** | See the table below. |
| **description** | Optional. |
| **about url** | Optional. Leave it blank. |
| **redirect uri** | `http://localhost:8080`. It must match `REDDIT_REDIRECT_URI` exactly, including the port. |

Choose the app type by mode:

| App type | Has a secret | Use it for | Notes |
|---|---|---|---|
| **installed app** | No | `oauth` mode (the default) | No secret to store. The simplest choice for this project. |
| **script app** | Yes | `password` and `app` modes, and `oauth` too | Its card says "personal use script". |
| **web app** | Yes | `oauth` mode | Works, but is meant for hosted web apps. |

Complete the **I'm not a robot** check first, and finish any puzzle Reddit shows. If you click **create app** with the box unticked, the same form stays on screen with no error message.

Clicking **create app** also agrees to Reddit's Developer Terms and Data API Terms, which the form links at the top. Read them first.

Click **create app** once the check passes. If it still does not create the app, self-service is probably closed for your account. Go to Step 5.

## Step 4: Copy the client ID and secret

On the apps page, each app is a card:

- **Client ID:** the random string shown under the app's name. For a script app it sits under the label "personal use script". PRAW describes it as at least 14 characters.
- **Client secret:** for script and web apps, the string next to the word "secret". PRAW describes it as at least 27 characters. Installed apps have no secret.

Put the values in a password manager. Put them in `.env`, which the repository ignores. Never paste them into an issue, a chat, or a commit.

To change or remove the app later, use the same apps page.

## Step 5: If you must request access instead

When self-service is closed, or when you need to ask Reddit for something it does not offer, use Reddit's developer support form.

1. **Read the rules first.**
   - [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy). Search summaries say API access needs Reddit's approval first, and that commercial use needs written permission.
   - [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).
   - [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki).
2. **Open the request form:** [Developer Support request](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164).
3. **Choose the options Reddit names.** Select "I'm a Developer", then "I want to register to use the Reddit API." The [Reddit API wiki](https://www.reddit.com/r/reddit.com/wiki/api/) gives those labels, but it also ties the request to "a valid moderation use case". This project does no moderation, so read that page before you submit. The request may be declined.
4. **Describe the use.** Adapt this draft. It is accurate for this project, and it matches what the software does:

   > I'm a developer building a personal, non-commercial command-line tool and MCP server for my own Reddit account. It uses OAuth with a browser login, so no password is stored. Each command performs one action I request: reading feeds, searches, threads, and user profiles; joining or leaving named subreddits; posting or commenting when I ask; editing or deleting my own content; and voting or saving named items. It does not scrape pages, use private endpoints, run bulk or automated voting, moderate, send direct messages, train models on Reddit data, or keep deleted content. It sends a descriptive User-Agent, respects rate limits, and enforces its own spacing and hourly caps. Installed-app redirect URI: http://localhost:8080. Reddit account: u/YOUR_USERNAME.

5. **Submit it once.** Reddit's policy reportedly rules out duplicate requests for the same use.
6. **Wait.** Reddit reviews the request. No timeline is published, and approval is not guaranteed. Reddit's reply is where the credentials, or the next steps, will come from. I could not confirm how Reddit delivers them.

**Dates to know.** A Reddit changelog dated October 8, 2026 is reported to say: new public API applications stop being accepted on October 31, 2026; apps that have neither registered nor replied to Reddit's outreach lose access from January 12, 2027; and public API access ends in March 2027. I could not open that page, so check it yourself: [Changelog, October 8, 2026](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026).

**Migration program.** Reddit also has a [Developer Platform App Migration Program 2026](https://support.reddithelp.com/hc/en-us/articles/47822311698452-Reddit-Developer-Platform-App-Migration-Program-2026-Terms). Its terms, as summarized, cover only apps that predate March 25, 2026. A new app would probably not qualify.

**Labels.** If Reddit asks about an app label for automated accounts, read [Apps on Reddit and how to get a label for your app](https://support.reddithelp.com/hc/en-us/articles/45376380316052-Apps-on-Reddit-and-how-to-get-a-label-for-your-app).

## Step 6: Make a test community

Make your first writes in a community you own, not in someone else's. Create one from your Reddit account, and use it for `--dry-run` tests and the first real post. Reddit's spam filters and moderators act on other people's communities, so a test community keeps mistakes contained.

## Step 7: Get the software

1. Install Node.js 22.12 or newer: [nodejs.org](https://nodejs.org/).
2. Install Git, then clone the repository: [github.com/FiredMosquito831/reddit-api-mcp](https://github.com/FiredMosquito831/reddit-api-mcp). It is public, so you can clone it without signing in.
3. In the project folder:
   ```
   npm install
   cp .env.example .env          # Windows: copy .env.example .env
   ```

## Step 8: Configure and log in

Edit `.env` for your mode. The full list is in [configuration.md](configuration.md).

**`oauth` mode** (installed app, the default):

```
REDDIT_CLIENT_ID=your-client-id
REDDIT_USERNAME=your-username
```

Then log in:

```
node --env-file-if-exists=.env src/cli.js login
```

The command prints an authorize URL. Open it while signed in as the right account, click **Allow**, and your browser lands on `http://localhost:8080/...`. That page fails to load. That is expected. Copy the full address from the address bar and paste it into the terminal. The refresh token goes to your OS keychain.

**`password` mode** (script app):

```
REDDIT_AUTH_MODE=password
REDDIT_CLIENT_ID=your-client-id
REDDIT_CLIENT_SECRET=your-secret
REDDIT_USERNAME=your-username
REDDIT_PASSWORD=your-password
```

With two-factor on, use `your-password:123456`, with the code you see at that moment. This mode stores nothing. Read the trade-off in [security.md](security.md#password-mode) before you use it.

**`app` mode** (read-only):

```
REDDIT_AUTH_MODE=app
REDDIT_CLIENT_ID=your-client-id
REDDIT_CLIENT_SECRET=your-secret
REDDIT_USERNAME=your-username
```

## Step 9: Check it

```
node --env-file-if-exists=.env src/cli.js test
```

Each line should read `ok`. A `FAIL` line includes the reason. See [troubleshooting.md](troubleshooting.md) for the common ones.

## Step 10: Make a first write, carefully

```
node --env-file-if-exists=.env src/cli.js post YOUR_TEST_SUB --title "Hello" --text "A test post" --dry-run
node --env-file-if-exists=.env src/cli.js post YOUR_TEST_SUB --title "Hello" --text "A test post"
```

The first command prints what would be sent and sends nothing. The second sends it. Application-level confirmation is off by default; a profile can require a trusted local approval. Use `--dry-run` and a community you own for the first real write.

## Revoking and cleaning up

- **`oauth` mode:** `node --env-file-if-exists=.env src/cli.js logout` revokes the refresh token with Reddit and removes it from the keychain.
- **`password` mode:** the tool stores nothing. If your password may have leaked, change it on Reddit.
- **The app itself:** edit or remove it on [old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps/).

## All the links in one place

- Reddit app page: [old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps/), [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
- Developer support request: [support.reddithelp.com/…/requests/new?ticket_form_id=14868593862164](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164)
- Responsible Builder Policy: [support.reddithelp.com/…/42728983564564-Responsible-Builder-Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- Developer docs overview: [Developer Platform & Accessing Reddit Data](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data)
- Data API wiki: [Reddit Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
- Changelog (October 8, 2026): [Changelog](https://support.reddithelp.com/hc/en-us/articles/54353370049684-Changelog-October-8-2026)
- Migration program terms: [Developer Platform App Migration Program 2026](https://support.reddithelp.com/hc/en-us/articles/47822311698452-Reddit-Developer-Platform-App-Migration-Program-2026-Terms)
- App labels: [Apps on Reddit and how to get a label for your app](https://support.reddithelp.com/hc/en-us/articles/45376380316052-Apps-on-Reddit-and-how-to-get-a-label-for-your-app)
- Two-factor and third-party apps: [Help article](https://support.reddithelp.com/hc/en-us/articles/360058446991-Does-Reddit-s-two-factor-authentication-work-with-third-party-apps)
- PRAW's OAuth guide: [praw.readthedocs.io](https://praw.readthedocs.io/en/latest/getting_started/authentication.html)
- Reddit API wiki (archived): [github.com/reddit/reddit/wiki/API](https://github.com/reddit/reddit/wiki/API)
- Reddit OAuth2 wiki (archived): [github.com/reddit-archive/reddit/wiki/OAuth2](https://github.com/reddit-archive/reddit/wiki/OAuth2)
- Node.js: [nodejs.org](https://nodejs.org/)
- This project: [github.com/FiredMosquito831/reddit-api-mcp](https://github.com/FiredMosquito831/reddit-api-mcp)

## Reddit's API policy

Reddit's rules are the ones that matter, and they change. This project follows the rules that apply to a personal, non-commercial tool acting for its owner:

- Use the official API with your own grant. This project does not scrape public pages, use undocumented private endpoints, or borrow another client's ID. An experimental, owner-approved exception exists for replaying requests and operating the rendered UI through a dedicated browser profile you enroll yourself; Reddit's terms may not permit or continue to permit that route. Prefer the official API and follow Reddit's current rules. See [browser-mode.md](browser-mode.md).
- Identify the tool honestly in the User-Agent. Never impersonate a client.
- Keep actions single and deliberate. No bulk voting, no automated engagement, no spam.
- Respect rate limits. The client enforces a cap of 60 requests a minute and backs off when Reddit throttles.
- Do not use Reddit content to train models, and do not keep content people have deleted.

If Reddit tells you the rules have changed for your account, follow Reddit's rules, not this document.
