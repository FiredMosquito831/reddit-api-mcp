// Public Atom feeds: no client ID, read-only, and reduced (no scores or comment counts).
// jordanburke's and karanb192's projects both use these as a fallback. Reddit may throttle them per IP.
const BASE = 'https://www.reddit.com';
const SORTS = ['hot', 'new', 'top', 'rising', 'controversial'];
const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;

export function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" stays "&lt;"
}

function tagText(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return match ? decodeEntities(match[1].trim()) : null;
}

// Title, link, author, and time from each <entry> of an Atom feed.
export function parseAtomEntries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, block]) => {
    const id = tagText(block, 'id');
    const link = /<link[^>]*\bhref="([^"]+)"/.exec(block);
    const author = /<author>\s*<name>([\s\S]*?)<\/name>/.exec(block);
    return {
      fullname: id && /^t3_[a-z0-9]+$/i.test(id) ? id : null,
      title: tagText(block, 'title'),
      author: author ? decodeEntities(author[1].trim()).replace(/^\/?u\//, '') : null,
      url: link ? decodeEntities(link[1]) : null,
      updated: tagText(block, 'updated'),
    };
  });
}

export async function browseSubredditRss({
  subreddit,
  sort = 'hot',
  limit = 25,
  fetch = globalThis.fetch,
  userAgent,
}) {
  if (!SUBREDDIT_RE.test(subreddit ?? '')) throw new Error(`Not a valid subreddit name: ${subreddit}`);
  if (!SORTS.includes(sort)) throw new Error(`Sort must be one of: ${SORTS.join(', ')}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be between 1 and 100.');
  const url = new URL(`/r/${subreddit}/${sort}/.rss`, BASE);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, { headers: { accept: 'application/atom+xml', 'user-agent': userAgent } });
  if (res.status === 429) throw new Error('Reddit is throttling public feed requests. Wait a minute, then try again.');
  if (!res.ok) throw new Error(`Public feed request failed (HTTP ${res.status}).`);
  const xml = await res.text();
  if (!xml.includes('<feed')) throw new Error('Reddit did not return an Atom feed. The request may have been blocked.');
  return parseAtomEntries(xml).slice(0, limit);
}
