// This ledger describes this repository's evidence, not upstream projects' claimed capabilities.
//
// A row is one tool on one backend. `implemented-offline-tested` means the adapter exists and its
// offline tests pass; it never means Reddit or a browser was exercised live. Experimental backends
// (replay, browser) stay non-verified until Task 16's separately authorized live account experiment.
// `unsupportedParameters` names inputs or behaviors the backend cannot produce honestly. `/` in that
// list means the whole operation is unavailable.
//
// This module is intentionally dependency-free: it is documentation/evidence data, not a runtime
// module, and must not pull browser or replay code into the API-only extension bundle graph.

const READS = [
  'get_me', 'browse_subreddit', 'get_top_posts', 'get_subreddit_info', 'get_subreddit_rules',
  'get_post_flairs', 'get_trending_subreddits', 'search_reddit', 'get_reddit_post',
  'get_post_comments', 'get_more_comments', 'get_user_info', 'get_user_posts',
  'get_user_comments', 'user_analysis', 'get_my_overview', 'get_my_saved',
  'list_my_subreddits', 'test_reddit_mcp_server',
];
const WRITES = [
  'create_post', 'reply_to_post', 'edit_post', 'edit_comment', 'delete_post',
  'delete_comment', 'save_content', 'unsave_content', 'vote_on_thing',
  'subscribe_to_subreddit', 'unsubscribe_from_subreddit',
];

const PAGED_READS = new Set([
  'browse_subreddit', 'get_top_posts', 'search_reddit', 'get_user_posts',
  'get_user_comments', 'get_my_overview', 'get_my_saved',
]);

// Mirrors src/replay/mappings.js. tests/coverage.test.js compares this against the real mappings.
const REPLAY_PINNED_COMMIT = '32745d3450f4291845220e0d9a6deee33ee6eacf';
const REPLAY_READS = READS.filter((tool) => tool !== 'get_post_flairs');
const REPLAY_WRITES = [...WRITES];
const REPLAY_UNSUPPORTED = Object.freeze({
  get_post_flairs: Object.freeze({
    reason: 'flair_path_not_evidenced',
    evidence: 'the inspected upstream read classifier allows /r/<sub>/{sorts,comments,search,about,wiki,duplicates} but not the flair-template path, and no equivalent /api/* GET is established.',
  }),
});

// Mirrors src/browser/adapters/{reads,writes}.js. The browser cannot produce these two operations.
const BROWSER_UNSUPPORTED = Object.freeze({
  get_post_flairs: Object.freeze({
    reason: 'flair_template_ids_unavailable',
    message: 'rendered flair labels do not expose the template ids this tool returns.',
  }),
  get_more_comments: Object.freeze({
    reason: 'branch_ids_unavailable',
    message: 'expanding named comment branches needs exact ids the rendered page does not expose; generic scrolling is not equivalent.',
  }),
});
const BROWSER_READS = READS.filter((tool) => !Object.hasOwn(BROWSER_UNSUPPORTED, tool));
const BROWSER_WRITES = [...WRITES];

const API_EVIDENCE = 'tests/: original offline API suites (actions, reads, writes, api-backend, mutation-outcomes)';
const REPLAY_EVIDENCE = `src/replay/mappings.js; Apollo-Reborn@${REPLAY_PINNED_COMMIT} (docs/web-json-spike-findings.md, src/ApolloWebJSON.m); tests/replay-mappings.test.js and tests/replay-transport.test.js`;
const BROWSER_READ_EVIDENCE = 'src/browser/adapters/reads.js; tests/browser-reads.test.js; tests/fixtures/browser/**';
const BROWSER_WRITE_EVIDENCE = 'src/browser/adapters/writes.js; tests/browser-writes.test.js and tests/browser-steps.test.js; tests/fixtures/browser/**';

const BROWSER_MISSING = Object.freeze({
  get_me: ['linkKarma', 'commentKarma'],
  browse_subreddit: ['upvoteRatio', 'createdUtc'],
  get_top_posts: ['upvoteRatio', 'createdUtc'],
  get_subreddit_info: ['title', 'subscribers', 'description'],
  get_subreddit_rules: ['kind'],
  get_trending_subreddits: ['rank', 'trendMetric'],
  search_reddit: ['upvoteRatio', 'createdUtc'],
  get_reddit_post: ['upvoteRatio', 'createdUtc'],
  get_post_comments: [],
  get_user_info: ['linkKarma', 'commentKarma', 'totalKarma', 'createdUtc', 'isMod'],
  get_user_posts: ['upvoteRatio', 'createdUtc'],
  get_user_comments: ['upvoteRatio', 'createdUtc'],
  user_analysis: ['sampleBounded', 'karmaHistory'],
  get_my_overview: ['upvoteRatio', 'createdUtc'],
  get_my_saved: ['upvoteRatio', 'createdUtc'],
  list_my_subreddits: ['privateSubreddits', 'subscriptionOrder'],
  test_reddit_mcp_server: ['elapsedMs'],
});

function row({
  tool, backend, status, missingFields = [], blockers = [], unsupportedParameters = [],
  evidenceRef, checkedAt = '2026-10-21', platform = 'win32',
}) {
  return Object.freeze({
    tool,
    backend,
    status,
    platform,
    checkedAt,
    missingFields: Object.freeze([...missingFields]),
    blockers: Object.freeze([...blockers]),
    unsupportedParameters: Object.freeze([...unsupportedParameters]),
    evidenceRef,
  });
}

function apiRows() {
  return [...READS, ...WRITES].map((tool) => row({
    tool,
    backend: 'api',
    status: 'implemented-offline-tested',
    blockers: ['No live Reddit API verification in this repository (no Reddit client ID).'],
    evidenceRef: API_EVIDENCE,
  }));
}

function replayRows() {
  return [...READS, ...WRITES].map((tool) => {
    const unsupported = REPLAY_UNSUPPORTED[tool];
    if (unsupported) {
      return row({
        tool,
        backend: 'replay',
        status: 'unsupported',
        blockers: [`${unsupported.reason}: ${unsupported.evidence}`],
        unsupportedParameters: ['/'],
        evidenceRef: REPLAY_EVIDENCE,
      });
    }
    const mapped = REPLAY_READS.includes(tool) || REPLAY_WRITES.includes(tool);
    const write = WRITE_TOOLS.has(tool);
    return row({
      tool,
      backend: 'replay',
      status: mapped ? 'implemented-offline-tested' : 'not-yet-tested',
      blockers: mapped
        ? [write
          ? 'Experimental write mapping is upstream-routable only; write acceptance is unverified and live testing needs separate authorization.'
          : 'Experimental read mapping is upstream-evidenced only; no live Reddit or Windows Chromium verification.']
        : ['No evidence-backed replay mapping exists for this tool.'],
      evidenceRef: REPLAY_EVIDENCE,
    });
  });
}

function browserRows() {
  return [...READS, ...WRITES].map((tool) => {
    const write = WRITE_TOOLS.has(tool);
    const unsupported = BROWSER_UNSUPPORTED[tool];
    if (unsupported) {
      return row({
        tool,
        backend: 'browser',
        status: 'unsupported',
        blockers: [`${unsupported.reason}: ${unsupported.message}`],
        unsupportedParameters: ['/'],
        evidenceRef: BROWSER_READ_EVIDENCE,
      });
    }
    const implemented = write ? BROWSER_WRITES.includes(tool) : BROWSER_READS.includes(tool);
    // A rendered listing has no API cursor; paging uses the separate UI continuation token.
    const unsupportedParameters = PAGED_READS.has(tool) ? ['after'] : [];
    return row({
      tool,
      backend: 'browser',
      status: implemented ? 'implemented-offline-tested' : 'not-yet-tested',
      missingFields: write ? [] : BROWSER_MISSING[tool] ?? [],
      blockers: implemented
        ? [write
          ? 'Rendered-UI write adapters are fixture-tested only; selectors, commit behavior, and outcome evidence are unverified live.'
          : 'Rendered-UI selectors and the in-page extractor are offline-fixture-tested only; no live Reddit UI verification.']
        : ['No browser adapter exists for this tool.'],
      unsupportedParameters,
      evidenceRef: write ? BROWSER_WRITE_EVIDENCE : BROWSER_READ_EVIDENCE,
    });
  });
}

const WRITE_TOOLS = new Set(WRITES);

export const TOOL_COVERAGE = Object.freeze([
  ...apiRows(),
  ...replayRows(),
  ...browserRows(),
  row({
    tool: 'browse_subreddit_rss',
    backend: 'rss',
    status: 'implemented-offline-tested',
    blockers: ['Feed availability and rate limits are controlled by Reddit; no live feed check here.'],
    evidenceRef: 'tests/rss.test.js',
  }),
  row({
    tool: 'reddit_explain',
    backend: 'offline',
    status: 'implemented-offline-tested',
    evidenceRef: 'tests/misc.test.js (offline glossary)',
  }),
]);

export function coverageFor(tool, backend) {
  return TOOL_COVERAGE.find((entry) => entry.tool === tool && entry.backend === backend) ?? null;
}

export function summarizeCoverage() {
  const tools = [...new Set(TOOL_COVERAGE.map((entry) => entry.tool))];
  const live = TOOL_COVERAGE.filter((entry) => entry.backend === 'replay' || entry.backend === 'browser')
    .filter((entry) => entry.status === 'live-verified');
  return {
    toolCount: tools.length,
    browserLiveVerified: live.filter((entry) => entry.backend === 'browser').length,
    replayLiveVerified: live.filter((entry) => entry.backend === 'replay').length,
    implementedOffline: TOOL_COVERAGE.filter((entry) => entry.status === 'implemented-offline-tested').length,
    unsupported: TOOL_COVERAGE.filter((entry) => entry.status === 'unsupported').length,
    // The owner's no-dev-app target requires a live-verified or natural offline/RSS route for every
    // tool. Offline adapters do not satisfy it, so this stays false until Task 16 records evidence.
    noAppComplete: tools.every((tool) => TOOL_COVERAGE.some((entry) => entry.tool === tool
      && ((entry.backend === 'replay' || entry.backend === 'browser')
        ? entry.status === 'live-verified'
        : (entry.backend === 'offline' || entry.backend === 'rss') && entry.status === 'implemented-offline-tested'))),
  };
}
