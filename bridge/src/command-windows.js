// The t3code-wow command on Windows: a t3code-wow.cmd in ~/.local/bin, and that folder
// on the user's PATH (HKCU\Environment\Path), so the installer can put the command in
// every new terminal and uninstall can take it off again. On Linux and macOS,
// install.sh links ~/.local/bin/t3code-wow instead.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// One PATH entry in a comparable form: %VARIABLES% expanded, case and slashes ignored.
function comparable(entry, env) {
  const vars = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return entry
    .replace(/%([^%;]+)%/g, (m, name) => vars[name.toLowerCase()] ?? m)
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

// The PATH value with `dir` added at the end, or null when it's already there.
export function addPathEntry(value, dir, env = process.env) {
  const entries = value.split(';').filter(Boolean);
  if (entries.some((e) => comparable(e, env) === comparable(dir, env))) return null;
  return [...entries, dir].join(';');
}

// The PATH value without `dir`, or null when it isn't there.
export function removePathEntry(value, dir, env = process.env) {
  const entries = value.split(';').filter(Boolean);
  const kept = entries.filter((e) => comparable(e, env) !== comparable(dir, env));
  return kept.length === entries.length ? null : kept.join(';');
}

// The t3code-wow.cmd the installer puts on PATH (a .cmd, because PowerShell's default
// script policy blocks .ps1 files). It runs the node the installer found, which keeps
// working in shells where a version manager such as fnm hasn't set PATH up, or `node`
// from PATH once that one is gone. `(goto)` leaves the batch file before node runs (the
// rest of the line is already read), because cmd re-reads a batch file after each
// command and `t3code-wow uninstall` deletes this one.
// In a batch file, % starts a variable; %% is a literal one.
const batchLiteral = (p) => p.replace(/%/g, '%%');

export function commandShim({ node, script }) {
  const q = (p) => `"${batchLiteral(p)}"`;
  return `@(goto) 2>nul & if exist ${q(node)} (${q(node)} ${q(script)} %*) else (node ${q(script)} %*)\r\n`;
}

// Run a PowerShell script with inputs in environment variables, and decode its
// base64 JSON answer. reg.exe prints in the console's code page, which would garble a
// PATH with non-ASCII folder names on the way back in; this keeps it Unicode both ways.
function powershell(script, vars, system) {
  const exe = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const full = `$ErrorActionPreference = 'Stop'\n${script}`;
  const r = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, ...vars },
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`couldn't update your PATH: ${(r.stderr || r.error?.message || '').trim().split('\n')[0]}`);
  const out = r.stdout.trim();
  return out ? JSON.parse(Buffer.from(out, 'base64').toString('utf8')) : null;
}

const READ = `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$v = $k.GetValue($env:T3W_NAME, $null, 'DoNotExpandEnvironmentNames')
$kind = if ($v -eq $null) { $null } else { $k.GetValueKind($env:T3W_NAME).ToString() }
$json = ConvertTo-Json -Compress @{ value = $v; kind = $kind }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;

// Write the value, then tell running programs (Explorer, so new terminals) that the
// environment changed, as the Environment Variables dialog does.
const WRITE = `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($env:T3W_DELETE) { $k.DeleteValue($env:T3W_NAME, $false) } else { $k.SetValue($env:T3W_NAME, $env:T3W_VALUE, [Microsoft.Win32.RegistryValueKind]$env:T3W_KIND) }
try {
  Add-Type -Namespace T3CodeWow -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
  $r = [UIntPtr]::Zero
  [void][T3CodeWow.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
} catch {}
`;

// The user's PATH. `name` is the registry value, so a check can use a throwaway one.
export function userPath({ name = 'Path', system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), env = process.env } = {}) {
  const read = () => powershell(READ, { T3W_NAME: name }, system);
  const write = (value, kind) => powershell(WRITE, value ? { T3W_NAME: name, T3W_VALUE: value, T3W_KIND: kind || 'ExpandString' } : { T3W_NAME: name, T3W_DELETE: '1' }, system);
  // Apply `change` to the value; true when it changed anything.
  const update = (change, dir) => {
    const { value, kind } = read();
    const next = change(value || '', dir, env);
    if (next === null) return false;
    write(next, kind);
    return true;
  };
  return {
    read,
    // True when `dir` was added, false when it was already there.
    add: (dir) => update(addPathEntry, dir),
    // True when `dir` was taken off.
    remove: (dir) => update(removePathEntry, dir),
  };
}

// What the installer puts on the computer for the command, and what uninstall removes.
export function windowsCommand({ binDir, dataDir, node, script, userPath: up = userPath() }) {
  const file = path.join(binDir, 't3code-wow.cmd');
  return {
    file,
    // Write the command; with `addToPath`, put its folder on PATH. Resolves to whether
    // this added the PATH entry (false when it was already there).
    install({ addToPath = true } = {}) {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(file, commandShim({ node, script }));
      return addToPath ? up.add(binDir) : false;
    },
    // Remove the command if it's ours. When the PATH entry was ours (`pathAdded`) and the
    // folder is now empty, remove both: other programs may keep files there too.
    remove({ pathAdded = false } = {}) {
      try {
        if (fs.readFileSync(file, 'utf8').toLowerCase().includes(batchLiteral(dataDir).toLowerCase())) fs.rmSync(file);
      } catch {}
      if (!pathAdded) return;
      try {
        if (fs.readdirSync(binDir).length) return;
        fs.rmdirSync(binDir);
      } catch (err) {
        if (err.code !== 'ENOENT') return;
      }
      up.remove(binDir);
    },
  };
}
