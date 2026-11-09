// Files only the current account may read: the T3 session tokens and the strip key.
// Each is written to a side file that is locked down before the secret goes in, then renamed
// over the old one, so a failure part way leaves the old file as it was.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// For a write at startup, before anything else could have the file open.
export function writeSecretSync(file, data) {
  const tmp = createSideFile(file);
  try {
    lockDownSync(tmp);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// For the running bridge: the Windows tools run without blocking it.
export async function writeSecret(file, data) {
  const tmp = createSideFile(file);
  try {
    await lockDown(tmp);
    fs.writeFileSync(tmp, data);
    await replace(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// An empty side file, 0600 on Linux and macOS. A side file left by a crash would keep its old
// mode (the mode only applies to a new file), so it's removed first.
function createSideFile(file) {
  const tmp = `${file}.new`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, '', { mode: 0o600 });
  return tmp;
}

// Windows refuses to replace a file someone has open (a virus scan, a CLI reading the token),
// so give them a moment before giving up.
async function replace(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}

// POSIX modes don't apply on Windows: drop inherited access and grant only the current account,
// named by its SID so a renamed account or an odd USERNAME can't point it elsewhere.
function lockDownSync(file) {
  if (process.platform !== 'win32') return;
  try {
    runSync(...icacls(file, sid || sidFrom(runSync(...whoami()))));
  } catch (e) {
    throw lockDownError(file, e);
  }
}

async function lockDown(file) {
  if (process.platform !== 'win32') return;
  try {
    await runAsync(...icacls(file, sid || sidFrom(await runAsync(...whoami()))));
  } catch (e) {
    throw lockDownError(file, e);
  }
}

const lockDownError = (file, e) => new Error(`could not limit ${file} to the current user: ${(e.stderr || e.stdout || e.message).trim()}`);

const icacls = (file, accountSid) => [path.join(system32(), 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${accountSid}:F`]];
const whoami = () => [path.join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']];

// The account doesn't change while the bridge runs, so whoami is asked once.
let sid = null;
function sidFrom(output) {
  sid = output.match(/S-1-[\d-]+/)?.[0] || null;
  if (!sid) throw new Error('whoami printed no SID');
  return sid;
}

// Full paths: Git for Windows puts its own whoami ahead of the system one on PATH.
function system32() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
}

const RUN_OPTS = { encoding: 'utf8', windowsHide: true, timeout: 15000 };

const runSync = (exe, args) => execFileSync(exe, args, { ...RUN_OPTS, stdio: 'pipe' });

function runAsync(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, RUN_OPTS, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}
