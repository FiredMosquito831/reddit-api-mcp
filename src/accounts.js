// Account identity binding for named profiles. The authoritative records live in the profile
// registry (`<home>/profiles.json`), so a username-only UI identity resolves to the same account
// key as a verified t2_ id and no second mapping file can drift. Bindings are conflict-safe: a
// username bound to one Reddit account id, or an id bound to another username, blocks instead of
// merging. `accountKey` is a hash-only, filesystem-safe quota identity shared by every alias of
// one verified account.

import { join } from 'node:path';
import { OperationError } from './errors.js';
import {
  deriveAccountKey,
  normalizeUsername,
  usernameKey,
  validateAccountId,
} from './profiles.js';

export { deriveAccountKey, normalizeUsername, usernameKey, validateAccountId };

const ACCOUNT_KEY_PATTERN = /^acct_[0-9a-f]{32}$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

// Account state directories are derived from the hashed key, never from an alias or username.
export function accountDirName(accountKey) {
  if (typeof accountKey !== 'string' || !ACCOUNT_KEY_PATTERN.test(accountKey)) {
    throw invalid('An account key must be acct_ followed by 32 hex characters.');
  }
  return accountKey;
}

export function accountDir(homeDir, accountKey) {
  if (typeof homeDir !== 'string' || !homeDir) throw invalid('accountDir needs a home directory.');
  return join(homeDir, 'accounts', accountDirName(accountKey));
}

export function createAccountRegistry({ registry } = {}) {
  if (!registry || typeof registry.bindIdentity !== 'function' || typeof registry.listAccounts !== 'function') {
    throw new TypeError('createAccountRegistry needs a profile registry with bindIdentity/listAccounts.');
  }

  async function bind(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalid('bind expects { profileId, accountId?, username }.');
    }
    const { profileId, username } = input;
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw invalid('bind needs a profile id.');
    }
    const accountId = input.accountId === undefined || input.accountId === null
      ? null
      : validateAccountId(input.accountId);
    const normalized = normalizeUsername(username);
    const binding = await registry.bindIdentity(profileId, {
      accountId,
      username: normalized.username,
      accountKey: deriveAccountKey(normalized.key),
    });
    return {
      accountKey: binding.accountKey,
      accountId: binding.accountId,
      username: binding.username,
    };
  }

  async function lookup({ accountId = null, username = null } = {}) {
    if (accountId === null && username === null) {
      throw invalid('lookup needs an accountId or a username.');
    }
    const wantedId = accountId === null ? null : validateAccountId(accountId);
    const wantedName = username === null ? null : usernameKey(username);
    const records = await registry.listAccounts();
    const byId = wantedId === null ? null : records.find((record) => record.accountId === wantedId) || null;
    const byName = wantedName === null ? null : records.find((record) => usernameKey(record.username) === wantedName) || null;
    if (wantedId !== null && wantedName !== null) {
      // Two identifiers supplied: they must agree, or the caller gets a conflict instead of a guess.
      if (!byId || !byName || byId.accountKey !== byName.accountKey) {
        throw new OperationError(
          'IDENTITY_MISMATCH',
          'The supplied account id and username do not identify the same stored account.',
          { safeDetails: { accountId: wantedId, username: wantedName } },
        );
      }
      return byId;
    }
    return wantedId !== null ? byId : byName;
  }

  async function list() {
    return registry.listAccounts();
  }

  return {
    bind,
    lookup,
    list,
    dirName: accountDirName,
    accountDir: (homeDir, accountKey) => accountDir(homeDir, accountKey),
  };
}
