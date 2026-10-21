import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SCOPES, parseScopes } from './oauth.js';
import { WRITE_TOOL_NAMES } from './operations.js';

export const VERSION = '0.1.0';
export const DEFAULT_BOT_FOOTER = '\n\n---\nI am a bot, posted with reddit-cli.';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const TEMPLATE_RE = /^\$\{[^}]*\}$/;
const AUTH_MODES = ['oauth', 'password', 'app'];
const SAFE_MODES = {
  standard: { minGapMs: 2_000, maxWritesPerHour: 30 },
  strict: { minGapMs: 5_000, maxWritesPerHour: 10 },
};
const DEFAULT_BACKENDS = Object.freeze(['api']);

// A host that fills settings from its own configuration can leave the template text in place when the user
// left a field empty. That text counts as "not set", so it can never become a credential or a footer.
function isTemplate(text) {
  return TEMPLATE_RE.test(text.trim());
}

function intFrom(value, fallback, min) {
  if (value === '') return fallback;
  const number = Number.parseInt(value, 10);
  if (!(number >= min)) throw new Error(`Expected a whole number of at least ${min}, got: ${value}`);
  return number;
}

// Empty turns the footer off, "auto" uses the default text, anything else is used as the footer text.
function botFooterFrom(value) {
  if (value === '') return '';
  if (value.toLowerCase() === 'auto') return DEFAULT_BOT_FOOTER;
  return `\n\n---\n${value}`;
}

// Settings come from the environment. Secrets are read here and never written to disk or logged.
function envGetter(env) {
  return (key) => {
    const raw = env[key];
    if (raw === undefined) return '';
    const text = String(raw).trim();
    return isTemplate(text) ? '' : text;
  };
}

export function loadConfig(env = process.env) {
  const get = envGetter(env);
  // A password keeps its exact characters, so only the template check applies to it.
  const rawPassword = env.REDDIT_PASSWORD ?? '';
  const password = rawPassword !== '' && !isTemplate(rawPassword) ? rawPassword : '';

  const authMode = get('REDDIT_AUTH_MODE') || 'oauth';
  if (!AUTH_MODES.includes(authMode)) throw new Error('REDDIT_AUTH_MODE must be oauth, password, or app.');
  const clientId = get('REDDIT_CLIENT_ID');
  const clientSecret = get('REDDIT_CLIENT_SECRET');
  const username = get('REDDIT_USERNAME').replace(/^u\//i, '');
  if (!clientId) throw new Error("Set REDDIT_CLIENT_ID to your Reddit app's client ID.");
  if (!username || !USERNAME_RE.test(username)) {
    throw new Error('Set REDDIT_USERNAME to your Reddit username (3-20 letters, digits, _ or -).');
  }
  if (authMode !== 'oauth' && !clientSecret) {
    throw new Error(`REDDIT_AUTH_MODE=${authMode} needs REDDIT_CLIENT_SECRET, which script and web apps have.`);
  }
  if (authMode === 'password' && !password) {
    throw new Error('REDDIT_AUTH_MODE=password needs REDDIT_PASSWORD. With two-factor on, put ":CODE" after the password.');
  }
  const safeMode = get('REDDIT_CLI_SAFE_MODE') || 'standard';
  if (!Object.hasOwn(SAFE_MODES, safeMode)) throw new Error('REDDIT_CLI_SAFE_MODE must be standard or strict.');
  const mode = SAFE_MODES[safeMode];
  const scopes = get('REDDIT_SCOPES');
  return {
    authMode,
    clientId,
    clientSecret,
    username,
    password,
    refreshToken: get('REDDIT_REFRESH_TOKEN'),
    redirectUri: get('REDDIT_REDIRECT_URI') || 'http://localhost:8080',
    scopes: scopes ? parseScopes(scopes) : DEFAULT_SCOPES,
    userAgent: get('REDDIT_USER_AGENT') || `node:reddit-cli:${VERSION} (by /u/${username})`,
    homeDir: get('REDDIT_CLI_HOME') || join(homedir(), '.reddit-cli'),
    safeMode,
    minGapMs: mode.minGapMs,
    maxWritesPerHour: intFrom(get('REDDIT_CLI_MAX_WRITES_PER_HOUR'), mode.maxWritesPerHour, 1),
    botFooter: botFooterFrom(get('REDDIT_CLI_BOT_FOOTER')),
    cacheTtlMs: get('REDDIT_CLI_CACHE').toLowerCase() === 'off' ? 0 : 60_000,
    maxAttempts: intFrom(get('REDDIT_CLI_MAX_RETRIES'), 3, 0) + 1,
  };
}

// Runtime, non-secret settings that every backend shares. Reading these never needs Reddit API
// credentials and never touches the keychain, so an unconfigured machine can still start, report
// diagnostics, and describe offline/RSS operations. Confirmation policy starts off, visibility starts
// visible, and backend selection starts on auto with only the official API enabled.
export function readRuntimeSettings(env = process.env) {
  const get = envGetter(env);
  const safeMode = get('REDDIT_CLI_SAFE_MODE') || 'standard';
  if (!Object.hasOwn(SAFE_MODES, safeMode)) throw new Error('REDDIT_CLI_SAFE_MODE must be standard or strict.');
  const mode = SAFE_MODES[safeMode];
  return Object.freeze({
    homeDir: get('REDDIT_CLI_HOME') || join(homedir(), '.reddit-cli'),
    safeMode,
    minGapMs: mode.minGapMs,
    maxWritesPerHour: intFrom(get('REDDIT_CLI_MAX_WRITES_PER_HOUR'), mode.maxWritesPerHour, 1),
    botFooter: botFooterFrom(get('REDDIT_CLI_BOT_FOOTER')),
    cacheTtlMs: get('REDDIT_CLI_CACHE').toLowerCase() === 'off' ? 0 : 60_000,
    maxAttempts: intFrom(get('REDDIT_CLI_MAX_RETRIES'), 3, 0) + 1,
    backendPreference: 'auto',
    enabledBackends: DEFAULT_BACKENDS,
    visibility: 'visible',
    confirmations: Object.freeze({
      global: 'off',
      perAction: Object.freeze(Object.fromEntries(WRITE_TOOL_NAMES.map((tool) => [tool, 'off']))),
    }),
    browser: Object.freeze({ enabled: false, passwordLoginEnabled: false }),
    sampling: Object.freeze({ enabled: false }),
  });
}

// The existing environment-only API configuration, unchanged. This stays strict: it needs a client ID
// and username, and is the fallback identity the named-profile registry can migrate from explicitly.
export function readLegacyApiConfig(env = process.env) {
  return loadConfig(env);
}
