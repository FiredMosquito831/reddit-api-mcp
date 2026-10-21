import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_BOT_FOOTER, loadConfig, readLegacyApiConfig, readRuntimeSettings } from '../src/config.js';
import { WRITE_TOOL_NAMES } from '../src/operations.js';

const BASE = { REDDIT_CLIENT_ID: 'client-1', REDDIT_USERNAME: 'alice' };

test('runtime settings succeed with an empty environment and expose only non-secret defaults', () => {
  const settings = readRuntimeSettings({});
  assert.equal(settings.backendPreference, 'auto');
  assert.equal(settings.visibility, 'visible');
  assert.deepEqual(settings.enabledBackends, ['api']);
  assert.equal(settings.confirmations.global, 'off');
  for (const tool of WRITE_TOOL_NAMES) assert.equal(settings.confirmations.perAction[tool], 'off');
  assert.equal(settings.safeMode, 'standard');
  assert.equal(settings.minGapMs, 2_000);
  assert.equal(settings.maxWritesPerHour, 30);
  assert.equal(settings.botFooter, '');
  assert.equal(settings.cacheTtlMs, 60_000);
  assert.equal(settings.maxAttempts, 4);
  assert.equal(settings.homeDir, join(homedir(), '.reddit-cli'));
  assert.deepEqual(settings.browser, { enabled: false, passwordLoginEnabled: false });
  assert.deepEqual(settings.sampling, { enabled: false });

  for (const key of ['clientId', 'clientSecret', 'username', 'password', 'refreshToken', 'userAgent', 'scopes']) {
    assert.equal(Object.hasOwn(settings, key), false, `${key} must not appear in runtime settings`);
  }
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.confirmations));
  assert.ok(Object.isFrozen(settings.confirmations.perAction));
});

test('runtime settings read the same local safety, cache, footer, and home settings as loadConfig', () => {
  const strict = readRuntimeSettings({ REDDIT_CLI_SAFE_MODE: 'strict', REDDIT_CLI_MAX_WRITES_PER_HOUR: '4' });
  assert.equal(strict.safeMode, 'strict');
  assert.equal(strict.minGapMs, 5_000);
  assert.equal(strict.maxWritesPerHour, 4);

  const tuned = readRuntimeSettings({
    REDDIT_CLI_HOME: 'D:/reddit-home',
    REDDIT_CLI_CACHE: 'off',
    REDDIT_CLI_MAX_RETRIES: '0',
    REDDIT_CLI_BOT_FOOTER: 'auto',
  });
  assert.equal(tuned.homeDir, 'D:/reddit-home');
  assert.equal(tuned.cacheTtlMs, 0);
  assert.equal(tuned.maxAttempts, 1);
  assert.equal(tuned.botFooter, DEFAULT_BOT_FOOTER);
  assert.equal(readRuntimeSettings({ REDDIT_CLI_BOT_FOOTER: 'Bot here' }).botFooter, '\n\n---\nBot here');
});

test('runtime settings reject the same invalid safe modes and counts, and treat templates as unset', () => {
  assert.throws(() => readRuntimeSettings({ REDDIT_CLI_SAFE_MODE: 'off' }), /standard or strict/);
  assert.throws(() => readRuntimeSettings({ REDDIT_CLI_SAFE_MODE: 'toString' }), /standard or strict/);
  assert.throws(() => readRuntimeSettings({ REDDIT_CLI_MAX_WRITES_PER_HOUR: '0' }), /at least 1/);

  const templated = readRuntimeSettings({
    REDDIT_CLI_HOME: '${user_config.home}',
    REDDIT_CLI_SAFE_MODE: '${user_config.safe_mode}',
    REDDIT_CLI_CACHE: '${user_config.cache}',
    REDDIT_CLI_BOT_FOOTER: '${user_config.bot_footer}',
  });
  assert.equal(templated.homeDir, join(homedir(), '.reddit-cli'));
  assert.equal(templated.safeMode, 'standard');
  assert.equal(templated.cacheTtlMs, 60_000);
  assert.equal(templated.botFooter, '');
});

test('loadConfig stays the strict legacy API wrapper and still needs a client ID and username', () => {
  assert.throws(() => loadConfig({}), /REDDIT_CLIENT_ID/);
  assert.throws(() => readLegacyApiConfig({}), /REDDIT_CLIENT_ID/);
  assert.throws(() => readLegacyApiConfig({ REDDIT_CLIENT_ID: 'client-1' }), /REDDIT_USERNAME/);
  assert.throws(() => readLegacyApiConfig({ REDDIT_CLIENT_ID: '${user_config.client_id}', REDDIT_USERNAME: 'alice' }), /REDDIT_CLIENT_ID/);
});

test('the legacy API config preserves passwords character for character and template placeholders', () => {
  const config = readLegacyApiConfig({
    ...BASE,
    REDDIT_AUTH_MODE: 'password',
    REDDIT_CLIENT_SECRET: 'secret',
    REDDIT_PASSWORD: ' pw:123456 ',
  });
  assert.equal(config.password, ' pw:123456 ');
  assert.equal(config.clientSecret, 'secret');
  assert.equal(loadConfig({ ...BASE, REDDIT_PASSWORD: '${user_config.password}' }).password, '');

  const full = readLegacyApiConfig({
    ...BASE,
    REDDIT_REFRESH_TOKEN: ' rt ',
    REDDIT_REDIRECT_URI: 'http://localhost:9',
    REDDIT_USER_AGENT: 'custom/1.0',
  });
  assert.equal(full.refreshToken, 'rt');
  assert.equal(full.redirectUri, 'http://localhost:9');
  assert.equal(full.userAgent, 'custom/1.0');
});
