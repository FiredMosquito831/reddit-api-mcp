// Finite, evidenced request mappings for the experimental replay transport.
//
// Every mapping is one HTTP method against `https://www.reddit.com`, with an explicit path and query
// builder. There is no generic path, header, or body passthrough: the replay transport accepts only
// these mapping objects, and the allowlist in transport.js rejects anything else.
//
// Evidence is pinned to Apollo-Reborn commit 32745d3450f4291845220e0d9a6deee33ee6eacf:
//   docs/web-json-spike-findings.md  and  src/ApolloWebJSON.m
// That evidence was measured in an iOS 26 simulator on a residential network. It is NOT proof for
// Windows Chromium, this repository, or this owner's account. Nothing here is live-verified.
//
// Evidenced mechanisms, and only these:
//   - GET https://www.reddit.com<page>.json with the profile's own session cookie (listings,
//     comments, user pages, search, subreddits, about/wiki, every /api/* GET served as JSON).
//   - POST https://www.reddit.com/api/<action> with the session cookie and the X-Modhash value read
//     from the same session's /api/me.json.
// Not adopted, because the source does not establish them: token_v2 bearer replay, a broad
// authenticated GraphQL surface, media/upload leases, client User-Agent spoofing, CAPTCHA solving.

import { OperationError } from '../errors.js';
import {
  COMMENT_FULLNAME_RE,
  COMMENT_SORTS,
  FULLNAME_RE,
  POST_FULLNAME_RE,
  POST_OR_COMMENT_RE,
  SEARCH_SORTS,
  SEARCH_TYPES,
  SORTS,
  TIME_RANGES,
  VOTE_DIRECTIONS,
  bareId,
  checkCursor,
  checkFullname,
  checkLimit,
  checkOneOf,
  checkPostId,
  checkSubreddit,
  checkUsername,
  parsePostRef,
} from '../validation.js';

export const REPLAY_ORIGIN = 'https://www.reddit.com';
export const REPLAY_PINNED_COMMIT = '32745d3450f4291845220e0d9a6deee33ee6eacf';
export const REPLAY_SOURCE_REF = `Apollo-Reborn/Apollo-Reborn@${REPLAY_PINNED_COMMIT}: docs/web-json-spike-findings.md and src/ApolloWebJSON.m`;
export const REPLAY_PLATFORM_EVIDENCE = 'iOS 26 simulator (residential network); Windows Chromium not proven';

export const REPLAY_STATUS = Object.freeze({
  EVIDENCED_UNVERIFIED: 'evidenced-unverified',
  UPSTREAM_ROUTABLE_UNVERIFIED: 'upstream-routable-unverified',
  UNSUPPORTED: 'unsupported',
});

const READ_EVIDENCE = 'upstream findings classify this www.reddit.com read and measure feed JSON; individual response shape not live-verified here.';
const API_GET_EVIDENCE = 'upstream findings: every /api/* GET is served as JSON natively by www.reddit.com with the session cookie.';
const WRITE_EVIDENCE = 'upstream findings: /api/* POST is re-pointed to www.reddit.com with the session cookie and X-Modhash; end-to-end write verification remains unproven.';

function text(value) {
  return String(value);
}

function queryObject(entries) {
  const query = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== '') query[key] = text(value);
  }
  return Object.freeze(query);
}

function readMapping(tool, {
  path,
  query = () => ({}),
  normalize,
  responseSchema,
  inputSchema,
  evidence = READ_EVIDENCE,
  status = REPLAY_STATUS.EVIDENCED_UNVERIFIED,
  steps = null,
  identity = 'session',
}) {
  return Object.freeze({
    tool,
    kind: 'read',
    method: 'GET',
    origin: REPLAY_ORIGIN,
    inputSchema: Object.freeze(inputSchema),
    responseSchema,
    identity,
    status,
    sourceRef: REPLAY_SOURCE_REF,
    platformEvidence: REPLAY_PLATFORM_EVIDENCE,
    evidence,
    ...(steps ? { steps: Object.freeze(steps) } : {}),
    build: (args = {}, options = {}) => Object.freeze({
      method: 'GET',
      origin: REPLAY_ORIGIN,
      path: path(args, options),
      query: query(args, options),
      form: null,
    }),
    normalize: (payload, args = {}, options = {}) => normalize(payload, args, options),
  });
}

function writeMapping(tool, {
  path,
  form,
  verify,
  responseSchema,
  inputSchema,
}) {
  return Object.freeze({
    tool,
    kind: 'write',
    method: 'POST',
    origin: REPLAY_ORIGIN,
    inputSchema: Object.freeze(inputSchema),
    responseSchema,
    identity: 'session',
    status: REPLAY_STATUS.UPSTREAM_ROUTABLE_UNVERIFIED,
    sourceRef: REPLAY_SOURCE_REF,
    platformEvidence: REPLAY_PLATFORM_EVIDENCE,
    evidence: WRITE_EVIDENCE,
    build: (args = {}, options = {}) => Object.freeze({
      method: 'POST',
      origin: REPLAY_ORIGIN,
      path,
      query: Object.freeze({}),
      form: Object.freeze(form(args, options)),
    }),
    normalize: verify,
  });
}

// ---- Response shaping: identical to src/actions.js so a replay result keeps the API contract. ----

function shapePost(data) {
  return {
    fullname: data.name,
    title: data.title,
    author: data.author,
    subreddit: data.subreddit,
    score: data.score,
    upvoteRatio: data.upvote_ratio ?? null,
    comments: data.num_comments,
    url: data.url,
    permalink: data.permalink,
    selftext: data.selftext ?? '',
  };
}

function shapeComment(data) {
  return {
    fullname: data.name,
    author: data.author,
    body: data.body,
    score: data.score,
    subreddit: data.subreddit,
    parentId: data.parent_id,
    permalink: data.permalink,
  };
}

function shapeThing({ kind, data }) {
  if (kind === 't3') return { kind, ...shapePost(data) };
  if (kind === 't1') return { kind, ...shapeComment(data) };
  return { kind, fullname: data.name ?? null, name: data.display_name ?? data.name ?? null };
}

function parseCommentTree(children, depth = 0) {
  const comments = [];
  const moreIds = [];
  for (const child of children) {
    if (child.kind === 'more') {
      moreIds.push(...child.data.children);
    } else if (child.kind === 't1') {
      comments.push({ ...shapeComment(child.data), depth });
      const replies = child.data.replies?.data?.children;
      if (replies) {
        const nested = parseCommentTree(replies, depth + 1);
        comments.push(...nested.comments);
        moreIds.push(...nested.moreIds);
      }
    }
  }
  return { comments, moreIds };
}

function invalidResponse(tool) {
  return new OperationError('BACKEND_UNAVAILABLE', 'The replay response did not have the expected Reddit JSON shape. Nothing was retried through another route.', {
    outcome: 'FAILED_KNOWN',
    safeDetails: { backend: 'replay', reason: 'invalid_response', tool },
  });
}

function expectData(payload, tool) {
  const data = payload?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse(tool);
  return data;
}

function expectListing(payload, tool) {
  const data = expectData(payload, tool);
  if (!Array.isArray(data.children)) throw invalidResponse(tool);
  return { items: data.children.map(shapeThing), after: data.after ?? null };
}

function requireUsername(options) {
  if (typeof options?.username !== 'string' || options.username.length === 0) {
    throw new OperationError('IDENTITY_UNVERIFIED', 'The replay transport needs the verified session username for this read; nothing was sent.', {
      safeDetails: { backend: 'replay', reason: 'username_required' },
    });
  }
  return options.username;
}

function listingQuery(options = {}, { defaults, omitSort = false } = {}) {
  const { sort, time, limit, after } = options;
  if (sort !== undefined) checkOneOf(sort, SORTS, 'Sort');
  if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
  if (limit !== undefined) checkLimit(limit);
  if (after !== undefined) checkCursor(after);
  return queryObject({
    limit: limit ?? defaults.limit,
    sort: omitSort ? undefined : (sort ?? defaults.sort),
    t: time ?? defaults.time,
    after,
  });
}

// ---- Read mappings -------------------------------------------------------------------------------

const READ_MAPPINGS = ({
  get_me: readMapping('get_me', {
    path: () => '/api/me.json',
    query: () => queryObject({}),
    responseSchema: 'me',
    inputSchema: { keys: [], required: [] },
    evidence: `${API_GET_EVIDENCE} Upstream login/identity flow keys auth decisions on /api/me.json returning a username.`,
    normalize: (payload) => {
      const data = expectData(payload, 'get_me');
      if (typeof data.name !== 'string' || data.name.length === 0) {
        throw new OperationError('LOGIN_REQUIRED', 'The replay session is not signed in to Reddit. Sign in in the visible browser window; nothing was retried.', {
          safeDetails: { backend: 'replay', reason: 'anonymous' },
        });
      }
      return { name: data.name, linkKarma: data.link_karma, commentKarma: data.comment_karma };
    },
  }),

  browse_subreddit: readMapping('browse_subreddit', {
    path: (args) => `/r/${checkSubreddit(args.subreddit)}/${checkOneOf(args.sort ?? 'hot', SORTS, 'Sort')}.json`,
    query: (args) => listingQuery(args, { defaults: { limit: 10 }, omitSort: true }),
    responseSchema: 'listing',
    inputSchema: { keys: ['subreddit', 'sort', 'time', 'limit', 'after', 'includeInfo'], required: ['subreddit'] },
    normalize: (payload) => expectListing(payload, 'browse_subreddit'),
  }),

  get_top_posts: readMapping('get_top_posts', {
    path: (args) => `/r/${checkSubreddit(args.subreddit)}/top.json`,
    query: (args) => listingQuery({ time: 'day', ...args }, { defaults: { limit: 10 }, omitSort: true }),
    responseSchema: 'listing',
    inputSchema: { keys: ['subreddit', 'time', 'limit', 'after'], required: ['subreddit'] },
    normalize: (payload) => expectListing(payload, 'get_top_posts'),
  }),

  get_subreddit_info: readMapping('get_subreddit_info', {
    path: (args) => `/r/${checkSubreddit(args.subreddit)}/about.json`,
    query: () => queryObject({}),
    responseSchema: 'subreddit',
    inputSchema: { keys: ['subreddit'], required: ['subreddit'] },
    evidence: 'upstream findings classify /r/<sub>/about[/...] as a routable listing page and require .json.',
    normalize: (payload) => {
      const data = expectData(payload, 'get_subreddit_info');
      return {
        name: data.display_name,
        title: data.title,
        subscribers: data.subscribers,
        description: data.public_description,
      };
    },
  }),

  get_subreddit_rules: readMapping('get_subreddit_rules', {
    path: (args) => `/r/${checkSubreddit(args.subreddit)}/about/rules.json`,
    query: () => queryObject({}),
    responseSchema: 'rules',
    inputSchema: { keys: ['subreddit'], required: ['subreddit'] },
    evidence: 'upstream findings classify /r/<sub>/about[/...] as routable JSON; the rules sub-path comes from the official /about/rules endpoint, whose response shape is not separately measured.',
    normalize: (payload) => {
      if (!Array.isArray(payload?.rules)) throw invalidResponse('get_subreddit_rules');
      return payload.rules.map((rule) => ({
        shortName: rule.short_name,
        description: rule.description,
        kind: rule.kind,
      }));
    },
  }),

  get_trending_subreddits: readMapping('get_trending_subreddits', {
    path: () => '/subreddits/popular.json',
    query: (args) => {
      if (args.limit !== undefined) checkLimit(args.limit);
      return queryObject({ limit: args.limit ?? 5 });
    },
    responseSchema: 'subreddit-names',
    inputSchema: { keys: ['limit'], required: [] },
    evidence: 'upstream findings classify /subreddits/... (subscriptions/discovery) as routable listing JSON.',
    normalize: (payload) => {
      const data = expectData(payload, 'get_trending_subreddits');
      if (!Array.isArray(data.children)) throw invalidResponse('get_trending_subreddits');
      return data.children.map(({ data: sub }) => sub.display_name);
    },
  }),

  search_reddit: readMapping('search_reddit', {
    path: (args) => {
      if (args.subreddit === undefined) return '/search.json';
      return `/r/${checkSubreddit(args.subreddit)}/search.json`;
    },
    query: (args) => {
      const { query, subreddit, sort, time, limit, type, author, flair, after } = args;
      if (sort !== undefined) checkOneOf(sort, SEARCH_SORTS, 'Search sort');
      if (time !== undefined) checkOneOf(time, TIME_RANGES, 'Time range');
      if (limit !== undefined) checkLimit(limit);
      if (type !== undefined) checkOneOf(type, SEARCH_TYPES, 'Search type');
      if (subreddit !== undefined) checkSubreddit(subreddit);
      if (author !== undefined) checkUsername(author);
      if (after !== undefined) checkCursor(after);
      const terms = [];
      if (typeof query === 'string' && query.trim()) terms.push(query.trim());
      if (author !== undefined) terms.push(`author:${checkUsername(author)}`);
      if (flair !== undefined) terms.push(`flair:"${String(flair).replace(/["\\]/g, '')}"`);
      if (terms.length === 0) throw new Error('Give a search query, an author, or a flair.');
      return queryObject({
        q: terms.join(' '),
        sort: sort ?? 'relevance',
        t: time ?? 'all',
        limit: limit ?? 25,
        type: type ?? 'link',
        restrict_sr: subreddit === undefined ? undefined : 'true',
        after,
      });
    },
    responseSchema: 'listing',
    inputSchema: { keys: ['query', 'subreddit', 'sort', 'time', 'limit', 'type', 'author', 'flair', 'after'], required: [] },
    evidence: 'upstream findings classify global and subreddit-scoped /search as routable listing JSON.',
    normalize: (payload) => expectListing(payload, 'search_reddit'),
  }),

  get_reddit_post: readMapping('get_reddit_post', {
    path: (args) => commentPath(args),
    query: (args) => commentQuery(args),
    responseSchema: 'comments',
    inputSchema: { keys: ['id', 'subreddit', 'sort', 'limit', 'depth'], required: ['id'] },
    normalize: (payload) => normalizeComments(payload, 'get_reddit_post'),
  }),

  get_post_comments: readMapping('get_post_comments', {
    path: (args) => commentPath(args),
    query: (args) => commentQuery(args),
    responseSchema: 'comments',
    inputSchema: { keys: ['id', 'subreddit', 'sort', 'limit', 'depth'], required: ['id'] },
    normalize: (payload) => normalizeComments(payload, 'get_post_comments'),
  }),

  get_more_comments: readMapping('get_more_comments', {
    path: () => '/api/morechildren',
    query: (args) => {
      checkFullname(args.postFullname, POST_FULLNAME_RE);
      if (!Array.isArray(args.childIds) || args.childIds.length === 0 || args.childIds.length > 100) {
        throw new Error('Give between 1 and 100 comment ids.');
      }
      const children = args.childIds.map((id) => bareId(id)).join(',');
      return queryObject({ api_type: 'json', link_id: args.postFullname, children });
    },
    responseSchema: 'more-children',
    inputSchema: { keys: ['postFullname', 'childIds'], required: ['postFullname', 'childIds'] },
    evidence: `${API_GET_EVIDENCE} Shape mirrors /api/morechildren's documented json envelope.`,
    normalize: (payload) => {
      const data = payload?.json?.data ?? payload?.data ?? payload ?? {};
      const things = Array.isArray(data.things) ? data.things : [];
      return things.filter((thing) => thing.kind === 't1').map(shapeThing);
    },
  }),

  get_user_info: readMapping('get_user_info', {
    path: (args) => `/user/${checkUsername(args.username)}/about.json`,
    query: () => queryObject({}),
    responseSchema: 'user',
    inputSchema: { keys: ['username'], required: ['username'] },
    evidence: 'upstream findings classify /user/<name>/about as routable listing JSON.',
    normalize: (payload) => {
      const data = expectData(payload, 'get_user_info');
      return {
        name: data.name,
        id: data.id,
        linkKarma: data.link_karma,
        commentKarma: data.comment_karma,
        totalKarma: data.total_karma ?? data.link_karma + data.comment_karma,
        isMod: data.is_mod,
        isGold: data.is_gold,
        isEmployee: data.is_employee,
        createdUtc: data.created_utc,
      };
    },
  }),

  get_user_posts: readMapping('get_user_posts', {
    path: (args) => `/user/${checkUsername(args.username)}/submitted.json`,
    query: (args) => userListingQuery(args.options),
    responseSchema: 'listing',
    inputSchema: { keys: ['username', 'options'], required: ['username'] },
    normalize: (payload) => expectListing(payload, 'get_user_posts'),
  }),

  get_user_comments: readMapping('get_user_comments', {
    path: (args) => `/user/${checkUsername(args.username)}/comments.json`,
    query: (args) => userListingQuery(args.options),
    responseSchema: 'listing',
    inputSchema: { keys: ['username', 'options'], required: ['username'] },
    normalize: (payload) => expectListing(payload, 'get_user_comments'),
  }),

  user_analysis: readMapping('user_analysis', {
    path: (args) => `/user/${checkUsername(args.username)}/about.json`,
    query: () => queryObject({}),
    responseSchema: 'user-analysis',
    inputSchema: { keys: ['username'], required: ['username'] },
    steps: ['get_user_info', 'get_user_posts', 'get_user_comments'],
    evidence: 'Three separate upstream-evidenced reads (user about plus two 100-item listings) composed with the same shape as actions.userActivity.',
    normalize: ({ account, posts, comments }) => {
      const items = [...posts.items, ...comments.items];
      const counts = new Map();
      for (const item of items) {
        if (item.subreddit) counts.set(item.subreddit, (counts.get(item.subreddit) ?? 0) + 1);
      }
      const activeSubreddits = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count }));
      return {
        account,
        sampledPosts: posts.items.length,
        sampledComments: comments.items.length,
        activeSubreddits,
      };
    },
  }),

  get_my_overview: readMapping('get_my_overview', {
    path: (args, options) => `/user/${checkUsername(requireUsername(options))}/overview.json`,
    query: (args) => ownListingQuery(args),
    responseSchema: 'listing',
    inputSchema: { keys: ['limit', 'after'], required: [] },
    evidence: 'upstream findings classify /user/<name>/overview as routable listing JSON and record the profile listing needing the username.',
    normalize: (payload) => expectListing(payload, 'get_my_overview'),
  }),

  get_my_saved: readMapping('get_my_saved', {
    path: (args, options) => `/user/${checkUsername(requireUsername(options))}/saved.json`,
    query: (args) => ownListingQuery(args),
    responseSchema: 'listing',
    inputSchema: { keys: ['limit', 'after'], required: [] },
    evidence: 'upstream findings classify /user/<name>/saved as routable listing JSON.',
    normalize: (payload) => expectListing(payload, 'get_my_saved'),
  }),

  list_my_subreddits: readMapping('list_my_subreddits', {
    path: () => '/subreddits/mine/subscriber.json',
    query: (args) => {
      if (args.limit !== undefined) checkLimit(args.limit);
      return queryObject({ limit: args.limit ?? 100 });
    },
    responseSchema: 'subreddit-names',
    inputSchema: { keys: ['limit'], required: [] },
    evidence: 'upstream findings classify /subreddits/mine/<where> as routable listing JSON.',
    normalize: (payload) => {
      const data = expectData(payload, 'list_my_subreddits');
      if (!Array.isArray(data.children)) throw invalidResponse('list_my_subreddits');
      return data.children.map(({ data: sub }) => sub.display_name);
    },
  }),

  test_reddit_mcp_server: readMapping('test_reddit_mcp_server', {
    path: () => '/subreddits/popular.json',
    query: () => queryObject({ limit: 1 }),
    responseSchema: 'self-test',
    inputSchema: { keys: ['checkAccount'], required: [] },
    steps: ['get_trending_subreddits', 'get_me'],
    evidence: 'Composed from the upstream-evidenced popular listing and /api/me.json reads; no new endpoint.',
    normalize: ({ popular, me, checkAccount = true, elapsedMs = 0 }) => {
      const checks = [popular.ok
        ? { name: 'read: popular subreddits', ok: true, detail: popular.data[0] ?? 'none' }
        : { name: 'read: popular subreddits', ok: false, detail: popular.error }];
      if (checkAccount) {
        checks.push(me.ok
          ? { name: 'account: whoami', ok: true, detail: me.data.name }
          : { name: 'account: whoami', ok: false, detail: me.error });
      }
      return { authMode: 'replay', ok: checks.every((check) => check.ok), checks, elapsedMs };
    },
  }),
});

function commentPath(args) {
  const ref = parsePostRef(args.id);
  const id = ref ? ref.id : checkPostId(args.id);
  const subreddit = args.subreddit ?? ref?.subreddit;
  return subreddit === undefined
    ? `/comments/${id}.json`
    : `/r/${checkSubreddit(subreddit)}/comments/${id}.json`;
}

function commentQuery(args) {
  const { sort = 'confidence', limit = 100, depth } = args;
  checkOneOf(sort, COMMENT_SORTS, 'Comment sort');
  checkLimit(limit, 500);
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 10)) {
    throw new Error('Depth must be between 1 and 10.');
  }
  return queryObject({ sort, limit, depth });
}

function normalizeComments(payload, tool) {
  if (!Array.isArray(payload) || payload.length < 1) throw invalidResponse(tool);
  const post = payload[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The replay response did not contain that post. It may be hidden from this session; nothing was retried.', {
      outcome: 'FAILED_KNOWN',
      safeDetails: { backend: 'replay', reason: 'not_found', tool },
    });
  }
  const { comments, moreIds } = parseCommentTree(payload[1]?.data?.children ?? []);
  return { post: shapePost(post), comments, moreIds };
}

function userListingQuery(options = {}) {
  return listingQuery({ limit: 25, sort: 'new', time: 'all', ...options });
}

function ownListingQuery(args = {}) {
  if (args.limit !== undefined) checkLimit(args.limit);
  if (args.after !== undefined) checkCursor(args.after);
  return queryObject({ limit: args.limit ?? 25, after: args.after });
}

// ---- Write mappings ------------------------------------------------------------------------------

function withFooter(value, footer) {
  return footer ? `${value}${footer}` : value;
}

export const REPLAY_WRITE_MAPPINGS = Object.freeze({
  create_post: writeMapping('create_post', {
    path: '/api/submit/',
    form: (args, { footer = '' } = {}) => {
      checkSubreddit(args.subreddit);
      if (!args.title?.trim()) throw new Error('A title is required.');
      if ((args.text === undefined) === (args.url === undefined)) throw new Error('Give exactly one of --text or --url.');
      return args.url === undefined
        ? { api_type: 'json', sr: args.subreddit, kind: 'self', title: args.title, text: withFooter(args.text, footer) }
        : { api_type: 'json', sr: args.subreddit, kind: 'link', title: args.title, url: args.url };
    },
    responseSchema: 'submit',
    inputSchema: { keys: ['subreddit', 'title', 'text', 'url'], required: ['subreddit', 'title'] },
    verify: (payload) => verifySubmit(payload),
  }),

  reply_to_post: writeMapping('reply_to_post', {
    path: '/api/comment/',
    form: (args, { footer = '' } = {}) => {
      checkFullname(args.parent, POST_OR_COMMENT_RE);
      if (!args.text?.trim()) throw new Error('Comment text is required.');
      return { api_type: 'json', thing_id: args.parent, text: withFooter(args.text, footer) };
    },
    responseSchema: 'comment-legacy-or-modern',
    inputSchema: { keys: ['parent', 'text'], required: ['parent', 'text'] },
    verify: (payload) => verifyThing(payload, 'reply_to_post'),
  }),

  edit_post: writeMapping('edit_post', {
    path: '/api/editusertext/',
    form: (args, { footer = '' } = {}) => {
      checkFullname(args.fullname, POST_FULLNAME_RE);
      if (!args.text?.trim()) throw new Error('New text is required.');
      return { api_type: 'json', thing_id: args.fullname, text: withFooter(args.text, footer) };
    },
    responseSchema: 'comment-legacy-or-modern',
    inputSchema: { keys: ['fullname', 'text'], required: ['fullname', 'text'] },
    verify: (payload) => verifyThing(payload, 'edit_post'),
  }),

  edit_comment: writeMapping('edit_comment', {
    path: '/api/editusertext/',
    form: (args, { footer = '' } = {}) => {
      checkFullname(args.fullname, COMMENT_FULLNAME_RE);
      if (!args.text?.trim()) throw new Error('New text is required.');
      return { api_type: 'json', thing_id: args.fullname, text: withFooter(args.text, footer) };
    },
    responseSchema: 'comment-legacy-or-modern',
    inputSchema: { keys: ['fullname', 'text'], required: ['fullname', 'text'] },
    verify: (payload) => verifyThing(payload, 'edit_comment'),
  }),

  delete_post: writeMapping('delete_post', {
    path: '/api/del/',
    form: (args) => {
      checkFullname(args.fullname, POST_FULLNAME_RE);
      return { id: args.fullname };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['fullname'], required: ['fullname'] },
    verify: (payload) => verifyEmpty(payload, 'delete_post'),
  }),

  delete_comment: writeMapping('delete_comment', {
    path: '/api/del/',
    form: (args) => {
      checkFullname(args.fullname, COMMENT_FULLNAME_RE);
      return { id: args.fullname };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['fullname'], required: ['fullname'] },
    verify: (payload) => verifyEmpty(payload, 'delete_comment'),
  }),

  save_content: writeMapping('save_content', {
    path: '/api/save/',
    form: (args) => {
      checkFullname(args.fullname, FULLNAME_RE);
      return { id: args.fullname };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['fullname'], required: ['fullname'] },
    verify: (payload) => verifyEmpty(payload, 'save_content'),
  }),

  unsave_content: writeMapping('unsave_content', {
    path: '/api/unsave/',
    form: (args) => {
      checkFullname(args.fullname, FULLNAME_RE);
      return { id: args.fullname };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['fullname'], required: ['fullname'] },
    verify: (payload) => verifyEmpty(payload, 'unsave_content'),
  }),

  vote_on_thing: writeMapping('vote_on_thing', {
    path: '/api/vote/',
    form: (args) => {
      checkFullname(args.fullname, FULLNAME_RE);
      if (!Object.hasOwn(VOTE_DIRECTIONS, args.direction)) throw new Error('Direction must be up, down, or clear.');
      return { id: args.fullname, dir: String(VOTE_DIRECTIONS[args.direction]) };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['fullname', 'direction'], required: ['fullname', 'direction'] },
    verify: (payload) => verifyEmpty(payload, 'vote_on_thing'),
  }),

  subscribe_to_subreddit: writeMapping('subscribe_to_subreddit', {
    path: '/api/subscribe/',
    form: (args) => {
      checkSubreddit(args.subreddit);
      return { action: 'sub', sr_name: args.subreddit };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['subreddit'], required: ['subreddit'] },
    verify: (payload) => verifyEmpty(payload, 'subscribe_to_subreddit'),
  }),

  unsubscribe_from_subreddit: writeMapping('unsubscribe_from_subreddit', {
    path: '/api/subscribe/',
    form: (args) => {
      checkSubreddit(args.subreddit);
      return { action: 'unsub', sr_name: args.subreddit };
    },
    responseSchema: 'empty-object',
    inputSchema: { keys: ['subreddit'], required: ['subreddit'] },
    verify: (payload) => verifyEmpty(payload, 'unsubscribe_from_subreddit'),
  }),
});

export const REPLAY_MAPPINGS = Object.freeze({ ...READ_MAPPINGS, ...REPLAY_WRITE_MAPPINGS });

export const REPLAY_READ_TOOLS = Object.freeze(
  Object.keys(REPLAY_MAPPINGS).filter((tool) => REPLAY_MAPPINGS[tool].kind === 'read'),
);
export const REPLAY_WRITE_TOOLS = Object.freeze(
  Object.keys(REPLAY_MAPPINGS).filter((tool) => REPLAY_MAPPINGS[tool].kind === 'write'),
);

// Operations in the 32-tool vocabulary that replay deliberately does not implement. They are listed
// here rather than guessed: upstream evidence does not classify the flair path, and inventing a
// similar-looking endpoint would be a private-endpoint guess.
export const UNSUPPORTED_REPLAY_OPERATIONS = Object.freeze({
  get_post_flairs: Object.freeze({
    tool: 'get_post_flairs',
    status: REPLAY_STATUS.UNSUPPORTED,
    reason: 'flair_path_not_evidenced',
    sourceRef: REPLAY_SOURCE_REF,
    evidence: 'The evidenced upstream read classifier allows /r/<sub>/{sorts,comments,search,about,wiki,duplicates} but not /r/<sub>/api/link_flair_v2, and no equivalent /api/* GET is established.',
  }),
});

export function buildReplayRequest(tool, args = {}, options = {}) {
  const mapping = Object.hasOwn(REPLAY_MAPPINGS, tool) ? REPLAY_MAPPINGS[tool] : null;
  if (!mapping) return undefined;
  return mapping.build(args ?? {}, options ?? {});
}

export function normalizeReplayRead(tool, payload, args = {}, options = {}) {
  const mapping = Object.hasOwn(REPLAY_MAPPINGS, tool) ? REPLAY_MAPPINGS[tool] : null;
  if (!mapping) {
    throw new OperationError('UNSUPPORTED_OPERATION', `The replay backend has no mapping for ${tool}.`, {
      safeDetails: { backend: 'replay', tool },
    });
  }
  return mapping.normalize(payload, args ?? {}, options ?? {});
}

// ---- Write completion contracts ------------------------------------------------------------------
//
// A 2xx alone never proves a write landed. Submit/comment/edit must carry a non-empty id or name.
// www.reddit.com's /api/comment and /api/editusertext responses are known to use the legacy
// `{parent, content:"<html>"}` shape, so the t1_ fullname is extracted from the embedded
// data-fullname attribute. Empty-body operations (vote, save, subscribe, delete) accept only a JSON
// object with no errors; a jQuery wrapper is recognized but never treated as proof.

function writeUnknown(tool, reason) {
  return new OperationError(
    'OUTCOME_UNKNOWN',
    "The replay response did not prove whether this write landed. It will not be resent automatically through any backend.",
    { outcome: 'OUTCOME_UNKNOWN', safeDetails: { backend: 'replay', reason, tool } },
  );
}

function responseErrors(payload) {
  return Array.isArray(payload?.json?.errors) ? payload.json.errors : [];
}

function refusalCode(errors) {
  const first = errors[0];
  return Array.isArray(first) && typeof first[0] === 'string' ? first[0].slice(0, 80) : 'UNKNOWN';
}

function assertNoRefusal(payload, tool) {
  const errors = responseErrors(payload);
  if (errors.length === 0) return;
  const code = refusalCode(errors);
  // An in-body RATELIMIT is a throttle, exactly as the API backend reports it. It is still terminal
  // (FAILED_KNOWN) and is never rerouted or resent, but the reason stays distinguishable.
  if (code === 'RATELIMIT') {
    throw new OperationError('THROTTLED', 'Reddit is throttling this account. Wait, then try again; the replay write was not resent or rerouted.', {
      outcome: 'FAILED_KNOWN',
      safeDetails: { backend: 'replay', reason: 'rate_limited', errorCode: code, tool },
    });
  }
  throw new OperationError('BACKEND_UNAVAILABLE', `Reddit refused this replay write (${code}).`, {
    outcome: 'FAILED_KNOWN',
    safeDetails: { backend: 'replay', reason: 'reddit_refusal', errorCode: code, tool },
  });
}

function isJqueryWrapper(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.jquery);
}

function hasEvidence(data) {
  if (!data || typeof data !== 'object') return false;
  const present = (value) => typeof value === 'string' && value.trim() !== '';
  return present(data.id) || present(data.name);
}

function fullnameFromLegacyContent(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const match = /data-fullname="(t[0-9]_[0-9a-z]+)"/i.exec(html);
  return match ? match[1] : null;
}

function verifySubmit(payload) {
  assertNoRefusal(payload, 'create_post');
  if (isJqueryWrapper(payload)) throw writeUnknown('create_post', 'legacy_jquery');
  const data = payload?.json?.data;
  if (!hasEvidence(data)) throw writeUnknown('create_post', 'write_not_confirmed');
  return data;
}

function verifyThing(payload, tool) {
  assertNoRefusal(payload, tool);
  if (isJqueryWrapper(payload)) throw writeUnknown(tool, 'legacy_jquery');
  const things = payload?.json?.data?.things;
  if (!Array.isArray(things) || things.length === 0) throw writeUnknown(tool, 'write_not_confirmed');
  const data = things[0]?.data;
  if (hasEvidence(data)) return data;
  const fullname = fullnameFromLegacyContent(data?.content);
  if (fullname) return { fullname, legacy: true };
  throw writeUnknown(tool, 'write_not_confirmed');
}

function isEmptyWritePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length === 0) return true;
  // The only accepted envelope is exactly the documented one: optional empty errors plus empty data.
  if (keys.length !== 1 || keys[0] !== 'json') return false;
  const body = payload.json;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.some((key) => key !== 'errors' && key !== 'data')) return false;
  if (Object.hasOwn(body, 'errors') && (!Array.isArray(body.errors) || body.errors.length > 0)) return false;
  if (Object.hasOwn(body, 'data')) {
    if (body.data === null || typeof body.data !== 'object' || Array.isArray(body.data)) return false;
    if (Object.keys(body.data).length > 0) return false;
  }
  return true;
}

function verifyEmpty(payload, tool) {
  assertNoRefusal(payload, tool);
  if (isJqueryWrapper(payload)) throw writeUnknown(tool, 'legacy_jquery');
  if (!isEmptyWritePayload(payload)) throw writeUnknown(tool, 'write_not_confirmed');
  return payload?.json?.data ?? {};
}

export function verifyReplayWrite(tool, payload) {
  const mapping = Object.hasOwn(REPLAY_MAPPINGS, tool) ? REPLAY_MAPPINGS[tool] : null;
  if (!mapping || mapping.kind !== 'write') {
    throw new OperationError('UNSUPPORTED_OPERATION', `The replay backend has no write mapping for ${tool}.`, {
      safeDetails: { backend: 'replay', tool },
    });
  }
  return mapping.normalize(payload);
}

// A small, explicit inventory for capabilities and status reporting.
export function replayCapabilities() {
  return Object.freeze({
    backend: 'replay',
    identity: 'user',
    appOnly: false,
    readOnly: false,
    reads: REPLAY_READ_TOOLS,
    writes: REPLAY_WRITE_TOOLS,
    completeness: 'unknown',
  });
}
