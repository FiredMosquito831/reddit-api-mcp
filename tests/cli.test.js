import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const UNCONFIGURED = { REDDIT_CLIENT_ID: '', REDDIT_USERNAME: '' };

test('--help lists the commands', async () => {
  const { code, stdout } = await run(['--help']);
  assert.equal(code, 0);
  for (const command of ['login', 'feed', 'post', 'vote', 'subscribe', 'api']) {
    assert.match(stdout, new RegExp(command));
  }
});

test('commands fail with a clear message when the environment is not configured', async () => {
  const { code, stderr } = await run(['whoami'], UNCONFIGURED);
  assert.equal(code, 1);
  assert.match(stderr, /REDDIT_CLIENT_ID/);
});

test('a dry run prints the request and needs no credentials', async () => {
  const { code, stdout } = await run(
    ['post', 'node', '--title', 'Hello', '--text', 'Body', '--dry-run'],
    UNCONFIGURED,
  );
  assert.equal(code, 0);
  assert.match(stdout, /Dry run: nothing was sent/);
  assert.match(stdout, /"subreddit": "node"/);
});
