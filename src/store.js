import { Entry } from '@napi-rs/keyring';

const SERVICE = 'reddit-cli';

// The refresh token is the only credential this CLI keeps. It lives in the OS credential store
// (Windows Credential Manager, macOS Keychain, or libsecret), keyed by Reddit username.
export function createKeyringStore(username) {
  const entry = new Entry(SERVICE, username.toLowerCase());
  return {
    async getRefreshToken() {
      return entry.getPassword(); // null when nothing is stored
    },
    async setRefreshToken(token) {
      entry.setPassword(token);
    },
    async clear() {
      entry.deletePassword(); // false when nothing was stored, which is fine
    },
  };
}

// The same token-store shape, backed by one profile's namespaced OS-store entry. `tokenSourceFor`
// accepts either adapter unchanged, so refresh-token rotation can be wired to a named profile
// without the legacy username-keyed service or an environment token entering the picture.
export function createProfileTokenStore({ secretStore, profileId } = {}) {
  if (!secretStore || typeof secretStore.ref !== 'function') {
    throw new TypeError('createProfileTokenStore needs a profile secret store.');
  }
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new TypeError('createProfileTokenStore needs a profile id.');
  }
  const ref = secretStore.ref(profileId, 'refreshToken');
  return {
    async getRefreshToken() {
      return secretStore.get(ref);
    },
    async setRefreshToken(token) {
      await secretStore.set(ref, token);
    },
    async clear() {
      return secretStore.delete(ref);
    },
  };
}
