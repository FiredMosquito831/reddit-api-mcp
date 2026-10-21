import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { writeAtomic, ensureProtectedRoot } from '../src/secure-fs.js';

const execFilePromise = promisify(execFile);
const ROOT = join(tmpdir(), 'reddit-protected-example');

async function tempDir(t, prefix = 'reddit-secure-fs-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const DEFAULT_USER_SID = 'S-1-5-21-1111-2222-3333-1001';

function fakeDirFs({ link = false, directory = true, resolved } = {}) {
  const calls = { mkdir: [], lstat: [], realpath: [] };
  return {
    calls,
    fs: {
      mkdir: async (path, options) => {
        calls.mkdir.push({ path, options });
      },
      lstat: async (path) => {
        calls.lstat.push(path);
        return {
          isSymbolicLink: () => link,
          isDirectory: () => directory,
        };
      },
      realpath: async (path) => {
        calls.realpath.push(path);
        return resolved ?? path;
      },
    },
  };
}

// A cleaned-up directory ACL in SDDL form: owner plus LocalSystem/Administrators/current-user
// full control, all explicit (no inherited "ID" flag). SDDL is locale-independent.
function cleanSddl(userSid = DEFAULT_USER_SID) {
  return `O:${userSid}G:D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${userSid})`;
}

// The runner receives (file, args, options). It records what it was asked to run and answers the
// three commands this module uses: the drive probe, the ACL grant, and the SDDL ACL dump.
function fakeRunner({
  drive = 'Fixed',
  sddl,
  userSid = DEFAULT_USER_SID,
  reportUserSid = true,
  grantCode = 0,
  driveCode = 0,
  verifyCode = 0,
} = {}) {
  const calls = [];
  const runner = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
    if (file === 'icacls') {
      return {
        code: grantCode,
        stdout: grantCode === 0 ? 'Successfully processed 1 files; Failed processing 0 files\n' : '',
        stderr: grantCode === 0 ? '' : 'access denied',
      };
    }
    if (file.toLowerCase().startsWith('powershell')) {
      const script = String(args[args.indexOf('-Command') + 1] ?? '');
      if (script.includes('DriveType')) {
        return { code: driveCode, stdout: `${drive}\n`, stderr: driveCode === 0 ? '' : 'drive probe failed' };
      }
      if (script.includes('Sddl')) {
        if (verifyCode !== 0) return { code: verifyCode, stdout: '', stderr: 'Get-Acl failed' };
        const lines = [];
        if (reportUserSid) lines.push(`USER|${userSid}`);
        lines.push(`SDDL|${sddl ?? cleanSddl(userSid)}`);
        return { code: 0, stdout: `${lines.join('\r\n')}\r\n`, stderr: '' };
      }
    }
    return { code: 1, stdout: '', stderr: `unexpected command: ${file}` };
  };
  return { calls, run: runner };
}

function icaclsCalls(runCalls) {
  return runCalls.filter((call) => call.file === 'icacls');
}

function aclDumpCalls(runCalls) {
  return runCalls.filter((call) => call.file.toLowerCase().startsWith('powershell')
    && String(call.args[call.args.indexOf('-Command') + 1] ?? '').includes('Sddl'));
}

function observedFs(overrides = {}) {
  return {
    writeFile: nodeFs.writeFile,
    readFile: nodeFs.readFile,
    rename: nodeFs.rename,
    unlink: nodeFs.unlink,
    mkdir: nodeFs.mkdir,
    ...overrides,
  };
}

test('ensureProtectedRoot refuses UNC and extended UNC paths before doing any work', async () => {
  for (const path of ['\\\\server\\share\\reddit', '\\\\?\\UNC\\server\\share\\reddit']) {
    const { calls, fs } = fakeDirFs();
    const { calls: runCalls, run } = fakeRunner();
    await assert.rejects(
      ensureProtectedRoot(path, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION' && /UNC|shared/i.test(error.message),
    );
    assert.equal(calls.mkdir.length, 0);
    assert.equal(runCalls.length, 0);
  }
});

test('ensureProtectedRoot refuses roaming profile locations', async () => {
  for (const path of ['C:\\Users\\someone\\AppData\\Roaming\\reddit-cli', 'C:\\Users\\someone\\AppData\\Roaming']) {
    const { calls, fs } = fakeDirFs();
    const { calls: runCalls, run } = fakeRunner();
    await assert.rejects(
      ensureProtectedRoot(path, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION' && /roaming/i.test(error.message),
    );
    assert.equal(calls.mkdir.length, 0);
    assert.equal(runCalls.length, 0);
  }
});

test('ensureProtectedRoot refuses relative paths and drive roots', async () => {
  for (const path of ['relative\\reddit', 'C:\\']) {
    const { fs } = fakeDirFs();
    const { run } = fakeRunner();
    await assert.rejects(
      ensureProtectedRoot(path, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION',
    );
  }
});

test('ensureProtectedRoot refuses a non-Windows host', async () => {
  const { fs } = fakeDirFs();
  const { calls, run } = fakeRunner();
  await assert.rejects(
    ensureProtectedRoot('C:\\Users\\someone\\reddit-cli', { platform: 'linux', run, fs }),
    (error) => error.code === 'UNSUPPORTED_PLATFORM',
  );
  assert.equal(calls.length, 0);
});

test('ensureProtectedRoot refuses network and removable drives', async () => {
  for (const drive of ['Network', 'Removable', 'NoRootDirectory', 'Unknown']) {
    const { calls, fs } = fakeDirFs();
    const { calls: runCalls, run } = fakeRunner({ drive });
    await assert.rejects(
      ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION' && /drive/i.test(error.message),
    );
    assert.equal(calls.mkdir.length, 0, 'a rejected drive must not have a directory created on it');
    assert.equal(runCalls.filter((call) => call.file === 'icacls').length, 0);
  }
});

test('ensureProtectedRoot tightens and verifies the ACL with argument-safe commands', async () => {
  const { calls, fs } = fakeDirFs();
  const { calls: runCalls, run } = fakeRunner();
  const user = userInfo().username;

  const protection = await ensureProtectedRoot(ROOT, { platform: 'win32', run, fs, user });

  assert.deepEqual(protection, {
    ok: true,
    protected: true,
    platform: 'win32',
    path: ROOT,
    user,
    driveType: 'Fixed',
    aclVerified: true,
  });
  assert.deepEqual(calls.mkdir, [{ path: ROOT, options: { recursive: true } }]);

  const driveCall = runCalls.find((call) => call.file.toLowerCase().startsWith('powershell'));
  assert.ok(driveCall, 'the drive type is inspected with a cmdlet');
  const script = driveCall.args[driveCall.args.indexOf('-Command') + 1];
  assert.match(script, /DriveType/);
  assert.ok(!script.includes(ROOT), 'the path must not be concatenated into the command text');
  assert.equal(driveCall.options.env.REDDIT_PROTECTED_ROOT, ROOT);

  const icaclsRan = icaclsCalls(runCalls);
  assert.equal(icaclsRan.length, 1, 'only the grant runs; verification reads the ACL instead of parsing names');
  assert.deepEqual(icaclsRan[0].args, [ROOT, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);

  const dumps = aclDumpCalls(runCalls);
  assert.equal(dumps.length, 1);
  const dumpScript = dumps[0].args[dumps[0].args.indexOf('-Command') + 1];
  assert.match(dumpScript, /Sddl/, 'verification reads a locale-independent SDDL ACL');
  assert.ok(!dumpScript.includes(ROOT), 'the path must not be concatenated into the command text');
  assert.equal(dumps[0].options.env.REDDIT_PROTECTED_ROOT, ROOT);
  assert.equal(dumps[0].options.env.REDDIT_PROTECTED_USER, user);
});

test('ensureProtectedRoot refuses a symlinked or junction tool root', async () => {
  for (const [variant, pattern] of [[{ link: true }, /link or junction/i], [{ directory: false }, /not a directory/i]]) {
    const { fs } = fakeDirFs(variant);
    const { calls, run } = fakeRunner();
    await assert.rejects(
      ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION' && pattern.test(error.message),
    );
    assert.equal(calls.filter((call) => call.file === 'icacls').length, 0, 'no ACL change runs on an unverified root');
  }
});

test('ensureProtectedRoot re-checks the resolved target when a parent component redirects', async () => {
  const cases = [
    ['\\\\server\\share\\reddit-cli', /UNC|shared/i],
    ['C:\\Users\\someone\\AppData\\Roaming\\reddit-cli', /roaming/i],
    ['C:\\', /drive root/i],
  ];
  for (const [resolved, pattern] of cases) {
    const { fs } = fakeDirFs({ resolved });
    const { calls, run } = fakeRunner();
    await assert.rejects(
      ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
      (error) => error.code === 'UNSAFE_LOCATION' && pattern.test(error.message),
      `resolved target ${resolved} must be refused`,
    );
    assert.equal(icaclsCalls(calls).length, 0, 'no ACL change runs on a redirected target');
  }
});

test('ensureProtectedRoot applies the ACL to the resolved target, not the visible path', async () => {
  const resolved = join(tmpdir(), 'reddit-resolved-root');
  const { fs, calls: fsCalls } = fakeDirFs({ resolved });
  const { calls, run } = fakeRunner();
  const user = userInfo().username;

  const protection = await ensureProtectedRoot(ROOT, { platform: 'win32', run, fs, user });

  assert.equal(protection.path, resolved);
  assert.deepEqual(fsCalls.mkdir, [{ path: ROOT, options: { recursive: true } }]);
  assert.deepEqual(fsCalls.realpath, [ROOT]);
  assert.deepEqual(icaclsCalls(calls)[0].args, [resolved, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
  assert.equal(aclDumpCalls(calls)[0].options.env.REDDIT_PROTECTED_ROOT, resolved);
});

test('ensureProtectedRoot fails closed when the root cannot be resolved', async () => {
  const { fs } = fakeDirFs();
  fs.realpath = async () => {
    const error = new Error('unresolvable');
    error.code = 'ENOENT';
    throw error;
  };
  const { calls, run } = fakeRunner();
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED',
  );
  assert.equal(icaclsCalls(calls).length, 0);
});

test('ensureProtectedRoot fails closed when the root cannot be inspected', async () => {
  const { fs } = fakeDirFs();
  fs.lstat = async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const { calls, run } = fakeRunner();
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED',
  );
  assert.equal(calls.filter((call) => call.file === 'icacls').length, 0);
});

test('ensureProtectedRoot fails closed when the drive probe fails', async () => {
  const { fs } = fakeDirFs();
  const { calls, run } = fakeRunner({ driveCode: 1 });
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED',
  );
  assert.equal(calls.filter((call) => call.file === 'icacls').length, 0);
});

test('ensureProtectedRoot fails closed when ACL tightening fails', async () => {
  const { fs } = fakeDirFs();
  const { run } = fakeRunner({ grantCode: 1 });
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED',
  );
});

test('ensureProtectedRoot rejects an ACL that still inherits entries', async () => {
  const { fs } = fakeDirFs();
  const inherited = `O:${DEFAULT_USER_SID}G:D:AI(A;OICIID;FA;;;SY)(A;OICI;FA;;;${DEFAULT_USER_SID})`;
  const { run } = fakeRunner({ sddl: inherited });
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED' && /inherit/i.test(error.message),
  );
});

test('ensureProtectedRoot rejects shared-identity write access by well-known SID, not by localized name', async () => {
  // SDDL may spell these trustees as S-forms or as two-letter aliases (icacls uses WD/BU).
  const trustees = [
    ['S-1-1-0', 'S-1-1-0'],
    ['S-1-5-32-545', 'S-1-5-32-545'],
    ['S-1-5-11', 'S-1-5-11'],
    ['S-1-5-4', 'S-1-5-4'],
    ['WD', 'S-1-1-0'],
    ['BU', 'S-1-5-32-545'],
    ['AU', 'S-1-5-11'],
    ['IU', 'S-1-5-4'],
  ];
  for (const [trustee, expectedSid] of trustees) {
    for (const rights of ['FA', '0x1f01ff', '0x1301bf']) {
      const { fs } = fakeDirFs();
      const sddl = `O:${DEFAULT_USER_SID}G:D:AI(A;OICI;${rights};;;${trustee})(A;OICI;FA;;;${DEFAULT_USER_SID})`;
      const { run } = fakeRunner({ sddl });
      await assert.rejects(
        ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
        (error) => error.code === 'PROTECTION_FAILED' && /shared identity/i.test(error.message)
          && error.message.includes(expectedSid),
        `write access for ${trustee} (${rights}) must be refused`,
      );
    }
  }
});

test('ensureProtectedRoot rejects an explicit Everyone grant that survived inheritance removal', async () => {
  const { fs } = fakeDirFs();
  // A user-supplied root may already carry an explicit ACE; /inheritance:r does not remove it.
  const sddl = `O:${DEFAULT_USER_SID}G:D:(A;OICI;0x1301bf;;;S-1-1-0)(A;OICI;FA;;;${DEFAULT_USER_SID})`;
  const { run } = fakeRunner({ sddl });
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED'
      && /shared identity/i.test(error.message)
      && error.message.includes('S-1-1-0'),
  );
});

test('ensureProtectedRoot accepts an ACL whose names are localized because SIDs are compared', async () => {
  const { fs } = fakeDirFs();
  // No account names are present at all in SDDL, so a German host cannot slip a shared grant past.
  const sddl = `O:${DEFAULT_USER_SID}G:D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${DEFAULT_USER_SID})`;
  const { run } = fakeRunner({ sddl });
  const protection = await ensureProtectedRoot(ROOT, { platform: 'win32', run, fs });
  assert.equal(protection.aclVerified, true);
});

test('ensureProtectedRoot fails closed when the ACL dump is unusable', async () => {
  for (const variant of [{ reportUserSid: false }, { verifyCode: 1 }, { sddl: 'not-a-dacl' }]) {
    const { fs } = fakeDirFs();
    const { run } = fakeRunner(variant);
    await assert.rejects(
      ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
      (error) => error.code === 'PROTECTION_FAILED',
    );
  }
});

test('ensureProtectedRoot rejects an ACL where the owner has no verified full control', async () => {
  const { fs } = fakeDirFs();
  const sddl = `O:${DEFAULT_USER_SID}G:D:AI(A;OICI;FA;;;SY)`;
  const { run } = fakeRunner({ sddl });
  await assert.rejects(
    ensureProtectedRoot(ROOT, { platform: 'win32', run, fs }),
    (error) => error.code === 'PROTECTION_FAILED',
  );
});

test('writeAtomic replaces content and leaves no temporary file behind', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'state.json');
  await writeFile(target, JSON.stringify({ old: true }));

  await writeAtomic(target, JSON.stringify({ fresh: true }));

  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { fresh: true });
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('writeAtomic accepts strings, Buffers, Uint8Arrays and objects', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'data.json');

  await writeAtomic(target, 'plain');
  assert.equal(await readFile(target, 'utf8'), 'plain');

  await writeAtomic(target, Buffer.from('buffer'));
  assert.equal(await readFile(target, 'utf8'), 'buffer');

  await writeAtomic(target, new Uint8Array([104, 105]));
  assert.equal(await readFile(target, 'utf8'), 'hi');

  await writeAtomic(target, { json: true });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { json: true });
});

test('writeAtomic retries Windows EPERM/EBUSY replacement with bounded backoff and never unlinks the target', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'state.json');
  await writeFile(target, JSON.stringify({ old: true }));

  const sleeps = [];
  const unlinked = [];
  const renamed = [];
  let attempts = 0;
  const fs = observedFs({
    rename: async (from, to) => {
      attempts += 1;
      renamed.push([from, to]);
      if (attempts <= 2) {
        const error = new Error('file is busy');
        error.code = attempts === 1 ? 'EPERM' : 'EBUSY';
        throw error;
      }
      return nodeFs.rename(from, to);
    },
    unlink: async (path) => {
      unlinked.push(path);
      return nodeFs.unlink(path);
    },
  });

  await writeAtomic(target, JSON.stringify({ fresh: true }), {
    fs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    newId: () => 'tmp1',
  });

  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms > 0 && ms <= 2_000), 'waits stay bounded');
  assert.deepEqual(unlinked, [], 'the target is never unlinked before replacement');
  assert.ok(renamed.every(([from, to]) => dirname(from) === dir && to === target));
  assert.equal(basename(renamed[0][0]), '.state.json.tmp1.tmp');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { fresh: true });
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('writeAtomic stops retrying a persistently locked target and leaves the old JSON intact', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'state.json');
  const original = JSON.stringify({ old: true });
  await writeFile(target, original);

  const unlinked = [];
  const sleeps = [];
  let attempts = 0;
  const fs = observedFs({
    rename: async () => {
      attempts += 1;
      const error = new Error('file is busy');
      error.code = 'EBUSY';
      throw error;
    },
    unlink: async (path) => {
      unlinked.push(path);
      return nodeFs.unlink(path);
    },
  });

  await assert.rejects(
    writeAtomic(target, JSON.stringify({ fresh: true }), {
      fs,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }),
    (error) => error.code === 'EBUSY',
  );

  assert.equal(attempts, 5, 'the retry count is bounded');
  assert.equal(sleeps.length, 4);
  assert.ok(!unlinked.includes(target), 'the target is never unlinked');
  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['state.json'], 'the temporary file is cleaned up');
});

test('writeAtomic replaces the target atomically for concurrent writers', async (t) => {
  const dir = await tempDir(t);
  const target = join(dir, 'state.json');
  await writeFile(target, JSON.stringify([]));

  const payloads = Array.from({ length: 8 }, (_, index) => `value-${index}-${'x'.repeat(4096)}`);
  await Promise.all(payloads.map((payload) => writeAtomic(target, JSON.stringify({ payload }))));

  const parsed = JSON.parse(await readFile(target, 'utf8'));
  assert.ok(payloads.includes(parsed.payload), 'the file is always a complete, parseable document');
  assert.deepEqual(await readdir(dir), ['state.json']);
});

test('ensureProtectedRoot repairs and verifies a real Windows ACL in a temporary directory', { skip: process.platform !== 'win32' ? 'requires Windows NTFS ACLs' : false }, async (t) => {
  const dir = await tempDir(t, 'reddit-acl-');
  const user = userInfo().username;

  const protection = await ensureProtectedRoot(dir);

  assert.equal(protection.ok, true);
  assert.equal(protection.protected, true);
  assert.equal(protection.platform, 'win32');
  assert.equal(protection.driveType, 'Fixed');
  assert.equal(protection.path, await realpath(dir));

  const { stdout } = await execFilePromise('icacls', [dir], { windowsHide: true });
  const lower = stdout.toLowerCase();
  assert.ok(!stdout.includes('(I)'), 'inherited entries are removed');
  assert.ok(lower.includes(`${user.toLowerCase()}:(oi)(ci)(f)`), 'the current user holds full control');

  // SDDL is locale-independent, so this verification holds on non-English Windows too.
  const { stdout: sddlOut } = await execFilePromise(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[string](Get-Acl -LiteralPath $env:TEST_ROOT).Sddl'],
    { windowsHide: true, env: { ...process.env, TEST_ROOT: dir } },
  );
  const sddl = sddlOut.trim();
  assert.match(sddl, /^O:S-[\d-]+G:S-[\d-]+D:P?AI?/, 'the ACL has an owner, a group, and a protected DACL');
  assert.ok(!sddl.includes('S-1-1-0'), 'no Everyone grant remains');
  assert.ok(!sddl.includes('S-1-5-32-545'), 'no shared Users grant remains');
  assert.ok(!sddl.includes('S-1-5-11'), 'no authenticated-users grant remains');
  assert.ok(!/\([AD];[A-Z]*ID[A-Z]*;/.test(sddl), 'no inherited ACE remains');
});

test('ensureProtectedRoot protects the resolved directory behind a parent junction', { skip: process.platform !== 'win32' ? 'requires Windows junctions' : false }, async (t) => {
  const realDir = await tempDir(t, 'reddit-acl-real-');
  const linkRoot = await tempDir(t, 'reddit-acl-link-');
  const junction = join(linkRoot, 'via-junction');
  await execFilePromise('cmd.exe', ['/c', 'mklink', '/J', junction, realDir], { windowsHide: true });

  const visibleRoot = join(junction, 'tool-root');
  const protection = await ensureProtectedRoot(visibleRoot);

  const resolved = await realpath(join(realDir, 'tool-root'));
  assert.equal(protection.path, resolved, 'the resolved directory is what gets protected');

  const { stdout: sddlOut } = await execFilePromise(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '[string](Get-Acl -LiteralPath $env:TEST_ROOT).Sddl'],
    { windowsHide: true, env: { ...process.env, TEST_ROOT: join(realDir, 'tool-root') } },
  );
  const sddl = sddlOut.trim();
  assert.ok(!sddl.includes('S-1-1-0'), 'the junction target carries the tightened ACL');
  assert.ok(!/\([AD];[A-Z]*ID[A-Z]*;/.test(sddl), 'inheritance is removed on the real target');
});
