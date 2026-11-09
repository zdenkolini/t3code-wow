import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askSupervisor, autostartCommand, concreteNode, supervise } from '../src/service-windows.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-svc-'));

// A stand-in bridge: records each start, then exits after `life` ms (or never), and
// leaves when its supervisor disconnects, as `t3code-wow run` does.
function fakeBridge(dir, life) {
  const script = path.join(dir, 'fake-bridge.js');
  fs.writeFileSync(script, [
    `require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'starts'))}, process.pid + '\\n');`,
    'process.on(\'disconnect\', () => process.exit(0));',
    life ? `setTimeout(() => process.exit(3), ${life});` : 'setInterval(() => {}, 1000);',
  ].join('\n'));
  return script;
}

const starts = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// Start a supervisor that is stopped after the test even if it fails, so a failure
// can't leave it listening and keep the test process alive.
function supervisor(t, opts) {
  t.after(async () => {
    await askSupervisor(opts.stateDir, 'stop');
    fs.rmSync(opts.stateDir, { recursive: true, force: true });
  });
  return supervise(opts);
}

async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('autostart records the real node binary, not a version manager\'s per-shell link', (t) => {
  // fnm puts node on PATH through a per-shell folder link that it deletes when the shell exits.
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'fnm', 'node-versions', 'v22.23.4', 'installation');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'node.exe'), '');
  const shell = path.join(root, 'fnm_multishells', '18768_1794255354201');
  fs.mkdirSync(path.dirname(shell));
  fs.symlinkSync(real, shell, 'junction');
  assert.equal(concreteNode(path.join(shell, 'node.exe')), fs.realpathSync.native(path.join(real, 'node.exe')));
});

test('the logon command starts the supervisor with the recorded node in a hidden console', () => {
  // conhost --headless gives node.exe a console that is never shown, so nothing flashes up at logon.
  // Paths with spaces must survive Windows' command-line splitting (no quotes inside paths).
  const conhost = 'C:\\Windows\\System32\\conhost.exe';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Users\\Jo Smith\\.local\\share\\t3code-wow\\bin\\t3code-wow.js';
  const argv = [...autostartCommand({ conhost, node, script }).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(argv, [conhost, '--headless', node, script, 'supervise']);
});

test('the supervisor starts the bridge again when it exits', async (t) => {
  const dir = tmp();
  const sup = supervisor(t, { script: fakeBridge(dir, 100), stateDir: dir, delay: 50 });
  await until(() => starts(dir).length >= 3);
  assert.equal(new Set(starts(dir)).size, starts(dir).length, 'each start is a new process');
  await askSupervisor(dir, 'stop');
  await sup;
});

test('stopping the supervisor ends the bridge and does not start it again', async (t) => {
  const dir = tmp();
  const sup = supervisor(t, { script: fakeBridge(dir), stateDir: dir, delay: 50 });
  await until(() => starts(dir).length === 1);
  const { bridge } = await askSupervisor(dir, 'status');
  assert.deepEqual(await askSupervisor(dir, 'stop'), { stopped: true });
  await sup;
  assert.throws(() => process.kill(bridge, 0), 'the bridge has exited');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(starts(dir).length, 1);
  assert.equal(await askSupervisor(dir, 'status'), null, 'nothing answers any more');
});

test('only one supervisor runs per state folder', async (t) => {
  const dir = tmp();
  const first = supervisor(t, { script: fakeBridge(dir), stateDir: dir });
  await until(() => starts(dir).length === 1);
  await assert.rejects(supervise({ script: fakeBridge(dir), stateDir: dir }), { code: 'ERUNNING' });
  await askSupervisor(dir, 'stop');
  await first;
  assert.equal(starts(dir).length, 1);
});
