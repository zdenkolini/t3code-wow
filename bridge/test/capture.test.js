import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMacWindow, pickWindowsWindow, StripCapture } from '../src/capture.js';

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
