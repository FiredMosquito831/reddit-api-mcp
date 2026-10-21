// The MCP server: 32 stable Reddit tools over every transport, plus 11 local stdio helpers.
//
// The Reddit tools resolve one frozen profile/backend per call through the dispatcher. The legacy
// function-getter injection (and the no-argument form, which lazily opens the environment API session
// like HEAD did) is kept only as a compatibility adapter for existing tests and callers: it maps the
// same tool arguments onto the old action methods and never touches a browser, a profile registry, or
// the write boundary. Production entry points (src/mcp.js) always pass a dispatcher.
//
// MCP output keeps the legacy JSON text for every tool and adds structured metadata when a call went
// through the dispatcher. Errors carry a canonical code plus allowlisted safe details; raw SDK,
// request, page, or filesystem text is never echoed.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION } from './config.js';
import { OperationError } from './errors.js';
import { lookupTerm } from './glossary.js';
import { REDDIT_TOOL_NAMES, WRITE_TOOL_NAMES, describeOperation } from './operations.js';
import { browseSubredditRss } from './rss.js';

// Kept here so an HTTP/API-only process never has to import the local helper module. The helper
// module re-exports the same frozen list.
export const LOCAL_TOOL_NAMES = Object.freeze([
  'reddit_profiles_list',
  'reddit_profile_current',
  'reddit_profile_default_set',
  'reddit_settings_get',
  'reddit_settings_propose',
  'reddit_browser_status',
  'reddit_browser_open',
  'reddit_browser_observe',
  'reddit_browser_step',
  'reddit_browser_handoff',
  'reddit_browser_close',
]);

const SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];
const LISTING_SORTS = ['hot', 'new', 'top', 'controversial'];
const TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];
const COMMENT_SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'];
const SEARCH_SORTS = ['relevance', 'hot', 'top', 'new', 'comments'];
const BACKENDS = ['auto', 'api', 'replay', 'browser'];
const LIMIT = z.number().int().min(1).max(100);
const CURSOR = z.string().optional().describe('The "after" cursor from the previous page');
const CONFIRM = z.literal(true).optional()
  .describe('Optional evidence for this call. It can only make an action stricter; it is never proof of a user approval.');
const PROFILE = z.string().optional().describe('Profile alias or id. Defaults to the saved default profile.');
const BACKEND = z.enum(BACKENDS).optional().describe('Explicit backend, or auto for the profile order.');
const CONTINUATION = z.string().optional()
  .describe('Opaque UI continuation token from a previous browser-backed page of this same read. A build without a continuation store refuses it instead of guessing; restart the read without one.');
// Paging through rendered UI is the only place a UI continuation can apply.
const PAGED_READS = new Set([
  'browse_subreddit',
  'get_top_posts',
  'search_reddit',
  'get_user_posts',
  'get_user_comments',
  'get_my_overview',
  'get_my_saved',
]);

const WRITE_TOOL_SET = new Set(WRITE_TOOL_NAMES);
const READ_ONLY_HINT = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
const WRITE_HINT = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
const LOCAL_READ_HINT = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
const LOCAL_WRITE_HINT = Object.freeze({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });

const META_KEYS = Object.freeze([
  'profile',
  'username',
  'backend',
  'completeness',
  'missingFields',
  'outcome',
  'attemptId',
  'cursorKind',
  'cacheGeneration',
]);
const PASSTHROUGH_ERROR_CODES = new Set([
  'DUPLICATE_WRITE',
  'ATTEMPT_NOT_READY',
  'ATTEMPT_STATE',
  'ATTEMPT_NOT_FOUND',
  'ATTEMPT_LEDGER_CORRUPT',
  'PROFILE_IN_USE',
]);
const SAFE_DETAIL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

// A deterministic inventory. It never changes because of login state, Playwright, or the default.
export function toolInventory({ transport = 'stdio' } = {}) {
  if (transport !== 'stdio' && transport !== 'http') {
    throw new TypeError('transport must be "stdio" or "http".');
  }
  return Object.freeze(transport === 'stdio'
    ? [...REDDIT_TOOL_NAMES, ...LOCAL_TOOL_NAMES]
    : [...REDDIT_TOOL_NAMES]);
}

function jsonSafe(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function safeScalar(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return undefined;
}

// Keep only recognized metadata fields and scalar values: no snapshots, page objects, or raw errors.
function safeMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const key of META_KEYS) {
    if (meta[key] === undefined) continue;
    if (key === 'missingFields' && Array.isArray(meta[key])) {
      out[key] = meta[key].filter((entry) => typeof entry === 'string').slice(0, 32);
    } else {
      const scalar = safeScalar(meta[key]);
      if (scalar !== undefined) out[key] = scalar;
    }
  }
  if (meta.continuation !== undefined) {
    const token = safeScalar(meta.continuation?.token);
    if (typeof token === 'string' && token.length > 0 && token.length <= 500) {
      out.continuation = { token, kind: 'ui-opaque' };
    }
  }
  return out;
}

// Safe details are shallow scalars only: a code and reason are enough to act on, and nothing can leak a
// page dump, SDK object, stack, or secret through this channel.
function safeDetails(details) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_DETAIL_KEY.test(key)) continue;
    if (Array.isArray(value)) {
      const list = value.map(safeScalar).filter((entry) => entry !== undefined).slice(0, 20);
      if (list.length > 0) out[key] = list;
      continue;
    }
    const scalar = safeScalar(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function errorResult(error) {
  let code = 'INTERNAL_ERROR';
  let message = 'The tool could not complete this request.';
  let outcome = null;
  let retryAfterMs = null;
  let details;
  if (error instanceof OperationError) {
    code = error.code;
    message = error.message;
    outcome = error.outcome ?? null;
    retryAfterMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null;
    details = safeDetails(error.safeDetails);
  } else if (typeof error?.code === 'string' && PASSTHROUGH_ERROR_CODES.has(error.code)) {
    code = error.code;
    if (typeof error.message === 'string' && error.message.length <= 300) message = error.message;
    details = safeDetails(error.details);
  }
  const structured = { error: { code } };
  if (outcome !== null) structured.error.outcome = outcome;
  if (retryAfterMs !== null) structured.error.retryAfterMs = retryAfterMs;
  if (details !== undefined) structured.error.safeDetails = details;
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: structured,
  };
}

function okResult(result) {
  const data = result?.data;
  const meta = safeMeta(result?.meta);
  const structured = { data: jsonSafe(data) ?? null, meta };
  const text = JSON.stringify(data ?? null, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function continuationUnavailable() {
  return new OperationError(
    'CONTINUATION_INVALID',
    'No UI continuation store is wired to this dispatcher build, so a continuation token cannot be used. '
      + 'Restart the read without a continuation.',
    { safeDetails: { reason: 'continuation_unavailable' } },
  );
}

// The old action-method adapter. It exists so a compatibility caller can inject `() => actions`; it is
// not reachable from the production entry point, never opens a browser, and never bypasses the shared
// write boundary because it is not used by the dispatcher. It keeps the two HEAD behaviors that did not
// pass through the actions object (the offline glossary and the public RSS feed) and still requires an
// explicit `confirm: true` for every write.
function createLegacyExecutor(getActions) {
  const call = async (tool, args) => {
    // The glossary and the public RSS feed never needed the account session in HEAD, so the
    // compatibility path serves them even when no credential or profile exists.
    if (tool === 'reddit_explain') return lookupTerm(args.term);
    if (tool === 'browse_subreddit_rss') {
      const { subreddit, sort, limit } = args;
      return browseSubredditRss({ subreddit, sort, limit, userAgent: `node:reddit-cli:${VERSION}` });
    }
    const a = await getActions();
    switch (tool) {
      case 'get_me': return a.whoami();
      case 'browse_subreddit': {
        const { include_info: includeInfo, ...rest } = args;
        return a.feed({ ...rest, includeInfo });
      }
      case 'get_top_posts': return a.topPosts(args);
      case 'get_subreddit_info': return a.subreddit(args.subreddit);
      case 'get_subreddit_rules': return a.rules(args.subreddit);
      case 'get_post_flairs': return a.flairs(args.subreddit);
      case 'get_trending_subreddits': return a.popular({ limit: args.limit });
      case 'search_reddit': return a.search(args);
      case 'get_reddit_post': return a.readPost({ id: args.post_id, subreddit: args.subreddit, limit: 1 });
      case 'get_post_comments': return a.readPost({
        id: args.post_id,
        subreddit: args.subreddit,
        sort: args.sort,
        limit: args.limit,
        depth: args.depth,
      });
      case 'get_more_comments': return a.moreComments({ postFullname: args.post_id, childIds: args.comment_ids });
      case 'get_user_info': return a.userInfo(args.username);
      case 'get_user_posts': return a.userPosts(args.username, {
        sort: args.sort, time: args.time, limit: args.limit, after: args.after,
      });
      case 'get_user_comments': return a.userComments(args.username, {
        sort: args.sort, time: args.time, limit: args.limit, after: args.after,
      });
      case 'user_analysis': return a.userActivity(args.username);
      case 'get_my_overview': return a.overview({ limit: args.limit, after: args.after });
      case 'get_my_saved': return a.saved({ limit: args.limit, after: args.after });
      case 'list_my_subreddits': return a.mySubscriptions({ limit: args.limit });
      case 'test_reddit_mcp_server': return a.selfTest();
      case 'create_post': return a.submitPost(args);
      case 'reply_to_post': return a.comment(args);
      case 'edit_post': return a.editText({ fullname: args.fullname, text: args.text, kind: 't3' });
      case 'edit_comment': return a.editText({ fullname: args.fullname, text: args.text, kind: 't1' });
      case 'delete_post': return a.deleteThing({ fullname: args.fullname, kind: 't3' });
      case 'delete_comment': return a.deleteThing({ fullname: args.fullname, kind: 't1' });
      case 'save_content': return a.save({ fullname: args.fullname });
      case 'unsave_content': return a.save({ fullname: args.fullname, undo: true });
      case 'vote_on_thing': return a.vote(args);
      case 'subscribe_to_subreddit': return a.subscribe({ subreddit: args.subreddit, subscribe: true });
      case 'unsubscribe_from_subreddit': return a.subscribe({ subreddit: args.subreddit, subscribe: false });
      default: throw new OperationError('UNSUPPORTED_OPERATION', `Unknown Reddit tool: ${tool}`);
    }
  };
  return {
    async execute(tool, args, options = {}) {
      // This adapter has no profile registry and no browser/replay backends. Refuse those inputs
      // rather than silently serving them with the environment API session.
      if (options?.profile != null || (options?.backend != null && options.backend !== 'auto' && options.backend !== 'api')) {
        throw new OperationError(
          'UNSUPPORTED_OPERATION',
          'This compatibility server has no profile registry or browser/replay backend. Use a dispatcher-backed server.',
        );
      }
      // No dispatcher and no write guard here: the legacy adapter keeps HEAD's rule that a write is
      // only attempted when the caller explicitly asked for it with confirm: true.
      if (WRITE_TOOL_SET.has(tool) && options?.requestConfirmation !== true) {
        throw new OperationError('APPROVAL_REQUIRED', 'Refusing to write without confirm: true.');
      }
      const data = await call(tool, args);
      return {
        data,
        meta: {
          backend: 'api',
          completeness: 'complete',
          missingFields: [],
          profile: null,
          username: null,
        },
      };
    },
  };
}

// Compatibility only: HEAD opened the environment API session on first use when no source was injected.
// The production entry point always passes a dispatcher, so this path never runs there. Importing the
// session lazily keeps startup credential-free and keeps browser modules out of every process.
function createEnvActions() {
  let actions;
  return async () => {
    if (!actions) {
      const [{ openSession }, { loadConfig }] = await Promise.all([
        import('./session.js'),
        import('./config.js'),
      ]);
      actions = openSession(loadConfig()).actions;
    }
    return actions;
  };
}

// Wrapper-specific legacy shapes for two tools. It is idempotent, so the same function applies to a
// dispatcher result or a legacy adapter result.
function adaptData(tool, result) {
  if (tool === 'get_reddit_post') return { ...result, data: result?.data?.post ?? result?.data ?? null };
  if (tool === 'get_post_comments') {
    return {
      ...result,
      data: {
        comments: result?.data?.comments ?? [],
        moreIds: result?.data?.moreIds ?? [],
      },
    };
  }
  return result;
}

// One spec per Reddit tool. Schemas mirror src/operations.js; the dispatcher re-validates every value.
function readSpec(name, description, shape, legacy) {
  return { name, description, shape, annotation: READ_ONLY_HINT, kind: 'read', legacy };
}

function writeSpec(name, description, shape, legacy) {
  return {
    name,
    description,
    shape: { ...shape, confirm: CONFIRM, profile: PROFILE, backend: BACKEND },
    annotation: WRITE_HINT,
    kind: 'write',
    legacy,
  };
}

function readShape(shape) {
  return { ...shape, profile: PROFILE, backend: BACKEND };
}

function pagedRead(name, description, shape, legacy) {
  return readSpec(name, description, { ...readShape(shape), continuation: CONTINUATION }, legacy);
}

const SPECS = [
  readSpec('get_me', 'The logged-in account: name and karma.', readShape({}), 'get_me'),
  pagedRead(
    'browse_subreddit',
    'Posts in a subreddit, sorted hot, new, top, rising, or controversial. Pass "after" to page. include_info adds the subreddit details.',
    {
      subreddit: z.string(),
      sort: z.enum(SORTS).default('hot'),
      time: z.enum(TIME_RANGES).optional().describe('Only for top and controversial'),
      limit: LIMIT.default(25),
      after: CURSOR,
      include_info: z.boolean().default(false),
    },
    'browse_subreddit',
  ),
  pagedRead(
    'get_top_posts',
    'Top posts in a subreddit for a time range.',
    { subreddit: z.string(), time: z.enum(TIME_RANGES).default('day'), limit: LIMIT.default(10), after: CURSOR },
    'get_top_posts',
  ),
  readSpec('get_subreddit_info', 'Subscriber count, title, and description of a subreddit.', readShape({ subreddit: z.string() }), 'get_subreddit_info'),
  readSpec('get_subreddit_rules', 'The rules of a subreddit.', readShape({ subreddit: z.string() }), 'get_subreddit_rules'),
  readSpec('get_post_flairs', 'The post flairs a subreddit offers.', readShape({ subreddit: z.string() }), 'get_post_flairs'),
  readSpec(
    'get_trending_subreddits',
    "Reddit's popular subreddits. This is the closest public list to trending.",
    readShape({ limit: LIMIT.default(5) }),
    'get_trending_subreddits',
  ),
  pagedRead(
    'search_reddit',
    'Search posts across Reddit, or inside one subreddit. author and flair narrow the results.',
    {
      query: z.string().default(''),
      subreddit: z.string().optional(),
      sort: z.enum(SEARCH_SORTS).default('relevance'),
      time: z.enum(TIME_RANGES).default('all'),
      limit: LIMIT.default(25),
      type: z.enum(['link', 'sr', 'user']).default('link'),
      author: z.string().optional(),
      flair: z.string().optional(),
      after: CURSOR,
    },
    'search_reddit',
  ),
  readSpec(
    'get_reddit_post',
    'One post, without comments. Accepts a fullname (t3_...), a bare id, or a reddit.com link.',
    readShape({ post_id: z.string(), subreddit: z.string().optional() }),
    'get_reddit_post',
  ),
  readSpec(
    'get_post_comments',
    'Comments on a post, threaded with depth, plus the ids of "load more" stubs for get_more_comments.',
    readShape({
      post_id: z.string(),
      subreddit: z.string().optional(),
      sort: z.enum(COMMENT_SORTS).default('confidence'),
      limit: z.number().int().min(1).max(500).default(100),
      depth: z.number().int().min(1).max(10).optional(),
    }),
    'get_post_comments',
  ),
  readSpec(
    'get_more_comments',
    'Expand "load more" comment ids from get_post_comments. Up to 100 ids per call.',
    readShape({
      post_id: z.string().describe('The post fullname, t3_...'),
      comment_ids: z.array(z.string()).min(1).max(100),
    }),
    'get_more_comments',
  ),
  readSpec('get_user_info', "A Reddit user's karma, account age, and flags.", readShape({ username: z.string() }), 'get_user_info'),
  pagedRead(
    'get_user_posts',
    "A user's posts, newest first by default.",
    {
      username: z.string(),
      sort: z.enum(LISTING_SORTS).default('new'),
      time: z.enum(TIME_RANGES).default('all'),
      limit: LIMIT.default(25),
      after: CURSOR,
    },
    'get_user_posts',
  ),
  pagedRead(
    'get_user_comments',
    "A user's comments, newest first by default.",
    {
      username: z.string(),
      sort: z.enum(LISTING_SORTS).default('new'),
      time: z.enum(TIME_RANGES).default('all'),
      limit: LIMIT.default(25),
      after: CURSOR,
    },
    'get_user_comments',
  ),
  readSpec(
    'user_analysis',
    'A user summary: karma, a sample of recent posts and comments, and the subreddits they are most active in.',
    readShape({ username: z.string() }),
    'user_analysis',
  ),
  pagedRead(
    'get_my_overview',
    'Your own posts and comments, newest first. Needs the history scope.',
    { limit: LIMIT.default(25), after: CURSOR },
    'get_my_overview',
  ),
  pagedRead(
    'get_my_saved',
    'Your saved posts and comments. Needs the history scope.',
    { limit: LIMIT.default(25), after: CURSOR },
    'get_my_saved',
  ),
  readSpec('list_my_subreddits', 'The subreddits you have joined.', readShape({ limit: LIMIT.default(100) }), 'list_my_subreddits'),
  readSpec(
    'browse_subreddit_rss',
    'Public feed, with no client ID needed. Read-only and reduced: no scores or comment counts. Reddit may throttle it.',
    readShape({ subreddit: z.string(), sort: z.enum(SORTS).default('hot'), limit: LIMIT.default(25) }),
    'browse_subreddit_rss',
  ),
  readSpec(
    'reddit_explain',
    'Plain-language meaning of a Reddit term, such as karma, cake day, AMA, ELI5, OP, or flair. Offline.',
    readShape({ term: z.string() }),
    'reddit_explain',
  ),
  readSpec(
    'test_reddit_mcp_server',
    'Checks the configuration end to end: a public read, and a whoami when the auth mode has a user.',
    readShape({}),
    'test_reddit_mcp_server',
  ),
  writeSpec(
    'create_post',
    'Submit a text post (text) or a link post (url) to a subreddit.',
    { subreddit: z.string(), title: z.string(), text: z.string().optional(), url: z.string().url().optional() },
    'create_post',
  ),
  writeSpec('reply_to_post', 'Reply to a post (t3_...) or to a comment (t1_...).', { parent: z.string(), text: z.string() }, 'reply_to_post'),
  writeSpec(
    'edit_post',
    'Replace the text of your own text post (t3_...).',
    { fullname: z.string(), text: z.string() },
    'edit_post',
  ),
  writeSpec(
    'edit_comment',
    'Replace the text of your own comment (t1_...).',
    { fullname: z.string(), text: z.string() },
    'edit_comment',
  ),
  writeSpec('delete_post', 'Delete your own post (t3_...). This cannot be undone.', { fullname: z.string() }, 'delete_post'),
  writeSpec('delete_comment', 'Delete your own comment (t1_...). This cannot be undone.', { fullname: z.string() }, 'delete_comment'),
  writeSpec('save_content', 'Save a post or comment to your account.', { fullname: z.string() }, 'save_content'),
  writeSpec('unsave_content', 'Remove a post or comment from your saved items.', { fullname: z.string() }, 'unsave_content'),
  writeSpec(
    'vote_on_thing',
    'Upvote, downvote, or clear your vote on one post or comment.',
    { fullname: z.string(), direction: z.enum(['up', 'down', 'clear']) },
    'vote_on_thing',
  ),
  writeSpec('subscribe_to_subreddit', 'Join a subreddit.', { subreddit: z.string() }, 'subscribe_to_subreddit'),
  writeSpec(
    'unsubscribe_from_subreddit',
    'Leave a subreddit.',
    { subreddit: z.string() },
    'unsubscribe_from_subreddit',
  ),
];

const SPEC_BY_NAME = new Map(SPECS.map((spec) => [spec.name, spec]));
for (const name of REDDIT_TOOL_NAMES) {
  if (!SPEC_BY_NAME.has(name)) throw new Error(`Missing MCP tool schema for ${name}.`);
}
if (SPECS.length !== REDDIT_TOOL_NAMES.length) throw new Error('MCP tool schemas do not match the 32-tool inventory.');
for (const spec of SPECS) {
  if (WRITE_TOOL_SET.has(spec.name) !== (spec.kind === 'write')) {
    throw new Error(`MCP tool ${spec.name} has the wrong kind.`);
  }
  if (PAGED_READS.has(spec.name) !== Object.hasOwn(spec.shape, 'continuation')) {
    throw new Error(`MCP tool ${spec.name} has the wrong paging inputs.`);
  }
}

// Local helper specs. They are frozen and state-independent.
const TASK_ID = z.string().describe('The task id returned by reddit_browser_open.');
const OBSERVATION_ID = z.string().describe('The observationId from the latest reddit_browser_observe.');
const HELPER_SPECS = [
  {
    name: 'reddit_profiles_list',
    description: 'List local named profiles and the saved default. No credentials or secrets are returned.',
    shape: {},
    annotation: LOCAL_READ_HINT,
  },
  {
    name: 'reddit_profile_current',
    description: 'The profile that a call would use right now: selection source, backend preference, and bound account state.',
    shape: { profile: PROFILE },
    annotation: LOCAL_READ_HINT,
  },
  {
    name: 'reddit_profile_default_set',
    description: 'Set or clear the saved default profile. This is operational configuration, not a security approval.',
    shape: { profile: z.string().nullable().describe('Alias to make default, or null to clear it.') },
    annotation: LOCAL_WRITE_HINT,
  },
  {
    name: 'reddit_settings_get',
    description: 'Non-secret runtime settings and effective approval policy. Never returns a credential or home path.',
    shape: { profile: PROFILE },
    annotation: LOCAL_READ_HINT,
  },
  {
    name: 'reddit_settings_propose',
    description: 'Record a settings patch proposal for trusted local approval. It never approves, applies, or returns an approval token.',
    shape: { profile: PROFILE, patch: z.record(z.unknown()).describe('Allowlisted settings patch, for example { "confirmations": { "global": "on" } }.') },
    annotation: LOCAL_WRITE_HINT,
  },
  {
    name: 'reddit_browser_status',
    description: 'Playwright/browser/profile diagnostics and open local browser tasks. Never installs or downloads anything.',
    shape: { profile: PROFILE },
    annotation: LOCAL_READ_HINT,
  },
  {
    name: 'reddit_browser_open',
    description: 'Open the dedicated browser profile with a visible window by default and start one bounded observation task. Only for an explicitly enabled browser profile.',
    shape: {
      profile: PROFILE,
      visibility: z.enum(['visible', 'headless', 'ask']).optional(),
    },
    annotation: LOCAL_WRITE_HINT,
  },
  {
    name: 'reddit_browser_observe',
    description: 'Read a bounded, redacted observation of the open task. Reddit sign-in or security screens require a human handoff.',
    shape: {
      task_id: TASK_ID,
      kind: z.enum(['page', 'controls']).optional(),
      assist: z.boolean().optional().describe('Ask the host for optional one-step sampling assistance when it is enabled.'),
    },
    annotation: LOCAL_READ_HINT,
  },
  {
    name: 'reddit_browser_step',
    description: 'Run one allowlisted UI step (navigate, scroll, sort, expand_branch, prepare_field) against the latest observation. No arbitrary clicks, evaluate, or fetch.',
    shape: {
      task_id: TASK_ID,
      observation_id: OBSERVATION_ID,
      step: z.enum(['navigate', 'scroll', 'sort', 'expand_branch', 'prepare_field']),
      args: z.record(z.unknown()).optional(),
    },
    annotation: LOCAL_WRITE_HINT,
  },
  {
    name: 'reddit_browser_handoff',
    description: 'Mark the task as waiting for a person to finish a sign-in or security step in the visible window. No solve or retry is attempted.',
    shape: { task_id: TASK_ID, reason: z.string().optional() },
    annotation: LOCAL_WRITE_HINT,
  },
  {
    name: 'reddit_browser_close',
    description: 'Close one browser task, or close every task and the browser session for a profile.',
    shape: { task_id: TASK_ID.optional(), profile: PROFILE },
    annotation: LOCAL_WRITE_HINT,
  },
];
const HELPER_SPEC_BY_NAME = new Map(HELPER_SPECS.map((spec) => [spec.name, spec]));
for (const name of LOCAL_TOOL_NAMES) {
  if (!HELPER_SPEC_BY_NAME.has(name)) throw new Error(`Missing MCP helper schema for ${name}.`);
}
if (HELPER_SPECS.length !== LOCAL_TOOL_NAMES.length) throw new Error('MCP helper schemas do not match the helper inventory.');

export function createRedditMcpServer(options = {}) {
  const config = typeof options === 'function' ? { getActions: options } : options;
  if (config === null || typeof config !== 'object') throw new TypeError('MCP server options must be an object or a getActions function.');
  const { dispatcher = null, browserHelpers = null, samplingEnabled = false } = config;
  const transport = config.transport ?? 'stdio';
  if (transport !== 'stdio' && transport !== 'http') throw new TypeError('transport must be "stdio" or "http".');
  const getActions = config.getActions;
  if (getActions !== undefined && typeof getActions !== 'function') {
    throw new TypeError('getActions must be a function when supplied.');
  }
  if (browserHelpers !== null && (typeof browserHelpers !== 'object' || Array.isArray(browserHelpers))) {
    throw new TypeError('browserHelpers must be an object when supplied.');
  }
  if (typeof samplingEnabled !== 'boolean') throw new TypeError('samplingEnabled must be a boolean.');

  // With neither a dispatcher nor injected actions, fall back to HEAD's lazily opened environment
  // session so existing direct callers (including an HTTP factory reference) keep working.
  const executor = dispatcher ?? createLegacyExecutor(getActions ?? createEnvActions());
  const server = new McpServer({ name: 'reddit-api-automation-mcp', version: VERSION });

  async function runReddit(spec, args, extra) {
    const { profile, backend, continuation, confirm, ...toolArgs } = args;
    // A dispatcher wired to a continuation store validates the token itself (and reports why it cannot
    // be resumed). Anything else must refuse here: silently dropping it would restart page one.
    if (continuation !== undefined && executor?.continuationStore !== true) throw continuationUnavailable();
    // Validate before the dispatcher resolves a profile, so an invalid argument is a typed refusal
    // rather than a generic internal error. The dispatcher validates again with runtime settings.
    try {
      describeOperation(spec.name, toolArgs, {});
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 300) {
        throw new OperationError('UNSUPPORTED_OPERATION', `Invalid arguments: ${error.message}`);
      }
      throw error;
    }
    const options = {
      profile: profile ?? null,
      backend: backend ?? null,
      requestConfirmation: confirm === true,
      signal: extra?.signal ?? null,
      ...(continuation !== undefined ? { continuation } : {}),
    };
    const result = await executor.execute(spec.name, toolArgs, options);
    return okResult(adaptData(spec.name, result));
  }

  async function runHelper(spec, args, extra) {
    if (!browserHelpers || typeof browserHelpers[spec.name] !== 'function') {
      throw new OperationError('UNSUPPORTED_OPERATION', 'This local helper is not available in this transport.');
    }
    const result = await browserHelpers[spec.name](args, extra);
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
      structuredContent: { data: jsonSafe(result) ?? null, meta: { backend: 'local', profile: null } },
    };
  }

  for (const spec of SPECS) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: spec.shape, annotations: spec.annotation },
      async (args, extra) => {
        try {
          return await runReddit(spec, args, extra);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  // Local helpers are registered only on the local stdio surface, and only when the process wired
  // their services. HTTP/Docker/MCPB keep exactly the 32 API tools and never load browser modules.
  if (transport === 'stdio' && browserHelpers) {
    for (const spec of HELPER_SPECS) {
      server.registerTool(
        spec.name,
        { description: spec.description, inputSchema: spec.shape, annotations: spec.annotation },
        async (args, extra) => {
          try {
            return await runHelper(spec, args, extra);
          } catch (error) {
            return errorResult(error);
          }
        },
      );
    }
  }

  return server;
}
