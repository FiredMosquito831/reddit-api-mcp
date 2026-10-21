// Synthetic extracted page models for browser-adapter tests. Each builder returns a plain object: the
// shape src/browser/adapters/*.js receives from the bounded in-page extractor. Field names follow what
// the rendered UI can expose (roles, labels, visible counts), and anything the UI cannot observe is
// simply absent so adapters must disclose it instead of inventing a value.

export function post({ id, title = 'A post', author = 'someone', subreddit = 'test', score, comments, permalink, body = '', createdUtc } = {}) {
  return {
    kind: 't3',
    id,
    title,
    author,
    subreddit,
    score,
    comments,
    permalink: permalink ?? `/r/${subreddit}/comments/${id}/a_post/`,
    body,
    createdUtc,
  };
}

export function comment({ id, parentId, author = 'someone', body = 'a comment', score, depth = 0, permalink } = {}) {
  return {
    kind: 't1',
    id,
    parentId,
    author,
    body,
    score,
    depth,
    permalink: permalink ?? `/r/test/comments/abc123/a_post/${id}/`,
  };
}

export function listingModel({ url = 'https://www.reddit.com/r/test/', items = [], next = null, truncated = false, canonicalId, subreddit, security = null, account = null, elements = [] } = {}) {
  return {
    kind: 'listing',
    url,
    title: 'listing',
    items,
    next,
    truncated,
    security,
    account,
    canonicalId: canonicalId ?? null,
    subreddit: subreddit ?? null,
    elements,
  };
}

export function postModel({ url = 'https://www.reddit.com/r/test/comments/abc123/a_post/', entry = post({ id: 'abc123' }), canonicalId, comments = [], next = null, truncated = false, security = null, account = null, controls = {}, elements = [] } = {}) {
  const postId = canonicalId === undefined ? (entry.id ?? null) : canonicalId;
  return {
    kind: 'post',
    url,
    title: entry.title ?? 'post',
    entry,
    comments,
    next,
    truncated,
    security,
    account,
    canonicalId: postId,
    controls: {
      ...(postId === null ? {} : {
        focus: {
          id: postId,
          author: entry.author ?? null,
          body: entry.body ?? '',
          permalink: entry.permalink ?? null,
          postId,
        },
      }),
      ...controls,
    },
    // Post-page controls belong to the post's own element. A test that wants a comment's same-labeled
    // control sets scopeId explicitly; the adapters must never fall back to it.
    elements: elements.map((element) => (element.scopeId === undefined && postId !== null
      ? { ...element, scopeId: postId }
      : element)),
  };
}

export function subredditModel({ url = 'https://www.reddit.com/r/test/', name = 'test', info = {}, rules = [], items = [], security = null, account = null, controls = {}, elements = [] } = {}) {
  return {
    kind: 'subreddit',
    url,
    title: name,
    subreddit: { name, ...info },
    rules,
    items,
    security,
    account,
    canonicalId: null,
    controls: { subreddit: name, ...controls },
    elements,
  };
}

export function userModel({ url = 'https://www.reddit.com/user/someone/', name = 'someone', info = {}, items = [], subscriptions = [], security = null, account = null, elements = [] } = {}) {
  return {
    kind: 'user',
    url,
    title: name,
    user: { name, ...info },
    items,
    subscriptions,
    security,
    account,
    canonicalId: null,
    elements,
  };
}

export function securityModel(screen, { url = 'https://www.reddit.com/login/' } = {}) {
  return { kind: 'page', url, title: 'Sign in', security: screen, items: [], elements: [] };
}

export default {
  post,
  comment,
  listingModel,
  postModel,
  subredditModel,
  userModel,
  securityModel,
};
