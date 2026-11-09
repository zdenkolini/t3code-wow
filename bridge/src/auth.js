// The bridge's T3 session token. Minted with the user's own `t3` CLI, stored owner-only
// under ~/.config/t3code-wow, renewed a week before it expires.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSecret } from './secret-file.js';

export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 't3code-wow');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

export function tokenClaims(token) {
  try {
    const [body] = token.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function findT3Cli({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return findWindowsT3Cli(env, home);
  const candidates = [
    env.T3_CLI,
    path.join(home, '.local/bin/t3'),
    path.join(home, '.t3/bin/t3'),
    '/usr/bin/t3',
    '/usr/local/bin/t3',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  for (const dir of (env.PATH || '').split(':')) {
    const p = path.join(dir, 't3');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// T3 Code Nightly writes a t3.cmd shim into the T3 home's bin folder.
function findWindowsT3Cli(env, home) {
  const t3Home = env.T3CODE_HOME || path.join(home, '.t3');
  const candidates = [
    env.T3_CLI,
    path.join(t3Home, 'bin', 't3.cmd'),
    path.join(home, '.local', 'bin', 't3.cmd'),
    path.join(home, '.local', 'bin', 't3.exe'),
  ];
  // Only types the bridge can launch: PATHEXT may also list scripts like .js or .vbs.
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e));
  for (const dir of (env.PATH || '').split(';')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d) candidates.push(...exts.map((ext) => path.join(d, `t3${ext}`)));
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

export async function mintToken({ label = 'WoW bridge' } = {}) {
  const cli = findT3Cli();
  if (!cli) throw new Error('could not find the `t3` command; open T3 Code once so it installs it');
  const args = [
    'auth', 'session', 'issue',
    '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate',
    '--ttl', '30d',
    '--label', label,
    '--token-only',
  ];
  const [file, argv, opts] = t3Command(cli, args);
  const stdout = await new Promise((resolve, reject) => {
    execFile(file, argv, { ...opts, timeout: 120000 }, (err, out, stderr) => {
      if (err) reject(new Error(`t3 auth session issue failed: ${(stderr || err.message).trim()}`));
      else resolve(out);
    });
  });
  const token = stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  if (!token || !tokenClaims(token)) throw new Error('t3 auth session issue printed no token');
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // If it can't be saved the old token stays in place, so revoke the session nobody will use.
  try {
    await writeSecret(TOKEN_FILE, token);
  } catch (e) {
    revokeSession(tokenClaims(token).sid, cli);
    throw e;
  }
  return token;
}

// Best effort; resolves to whether the session is gone.
export function revokeSession(sid, cli = findT3Cli()) {
  if (!sid || !cli) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const [file, argv, opts] = t3Command(cli, ['auth', 'session', 'revoke', sid]);
      execFile(file, argv, { ...opts, timeout: 60000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

// Node won't run a .cmd shim directly on Windows; it has to go through cmd.exe.
// Every argument is quoted. Anything cmd would still expand inside quotes is refused, and so is
// a trailing backslash, which the program would read as escaping the closing quote.
export function t3Command(cli, args, { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(cli)) return [cli, args, { windowsHide: true }];
  const unsafe = [cli, ...args].find((a) => /["%\r\n]|\\$/.test(a));
  if (unsafe) throw new Error(`can't pass ${JSON.stringify(unsafe)} to ${path.basename(cli)} safely`);
  const line = [cli, ...args].map((a) => `"${a}"`).join(' ');
  return [comspec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${line}"`], { windowsHide: true, windowsVerbatimArguments: true }];
}

export function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Returns a function the T3 client calls before connecting.
export function tokenProvider({ log = () => {} } = {}) {
  let minting = null;
  let forceRenew = false;
  const provider = async () => {
    if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
    let token = readToken();
    const claims = token && tokenClaims(token);
    const expiring = !claims || (claims.exp && claims.exp - Date.now() < RENEW_BEFORE_MS);
    if (!token || expiring || forceRenew) {
      if (!minting) {
        log(token ? 'renewing the T3 session token' : 'minting a T3 session token');
        minting = mintToken().finally(() => {
          minting = null;
          forceRenew = false;
        });
      }
      try {
        token = await minting;
      } catch (err) {
        if (!token) throw err;
        log(`token renewal failed, using the old one: ${err.message}`);
      }
    }
    return token;
  };
  provider.invalidate = () => {
    forceRenew = true;
  };
  return provider;
}
