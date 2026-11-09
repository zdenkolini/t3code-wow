// Files only the current account may read: the T3 session tokens and the strip key.
// Each is written to a side file, locked down, then renamed over the old one, so a failure
// part way leaves the old file as it was and the secret is never readable by others.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// For a write at startup, before anything else could have the file open.
export function writeSecretSync(file, data) {
  const tmp = prepare(file, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export async function writeSecret(file, data) {
  const tmp = prepare(file, data);
  try {
    await replace(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function prepare(file, data) {
  const tmp = `${file}.new`;
  // A side file left by a crash would keep its old mode: the mode only applies to a new file.
  fs.rmSync(tmp, { force: true });
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    ownerOnly(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
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
function ownerOnly(file) {
  if (process.platform !== 'win32') return;
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: 'pipe' };
  try {
    execFileSync(path.join(system32(), 'icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${currentSid(file)}:F`], opts);
  } catch (e) {
    throw new Error(`could not limit ${file} to the current user: ${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

// The account doesn't change while the bridge runs, so ask once.
let sid = null;
function currentSid(file) {
  if (sid) return sid;
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: 'pipe' };
  const found = execFileSync(path.join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], opts).match(/S-1-[\d-]+/)?.[0];
  if (!found) throw new Error(`could not limit ${file} to the current user: whoami printed no SID`);
  return (sid = found);
}

// Full paths: Git for Windows puts its own whoami ahead of the system one on PATH.
function system32() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
}
