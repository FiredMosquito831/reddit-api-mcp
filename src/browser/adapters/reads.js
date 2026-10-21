// Known rendered-UI read adapters for the modern desktop www.reddit.com surface.
//
// Each tool maps to one finite navigation plus a parser for the bounded page model the in-page
// extractor returns. Nothing here clicks, types, invokes page JavaScript supplied by a caller, or
// follows arbitrary links. Reddit text is data: a page whose text says "click delete" cannot change
// the target, account, or policy.
//
// Honest limits: rendered pages do not expose exact API cursors, all listing metrics, flair template
// ids, or the full comment tree. Results are marked partial and name the missing fields; operations
// whose essential parameter cannot be produced from the UI are reported as PARAMETER_UNSUPPORTED
// rather than guessed. The in-page selectors are best-effort and untested against a live account.

import { OperationError } from '../../errors.js';
import { checkLimit, checkOneOf, checkSubreddit, SEARCH_SORTS, SORTS, TIME_RANGES } from '../../validation.js';
import { gotoReddit, REDDIT_ORIGIN, securityScreenOf } from '../steps.js';

export const BROWSER_READ_TOOLS = Object.freeze([
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
  'test_reddit_mcp_server',
]);

// Essential parameters the rendered UI cannot supply. These stay explicit gaps until a verified
// mapping exists; a visible label is not the same evidence as an API id.
export const UNSUPPORTED_BROWSER_READS = Object.freeze({
  get_post_flairs: Object.freeze({
    reason: 'flair_template_ids_unavailable',
    message: 'Rendered flair labels do not expose the flair template ids this tool returns, so the browser backend cannot answer it honestly.',
  }),
  get_more_comments: Object.freeze({
    reason: 'branch_ids_unavailable',
    message: 'Expanding named comment branches needs exact ids that the rendered page does not expose; generic scrolling is not equivalent.',
  }),
});

const POST_FIELDS = Object.freeze(['upvoteRatio', 'createdUtc']);
const USER_FIELDS = Object.freeze(['linkKarma', 'commentKarma', 'totalKarma', 'createdUtc', 'isMod']);
const SUBREDDIT_FIELDS = Object.freeze(['title', 'subscribers', 'description']);

// In-page extractor. It reads a small, fixed set of semantic containers and visible text; it never
// returns cookies, tokens, headers, or storage state. Selectors are likely UI variants and must be
// re-verified against a live page (Task 16) before any live status is claimed.
// Exported for the offline extractor tests: the adapters receive whatever this returns, so an
// adapter-only fixture cannot prove the wiring. It references only page globals, never module state.
export const BOUNDED_PAGE_MODEL = ({ kind, limit } = {}) => {
  const text = (node) => String(node?.innerText ?? node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const int = (value) => {
    const match = /(-?\d[\d,.]*[km]?)/i.exec(String(value ?? ''));
    if (!match) return null;
    const raw = match[1].toLowerCase();
    const number = Number.parseFloat(raw.replace(/,/g, ''));
    if (!Number.isFinite(number)) return null;
    if (raw.endsWith('k')) return Math.round(number * 1_000);
    if (raw.endsWith('m')) return Math.round(number * 1_000_000);
    return Math.round(number);
  };
  const idFromHref = (href) => {
    const match = /\/comments\/([a-z0-9]+)/i.exec(String(href ?? ''));
    return match ? match[1].toLowerCase() : null;
  };
  const seconds = (value) => {
    const ms = Date.parse(String(value ?? ''));
    return Number.isFinite(ms) ? Math.round(ms / 1_000) : null;
  };
  const path = String(location.pathname ?? '');
  const postMatch = /^\/r\/[^/]+\/comments\/([a-z0-9]+)/i.exec(path) || /^\/comments\/([a-z0-9]+)/i.exec(path);
  const canonicalId = postMatch ? postMatch[1].toLowerCase() : null;
  const bodyText = String(document.body?.innerText ?? '').slice(0, 4_000);
  const base = {
    kind: typeof kind === 'string' ? kind : 'page',
    url: String(location.href),
    title: String(document.title || ''),
    recognized: true,
    truncated: false,
    canonicalId,
    entry: null,
    items: [],
    comments: [],
    rules: [],
    subscriptions: [],
  };

  const shapePost = (node) => {
    const permalink = node.getAttribute('permalink') || node.querySelector('a[href*="/comments/"]')?.getAttribute('href') || null;
    const id = (node.getAttribute('id') || '').replace(/^t3_/, '') || idFromHref(permalink);
    if (!id) return null;
    return {
      kind: 't3',
      id,
      title: node.getAttribute('post-title') || text(node.querySelector('[slot="title"], h1, h2')) || null,
      author: node.getAttribute('author') || null,
      subreddit: node.getAttribute('subreddit-prefixed-name')?.replace(/^r\//, '') || node.getAttribute('subreddit-name') || null,
      score: int(node.getAttribute('score') ?? text(node.querySelector('[data-post-click-location="vote"]'))),
      comments: int(node.getAttribute('comment-count') ?? text(node.querySelector('[data-post-click-location="comments-button"]'))),
      upvoteRatio: (() => {
        const value = Number.parseFloat(String(node.getAttribute('upvote-ratio') ?? ''));
        return Number.isFinite(value) ? value : null;
      })(),
      createdUtc: seconds(node.getAttribute('created-timestamp')),
      url: node.getAttribute('url') || null,
      permalink,
      body: text(node.querySelector('[slot="text-body"]')) || null,
    };
  };

  const postNodes = Array.from(document.querySelectorAll('shreddit-post, [data-testid="post-container"]'));
  const bound = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const boundedPosts = postNodes.slice(0, bound);
  for (const node of boundedPosts) {
    const item = shapePost(node);
    if (item) base.items.push(item);
  }

  // The focused post is the one the URL names when it names one; a caller reading a listing ignores
  // `entry`, while a post read binds to it and refuses when it is absent.
  const focusPost = (canonicalId
    ? boundedPosts.find((node) => {
      const id = (node.getAttribute('id') || '').replace(/^t3_/, '');
      return id === canonicalId || idFromHref(node.getAttribute('permalink')) === canonicalId;
    })
    : null) ?? boundedPosts[0] ?? null;
  if (focusPost) base.entry = shapePost(focusPost);

  const commentNodes = Array.from(document.querySelectorAll('shreddit-comment'));
  for (const node of commentNodes.slice(0, 100)) {
    const id = (node.getAttribute('thingid') || node.getAttribute('id') || '').replace(/^t1_/, '');
    if (!id) continue;
    base.comments.push({
      kind: 't1',
      id,
      parentId: node.getAttribute('parentid') || null,
      author: node.getAttribute('author') || null,
      body: text(node.querySelector('[slot="comment"]')) || '',
      score: int(node.getAttribute('score')),
      depth: Number.parseInt(node.getAttribute('depth') || '0', 10) || 0,
      permalink: null,
    });
  }

  const subredditName = (/^\/r\/([A-Za-z0-9_]+)/.exec(path) ?? [])[1] ?? null;
  const ruleNodes = Array.from(document.querySelectorAll('shreddit-community-rules [data-testid="rule"], [data-testid="rule"]'));
  for (const node of ruleNodes.slice(0, 50)) {
    base.rules.push({
      shortName: text(node.querySelector('h3, [slot="title"]')) || null,
      description: text(node.querySelector('[slot="description"], p')) || null,
      kind: null,
    });
  }

  const header = document.querySelector('shreddit-subreddit-header');
  const metaDescription = document.querySelector('meta[name="description"]');
  const headerSubscribers = header?.getAttribute('subscribers');
  const membersMatch = /([\d,.]+[km]?)\s*members/i.exec(bodyText);
  base.subreddit = subredditName ? {
    name: subredditName,
    title: header?.getAttribute('display-name') || null,
    subscribers: headerSubscribers !== null && headerSubscribers !== undefined && headerSubscribers !== ''
      ? int(headerSubscribers)
      : (membersMatch ? int(membersMatch[1]) : null),
    description: header?.getAttribute('description') || metaDescription?.getAttribute('content') || null,
  } : null;

  const userMatch = /^\/user\/([A-Za-z0-9_-]+)/i.exec(path);
  const profile = document.querySelector('shreddit-profile-header');
  const karmaFrom = (attribute, pattern) => {
    const declared = profile?.getAttribute(attribute);
    if (declared !== null && declared !== undefined && declared !== '') return int(declared);
    const match = pattern.exec(bodyText);
    return match ? int(match[1]) : null;
  };
  base.user = userMatch ? {
    name: userMatch[1],
    id: profile?.getAttribute('profile-id') || null,
    linkKarma: karmaFrom('post-karma', /([\d,.]+[km]?)\s*(?:post|link) karma/i),
    commentKarma: karmaFrom('comment-karma', /([\d,.]+[km]?)\s*comment karma/i),
    createdUtc: seconds(profile?.getAttribute('created-timestamp')),
  } : null;
  base.account = null;
  const accountNode = document.querySelector('#expand-user-drawer [data-testid="profile-name"], faceplate-tracker[noun="user"] a');
  if (accountNode) base.account = { username: text(accountNode).replace(/^u\//, '') || null };
  base.next = null;
  return base;
};

async function extractPageModel(page, request) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The browser page is not available.', { safeDetails: { reason: 'page_unavailable' } });
  }
  let model;
  try {
    model = await page.evaluate(BOUNDED_PAGE_MODEL, request);
  } catch {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The page could not be read safely.', { safeDetails: { reason: 'extraction_failed' } });
  }
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new OperationError('BACKEND_UNAVAILABLE', 'The page did not yield a readable structure.', { safeDetails: { reason: 'extraction_invalid' } });
  }
  if (model.recognized === false) {
    throw new OperationError('UNSUPPORTED_OPERATION', 'This Reddit page variant is not recognized. No element was clicked or guessed.', {
      safeDetails: { reason: 'unrecognized_page' },
    });
  }
  return model;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function fullname(kind, id) {
  return typeof id === 'string' && id !== '' ? `${kind}_${id}` : null;
}

function shapePost(item) {
  const id = stringOrNull(item?.id);
  return {
    fullname: id ? fullname('t3', id) : null,
    id,
    title: stringOrNull(item?.title),
    author: stringOrNull(item?.author),
    subreddit: stringOrNull(item?.subreddit),
    score: numberOrNull(item?.score),
    upvoteRatio: numberOrNull(item?.upvoteRatio),
    comments: numberOrNull(item?.comments),
    url: stringOrNull(item?.url),
    permalink: stringOrNull(item?.permalink),
    selftext: typeof item?.body === 'string' ? item.body : '',
  };
}

function shapeComment(item) {
  const id = stringOrNull(item?.id);
  return {
    fullname: id ? fullname('t1', id) : null,
    id,
    author: stringOrNull(item?.author),
    body: typeof item?.body === 'string' ? item.body : '',
    score: numberOrNull(item?.score),
    subreddit: stringOrNull(item?.subreddit),
    parentId: stringOrNull(item?.parentId),
    permalink: stringOrNull(item?.permalink),
    depth: Number.isInteger(item?.depth) && item.depth >= 0 ? item.depth : 0,
  };
}

function shapeItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      if (item.kind === 't1') return { kind: 't1', ...shapeComment(item) };
      if (item.kind === 't3') return { kind: 't3', ...shapePost(item) };
      return { kind: 't5', fullname: null, name: stringOrNull(item.name) };
    });
}

function listingMeta(model, extraFields = []) {
  const items = Array.isArray(model.items) ? model.items : [];
  const missing = new Set(extraFields);
  for (const item of items) {
    if (item?.kind === 't3') {
      for (const field of POST_FIELDS) if (item[field] === undefined || item[field] === null) missing.add(field);
      if (item.score === undefined || item.score === null) missing.add('score');
    }
  }
  return {
    completeness: 'partial',
    missingFields: [...missing],
    continuationState: model.next && typeof model.next === 'object' ? model.next : null,
  };
}

function assertRedditPage(model) {
  const screen = securityScreenOf(model);
  if (screen) {
    throw new OperationError(
      'USER_HANDOFF_REQUIRED',
      'Reddit is showing a sign-in or security screen. Finish it in the visible browser window; no page content was read.',
      { safeDetails: { reason: 'security_screen', screen } },
    );
  }
}

function assertAccount(model, ctx) {
  const shown = model?.account?.username;
  const expected = ctx?.account?.username;
  if (typeof shown === 'string' && shown !== '' && typeof expected === 'string' && expected !== ''
    && shown.toLowerCase() !== expected.toLowerCase()) {
    throw new OperationError('IDENTITY_MISMATCH', 'The signed-in Reddit account does not match the selected profile.', {
      safeDetails: { reason: 'page_account_mismatch' },
    });
  }
}

function assertSubreddit(model, name) {
  const shown = model?.subreddit?.name;
  if (typeof shown === 'string' && shown !== '' && shown.toLowerCase() !== String(name).toLowerCase()) {
    throw new OperationError('STEP_STALE', 'The open page is not the requested subreddit.', {
      safeDetails: { reason: 'target_changed' },
    });
  }
}

function assertCanonicalPost(model, id) {
  const shown = typeof model?.canonicalId === 'string' ? model.canonicalId.toLowerCase() : null;
  if (!shown) {
    throw new OperationError('STEP_STALE', 'The page did not prove which post it shows.', {
      safeDetails: { reason: 'target_unverified' },
    });
  }
  if (shown !== String(id).toLowerCase()) {
    throw new OperationError('STEP_STALE', 'The open page shows a different post than the one requested.', {
      safeDetails: { reason: 'target_changed' },
    });
  }
}

function searchUrl(args) {
  const terms = [];
  if (typeof args.query === 'string' && args.query.trim() !== '') terms.push(args.query.trim());
  if (args.author !== undefined) terms.push(`author:${args.author}`);
  if (args.flair !== undefined) terms.push(`flair:"${String(args.flair).replace(/["\\]/g, '')}"`);
  if (terms.length === 0) throw new Error('Give a search query, an author, or a flair.');
  const path = args.subreddit === undefined ? '/search/' : `/r/${args.subreddit}/search/`;
  const url = new URL(path, REDDIT_ORIGIN);
  url.searchParams.set('q', terms.join(' '));
  if (args.subreddit !== undefined) url.searchParams.set('restrict_sr', '1');
  if (args.sort !== undefined) url.searchParams.set('sort', args.sort);
  if (args.time !== undefined) url.searchParams.set('t', args.time);
  if (args.type !== undefined) url.searchParams.set('type', args.type);
  return url.toString();
}

function listingUrl(path, { sort, time } = {}) {
  const url = new URL(path, REDDIT_ORIGIN);
  if (sort !== undefined) url.searchParams.set('sort', sort);
  if (time !== undefined) url.searchParams.set('t', time);
  return url.toString();
}

function postUrl(id, { subreddit, sort, limit, depth } = {}) {
  const base = subreddit === undefined ? `/comments/${id}/` : `/r/${subreddit}/comments/${id}/`;
  const url = new URL(base, REDDIT_ORIGIN);
  if (sort !== undefined) url.searchParams.set('sort', sort);
  if (limit !== undefined) url.searchParams.set('limit', String(limit));
  if (depth !== undefined) url.searchParams.set('depth', String(depth));
  return url.toString();
}

// The adapters: one finite navigation, one extraction, one parser. `ctx` is
// `{page, account, sessions, signal}`; nothing here mutates account state.
export function createReadAdapters({ extract = extractPageModel } = {}) {
  async function load(page, url, request, ctx) {
    if (ctx?.signal?.aborted) {
      throw new OperationError('USER_HANDOFF_REQUIRED', 'The operation was cancelled before dispatch; nothing was sent.', {
        safeDetails: { reason: 'cancelled' },
      });
    }
    await gotoReddit(page, url);
    const model = await extract(page, request);
    assertRedditPage(model);
    assertAccount(model, ctx);
    return model;
  }

  async function readListing(operation, ctx, { url, request }) {
    const page = ctx.page;
    const model = await load(page, url, request, ctx);
    return {
      data: { items: shapeItems(model.items), after: null },
      meta: listingMeta(model),
    };
  }

  async function read(operation, ctx = {}) {
    if (!operation || typeof operation !== 'object') throw new TypeError('An operation descriptor is required.');
    const tool = operation.tool;
    const args = operation.args ?? {};
    const page = ctx.page;
    if (!page) throw new TypeError('The browser read needs a page.');
    const unsupported = UNSUPPORTED_BROWSER_READS[tool];
    if (unsupported) {
      throw new OperationError('PARAMETER_UNSUPPORTED', unsupported.message, {
        safeDetails: { reason: unsupported.reason, tool },
      });
    }

    switch (tool) {
      case 'get_me': {
        const username = typeof ctx.account?.username === 'string' ? ctx.account.username : null;
        if (!username) {
          throw new OperationError('IDENTITY_UNVERIFIED', 'The browser session has no verified Reddit account for get_me.', {
            safeDetails: { reason: 'identity_unverified' },
          });
        }
        return {
          data: { name: username, linkKarma: null, commentKarma: null },
          meta: { completeness: 'partial', missingFields: ['linkKarma', 'commentKarma'] },
        };
      }

      case 'browse_subreddit': {
        checkSubreddit(args.subreddit);
        const sort = args.sort ?? 'hot';
        checkOneOf(sort, SORTS, 'Sort');
        if (args.time !== undefined) checkOneOf(args.time, TIME_RANGES, 'Time range');
        if (args.limit !== undefined) checkLimit(args.limit);
        const url = listingUrl(`/r/${args.subreddit}/${sort}/`, { time: args.time });
        const result = await readListing(operation, ctx, {
          url,
          request: { kind: 'listing', limit: args.limit ?? 25, sort, time: args.time ?? null },
        });
        if (args.includeInfo === true) {
          const infoModel = await load(ctx.page, `/r/${args.subreddit}/about/`, { kind: 'subreddit' }, ctx);
          const info = subredditInfo(infoModel, args.subreddit);
          result.data.info = info.data;
          result.meta = mergeMeta(result.meta, info.meta);
        }
        return result;
      }

      case 'get_top_posts': {
        checkSubreddit(args.subreddit);
        const time = args.time ?? 'day';
        checkOneOf(time, TIME_RANGES, 'Time range');
        if (args.limit !== undefined) checkLimit(args.limit);
        return await readListing(operation, ctx, {
          url: listingUrl(`/r/${args.subreddit}/top/`, { time }),
          request: { kind: 'listing', limit: args.limit ?? 25, sort: 'top', time },
        });
      }

      case 'get_subreddit_info': {
        checkSubreddit(args.subreddit);
        const model = await load(page, `/r/${args.subreddit}/about/`, { kind: 'subreddit' }, ctx);
        assertSubreddit(model, args.subreddit);
        return subredditInfo(model, args.subreddit);
      }

      case 'get_subreddit_rules': {
        checkSubreddit(args.subreddit);
        const model = await load(page, `/r/${args.subreddit}/about/rules/`, { kind: 'rules' }, ctx);
        assertSubreddit(model, args.subreddit);
        const rules = (Array.isArray(model.rules) ? model.rules : []).map((rule) => ({
          shortName: stringOrNull(rule?.shortName),
          description: stringOrNull(rule?.description),
          kind: stringOrNull(rule?.kind),
        }));
        return {
          data: rules,
          meta: {
            completeness: 'partial',
            missingFields: rules.some((rule) => rule.kind === null) ? ['kind'] : [],
          },
        };
      }

      case 'get_trending_subreddits': {
        if (args.limit !== undefined) checkLimit(args.limit);
        const model = await load(page, '/subreddits/popular/', { kind: 'listing', limit: args.limit ?? 5 }, ctx);
        const names = (Array.isArray(model.items) ? model.items : [])
          .map((item) => stringOrNull(item?.subreddit) ?? stringOrNull(item?.name))
          .filter((name) => name !== null);
        return {
          data: names,
          meta: { completeness: 'partial', missingFields: ['rank', 'trendMetric'] },
        };
      }

      case 'search_reddit': {
        if (args.sort !== undefined) checkOneOf(args.sort, SEARCH_SORTS, 'Search sort');
        if (args.time !== undefined) checkOneOf(args.time, TIME_RANGES, 'Time range');
        if (args.limit !== undefined) checkLimit(args.limit);
        if (args.subreddit !== undefined) checkSubreddit(args.subreddit);
        return await readListing(operation, ctx, {
          url: searchUrl(args),
          request: { kind: 'listing', limit: args.limit ?? 25, sort: args.sort ?? null, time: args.time ?? null },
        });
      }

      case 'get_reddit_post':
      case 'get_post_comments': {
        const id = String(args.id);
        const model = await load(page, postUrl(id, args), { kind: 'post', limit: args.limit ?? 100 }, ctx);
        assertCanonicalPost(model, id);
        const entry = model.entry ?? model.post ?? {};
        const comments = (Array.isArray(model.comments) ? model.comments : []).map(shapeComment);
        const missing = new Set();
        if (model.truncated === true || model.next) missing.add('commentTreeBeyondVisiblePage');
        if (comments.some((entryComment) => entryComment.score === null)) missing.add('score');
        missing.add('moreIds');
        const post = shapePost(entry);
        if (post.id === null) {
          throw new OperationError('STEP_STALE', 'The page did not expose a stable post id.', {
            safeDetails: { reason: 'target_unverified' },
          });
        }
        return {
          data: { post, comments, moreIds: [] },
          meta: { completeness: 'partial', missingFields: [...missing], continuationState: model.next ?? null },
        };
      }

      case 'get_user_info': {
        const model = await load(page, `/user/${args.username}/`, { kind: 'user' }, ctx);
        assertUser(model, args.username);
        return userInfo(model, args.username);
      }

      case 'get_user_posts':
      case 'get_user_comments': {
        const submitted = tool === 'get_user_posts';
        const options = args.options ?? {};
        const url = listingUrl(`/user/${args.username}/${submitted ? 'submitted' : 'comments'}/`, {
          sort: options.sort ?? 'new',
          time: options.time ?? 'all',
        });
        const model = await load(page, url, {
          kind: 'listing',
          limit: options.limit ?? 25,
          sort: options.sort ?? 'new',
          time: options.time ?? 'all',
        }, ctx);
        assertUser(model, args.username);
        return {
          data: { items: shapeItems(model.items), after: null },
          meta: listingMeta(model),
        };
      }

      case 'user_analysis': {
        const infoModel = await load(page, `/user/${args.username}/`, { kind: 'user' }, ctx);
        assertUser(infoModel, args.username);
        const account = userInfo(infoModel, args.username);
        const posts = await readListing(operation, ctx, {
          url: listingUrl(`/user/${args.username}/submitted/`, { sort: 'new', time: 'all' }),
          request: { kind: 'listing', limit: 100 },
        });
        const comments = await readListing(operation, ctx, {
          url: listingUrl(`/user/${args.username}/comments/`, { sort: 'new', time: 'all' }),
          request: { kind: 'listing', limit: 100 },
        });
        const counts = new Map();
        for (const item of [...posts.data.items, ...comments.data.items]) {
          if (typeof item.subreddit === 'string' && item.subreddit !== '') {
            counts.set(item.subreddit, (counts.get(item.subreddit) ?? 0) + 1);
          }
        }
        const activeSubreddits = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => ({ name, count }));
        return {
          data: {
            account: account.data,
            sampledPosts: posts.data.items.length,
            sampledComments: comments.data.items.length,
            activeSubreddits,
          },
          meta: {
            completeness: 'partial',
            missingFields: [...new Set([...account.meta.missingFields, 'sampleBounded', 'karmaHistory'])],
            sampled: true,
          },
        };
      }

      case 'get_my_overview': {
        const username = requireAccount(ctx);
        const options = args;
        const result = await readListing(operation, ctx, {
          url: listingUrl(`/user/${username}/`, { sort: options.sort, time: options.time }),
          request: { kind: 'listing', limit: options.limit ?? 25 },
        });
        return result;
      }

      case 'get_my_saved': {
        const username = requireAccount(ctx);
        return await readListing(operation, ctx, {
          url: `/user/${username}/saved/`,
          request: { kind: 'listing', limit: args.limit ?? 25 },
        });
      }

      case 'list_my_subreddits': {
        requireAccount(ctx);
        if (args.limit !== undefined) checkLimit(args.limit);
        const model = await load(page, '/subreddits/mine/', { kind: 'listing', limit: args.limit ?? 100 }, ctx);
        const names = (Array.isArray(model.items) ? model.items : [])
          .map((item) => stringOrNull(item?.subreddit) ?? stringOrNull(item?.name))
          .filter((name) => name !== null);
        return {
          data: names,
          meta: { completeness: 'partial', missingFields: ['privateSubreddits', 'subscriptionOrder'] },
        };
      }

      case 'test_reddit_mcp_server': {
        const checks = [];
        const username = typeof ctx.account?.username === 'string' ? ctx.account.username : null;
        checks.push({ name: 'account: verified session', ok: username !== null, detail: username ?? 'no verified account' });
        if (args.checkAccount !== false && username !== null) {
          try {
            const model = await load(page, '/subreddits/popular/', { kind: 'listing', limit: 1 }, ctx);
            const first = shapeItems(model.items)[0];
            checks.push({ name: 'read: popular subreddits', ok: true, detail: first?.subreddit ?? first?.name ?? 'none' });
          } catch (error) {
            checks.push({ name: 'read: popular subreddits', ok: false, detail: error.message });
          }
        }
        return {
          data: { authMode: 'browser', ok: checks.every((check) => check.ok), checks, elapsedMs: 0 },
          meta: { completeness: 'partial', missingFields: ['elapsedMs'] },
        };
      }

      default:
        throw new OperationError('UNSUPPORTED_OPERATION', `The browser backend does not implement ${tool}.`, {
          safeDetails: { tool },
        });
    }
  }

  function requireAccount(ctx) {
    const username = typeof ctx.account?.username === 'string' ? ctx.account.username : null;
    if (!username) {
      throw new OperationError('IDENTITY_UNVERIFIED', 'This read needs a verified signed-in account.', {
        safeDetails: { reason: 'identity_unverified' },
      });
    }
    return username;
  }

  return Object.freeze({
    tools: BROWSER_READ_TOOLS,
    supports(tool) {
      return BROWSER_READ_TOOLS.includes(tool);
    },
    read,
  });
}

function assertUser(model, username) {
  const shown = model?.user?.name;
  if (typeof shown === 'string' && shown !== '' && shown.toLowerCase() !== String(username).toLowerCase()) {
    throw new OperationError('STEP_STALE', 'The open page is not the requested user profile.', {
      safeDetails: { reason: 'target_changed' },
    });
  }
}

function subredditInfo(model, name) {
  const data = {
    name: stringOrNull(model?.subreddit?.name) ?? name,
    title: stringOrNull(model?.subreddit?.title),
    subscribers: numberOrNull(model?.subreddit?.subscribers),
    description: stringOrNull(model?.subreddit?.description),
  };
  return {
    data,
    meta: {
      completeness: 'partial',
      missingFields: SUBREDDIT_FIELDS.filter((field) => data[field] === null),
    },
  };
}

function userInfo(model, username) {
  const source = model?.user ?? {};
  const data = {
    name: stringOrNull(source.name) ?? username,
    id: stringOrNull(source.id),
    linkKarma: numberOrNull(source.linkKarma),
    commentKarma: numberOrNull(source.commentKarma),
    totalKarma: numberOrNull(source.totalKarma)
      ?? (numberOrNull(source.linkKarma) !== null && numberOrNull(source.commentKarma) !== null
        ? source.linkKarma + source.commentKarma
        : null),
    isMod: typeof source.isMod === 'boolean' ? source.isMod : null,
    isGold: typeof source.isGold === 'boolean' ? source.isGold : null,
    isEmployee: typeof source.isEmployee === 'boolean' ? source.isEmployee : null,
    createdUtc: numberOrNull(source.createdUtc),
  };
  return {
    data,
    meta: {
      completeness: 'partial',
      missingFields: USER_FIELDS.filter((field) => data[field] === null),
    },
  };
}

function mergeMeta(meta, extra) {
  return {
    ...meta,
    completeness: 'partial',
    missingFields: [...new Set([...(meta.missingFields ?? []), ...(extra.missingFields ?? [])])],
  };
}
