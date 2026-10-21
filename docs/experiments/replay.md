# Experimental request replay (Task 10)

Request replay sends the profile's own enrolled Reddit web session at `www.reddit.com` for a small,
explicit set of operations. It is **experimental and not live-verified**. It is not a Reddit API, has
no OAuth scopes, and may stop working at any time. It is never used to route around an authentication
denial, throttle, CAPTCHA, or account restriction.

## Pinned upstream evidence

Inspected primary source at commit
[`32745d3450f4291845220e0d9a6deee33ee6eacf`](https://github.com/Apollo-Reborn/Apollo-Reborn/tree/32745d3450f4291845220e0d9a6deee33ee6eacf):

- `docs/web-json-spike-findings.md`
- `src/ApolloWebJSON.m`

Measurements in that document were made in an **iOS 26 simulator** on a residential network. They are
prior art, not proof for this repository, for Windows Chromium, or for this owner's account. No live
Reddit request was made while implementing or testing this task.

What the source establishes:

| Mechanism | Evidence | Adopted here |
|---|---|---|
| Cookie-authenticated `GET https://www.reddit.com/...json` | Feed and subreddit listings measured HTTP 200 with personalized content; anonymous requests returned a 403 HTML block page | Yes, for the mapping paths below |
| `GET https://www.reddit.com/api/me.json` | Login/identity flow keys every decision on a returned username; `data.modhash` is read from the same payload | Yes (identity and modhash source) |
| Listing/page `.json` path classes | Front page, `/r/<sub>[/sort|comments|search|about|wiki|duplicates]`, `/user|/u/<name>[/where|about|m]`, `/comments/...`, `/search`, `/subreddits/...`, `/message/...`, `/prefs` | Used only where a shipped read needs them |
| Every `/api/*` GET is served as JSON natively | Classifier returns the API kind without a `.json` suffix | Used for `/api/morechildren` |
| Cookie + `X-Modhash` POST to `www.reddit.com/api/*` | Generic write routing implemented upstream; simulator vote/comment/edit reported working | Used for the eleven write tools, with write verification still unproven |
| Legacy write response shape | `/api/comment` and `/api/editusertext` return `{parent, content:"<html>"}` with `data-fullname="t1_…"` instead of modern thing JSON | Handled explicitly in write verification |
| `403` + `text/html` block page | ~190 KB HTML, used by upstream to detect expiry | Treated as a human security handoff, never a retry |
| `token_v2` bearer reuse, broad authenticated GraphQL, media/upload lease | Mentioned as a follow-up, not established | **Not adopted** |
| Client User-Agent spoofing, CAPTCHA solving, stealth fingerprints | Out of scope and prohibited | **Not adopted** |

## Transport rules

`src/replay/transport.js` accepts only checked-in mapping objects:

- **Destination allowlist**: HTTPS and exactly `https://www.reddit.com` by default. No port, userinfo,
  fragment, media/CDN host, or second origin.
- **Path allowlist**: `/api/`, `/r/`, `/u/`, `/user/`, `/comments/`, `/subreddits/`, plus `/`,
  `/.json`, and `/search.json`. No `..`, encoded separators, backslashes, query in the path, or
  control characters.
- **Method allowlist**: mapped `GET` and `POST` only. A caller cannot supply a path, query, form,
  header, cookie, or method outside the mapping builder.
- **Credentials**: the live Playwright request context's cookie jar only (the browser-associated
  context shares cookies with the browser). No `Cookie`, `Authorization`, or `User-Agent` header is
  set by this module. Writes add only `X-Modhash`, read from the same session's `/api/me.json`
  again for every mutation.
- **Redirects**: handled manually, at most three, GET only, and only to allowlisted first-party paths.
  A mutation redirect is never followed (a single write is never sent twice). A redirect to `/login`
  or another non-evidenced path is refused.
- **Identity**: the browser session's verified identity must match the profile's expected username and
  account key before any operation request. A write always re-probes the live session immediately
  before its single mutation, so a visible profile that was signed out and back in as another account
  cannot write or read as the old account. A read may reuse a recent verification for a bounded
  window (one minute by default, `identityTtlMs`). An identity mismatch blocks before sending. A
  successful identity probe does not enable any operation that lacks a mapping.
- **Idle-closed session**: the session manager may close an idle session and dispose its Playwright
  context. The transport drops its cached context, identity, and modhash, and a GET reopens the
  session once. A mutation is never resent for this or any other reason.
- **Errors**: `401` is `LOGIN_REQUIRED` (`session_expired`); `403` HTML is
  `USER_HANDOFF_REQUIRED` (`security_challenge`); `403` JSON is a terminal backend rejection;
  `429` is `THROTTLED`; an in-body `RATELIMIT` write refusal is also `THROTTLED` (`rate_limited`),
  distinct from a backend outage; ambiguous write responses (5xx, invalid JSON, HTML, redirect,
  transport failure) are `OUTCOME_UNKNOWN` and are never retried. Response bodies, cookies,
  `Set-Cookie`, and modhash values never enter a result, error, or log.
- **Standalone session**: `requestFactory` is the only browserless extension point. A standalone
  encrypted own-session store is **not implemented**; the upstream evidence uses WebView cookies and
  does not establish an export/renewal format this project could verify.

## Operation status

Status values:

- `evidenced-unverified`: an upstream-evidenced mechanism and path, never live-tested here.
- `upstream-routable-unverified`: covered by the upstream generic `/api/*` write route, but not
  individually proven, including write acceptance.
- `unsupported`: deliberately absent because no inspected evidence establishes the path.

### Reads (18 mapped read tools; two are compositions)

| Tool | Method and path | Status |
|---|---|---|
| `get_me` | `GET /api/me.json` | evidenced-unverified |
| `browse_subreddit` | `GET /r/<sub>/<sort>.json` (`limit`, `t`, `after`; `includeInfo` adds `/about.json`) | evidenced-unverified |
| `get_top_posts` | `GET /r/<sub>/top.json` | evidenced-unverified |
| `get_subreddit_info` | `GET /r/<sub>/about.json` | evidenced-unverified |
| `get_subreddit_rules` | `GET /r/<sub>/about/rules.json` | evidenced-unverified (about path classified; exact rules shape assumed from the official endpoint) |
| `get_trending_subreddits` | `GET /subreddits/popular.json` | evidenced-unverified |
| `search_reddit` | `GET /search.json` or `/r/<sub>/search.json` | evidenced-unverified |
| `get_reddit_post`, `get_post_comments` | `GET [/r/<sub>]/comments/<id>.json` | evidenced-unverified |
| `get_more_comments` | `GET /api/morechildren` | evidenced-unverified |
| `get_user_info` | `GET /user/<name>/about.json` | evidenced-unverified |
| `get_user_posts`, `get_user_comments` | `GET /user/<name>/<submitted|comments>.json` | evidenced-unverified |
| `user_analysis` | Composition of user about plus two 100-item listings | evidenced-unverified |
| `get_my_overview`, `get_my_saved` | `GET /user/<verified-name>/<overview|saved>.json` | evidenced-unverified |
| `list_my_subreddits` | `GET /subreddits/mine/subscriber.json` | evidenced-unverified |
| `test_reddit_mcp_server` | Composition of the popular listing and `/api/me.json` | evidenced-unverified |
| `get_post_flairs` | — | **unsupported**: `flair_path_not_evidenced` (`/r/<sub>/api/link_flair_v2` is not in the upstream read classifier) |

`browse_subreddit_rss` and `reddit_explain` never reach replay; they are routed before backend
selection.

### Writes (all eleven guarded tools)

| Tool | Method and path | Status |
|---|---|---|
| `create_post` | `POST /api/submit/` | upstream-routable-unverified |
| `reply_to_post` | `POST /api/comment/` | upstream-routable-unverified; legacy response handled |
| `edit_post`, `edit_comment` | `POST /api/editusertext/` | upstream-routable-unverified; legacy response handled |
| `delete_post`, `delete_comment` | `POST /api/del/` | upstream-routable-unverified |
| `save_content`, `unsave_content` | `POST /api/save/`, `/api/unsave/` | upstream-routable-unverified |
| `vote_on_thing` | `POST /api/vote/` | upstream-routable-unverified |
| `subscribe_to_subreddit`, `unsubscribe_from_subreddit` | `POST /api/subscribe/` | upstream-routable-unverified |

Write framing is unchanged from the official-API plans (same validation, same form fields, footer
appended to text posts, comments, and edits). Every mutation runs once inside the dispatcher's shared
durable boundary; preparation is network-free.

Write verification is deliberately strict:

- `create_post` needs a non-empty `data.id` or `data.name`.
- `reply_to_post`, `edit_post`, `edit_comment` need a modern thing with a non-empty `id`/`name`, or
  the legacy `content` HTML with a `data-fullname="t1_…"` value. Anything else is `OUTCOME_UNKNOWN`.
- Delete, vote, save, and subscribe accept a JSON object with no `json.errors`. A legacy jQuery
  wrapper is recognized but never treated as success.

## Missing and unverified

- **Missing operation**: `get_post_flairs` (explicitly listed above). No private endpoint was guessed.
- **Not established**: `token_v2` bearer requests, broad GraphQL, media/upload, inbox, prefs, wiki,
  duplicates, multireddit pages. They are not exposed even though the upstream read classifier can
  route some of them.
- **Not proven on Windows**: the upstream measurements are iOS simulator results. Request-context
  cookie sharing is documented by Playwright, but Reddit's acceptance of this path on Windows Chromium
  has not been observed.
- **Not proven live**: every mapping above. `docs/backend-coverage.md` and the coverage module must
  keep replay statuses non-verified until an approved bounded account experiment records results.
- **No eternal session**: replay uses the browser profile's current cookies. If the session is
  expired, the transport reports `LOGIN_REQUIRED`; re-authentication is the normal enrollment/login
  flow, not a replay retry.
- **HTTP/Docker/MCPB**: replay is local CLI/stdio only. Those distributions remain API-only even
  though this module has no Browser-specific import.

## Enabling and troubleshooting

Replay is selected only for a named profile with `replay` in its enabled backends (explicit backend
selection or the profile's preference order). Opening the dedicated browser profile is required
unless a `requestFactory` is injected by an embedding test/host. Nothing is installed, downloaded, or
logged in automatically.

Symptoms and canonical results:

- `LOGIN_REQUIRED` (`session_expired`): sign in again in the visible browser profile.
- `USER_HANDOFF_REQUIRED` (`security_challenge`): complete the challenge yourself; no automatic solve
  or alternate route is attempted.
- `BACKEND_UNAVAILABLE` (`reddit_refusal`): Reddit refused the write for a reason other than
  throttling; nothing is resent or rerouted.
- `THROTTLED` (`rate_limited`): wait, then retry deliberately. Throttling is never rerouted.
- `IDENTITY_MISMATCH`: the browser profile is signed in to a different account than the profile
  expects; re-enroll explicitly.
- `UNSUPPORTED_OPERATION` (`flair_path_not_evidenced`): replay does not implement post flairs.
- `OUTCOME_UNKNOWN`: the write response did not prove the result. Do not retry blindly; check the
  account in a browser.
