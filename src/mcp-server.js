import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VERSION, loadConfig } from './config.js';
import { lookupTerm } from './glossary.js';
import { browseSubredditRss } from './rss.js';
import { openSession } from './session.js';

const SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];
const LISTING_SORTS = ['hot', 'new', 'top', 'controversial'];
const TIME_RANGES = ['hour', 'day', 'week', 'month', 'year', 'all'];
const COMMENT_SORTS = ['confidence', 'top', 'new', 'controversial', 'old', 'qa'];
const SEARCH_SORTS = ['relevance', 'hot', 'top', 'new', 'comments'];
const LIMIT = z.number().int().min(1).max(100);
const CURSOR = z.string().optional().describe('The "after" cursor from the previous page');
const CONFIRM = z.literal(true).describe('Must be true. Nothing is sent to Reddit unless this is set.');

// One session per process, built on first use, so the server can start before any configuration exists.
function lazyActions() {
  let actions;
  return () => {
    actions ??= openSession(loadConfig()).actions;
    return actions;
  };
}

const defaultActions = lazyActions();

// Builds the MCP server with every tool. Stdio and HTTP both use it, so they expose the same tools.
export function createRedditMcpServer(getActions = defaultActions) {
  const server = new McpServer({ name: 'reddit-api-mcp', version: VERSION });
  const actions = () => getActions();

  function registerTool(name, description, shape, run) {
    server.tool(name, description, shape, async (args) => {
      try {
        const result = await run(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }

  // Writes refuse to run without confirm: true, even when the host skips its own approval prompt.
  function registerWrite(name, description, shape, run) {
    registerTool(name, description, { ...shape, confirm: CONFIRM }, async (args) => {
      if (args.confirm !== true) throw new Error('Refusing to write without confirm: true.');
      return run(args);
    });
  }

  // ---- Reads ----

  registerTool('get_me', 'The logged-in account: name and karma.', {}, () => actions().whoami());

  registerTool(
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
    ({ include_info, ...args }) => actions().feed({ ...args, includeInfo: include_info }),
  );

  registerTool(
    'get_top_posts',
    'Top posts in a subreddit for a time range.',
    { subreddit: z.string(), time: z.enum(TIME_RANGES).default('day'), limit: LIMIT.default(10), after: CURSOR },
    (args) => actions().topPosts(args),
  );

  registerTool(
    'get_subreddit_info',
    'Subscriber count, title, and description of a subreddit.',
    { subreddit: z.string() },
    ({ subreddit }) => actions().subreddit(subreddit),
  );

  registerTool(
    'get_subreddit_rules',
    'The rules of a subreddit.',
    { subreddit: z.string() },
    ({ subreddit }) => actions().rules(subreddit),
  );

  registerTool(
    'get_post_flairs',
    'The post flairs a subreddit offers.',
    { subreddit: z.string() },
    ({ subreddit }) => actions().flairs(subreddit),
  );

  registerTool(
    'get_trending_subreddits',
    "Reddit's popular subreddits. This is the closest public list to trending.",
    { limit: LIMIT.default(5) },
    ({ limit }) => actions().popular({ limit }),
  );

  registerTool(
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
    (args) => actions().search(args),
  );

  registerTool(
    'get_reddit_post',
    'One post, without comments. Accepts a fullname (t3_...), a bare id, or a reddit.com link.',
    { post_id: z.string(), subreddit: z.string().optional() },
    async ({ post_id, subreddit }) => (await actions().readPost({ id: post_id, subreddit, limit: 1 })).post,
  );

  registerTool(
    'get_post_comments',
    'Comments on a post, threaded with depth, plus the ids of "load more" stubs for get_more_comments.',
    {
      post_id: z.string(),
      subreddit: z.string().optional(),
      sort: z.enum(COMMENT_SORTS).default('confidence'),
      limit: z.number().int().min(1).max(500).default(100),
      depth: z.number().int().min(1).max(10).optional(),
    },
    async ({ post_id, subreddit, sort, limit, depth }) => {
      const { comments, moreIds } = await actions().readPost({ id: post_id, subreddit, sort, limit, depth });
      return { comments, moreIds };
    },
  );

  registerTool(
    'get_more_comments',
    'Expand "load more" comment ids from get_post_comments. Up to 100 ids per call.',
    {
      post_id: z.string().describe('The post fullname, t3_...'),
      comment_ids: z.array(z.string()).min(1).max(100),
    },
    ({ post_id, comment_ids }) => actions().moreComments({ postFullname: post_id, childIds: comment_ids }),
  );

  registerTool(
    'get_user_info',
    "A Reddit user's karma, account age, and flags.",
    { username: z.string() },
    ({ username }) => actions().userInfo(username),
  );

  registerTool(
    'get_user_posts',
    "A user's posts, newest first by default.",
    {
      username: z.string(),
      sort: z.enum(LISTING_SORTS).default('new'),
      time: z.enum(TIME_RANGES).default('all'),
      limit: LIMIT.default(25),
      after: CURSOR,
    },
    ({ username, ...options }) => actions().userPosts(username, options),
  );

  registerTool(
    'get_user_comments',
    "A user's comments, newest first by default.",
    {
      username: z.string(),
      sort: z.enum(LISTING_SORTS).default('new'),
      time: z.enum(TIME_RANGES).default('all'),
      limit: LIMIT.default(25),
      after: CURSOR,
    },
    ({ username, ...options }) => actions().userComments(username, options),
  );

  registerTool(
    'user_analysis',
    'A user summary: karma, a sample of recent posts and comments, and the subreddits they are most active in.',
    { username: z.string() },
    ({ username }) => actions().userActivity(username),
  );

  registerTool(
    'get_my_overview',
    'Your own posts and comments, newest first. Needs the history scope.',
    { limit: LIMIT.default(25), after: CURSOR },
    (args) => actions().overview(args),
  );

  registerTool(
    'get_my_saved',
    'Your saved posts and comments. Needs the history scope.',
    { limit: LIMIT.default(25), after: CURSOR },
    (args) => actions().saved(args),
  );

  registerTool(
    'list_my_subreddits',
    'The subreddits you have joined.',
    { limit: LIMIT.default(100) },
    ({ limit }) => actions().mySubscriptions({ limit }),
  );

  registerTool(
    'browse_subreddit_rss',
    'Public feed, with no client ID needed. Read-only and reduced: no scores or comment counts. Reddit may throttle it.',
    { subreddit: z.string(), sort: z.enum(SORTS).default('hot'), limit: LIMIT.default(25) },
    (args) => browseSubredditRss({ ...args, userAgent: `node:reddit-cli:${VERSION}` }),
  );

  registerTool(
    'reddit_explain',
    'Plain-language meaning of a Reddit term, such as karma, cake day, AMA, ELI5, OP, or flair. Offline.',
    { term: z.string() },
    ({ term }) => lookupTerm(term),
  );

  registerTool(
    'test_reddit_mcp_server',
    'Checks the configuration end to end: a public read, and a whoami when the auth mode has a user.',
    {},
    () => actions().selfTest(),
  );

  // ---- Writes. Each needs confirm: true. ----

  registerWrite(
    'create_post',
    'Submit a text post (text) or a link post (url) to a subreddit.',
    { subreddit: z.string(), title: z.string(), text: z.string().optional(), url: z.string().url().optional() },
    (args) => actions().submitPost(args),
  );

  registerWrite(
    'reply_to_post',
    'Reply to a post (t3_...) or to a comment (t1_...).',
    { parent: z.string(), text: z.string() },
    (args) => actions().comment(args),
  );

  registerWrite(
    'edit_post',
    'Replace the text of your own text post (t3_...).',
    { fullname: z.string(), text: z.string() },
    ({ fullname, text }) => actions().editText({ fullname, text, kind: 't3' }),
  );

  registerWrite(
    'edit_comment',
    'Replace the text of your own comment (t1_...).',
    { fullname: z.string(), text: z.string() },
    ({ fullname, text }) => actions().editText({ fullname, text, kind: 't1' }),
  );

  registerWrite(
    'delete_post',
    'Delete your own post (t3_...). This cannot be undone.',
    { fullname: z.string() },
    ({ fullname }) => actions().deleteThing({ fullname, kind: 't3' }),
  );

  registerWrite(
    'delete_comment',
    'Delete your own comment (t1_...). This cannot be undone.',
    { fullname: z.string() },
    ({ fullname }) => actions().deleteThing({ fullname, kind: 't1' }),
  );

  registerWrite(
    'save_content',
    'Save a post or comment to your account.',
    { fullname: z.string() },
    ({ fullname }) => actions().save({ fullname }),
  );

  registerWrite(
    'unsave_content',
    'Remove a post or comment from your saved items.',
    { fullname: z.string() },
    ({ fullname }) => actions().save({ fullname, undo: true }),
  );

  registerWrite(
    'vote_on_thing',
    'Upvote, downvote, or clear your vote on one post or comment.',
    { fullname: z.string(), direction: z.enum(['up', 'down', 'clear']) },
    (args) => actions().vote(args),
  );

  registerWrite(
    'subscribe_to_subreddit',
    'Join a subreddit.',
    { subreddit: z.string() },
    ({ subreddit }) => actions().subscribe({ subreddit, subscribe: true }),
  );

  registerWrite(
    'unsubscribe_from_subreddit',
    'Leave a subreddit.',
    { subreddit: z.string() },
    ({ subreddit }) => actions().subscribe({ subreddit, subscribe: false }),
  );

  return server;
}
