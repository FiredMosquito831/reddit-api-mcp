import { join } from 'node:path';
import { createActions } from './actions.js';
import { createRedditClient } from './client.js';
import { clientCredentialsGrant, passwordGrant, refreshAccessToken } from './oauth.js';
import { createFileLog, createWriteGuard } from './safety.js';
import { readProfileApiConfig } from './secrets.js';
import { createKeyringStore, createProfileTokenStore } from './store.js';

// Where access tokens come from in each auth mode.
//
// oauth: the refresh token comes from REDDIT_REFRESH_TOKEN when it is set, and from the keychain otherwise.
// Reddit may issue a new refresh token on a refresh, so the newest one is kept for the rest of this process.
// The keychain copy is updated too. A refresh token from the environment is never written anywhere.
export function tokenSourceFor(config, store, fetch = globalThis.fetch, { persistRotation = !config.refreshToken } = {}) {
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
      // An environment-supplied token is never written; a token read from a store is, so rotation
      // survives the process. A profile session opts in explicitly: its token always came from the
      // profile's own OS-store entry, and the newest one must replace it.
      if (persistRotation) await store.setRefreshToken(tokens.refreshToken);
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

// API session for one named profile. Credentials come from that profile's own OS-store refs via
// readProfileApiConfig, never from the process-wide legacy environment, and refresh-token rotation is
// written back to the same profile entry. The returned object deliberately omits the secret-bearing
// config: callers get the client, the profile-bound token store, and read actions only.
//
// Identity is not assumed here. `probe()` on src/backends/api.js verifies the authorized Reddit
// account and derives its account key; a session is authenticated plumbing, not proof of identity.
export async function openApiSession({
  snapshot,
  settings = {},
  secretStore,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  sleep = undefined,
  cacheGeneration = null,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string') {
    throw new TypeError('openApiSession needs a resolved profile snapshot.');
  }
  const config = await readProfileApiConfig(snapshot, { secretStore, settings });
  const store = createProfileTokenStore({ secretStore, profileId: snapshot.id });
  const clientOptions = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    userAgent: config.userAgent,
    store,
    fetch,
    now,
    cacheTtlMs: config.cacheTtlMs,
    maxAttempts: config.maxAttempts,
    readOnly: config.readOnly,
    obtainToken: tokenSourceFor(config, store, fetch, { persistRotation: true }),
    cacheGeneration,
    cacheNamespace: snapshot.id,
  };
  if (sleep !== undefined) clientOptions.sleep = sleep;
  const client = createRedditClient(clientOptions);
  const actions = createActions({ client, footer: config.botFooter, authMode: config.authMode });
  return {
    profileId: snapshot.id,
    alias: snapshot.alias ?? null,
    accountKey: snapshot.accountKey ?? null,
    credentialGeneration: config.credentialGeneration ?? null,
    authMode: config.authMode,
    appOnly: config.authMode === 'app',
    // Public, non-secret runtime text that a backend adapter needs to build the same plans the direct
    // CLI path would send.
    botFooter: config.botFooter,
    client,
    store,
    actions,
    // Nothing durable is held here: tokens live in this client and in the profile's OS-store entry.
    // The lifecycle hook exists so a dispatcher can close a cached backend without special-casing.
    async close() {},
  };
}
