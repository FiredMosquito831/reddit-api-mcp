import { join } from 'node:path';
import { createActions } from './actions.js';
import { createRedditClient } from './client.js';
import { clientCredentialsGrant, passwordGrant, refreshAccessToken } from './oauth.js';
import { createFileLog, createWriteGuard } from './safety.js';
import { createKeyringStore } from './store.js';

// Where access tokens come from in each auth mode.
//
// oauth: the refresh token comes from REDDIT_REFRESH_TOKEN when it is set, and from the keychain otherwise.
// Reddit may issue a new refresh token on a refresh, so the newest one is kept for the rest of this process.
// The keychain copy is updated too. A refresh token from the environment is never written anywhere.
export function tokenSourceFor(config, store, fetch = globalThis.fetch) {
  const common = {
    fetch,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    userAgent: config.userAgent,
  };
  if (config.authMode === 'password') {
    return () => passwordGrant({ ...common, username: config.username, password: config.password });
  }
  if (config.authMode === 'app') {
    return () => clientCredentialsGrant(common);
  }
  let current = config.refreshToken;
  return async () => {
    const refreshToken = current || (await store.getRefreshToken());
    if (!refreshToken) throw new Error('Not logged in. Run "reddit-cli login" first.');
    const tokens = await refreshAccessToken({ ...common, refreshToken });
    if (tokens.refreshToken) {
      current = tokens.refreshToken;
      if (!config.refreshToken) await store.setRefreshToken(tokens.refreshToken);
    }
    return tokens;
  };
}

// Builds the token source, the Reddit client, the write guard, and the actions for one configured account.
export function openSession(config) {
  const store = createKeyringStore(config.username);
  const client = createRedditClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    userAgent: config.userAgent,
    store,
    obtainToken: tokenSourceFor(config, store),
    cacheTtlMs: config.cacheTtlMs,
    maxAttempts: config.maxAttempts,
    readOnly: config.authMode === 'app',
  });
  const guard = createWriteGuard({
    log: createFileLog(join(config.homeDir, 'writes.json')),
    minGapMs: config.minGapMs,
    maxWritesPerHour: config.maxWritesPerHour,
  });
  const actions = createActions({
    client,
    guard,
    footer: config.botFooter,
    authMode: config.authMode,
  });
  return { store, client, actions };
}
