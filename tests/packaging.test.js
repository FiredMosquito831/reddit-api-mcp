// Packaging boundary tests: the MCPB bundle carries the official-API server and runtime dependencies, and never
// carries the CLI, browser/replay backend code, or Playwright. Everything here runs offline against temp fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  copyServerSources,
  isMainModule,
  manifestFor,
  planServerFiles,
  runtimeDependenciesFor,
  staticImportSpecifiers,
} from '../scripts/build-mcpb.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function posix(rel) {
  return rel.split('\\').join('/');
}

function isOptionalBackend(rel) {
  return rel.startsWith('browser/') || rel.startsWith('replay/');
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'reddit-mcpb-'));
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

test('a nested official-API module tree is copied, while the CLI and unused browser/replay code are not', () => {
  const root = fixture({
    'src/mcp.js': "import './server.js';\n",
    'src/server.js': "import './nested/tools/official.js';\n",
    'src/nested/tools/official.js': 'export const official = true;\n',
    'src/cli.js': '#!/usr/bin/env node\n',
    'src/browser/session.js': 'export const session = true;\n',
    'src/replay/client.js': 'export const replay = true;\n',
    'src/browser/storage-state.json': '{"cookies":[]}\n',
    'src/replay/profile/cookies.json': '{"cookies":[]}\n',
  });

  const plan = planServerFiles(join(root, 'src'));

  assert.deepEqual(plan, ['mcp.js', 'nested/tools/official.js', 'server.js']);
});

test('a browser/replay module that is statically required from the server is included, with no session assets', () => {
  const root = fixture({
    'src/mcp.js': "import './server.js';\n",
    'src/server.js': "import './browser/handoff.js';\n",
    'src/browser/handoff.js': "import './shared/chrome.js';\n",
    'src/browser/shared/chrome.js': 'export const chrome = true;\n',
    'src/browser/unused.js': 'export const unused = true;\n',
    'src/browser/profile/storage-state.json': '{"cookies":[]}\n',
    'src/replay/unused.js': 'export const unused = true;\n',
  });

  const plan = planServerFiles(join(root, 'src'));

  assert.deepEqual(plan, ['browser/handoff.js', 'browser/shared/chrome.js', 'mcp.js', 'server.js']);
});

test('copyServerSources copies the plan into a destination without side effects outside it', () => {
  const root = fixture({
    'src/mcp.js': "import './nested/official.js';\n",
    'src/nested/official.js': 'export const value = 1;\n',
    'src/cli.js': '#!/usr/bin/env node\n',
    'src/browser/session.js': 'export const browser = true;\n',
  });
  const dest = join(root, 'out', 'server', 'src');

  const copied = copyServerSources({ srcDir: join(root, 'src'), destDir: dest });

  assert.deepEqual(copied, ['mcp.js', 'nested/official.js']);
  assert.deepEqual(walk(dest), ['mcp.js', 'nested/official.js']);
  assert.equal(readFileSync(join(dest, 'nested/official.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(join(dest, 'cli.js')), false);
  assert.equal(existsSync(join(dest, 'browser')), false);
  // The plan is derived from the source tree only; nothing is written next to the source.
  assert.deepEqual(walk(join(root, 'src')), ['browser/session.js', 'cli.js', 'mcp.js', 'nested/official.js']);
});

test('staticImportSpecifiers reads static imports and exports, but not dynamic imports', () => {
  const source = [
    "import { a } from './a.js';",
    "import './side-effect.js';",
    "export { b } from './b.js';",
    "const lazy = await import('./lazy.js');",
  ].join('\n');

  assert.deepEqual(staticImportSpecifiers(source), ['./a.js', './side-effect.js', './b.js']);
});

test('staticImportSpecifiers ignores imports that only appear in comments, strings, templates, or regexes', () => {
  const source = [
    "// import './line-comment.js';",
    "/* export { x } from './block-comment.js'; */",
    "const text = \"import './in-string.js'\";",
    "const other = 'export { y } from \"./other-string.js\"';",
    "const tpl = `import './in-template.js' ${'nested'} ${1 + 2} /not a regex/`;",
    "const re = /import '\\.\\/in-regex\\.js'/;",
    "const re2 = /[\"'`]/g;",
    "const division = 4 / 2; const slash = '/not/a/comment';",
    "import real from './real.js';",
  ].join('\n');

  assert.deepEqual(staticImportSpecifiers(source), ['./real.js']);
});

test('staticImportSpecifiers handles multi-line declarations, re-exports, and non-import keywords', () => {
  const source = [
    'import {',
    '  a,',
    '  b as c,',
    '} from "./a.js";',
    'import * as ns from "./ns.js";',
    'import defaultExport, { named } from "./mixed.js";',
    'export * from "./star.js";',
    'export * as ns2 from "./star-ns.js";',
    'export { a as d } from "./named.js";',
    'export { localOnly };',
    'const lazy = import("./lazy.js");',
    'const meta = import.meta.url;',
    'const object = { import: "./key.js", export: "./key2.js" };',
  ].join('\n');

  assert.deepEqual(staticImportSpecifiers(source), [
    './a.js',
    './ns.js',
    './mixed.js',
    './star.js',
    './star-ns.js',
    './named.js',
  ]);
});

test('an unparseable static import declaration is rejected instead of being skipped', () => {
  assert.throws(() => staticImportSpecifiers("import { a }\n", 'incomplete.js'), /incomplete\.js/);
  assert.throws(() => staticImportSpecifiers("export * as ns\n", 'incomplete-export.js'), /incomplete-export\.js/);
});

test('the bundle dependency list keeps official runtime dependencies and drops the CLI-only one', () => {
  const deps = runtimeDependenciesFor({
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.32.1',
      '@napi-rs/keyring': '^2.1.2',
      commander: '^15.0.0',
      zod: '^3.25.76',
    },
  });

  assert.deepEqual(deps, {
    '@modelcontextprotocol/sdk': '^1.32.1',
    '@napi-rs/keyring': '^2.1.2',
    zod: '^3.25.76',
  });
});

test('the MCPB manifest keeps its API-only entry point and carries no Playwright dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = manifestFor(pkg, 'win32');

  assert.equal(manifest.server.entry_point, 'server/src/mcp.js');
  assert.equal(manifest.server.mcp_config.args[0], '${__dirname}/server/src/mcp.js');
  assert.deepEqual(manifest.compatibility.platforms, ['win32']);
  assert.equal(
    manifest.description,
    'Control your own Reddit account from Claude: read, search, post, reply, edit, vote, join, and save.',
  );
  assert.notEqual(manifest.description, pkg.description);
  assert.doesNotMatch(JSON.stringify(manifest), /playwright/i);
});

test('package.json declares Playwright as an optional peer, never as an installed dependency', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  assert.ok(pkg.peerDependencies?.playwright, 'playwright must be a peer dependency');
  assert.match(pkg.peerDependencies.playwright, /^\^1\.\d+\.\d+$/);
  assert.equal(pkg.peerDependenciesMeta?.playwright?.optional, true);
  assert.equal(pkg.dependencies?.playwright, undefined);
  assert.equal(pkg.devDependencies?.playwright, undefined);
  assert.equal(pkg.optionalDependencies?.playwright, undefined);
  assert.ok(!pkg.optionalDependencies || Object.keys(pkg.optionalDependencies).length === 0);
});

test('package-lock agrees with the optional peer declaration', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const rootEntry = lock.packages?.[''];

  assert.ok(rootEntry, 'lockfile must carry the root package entry');
  assert.equal(rootEntry.peerDependencies?.playwright, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).peerDependencies.playwright);
  assert.equal(rootEntry.peerDependenciesMeta?.playwright?.optional, true);
  assert.equal(rootEntry.dependencies?.playwright, undefined);
});

test('official API and RSS source never statically imports Playwright', () => {
  const offenders = [];
  for (const rel of walk(SRC)) {
    if (!/\.(?:js|mjs)$/.test(rel)) continue;
    const source = readFileSync(join(SRC, rel), 'utf8');
    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier === 'playwright' || specifier.startsWith('playwright/') || specifier.startsWith('@playwright/')) {
        offenders.push(`${rel}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test('a missing or escaping static local import is rejected clearly instead of silently dropped', () => {
  const missing = fixture({ 'src/mcp.js': "import './server.js';\n" });
  assert.throws(
    () => planServerFiles(join(missing, 'src')),
    /Cannot read statically imported module server\.js imported by mcp\.js/,
  );

  const missingEntry = fixture({ 'src/other.js': 'export const other = true;\n' });
  assert.throws(
    () => planServerFiles(join(missingEntry, 'src')),
    /Cannot read statically imported module mcp\.js \(server entry point\)/,
  );

  const escaping = fixture({ 'src/mcp.js': "import '../outside.js';\n" });
  assert.throws(
    () => planServerFiles(join(escaping, 'src')),
    /resolves outside src\/ and cannot be bundled/,
  );
});

test('a statically reachable Playwright import fails the build instead of shipping a broken bundle', () => {
  const root = fixture({
    'src/mcp.js': "import './browser/helper.js';\n",
    'src/browser/helper.js': "import { chromium } from 'playwright';\n",
  });

  assert.throws(
    () => planServerFiles(join(root, 'src')),
    /Statically reachable module browser\/helper\.js imports "playwright".*dynamic import/,
  );
});

test('a dynamically imported browser backend is not auto-shipped', () => {
  const root = fixture({
    'src/mcp.js': "const backend = await import('./browser/handoff.js');\n",
    'src/browser/handoff.js': 'export const handoff = true;\n',
    'src/browser/shared/static-helper.js': 'export const helper = true;\n',
  });

  assert.deepEqual(planServerFiles(join(root, 'src')), ['mcp.js']);
});

test('the real source tree plans a self-contained, Playwright-free API module graph', () => {
  const plan = planServerFiles(SRC);
  const planned = new Set(plan);

  assert.equal(plan.length, planned.size, 'the plan must not list a file twice');
  assert.ok(planned.has('mcp.js'), 'the MCP server entry point must be shipped');
  assert.ok(!planned.has('cli.js'), 'the CLI must not be shipped');

  for (const rel of plan) {
    const full = join(SRC, ...rel.split('/'));
    assert.ok(existsSync(full), `${rel} is in the plan but does not exist`);
    if (!rel.endsWith('.js')) continue;
    for (const specifier of staticImportSpecifiers(readFileSync(full, 'utf8'), rel)) {
      assert.ok(
        !(specifier === 'playwright' || specifier.startsWith('playwright/') || specifier.startsWith('@playwright/')),
        `${rel} statically imports ${specifier}, which is not installed in the bundle`,
      );
      if (!specifier.startsWith('.')) continue;
      const target = posix(relative(SRC, resolve(SRC, dirname(rel), specifier)));
      assert.ok(planned.has(target), `${rel} imports ${specifier}, but ${target} is missing from the bundle plan`);
    }
  }
});

test('the real tree ships browser/replay modules only when the API entry point reaches them statically', () => {
  const plan = new Set(planServerFiles(SRC));

  // Independent closure over the real files, using only the import scanner.
  const reachable = new Set();
  const queue = ['mcp.js'];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (reachable.has(rel)) continue;
    reachable.add(rel);
    if (!rel.endsWith('.js')) continue;
    const source = readFileSync(join(SRC, ...rel.split('/')), 'utf8');
    for (const specifier of staticImportSpecifiers(source, rel)) {
      if (!specifier.startsWith('.')) continue;
      queue.push(posix(relative(SRC, resolve(SRC, dirname(rel), specifier))));
    }
  }

  for (const rel of walk(SRC)) {
    if (!isOptionalBackend(rel)) continue;
    assert.equal(
      plan.has(rel),
      reachable.has(rel),
      `optional backend ${rel}: shipped=${plan.has(rel)} but statically reachable=${reachable.has(rel)}`,
    );
    if (plan.has(rel)) {
      assert.match(rel, /\.js$/, `only JavaScript modules reachable from the API may ship, not assets: ${rel}`);
    }
  }
});

test('direct-invocation detection canonicalises paths and treats Windows casing as equal', () => {
  const root = fixture({ 'scripts/entry.js': '// entry\n' });
  const entry = join(root, 'scripts', 'entry.js');
  const url = pathToFileURL(entry).href;

  assert.equal(isMainModule(entry, url), true);
  assert.equal(isMainModule(join(root, 'scripts', '..', 'scripts', 'entry.js'), url), true);
  assert.equal(isMainModule(join(root, 'scripts', 'other.js'), url), false);
  assert.equal(isMainModule('', url), false);
  assert.equal(isMainModule(entry, 'not-a-url'), false);
  assert.equal(isMainModule(entry, pathToFileURL(join(root, 'scripts', 'other.js')).href), false);
  assert.equal(isMainModule(entry, url, 'linux'), true);
  if (process.platform === 'win32') {
    assert.equal(isMainModule(entry.toUpperCase(), url), true);
    assert.equal(isMainModule(entry.replace(/entry\.js$/, 'ENTRY.JS'), url), true);
  }
});

test('direct-invocation detection resolves a symlinked entry point', (t) => {
  const root = fixture({ 'scripts/entry.js': '// entry\n' });
  const entry = join(root, 'scripts', 'entry.js');
  const alias = join(root, 'entry-alias.js');
  try {
    symlinkSync(entry, alias, 'file');
  } catch (error) {
    t.skip(`cannot create a symlink in this environment: ${error.code}`);
    return;
  }

  assert.equal(isMainModule(alias, pathToFileURL(entry).href), true);
});

test('the build script leaves no exported state behind and does not build on import', () => {
  // Importing the module above already happened; if it had run the build it would have written dist/mcpb or thrown.
  assert.equal(typeof planServerFiles, 'function');
  assert.equal(typeof copyServerSources, 'function');
  assert.equal(typeof runtimeDependenciesFor, 'function');
  assert.equal(typeof manifestFor, 'function');
  assert.equal(typeof isMainModule, 'function');
  const dist = join(ROOT, 'dist');
  if (existsSync(dist) && existsSync(join(dist, 'mcpb'))) {
    assert.ok(statSync(join(dist, 'mcpb')).isDirectory());
  }
});

test('the planned API-only bundle starts over stdio without browser modules', async (t) => {
  // The real MCPB plan omits src/browser, src/replay, and the local helper module. Starting that
  // exact plan (with --api-only, as the manifest does) must reach initialize and advertise only the
  // 32 Reddit tools. The temp tree lives under the repository so the parent node_modules resolves.
  const root = mkdtempSync(join(ROOT, '.tmp-mcpb-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = copyServerSources({ srcDir: SRC, destDir: join(root, 'src') });
  assert.equal(plan.includes('mcp-browser.js'), false);
  assert.equal(plan.some((rel) => rel.startsWith('browser/')), false);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const entry = join(root, 'src', 'mcp.js');
  const child = spawn(process.execPath, [entry, '--api-only'], {
    env: { ...process.env, REDDIT_CLI_HOME: join(root, 'home'), REDDIT_CLIENT_ID: '', REDDIT_USERNAME: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffered = '';
  let stderr = '';
  const replies = new Map();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      } catch {
        // A non-JSON stdout line is a protocol failure; the assertion below reports the timeout.
      }
    }
  });
  const waitFor = async (id) => {
    const deadline = Date.now() + 15_000;
    while (!replies.has(id)) {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(`MCP bundle did not answer id ${id}. stderr: ${stderr}`);
      }
      await new Promise((done) => setTimeout(done, 25));
    }
    return replies.get(id);
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packaging', version: '0.0.0' } } })}\n`);
    const initialized = await waitFor(1);
    assert.equal(initialized.error, undefined, stderr);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const listed = await waitFor(2);
    assert.equal(listed.result.tools.length, 32);
    assert.equal(listed.result.tools.some((tool) => tool.name.startsWith('reddit_browser_')), false);
    assert.equal(listed.result.tools.some((tool) => tool.name === 'reddit_profiles_list'), false);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
