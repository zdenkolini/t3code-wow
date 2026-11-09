// Checks that a secret file can only be read by the current account: mode 0600 on Linux and
// macOS, and on Windows an ACL that `icacls` lists with the current account alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Full paths: Git for Windows puts its own whoami ahead of the system one on PATH.
const system32 = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

export function assertOwnerOnly(file) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    return;
  }
  const opts = { encoding: 'utf8', windowsHide: true };
  // "DOMAIN\name","S-1-…"
  const account = execFileSync(path.join(system32(), 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], opts).split(',')[0].replace(/"/g, '').trim();
  // icacls prints "<file> <entry>" first, then one entry per line, then a blank line and a summary.
  const lines = execFileSync(path.join(system32(), 'icacls.exe'), [file], opts).split(/\r?\n/);
  const entries = lines.slice(0, lines.findIndex((l) => !l.trim())).map((l, i) => (i === 0 ? l.slice(file.length) : l).trim());
  // whoami lowercases the account name; icacls doesn't.
  assert.deepEqual(entries.map((e) => e.toLowerCase()), [`${account}:(F)`.toLowerCase()]);
}
