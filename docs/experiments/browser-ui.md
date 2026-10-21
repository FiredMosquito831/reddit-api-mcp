# Experimental rendered-UI backend (Task 11)

The browser backend drives the current desktop `www.reddit.com` surface in a dedicated enrolled
profile. It is **experimental and not live-verified**. No live Reddit page was loaded while
implementing or testing it. The UI is not a sanctioned API, has no OAuth scopes, and can change
without notice. It is never used to route around an authentication denial, throttle, CAPTCHA, or
account restriction.

## Evidence standard

- Selectors and extractors are best-effort from the modern desktop UI and are exercised only against
  synthetic fixtures in `tests/fixtures/browser/`.
- A fixture test proves the adapter wiring and the parser, not Reddit's current markup, A/B variants,
  or account-specific controls.
- A successful anonymous page load, a visible button label, or an avatar is not identity or write
  evidence.
- `docs/backend-coverage.md` keeps every browser row below `live-verified` until a separately
  authorized account experiment records a result with date, platform, and observation.

## Task-bound steps (no unrestricted click tool)

`src/browser/steps.js` exposes a server-generated task and observation. Supported steps are exactly
`navigate`, `scroll`, `sort`, `expand_branch`, and `prepare_field`. Generic `click`, JavaScript
`evaluate`, `fetch`, header editing, cookie access, and arbitrary selector execution are rejected.
A stale task or observation returns `STEP_STALE` and requires a fresh observation.

Writes are never performed by a host step. The read/observe path can look at the page and prepare
non-secret fields; the final create/edit/delete/vote/save/subscribe action happens only inside the
dispatcher's single durable write boundary, after account and target verification.

Screenshots are page-only and task-relevant. Sign-in, password, 2FA, and recovery-code screens are
refused for automated observation and become `USER_HANDOFF_REQUIRED`; the visible window stays open
for a person. Reddit text is untrusted data: page text cannot change the target, account, policy, or
approval requirement.

## Implemented adapters

- Reads: `src/browser/adapters/reads.js` for 17 of the 19 tools. `get_post_flairs` and
  `get_more_comments` are explicitly `PARAMETER_UNSUPPORTED` (flair-template ids and branch ids are
  not exposed by the rendered page).
- Writes: `src/browser/adapters/writes.js` for all 11 write tools. Known toggle state is required
  before save/join/vote; an unknown state is refused rather than assumed. Delete is a sequential menu
  then confirmation flow on the named target.
- Result metadata: `completeness: 'partial'`, explicit `missingFields`, no fabricated zeros. Paged
  reads return `after: null` and may return a separate opaque UI continuation.

## Out of scope and prohibited

- Old Reddit as a silent fallback, arbitrary sites, desktop control, password-manager inspection,
  cookie export, or a debugging endpoint.
- CAPTCHA solving, 2FA automation, stealth fingerprints, client impersonation, or account rotation.
- Bulk engagement, new moderation/DM/report tools, or using another account to escape a restriction.
- HTTP, Docker, or `.mcpb` browser hosting. Those builds are API-only.

## Running a future authorized experiment

No account or target is authorized today. Before any authenticated discovery, a separate scoped
authorization must name the enrolled profile/account, permitted public read targets, a sandbox
subreddit, operation kinds, the maximum mutation count, whether newly created content may be
edited/deleted, and whether redacted request observation is permitted.

Then record, for each operation:

| Field | Content |
|---|---|
| Purpose | The specific question being answered |
| Profile and account | Alias, verified username; no secrets |
| Target | Public URL/ID, or sandbox content created for the test |
| Platform | Windows version, Chromium/Playwright versions, locale, viewport |
| Expected vs observed | What the adapter predicted, what the page/result showed |
| Outcome | Success, definite rejection, handoff, or unknown; completeness and missing fields |
| Decision | Enable, leave experimental, or mark unsupported |
| Open questions | Selector variants, pagination, rate limits |

Rules for the experiment:

- Start with identity and reads. Do not infer write support from a successful read.
- Exercise one named action at a time inside the approval budget. A challenge, restriction, or
  unknown outcome stops that test; never reroute or retry.
- Do not capture or publish raw cookies, request headers, session state, or screenshots with account
  content. Redact URLs and secret fields.
- Turn every observed defect into a failing offline regression before fixing it.
- Reuse no protected observation as a public fixture.

## Current gaps

- Every selector, the in-page extractor, form behavior, and every write commit path are unverified.
- UI continuation resume is refused (`continuation_resume_unverified`) because the extractor never
  produces a next-page state today.
- Two read tools remain unsupported by design, and the API's exact cursors, metrics, and complete
  comment tree are not promised.
