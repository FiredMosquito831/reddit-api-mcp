#!/usr/bin/env node
// Builds dist/reddit-api-mcp.mcpb, a Claude Desktop extension that runs the MCP server (src/mcp.js) over stdio.
// The bundle carries the server code and its runtime dependencies for this platform. The CLI, tests, scripts,
// and docs are left out. Run it with: npm run mcpb
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
const bundleDir = join(dist, 'mcpb');
const serverDir = join(bundleDir, 'server');
const manifestPath = join(bundleDir, 'manifest.json');
const outFile = join(dist, 'reddit-api-mcp.mcpb');
const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
const PLATFORMS = ['darwin', 'win32', 'linux'];

if (!PLATFORMS.includes(process.platform)) {
  throw new Error(`Cannot build an MCPB bundle on ${process.platform}. Use darwin, win32, or linux.`);
}

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(join(serverDir, 'src'), { recursive: true });

// The server code: everything under src/ except the CLI, which the extension never runs.
for (const file of readdirSync(join(root, 'src'))) {
  if (file !== 'cli.js') copyFileSync(join(root, 'src', file), join(serverDir, 'src', file));
}

// ES modules need a package.json with "type": "module" next to the code. commander is CLI-only, so it is left out.
const runtimeDependencies = { ...pkg.dependencies };
delete runtimeDependencies.commander;
writeFileSync(join(serverDir, 'package.json'), `${JSON.stringify({
  name: `${pkg.name}-bundle`,
  version: pkg.version,
  private: true,
  type: 'module',
  dependencies: runtimeDependencies,
}, null, 2)}\n`);

// Install the runtime dependencies for this platform. The keychain binding is native, so a bundle is per platform.
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: serverDir, stdio: 'inherit' });
rmSync(join(serverDir, 'package-lock.json'), { force: true });

const manifest = {
  $schema: 'https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json',
  manifest_version: '0.4',
  name: pkg.name,
  display_name: 'Reddit API',
  version: pkg.version,
  description: 'Control your own Reddit account from Claude: read, search, post, reply, edit, vote, join, and save.',
  author: { name: 'FiredMosquito831' },
  server: {
    type: 'node',
    entry_point: 'server/src/mcp.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/src/mcp.js'],
      env: {
        REDDIT_AUTH_MODE: '${user_config.auth_mode}',
        REDDIT_CLIENT_ID: '${user_config.client_id}',
        REDDIT_CLIENT_SECRET: '${user_config.client_secret}',
        REDDIT_USERNAME: '${user_config.username}',
        REDDIT_PASSWORD: '${user_config.password}',
        REDDIT_REFRESH_TOKEN: '${user_config.refresh_token}',
        REDDIT_CLI_SAFE_MODE: '${user_config.safe_mode}',
        REDDIT_CLI_BOT_FOOTER: '${user_config.bot_footer}',
        REDDIT_CLI_CACHE: '${user_config.cache}',
      },
    },
  },
  user_config: {
    client_id: {
      type: 'string',
      title: 'Reddit app client ID',
      description: "The client ID shown under your app's name at reddit.com/prefs/apps.",
      required: true,
    },
    username: {
      type: 'string',
      title: 'Reddit username',
      description: 'The account this extension acts for. Used in the User-Agent and checked at login.',
      required: true,
    },
    auth_mode: {
      type: 'string',
      title: 'Auth mode',
      description: 'oauth (default, needs a refresh token), password (needs client_secret and password), or app (read-only, needs client_secret).',
      default: 'oauth',
    },
    client_secret: {
      type: 'string',
      title: 'Client secret',
      description: 'Needed for password and app modes, and for script or web apps. Leave empty for installed apps.',
      sensitive: true,
    },
    password: {
      type: 'string',
      title: 'Reddit password',
      description: 'Password mode only. Your password is held by the host and never written to disk here. With two-factor on, append ":CODE".',
      sensitive: true,
    },
    refresh_token: {
      type: 'string',
      title: 'Refresh token',
      description: 'oauth mode only. In the source repo, run "node src/cli.js login", then "node src/cli.js token", and paste the output here.',
      sensitive: true,
    },
    safe_mode: {
      type: 'string',
      title: 'Write safety',
      description: 'standard (2 seconds between writes, 30 an hour) or strict (5 seconds, 10 an hour).',
      default: 'standard',
    },
    bot_footer: {
      type: 'string',
      title: 'Bot footer',
      description: 'Leave empty for none, "auto" for the standard disclosure, or your own footer text.',
      default: '',
    },
    cache: {
      type: 'string',
      title: 'Read cache',
      description: 'on (default, 60 seconds) or off.',
      default: 'on',
    },
  },
  compatibility: {
    claude_desktop: '>=1.0.0',
    platforms: [process.platform],
    runtimes: { node: '>=22.12' },
  },
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

execSync(`"${mcpb}" validate "${manifestPath}"`, { stdio: 'inherit' });
execSync(`"${mcpb}" pack "${bundleDir}" "${outFile}"`, { stdio: 'inherit' });
console.log(`Built ${outFile} (${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB) for ${process.platform}.`);
