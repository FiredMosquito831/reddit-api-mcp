#!/usr/bin/env node
// Builds dist/reddit-api-mcp.mcpb, a Claude Desktop extension that runs the MCP server (src/mcp.js) over stdio.
// The bundle carries the server code and its runtime dependencies for this platform. The CLI, tests, scripts,
// and docs are left out. Run it with: npm run mcpb
//
// Dependency boundary: the extension is API-only. Playwright is an optional peer for local CLI/stdio browser
// backends and is never a bundle dependency or asset. Browser/replay modules under src/browser and src/replay are
// copied only when the API server statically imports them; they are expected to be loaded dynamically, so they
// normally stay out. Browser profile/state assets are never imported and therefore never copied.
//
// Importing this module has no side effects; the build runs only when the file is executed directly.
import { execSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = 'mcp.js';
// Command-line-only modules. The bundle serves stdio MCP from mcp.js; the CLI and its profile/browser
// command modules statically reach Playwright-adjacent code and are never shipped.
const CLI_ONLY_FILES = new Set(['cli.js', 'cli-profiles.js', 'cli-browser.js']);
// The local stdio browser helper surface is never registered by the API-only bundle.
const LOCAL_ONLY_FILES = new Set(['mcp-browser.js']);
// Optional backends that ship in the source tree for local CLI/stdio only. The dispatcher loads the
// replay and rendered-UI adapters through dynamic imports, so their modules (and everything under
// src/browser and src/replay) stay out of the API bundle unless the server statically reaches them.
const OPTIONAL_BACKEND_DIRS = new Set(['browser', 'replay']);
const OPTIONAL_BACKEND_FILES = new Set(['backends/browser.js', 'backends/replay.js']);
// Keywords after which a `/` starts a regular expression rather than a division.
const EXPRESSION_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);
const IDENT_START = /[A-Za-z_$\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

function isPunctValue(value) {
  return '()[]{};,.?:=!&|^~%*+-<>/'.includes(value);
}

function isPlaywrightSpecifier(specifier) {
  return specifier === 'playwright'
    || specifier.startsWith('playwright/')
    || specifier.startsWith('@playwright/');
}

// A small lexer for the subset of JavaScript that can hide or contain a module specifier. It skips comments,
// strings, template literals (including nested `${...}`), and regular expression literals, so `import` inside any
// of them is never mistaken for a declaration. Malformed input is rejected instead of silently mis-scanned.
function tokenize(source) {
  if (typeof source !== 'string') throw new TypeError('tokenize expects a string');

  function readString(quote, start) {
    let i = start + 1;
    let value = '';
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') {
        value += ch;
        if (i + 1 < source.length) value += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) return { type: 'string', value, end: i + 1 };
      if (ch === '\n' || ch === '\r') break;
      value += ch;
      i += 1;
    }
    throw new Error('Unterminated string literal');
  }

  function skipLineComment(i) {
    while (i < source.length && source[i] !== '\n') i += 1;
    return i;
  }

  function skipBlockComment(i) {
    const end = source.indexOf('*/', i);
    if (end === -1) throw new Error('Unterminated block comment');
    return end + 2;
  }

  function skipRegex(i) {
    let inClass = false;
    let j = i + 1;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '\n' || ch === '\r') break;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        j += 1;
        while (j < source.length && /[A-Za-z]/.test(source[j])) j += 1;
        return j;
      }
      j += 1;
    }
    throw new Error('Unterminated regular expression literal');
  }

  function regexAllowed(last) {
    if (!last) return true;
    if (last.type === 'word') return EXPRESSION_KEYWORDS.has(last.value);
    if (last.type === 'punct') return ![')', ']', '}', '.', '++', '--'].includes(last.value);
    return false;
  }

  // Scans code. When `stopAtBrace` is set, stops at the `}` that closes the enclosing `${...}` and returns the
  // position after it. Tokens found inside a template interpolation are discarded.
  function scanCode(start, stopAtBrace) {
    const tokens = [];
    let last = null;
    let depth = 0;
    let i = start;
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch)) { i += 1; continue; }
      if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(i + 2); continue; }
      if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(i + 2); continue; }
      if (ch === "'" || ch === '"') {
        const stringToken = readString(ch, i);
        i = stringToken.end;
        const token = { type: 'string', value: stringToken.value };
        tokens.push(token);
        last = token;
        continue;
      }
      if (ch === '`') {
        i = skipTemplate(i + 1);
        last = { type: 'template' };
        tokens.push(last);
        continue;
      }
      if (ch === '/') {
        if (regexAllowed(last)) {
          i = skipRegex(i);
          last = { type: 'regex' };
          tokens.push(last);
        } else {
          last = { type: 'punct', value: '/' };
          tokens.push(last);
          i += 1;
        }
        continue;
      }
      if (ch === '{') {
        depth += 1;
        last = { type: 'punct', value: '{' };
        tokens.push(last);
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (stopAtBrace && depth === 0) return { index: i + 1, tokens };
        if (depth > 0) depth -= 1;
        last = { type: 'punct', value: '}' };
        tokens.push(last);
        i += 1;
        continue;
      }
      if (isPunctValue(ch)) {
        let value = ch;
        if ((ch === '+' || ch === '-') && source[i + 1] === ch) {
          value += ch;
          i += 1;
        }
        last = { type: 'punct', value };
        tokens.push(last);
        i += 1;
        continue;
      }
      if (IDENT_START.test(ch)) {
        let end = i + 1;
        while (end < source.length && IDENT_PART.test(source[end])) end += 1;
        last = { type: 'word', value: source.slice(i, end) };
        tokens.push(last);
        i = end;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let end = i + 1;
        while (end < source.length && /[0-9A-Za-z_.]/.test(source[end])) end += 1;
        last = { type: 'number', value: source.slice(i, end) };
        tokens.push(last);
        i = end;
        continue;
      }
      // Unknown punctuation (for example `#` or `@`): skip it without interpreting its neighbours.
      i += 1;
    }
    if (stopAtBrace) throw new Error('Unterminated template interpolation');
    return { index: i, tokens };
  }

  function skipTemplate(i) {
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') return i + 1;
      if (ch === '$' && source[i + 1] === '{') {
        i = scanCode(i + 2, true).index;
        continue;
      }
      i += 1;
    }
    throw new Error('Unterminated template literal');
  }

  return scanCode(0, false).tokens;
}

function specifierValue(token, label) {
  if (token.value.includes('\\')) {
    throw new Error(`Module specifier with an escape sequence is not supported in ${label}: ${JSON.stringify(token.value)}`);
  }
  return token.value;
}

// Every static `import ... from '...'` / `import '...'` / `export ... from '...'` specifier in a module source.
// Comments, strings, templates, and regex literals are skipped, so text that merely looks like an import does not
// count. Dynamic `import('./x.js')` and `import.meta` are deliberately ignored: dynamically loaded backends are not
// bundle dependencies. A declaration that cannot be parsed is an error rather than an omission.
export function staticImportSpecifiers(source, label = '<module>') {
  const tokens = tokenize(source);
  const specifiers = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'word') continue;
    const previous = tokens[i - 1];
    if (previous && previous.type === 'punct' && previous.value === '.') continue;

    if (token.value === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === 'punct' && (next.value === '(' || next.value === '.' || next.value === ':')) continue;
      if (next.type === 'string') {
        specifiers.push(specifierValue(next, label));
        continue;
      }
      let depth = 0;
      let parsed = false;
      for (let j = i + 1; j < tokens.length; j += 1) {
        const current = tokens[j];
        if (current.type === 'punct') {
          if (current.value === '{' || current.value === '(' || current.value === '[') depth += 1;
          else if (current.value === '}' || current.value === ')' || current.value === ']') depth -= 1;
          else if (depth === 0 && (current.value === ';' || current.value === '=')) break;
        }
        if (depth === 0 && current.type === 'word' && current.value === 'from'
          && tokens[j + 1]?.type === 'string') {
          specifiers.push(specifierValue(tokens[j + 1], label));
          parsed = true;
          break;
        }
      }
      if (!parsed) throw new Error(`Could not parse a static import declaration in ${label}`);
      continue;
    }

    if (token.value === 'export') {
      const next = tokens[i + 1];
      if (!next || next.type !== 'punct' || (next.value !== '{' && next.value !== '*')) continue;
      if (next.value === '{') {
        let depth = 0;
        let j = i + 1;
        for (; j < tokens.length; j += 1) {
          const current = tokens[j];
          if (current.type === 'punct' && current.value === '{') depth += 1;
          else if (current.type === 'punct' && current.value === '}') {
            depth -= 1;
            if (depth === 0) { j += 1; break; }
          }
        }
        if (depth !== 0) throw new Error(`Could not parse a static re-export declaration in ${label}`);
        const from = tokens[j];
        if (!(from && from.type === 'word' && from.value === 'from')) continue; // local re-export, no module
        const specifier = tokens[j + 1];
        if (!specifier || specifier.type !== 'string') {
          throw new Error(`A re-export in ${label} has no module specifier after "from"`);
        }
        specifiers.push(specifierValue(specifier, label));
        continue;
      }
      // `export * from './x.js'` and `export * as ns from './x.js'`.
      let parsed = false;
      for (let j = i + 2; j < tokens.length; j += 1) {
        const current = tokens[j];
        if (current.type === 'punct' && current.value === ';') break;
        if (current.type === 'word' && current.value === 'from' && tokens[j + 1]?.type === 'string') {
          specifiers.push(specifierValue(tokens[j + 1], label));
          parsed = true;
          break;
        }
      }
      if (!parsed) throw new Error(`Could not parse a static re-export declaration in ${label}`);
    }
  }
  return specifiers;
}

function posix(rel) {
  return rel.split('\\').join('/');
}

function isOptionalBackend(rel) {
  return OPTIONAL_BACKEND_DIRS.has(rel.split('/')[0]) || OPTIONAL_BACKEND_FILES.has(rel);
}

function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else if (entry.isFile()) files.push(posix(relative(base, full)));
  }
  return files.sort();
}

// Relative modules statically reachable from the server entry point. Bare package specifiers are not local files.
// A local specifier that cannot be read is a build error: silently skipping it would ship a bundle with a missing
// module. A reachable module that statically imports Playwright is also an error, because the optional peer is not
// installed in the bundle and browser backends must be loaded dynamically.
function staticallyReachable(srcDir) {
  const reachable = new Set();
  const queue = [{ rel: ENTRY_POINT, importedBy: null }];
  while (queue.length > 0) {
    const { rel, importedBy } = queue.shift();
    if (reachable.has(rel)) continue;
    reachable.add(rel);
    let source;
    try {
      source = readFileSync(join(srcDir, ...rel.split('/')), 'utf8');
    } catch (error) {
      const origin = importedBy ? ` imported by ${importedBy}` : ' (server entry point)';
      throw new Error(`Cannot read statically imported module ${rel}${origin}: ${error.message}`);
    }
    let specifiers;
    try {
      specifiers = staticImportSpecifiers(source, rel);
    } catch (error) {
      throw new Error(`Cannot scan static imports in ${rel}: ${error.message}`);
    }
    for (const specifier of specifiers) {
      if (isPlaywrightSpecifier(specifier)) {
        throw new Error(
          `Statically reachable module ${rel} imports ${JSON.stringify(specifier)}. Browser backends must load `
          + 'Playwright through a dynamic import so the API-only bundle never depends on the optional peer.',
        );
      }
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      const imported = posix(relative(srcDir, resolve(srcDir, dirname(rel), specifier)));
      if (imported.startsWith('..')) {
        throw new Error(
          `Static import ${JSON.stringify(specifier)} in ${rel} resolves outside src/ and cannot be bundled`,
        );
      }
      queue.push({ rel: imported, importedBy: rel });
    }
  }
  return reachable;
}

// The server sources to copy, relative to src/. Nested official modules are always kept (as before); the CLI and
// unreferenced browser/replay modules are not.
export function planServerFiles(srcDir) {
  const reachable = staticallyReachable(srcDir);
  return listFiles(srcDir).filter((rel) => {
    if (CLI_ONLY_FILES.has(rel)) return false;
    if (LOCAL_ONLY_FILES.has(rel)) return false;
    if (isOptionalBackend(rel) && !reachable.has(rel)) return false;
    return true;
  });
}

// Copies the planned sources into destDir and returns the copied paths. Directory growth is limited to destDir.
export function copyServerSources({ srcDir, destDir }) {
  const plan = planServerFiles(srcDir);
  for (const rel of plan) {
    const target = join(destDir, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(srcDir, ...rel.split('/')), target);
  }
  return plan;
}

// commander is CLI-only. playwright is an optional peer, never a bundled runtime dependency.
export function runtimeDependenciesFor(pkg) {
  const dependencies = { ...(pkg.dependencies ?? {}) };
  delete dependencies.commander;
  delete dependencies.playwright;
  return dependencies;
}

export function manifestFor(pkg, platform) {
  return {
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
        args: ['${__dirname}/server/src/mcp.js', '--api-only'],
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
      platforms: [platform],
      runtimes: { node: '>=22.12' },
    },
  };
}

// True when `invokedPath` is this module. Both sides are canonicalised with the OS realpath, so a symlinked entry
// point, a relative path, a short (8.3) Windows path, or a differently-cased path on Windows still runs the build.
// On Windows the comparison is case-insensitive, matching how NTFS resolves names.
export function isMainModule(invokedPath, moduleUrl, platform = process.platform) {
  if (typeof invokedPath !== 'string' || invokedPath.length === 0 || typeof moduleUrl !== 'string') return false;
  let invoked;
  let moduleFile;
  try {
    invoked = realpathSync.native(invokedPath);
    moduleFile = realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
  return platform === 'win32' ? invoked.toLowerCase() === moduleFile.toLowerCase() : invoked === moduleFile;
}

function main() {
  const PLATFORMS = ['darwin', 'win32', 'linux'];
  if (!PLATFORMS.includes(process.platform)) {
    throw new Error(`Cannot build an MCPB bundle on ${process.platform}. Use darwin, win32, or linux.`);
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dist = join(root, 'dist');
  const bundleDir = join(dist, 'mcpb');
  const serverDir = join(bundleDir, 'server');
  const manifestPath = join(bundleDir, 'manifest.json');
  const outFile = join(dist, 'reddit-api-mcp.mcpb');
  const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(serverDir, { recursive: true });

  // The server code: nested modules under src/ are copied recursively, except the CLI and unreferenced optional
  // browser/replay modules (see the boundary note at the top).
  copyServerSources({ srcDir: join(root, 'src'), destDir: join(serverDir, 'src') });

  // ES modules need a package.json with "type": "module" next to the code. commander is CLI-only, so it is left out.
  writeFileSync(join(serverDir, 'package.json'), `${JSON.stringify({
    name: `${pkg.name}-bundle`,
    version: pkg.version,
    private: true,
    type: 'module',
    dependencies: runtimeDependenciesFor(pkg),
  }, null, 2)}\n`);

  // Install the runtime dependencies for this platform. The keychain binding is native, so a bundle is per platform.
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: serverDir, stdio: 'inherit' });
  rmSync(join(serverDir, 'package-lock.json'), { force: true });

  writeFileSync(manifestPath, `${JSON.stringify(manifestFor(pkg, process.platform), null, 2)}\n`);

  execSync(`"${mcpb}" validate "${manifestPath}"`, { stdio: 'inherit' });
  execSync(`"${mcpb}" pack "${bundleDir}" "${outFile}"`, { stdio: 'inherit' });
  console.log(`Built ${outFile} (${(statSync(outFile).size / 1024 / 1024).toFixed(1)} MB) for ${process.platform}.`);
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main();
}
