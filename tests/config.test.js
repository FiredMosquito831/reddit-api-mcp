import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BOT_FOOTER, loadConfig } from '../src/config.js';

const BASE = { REDDIT_CLIENT_ID: 'client-1', REDDIT_USERNAME: 'alice' };

test('standard mode is the default: 2 seconds between writes, 30 writes an hour, no footer', () => {
  const config = loadConfig(BASE);
  assert.equal(config.safeMode, 'standard');
  assert.equal(config.minGapMs, 2_000);
  assert.equal(config.maxWritesPerHour, 30);
  assert.equal(config.botFooter, '');
  assert.equal(config.clientSecret, '');
});

test('strict mode tightens the spacing and the hourly cap', () => {
  const config = loadConfig({ ...BASE, REDDIT_CLI_SAFE_MODE: 'strict' });
  assert.equal(config.minGapMs, 5_000);
  assert.equal(config.maxWritesPerHour, 10);
});

test('an explicit hourly cap overrides the mode default', () => {
  const config = loadConfig({ ...BASE, REDDIT_CLI_SAFE_MODE: 'strict', REDDIT_CLI_MAX_WRITES_PER_HOUR: '4' });
  assert.equal(config.maxWritesPerHour, 4);
});

test('an unknown safe mode is rejected, including "off" and inherited names', () => {
  assert.throws(() => loadConfig({ ...BASE, REDDIT_CLI_SAFE_MODE: 'off' }), /standard or strict/);
  assert.throws(() => loadConfig({ ...BASE, REDDIT_CLI_SAFE_MODE: 'toString' }), /standard or strict/);
});

test('the bot footer is off by default; "auto" uses the default text, other text is used as given', () => {
  assert.equal(loadConfig({ ...BASE, REDDIT_CLI_BOT_FOOTER: 'auto' }).botFooter, DEFAULT_BOT_FOOTER);
  assert.equal(loadConfig({ ...BASE, REDDIT_CLI_BOT_FOOTER: 'Bot here' }).botFooter, '\n\n---\nBot here');
});

test('the client secret comes from the environment and is optional', () => {
  assert.equal(loadConfig({ ...BASE, REDDIT_CLIENT_SECRET: ' shh ' }).clientSecret, 'shh');
});
