// The complete Reddit tool inventory and the operation descriptor for each tool. The descriptor is the
// single place that knows how tool-level arguments map onto the action methods, what a canonical target
// is, and what content a write carries. Describe an operation before any backend is selected: only
// normalized, validated arguments leave this module.
//
// Tool argument names follow the MCP tool schemas. Action-native names are used when an action expects
// a different spelling. The conversions are:
//   get_reddit_post, get_post_comments: post_id -> readPost({ id })
//   get_more_comments: post_id -> postFullname, comment_ids -> childIds
//   browse_subreddit: include_info -> includeInfo
//   edit_post/edit_comment/delete_post/delete_comment: fullname plus the action's ownership kind
//   save_content/unsave_content: fullname plus the action's undo flag
//   subscribe_to_subreddit/unsubscribe_from_subreddit: subreddit plus the action's subscribe flag
// Everything else passes its validated arguments through under the action's own names. Actions that
// take a single positional value (userInfo, rules, flairs, subreddit, userActivity, explain) keep that
// value under its schema key; actions that take (value, options) use { username, options }.
// The rss action is the standalone browseSubredditRss function rather than an actions method.

import { createHash } from 'node:crypto';
import { OperationError } from './errors.js';
import {
  COMMENT_FULLNAME_RE,
  COMMENT_SORTS,
  FULLNAME_RE,
  LISTING_SORTS,
  POST_FULLNAME_RE,
  POST_OR_COMMENT_RE,
  SEARCH_SORTS,
  SEARCH_TYPES,
  SORTS,
  TIME_RANGES,
  bareId,
  checkCursor,
  checkFullname,
  checkHttpUrl,
  checkLimit,
  checkOneOf,
  checkPostId,
  checkSubreddit,
  checkUsername,
  checkVoteDirection,
  parsePostRef,
} from './validation.js';

// Freeze validated arguments all the way down. Arrays and plain objects are copied, so a caller that keeps
// a reference to its own input cannot change a description after it is returned; a dispatcher may hold the
// frozen operation across awaits and rely on it. Only plain containers are copied: a RegExp or class
// instance is left alone rather than being turned into an empty object.
function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)])));
  }
  return value;
}

// Keep only the keys that were supplied, so a description is stable regardless of undefined defaults.
function only(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function subredditTarget(name) {
  return `r/${String(name).toLowerCase()}`;
}

function userTarget(name) {
  return `u/${String(name).toLowerCase()}`;
}

function fullnameTarget(fullname) {
  return String(fullname).toLowerCase();
}

// Stable JSON: object keys are sorted at every level, so a content hash never depends on argument order.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

// The footer is appended to text posts, comments, and edits, so it is part of the content a write carries.
function footerFor(settings) {
  return typeof settings?.botFooter === 'string' ? settings.botFooter : '';
}

function withFooter(text, settings) {
  const footer = footerFor(settings);
  return footer ? `${text}${footer}` : text;
}

function listingArgs(raw) {
  const { username, sort, time, limit, after } = raw;
  checkUsername(username);
  if (sort !== undefined) checkOneOf(sort, LISTING_SORTS, 'Sort');
  if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
  if (limit !== undefined) checkLimit(limit);
  if (after !== undefined) checkCursor(after);
  return only({ username, sort, time, limit, after });
}

function readPostArgs(raw, forcedLimit) {
  const ref = parsePostRef(raw.post_id);
  const id = ref ? ref.id : checkPostId(raw.post_id);
  const subreddit = raw.subreddit ?? ref?.subreddit;
  if (subreddit !== undefined) checkSubreddit(subreddit);
  if (raw.sort !== undefined) checkOneOf(raw.sort, COMMENT_SORTS, 'Comment sort');
  const limit = forcedLimit ?? raw.limit;
  if (limit !== undefined) checkLimit(limit, 500);
  if (raw.depth !== undefined) {
    if (!Number.isInteger(raw.depth) || raw.depth < 1 || raw.depth > 10) throw new Error('Depth must be between 1 and 10.');
  }
  return only({ id, subreddit, sort: raw.sort, limit, depth: raw.depth });
}

function postContent(raw, settings) {
  const text = raw.text === undefined ? null : withFooter(raw.text, settings);
  return hash({ title: raw.title, text, url: raw.url ?? null });
}

function rule(spec) {
  return Object.freeze({
    requiresIdentity: false,
    contentHash: null,
    ...spec,
    policyKey: spec.tool,
  });
}

// Every tool the MCP server exposes. The order follows src/mcp-server.js registration order.
const RULES = {
  get_me: rule({
    tool: 'get_me',
    action: 'whoami',
    kind: 'read',
    requiresIdentity: true,
    args: () => ({}),
    target: () => 'me',
  }),

  browse_subreddit: rule({
    tool: 'browse_subreddit',
    action: 'feed',
    kind: 'read',
    args: (raw) => {
      const { subreddit, sort, time, limit, after, include_info: includeInfo } = raw;
      checkSubreddit(subreddit);
      if (sort !== undefined) checkOneOf(sort, SORTS, 'Sort');
      if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
      if (limit !== undefined) checkLimit(limit);
      if (after !== undefined) checkCursor(after);
      return only({ subreddit, sort, time, limit, after, includeInfo });
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  get_top_posts: rule({
    tool: 'get_top_posts',
    action: 'topPosts',
    kind: 'read',
    args: (raw) => {
      const { subreddit, time, limit, after } = raw;
      checkSubreddit(subreddit);
      if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
      if (limit !== undefined) checkLimit(limit);
      if (after !== undefined) checkCursor(after);
      return only({ subreddit, time, limit, after });
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  get_subreddit_info: rule({
    tool: 'get_subreddit_info',
    action: 'subreddit',
    kind: 'read',
    args: ({ subreddit }) => {
      checkSubreddit(subreddit);
      return { subreddit };
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  get_subreddit_rules: rule({
    tool: 'get_subreddit_rules',
    action: 'rules',
    kind: 'read',
    args: ({ subreddit }) => {
      checkSubreddit(subreddit);
      return { subreddit };
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  get_post_flairs: rule({
    tool: 'get_post_flairs',
    action: 'flairs',
    kind: 'read',
    args: ({ subreddit }) => {
      checkSubreddit(subreddit);
      return { subreddit };
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  get_trending_subreddits: rule({
    tool: 'get_trending_subreddits',
    action: 'popular',
    kind: 'read',
    args: ({ limit }) => {
      if (limit !== undefined) checkLimit(limit);
      return only({ limit });
    },
    target: () => 'subreddits:popular',
  }),

  search_reddit: rule({
    tool: 'search_reddit',
    action: 'search',
    kind: 'read',
    args: (raw) => {
      const { query, subreddit, sort, time, limit, type, author, flair, after } = raw;
      if (sort !== undefined) checkOneOf(sort, SEARCH_SORTS, 'Search sort');
      if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
      if (limit !== undefined) checkLimit(limit);
      if (type !== undefined) checkOneOf(type, SEARCH_TYPES, 'Search type');
      if (subreddit !== undefined) checkSubreddit(subreddit);
      if (author !== undefined) checkUsername(author);
      if (after !== undefined) checkCursor(after);
      const hasQuery = typeof query === 'string' && query.trim() !== '';
      if (!hasQuery && author === undefined && flair === undefined) {
        throw new Error('Give a search query, an author, or a flair.');
      }
      return only({ query, subreddit, sort, time, limit, type, author, flair, after });
    },
    target: (args) => (args.subreddit === undefined ? 'search' : `search:${subredditTarget(args.subreddit)}`),
  }),

  get_reddit_post: rule({
    tool: 'get_reddit_post',
    action: 'readPost',
    kind: 'read',
    args: (raw) => readPostArgs(raw, 1),
    target: (args) => `t3_${args.id}`,
  }),

  get_post_comments: rule({
    tool: 'get_post_comments',
    action: 'readPost',
    kind: 'read',
    args: (raw) => readPostArgs(raw),
    target: (args) => `t3_${args.id}`,
  }),

  get_more_comments: rule({
    tool: 'get_more_comments',
    action: 'moreComments',
    kind: 'read',
    args: ({ post_id: postFullname, comment_ids: childIds }) => {
      checkFullname(postFullname, POST_FULLNAME_RE);
      if (!Array.isArray(childIds) || childIds.length === 0 || childIds.length > 100) {
        throw new Error('Give between 1 and 100 comment ids.');
      }
      for (const id of childIds) bareId(id);
      return { postFullname, childIds };
    },
    target: (args) => fullnameTarget(args.postFullname),
  }),

  get_user_info: rule({
    tool: 'get_user_info',
    action: 'userInfo',
    kind: 'read',
    args: ({ username }) => {
      checkUsername(username);
      return { username };
    },
    target: (args) => userTarget(args.username),
  }),

  get_user_posts: rule({
    tool: 'get_user_posts',
    action: 'userPosts',
    kind: 'read',
    args: (raw) => {
      const { username, ...options } = listingArgs(raw);
      return { username, options };
    },
    target: (args) => userTarget(args.username),
  }),

  get_user_comments: rule({
    tool: 'get_user_comments',
    action: 'userComments',
    kind: 'read',
    args: (raw) => {
      const { username, ...options } = listingArgs(raw);
      return { username, options };
    },
    target: (args) => userTarget(args.username),
  }),

  user_analysis: rule({
    tool: 'user_analysis',
    action: 'userActivity',
    kind: 'read',
    args: ({ username }) => {
      checkUsername(username);
      return { username };
    },
    target: (args) => userTarget(args.username),
  }),

  get_my_overview: rule({
    tool: 'get_my_overview',
    action: 'overview',
    kind: 'read',
    requiresIdentity: true,
    args: (raw) => {
      if (raw.limit !== undefined) checkLimit(raw.limit);
      if (raw.after !== undefined) checkCursor(raw.after);
      return only({ limit: raw.limit, after: raw.after });
    },
    target: () => 'me:overview',
  }),

  get_my_saved: rule({
    tool: 'get_my_saved',
    action: 'saved',
    kind: 'read',
    requiresIdentity: true,
    args: (raw) => {
      if (raw.limit !== undefined) checkLimit(raw.limit);
      if (raw.after !== undefined) checkCursor(raw.after);
      return only({ limit: raw.limit, after: raw.after });
    },
    target: () => 'me:saved',
  }),

  list_my_subreddits: rule({
    tool: 'list_my_subreddits',
    action: 'mySubscriptions',
    kind: 'read',
    requiresIdentity: true,
    args: ({ limit }) => {
      if (limit !== undefined) checkLimit(limit);
      return only({ limit });
    },
    target: () => 'me:subreddits',
  }),

  // Public Atom feed: needs no profile, client ID, or account, and is read-only and reduced.
  browse_subreddit_rss: rule({
    tool: 'browse_subreddit_rss',
    action: 'browseSubredditRss',
    kind: 'rss',
    args: ({ subreddit, sort, limit }) => {
      checkSubreddit(subreddit);
      if (sort !== undefined) checkOneOf(sort, SORTS, 'Sort');
      if (limit !== undefined) checkLimit(limit);
      return only({ subreddit, sort, limit });
    },
    target: (args) => subredditTarget(args.subreddit),
  }),

  reddit_explain: rule({
    tool: 'reddit_explain',
    action: 'explain',
    kind: 'offline',
    args: ({ term }) => ({ term: String(term ?? '') }),
    target: (args) => `term:${args.term.trim().toLowerCase()}`,
  }),

  test_reddit_mcp_server: rule({
    tool: 'test_reddit_mcp_server',
    action: 'selfTest',
    kind: 'read',
    args: ({ checkAccount }) => {
      if (checkAccount !== undefined && typeof checkAccount !== 'boolean') {
        throw new Error('checkAccount must be a boolean.');
      }
      return only({ checkAccount });
    },
    target: () => 'selftest',
  }),

  // ---- Writes. The policy key is the exact tool name, so related actions never share a policy entry. ----

  create_post: rule({
    tool: 'create_post',
    action: 'submitPost',
    kind: 'write',
    requiresIdentity: true,
    args: ({ subreddit, title, text, url }) => {
      checkSubreddit(subreddit);
      if (!title?.trim()) throw new Error('A title is required.');
      if ((text === undefined) === (url === undefined)) throw new Error('Give exactly one of --text or --url.');
      if (url !== undefined) checkHttpUrl(url);
      return only({ subreddit, title, text, url });
    },
    target: (args) => subredditTarget(args.subreddit),
    contentHash: (args, settings) => postContent(args, settings),
  }),

  reply_to_post: rule({
    tool: 'reply_to_post',
    action: 'comment',
    kind: 'write',
    requiresIdentity: true,
    args: ({ parent, text }) => {
      checkFullname(parent, POST_OR_COMMENT_RE);
      if (!text?.trim()) throw new Error('Comment text is required.');
      return { parent, text };
    },
    target: (args) => fullnameTarget(args.parent),
    contentHash: (args, settings) => hash({ parent: fullnameTarget(args.parent), text: withFooter(args.text, settings) }),
  }),

  edit_post: rule({
    tool: 'edit_post',
    action: 'editText',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname, text }) => {
      checkFullname(fullname, POST_FULLNAME_RE);
      if (!text?.trim()) throw new Error('New text is required.');
      return { fullname, text, kind: 't3' };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: (args, settings) => hash({ text: withFooter(args.text, settings) }),
  }),

  edit_comment: rule({
    tool: 'edit_comment',
    action: 'editText',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname, text }) => {
      checkFullname(fullname, COMMENT_FULLNAME_RE);
      if (!text?.trim()) throw new Error('New text is required.');
      return { fullname, text, kind: 't1' };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: (args, settings) => hash({ text: withFooter(args.text, settings) }),
  }),

  delete_post: rule({
    tool: 'delete_post',
    action: 'deleteThing',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname }) => {
      checkFullname(fullname, POST_FULLNAME_RE);
      return { fullname, kind: 't3' };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: () => null,
  }),

  delete_comment: rule({
    tool: 'delete_comment',
    action: 'deleteThing',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname }) => {
      checkFullname(fullname, COMMENT_FULLNAME_RE);
      return { fullname, kind: 't1' };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: () => null,
  }),

  save_content: rule({
    tool: 'save_content',
    action: 'save',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname }) => {
      checkFullname(fullname, FULLNAME_RE);
      return { fullname, undo: false };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: () => hash({ action: 'save' }),
  }),

  unsave_content: rule({
    tool: 'unsave_content',
    action: 'save',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname }) => {
      checkFullname(fullname, FULLNAME_RE);
      return { fullname, undo: true };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: () => hash({ action: 'unsave' }),
  }),

  vote_on_thing: rule({
    tool: 'vote_on_thing',
    action: 'vote',
    kind: 'write',
    requiresIdentity: true,
    args: ({ fullname, direction }) => {
      checkFullname(fullname, FULLNAME_RE);
      checkVoteDirection(direction);
      return { fullname, direction };
    },
    target: (args) => fullnameTarget(args.fullname),
    contentHash: (args) => hash({ direction: args.direction }),
  }),

  subscribe_to_subreddit: rule({
    tool: 'subscribe_to_subreddit',
    action: 'subscribe',
    kind: 'write',
    requiresIdentity: true,
    args: ({ subreddit }) => {
      checkSubreddit(subreddit);
      return { subreddit, subscribe: true };
    },
    target: (args) => subredditTarget(args.subreddit),
    contentHash: () => hash({ action: 'subscribe' }),
  }),

  unsubscribe_from_subreddit: rule({
    tool: 'unsubscribe_from_subreddit',
    action: 'subscribe',
    kind: 'write',
    requiresIdentity: true,
    args: ({ subreddit }) => {
      checkSubreddit(subreddit);
      return { subreddit, subscribe: false };
    },
    target: (args) => subredditTarget(args.subreddit),
    contentHash: () => hash({ action: 'unsubscribe' }),
  }),
};

// The complete, ordered tool list. Frozen so a consumer can rely on the inventory not changing under it.
export const REDDIT_TOOL_NAMES = Object.freeze([
  'get_me',
  'browse_subreddit',
  'get_top_posts',
  'get_subreddit_info',
  'get_subreddit_rules',
  'get_post_flairs',
  'get_trending_subreddits',
  'search_reddit',
  'get_reddit_post',
  'get_post_comments',
  'get_more_comments',
  'get_user_info',
  'get_user_posts',
  'get_user_comments',
  'user_analysis',
  'get_my_overview',
  'get_my_saved',
  'list_my_subreddits',
  'browse_subreddit_rss',
  'reddit_explain',
  'test_reddit_mcp_server',
  'create_post',
  'reply_to_post',
  'edit_post',
  'edit_comment',
  'delete_post',
  'delete_comment',
  'save_content',
  'unsave_content',
  'vote_on_thing',
  'subscribe_to_subreddit',
  'unsubscribe_from_subreddit',
]);

export const WRITE_TOOL_NAMES = Object.freeze([
  'create_post',
  'reply_to_post',
  'edit_post',
  'edit_comment',
  'delete_post',
  'delete_comment',
  'save_content',
  'unsave_content',
  'vote_on_thing',
  'subscribe_to_subreddit',
  'unsubscribe_from_subreddit',
]);

const missing = REDDIT_TOOL_NAMES.filter((tool) => !Object.hasOwn(RULES, tool));
if (missing.length > 0) throw new Error(`Missing operation descriptors: ${missing.join(', ')}`);

// Frozen descriptors keyed by the exact tool name.
export const OPERATION_DESCRIPTORS = Object.freeze(
  Object.fromEntries(REDDIT_TOOL_NAMES.map((tool) => [tool, RULES[tool]])),
);

export const WRITE_OPERATION_DESCRIPTORS = Object.freeze(
  Object.fromEntries(WRITE_TOOL_NAMES.map((tool) => [tool, OPERATION_DESCRIPTORS[tool]])),
);

// Turns tool arguments into a validated Operation. `settings` affects only the runtime text settings
// that become part of a write (currently the bot footer), so the content hash matches what is sent.
export function describeOperation(tool, args = {}, settings = {}) {
  const descriptor = Object.hasOwn(OPERATION_DESCRIPTORS, tool) ? OPERATION_DESCRIPTORS[tool] : null;
  if (!descriptor) {
    throw new OperationError('UNSUPPORTED_OPERATION', `Unknown Reddit tool: ${tool}`);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Tool arguments must be an object.');
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('Runtime settings must be an object.');
  }
  const normalized = deepFreeze(descriptor.args(args));
  const operation = {
    tool: descriptor.tool,
    action: descriptor.action,
    kind: descriptor.kind,
    policyKey: descriptor.policyKey,
    target: descriptor.target(normalized),
    requiresIdentity: descriptor.requiresIdentity,
    args: normalized,
  };
  if (descriptor.kind === 'write') {
    operation.contentHash = descriptor.contentHash ? descriptor.contentHash(normalized, settings) : null;
  }
  return Object.freeze(operation);
}
