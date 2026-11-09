// Finding the WoW: Forever install and the running client.
//
// On Linux the game runs under Wine or Proton, so we look through Wine prefixes. On
// macOS it runs natively, from /Applications by default, and on Windows natively from
// wherever Battle.net put it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FLAVOR = '_forever_';
// Omarchy's Battle.net installer (omarchy-install-gaming-battlenet) uses this prefix.
export const OMARCHY_PREFIX = path.join(os.homedir(), 'Games/battlenet');

// Wine prefixes that might hold Battle.net, most likely first.
function candidateRoots() {
  const home = os.homedir();
  const roots = [];
  const add = (p) => p && !roots.includes(p) && roots.push(p);
  add(OMARCHY_PREFIX);
  add(process.env.WINEPREFIX);
  add(path.join(home, 'Games/battle-net'));
  add(path.join(home, 'Games/blizzard'));
  add(path.join(home, '.wine'));
  add(path.join(home, '.local/share/lutris/prefixes/battlenet'));
  // Heroic, Bottles and Steam (non-Steam game shortcut) prefixes.
  for (const base of [
    path.join(home, 'Games/Heroic/Prefixes/default'),
    path.join(home, '.var/app/com.usebottles.bottles/data/bottles/bottles'),
    path.join(home, '.local/share/bottles/bottles'),
    path.join(home, '.local/share/Steam/steamapps/compatdata'),
    path.join(home, '.steam/steam/steamapps/compatdata'),
  ]) {
    try {
      for (const d of fs.readdirSync(base)) {
        add(path.join(base, d));
        add(path.join(base, d, 'pfx'));
      }
    } catch {}
  }
  return roots.filter((r) => fs.existsSync(path.join(r, 'drive_c')));
}

// A Windows path ("C:/Games/World of Warcraft") inside a prefix, as a Linux path.
function winToLinux(root, win) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win.trim());
  if (!m) return null;
  const drive = m[1].toLowerCase() === 'c' ? path.join(root, 'drive_c') : path.join(root, 'dosdevices', `${m[1].toLowerCase()}:`);
  return path.join(drive, ...m[2].split(/[\\/]+/).filter(Boolean));
}

// Where Battle.net says it put World of Warcraft (product.db), and where it installs
// new games by default (Battle.net.config). Covers installs outside Program Files.
function battlenetWowDirs(root) {
  const dirs = [];
  try {
    const db = fs.readFileSync(path.join(root, 'drive_c/ProgramData/Battle.net/Agent/product.db'), 'latin1');
    for (const m of db.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"]*?World of Warcraft(?=[\x00-\x1f"]|$)/g)) {
      const d = winToLinux(root, m[0]);
      if (d && !dirs.includes(d)) dirs.push(d);
    }
  } catch {}
  try {
    for (const user of fs.readdirSync(path.join(root, 'drive_c/users'))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'drive_c/users', user, 'AppData/Roaming/Battle.net/Battle.net.config'), 'utf8'));
      const base = cfg?.Client?.Install?.DefaultInstallPath;
      const d = base && winToLinux(root, `${base}/World of Warcraft`);
      if (d && !dirs.includes(d)) dirs.push(d);
    }
  } catch {}
  return dirs;
}

// Sort WoW folders into Forever installs and WoW installs without Forever.
function classify(wowDirs, forever, wowOnly) {
  for (const wow of wowDirs) {
    if (!fs.existsSync(wow)) continue;
    const dir = path.join(wow, FLAVOR);
    if (['Wow.exe', 'World of Warcraft.app', 'Interface'].some((f) => fs.existsSync(path.join(dir, f)))) {
      if (!forever.includes(dir)) forever.push(dir);
    } else if (!wowOnly.includes(wow)) {
      wowOnly.push(wow);
    }
  }
}

function linuxInstalls() {
  const forever = [];
  const wowOnly = [];
  const roots = candidateRoots();
  for (const root of roots) {
    classify([
      ...battlenetWowDirs(root),
      path.join(root, 'drive_c/Program Files (x86)/World of Warcraft'),
      path.join(root, 'drive_c/Program Files/World of Warcraft'),
    ], forever, wowOnly);
  }
  const battlenet = roots.filter((r) => ['drive_c/ProgramData/Battle.net', 'drive_c/Program Files (x86)/Battle.net', 'drive_c/Program Files/Battle.net']
    .some((d) => fs.existsSync(path.join(r, d))));
  return { forever, wowOnly, prefixes: battlenet };
}

// macOS: Battle.net records install paths as plain paths in product.db, and its
// default install folder in Battle.net.config. `system` stands in for / in tests.
function macInstalls(system = '/') {
  const home = os.homedir();
  const sys = (p) => path.join(system, p);
  const dirs = [];
  const shared = sys('Users/Shared/Battle.net');
  try {
    const db = fs.readFileSync(path.join(shared, 'Agent/product.db'), 'latin1');
    for (const m of db.matchAll(/\/[^\x00-\x1f"]*?World of Warcraft(?=[\x00-\x1f"]|$)/g)) dirs.push(sys(Buffer.from(m[0], 'latin1').toString('utf8')));
  } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'Library/Application Support/Battle.net/Battle.net.config'), 'utf8'));
    const base = cfg.Client.Install.DefaultInstallPath;
    if (base) dirs.push(path.join(system, base, 'World of Warcraft'));
  } catch {}
  dirs.push(sys('Applications/World of Warcraft'), path.join(home, 'Applications/World of Warcraft'));
  const forever = [];
  const wowOnly = [];
  classify(dirs, forever, wowOnly);
  const battlenet = [sys('Applications/Battle.net.app'), path.join(home, 'Applications/Battle.net.app'), shared].filter((p) => fs.existsSync(p));
  return { forever, wowOnly, prefixes: battlenet };
}

// Windows: a Windows path as a path on this machine. `system` stands in for the
// drives in tests, with one folder per drive letter ("D:\Games" is <system>/D/Games).
function winPath(system, win) {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(String(win).trim());
  if (!m) return null;
  const parts = m[2].split(/[\\/]+/).filter(Boolean);
  return system ? path.join(system, m[1].toUpperCase(), ...parts) : path.join(`${m[1].toUpperCase()}:\\`, ...parts);
}

const UNINSTALL = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

// One string value from `reg.exe query <key> /v <name>`: "    <name>    REG_SZ    <data>".
export function parseRegValue(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}REG_(?:EXPAND_)?SZ\s{4}(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2].trim() || null;
  }
  return null;
}

function readRegistry(key, name) {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const r = spawnSync(reg, ['query', key, '/v', name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return r.status === 0 ? parseRegValue(r.stdout, name) : null;
}

// Windows: Battle.net records install paths in product.db (as under Wine), its
// default install folder in Battle.net.config, and older clients in the registry.
// When none of those lead to Forever, look in the usual folders on every drive.
function winInstalls({ system, env = process.env, registry = readRegistry } = {}) {
  const dirs = [];
  const add = (d) => d && !dirs.includes(d) && dirs.push(d);
  const programData = winPath(system, env.PROGRAMDATA || env.ProgramData || 'C:\\ProgramData');
  try {
    const db = fs.readFileSync(path.join(programData, 'Battle.net/Agent/product.db'), 'latin1');
    for (const m of db.matchAll(/[A-Za-z]:[\\/][^\x00-\x1f"]*?World of Warcraft(?=[\x00-\x1f"]|$)/g)) add(winPath(system, Buffer.from(m[0], 'latin1').toString('utf8')));
  } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(winPath(system, env.APPDATA), 'Battle.net/Battle.net.config'), 'utf8'));
    const base = cfg.Client.Install.DefaultInstallPath;
    if (base) add(winPath(system, `${base}/World of Warcraft`));
  } catch {}
  for (const [key, name] of [[`${UNINSTALL}\\World of Warcraft`, 'InstallLocation'], ['HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft', 'InstallPath']]) {
    const p = winPath(system, registry(key, name) || '');
    // InstallPath can name the flavor folder (…\World of Warcraft\_retail_\).
    if (p) add(/^_[a-z]+_$/i.test(path.basename(p)) ? path.dirname(p) : p);
  }
  const forever = [];
  const wowOnly = [];
  classify(dirs, forever, wowOnly);
  if (!forever.length) {
    const drives = system
      ? fs.readdirSync(system).filter((d) => /^[A-Z]$/.test(d))
      : 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((d) => fs.existsSync(`${d}:\\`));
    classify(drives.flatMap((d) => ['Program Files (x86)', 'Program Files', '', 'Games'].map((f) => winPath(system, `${d}:\\${f}\\World of Warcraft`))), forever, wowOnly);
  }
  const battlenet = [winPath(system, registry(`${UNINSTALL}\\Battle.net`, 'InstallLocation') || ''), path.join(programData, 'Battle.net')]
    .filter((p, i, all) => p && all.indexOf(p) === i && fs.existsSync(p));
  return { forever, wowOnly, prefixes: battlenet };
}

// { forever: [...WoW: Forever folders], wowOnly: [...WoW installs without Forever], prefixes: [...where Battle.net is] }
// On Windows, `env` and `registry` (key, value name) => string|null stand in for the
// real environment and registry in tests.
export function findWowInstalls({ platform = process.platform, system, env, registry } = {}) {
  const { forever, wowOnly, prefixes } = platform === 'darwin' ? macInstalls(system)
    : platform === 'win32' ? winInstalls({ system, env, registry })
    : linuxInstalls();
  return { forever, wowOnly: wowOnly.filter((w) => !forever.some((f) => f.startsWith(w + path.sep))), prefixes };
}

// A folder the player named (--wow): the World of Warcraft folder or its Forever folder.
export function foreverFolder(dir) {
  return fs.existsSync(path.join(dir, FLAVOR)) ? path.join(dir, FLAVOR) : dir;
}

export function findWowDirs() {
  return findWowInstalls().forever;
}

export function addonsDir(wowDir) {
  return path.join(wowDir, 'Interface', 'AddOns');
}

// The running Forever client: { pid, startTicks } or null. startTicks (from
// /proc/<pid>/stat, or the start time on macOS and Windows) distinguishes a restarted
// client that happens to reuse a pid.
export function findWowProcess() {
  if (process.platform === 'darwin') return findMacProcess();
  if (process.platform === 'win32') return findWindowsProcess();
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${e}/cmdline`, 'latin1');
    } catch {
      continue;
    }
    if (!/_forever_[\\/]+Wow\.exe/i.test(cmd)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, 'latin1');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(e), startTicks: Number(fields[19]) };
    } catch {
      return { pid: Number(e), startTicks: 0 };
    }
  }
  return null;
}

// `ps -axww -o pid=,lstart=,comm=` lines: "  123 Mon Nov  9 09:27:45 2026     /path/to/exe".
// The start time is in UTC (findMacProcess runs ps with TZ=UTC), so a change of time
// zone while the game runs doesn't look like a new client.
export function parseMacProcesses(text) {
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!m || !/\/_forever_\/[^/]+\.app\/Contents\/MacOS\//.test(m[3])) continue;
    return { pid: Number(m[1]), startTicks: Date.parse(`${m[2]} GMT`) };
  }
  return null;
}

function findMacProcess() {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,lstart=,comm='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  return r.status === 0 ? parseMacProcesses(r.stdout) : null;
}

// Windows listing from WIN_PS: "<pid>\t<start, ms since 1970 UTC>\t<path>" lines. The
// path is empty for a process we aren't allowed to inspect.
export function parseWindowsProcesses(text) {
  for (const line of text.split(/\r?\n/)) {
    const [pid, start, exe] = line.split('\t');
    if (exe && /[\\/]_forever_[\\/]Wow\.exe$/i.test(exe.trim())) return { pid: Number(pid), startTicks: Number(start) };
  }
  return null;
}

// "<pid>","<pid>"… of running Wow.exe processes from `tasklist /fo csv /nh` (whose
// "no tasks" line is localized, so only matching rows count).
export function parseTasklist(text) {
  return [...text.matchAll(/^"Wow\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
}

// A client we may not inspect (one run as administrator) has no start time, and
// reading it throws; skip it rather than lose the whole listing.
const WIN_PS = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process -Name Wow -ErrorAction SilentlyContinue | ForEach-Object { try { ($_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds(), $_.Path) -join [char]9 } catch {} }";
let winProcCache = { pids: null, proc: null };

// tasklist takes ~0.1 s; PowerShell, which can tell Forever from Retail by path and
// knows the start time, takes ~0.3 s or more. The bridge checks every few seconds,
// so PowerShell only runs when the set of Wow.exe processes changes. A restarted
// client is a new pid set, because the game takes longer than one check to start.
function findWindowsProcess() {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const tl = spawnSync(path.join(sys32, 'tasklist.exe'), ['/fi', 'IMAGENAME eq Wow.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (tl.status !== 0) return null;
  const pids = parseTasklist(tl.stdout).join(',');
  if (!pids) return (winProcCache = { pids, proc: null }).proc;
  if (pids === winProcCache.pids) return winProcCache.proc;
  const ps = spawnSync(path.join(sys32, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (ps.error) return null;
  return (winProcCache = { pids, proc: parseWindowsProcesses(ps.stdout) }).proc;
}

export function processKey(p) {
  return p ? `${p.pid}:${p.startTicks}` : null;
}
