// Offline definitions for common Reddit terms. Ported from karanb192/reddit-mcp-buddy's glossary tool.
export const GLOSSARY = {
  karma: 'Points earned from upvotes: link karma from posts and comment karma from comments. Total karma is the sum.',
  'cake day': 'The anniversary of the day an account was created.',
  ama: '"Ask Me Anything": a post where a guest answers questions from the community, usually in the comments.',
  eli5: '"Explain Like I\'m Five": a request for a simple explanation of something complicated.',
  op: '"Original poster": the person who submitted the post.',
  til: '"Today I Learned": a post that shares a fact the poster just learned.',
  upvote: 'A vote that raises a post or comment in the ranking. Each account casts one vote per item.',
  downvote: 'A vote that lowers a post or comment in the ranking.',
  subreddit: 'A community on Reddit, written r/name.',
  flair: 'A label. Link flair marks a post; user flair marks a member within one subreddit.',
  mod: "Short for moderator: a volunteer who enforces a subreddit's rules.",
  nsfw: '"Not safe for work": marks adult content.',
  spoiler: 'Hides details, such as a plot point or a result, until a reader chooses to reveal them.',
  crosspost: 'A post shared from one subreddit into another.',
  megathread: 'A single thread that collects discussion of one big event.',
  stickied: 'Pinned to the top of a subreddit by its moderators.',
  quarantine: 'A restriction Reddit places on a community. It hides the community until a user opts in.',
};

export function lookupTerm(term) {
  const key = String(term ?? '').trim().toLowerCase();
  return { term: key, definition: GLOSSARY[key] ?? null };
}
