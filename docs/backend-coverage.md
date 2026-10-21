# Backend coverage ledger

This page is the repository's evidence record, generated from `src/coverage.js` and checked by
`tests/coverage.test.js`. It describes what is **implemented and tested offline**, never what has
been proven against a live Reddit account. The approved design's all-32-tools target is not met until
a separately authorized live experiment (Task 16 in the implementation plan) records `live-verified`
rows. `summarizeCoverage().noAppComplete` therefore remains `false`.

Status values:

- `implemented-offline-tested`: the adapter or mapping exists, and its offline tests pass. This does
  not mean Reddit, Playwright, or a browser was exercised.
- `live-verified`: observed on an authorized live account and date. No row has this status yet.
- `unsupported`: deliberately absent because no honest mapping exists; the reason is recorded.
- `not-yet-tested`: implemented scaffolding with no adapter-level coverage claim.

Every row is dated `2026-10-21`, platform `win32`, and carries `missingFields`, `blockers`,
`unsupportedParameters`, and an `evidenceRef` in `src/coverage.js`. An empty `unsupportedParameters`
cell means the backend accepts the tool's documented inputs; `/` means the whole operation is
unsupported.

## Evidence sources

| Backend | EvidenceRef |
|---|---|
| `api` | Original offline API suites: `tests/actions.test.js`, `tests/reads.test.js`, `tests/writes.test.js`, `tests/api-backend.test.js`, `tests/mutation-outcomes.test.js`. No live API call has been made; there is no Reddit client ID. |
| `replay` | `src/replay/mappings.js`, pinned to Apollo-Reborn commit [`32745d3450f4291845220e0d9a6deee33ee6eacf`](https://github.com/Apollo-Reborn/Apollo-Reborn/tree/32745d3450f4291845220e0d9a6deee33ee6eacf) (`docs/web-json-spike-findings.md`, `src/ApolloWebJSON.m`). Those measurements were iOS-simulator, residential-network prior art; Windows Chromium acceptance is unproven. Offline tests: `tests/replay-mappings.test.js`, `tests/replay-transport.test.js`. |
| `browser` | `src/browser/adapters/reads.js`, `src/browser/adapters/writes.js`, `src/browser/steps.js`. Tests: `tests/browser-reads.test.js`, `tests/browser-writes.test.js`, `tests/browser-steps.test.js`, `tests/browser-redaction.test.js`, with synthetic fixtures under `tests/fixtures/browser/`. Selectors and the in-page extractor have never run against live Reddit. |
| `rss` | `tests/rss.test.js`; public Atom feed, availability-dependent. |
| `offline` | `tests/misc.test.js`; the glossary does not use the network. |

Details of the replay mappings, transport allowlists, and response verification are in
[experiments/replay.md](experiments/replay.md). Browser steps, enrollment, and limitations are in
[browser-mode.md](browser-mode.md) and [experiments/browser-ui.md](experiments/browser-ui.md).

## Explicit unsupported operations and parameters

| Backend | Tool | Why |
|---|---|---|
| `replay` | `get_post_flairs` | `flair_path_not_evidenced`: the inspected upstream read classifier allows `/r/<sub>/{sorts,comments,search,about,wiki,duplicates}` but not the flair-template path, and no equivalent `/api/*` GET is established. No private endpoint was guessed. |
| `browser` | `get_post_flairs` | `flair_template_ids_unavailable`: rendered flair labels do not expose the template ids this tool returns. |
| `browser` | `get_more_comments` | `branch_ids_unavailable`: expanding named comment branches needs exact ids the rendered page does not expose; generic scrolling is not equivalent. |
| `browser` | All seven paged reads (`browse_subreddit`, `get_top_posts`, `search_reddit`, `get_user_posts`, `get_user_comments`, `get_my_overview`, `get_my_saved`) | `after` is an official API cursor. A rendered listing returns `after: null` and, where supported, a separate opaque UI continuation bound to profile, account, backend, filter, and session generation. |
| `browser` | Reads with unavailable display fields | Missing fields are listed per row and returned as `null` with `missingFields` metadata, never as zero. |

All 11 write tools exist on all three backends behind the same durable write boundary. Confirmation
policy is separate from backend support; see [configuration.md](configuration.md#confirmations).

## Ledger

| Tool | Backend | Status | Unsupported parameters | Missing fields |
|---|---|---|---|---|
| `get_me` | api | implemented-offline-tested |  |  |
| `browse_subreddit` | api | implemented-offline-tested |  |  |
| `get_top_posts` | api | implemented-offline-tested |  |  |
| `get_subreddit_info` | api | implemented-offline-tested |  |  |
| `get_subreddit_rules` | api | implemented-offline-tested |  |  |
| `get_post_flairs` | api | implemented-offline-tested |  |  |
| `get_trending_subreddits` | api | implemented-offline-tested |  |  |
| `search_reddit` | api | implemented-offline-tested |  |  |
| `get_reddit_post` | api | implemented-offline-tested |  |  |
| `get_post_comments` | api | implemented-offline-tested |  |  |
| `get_more_comments` | api | implemented-offline-tested |  |  |
| `get_user_info` | api | implemented-offline-tested |  |  |
| `get_user_posts` | api | implemented-offline-tested |  |  |
| `get_user_comments` | api | implemented-offline-tested |  |  |
| `user_analysis` | api | implemented-offline-tested |  |  |
| `get_my_overview` | api | implemented-offline-tested |  |  |
| `get_my_saved` | api | implemented-offline-tested |  |  |
| `list_my_subreddits` | api | implemented-offline-tested |  |  |
| `test_reddit_mcp_server` | api | implemented-offline-tested |  |  |
| `create_post` | api | implemented-offline-tested |  |  |
| `reply_to_post` | api | implemented-offline-tested |  |  |
| `edit_post` | api | implemented-offline-tested |  |  |
| `edit_comment` | api | implemented-offline-tested |  |  |
| `delete_post` | api | implemented-offline-tested |  |  |
| `delete_comment` | api | implemented-offline-tested |  |  |
| `save_content` | api | implemented-offline-tested |  |  |
| `unsave_content` | api | implemented-offline-tested |  |  |
| `vote_on_thing` | api | implemented-offline-tested |  |  |
| `subscribe_to_subreddit` | api | implemented-offline-tested |  |  |
| `unsubscribe_from_subreddit` | api | implemented-offline-tested |  |  |
| `get_me` | replay | implemented-offline-tested |  |  |
| `browse_subreddit` | replay | implemented-offline-tested |  |  |
| `get_top_posts` | replay | implemented-offline-tested |  |  |
| `get_subreddit_info` | replay | implemented-offline-tested |  |  |
| `get_subreddit_rules` | replay | implemented-offline-tested |  |  |
| `get_post_flairs` | replay | unsupported | / |  |
| `get_trending_subreddits` | replay | implemented-offline-tested |  |  |
| `search_reddit` | replay | implemented-offline-tested |  |  |
| `get_reddit_post` | replay | implemented-offline-tested |  |  |
| `get_post_comments` | replay | implemented-offline-tested |  |  |
| `get_more_comments` | replay | implemented-offline-tested |  |  |
| `get_user_info` | replay | implemented-offline-tested |  |  |
| `get_user_posts` | replay | implemented-offline-tested |  |  |
| `get_user_comments` | replay | implemented-offline-tested |  |  |
| `user_analysis` | replay | implemented-offline-tested |  |  |
| `get_my_overview` | replay | implemented-offline-tested |  |  |
| `get_my_saved` | replay | implemented-offline-tested |  |  |
| `list_my_subreddits` | replay | implemented-offline-tested |  |  |
| `test_reddit_mcp_server` | replay | implemented-offline-tested |  |  |
| `create_post` | replay | implemented-offline-tested |  |  |
| `reply_to_post` | replay | implemented-offline-tested |  |  |
| `edit_post` | replay | implemented-offline-tested |  |  |
| `edit_comment` | replay | implemented-offline-tested |  |  |
| `delete_post` | replay | implemented-offline-tested |  |  |
| `delete_comment` | replay | implemented-offline-tested |  |  |
| `save_content` | replay | implemented-offline-tested |  |  |
| `unsave_content` | replay | implemented-offline-tested |  |  |
| `vote_on_thing` | replay | implemented-offline-tested |  |  |
| `subscribe_to_subreddit` | replay | implemented-offline-tested |  |  |
| `unsubscribe_from_subreddit` | replay | implemented-offline-tested |  |  |
| `get_me` | browser | implemented-offline-tested |  | linkKarma, commentKarma |
| `browse_subreddit` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `get_top_posts` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `get_subreddit_info` | browser | implemented-offline-tested |  | title, subscribers, description |
| `get_subreddit_rules` | browser | implemented-offline-tested |  | kind |
| `get_post_flairs` | browser | unsupported | / |  |
| `get_trending_subreddits` | browser | implemented-offline-tested |  | rank, trendMetric |
| `search_reddit` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `get_reddit_post` | browser | implemented-offline-tested |  | upvoteRatio, createdUtc |
| `get_post_comments` | browser | implemented-offline-tested |  |  |
| `get_more_comments` | browser | unsupported | / |  |
| `get_user_info` | browser | implemented-offline-tested |  | linkKarma, commentKarma, totalKarma, createdUtc, isMod |
| `get_user_posts` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `get_user_comments` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `user_analysis` | browser | implemented-offline-tested |  | sampleBounded, karmaHistory |
| `get_my_overview` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `get_my_saved` | browser | implemented-offline-tested | after | upvoteRatio, createdUtc |
| `list_my_subreddits` | browser | implemented-offline-tested |  | privateSubreddits, subscriptionOrder |
| `test_reddit_mcp_server` | browser | implemented-offline-tested |  | elapsedMs |
| `create_post` | browser | implemented-offline-tested |  |  |
| `reply_to_post` | browser | implemented-offline-tested |  |  |
| `edit_post` | browser | implemented-offline-tested |  |  |
| `edit_comment` | browser | implemented-offline-tested |  |  |
| `delete_post` | browser | implemented-offline-tested |  |  |
| `delete_comment` | browser | implemented-offline-tested |  |  |
| `save_content` | browser | implemented-offline-tested |  |  |
| `unsave_content` | browser | implemented-offline-tested |  |  |
| `vote_on_thing` | browser | implemented-offline-tested |  |  |
| `subscribe_to_subreddit` | browser | implemented-offline-tested |  |  |
| `unsubscribe_from_subreddit` | browser | implemented-offline-tested |  |  |
| `browse_subreddit_rss` | rss | implemented-offline-tested |  |  |
| `reddit_explain` | offline | implemented-offline-tested |  |  |

## What remains before this is complete

- Every `replay` and `browser` row still needs a live result from an authorized account experiment,
  recorded with date, platform, upstream ref, observed outcome, and completeness.
- Browser selectors, the in-page extractor, and every write commit path are unverified. A successful
  anonymous or logged-out page load proves nothing.
- Continuation resume is refused with `CONTINUATION_INVALID` (`continuation_resume_unverified`) until
  a live page yields a real next-page state; no production token is produced today.
- The two unsupported browser reads and the unsupported replay flair read are honest gaps. They are
  not satisfied by API or RSS routes, and this document does not relabel them.
