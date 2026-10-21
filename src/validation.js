// Shared, backend-independent input validation. The rules and error messages here are the ones the
// existing actions have always used; they were moved out of src/actions.js unchanged so that the
// operation dispatcher can validate before any backend work starts. Keep action outputs unchanged.

const v = {
  SUBREDDIT_RE: /^[A-Za-z0-9_]{2,21}$/,
  USERNAME_RE: /^[A-Za-z0-9_-]{3,20}$/,
  FULLNAME_RE: /^t[1-6]_[a-z0-9]+$/i,
  POST_FULLNAME_RE: /^t3_[a-z0-9]+$/i,
  COMMENT_FULLNAME_RE: /^t1_[a-z0-9]+$/i,
  POST_OR_COMMENT_RE: /^t[13]_[a-z0-9]+$/i,
};

export const SUBREDDIT_RE = v.SUBREDDIT_RE;
export const USERNAME_RE = v.USERNAME_RE;
export const FULLNAME_RE = v.FULLNAME_RE;
export const POST_FULLNAME_RE = v.POST_FULLNAME_RE;
export const COMMENT_FULLNAME_RE = v.COMMENT_FULLNAME_RE;
export const POST_OR_COMMENT_RE = v.POST_OR_COMMENT_RE;

export const SORTS = Object.freeze(['hot', 'new', 'top', 'rising', 'controversial']);
export const LISTING_SORTS = Object.freeze(['hot', 'new', 'top', 'controversial']);
export const COMMENT_SORTS = Object.freeze(['confidence', 'top', 'new', 'controversial', 'old', 'qa']);
export const SEARCH_SORTS = Object.freeze(['relevance', 'hot', 'top', 'new', 'comments']);
export const SEARCH_TYPES = Object.freeze(['link', 'sr', 'user']);
export const TIME_RANGES = Object.freeze(['hour', 'day', 'week', 'month', 'year', 'all']);
export const VOTE_DIRECTIONS = Object.freeze({ up: 1, down: -1, clear: 0 });

export function checkSubreddit(name) {
  if (!SUBREDDIT_RE.test(name ?? '')) throw new Error(`Not a valid subreddit name: ${name}`);
  return name;
}

export function checkUsername(name) {
  if (!USERNAME_RE.test(name ?? '')) throw new Error(`Not a valid Reddit username: ${name}`);
  return name;
}

export function checkFullname(value, pattern = FULLNAME_RE) {
  if (!pattern.test(value ?? '')) throw new Error(`Expected a Reddit fullname such as t3_abc123, got: ${value}`);
  return value;
}

export function checkOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

export function checkLimit(limit, max = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new Error(`Limit must be between 1 and ${max}.`);
  return limit;
}

// Accepts "t3_abc123", "t1_abc123", or a bare id such as "abc123".
export function bareId(value) {
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

// A post reference in any accepted form (fullname, bare id, or link) reduced to its id.
export function checkPostId(value) {
  const ref = parsePostRef(value);
  if (ref) return ref.id;
  return bareId(value).toLowerCase();
}

// Canonical fullname for a post reference, used for targets and identity bindings.
export function checkPostFullname(value) {
  return `t3_${checkPostId(value)}`;
}

export function checkVoteDirection(direction) {
  if (!Object.hasOwn(VOTE_DIRECTIONS, direction)) throw new Error('Direction must be up, down, or clear.');
  return direction;
}

// A listing cursor is opaque; only its type is checked, and empty values are treated as absent.
export function checkCursor(value) {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error('The after cursor must be a non-empty string.');
  }
  return value;
}

export function checkHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('URL must be an absolute http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must be an absolute http or https URL.');
  }
  return String(value);
}
