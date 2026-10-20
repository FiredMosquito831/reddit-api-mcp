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
