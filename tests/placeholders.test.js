import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = { REDDIT_CLIENT_ID: 'client-1', REDDIT_USERNAME: 'alice' };

test('a template the host left unfilled counts as an empty setting', () => {
  const config = loadConfig({
    ...BASE,
    REDDIT_REFRESH_TOKEN: '${user_config.refresh_token}',
    REDDIT_PASSWORD: '${user_config.password}',
    REDDIT_CLI_BOT_FOOTER: '${user_config.bot_footer}',
    REDDIT_CLI_SAFE_MODE: '${user_config.safe_mode}',
    REDDIT_CLI_CACHE: '${user_config.cache}',
  });
  assert.equal(config.refreshToken, '');
  assert.equal(config.password, '');
  assert.equal(config.botFooter, '');
  assert.equal(config.safeMode, 'standard');
  assert.equal(config.cacheTtlMs, 60_000);
});

test('an unfilled client ID is treated as missing, not used as an ID', () => {
  assert.throws(
    () => loadConfig({ REDDIT_CLIENT_ID: '${user_config.client_id}', REDDIT_USERNAME: 'alice' }),
    /REDDIT_CLIENT_ID/,
  );
});

test('a password keeps its exact characters', () => {
  const config = loadConfig({ ...BASE, REDDIT_AUTH_MODE: 'password', REDDIT_CLIENT_SECRET: 's', REDDIT_PASSWORD: ' pw:123456 ' });
  assert.equal(config.password, ' pw:123456 ');
});
