#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { VERSION, loadConfig } from './config.js';
import { DEFAULT_SCOPES, createAuthorizeUrl, exchangeCode, parseRedirectUrl, revokeToken } from './oauth.js';
import { lookupTerm } from './glossary.js';
import { SCOPE_CATALOG } from './scopes.js';
import { openApiSession, openSession } from './session.js';
import { createKeyringStore } from './store.js';
import {
  addBackendOptions,
  addProfileCommands,
  createCliServices,
  executeCliRead,
  executeCliRaw,
  executeCliWrite,
  logoutProfile,
} from './cli-profiles.js';
import { addBrowserCommands } from './cli-browser.js';

async function ask(question) {
  if (!process.stdin.isTTY) throw new Error('This step needs an interactive terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

// Reads a secret one character at a time with no echo. The value never appears in argv, the
// environment, the transcript, or a child process. Returns only what the caller asked for.
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('This step needs an interactive terminal.'));
      return;
    }
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';
    let escapeSequence = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // Raw mode may already be off.
      }
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        // Arrow keys and other escape sequences are not part of a credential.
        if (escapeSequence) {
          if (/[A-Za-z~]/.test(character)) escapeSequence = false;
          continue;
        }
        if (character === '\u001b') {
          escapeSequence = true;
          continue;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdout.write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// The trusted local prompt. It is reached only after the caller printed the exact action, target,
// and risks. Nothing here can be supplied by a model, a tool argument, or --yes.
async function promptApproval() {
  const answer = await ask('Approve this local action? [y/N] ');
  return /^y(es)?$/i.test(answer.trim());
}

const services = createCliServices({ env: process.env });
const deps = {
  services: () => services.get(),
  settings: () => services.settings(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  interactive: () => process.stdin.isTTY === true,
  askText: ask,
  askHidden,
  promptApproval,
  revokeToken: (options) => revokeToken(options),
};

// Writes ask first only when policy (or --confirm) requires it; --yes is kept for compatibility and
// never satisfies that requirement.
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
function printListing({ items, after } = { items: [], after: null }) {
  for (const item of items ?? []) {
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
    .option('--yes', 'accepted for compatibility; it never satisfies a stored or requested confirmation')
    .option('--confirm', 'require a trusted local confirmation for this one action')
    .option('--dry-run', 'print what would be sent and exit');
}

// Reads share one dispatcher path. Default output keeps the existing printed shape; --json prints
// the full structured envelope (data plus backend/profile/completeness metadata).
async function read(tool, args, options, printer) {
  const result = await executeCliRead(deps, {
    tool,
    args,
    profile: options.profile ?? null,
    backend: options.backend ?? null,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (printer) printer(result.data);
  return result;
}

async function writeCli(tool, args, options, printer, plan) {
  if (options.dryRun) return printPlan(plan);
  const result = await executeCliWrite(deps, {
    tool,
    args,
    profile: options.profile ?? null,
    backend: options.backend ?? null,
    confirm: options.confirm === true,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (printer) printer(result.data);
  return result;
}

const program = new Command()
  .name('reddit-cli')
  .description('Control your own Reddit account through the official OAuth API, or a dedicated local browser profile.')
  .version(VERSION);

addProfileCommands(program, deps);
addBrowserCommands(program, deps);

program
  .command('login')
  .description('Authorize this CLI for your account; the refresh token goes to the OS keychain')
  .option('--profile <name>', 'store the grant in this named profile instead of the environment keychain entry')
  .action(async (options) => {
    if (options.profile !== undefined) {
      await loginProfile(options.profile);
      return;
    }
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

// OAuth login for one named profile. The token is written only to that profile's OS-store entry, and
// the verified account is bound explicitly; a mismatch removes the token before anything is stored.
async function loginProfile(alias) {
  const graph = services.get();
  const { registry, secretStore, accounts, settings } = graph;
  const snapshot = await registry.snapshot(alias);
  const clientId = snapshot.api?.clientId;
  if (!clientId) {
    throw new Error(`Profile "${snapshot.alias}" has no API client id. Set one with "profile add --api-client-id" first.`);
  }
  let clientSecret = '';
  try {
    clientSecret = (await secretStore.get(secretStore.ref(snapshot.id, 'clientSecret'))) ?? '';
  } catch {
    clientSecret = '';
  }
  if (snapshot.api?.appType !== 'installed' && !clientSecret) {
    throw new Error(`Profile "${snapshot.alias}" is a confidential app without a stored client secret. Run "profile credentials <name>" first.`);
  }
  const redirectUri = settings.redirectUri ?? 'http://localhost:8080';
  const state = randomBytes(16).toString('hex');
  console.log(`1. Open this URL and approve access for profile "${snapshot.alias}":\n`);
  console.log(createAuthorizeUrl({ clientId, redirectUri, scopes: [...DEFAULT_SCOPES], state }));
  console.log('\n2. Approve access. The browser then lands on the redirect URI; an error page there is expected.');
  const pasted = await ask('3. Paste the full address from the browser bar: ');
  const code = parseRedirectUrl(pasted, state);
  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    userAgent: settings.userAgent ?? `node:reddit-cli:${VERSION}`,
    redirectUri,
    code,
  });
  if (!tokens.refreshToken) throw new Error('Reddit returned no refresh token. Check that the authorize URL included duration=permanent.');

  const tokenRef = secretStore.ref(snapshot.id, 'refreshToken');
  await secretStore.set(tokenRef, tokens.refreshToken);
  let me;
  try {
    const session = await openApiSession({ snapshot, settings, secretStore });
    me = await session.actions.whoami();
  } catch (error) {
    await secretStore.delete(tokenRef);
    throw error;
  }
  const expected = snapshot.expectedUsername ?? snapshot.username;
  if (expected && expected.toLowerCase() !== me.name.toLowerCase()) {
    await secretStore.delete(tokenRef);
    throw new Error(`You authorized u/${me.name}, but this profile expects u/${expected}. The stored token was removed.`);
  }
  await accounts.bind({ profileId: snapshot.id, username: me.name });
  console.log(`Profile "${snapshot.alias}" is logged in as u/${me.name} and bound to that account. Granted scopes: ${tokens.scopes.join(', ')}`);
}

program
  .command('logout')
  .description('Revoke the stored token and remove it from the keychain')
  .option('--profile <name>', 'log out this named profile instead of the environment keychain entry')
  .option('--json', 'print the local/remote result')
  .action(async (options) => {
    if (options.profile !== undefined) {
      const result = await logoutProfile(deps, options.profile, { print: options.json !== true });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      return;
    }
    const config = loadConfig();
    if (config.authMode !== 'oauth') {
      console.log('This mode stores nothing, so there is nothing to remove.');
      return;
    }
    const store = createKeyringStore(config.username);
    const refreshToken = config.refreshToken || (await store.getRefreshToken());
    if (refreshToken) {
      await revokeToken({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        userAgent: config.userAgent,
        refreshToken,
      });
    }
    await store.clear();
    console.log(config.refreshToken
      ? 'Logged out. Also remove REDDIT_REFRESH_TOKEN from your environment.'
      : 'Logged out.');
  });

addBackendOptions(program
  .command('whoami')
  .description('Show the account the stored token belongs to (get_me)'))
  .action(async (options) => {
    await read('get_me', {}, options, (me) => {
      console.log(`u/${me.name}  link karma ${me.linkKarma}  comment karma ${me.commentKarma}`);
    });
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

addBackendOptions(program
  .command('feed <subreddit>')
  .description('List posts in a subreddit (browse_subreddit)')
  .option('--sort <sort>', 'hot, new, top, rising, or controversial', 'hot')
  .option('--time <range>', 'hour, day, week, month, year, or all (for top and controversial)')
  .option('--limit <n>', 'posts per page, 1-100', '10')
  .option('--info', 'also show the subreddit details first')
  .option('--after <cursor>', 'continue from the cursor printed at the end of the last page'))
  .action(async (subreddit, options) => {
    await read('browse_subreddit', {
      subreddit,
      sort: options.sort,
      time: options.time,
      limit: Number(options.limit),
      after: options.after,
      include_info: Boolean(options.info),
    }, options, (page) => {
      if (page.info) console.log(`r/${page.info.name}: ${page.info.subscribers} subscribers. ${page.info.title}`);
      printListing(page);
    });
  });

addBackendOptions(program
  .command('top <subreddit>')
  .description('Top posts in a subreddit for a time range (get_top_posts)')
  .option('--time <range>', 'hour, day, week, month, year, or all', 'day')
  .option('--limit <n>', 'posts per page, 1-100', '10')
  .option('--after <cursor>', 'continue from a previous page'))
  .action(async (subreddit, options) => {
    await read('get_top_posts', {
      subreddit,
      time: options.time,
      limit: Number(options.limit),
      after: options.after,
    }, options, printListing);
  });

addBackendOptions(program
  .command('subreddit <name>')
  .description("Show a subreddit's size and description (get_subreddit_info)"))
  .action(async (name, options) => {
    await read('get_subreddit_info', { subreddit: name }, options, (info) => {
      console.log(`r/${info.name}: ${info.subscribers} subscribers`);
      console.log(info.title);
      if (info.description) console.log(info.description);
    });
  });

addBackendOptions(program
  .command('rules <subreddit>')
  .description('Show the rules of a subreddit (get_subreddit_rules)'))
  .action(async (subreddit, options) => {
    await read('get_subreddit_rules', { subreddit }, options, (rules) => {
      for (const rule of rules) console.log(`- ${rule.shortName}: ${rule.description}`);
    });
  });

addBackendOptions(program
  .command('flairs <subreddit>')
  .description('List the post flairs a subreddit offers (get_post_flairs)'))
  .action(async (subreddit, options) => {
    await read('get_post_flairs', { subreddit }, options, (flairs) => {
      for (const flair of flairs) console.log(`${flair.id}  ${flair.text}`);
    });
  });

addBackendOptions(program
  .command('popular')
  .description("Popular subreddits, Reddit's closest public list to trending (get_trending_subreddits)")
  .option('--limit <n>', 'how many, 1-100', '5'))
  .action(async (options) => {
    await read('get_trending_subreddits', { limit: Number(options.limit) }, options, (names) => {
      for (const name of names) console.log(`r/${name}`);
    });
  });

addBackendOptions(program
  .command('search [query...]')
  .description('Search posts across Reddit or inside one subreddit (search_reddit)')
  .option('--subreddit <name>', 'limit the search to one subreddit')
  .option('--sort <sort>', 'relevance, hot, top, new, or comments', 'relevance')
  .option('--time <range>', 'hour, day, week, month, year, or all', 'all')
  .option('--type <type>', 'link, sr, or user', 'link')
  .option('--author <name>', 'only posts by this user')
  .option('--flair <text>', 'only posts with this flair')
  .option('--limit <n>', 'results per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page'))
  .action(async (words, options) => {
    await read('search_reddit', {
      query: (words ?? []).join(' '),
      author: options.author,
      flair: options.flair,
      subreddit: options.subreddit,
      sort: options.sort,
      time: options.time,
      type: options.type,
      limit: Number(options.limit),
      after: options.after,
    }, options, printListing);
  });

addBackendOptions(program
  .command('thread <id>')
  .description('A post and its comments (get_reddit_post and get_post_comments)')
  .option('--subreddit <name>', 'the subreddit the post is in (speeds up the lookup)')
  .option('--sort <sort>', 'confidence, top, new, controversial, old, or qa', 'confidence')
  .option('--limit <n>', 'comments to fetch, 1-500', '100')
  .option('--depth <n>', 'comment depth, 1-10'))
  .action(async (id, options) => {
    await read('get_post_comments', {
      post_id: id,
      subreddit: options.subreddit,
      sort: options.sort,
      limit: Number(options.limit),
      depth: options.depth === undefined ? undefined : Number(options.depth),
    }, options, (page) => console.log(JSON.stringify(page, null, 2)));
  });

addBackendOptions(program
  .command('more <postFullname> <commentIds...>')
  .description('Expand "load more" comment ids from a thread (get_more_comments)'))
  .action(async (postFullname, commentIds, options) => {
    await read('get_more_comments', { post_id: postFullname, comment_ids: commentIds }, options, (comments) => {
      console.log(JSON.stringify(comments, null, 2));
    });
  });

addBackendOptions(program
  .command('user <name>')
  .description("A Reddit user's karma and account details (get_user_info)"))
  .action(async (name, options) => {
    await read('get_user_info', { username: name }, options, (data) => console.log(JSON.stringify(data, null, 2)));
  });

for (const [command, description, tool] of [
  ['user-posts <name>', 'Posts by a user (get_user_posts)', 'get_user_posts'],
  ['user-comments <name>', 'Comments by a user (get_user_comments)', 'get_user_comments'],
]) {
  addBackendOptions(program
    .command(command)
    .description(description)
    .option('--sort <sort>', 'hot, new, top, or controversial', 'new')
    .option('--time <range>', 'hour, day, week, month, year, or all', 'all')
    .option('--limit <n>', 'items per page, 1-100', '25')
    .option('--after <cursor>', 'continue from a previous page'))
    .action(async (name, options) => {
      await read(tool, {
        username: name,
        sort: options.sort,
        time: options.time,
        limit: Number(options.limit),
        after: options.after,
      }, options, printListing);
    });
}

addBackendOptions(program
  .command('overview')
  .description('Your own posts and comments, newest first (get_my_overview; needs history)')
  .option('--limit <n>', 'items per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page'))
  .action(async (options) => {
    await read('get_my_overview', { limit: Number(options.limit), after: options.after }, options, printListing);
  });

addBackendOptions(program
  .command('saved')
  .description('Your saved posts and comments (get_my_saved; needs history)')
  .option('--limit <n>', 'items per page, 1-100', '25')
  .option('--after <cursor>', 'continue from a previous page'))
  .action(async (options) => {
    await read('get_my_saved', { limit: Number(options.limit), after: options.after }, options, printListing);
  });

addBackendOptions(program
  .command('mine')
  .description('List the subreddits you have joined (list_my_subreddits)'))
  .action(async (options) => {
    await read('list_my_subreddits', {}, options, (names) => {
      for (const name of names) console.log(`r/${name}`);
    });
  });

addBackendOptions(program
  .command('rss <subreddit>')
  .description('Browse a public feed with no client ID needed. Read-only, no scores; Reddit may throttle it')
  .option('--sort <sort>', 'hot, new, top, rising, or controversial', 'hot')
  .option('--limit <n>', 'posts, 1-100', '25'))
  .action(async (subreddit, options) => {
    await read('browse_subreddit_rss', {
      subreddit,
      sort: options.sort,
      limit: Number(options.limit),
    }, options, (entries) => {
      for (const entry of entries) {
        console.log(`${(entry.fullname ?? '').padEnd(10)}  ${entry.title}  (u/${entry.author ?? '?'})`);
      }
    });
  });

program
  .command('explain <term>')
  .description('Plain-language meaning of a Reddit term, such as karma or AMA (reddit_explain). Offline.')
  .action((term) => {
    const { definition } = lookupTerm(term);
    console.log(definition ?? `No entry for "${term}". Try karma, cake day, AMA, ELI5, OP, TIL, flair, or mod.`);
  });

addBackendOptions(program
  .command('activity <name>')
  .description('A user summary: karma, recent posts and comments, and where they are active (user_analysis)'))
  .action(async (name, options) => {
    await read('user_analysis', { username: name }, options, (data) => console.log(JSON.stringify(data, null, 2)));
  });

addBackendOptions(program
  .command('test')
  .description('Checks the configuration end to end (test_reddit_mcp_server)')
  .option('--check-account', 'also verify the account identity'))
  .action(async (options) => {
    // Omit checkAccount unless asked, so the API default (verify identity except in app mode) holds.
    const result = await read(
      'test_reddit_mcp_server',
      options.checkAccount ? { checkAccount: true } : {},
      options,
      null,
    );
    if (options.json) return;
    const report = result.data;
    for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
    console.log(report.ok ? `All checks passed in ${report.elapsedMs} ms.` : 'Some checks failed.');
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('token')
  .description('Print the stored API refresh token, for the Claude Desktop extension. It is a secret: anyone with it can act as your account')
  .option('--profile <name>', 'read this named profile API refresh token instead of the environment keychain entry')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (options) => {
    if (options.profile !== undefined) {
      const graph = services.get();
      const snapshot = await graph.registry.snapshot(options.profile);
      const token = await graph.secretStore.get(graph.secretStore.ref(snapshot.id, 'refreshToken'));
      if (!token) throw new Error(`No refresh token is stored for profile "${snapshot.alias}". Run "login --profile ${snapshot.alias}" first.`);
      await confirm(`Print the API refresh token for profile "${snapshot.alias}"? Anyone with it can act as that account.`, options);
      console.log(token);
      return;
    }
    const config = loadConfig();
    if (config.authMode !== 'oauth') throw new Error('Only oauth mode has a refresh token.');
    const token = config.refreshToken || (await createKeyringStore(config.username).getRefreshToken());
    if (!token) throw new Error('No refresh token is stored. Run "reddit-cli login" first.');
    await confirm('Print the refresh token to this terminal? Anyone with it can act as your account.', options);
    console.log(token);
  });

// ---- Writes. Each asks only when the configured policy (or --confirm) requires it. ----

addBackendOptions(addWriteOptions(program
  .command('post <subreddit>')
  .description('Submit a text or link post (create_post)')
  .requiredOption('--title <title>', 'post title')
  .option('--text <text>', 'body of a text post')
  .option('--url <url>', 'link for a link post')))
  .action(async (subreddit, options) => {
    const args = { subreddit, title: options.title, text: options.text, url: options.url };
    await writeCli('create_post', args, options, (result) => {
      console.log(result?.url ? `Posted: ${result.url}` : 'Posted.');
    }, { action: 'submit', ...args });
  });

addBackendOptions(addWriteOptions(program
  .command('comment <parent>')
  .description('Reply to a post (t3_...) or to a comment (t1_...) (reply_to_post)')
  .requiredOption('--text <text>', 'comment body')))
  .action(async (parent, options) => {
    const args = { parent, text: options.text };
    await writeCli('reply_to_post', args, options, (result) => {
      const permalink = result?.things?.[0]?.data?.permalink;
      console.log(permalink ? `Commented: https://www.reddit.com${permalink}` : 'Commented.');
    }, { action: 'comment', ...args });
  });

addBackendOptions(addWriteOptions(program
  .command('edit <fullname>')
  .description('Replace the text of your own post (t3_...) or comment (t1_...) (edit_post, edit_comment)')
  .requiredOption('--text <text>', 'the new text')))
  .action(async (fullname, options) => {
    const kind = kindOf(fullname);
    const tool = kind === 't1' ? 'edit_comment' : 'edit_post';
    const args = { fullname, text: options.text };
    await writeCli(tool, args, options, () => console.log(`Edited ${fullname}.`), {
      action: 'edit', ...args, kind,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('delete <fullname>')
  .description('Delete your own post (t3_...) or comment (t1_...). This cannot be undone (delete_post, delete_comment)')))
  .action(async (fullname, options) => {
    const kind = kindOf(fullname);
    const tool = kind === 't1' ? 'delete_comment' : 'delete_post';
    const args = { fullname };
    await writeCli(tool, args, options, () => console.log(`Deleted ${fullname}.`), {
      action: 'delete', ...args, kind,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('vote <fullname> <direction>')
  .description('Upvote, downvote, or clear your vote on one post or comment: up | down | clear (vote_on_thing)')))
  .action(async (fullname, direction, options) => {
    const args = { fullname, direction };
    await writeCli('vote_on_thing', args, options, () => console.log(`Vote on ${fullname} set to ${direction}.`), {
      action: 'vote', ...args,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('subscribe <subreddit>')
  .description('Join a subreddit (subscribe_to_subreddit)')))
  .action(async (subreddit, options) => {
    await writeCli('subscribe_to_subreddit', { subreddit }, options, () => console.log(`Joined r/${subreddit}.`), {
      action: 'subscribe', subreddit,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('unsubscribe <subreddit>')
  .description('Leave a subreddit (unsubscribe_from_subreddit)')))
  .action(async (subreddit, options) => {
    await writeCli('unsubscribe_from_subreddit', { subreddit }, options, () => console.log(`Left r/${subreddit}.`), {
      action: 'unsubscribe', subreddit,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('save <fullname>')
  .description('Save a post or comment to your account (save_content)')))
  .action(async (fullname, options) => {
    await writeCli('save_content', { fullname }, options, () => console.log(`Saved ${fullname}.`), {
      action: 'save', fullname,
    });
  });

addBackendOptions(addWriteOptions(program
  .command('unsave <fullname>')
  .description('Remove a post or comment from your saved items (unsave_content)')))
  .action(async (fullname, options) => {
    await writeCli('unsave_content', { fullname }, options, () => console.log(`Unsaved ${fullname}.`), {
      action: 'unsave', fullname,
    });
  });

// The raw API escape hatch stays an official-API call. It is not a browser or replay entry point and
// has no profile-agnostic cookie access. A raw POST runs through the shared write boundary under the
// `raw_post` admission key; --yes is only its legacy local confirmation, never account admission or a
// stored-policy override.
addBackendOptions(program
  .command('api <method> <path>')
  .description('Send any authenticated official-API GET or POST, e.g. api GET /api/v1/me')
  .option('-f, --field <key=value>', 'form field for POST, query parameter for GET (repeatable)', collect, [])
  .option('--yes', 'skip the local confirmation for a raw POST')
  .option('--dry-run', 'print the request and exit'))
  .action(async (method, path, options) => {
    if (!path.startsWith('/')) {
      throw new Error(
        'Paths must start with "/", for example /api/v1/me. In Git Bash, prefix the command with MSYS_NO_PATHCONV=1 so the path is not rewritten.',
      );
    }
    if (options.backend !== undefined && options.backend !== 'auto' && options.backend !== 'api') {
      throw new Error('The raw api command is official-API-only; replay and browser backends are not reachable through it.');
    }
    const verb = method.toUpperCase();
    const fields = toFields(options.field);
    if (options.dryRun) return printPlan({ method: verb, path, fields });
    if (verb === 'POST') {
      // POST is a mutation: it runs through the shared write boundary with the raw_post admission
      // key. The optional --yes is only the legacy local confirmation when no stricter stored policy
      // applies; it never replaces account admission or the durable attempt ledger.
      const result = await executeCliRaw(deps, {
        method: verb,
        path,
        fields,
        profile: options.profile ?? null,
        yes: options.yes === true,
      });
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }
    if (verb !== 'GET') throw new Error('Only GET and POST are supported.');
    let actions;
    if (options.profile !== undefined) {
      const graph = services.get();
      const snapshot = await graph.registry.snapshot(options.profile);
      const session = await openApiSession({ snapshot, settings: graph.settings, secretStore: graph.secretStore });
      actions = session.actions;
    } else {
      actions = openSession(loadConfig()).actions;
    }
    const result = await actions.raw({ method: verb, path, fields });
    console.log(JSON.stringify(result, null, 2));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
