#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { VERSION, loadConfig } from './config.js';
import { createAuthorizeUrl, exchangeCode, parseRedirectUrl, revokeToken } from './oauth.js';
import { lookupTerm } from './glossary.js';
import { browseSubredditRss } from './rss.js';
import { SCOPE_CATALOG } from './scopes.js';
import { openSession } from './session.js';
import { createKeyringStore } from './store.js';

async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('This step needs an interactive terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Writes ask first unless --yes is given, so scripts have to pass --yes explicitly.
async function confirm(message, options) {
  if (options.yes) return;
  let answer;
  try {
    answer = await ask(`${message} [y/N] `);
  } catch {
    throw new Error('Confirmation needed: run in a terminal, or pass --yes.');
  }
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Cancelled.');
}

function printPlan(plan) {
  console.log('Dry run: nothing was sent.');
  console.log(JSON.stringify(plan, null, 2));
}

function toFields(pairs) {
  return Object.fromEntries(pairs.map((pair) => {
    const index = pair.indexOf('=');
    if (index < 1) throw new Error(`Expected key=value, got: ${pair}`);
    return [pair.slice(0, index), pair.slice(index + 1)];
  }));
}

// One line per listing item, then the cursor for the next page when there is one.
function printListing({ items, after }) {
  for (const item of items) {
    if (item.kind === 't1') {
      console.log(`${String(item.score).padStart(6)}  ${item.fullname.padEnd(10)}  ${item.body.replace(/\s+/g, ' ').slice(0, 100)}`);
    } else if (item.kind === 't3') {
      console.log(`${String(item.score).padStart(6)}  ${item.fullname.padEnd(10)}  ${item.title}`);
    } else {
      console.log(`${item.kind}  ${item.name ?? item.fullname ?? ''}`);
    }
  }
  if (after && items.length > 0) console.log(`\nNext page: --after ${after}`);
}

const collect = (value, previous) => [...previous, value];
const kindOf = (fullname) => String(fullname ?? '').split('_')[0];

function addWriteOptions(command) {
  return command
    .option('--yes', 'skip the confirmation prompt')
    .option('--dry-run', 'print what would be sent and exit');
}

const program = new Command()
  .name('reddit-cli')
  .description('Control your own Reddit account through the official OAuth API.')
  .version(VERSION);

program
  .command('login')
  .description('Authorize this CLI for your account; the refresh token goes to the OS keychain')
  .action(async () => {
    const config = loadConfig();
    if (config.authMode === 'app') {
      console.log('App mode (REDDIT_AUTH_MODE=app) needs no login. It is read-only.');
      return;
    }
    if (config.authMode === 'password') {
      const me = await openSession(config).actions.whoami();
      console.log(`Password mode: u/${me.name} is reachable with REDDIT_PASSWORD. Nothing was stored.`);
      return;
    }
    const state = randomBytes(16).toString('hex');
    console.log(`1. Open this URL while signed in as u/${config.username}:\n`);
    console.log(createAuthorizeUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      state,
    }));
    console.log('\n2. Approve access. The browser then lands on the redirect URI; an error page there is expected.');
    const pasted = await ask('3. Paste the full address from the browser bar: ');
    const code = parseRedirectUrl(pasted, state);
    const tokens = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      userAgent: config.userAgent,
      redirectUri: config.redirectUri,
      code,
    });
    if (!tokens.refreshToken) {
      throw new Error('Reddit returned no refresh token. Check that the authorize URL included duration=permanent.');
    }

    const { store, actions } = openSession(config);
    await store.setRefreshToken(tokens.refreshToken);
    const me = await actions.whoami();
    if (me.name.toLowerCase() !== config.username.toLowerCase()) {
      await store.clear();
      throw new Error(
        `You authorized u/${me.name}, but REDDIT_USERNAME is ${config.username}. The stored token was removed.`,
      );
    }
    console.log(`Logged in as u/${me.name}. Granted scopes: ${tokens.scopes.join(', ')}`);
  });

program
  .command('logout')
  .description('Revoke the stored token and remove it from the keychain')
  .action(async () => {
    const config = loadConfig();
    if (config.authMode !== 'oauth') {
      console.log('This mode stores nothing, so there is nothing to remove.');
      return;
    }
    const store = createKeyringStore(config.username);
    const refreshToken = await store.getRefreshToken();
    if (refreshToken) {
      await revokeToken({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        userAgent: config.userAgent,
        refreshToken,
      });
    }
    await store.clear();
    console.log('Logged out.');
  });

program
  .command('whoami')
  .description('Show the account the stored token belongs to (get_me)')
  .action(async () => {
    const { actions } = openSession(loadConfig());
    const me = await actions.whoami();
    console.log(`u/${me.name}  link karma ${me.linkKarma}  comment karma ${me.commentKarma}`);
  });

program
  .command('scopes')
  .description('List every OAuth scope, which ones login requests, and why the others are left out')
  .action(() => {
    for (const scope of SCOPE_CATALOG) {
      console.log(`${scope.requested ? 'requested' : 'omitted  '}  ${scope.name.padEnd(17)}  ${scope.why}`);
    }
  });

// ---- Reads ----

program
  .command('feed <subreddit>')
  .description('List posts in a subreddit (browse_subreddit)')
  .option('--sort <sort>', 'hot, new, top, rising, or controversial', 'hot')
  .option('--time <range>', 'hour, day, week, month, year, or all (for top and controversial)')
  .option('--limit <n>', 'posts per page, 1-100', '10')
  .option('--info', 'also show the subreddit details first')
  .option('--after <cursor>', 'continue from the cursor printed at the end of the last page')
  .action(async (subreddit, options) => {
    const { actions } = openSession(loadConfig());
    const page = await actions.feed({
      subreddit,
      sort: options.sort,
      time: options.time,
      limit: Number(options.limit),
      after: options.after,
      includeInfo: Boolean(options.info),
    });
    if (page.info) console.log(`r/${page.info.name}: ${page.info.subscribers} subscribers. ${page.info.title}`);
    printListing(page);
  });

program
  .command('top <subreddit>')
  .description('Top posts in a subreddit for a time range (get_top_posts)')
  .option('--time <range>', 'hour, day, week, month, year, or all', 'day')
  .option('--limit <n>', 'posts per page, 1-100', '10')
  .option('--after <cursor>', 'continue from a previous page')
  .action(async (subreddit, options) => {
    const { actions } = openSession(loadConfig());
    printListing(await actions.topPosts({
      subreddit,
      time: options.time,
      limit: Number(options.limit),
      after: options.after,
    }));
  });

program
  .command('subreddit <name>')
  .description("Show a subreddit's size and description (get_subreddit_info)")
  .action(async (name) => {
    const { actions } = openSession(loadConfig());
    const info = await actions.subreddit(name);
    console.log(`r/${info.name}: ${info.subscribers} subscribers`);
    console.log(info.title);
    if (info.description) console.log(info.description);
  });

program
  .command('rules <subreddit>')
  .description('Show the rules of a subreddit (get_subreddit_rules)')
  .action(async (subreddit) => {
    const { actions } = openSession(loadConfig());
    for (const rule of await actions.rules(subreddit)) console.log(`- ${rule.shortName}: ${rule.description}`);
  });

program
  .command('flairs <subreddit>')
  .description('List the post flairs a subreddit offers (get_post_flairs)')
  .action(async (subreddit) => {
    const { actions } = openSession(loadConfig());
    for (const flair of await actions.flairs(subreddit)) console.log(`${flair.id}  ${flair.text}`);
  });

program
  .command('popular')
  .description("Popular subreddits, Reddit's closest public list to trending (get_trending_subreddits)")
  .option('--limit <n>', 'how many, 1-100', '5')
  .action(async (options) => {
    const { actions } = openSession(loadConfig());
    for (const name of await actions.popular({ limit: Number(options.limit) })) console.log(`r/${name}`);
  });

program
  .command('search [query...]')
  .description('Search posts across Reddit or inside one subreddit (search_reddit)')
  .option('--subreddit <name>', 'limit the search to one subreddit')
  .option('--sort <sort>', 'relevance, hot, top, new, or comments', 'relevance')
  .option('--time <range>', 'hour, day, week, month, year, or all', 'all')
  .option('--type <type>', 'link, sr, or user', 'link')
  .option('--author <name>', 'only posts by this user')
  .option('--flair <text>', 'only posts with this flair')
  .option('--limit <n>', 'results per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page')
  .action(async (words, options) => {
    const { actions } = openSession(loadConfig());
    printListing(await actions.search({
      query: (words ?? []).join(' '),
      author: options.author,
      flair: options.flair,
      subreddit: options.subreddit,
      sort: options.sort,
      time: options.time,
      type: options.type,
      limit: Number(options.limit),
      after: options.after,
    }));
  });

program
  .command('thread <id>')
  .description('A post and its comments (get_reddit_post and get_post_comments)')
  .option('--subreddit <name>', 'the subreddit the post is in (speeds up the lookup)')
  .option('--sort <sort>', 'confidence, top, new, controversial, old, or qa', 'confidence')
  .option('--limit <n>', 'comments to fetch, 1-500', '100')
  .option('--depth <n>', 'comment depth, 1-10')
  .action(async (id, options) => {
    const { actions } = openSession(loadConfig());
    const page = await actions.readPost({
      id,
      subreddit: options.subreddit,
      sort: options.sort,
      limit: Number(options.limit),
      depth: options.depth === undefined ? undefined : Number(options.depth),
    });
    console.log(JSON.stringify(page, null, 2));
  });

program
  .command('more <postFullname> <commentIds...>')
  .description('Expand "load more" comment ids from a thread (get_more_comments)')
  .action(async (postFullname, commentIds) => {
    const { actions } = openSession(loadConfig());
    const comments = await actions.moreComments({ postFullname, childIds: commentIds });
    console.log(JSON.stringify(comments, null, 2));
  });

program
  .command('user <name>')
  .description("A Reddit user's karma and account details (get_user_info)")
  .action(async (name) => {
    const { actions } = openSession(loadConfig());
    console.log(JSON.stringify(await actions.userInfo(name), null, 2));
  });

for (const [command, description, method] of [
  ['user-posts <name>', 'Posts by a user (get_user_posts)', 'userPosts'],
  ['user-comments <name>', 'Comments by a user (get_user_comments)', 'userComments'],
]) {
  program
    .command(command)
    .description(description)
    .option('--sort <sort>', 'hot, new, top, or controversial', 'new')
    .option('--time <range>', 'hour, day, week, month, year, or all', 'all')
    .option('--limit <n>', 'items per page, 1-100', '25')
    .option('--after <cursor>', 'continue from a previous page')
    .action(async (name, options) => {
      const { actions } = openSession(loadConfig());
      printListing(await actions[method](name, {
        sort: options.sort,
        time: options.time,
        limit: Number(options.limit),
        after: options.after,
      }));
    });
}

program
  .command('overview')
  .description('Your own posts and comments, newest first (get_my_overview; needs history)')
  .option('--limit <n>', 'items per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page')
  .action(async (options) => {
    const { actions } = openSession(loadConfig());
    printListing(await actions.overview({ limit: Number(options.limit), after: options.after }));
  });

program
  .command('saved')
  .description('Your saved posts and comments (get_my_saved; needs history)')
  .option('--limit <n>', 'items per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page')
  .action(async (options) => {
    const { actions } = openSession(loadConfig());
    printListing(await actions.saved({ limit: Number(options.limit), after: options.after }));
  });

program
  .command('mine')
  .description('List the subreddits you have joined (list_my_subreddits)')
  .action(async () => {
    const { actions } = openSession(loadConfig());
    for (const name of await actions.mySubscriptions()) console.log(`r/${name}`);
  });

program
  .command('rss <subreddit>')
  .description('Browse a public feed with no client ID needed. Read-only, no scores; Reddit may throttle it')
  .option('--sort <sort>', 'hot, new, top, rising, or controversial', 'hot')
  .option('--limit <n>', 'posts, 1-100', '25')
  .action(async (subreddit, options) => {
    const entries = await browseSubredditRss({
      subreddit,
      sort: options.sort,
      limit: Number(options.limit),
      userAgent: `node:reddit-cli:${VERSION}`,
    });
    for (const entry of entries) {
      console.log(`${(entry.fullname ?? '').padEnd(10)}  ${entry.title}  (u/${entry.author ?? '?'})`);
    }
  });

program
  .command('explain <term>')
  .description('Plain-language meaning of a Reddit term, such as karma or AMA (reddit_explain). Offline.')
  .action((term) => {
    const { definition } = lookupTerm(term);
    console.log(definition ?? `No entry for "${term}". Try karma, cake day, AMA, ELI5, OP, TIL, flair, or mod.`);
  });

program
  .command('activity <name>')
  .description('A user summary: karma, recent posts and comments, and where they are active (user_analysis)')
  .action(async (name) => {
    const { actions } = openSession(loadConfig());
    console.log(JSON.stringify(await actions.userActivity(name), null, 2));
  });

program
  .command('test')
  .description('Checks the configuration end to end (test_reddit_mcp_server)')
  .action(async () => {
    const { actions } = openSession(loadConfig());
    const report = await actions.selfTest();
    for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
    console.log(report.ok ? `All checks passed in ${report.elapsedMs} ms.` : 'Some checks failed.');
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('token')
  .description('Print the stored refresh token, for the Claude Desktop extension. It is a secret: anyone with it can act as your account')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (options) => {
    const config = loadConfig();
    if (config.authMode !== 'oauth') throw new Error('Only oauth mode has a refresh token.');
    const token = config.refreshToken || (await createKeyringStore(config.username).getRefreshToken());
    if (!token) throw new Error('No refresh token is stored. Run "reddit-cli login" first.');
    await confirm('Print the refresh token to this terminal? Anyone with it can act as your account.', options);
    console.log(token);
  });

// ---- Writes. Each asks first unless --yes is given. ----

addWriteOptions(program
  .command('post <subreddit>')
  .description('Submit a text or link post (create_post)')
  .requiredOption('--title <title>', 'post title')
  .option('--text <text>', 'body of a text post')
  .option('--url <url>', 'link for a link post'))
  .action(async (subreddit, options) => {
    const input = { subreddit, title: options.title, text: options.text, url: options.url };
    if (options.dryRun) return printPlan({ action: 'submit', ...input });
    const config = loadConfig();
    await confirm(`Submit this post to r/${subreddit} as u/${config.username}?`, options);
    const result = await openSession(config).actions.submitPost(input);
    console.log(result.url ? `Posted: ${result.url}` : 'Posted.');
  });

addWriteOptions(program
  .command('comment <parent>')
  .description('Reply to a post (t3_...) or to a comment (t1_...) (reply_to_post)')
  .requiredOption('--text <text>', 'comment body'))
  .action(async (parent, options) => {
    const input = { parent, text: options.text };
    if (options.dryRun) return printPlan({ action: 'comment', ...input });
    const config = loadConfig();
    await confirm(`Reply to ${parent} as u/${config.username}?`, options);
    const result = await openSession(config).actions.comment(input);
    const permalink = result.things?.[0]?.data?.permalink;
    console.log(permalink ? `Commented: https://www.reddit.com${permalink}` : 'Commented.');
  });

addWriteOptions(program
  .command('edit <fullname>')
  .description('Replace the text of your own post (t3_...) or comment (t1_...) (edit_post, edit_comment)')
  .requiredOption('--text <text>', 'the new text'))
  .action(async (fullname, options) => {
    const input = { fullname, text: options.text, kind: kindOf(fullname) };
    if (options.dryRun) return printPlan({ action: 'edit', ...input });
    const config = loadConfig();
    await confirm(`Replace the text of ${fullname} as u/${config.username}?`, options);
    await openSession(config).actions.editText(input);
    console.log(`Edited ${fullname}.`);
  });

addWriteOptions(program
  .command('delete <fullname>')
  .description('Delete your own post (t3_...) or comment (t1_...). This cannot be undone (delete_post, delete_comment)'))
  .action(async (fullname, options) => {
    const input = { fullname, kind: kindOf(fullname) };
    if (options.dryRun) return printPlan({ action: 'delete', ...input });
    const config = loadConfig();
    await confirm(`Permanently delete ${fullname} as u/${config.username}? This cannot be undone.`, options);
    await openSession(config).actions.deleteThing(input);
    console.log(`Deleted ${fullname}.`);
  });

addWriteOptions(program
  .command('vote <fullname> <direction>')
  .description('Upvote, downvote, or clear your vote on one post or comment: up | down | clear (vote_on_thing)'))
  .action(async (fullname, direction, options) => {
    const input = { fullname, direction };
    if (options.dryRun) return printPlan({ action: 'vote', ...input });
    const config = loadConfig();
    await confirm(`Set your vote on ${fullname} to ${direction}?`, options);
    await openSession(config).actions.vote(input);
    console.log(`Vote on ${fullname} set to ${direction}.`);
  });

addWriteOptions(program
  .command('subscribe <subreddit>')
  .description('Join a subreddit (subscribe_to_subreddit)'))
  .action(async (subreddit, options) => {
    if (options.dryRun) return printPlan({ action: 'subscribe', subreddit });
    const config = loadConfig();
    await confirm(`Join r/${subreddit} as u/${config.username}?`, options);
    await openSession(config).actions.subscribe({ subreddit, subscribe: true });
    console.log(`Joined r/${subreddit}.`);
  });

addWriteOptions(program
  .command('unsubscribe <subreddit>')
  .description('Leave a subreddit (unsubscribe_from_subreddit)'))
  .action(async (subreddit, options) => {
    if (options.dryRun) return printPlan({ action: 'unsubscribe', subreddit });
    const config = loadConfig();
    await confirm(`Leave r/${subreddit} as u/${config.username}?`, options);
    await openSession(config).actions.subscribe({ subreddit, subscribe: false });
    console.log(`Left r/${subreddit}.`);
  });

addWriteOptions(program
  .command('save <fullname>')
  .description('Save a post or comment to your account (save_content)'))
  .action(async (fullname, options) => {
    if (options.dryRun) return printPlan({ action: 'save', fullname });
    const config = loadConfig();
    await confirm(`Save ${fullname} to u/${config.username}?`, options);
    await openSession(config).actions.save({ fullname });
    console.log(`Saved ${fullname}.`);
  });

addWriteOptions(program
  .command('unsave <fullname>')
  .description('Remove a post or comment from your saved items (unsave_content)'))
  .action(async (fullname, options) => {
    if (options.dryRun) return printPlan({ action: 'unsave', fullname });
    const config = loadConfig();
    await confirm(`Unsave ${fullname} from u/${config.username}?`, options);
    await openSession(config).actions.save({ fullname, undo: true });
    console.log(`Unsaved ${fullname}.`);
  });

addWriteOptions(program
  .command('api <method> <path>')
  .description('Send any authenticated GET or POST, e.g. api GET /api/v1/me')
  .option('-f, --field <key=value>', 'form field for POST, query parameter for GET (repeatable)', collect, []))
  .action(async (method, path, options) => {
    if (!path.startsWith('/')) {
      throw new Error(
        'Paths must start with "/", for example /api/v1/me. In Git Bash, prefix the command with MSYS_NO_PATHCONV=1 so the path is not rewritten.',
      );
    }
    const verb = method.toUpperCase();
    const fields = toFields(options.field);
    if (options.dryRun) return printPlan({ method: verb, path, fields });
    const config = loadConfig();
    if (verb === 'POST') await confirm(`Send POST ${path} as u/${config.username}?`, options);
    const result = await openSession(config).actions.raw({ method: verb, path, fields });
    console.log(JSON.stringify(result, null, 2));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
