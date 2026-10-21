// Explicit, local migration from the environment-only legacy configuration into one named profile.
//
// Ordering matters: the caller's verifier runs before any registry or secret-store mutation, the
// legacy keychain entry and write history are never deleted or reassigned, and a failure at any
// later point rolls back the profile (and any secrets) this import created. Nothing is guessed about
// identity: a verifier that returns a different username/account id, or an invalid id, aborts.

import { OperationError } from './errors.js';
import {
  deriveAccountKey,
  normalizeUsername,
  usernameKey,
  validateAccountId,
} from './profiles.js';

const APP_TYPES = new Set(['script', 'web', 'installed']);

function codedError(code, message, safeDetails = undefined) {
  const error = new Error(message);
  error.code = code;
  if (safeDetails !== undefined) error.safeDetails = safeDetails;
  return error;
}

function invalid(message) {
  return codedError('INVALID_ARGUMENT', message);
}

function requireRegistry(registry) {
  if (!registry || typeof registry.add !== 'function' || typeof registry.update !== 'function'
    || typeof registry.remove !== 'function' || typeof registry.get !== 'function') {
    throw new TypeError('importLegacyProfile needs a profile registry.');
  }
}

function requireAccounts(accounts) {
  if (!accounts || typeof accounts.bind !== 'function') {
    throw new TypeError('importLegacyProfile needs an account registry.');
  }
}

function normalizeVerifiedIdentity(verified, legacyUsername, appOnly) {
  if (appOnly && (verified === null || verified === undefined || verified === true)) {
    return { username: null, accountId: null };
  }
  if (verified === true) return { username: legacyUsername, accountId: null };
  if (!verified || typeof verified !== 'object' || Array.isArray(verified)) {
    throw new OperationError(
      'IDENTITY_MISMATCH',
      'Identity verification did not return the signed-in account.',
      { safeDetails: { username: legacyUsername } },
    );
  }
  const rawUsername = verified.username;
  if (typeof rawUsername !== 'string' || rawUsername.length === 0) {
    throw new OperationError(
      'IDENTITY_MISMATCH',
      'Identity verification did not return a username.',
      { safeDetails: { username: legacyUsername } },
    );
  }
  const normalized = normalizeUsername(rawUsername).username;
  if (usernameKey(normalized) !== usernameKey(legacyUsername)) {
    throw new OperationError(
      'IDENTITY_MISMATCH',
      'The verified account does not match the legacy configuration username.',
      { safeDetails: { expectedUsername: legacyUsername } },
    );
  }
  const accountId = verified.accountId === undefined || verified.accountId === null
    ? null
    : validateAccountId(verified.accountId);
  return { username: normalized, accountId };
}

function inferredAppType(legacyConfig, explicit) {
  const appType = explicit ?? (
    legacyConfig.authMode === 'app' || legacyConfig.clientSecret ? 'script' : 'installed'
  );
  if (!APP_TYPES.has(appType)) throw invalid('appType must be script, web, or installed.');
  return appType;
}

export async function importLegacyProfile({
  registry,
  accounts,
  secretStore,
  legacyConfig,
  legacyStore,
  verifyIdentity,
  alias,
  appType,
} = {}) {
  requireRegistry(registry);
  requireAccounts(accounts);
  if (!secretStore || typeof secretStore.ref !== 'function' || typeof secretStore.set !== 'function') {
    throw new TypeError('importLegacyProfile needs a profile secret store.');
  }
  if (!legacyConfig || typeof legacyConfig !== 'object') {
    throw new TypeError('importLegacyProfile needs the legacy configuration.');
  }
  if (typeof verifyIdentity !== 'function') {
    throw new TypeError('importLegacyProfile needs a verifyIdentity function.');
  }
  const clientId = legacyConfig.clientId;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw invalid('The legacy configuration has no client ID to import.');
  }
  if (typeof legacyConfig.username !== 'string' || legacyConfig.username.length === 0) {
    throw invalid('The legacy configuration has no username to import.');
  }
  const legacyUsername = normalizeUsername(legacyConfig.username).username;
  const cleanAlias = alias ?? legacyUsername;
  if (typeof cleanAlias !== 'string' || cleanAlias.length === 0) {
    throw invalid('A migration alias must be a non-empty string.');
  }

  // Read the legacy credential without mutating anything. An environment token has the same
  // precedence it has in tokenSourceFor and is never written anywhere, so only a keychain token needs
  // re-reading after verification.
  const environmentToken = typeof legacyConfig.refreshToken === 'string' ? legacyConfig.refreshToken : '';
  const keychainReadable = typeof legacyStore?.getRefreshToken === 'function';
  let refreshToken = environmentToken;
  if (!refreshToken && keychainReadable) {
    refreshToken = (await legacyStore.getRefreshToken()) || '';
  }

  const verified = await verifyIdentity({
    authMode: legacyConfig.authMode,
    clientId,
    clientSecret: legacyConfig.clientSecret ?? '',
    username: legacyUsername,
    password: legacyConfig.password ?? '',
    refreshToken,
    redirectUri: legacyConfig.redirectUri,
    scopes: legacyConfig.scopes,
    userAgent: legacyConfig.userAgent,
  });
  const identity = normalizeVerifiedIdentity(verified, legacyUsername, legacyConfig.authMode === 'app');
  const resolvedAppType = inferredAppType(legacyConfig, appType);

  // Verification may have used the legacy keychain session and rotated the refresh token (Reddit
  // issues a new one on refresh). Copy what is stored now, not the pre-verification value. A failed
  // re-read aborts before any mutation rather than importing a stale token.
  if (!environmentToken && keychainReadable) {
    refreshToken = (await legacyStore.getRefreshToken()) || '';
  }

  // An alias already owned by the same verified account is an idempotent re-run. Any other conflict
  // fails before anything is written.
  let existing = null;
  try {
    existing = await registry.get(cleanAlias);
  } catch (error) {
    if (error.code !== 'PROFILE_NOT_FOUND') throw error;
  }
  if (existing) {
    const sameClient = existing.api?.clientId === clientId;
    const expectedKey = identity.username
      ? deriveAccountKey(usernameKey(identity.username))
      : null;
    if (sameClient && expectedKey && existing.accountKey === expectedKey) return existing.id;
    if (sameClient && !expectedKey && existing.accountKey === null) return existing.id;
    // Same alias/account but a different (or missing) app configuration means the import would copy
    // nothing usable; fail loudly instead of reporting a misleading success.
    throw codedError(
      'ALIAS_TAKEN',
      `A profile with the alias "${cleanAlias}" already exists with a different API client id.`,
    );
  }

  let profileId = null;
  const written = [];
  try {
    const created = await registry.add({
      alias: cleanAlias,
      expectedUsername: identity.username,
    });
    profileId = created.id;
    await registry.update(
      profileId,
      { api: { clientId, appType: resolvedAppType } },
      { expectedGeneration: created.generation },
    );
    if (identity.username) {
      await accounts.bind({
        profileId,
        username: identity.username,
        accountId: identity.accountId,
      });
    }

    if (typeof legacyConfig.clientSecret === 'string' && legacyConfig.clientSecret.length > 0) {
      const secretRef = secretStore.ref(profileId, 'clientSecret');
      await secretStore.set(secretRef, legacyConfig.clientSecret);
      written.push(secretRef);
    }
    // The legacy password is environment-only. It is used for verification above and never stored;
    // a browser password is a separate, explicit enrollment.
    if (refreshToken) {
      const secretRef = secretStore.ref(profileId, 'refreshToken');
      await secretStore.set(secretRef, refreshToken);
      written.push(secretRef);
    }
    return profileId;
  } catch (error) {
    for (const secretRef of written.reverse()) {
      try {
        await secretStore.delete(secretRef);
      } catch {
        // Best effort: the original failure is the actionable one.
      }
    }
    if (profileId) {
      try {
        await registry.remove(profileId, { approved: true });
      } catch {
        // Best effort rollback; never mask the original error.
      }
    }
    throw error;
  }
}
