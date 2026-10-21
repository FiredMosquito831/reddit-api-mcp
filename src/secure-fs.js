// Atomic local replacement and Windows protected-root checks for Reddit CLI state.
// Plain JS on purpose: secrets never flow through this module, only paths and ACL metadata.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const defaultFs = { lstat, mkdir, realpath, rename, unlink, writeFile };
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Windows file replacement transiently fails while a scanner or another handle briefly holds
// the destination. Only these codes are worth retrying, and only a bounded number of times.
const RETRYABLE_REPLACE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);

const PROTECTED_ROOT_ENV = 'REDDIT_PROTECTED_ROOT';
const PROTECTED_USER_ENV = 'REDDIT_PROTECTED_USER';
const DRIVE_PROBE_SCRIPT =
  '$p=[IO.Path]::GetFullPath($env:' + PROTECTED_ROOT_ENV + '); ' +
  '$r=[IO.Path]::GetPathRoot($p); ' +
  '[string]([IO.DriveInfo]::new($r)).DriveType';

// SDDL is locale-independent: it names every trustee by SID, so a German, Japanese or unresolved
// account cannot be mistaken for the current user or slip past the shared-identity checks. The
// path and account name travel through per-child environment variables, never in the command text.
const ACL_DUMP_SCRIPT =
  '$sid=[Security.Principal.NTAccount]::new($env:' + PROTECTED_USER_ENV + ').Translate([Security.Principal.SecurityIdentifier]).Value; ' +
  '"USER|$sid"; ' +
  '"SDDL|" + [string](Get-Acl -LiteralPath $env:' + PROTECTED_ROOT_ENV + ').Sddl';

// Well-known SIDs whose write access means the tool root is not private to one account:
// Everyone, BUILTIN\Users (localized, e.g. "VORDEFINIERT\Benutzer"), and Authenticated Users.
const SHARED_SIDS = new Set(['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11', 'S-1-5-4']);
// SDDL may spell a well-known trustee as a two-letter alias instead of its S-form (icacls-derived
// ACLs use WD for Everyone and BU for BUILTIN\Users). Both spellings must be recognized.
const SDDL_ALIASES = new Map([
  ['WD', 'S-1-1-0'], // Everyone
  ['AU', 'S-1-5-11'], // Authenticated Users
  ['BU', 'S-1-5-32-545'], // BUILTIN\Users
  ['IU', 'S-1-5-4'], // INTERACTIVE
]);
const FULL_CONTROL_BITS = 0x1f01ff;
const WRITE_BITS = 0x10000000 // GENERIC_WRITE
  | 0x40000000 // GENERIC_ALL
  | 0x00000002 // FILE_WRITE_DATA
  | 0x00000004 // FILE_APPEND_DATA
  | 0x00000010 // FILE_WRITE_EA
  | 0x00000040 // FILE_DELETE_CHILD
  | 0x00000100 // FILE_WRITE_ATTRIBUTES
  | 0x00010000 // DELETE
  | 0x00040000 // WRITE_DAC
  | 0x00080000; // WRITE_OWNER

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function toBytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return data;
  if (data && typeof data === 'object') return Buffer.from(JSON.stringify(data), 'utf8');
  throw codedError('INVALID_ARGUMENT', 'writeAtomic accepts a string, Buffer, Uint8Array, or JSON-serializable object.');
}

async function quietUnlink(fs, path) {
  try {
    await fs.unlink(path);
  } catch {
    // The temporary file may already be gone; the original error is what matters.
  }
}

// Write to a unique sibling and rename over the target. The target is never unlinked first, so a
// failed replacement leaves the previous document readable. Waits are bounded and back off.
export async function writeAtomic(path, data, options = {}) {
  const {
    fs = defaultFs,
    sleep = defaultSleep,
    newId = randomUUID,
    retries = 5,
    backoffMs = 20,
    maxBackoffMs = 500,
  } = options;

  const bytes = toBytes(data);
  // The temporary file is a sibling, so the rename never crosses a volume.
  const tempPath = join(dirname(path), `.${basename(path)}.${newId()}.tmp`);

  await fs.writeFile(tempPath, bytes, { flag: 'wx', mode: 0o600 });

  let delay = Math.max(1, backoffMs);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tempPath, path);
      return;
    } catch (error) {
      if (!RETRYABLE_REPLACE.has(error.code) || attempt >= retries) {
        await quietUnlink(fs, tempPath);
        throw error;
      }
      await sleep(Math.min(delay, maxBackoffMs));
      delay = Math.min(delay * 2, maxBackoffMs);
    }
  }
}

function defaultRun(file, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code === 'string') {
        rejectRun(error);
        return;
      }
      resolveRun({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? error?.message ?? ''),
      });
    });
  });
}

async function runChecked(run, file, args, options, action) {
  let result;
  try {
    result = await run(file, args, options);
  } catch (error) {
    throw codedError('PROTECTION_FAILED', `Could not ${action} because ${file} could not be run (${error.code ?? 'error'}).`);
  }
  if (!result || typeof result.code !== 'number') {
    throw codedError('PROTECTION_FAILED', `Could not ${action} because ${file} returned no usable result.`);
  }
  if (result.code !== 0) {
    const detail = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    throw codedError('PROTECTION_FAILED', `Could not ${action} (${file} exited ${result.code})${detail ? `: ${detail}` : '.'}`);
  }
  return result;
}

// Accepts a path such as C:\Users\me, C:/Users/me, or an extended local path. UNC, mapped-share,
// and roaming locations are refused before any directory or ACL change happens.
function normalizeWindowsPath(target) {
  return target.replace(/\//g, '\\');
}

function isUncPath(windowsPath) {
  if (!windowsPath.startsWith('\\\\')) return false;
  return !/^\\\\\?\\[a-zA-Z]:\\/.test(windowsPath);
}

function isRoamingPath(windowsPath) {
  const lower = windowsPath.toLowerCase();
  return lower.includes('\\appdata\\roaming\\') || lower.endsWith('\\appdata\\roaming');
}

function isDriveRoot(windowsPath) {
  return /^[a-zA-Z]:\\?$/.test(windowsPath);
}

function defaultUser() {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

// A parsed SDDL DACL keeps only what verification needs: trustee SID, allow/deny, rights, and
// whether the ACE is inherited. Account names never appear, so localized output cannot fail open.
function parseSddl(sddl) {
  const text = String(sddl).trim();
  const ownerMatch = /O:(S-\d+(?:-\d+)*)/.exec(text);
  const aces = [];
  const daclIndex = text.indexOf('D:');
  if (daclIndex !== -1) {
    // After "D:" the ACE list has no colons; the next colon can only start a SACL ("S:").
    const rest = text.slice(daclIndex + 2);
    const daclText = rest.slice(0, rest.indexOf(':') === -1 ? rest.length : rest.indexOf(':'));
    for (const match of daclText.matchAll(/\(([^)]*)\)/g)) {
      const parts = match[1].split(';');
      if (parts.length < 6) continue;
      const [type, flags, rights, , , trustee] = parts;
      const sid = trustee.trim().toUpperCase();
      aces.push({
        type: type.toUpperCase(),
        flags: flags.toUpperCase(),
        rights: rights.toUpperCase(),
        sid: SDDL_ALIASES.get(sid) ?? sid,
      });
    }
  }
  return { owner: ownerMatch ? ownerMatch[1] : null, aces };
}

function rightsValue(rights) {
  if (rights === 'FA' || rights === 'GA') return FULL_CONTROL_BITS;
  if (rights === 'FR' || rights === 'GR') return 0;
  if (/^0X[0-9A-F]+$/.test(rights)) return Number.parseInt(rights.slice(2), 16);
  return null; // Unknown rights are handled conservatively by the callers.
}

function rightsAllowWrite(rights) {
  const value = rightsValue(rights);
  return value === null || (value & WRITE_BITS) !== 0;
}

function rightsAreFull(rights) {
  const value = rightsValue(rights);
  return value !== null && (value & FULL_CONTROL_BITS) === FULL_CONTROL_BITS;
}

// ACE flags are two-letter codes (OI, CI, IO, ID, ...); split them so "OI" cannot be found inside
// an unrelated concatenation.
function aceFlagCodes(flags) {
  const codes = new Set();
  for (let index = 0; index + 1 < flags.length; index += 2) codes.add(flags.slice(index, index + 2));
  return codes;
}

function isInheritedAce(ace) {
  return aceFlagCodes(ace.flags).has('ID');
}

// Expects the two lines printed by ACL_DUMP_SCRIPT: "USER|<sid>" and "SDDL|<sddl>".
function parseAclDump(output, path) {
  let userSid = null;
  let sddl = null;
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('USER|')) userSid = line.slice('USER|'.length).trim();
    else if (line.startsWith('SDDL|')) sddl = line.slice('SDDL|'.length).trim();
  }
  if (!userSid || !/^S-\d+(?:-\d+)*$/.test(userSid) || !sddl) {
    throw codedError('PROTECTION_FAILED', `Could not read a usable ACL for ${path}.`);
  }
  return { userSid, ...parseSddl(sddl) };
}

function assertSafeLocation(windowsPath) {
  if (isUncPath(windowsPath)) {
    throw codedError('UNSAFE_LOCATION', 'Protected storage cannot live on a UNC or shared path.');
  }
  if (isRoamingPath(windowsPath)) {
    throw codedError('UNSAFE_LOCATION', 'Protected storage cannot live in a roaming profile location.');
  }
  if (isDriveRoot(windowsPath)) {
    throw codedError('UNSAFE_LOCATION', 'Refusing to change ACLs on a drive root; name the tool directory instead.');
  }
}

export async function ensureProtectedRoot(path, options = {}) {
  const {
    platform = process.platform,
    run = defaultRun,
    fs = defaultFs,
    user = defaultUser(),
    env = process.env,
  } = options;

  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw codedError('UNSAFE_LOCATION', 'Protected storage must be an absolute local directory path.');
  }
  const target = resolve(path);
  const windowsPath = normalizeWindowsPath(target);

  assertSafeLocation(windowsPath);
  if (platform !== 'win32') {
    throw codedError('UNSUPPORTED_PLATFORM', 'Protected local storage requires Windows NTFS in this release.');
  }
  if (!user) {
    throw codedError('PROTECTION_FAILED', 'Could not determine the current Windows user to protect the directory for.');
  }

  const probeDrive = async (candidate) => {
    const probe = await runChecked(
      run,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DRIVE_PROBE_SCRIPT],
      { env: { ...env, [PROTECTED_ROOT_ENV]: candidate } },
      'inspect the storage drive',
    );
    const driveType = String(probe.stdout ?? '').trim();
    if (driveType !== 'Fixed') {
      throw codedError('UNSAFE_LOCATION', `Protected storage requires a local fixed drive, not ${driveType || 'an unknown drive'}.`);
    }
    return driveType;
  };

  let driveType = await probeDrive(target);

  await fs.mkdir(target, { recursive: true });

  // A junction or symlink in the final component would redirect the ACL change somewhere else.
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    throw codedError('PROTECTION_FAILED', `Could not inspect ${target} before changing its ACL (${error.code ?? 'error'}).`);
  }
  if (typeof stats?.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
    throw codedError('UNSAFE_LOCATION', `Refusing to protect ${target}: it is a link or junction, not a real directory.`);
  }
  if (typeof stats?.isDirectory === 'function' && !stats.isDirectory()) {
    throw codedError('UNSAFE_LOCATION', `Refusing to protect ${target}: it is not a directory.`);
  }

  // Intermediate components (for example %LOCALAPPDATA%) may themselves be junctions. Resolving the
  // real target before touching ACLs is what stops a redirect to a share or removable volume.
  let resolvedTarget;
  try {
    resolvedTarget = await fs.realpath(target);
  } catch (error) {
    throw codedError('PROTECTION_FAILED', `Could not resolve ${target} before changing its ACL (${error.code ?? 'error'}).`);
  }
  if (typeof resolvedTarget !== 'string' || !isAbsolute(resolvedTarget)) {
    throw codedError('PROTECTION_FAILED', `Could not resolve ${target} to an absolute local directory.`);
  }
  const resolvedWindowsPath = normalizeWindowsPath(resolvedTarget);
  if (resolvedWindowsPath.toLowerCase() !== windowsPath.toLowerCase()) {
    assertSafeLocation(resolvedWindowsPath);
    driveType = await probeDrive(resolvedTarget);
  }

  // Remove inheritance first, then grant only the current user. The path is passed as its own
  // argument, never concatenated into a command line.
  await runChecked(
    run,
    'icacls',
    [resolvedTarget, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`],
    undefined,
    'tighten the directory ACL',
  );

  const verification = await runChecked(
    run,
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', ACL_DUMP_SCRIPT],
    { env: { ...env, [PROTECTED_ROOT_ENV]: resolvedTarget, [PROTECTED_USER_ENV]: user } },
    'verify the directory ACL',
  );
  const { userSid, aces } = parseAclDump(verification.stdout, resolvedTarget);

  const inherited = aces.filter(isInheritedAce);
  const sharedWrite = aces.filter((ace) => SHARED_SIDS.has(ace.sid)
    && (ace.type === 'D' || rightsAllowWrite(ace.rights)));
  const ownerFull = aces.some((ace) => {
    if (ace.type !== 'A' || ace.sid !== userSid || isInheritedAce(ace)) return false;
    const flags = aceFlagCodes(ace.flags);
    return flags.has('OI') && flags.has('CI') && rightsAreFull(ace.rights);
  });

  if (inherited.length > 0) {
    throw codedError('PROTECTION_FAILED', `The ACL for ${resolvedTarget} still contains inherited entries.`);
  }
  if (sharedWrite.length > 0) {
    throw codedError('PROTECTION_FAILED', `The ACL for ${resolvedTarget} grants access to a shared identity (${sharedWrite[0].sid}).`);
  }
  if (!ownerFull) {
    throw codedError('PROTECTION_FAILED', `The ACL for ${resolvedTarget} does not verify full control for ${user}.`);
  }

  return {
    ok: true,
    protected: true,
    platform,
    path: resolvedTarget,
    user,
    driveType,
    aclVerified: true,
  };
}
