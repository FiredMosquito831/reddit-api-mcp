// Every Reddit OAuth scope this project knows about. `requested` marks what login asks Reddit for.
// Each scope we leave out is listed with the reason, so nothing is dropped silently.
// Names come from PRAW's source, plus `creddits` from Reddit's public scope list.
export const SCOPE_CATALOG = [
  { name: 'identity', requested: true, why: 'whoami and get_me' },
  { name: 'read', requested: true, why: 'feeds, posts, comments, search, users, rules, flairs, popular subreddits' },
  { name: 'history', requested: true, why: 'saved items and your own overview' },
  { name: 'mysubreddits', requested: true, why: 'list the subreddits you have joined' },
  { name: 'subscribe', requested: true, why: 'join and leave subreddits' },
  { name: 'vote', requested: true, why: 'vote on one post or comment per command' },
  { name: 'submit', requested: true, why: 'create posts and comments' },
  { name: 'edit', requested: true, why: 'edit and delete your own posts and comments' },
  { name: 'save', requested: true, why: 'save and unsave posts and comments' },
  { name: 'creddits', requested: false, why: 'spends Reddit coins; no feature needs it' },
  { name: 'flair', requested: false, why: 'changes your user flair; no feature needs it' },
  { name: 'livemanage', requested: false, why: 'manages live threads; no feature needs it' },
  { name: 'modconfig', requested: false, why: 'moderator settings; this project does no moderation' },
  { name: 'modcontributors', requested: false, why: 'moderator contributor management; not used' },
  { name: 'modflair', requested: false, why: 'moderator flair tools; not used' },
  { name: 'modlog', requested: false, why: 'moderation log; not used' },
  { name: 'modmail', requested: false, why: 'moderator inbox; not used' },
  { name: 'modothers', requested: false, why: 'moderator actions on other users; not used' },
  { name: 'modposts', requested: false, why: 'moderator post actions; not used' },
  { name: 'modself', requested: false, why: 'moderator self-management; not used' },
  { name: 'modwiki', requested: false, why: 'moderator wiki tools; not used' },
  { name: 'privatemessages', requested: false, why: 'direct messages; excluded on purpose, as jordanburke does' },
  { name: 'report', requested: false, why: 'filing reports can be used for brigading; no feature needs it' },
  { name: 'structuredstyles', requested: false, why: 'subreddit styling; not used' },
  { name: 'wikiedit', requested: false, why: 'editing wiki pages; not used' },
  { name: 'wikiread', requested: false, why: 'reading wiki pages; not used yet' },
];

export const REQUESTED_SCOPES = SCOPE_CATALOG.filter((scope) => scope.requested).map((scope) => scope.name);
