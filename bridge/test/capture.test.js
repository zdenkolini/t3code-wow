import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { pickMacWindow, pickWindowsWindow, StripCapture, WinHelper, helperErrorText } from '../src/capture.js';

const screens = [
  { x: 0, y: 0, width: 1512, height: 982, scale: 2 }, // built-in Retina, the primary
  { x: 1512, y: -100, width: 2560, height: 1440, scale: 1 }, // external, NSScreen's bottom-left origin
];
const win = (pid, X, Y, Width, Height, extra = {}) => ({ pid, layer: 0, onscreen: true, bounds: { X, Y, Width, Height }, ...extra });

test('a window on the Retina screen', () => {
  const w = pickMacWindow({ windows: [win(5, 0, 0, 1512, 982)], screens }, 5);
  assert.deepEqual([w.found, w.visible, w.scale], [true, true, 2]);
});

test('a windowed client on the external screen, found by pid over a same-named window', () => {
  const info = { windows: [win(9, 10, 10, 800, 600), win(5, 1600, -300, 1280, 748)], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.x, w.y, w.scale], [1600, -300, 1]);
});

test('ignores menus and tiny windows, and reports a window on another Space as hidden', () => {
  const info = { windows: [win(5, 0, 0, 1512, 30, { layer: 25 }), win(5, 0, 0, 40, 40), win(5, 0, 0, 1512, 982, { onscreen: false })], screens };
  const w = pickMacWindow(info, 5);
  assert.deepEqual([w.found, w.visible], [true, false]);
  assert.equal(pickMacWindow({ windows: [], screens }, 5).found, false);
});

test('Windows resolves to the windows backend instead of crashing on process.getuid', () => {
  assert.equal(new StripCapture({ platform: 'win32' }).resolveBackend(), 'windows');
});

// Windows: the helper reports top-level windows with client areas in physical pixels.
const primary = { x: 0, y: 0, width: 3840, height: 2160 };
const left = { x: -2560, y: 0, width: 2560, height: 1440 };
const gw = (pid, x, y, width, height, extra = {}) => ({
  pid, cls: 'waApplication Window', visible: true, iconic: false, cloaked: false, tool: false,
  client: { x, y, width, height }, dpi: 96, monitor: primary, ...extra,
});

test('Windows: a windowed game on a second monitor at 150%, found by pid over another window', () => {
  const browser = gw(7, 0, 0, 3840, 2100, { cls: 'Chrome_WidgetWin_1' });
  const game = gw(5, -2400, 100, 1920, 1080, { dpi: 144, monitor: left });
  const w = pickWindowsWindow({ windows: [browser, game] }, 5);
  assert.deepEqual(w, { found: true, visible: true, x: -2400, y: 100, width: 1920, height: 1080, scale: 1.5, fullscreen: false });
});

test('Windows: a minimized or cloaked game is found but not visible; tiny and tool windows are ignored', () => {
  const popup = gw(5, 10, 10, 40, 40, { cls: '#32770' });
  const tool = gw(5, 0, 0, 800, 600, { tool: true });
  const minimized = gw(5, 0, 0, 0, 0, { iconic: true });
  let w = pickWindowsWindow({ windows: [popup, tool, minimized] }, 5);
  assert.deepEqual([w.found, w.visible], [true, false]);
  // On another virtual desktop the window is visible to Win32 but cloaked by the shell.
  w = pickWindowsWindow({ windows: [gw(5, 0, 0, 1920, 1080, { cloaked: true })] }, 5);
  assert.deepEqual([w.found, w.visible], [true, false]);
  assert.equal(pickWindowsWindow({ windows: [popup] }, 5).found, false);
  assert.equal(pickWindowsWindow({ windows: [] }, 5).found, false);
});

test('Windows: without a pid, the game is found by its window class, and covering the monitor reads as fullscreen', () => {
  const other = gw(7, 0, 0, 1200, 800, { cls: 'Chrome_WidgetWin_1' });
  const w = pickWindowsWindow({ windows: [other, gw(5, 0, 0, 3840, 2160)] }, undefined);
  assert.deepEqual([w.found, w.width, w.fullscreen], [true, 3840, true]);
});

// A stand-in for the PowerShell helper: records request lines, and lets the test write its stdout.
function fakeHelper() {
  const fake = { lines: [], spawned: [] };
  fake.spawn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit('exit', null);
    proc.stdin.setEncoding('utf8');
    proc.stdin.on('data', (d) => fake.lines.push(...d.split('\n').filter(Boolean)));
    fake.proc = proc;
    fake.spawned.push(args);
    return proc;
  };
  fake.say = (text) => fake.proc.stdout.write(`${text}\n`);
  return fake;
}

const tick = () => new Promise((r) => setImmediate(r));

test('Windows helper: replies go to the request with their number, and stray lines are dropped', async () => {
  const fake = fakeHelper();
  const logged = [];
  const helper = new WinHelper({ spawn: fake.spawn, log: (m) => logged.push(m) });
  const a = helper.request('windows 5');
  const b = helper.request('grab 0 0 4 4');
  await tick();
  const [ida, idb] = fake.lines.map((l) => l.split(' ')[0]);
  assert.deepEqual(fake.lines.map((l) => l.split(' ').slice(1).join(' ')), ['windows 5', 'grab 0 0 4 4']);
  assert.notEqual(ida, idb);
  fake.say('WARNING: something PowerShell printed');
  fake.say(`${idb} ok bbbb`);
  fake.say(`${ida} err Access is denied.`);
  assert.equal(await b, 'bbbb');
  await assert.rejects(a, /Access is denied\./);
  // A second answer to a request that's already answered has nothing to resolve.
  const c = helper.request('windows 6');
  await tick();
  fake.say(`${idb} ok late`);
  fake.say(`${fake.lines[2].split(' ')[0]} ok cccc`);
  assert.equal(await c, 'cccc');
  assert.equal(logged.length, 2);
  assert.match(logged[0], /WARNING: something PowerShell printed/);
  assert.match(logged[1], /ok late/);
});

test('Windows helper: starts the script file that ships next to capture.js', async () => {
  const fake = fakeHelper();
  const helper = new WinHelper({ spawn: fake.spawn });
  helper.request('windows 5').catch(() => {});
  const args = fake.spawned[0];
  const script = args[args.indexOf('-File') + 1];
  assert.ok(fs.existsSync(script), script);
  fake.proc.emit('exit', 0);
});

test('Windows helper: a helper that dies reports its error, rejects what was waiting and backs off', async () => {
  const fake = fakeHelper();
  const helper = new WinHelper({ spawn: fake.spawn });
  const a = helper.request('windows 5');
  fake.proc.stderr.write('#< CLIXML\r\n<Objs><S S="Error">Add-Type : blocked by policy_x000D__x000A_</S></Objs>');
  await tick();
  fake.proc.emit('exit', 1);
  await assert.rejects(a, /capture helper exited \(1\): Add-Type : blocked by policy/);
  await assert.rejects(helper.request('windows 5'), /retrying in 5 s/);
  assert.equal(fake.spawned.length, 1);
});

test("a blocked helper's PowerShell error reads as one sentence, even where PowerShell wrapped it mid-word", () => {
  // Windows PowerShell 5.1 refusing the script under an AllSigned policy: wrapped at 120 columns,
  // then followed by its CategoryInfo lines.
  const stderr = [
    String.raw`File C:\Program Files\t3code-wow\bridge\src\capture-helper.ps1 cannot be loaded. The file C:\Program Files\t3code-wow\br`,
    String.raw`idge\src\capture-helper.ps1 is not digitally signed. You cannot run this script on the current system.`,
    '    + CategoryInfo          : SecurityError: (:) [], ParentContainsErrorRecordException',
    '    + FullyQualifiedErrorId : UnauthorizedAccess',
    '',
  ].join('\r\n');
  assert.equal(helperErrorText(stderr), String.raw`File C:\Program Files\t3code-wow\bridge\src\capture-helper.ps1 cannot be loaded. The file C:\Program Files\t3code-wow\bridge\src\capture-helper.ps1 is not digitally signed. You cannot run this script on the current system.`);
});
