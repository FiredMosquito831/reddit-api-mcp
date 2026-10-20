import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCOPES } from '../src/oauth.js';
import { REQUESTED_SCOPES, SCOPE_CATALOG } from '../src/scopes.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('login requests exactly the scopes the shipped features need', () => {
  assert.deepEqual(
    [...REQUESTED_SCOPES].sort(),
    ['edit', 'history', 'identity', 'mysubreddits', 'read', 'save', 'submit', 'subscribe', 'vote'],
  );
  assert.deepEqual(DEFAULT_SCOPES, REQUESTED_SCOPES);
});

test('every scope in the catalog appears once, with a decision and a reason', () => {
  const names = SCOPE_CATALOG.map((scope) => scope.name);
  assert.equal(new Set(names).size, names.length);
  for (const scope of SCOPE_CATALOG) {
    assert.equal(typeof scope.requested, 'boolean', scope.name);
    assert.ok(scope.why.length > 0, scope.name);
  }
});

test('the scopes command prints every catalog entry with its decision and needs no configuration', async () => {
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, 'scopes'], { env: { ...process.env, REDDIT_CLIENT_ID: '', REDDIT_USERNAME: '' } },
      (error, out) => (error ? reject(error) : resolve(out)));
  });
  assert.match(stdout, /requested  +read/);
  assert.match(stdout, /omitted  +privatemessages/);
  assert.equal(stdout.trim().split('\n').length, SCOPE_CATALOG.length);
});
