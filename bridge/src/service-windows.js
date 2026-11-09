// The bridge's autostart on Windows: a per-user "Run" entry that starts a small
// supervisor at logon, which runs the bridge and starts it again when it exits.
//
// Why not a Scheduled Task: Task Scheduler refuses to register tasks from a
// non-elevated administrator ("Access is denied"), which is how most people use
// Windows, so every install, update and uninstall would need a UAC prompt. A Windows
// service runs in session 0 and can't see the game window. The Run entry needs no
// elevation and starts in the desktop session; the supervisor does the restarting,
// like systemd's Restart=always or launchd's KeepAlive.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LOG_LIMIT = 5 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The node binary to record for autostart. Version managers such as fnm put node on
// PATH through a per-shell link (fnm_multishells\<id>\node.exe) that disappears with the
// shell, so resolve it to the installed binary. Re-running install records a new one.
export function concreteNode(execPath = process.execPath) {
  try {
    return fs.realpathSync.native(execPath);
  } catch {
    return execPath;
  }
}

// The command Windows runs at logon. node.exe is a console program: started on its own
// it opens a terminal window. `conhost.exe --headless` gives it a console that is never
// shown, which the bridge and its child processes share.
export function autostartCommand({ conhost, node, script }) {
  return `"${conhost}" --headless "${node}" "${script}" supervise`;
}

// Where the supervisor listens: a named pipe per state folder (so per user), or a
// socket file elsewhere. Listening on it is also what keeps a second copy from starting.
export function supervisorAddress(stateDir, platform = process.platform) {
  if (platform !== 'win32') return path.join(stateDir, 'supervisor.sock');
  const id = crypto.createHash('sha256').update(path.resolve(stateDir).toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\t3code-wow-${id}`;
}

// Send the supervisor a command ("status" or "stop"). Resolves to its JSON reply, or
// null when no supervisor is running. "stop" answers once the bridge has exited.
export function askSupervisor(stateDir, command, timeout = 15000) {
  return new Promise((resolve) => {
    let buf = '';
    const sock = net.connect(supervisorAddress(stateDir));
    const timer = setTimeout(() => sock.destroy(), timeout);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${command}\n`));
    sock.on('data', (d) => (buf += d));
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
  });
}

async function listen(server, stateDir) {
  const address = supervisorAddress(stateDir);
  for (let attempt = 0; ; attempt++) {
    const err = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(address, () => {
        server.off('error', resolve);
        resolve(null);
      });
    });
    if (!err) return;
    if (err.code !== 'EADDRINUSE' || attempt >= 20) throw err;
    if (await askSupervisor(stateDir, 'status', 2000)) throw Object.assign(new Error('the bridge supervisor is already running'), { code: 'ERUNNING' });
    // Nobody answers: a socket file left by a crash, or a pipe still closing.
    if (process.platform !== 'win32') fs.rmSync(address, { force: true });
    await sleep(100);
  }
}

// Run `node script ...args` and start it again `delay` ms after it exits, until told to
// stop. The bridge's output goes to bridge.log in stateDir. Resolves once stopped.
export async function supervise({ node = process.execPath, script, args = ['run'], stateDir, delay = 3000 }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const server = net.createServer();
  await listen(server, stateDir);

  const logFile = path.join(stateDir, 'bridge.log');
  try {
    if (fs.statSync(logFile).size > LOG_LIMIT) fs.renameSync(logFile, `${logFile}.old`);
  } catch {}
  const out = fs.openSync(logFile, 'a');
  const note = (msg) => fs.writeSync(out, `${new Date().toISOString()} supervisor: ${msg}\n`);

  const since = Date.now();
  let child = null;
  let timer = null;
  let restarts = 0;
  let stopping = false;
  const waiting = [];

  return new Promise((resolve) => {
    const finish = () => {
      note('stopped');
      fs.closeSync(out);
      server.close();
      for (const sock of waiting) sock.end(`${JSON.stringify({ stopped: true })}\n`);
      resolve();
    };
    const start = () => {
      timer = null;
      let exited = false;
      const proc = spawn(node, [script, ...args], { stdio: ['ignore', out, out, 'ipc'], windowsHide: true });
      child = proc;
      const onExit = (why) => {
        if (exited) return;
        exited = true;
        child = null;
        if (stopping) return finish();
        restarts++;
        note(`bridge ${why}; starting it again in ${delay / 1000}s`);
        timer = setTimeout(start, delay);
      };
      proc.on('error', (err) => onExit(`failed to start (${err.message})`));
      proc.on('exit', (code, signal) => onExit(`exited (${signal || `code ${code}`})`));
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      if (!child) return finish();
      // `t3code-wow run` stops cleanly when its supervisor disconnects; kill it if it doesn't.
      if (child.connected) child.disconnect();
      const proc = child;
      setTimeout(() => proc.kill(), 5000).unref();
    };
    server.on('connection', (sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('data', (d) => {
        buf += d;
        if (!buf.includes('\n')) return;
        const command = buf.trim();
        if (command === 'stop') {
          waiting.push(sock);
          stop();
        } else if (command === 'status') {
          sock.end(`${JSON.stringify({ pid: process.pid, bridge: child?.pid ?? null, restarts, since })}\n`);
        } else sock.end('{}\n');
      });
    });
    note(`started (pid ${process.pid})`);
    start();
  });
}

// The bridge's service on Windows, with the same shape as the systemd and launchd ones.
export function windowsAutostart({ name = 't3code-wow', script, stateDir, node = concreteNode(), system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }) {
  const conhost = path.join(system, 'conhost.exe');
  const reg = (...args) => spawnSync(path.join(system, 'reg.exe'), args, { encoding: 'utf8', windowsHide: true });
  const command = autostartCommand({ conhost, node, script });
  // Start it the way logon does. A headless conhost reads its stdin as the terminal and
  // quits at once on the NUL handles Node passes, so let cmd's `start` launch it with
  // no std handles, as Explorer does.
  const launch = async () => {
    spawnSync(path.join(system, 'cmd.exe'), ['/d', '/s', '/c', `"start "" ${command}"`], { cwd: path.dirname(script), stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    for (let i = 0; i < 50; i++) {
      if (await askSupervisor(stateDir, 'status', 1000)) return true;
      await sleep(100);
    }
    process.stderr.write(`The bridge didn't start; see ${path.join(stateDir, 'bridge.log')}\n`);
    return false;
  };
  return {
    name,
    kind: 'startup app',
    installed: () => reg('query', RUN_KEY, '/v', name).status === 0,
    async install() {
      const r = reg('add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f');
      if (r.status !== 0) {
        process.stderr.write(r.stderr || `couldn't add ${name} to ${RUN_KEY}\n`);
        return false;
      }
      // Start a fresh supervisor so a new node path or new bridge files take effect.
      return this.restart();
    },
    async restart() {
      await askSupervisor(stateDir, 'stop');
      return launch();
    },
    async remove() {
      reg('delete', RUN_KEY, '/v', name, '/f');
      await askSupervisor(stateDir, 'stop');
    },
  };
}
