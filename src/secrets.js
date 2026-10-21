// Profile-owned secrets and authenticated session state.
//
// A named profile keeps its secrets in the OS credential store under its own service and opaque,
// deterministic refs. The profile registry itself stores only public API metadata, so a client
// secret or refresh token never enters profiles.json. The OS store is used for small values only
// (a refresh token, an app secret, a per-profile encryption key); a full browser storage-state
// document is sealed with AES-256-GCM and written by callers that own the protected file path.
//
// Errors from this module are deliberately generic: a failed read/write names the ref at most and
// never echoes a secret value, an underlying store message, or decrypted bytes.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { VERSION } from './config.js';
import { OperationError } from './errors.js';
import { DEFAULT_SCOPES } from './oauth.js';

export const PROFILE_SECRET_SERVICE = 'reddit-cli-profile';
// Credential Manager entries are small. Keep the keyring payload to a token-sized value; session
// state is sealed separately and never stored whole in one entry.
export const MAX_SECRET_BYTES = 2048;

const REF_PREFIX = 'reddit-cli:profile:';
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET_NAME_PATTERN = /^[a-z][A-Za-z0-9_-]{0,63}$/;

const SEAL_MAGIC = Buffer.from('RSES', 'ascii');
const SEAL_HEADER_BYTES = SEAL_MAGIC.length + 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEAL_MIN_BYTES = SEAL_HEADER_BYTES + NONCE_BYTES + TAG_BYTES + 1;

function codedError(code, message, safeDetails = undefined) {
  const error = new Error(message);
  error.code = code;
  if (safeDetails !== undefined) error.safeDetails = safeDetails;
  return error;
}

function invalid(message) {
  return codedError('INVALID_ARGUMENT', message);
}

function secretStoreError(ref, action) {
  return codedError(
    'SECRET_STORE_UNAVAILABLE',
    `The OS secret store could not ${action} this profile secret.`,
    { ref },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertProfileId(profileId) {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw invalid('A profile id must be 1-128 letters, digits, _ or -.');
  }
  return profileId;
}

function assertSecretName(name) {
  if (typeof name !== 'string' || !SECRET_NAME_PATTERN.test(name)) {
    throw invalid('A secret name must start with a lowercase letter and use only letters, digits, _ or -.');
  }
  return name;
}

// The public form of a secret reference. It is safe to put in non-secret metadata: it names the
// profile and the kind of secret, never its value.
export function ref(profileId, name) {
  return `${REF_PREFIX}${assertProfileId(profileId)}:${assertSecretName(name)}`;
}

function parseRef(value) {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) {
    throw invalid('A profile secret ref must come from this profile secret store.');
  }
  const remainder = value.slice(REF_PREFIX.length);
  const separator = remainder.indexOf(':');
  if (separator <= 0 || remainder.indexOf(':', separator + 1) !== -1) {
    throw invalid('A profile secret ref is malformed.');
  }
  return {
    profileId: assertProfileId(remainder.slice(0, separator)),
    name: assertSecretName(remainder.slice(separator + 1)),
  };
}

function entryAccount(parsed) {
  return `${parsed.profileId}:${parsed.name}`;
}

// A class has to be constructed with `new`; calling one throws (or, for a native/napi class, returns
// undefined). Detect classes structurally and by source text rather than assuming every function is
// a plain factory.
function isEntryClass(value) {
  if (typeof value !== 'function') return false;
  const prototype = value.prototype;
  if (prototype && typeof prototype.getPassword === 'function' && typeof prototype.setPassword === 'function') {
    return true;
  }
  try {
    return /^\s*class\b/.test(Function.prototype.toString.call(value));
  } catch {
    return false;
  }
}

function constructEntry(EntryClass) {
  return isEntryClass(EntryClass)
    ? (service, account) => new EntryClass(service, account)
    : (service, account) => EntryClass(service, account);
}

// Accept the `Entry` class, an `{ Entry }` module shape, or a plain factory. Tests inject a factory
// so no test can reach the real OS credential store.
function normalizeKeyringFactory(keyring) {
  if (keyring === undefined || keyring === null) {
    return (service, account) => new Entry(service, account);
  }
  if (typeof keyring === 'function') return constructEntry(keyring);
  if (keyring && typeof keyring === 'object' && typeof keyring.Entry === 'function') {
    return constructEntry(keyring.Entry);
  }
  throw new TypeError('keyring must be an Entry class, an Entry factory, or { Entry }.');
}

function assertSecretValue(value) {
  if (typeof value !== 'string') throw invalid('A profile secret must be a string.');
  if (value.length === 0) throw invalid('A profile secret may not be empty.');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SECRET_BYTES) {
    throw codedError(
      'SECRET_TOO_LARGE',
      `This secret is too large for a single OS-store entry (limit ${MAX_SECRET_BYTES} bytes). ` +
        'Store session state as a sealed file instead.',
    );
  }
  return value;
}

export function createProfileSecretStore({ keyring } = {}) {
  const factory = normalizeKeyringFactory(keyring);

  async function entryFor(value, action) {
    const parsed = parseRef(value);
    let entry;
    try {
      entry = await factory(PROFILE_SECRET_SERVICE, entryAccount(parsed));
    } catch {
      throw secretStoreError(value, action);
    }
    if (!entry || typeof entry.getPassword !== 'function' || typeof entry.setPassword !== 'function') {
      throw secretStoreError(value, action);
    }
    return entry;
  }

  return {
    ref,
    async get(value) {
      const entry = await entryFor(value, 'read');
      try {
        const secret = await entry.getPassword();
        return secret === undefined ? null : secret;
      } catch {
        throw secretStoreError(value, 'read');
      }
    },
    async set(value, secret) {
      assertSecretValue(secret);
      const entry = await entryFor(value, 'write');
      try {
        await entry.setPassword(secret);
      } catch {
        throw secretStoreError(value, 'write');
      }
    },
    async delete(value) {
      const entry = await entryFor(value, 'delete');
      try {
        return Boolean(await entry.deletePassword());
      } catch {
        throw secretStoreError(value, 'delete');
      }
    },
  };
}

// A 32-byte AES-256 key, either as bytes or as the base64/hex text a credential entry returns.
function sessionKey(key) {
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) {
    if (key.length !== 32) throw invalid('A session key must be exactly 32 bytes.');
    return Buffer.from(key);
  }
  if (typeof key === 'string') {
    const hex = /^[0-9a-fA-F]{64}$/.test(key);
    if (hex) return Buffer.from(key, 'hex');
    const base64 = /^[A-Za-z0-9+/_-]{43}=?$/.test(key);
    if (base64) {
      const decoded = Buffer.from(key, 'base64');
      if (decoded.length === 32) return decoded;
    }
  }
  throw invalid('A session key must be 32 bytes, base64, or hex.');
}

function sealVersion(version) {
  const value = version === undefined ? 1 : version;
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw invalid('A session-state version must be an integer from 1 to 255.');
  }
  return value;
}

function associatedData(version, profileId) {
  assertProfileId(profileId);
  return Buffer.from(`reddit-cli:session:v${version}:${profileId}`, 'utf8');
}

function sessionInvalid() {
  return codedError('SESSION_STATE_INVALID', 'The stored session state could not be authenticated.');
}

// Encrypt an optional exported session document. The profile id and format version are authenticated
// associated data, so ciphertext refused for one profile cannot be opened as another.
export function sealSession(value, { key, profileId, version } = {}) {
  if (!isPlainObject(value)) throw invalid('Session state must be a plain object.');
  const bytes = sessionKey(key);
  const formatVersion = sealVersion(version);
  const aad = associatedData(formatVersion, profileId);
  let plaintext;
  try {
    plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw invalid('Session state must be JSON-serializable.');
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', bytes, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([SEAL_MAGIC, Buffer.from([formatVersion]), nonce, tag, ciphertext]);
}

export function openSessionState(buffer, { key, profileId, version } = {}) {
  const bytes = sessionKey(key);
  const formatVersion = sealVersion(version);
  const aad = associatedData(formatVersion, profileId);
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw sessionInvalid();
  const data = Buffer.from(buffer);
  if (data.length < SEAL_MIN_BYTES) throw sessionInvalid();
  if (!data.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) throw sessionInvalid();
  if (data[SEAL_MAGIC.length] !== formatVersion) throw sessionInvalid();

  const nonceStart = SEAL_HEADER_BYTES;
  const tagStart = nonceStart + NONCE_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const nonce = data.subarray(nonceStart, tagStart);
  const tag = data.subarray(tagStart, ciphertextStart);
  const ciphertext = data.subarray(ciphertextStart);

  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', bytes, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw sessionInvalid();
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw sessionInvalid();
  }
  if (!isPlainObject(parsed)) throw sessionInvalid();
  return parsed;
}

// A cookie header, JSON field, or log line may hold several pairs. The whole value is secret, so
// redact it as one unit before the generic key/value pass can stop at the first `;`.
const COOKIE_VALUE = /(\b(?:set[_-]?cookie|cookie)\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n]+)/gi;

// Credential fields appear bare (`refresh_token=...`), inside headers (`Authorization: ...`), and in
// JSON (`"refresh_token":"..."`). Match an optional quoted key and a quoted or bare value, so a
// serialized token-endpoint error is covered as well as a `key=value` spelling.
const SECRET_ASSIGNMENT = /(["']?)\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|api[_-]?key|authorization|proxy[_-]?authorization|session[_-]?key|session|secret)\b(["']?)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}]+)/gi;

function redactedValue(value) {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return quote ? `${quote}[REDACTED]${quote}` : '[REDACTED]';
}

// Redact values that must never reach logs, errors, or model-visible observations. Callers pass
// known secret literals; the patterns catch the usual credential spellings as a backstop.
export function redactSecrets(value, secrets = []) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[REDACTED]');
  }
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(COOKIE_VALUE, (match, prefix) => `${prefix}[REDACTED]`);
  text = text.replace(
    SECRET_ASSIGNMENT,
    (match, openQuote, key, closeQuote, separator, secretValue) =>
      `${openQuote}${key}${closeQuote}${separator}${redactedValue(secretValue)}`,
  );
  return text;
}

// Build the official-API configuration for one resolved profile. Everything comes from the frozen
// snapshot and that profile's own OS-store entries: a named profile never inherits REDDIT_REFRESH_TOKEN,
// REDDIT_PASSWORD, or any other process-wide legacy value. A stored browser password is deliberately
// not read here; it is enrollment data for the browser backend, not an API grant.
//
// SECURITY: the returned object carries plaintext `clientSecret` and `refreshToken`, because
// `tokenSourceFor` needs them. It is shaped like ordinary config, but it is secret-bearing: never log
// it, never place it in `OperationError.safeDetails` (whose contract excludes secrets), and never
// return it to a tool caller. Callers must `await` it; profile secrets live in the OS store.
//
// Codes this module and `migration.js` can raise that are not in `OPERATION_ERROR_CODES`
// (`INVALID_ARGUMENT`, `SECRET_STORE_UNAVAILABLE`, `SECRET_TOO_LARGE`, `SESSION_STATE_INVALID`,
// `ALIAS_TAKEN`) must be classified or mapped at the operation dispatcher boundary.
export async function readProfileApiConfig(snapshot, { secretStore, settings = {} } = {}) {
  if (!isPlainObject(snapshot) || typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
    throw invalid('readProfileApiConfig needs a resolved profile snapshot.');
  }
  if (!secretStore || typeof secretStore.get !== 'function' || typeof secretStore.ref !== 'function') {
    throw new TypeError('readProfileApiConfig needs a profile secret store.');
  }
  assertProfileId(snapshot.id);
  const runtime = settings && typeof settings === 'object' ? settings : {};
  const api = isPlainObject(snapshot.api) ? snapshot.api : {};
  const clientId = typeof api.clientId === 'string' && api.clientId.length > 0 ? api.clientId : null;
  if (!clientId) {
    throw new OperationError(
      'BACKEND_UNAVAILABLE',
      'This profile has no API client ID, and a named profile does not inherit environment credentials.',
      { safeDetails: { profileId: snapshot.id, alias: snapshot.alias ?? null } },
    );
  }

  const storedAppType = api.appType ?? null;
  if (storedAppType !== null && !['script', 'web', 'installed'].includes(storedAppType)) {
    throw invalid('The profile app type must be script, web, installed, or null.');
  }

  const clientSecret = (await secretStore.get(secretStore.ref(snapshot.id, 'clientSecret'))) || '';
  const refreshToken = (await secretStore.get(secretStore.ref(snapshot.id, 'refreshToken'))) || '';
  const appType = storedAppType ?? (clientSecret ? 'script' : 'installed');

  let explicitMode = runtime.apiAuthMode;
  if (explicitMode !== undefined && explicitMode !== null && !['oauth', 'app'].includes(explicitMode)) {
    throw invalid('A profile API auth mode must be oauth or app; profile passwords are never stored.');
  }
  // A profile with app credentials but no user grant and no bound human account is app-only. A bound
  // account without a token is an OAuth profile that still needs login, not an app-only substitute.
  const authMode = explicitMode
    || (refreshToken ? 'oauth' : appType !== 'installed' && clientSecret && !snapshot.accountKey ? 'app' : 'oauth');

  if (authMode === 'app') {
    if (appType === 'installed' || !clientSecret) {
      throw new OperationError(
        'BACKEND_UNAVAILABLE',
        'An app-only profile needs a script or web app client secret stored for this profile.',
        { safeDetails: { profileId: snapshot.id, appType } },
      );
    }
  } else if (appType !== 'installed' && !clientSecret) {
    throw new OperationError(
      'BACKEND_UNAVAILABLE',
      'This confidential Reddit app needs its client secret stored for this profile.',
      { safeDetails: { profileId: snapshot.id, appType } },
    );
  }

  const username = typeof snapshot.username === 'string' && snapshot.username.length > 0 ? snapshot.username : null;
  const userAgent = typeof runtime.userAgent === 'string' && runtime.userAgent.length > 0
    ? runtime.userAgent
    : username
      ? `node:reddit-cli:${VERSION} (by /u/${username})`
      : `node:reddit-cli:${VERSION}`;

  return {
    profileId: snapshot.id,
    accountKey: snapshot.accountKey ?? null,
    authMode,
    appType,
    appOnly: authMode === 'app',
    clientId,
    clientSecret,
    // Never sourced from the environment, and never a stored browser password.
    username,
    password: '',
    refreshToken,
    redirectUri: runtime.redirectUri || 'http://localhost:8080',
    scopes: Array.isArray(runtime.scopes) && runtime.scopes.length > 0 ? [...runtime.scopes] : [...DEFAULT_SCOPES],
    userAgent,
    homeDir: runtime.homeDir ?? null,
    safeMode: runtime.safeMode ?? 'standard',
    minGapMs: runtime.minGapMs ?? 2_000,
    maxWritesPerHour: runtime.maxWritesPerHour ?? 30,
    botFooter: runtime.botFooter ?? '',
    cacheTtlMs: runtime.cacheTtlMs ?? 60_000,
    maxAttempts: runtime.maxAttempts ?? 4,
    readOnly: authMode === 'app',
    credentialGeneration: snapshot.credentialGeneration ?? 1,
  };
}
