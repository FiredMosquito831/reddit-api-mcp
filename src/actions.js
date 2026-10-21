import { API_BASE, RedditError } from './client.js';
import { OperationError, OUTCOMES } from './errors.js';
import { lookupTerm } from './glossary.js';
import {
  COMMENT_FULLNAME_RE,
  COMMENT_SORTS,
  LISTING_SORTS,
  POST_FULLNAME_RE,
  POST_OR_COMMENT_RE,
  SEARCH_SORTS,
  SEARCH_TYPES,
  SORTS,
  TIME_RANGES,
  VOTE_DIRECTIONS,
  bareId,
  checkFullname,
  checkLimit,
  checkOneOf,
  checkSubreddit,
  checkUsername,
  parsePostRef,
} from './validation.js';

export { parsePostRef };

function withFooter(text, footer) {
  return footer ? `${text}${footer}` : text;
}

// Read endpoints wrap their payload in `data`. Anything else is reported instead of crashing on a missing field.
function expectData(response, what) {
  if (!response?.data) {
    throw new RedditError(`Reddit returned an unexpected response for ${what}.`, { details: response });
  }
  return response.data;
}

function expectArray(response, what) {
  if (!Array.isArray(response)) {
    throw new RedditError(`Reddit returned an unexpected response for ${what}.`, { details: response });
  }
  return response;
}

// Write endpoints answer 200 and report failures in json.errors, so they are checked here.
function unwrap(response) {
  const errors = response?.json?.errors ?? [];
  if (errors.length > 0) {
    const [code, message] = errors[0];
    throw new RedditError(`Reddit refused the request (${code}): ${message ?? 'no details given'}`, { details: errors });
  }
  return response?.json?.data ?? response ?? {};
}

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

// Listing children are tagged by kind: t3 posts, t1 comments, t5 subreddits, t2 users.
function shapeThing({ kind, data }) {
  if (kind === 't3') return { kind, ...shapePost(data) };
  if (kind === 't1') return { kind, ...shapeComment(data) };
  return { kind, fullname: data.name ?? null, name: data.display_name ?? data.name ?? null };
}

// Turns the nested comment tree into a flat list with depth, and collects the ids behind "load more" stubs.
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

// ---- Mutation plans -------------------------------------------------------------------------------
//
// A plan is the exact request one action sends, with no network access. It is shared by the legacy
// guarded actions and by the API backend, so a validated operation and a direct CLI call can never
// drift into different paths or forms. `legacy(response)` returns what the old action returned.
// `complete(response)` is the new-backend completion contract: it fails closed as OUTCOME_UNKNOWN
// unless the response itself proves the documented state. This is why an empty `{}` succeeds only for
// endpoints whose documented success body is empty, never as a generic fallback.

function unknownCompletion(action) {
  return new RedditError(
    `Reddit's completion response for the ${action} could not be confirmed, so its outcome is unknown. It will not be resent automatically.`,
    { outcome: OUTCOMES.OUTCOME_UNKNOWN },
  );
}

function responseErrors(response) {
  return Array.isArray(response?.json?.errors) ? response.json.errors : [];
}

function assertNoRefusal(response, action) {
  const errors = responseErrors(response);
  if (errors.length === 0) return;
  const [code, message] = errors[0];
  if (code === 'RATELIMIT') {
    throw new RedditError('Reddit is throttling this account. Nothing was sent.', {
      outcome: OUTCOMES.FAILED_KNOWN,
      details: errors,
    });
  }
  throw new RedditError(`Reddit refused the request (${code}): ${message ?? 'no details given'}`, {
    outcome: OUTCOMES.FAILED_KNOWN,
    details: errors,
  });
}

// An empty documented body is success for this operation; anything unparseable is not.
function emptyCompletion(response, action) {
  assertNoRefusal(response, action);
  if (response === null || response === undefined) return {};
  if (typeof response !== 'object' || Array.isArray(response)) throw unknownCompletion(action);
  return response;
}

// Evidence must be a non-empty identifier: a 200 with `name: ''` does not prove the write landed.
function hasEvidence(data) {
  if (!data || typeof data !== 'object') return false;
  const present = (value) => typeof value === 'string' && value.trim() !== '';
  return present(data.id) || present(data.name);
}

// Submit: Reddit answers with json.data carrying the new thing's id/name. Without either, the write
// may have landed, but this response does not prove it.
function submitCompletion(response) {
  assertNoRefusal(response, 'post');
  const data = response?.json?.data;
  if (!hasEvidence(data)) throw unknownCompletion('post');
  return data;
}

// Comment and edit: json.data.things must contain the affected thing.
function thingCompletion(response, action) {
  assertNoRefusal(response, action);
  const data = response?.json?.data;
  const things = data?.things;
  if (!Array.isArray(things) || things.length === 0) throw unknownCompletion(action);
  if (!hasEvidence(things[0]?.data)) throw unknownCompletion(action);
  return data;
}

function legacyUnwrap(response) {
  const errors = responseErrors(response);
  if (errors.length > 0) {
    const [code, message] = errors[0];
    throw new RedditError(`Reddit refused the request (${code}): ${message ?? 'no details given'}`, { details: errors });
  }
  return response?.json?.data ?? response ?? {};
}

export function planMutation(action, args = {}, { footer = '' } = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Write arguments must be an object.');
  }
  switch (action) {
    case 'submitPost': {
      const { subreddit, title, text, url } = args;
      checkSubreddit(subreddit);
      if (!title?.trim()) throw new Error('A title is required.');
      if ((text === undefined) === (url === undefined)) throw new Error('Give exactly one of --text or --url.');
      const form = url === undefined
        ? { api_type: 'json', sr: subreddit, kind: 'self', title, text: withFooter(text, footer) }
        : { api_type: 'json', sr: subreddit, kind: 'link', title, url };
      return Object.freeze({
        method: 'POST',
        path: '/api/submit/',
        form: Object.freeze(form),
        text: [title, text ?? url].join('\n'),
        complete: submitCompletion,
        legacy: legacyUnwrap,
      });
    }
    case 'comment': {
      const { parent, text } = args;
      checkFullname(parent, POST_OR_COMMENT_RE);
      if (!text?.trim()) throw new Error('Comment text is required.');
      return Object.freeze({
        method: 'POST',
        path: '/api/comment/',
        form: Object.freeze({ api_type: 'json', thing_id: parent, text: withFooter(text, footer) }),
        text,
        complete: (response) => thingCompletion(response, 'comment'),
        legacy: legacyUnwrap,
      });
    }
    case 'editText': {
      const { fullname, text, kind } = args;
      checkFullname(fullname, kind === 't3' ? POST_FULLNAME_RE : kind === 't1' ? COMMENT_FULLNAME_RE : POST_OR_COMMENT_RE);
      if (!text?.trim()) throw new Error('New text is required.');
      return Object.freeze({
        method: 'POST',
        path: '/api/editusertext/',
        form: Object.freeze({ api_type: 'json', thing_id: fullname, text: withFooter(text, footer) }),
        text,
        complete: (response) => thingCompletion(response, 'edit'),
        legacy: legacyUnwrap,
      });
    }
    case 'deleteThing': {
      const { fullname, kind } = args;
      checkFullname(fullname, kind === 't3' ? POST_FULLNAME_RE : kind === 't1' ? COMMENT_FULLNAME_RE : POST_OR_COMMENT_RE);
      return Object.freeze({
        method: 'POST',
        path: '/api/del/',
        form: Object.freeze({ id: fullname }),
        text: undefined,
        complete: (response) => {
          assertNoRefusal(response, 'delete');
          return legacyUnwrap(response);
        },
        legacy: legacyUnwrap,
      });
    }
    case 'vote': {
      const { fullname, direction } = args;
      checkFullname(fullname);
      if (!Object.hasOwn(VOTE_DIRECTIONS, direction)) throw new Error('Direction must be up, down, or clear.');
      return Object.freeze({
        method: 'POST',
        path: '/api/vote/',
        form: Object.freeze({ id: fullname, dir: String(VOTE_DIRECTIONS[direction]) }),
        text: undefined,
        complete: (response) => emptyCompletion(response, 'vote'),
        legacy: (response) => response,
      });
    }
    case 'subscribe': {
      const { subreddit, subscribe } = args;
      checkSubreddit(subreddit);
      return Object.freeze({
        method: 'POST',
        path: '/api/subscribe/',
        form: Object.freeze({ action: subscribe ? 'sub' : 'unsub', sr_name: subreddit }),
        text: undefined,
        complete: (response) => emptyCompletion(response, 'subscription'),
        legacy: (response) => response,
      });
    }
    case 'save': {
      const { fullname, undo = false } = args;
      checkFullname(fullname);
      return Object.freeze({
        method: 'POST',
        path: undo ? '/api/unsave/' : '/api/save/',
        form: Object.freeze({ id: fullname }),
        text: undefined,
        complete: (response) => emptyCompletion(response, 'save'),
        legacy: (response) => response,
      });
    }
    default:
      throw new OperationError('UNSUPPORTED_OPERATION', `No API mutation plan exists for action ${action}.`);
  }
}

// Raw POST is API-only and has no per-operation response schema to verify. It keeps its own
// `raw_post` policy/admission key so it cannot borrow a shipped tool's approval entry.
//
// The path is rejected here as well as in the client: `\` is a URL separator to WHATWG, so `/\host`
// would otherwise resolve to another origin before the client's own check could see it.
export function planRawMutation({ path, fields = {} } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
    || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new OperationError('UNSUPPORTED_OPERATION', 'A raw API path must start with a single slash and stay on the API host.');
  }
  const url = new URL(path, API_BASE);
  if (url.origin !== new URL(API_BASE).origin) {
    throw new OperationError('UNSUPPORTED_OPERATION', 'A raw API path must start with a single slash and stay on the API host.');
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('Raw POST fields must be an object.');
  }
  return Object.freeze({
    method: 'POST',
    path,
    form: Object.freeze({ ...fields }),
    text: undefined,
    complete: (response) => emptyCompletion(response, 'raw POST'),
    legacy: (response) => response,
  });
}

// Endpoint paths and form fields follow PRAW's endpoints.py and call sites. The listing and comment
// calls follow jordanburke/reddit-mcp-server. `footer` is appended to every text this project writes.
//
// Writes run through exactly one admission adapter: the legacy `guard.run` (direct CLI use), or the
// injected `writes.run` that a dispatcher binds to the shared durable boundary. Supplying both is a
// programming error: nested guards would double-record, double-space, or double-dispatch.
export function createActions({ client, guard, writes, footer = '', authMode = 'oauth' }) {
  if (guard && writes) {
    throw new TypeError('createActions accepts either the legacy guard or a writes adapter, never both.');
  }
  if (writes && (typeof writes.run !== 'function')) throw new TypeError('A writes adapter must expose run().');

  // `perform` sends one prepared request; the adapter decides whether that send needs the legacy
  // guard or the shared boundary. Nothing else in this module re-guards.
  async function runPlan(plan, operation) {
    const perform = async () => {
      const response = await client.request('POST', plan.path, { form: plan.form });
      return writes ? plan.complete(response) : plan.legacy(response);
    };
    if (writes) {
      if (!operation || operation.kind !== 'write') {
        throw new TypeError('A guarded writes adapter needs the write operation descriptor.');
      }
      return writes.run({ operation, text: plan.text, perform });
    }
    if (!guard || typeof guard.run !== 'function') {
      throw new TypeError('createActions needs a guard or writes adapter to perform writes.');
    }
    return guard.run({ text: plan.text, perform });
  }

  // One paged listing. `after` is the cursor for the next page.
  async function listing(path, { sort, time, limit = 25, after }, what) {
    const query = { limit: checkLimit(limit) };
    if (sort !== undefined) query.sort = checkOneOf(sort, LISTING_SORTS, 'Sort');
    if (time !== undefined) query.t = checkOneOf(time, TIME_RANGES, 'Time range');
    if (after !== undefined) query.after = after;
    const data = expectData(await client.request('GET', path, { query }), what);
    return { items: data.children.map(shapeThing), after: data.after ?? null };
  }

  const actions = {
    async whoami() {
      const me = await client.request('GET', '/api/v1/me');
      if (!me?.name) throw new RedditError('Reddit returned no account details.', { details: me });
      return { name: me.name, linkKarma: me.link_karma, commentKarma: me.comment_karma };
    },

    async myUsername() {
      return (await actions.whoami()).name;
    },

    // browse_subreddit. The same call with sort 'top' is get_top_posts. includeInfo adds the subreddit's details.
    async feed({ subreddit, sort = 'hot', limit = 10, time, after, includeInfo = false } = {}) {
      checkSubreddit(subreddit);
      checkOneOf(sort, SORTS, 'Sort');
      checkLimit(limit);
      const query = { limit };
      if (time !== undefined) query.t = checkOneOf(time, TIME_RANGES, 'Time range');
      if (after !== undefined) query.after = after;
      const data = expectData(await client.request('GET', `/r/${subreddit}/${sort}`, { query }), 'this listing');
      const page = { items: data.children.map(shapeThing), after: data.after ?? null };
      if (includeInfo) page.info = await actions.subreddit(subreddit);
      return page;
    },

    async topPosts({ subreddit, time = 'day', limit = 10, after } = {}) {
      return actions.feed({ subreddit, sort: 'top', time, limit, after });
    },

    async subreddit(name) {
      checkSubreddit(name);
      const data = expectData(await client.request('GET', `/r/${name}/about`), `r/${name}`);
      return {
        name: data.display_name,
        title: data.title,
        subscribers: data.subscribers,
        description: data.public_description,
      };
    },

    async rules(name) {
      checkSubreddit(name);
      const response = await client.request('GET', `/r/${name}/about/rules`);
      if (!Array.isArray(response?.rules)) {
        throw new RedditError(`Reddit returned no rules for r/${name}.`, { details: response });
      }
      return response.rules.map((rule) => ({
        shortName: rule.short_name,
        description: rule.description,
        kind: rule.kind,
      }));
    },

    async flairs(name) {
      checkSubreddit(name);
      const flairs = expectArray(await client.request('GET', `/r/${name}/api/link_flair_v2`), `flairs for r/${name}`);
      return flairs.map((flair) => ({ id: flair.id, text: flair.text, textEditable: flair.text_editable }));
    },

    // Reddit's popular list is the closest public equivalent of "trending".
    async popular({ limit = 5 } = {}) {
      checkLimit(limit);
      const data = expectData(
        await client.request('GET', '/subreddits/popular', { query: { limit } }),
        'popular subreddits',
      );
      return data.children.map(({ data: sub }) => sub.display_name);
    },

    // search_reddit. Author and flair become Reddit's author: and flair: query terms.
    async search({ query, subreddit, sort = 'relevance', time = 'all', limit = 25, type = 'link', after, author, flair } = {}) {
      checkOneOf(sort, SEARCH_SORTS, 'Search sort');
      checkOneOf(time, TIME_RANGES, 'Time range');
      checkLimit(limit);
      checkOneOf(type, SEARCH_TYPES, 'Search type');
      const terms = [];
      if (query?.trim()) terms.push(query.trim());
      if (author !== undefined) terms.push(`author:${checkUsername(author)}`);
      if (flair !== undefined) terms.push(`flair:"${String(flair).replace(/["\\]/g, '')}"`);
      if (terms.length === 0) throw new Error('Give a search query, an author, or a flair.');
      const params = { q: terms.join(' '), sort, t: time, limit, type };
      let path = '/search';
      if (subreddit !== undefined) {
        checkSubreddit(subreddit);
        path = `/r/${subreddit}/search`;
        params.restrict_sr = 'true';
      }
      if (after !== undefined) params.after = after;
      const data = expectData(await client.request('GET', path, { query: params }), 'this search');
      return { items: data.children.map(shapeThing), after: data.after ?? null };
    },

    // The post and its comment tree. moreIds are the stubs that moreComments can expand.
    async readPost({ id, subreddit, sort = 'confidence', limit = 100, depth } = {}) {
      const ref = parsePostRef(id);
      const postId = ref ? ref.id : bareId(id);
      const sr = subreddit ?? ref?.subreddit;
      checkOneOf(sort, COMMENT_SORTS, 'Comment sort');
      checkLimit(limit, 500);
      const query = { sort, limit };
      if (depth !== undefined) {
        if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw new Error('Depth must be between 1 and 10.');
        query.depth = depth;
      }
      let path = `/comments/${postId}`;
      if (sr !== undefined) {
        checkSubreddit(sr);
        path = `/r/${sr}/comments/${postId}`;
      }
      const [postPage, commentPage] = expectArray(await client.request('GET', path, { query }), `post ${postId}`);
      const post = postPage?.data?.children?.[0]?.data;
      if (!post) throw new RedditError(`Post ${postId} was not found or is not visible to this account.`);
      const { comments, moreIds } = parseCommentTree(commentPage?.data?.children ?? []);
      return { post: shapePost(post), comments, moreIds };
    },

    // "Load more" expansion through /api/morechildren, up to 100 ids per call.
    async moreComments({ postFullname, childIds } = {}) {
      checkFullname(postFullname, POST_FULLNAME_RE);
      if (!Array.isArray(childIds) || childIds.length === 0 || childIds.length > 100) {
        throw new Error('Give between 1 and 100 comment ids.');
      }
      const response = await client.request('GET', '/api/morechildren', {
        query: { api_type: 'json', link_id: postFullname, children: childIds.map(bareId).join(',') },
      });
      const things = unwrap(response)?.things ?? [];
      return things.filter((thing) => thing.kind === 't1').map(shapeThing);
    },

    async userInfo(username) {
      checkUsername(username);
      const data = expectData(await client.request('GET', `/user/${username}/about`), `u/${username}`);
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

    async userPosts(username, options = {}) {
      checkUsername(username);
      return listing(`/user/${username}/submitted`, { sort: 'new', time: 'all', ...options }, `u/${username} posts`);
    },

    async userComments(username, options = {}) {
      checkUsername(username);
      return listing(`/user/${username}/comments`, { sort: 'new', time: 'all', ...options }, `u/${username} comments`);
    },

    // user_analysis: karma, a sample of recent posts and comments, and the subreddits they cluster in.
    async userActivity(username) {
      checkUsername(username);
      const [account, posts, comments] = await Promise.all([
        actions.userInfo(username),
        listing(`/user/${username}/submitted`, { sort: 'new', time: 'all', limit: 100 }, `u/${username} posts`),
        listing(`/user/${username}/comments`, { sort: 'new', time: 'all', limit: 100 }, `u/${username} comments`),
      ]);
      const counts = new Map();
      for (const item of [...posts.items, ...comments.items]) {
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

    // Your own history needs the history scope. These use the account name from whoami, not the config.
    async overview(options = {}) {
      return listing(`/user/${await actions.myUsername()}/overview`, options, 'your overview');
    },

    async saved(options = {}) {
      return listing(`/user/${await actions.myUsername()}/saved`, options, 'your saved items');
    },

    async mySubscriptions({ limit = 100 } = {}) {
      checkLimit(limit);
      const data = expectData(
        await client.request('GET', '/subreddits/mine/subscriber/', { query: { limit } }),
        'your subscriptions',
      );
      return data.children.map(({ data: sub }) => sub.display_name);
    },

    explain(term) {
      return lookupTerm(term);
    },

    // test_reddit_mcp_server: a read that works in every mode, plus a whoami when the mode has a user.
    async selfTest({ checkAccount = authMode !== 'app' } = {}) {
      const started = Date.now();
      const checks = [];
      const run = async (name, task) => {
        try {
          checks.push({ name, ok: true, detail: await task() });
        } catch (error) {
          checks.push({ name, ok: false, detail: error.message });
        }
      };
      await run('read: popular subreddits', async () => (await actions.popular({ limit: 1 }))[0] ?? 'none');
      if (checkAccount) await run('account: whoami', async () => (await actions.whoami()).name);
      return { authMode, ok: checks.every((check) => check.ok), checks, elapsedMs: Date.now() - started };
    },

    // ---- Writes. Each goes through the one configured adapter: spacing, duplicate check, and the
    // hourly cap in legacy use; the durable account boundary when a dispatcher injects `writes`. ----

    async submitPost(args = {}, options = {}) {
      return runPlan(planMutation('submitPost', args, { footer }), options.operation);
    },

    async comment(args = {}, options = {}) {
      return runPlan(planMutation('comment', args, { footer }), options.operation);
    },

    // Edits your own post (kind 't3') or comment (kind 't1'). Without a kind, either is accepted.
    async editText(args = {}, options = {}) {
      return runPlan(planMutation('editText', args, { footer }), options.operation);
    },

    // Deletes your own post or comment. Not reversible.
    async deleteThing(args = {}, options = {}) {
      return runPlan(planMutation('deleteThing', args, { footer }), options.operation);
    },

    async vote(args = {}, options = {}) {
      return runPlan(planMutation('vote', args, { footer }), options.operation);
    },

    async subscribe(args = {}, options = {}) {
      return runPlan(planMutation('subscribe', args, { footer }), options.operation);
    },

    async save(args = {}, options = {}) {
      return runPlan(planMutation('save', args, { footer }), options.operation);
    },

    async raw({ method, path, fields = {} } = {}, options = {}) {
      const verb = String(method ?? '').toUpperCase();
      if (verb === 'GET') return client.request('GET', path, { query: fields });
      if (verb !== 'POST') throw new Error('Only GET and POST are supported.');
      const plan = planRawMutation({ path, fields });
      const operation = options.operation ?? Object.freeze({
        tool: 'raw_post',
        action: 'raw',
        kind: 'write',
        policyKey: 'raw_post',
        target: `raw:POST:${path}`,
        requiresIdentity: true,
        contentHash: null,
        args: Object.freeze({ method: 'POST', path, fields: Object.freeze({ ...fields }) }),
      });
      return runPlan(plan, operation);
    },
  };
  return actions;
}
