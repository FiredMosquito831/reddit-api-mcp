import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_COVERAGE, coverageFor, summarizeCoverage } from '../src/coverage.js';
import { REDDIT_TOOL_NAMES, WRITE_TOOL_NAMES } from '../src/operations.js';
import {
  REPLAY_PINNED_COMMIT,
  REPLAY_READ_TOOLS,
  REPLAY_WRITE_TOOLS,
  UNSUPPORTED_REPLAY_OPERATIONS,
} from '../src/replay/mappings.js';
import { BROWSER_READ_TOOLS, UNSUPPORTED_BROWSER_READS } from '../src/browser/adapters/reads.js';
import { BROWSER_WRITE_TOOLS } from '../src/browser/adapters/writes.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKENDS = ['api', 'replay', 'browser'];
const STATUSES = ['implemented-offline-tested', 'live-verified', 'unsupported', 'not-yet-tested'];

test('the ledger covers all 32 original tools for every meaningful backend', () => {
  assert.equal(REDDIT_TOOL_NAMES.length, 32);
  assert.equal(WRITE_TOOL_NAMES.length, 11);
  assert.deepEqual([...new Set(TOOL_COVERAGE.map((row) => row.tool))].sort(), [...REDDIT_TOOL_NAMES].sort());
  const keys = TOOL_COVERAGE.map((row) => `${row.tool}:${row.backend}`);
  assert.equal(new Set(keys).size, keys.length);

  for (const tool of REDDIT_TOOL_NAMES) {
    if (tool === 'reddit_explain') {
      assert.ok(coverageFor(tool, 'offline'));
      continue;
    }
    if (tool === 'browse_subreddit_rss') {
      assert.ok(coverageFor(tool, 'rss'));
      continue;
    }
    for (const backend of BACKENDS) assert.ok(coverageFor(tool, backend), `${tool} is missing a ${backend} row`);
  }
});

test('every row is dated, typed, and never claims live evidence that does not exist', () => {
  for (const row of TOOL_COVERAGE) {
    assert.ok(STATUSES.includes(row.status), `${row.tool}/${row.backend} has status ${row.status}`);
    assert.equal(row.platform, 'win32');
    assert.equal(row.checkedAt, '2026-10-21');
    assert.ok(Array.isArray(row.missingFields));
    assert.ok(Array.isArray(row.blockers));
    assert.ok(Array.isArray(row.unsupportedParameters), `${row.tool}/${row.backend} lacks an explicit unsupportedParameters list`);
    assert.ok(typeof row.evidenceRef === 'string' && row.evidenceRef.length > 0, `${row.tool}/${row.backend} lacks evidence`);
    if (row.backend === 'replay' || row.backend === 'browser') assert.notEqual(row.status, 'live-verified');
    if (row.status === 'unsupported') assert.ok(row.blockers.length > 0, `${row.tool}/${row.backend} is unsupported without a reason`);
    if (row.status !== 'implemented-offline-tested' && row.backend !== 'offline') {
      assert.ok(row.blockers.length > 0, `${row.tool}/${row.backend} needs a blocker`);
    }
  }
});

test('replay rows mirror the implemented mappings and their pinned upstream evidence', () => {
  for (const tool of [...REPLAY_READ_TOOLS, ...REPLAY_WRITE_TOOLS]) {
    const row = coverageFor(tool, 'replay');
    assert.ok(row, `${tool} has no replay row`);
    assert.equal(row.status, 'implemented-offline-tested', `${tool} is implemented offline but not marked so`);
    assert.match(row.evidenceRef, new RegExp(REPLAY_PINNED_COMMIT));
    assert.ok(row.blockers.some((reason) => /live|experimental|unverified/i.test(reason)), `${tool} hides its unverified status`);
  }
  for (const tool of Object.keys(UNSUPPORTED_REPLAY_OPERATIONS)) {
    const row = coverageFor(tool, 'replay');
    assert.equal(row.status, 'unsupported');
    assert.ok(row.blockers.some((reason) => reason.includes(UNSUPPORTED_REPLAY_OPERATIONS[tool].reason)));
  }
  // Every replay row whose tool is not mapped must be explicitly unsupported, never silently absent.
  for (const tool of REDDIT_TOOL_NAMES) {
    if (['reddit_explain', 'browse_subreddit_rss'].includes(tool)) continue;
    const row = coverageFor(tool, 'replay');
    if (!REPLAY_READ_TOOLS.includes(tool) && !REPLAY_WRITE_TOOLS.includes(tool)) assert.equal(row.status, 'unsupported');
  }
});

test('browser rows match the adapters and record unsupported operations and parameters', () => {
  for (const tool of BROWSER_READ_TOOLS) {
    const row = coverageFor(tool, 'browser');
    assert.ok(row, `${tool} has no browser row`);
    const unsupported = UNSUPPORTED_BROWSER_READS[tool];
    if (unsupported) {
      assert.equal(row.status, 'unsupported', `${tool} cannot be produced by the UI adapters`);
      assert.ok(row.blockers.some((reason) => reason.includes(unsupported.reason)));
    } else {
      assert.equal(row.status, 'implemented-offline-tested');
      assert.ok(row.blockers.some((reason) => /live|selector|unverified/i.test(reason)));
    }
    assert.match(row.evidenceRef, /tests\/browser-/);
  }
  for (const tool of BROWSER_WRITE_TOOLS) {
    const row = coverageFor(tool, 'browser');
    assert.ok(row, `${tool} has no browser row`);
    assert.equal(row.status, 'implemented-offline-tested');
    assert.ok(row.blockers.some((reason) => /live|selector|unverified/i.test(reason)));
  }
  // API paging cursors are not rendered pages: the UI continuation is separate.
  const paged = ['browse_subreddit', 'get_top_posts', 'search_reddit', 'get_user_posts', 'get_user_comments', 'get_my_overview', 'get_my_saved'];
  for (const tool of paged) {
    assert.ok(coverageFor(tool, 'browser').unsupportedParameters.includes('after'), `${tool} must disclose that UI paging is not an API cursor`);
  }
});

test('the summary separates offline scaffolding from a verified no-app route', () => {
  const summary = summarizeCoverage();
  assert.equal(summary.toolCount, 32);
  assert.equal(summary.browserLiveVerified, 0);
  assert.equal(summary.noAppComplete, false);
  assert.ok(summary.implementedOffline >= 30);
  assert.equal(coverageFor('invented', 'api'), null);
});

test('docs/backend-coverage.md lists every ledger row exactly', async () => {
  const doc = await readFile(join(ROOT, 'docs', 'backend-coverage.md'), 'utf8');
  for (const row of TOOL_COVERAGE) {
    const line = `| \`${row.tool}\` | ${row.backend} | ${row.status} |`;
    assert.ok(doc.includes(line), `backend-coverage.md is missing ${line}`);
  }
});

function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

async function markdownFiles() {
  const files = [join(ROOT, 'README.md')];
  for (const dir of ['docs', join('docs', 'experiments')]) {
    const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(ROOT, dir, entry.name));
    }
  }
  return files;
}

async function headingsOf(file) {
  try {
    const text = await readFile(file, 'utf8');
    return [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]));
  } catch {
    return null;
  }
}

test('relative documentation links and anchors resolve', async () => {
  const files = await markdownFiles();
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [pathPart, anchor] = target.split('#');
      const targetFile = pathPart === '' ? file : resolve(dirname(file), pathPart);
      if (pathPart !== '' && !targetFile.toLowerCase().endsWith('.md')) continue;
      const headings = await headingsOf(targetFile);
      assert.ok(headings, `${file} links to missing document ${target}`);
      if (anchor) assert.ok(headings.includes(anchor), `${file} links to missing anchor ${target}`);
    }
  }
});
