import { RedditError } from './client.js';
import { lookupTerm } from './glossary.js';

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const FULLNAME_RE = /^t[1-6]_[a-z0-9]+$/i;
const POST_FULLNAME_RE = /^t3_[a-z0-9]+$/i;
const COMMENT_FULLNAME_RE = /^t1_[a-z0-9]+$/i;
const POST_OR_COMMENT_RE = /^t[13]_[a-z0-9]+$/i;
const SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];
const LISTING_SORTS = ['hot', 'new', 'top', 'controversial'];
const COMMENT_SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'];
const SEARCH_SORTS = ['relevance', 'hot', 'top', 'new', 'comments'];
const SEARCH_TYPES = ['link', 'sr', 'user'];
const TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];
const VOTE_DIRECTIONS = { up: 1, down: -1, clear: 0 };

function checkSubreddit(name) {
  if (!SUBREDDIT_RE.test(name ?? '')) throw new Error(`Not a valid subreddit name: ${name}`);
  return name;
}

function checkUsername(name) {
  if (!USERNAME_RE.test(name ?? '')) throw new Error(`Not a valid Reddit username: ${name}`);
  return name;
}

function checkFullname(value, pattern = FULLNAME_RE) {
  if (!pattern.test(value ?? '')) throw new Error(`Expected a Reddit fullname such as t3_abc123, got: ${value}`);
  return value;
}

function checkOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function checkLimit(limit, max = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new Error(`Limit must be between 1 and ${max}.`);
  return limit;
}

// Accepts "t3_abc123", "t1_abc123", or a bare id such as "abc123".
function bareId(value) {
  const id = String(value ?? '').replace(/^t[0-9]_/i, '');
  if (!/^[a-z0-9]+$/i.test(id)) throw new Error(`Not a valid Reddit id: ${value}`);
  return id;
}

// Post links as people paste them: reddit.com (and old., new., np., m.) and redd.it short links, which
// carry only the id. Returns null for anything else.
export function parsePostRef(value) {
  const text = String(value ?? '').trim();
  const link = /reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([a-z0-9]+)/i.exec(text);
  if (link) return { subreddit: link[1], id: link[2].toLowerCase() };
  const short = /redd\.it\/([a-z0-9]+)/i.exec(text);
  if (short) return { subreddit: undefined, id: short[1].toLowerCase() };
  return null;
}

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

// Endpoint paths and form fields follow PRAW's endpoints.py and call sites. The listing and comment
// calls follow jordanburke/reddit-mcp-server. `footer` is appended to every text this project writes.
export function createActions({ client, guard, footer = '', authMode = 'oauth' }) {
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

    // ---- Writes. Each goes through the guard: spacing, duplicate check, and the hourly cap. ----

    async submitPost({ subreddit, title, text, url }) {
      checkSubreddit(subreddit);
      if (!title?.trim()) throw new Error('A title is required.');
      if ((text === undefined) === (url === undefined)) throw new Error('Give exactly one of --text or --url.');
      const form = url === undefined
        ? { api_type: 'json', sr: subreddit, kind: 'self', title, text: withFooter(text, footer) }
        : { api_type: 'json', sr: subreddit, kind: 'link', title, url };
      return guard.run({
        text: [title, text ?? url].join('\n'),
        perform: async () => unwrap(await client.request('POST', '/api/submit/', { form })),
      });
    },

    async comment({ parent, text }) {
      checkFullname(parent, POST_OR_COMMENT_RE);
      if (!text?.trim()) throw new Error('Comment text is required.');
      return guard.run({
        text,
        perform: async () => unwrap(await client.request('POST', '/api/comment/', {
          form: { api_type: 'json', thing_id: parent, text: withFooter(text, footer) },
        })),
      });
    },

    // Edits your own post (kind 't3') or comment (kind 't1'). Without a kind, either is accepted.
    async editText({ fullname, text, kind } = {}) {
      checkFullname(fullname, kind === 't3' ? POST_FULLNAME_RE : kind === 't1' ? COMMENT_FULLNAME_RE : POST_OR_COMMENT_RE);
      if (!text?.trim()) throw new Error('New text is required.');
      return guard.run({
        text,
        perform: async () => unwrap(await client.request('POST', '/api/editusertext/', {
          form: { api_type: 'json', thing_id: fullname, text: withFooter(text, footer) },
        })),
      });
    },

    // Deletes your own post or comment. Not reversible.
    async deleteThing({ fullname, kind } = {}) {
      checkFullname(fullname, kind === 't3' ? POST_FULLNAME_RE : kind === 't1' ? COMMENT_FULLNAME_RE : POST_OR_COMMENT_RE);
      return guard.run({
        perform: async () => unwrap(await client.request('POST', '/api/del/', { form: { id: fullname } })),
      });
    },

    async vote({ fullname, direction }) {
      checkFullname(fullname);
      if (!Object.hasOwn(VOTE_DIRECTIONS, direction)) throw new Error('Direction must be up, down, or clear.');
      return guard.run({
        perform: () => client.request('POST', '/api/vote/', {
          form: { id: fullname, dir: String(VOTE_DIRECTIONS[direction]) },
        }),
      });
    },

    async subscribe({ subreddit, subscribe }) {
      checkSubreddit(subreddit);
      return guard.run({
        perform: () => client.request('POST', '/api/subscribe/', {
          form: { action: subscribe ? 'sub' : 'unsub', sr_name: subreddit },
        }),
      });
    },

    async save({ fullname, undo = false }) {
      checkFullname(fullname);
      return guard.run({
        perform: () => client.request('POST', undo ? '/api/unsave/' : '/api/save/', { form: { id: fullname } }),
      });
    },

    async raw({ method, path, fields = {} }) {
      const verb = method.toUpperCase();
      if (verb === 'GET') return client.request('GET', path, { query: fields });
      if (verb === 'POST') return guard.run({ perform: () => client.request('POST', path, { form: fields }) });
      throw new Error('Only GET and POST are supported.');
    },
  };
  return actions;
}
