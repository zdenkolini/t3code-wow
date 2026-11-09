import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findT3Cli } from '../src/auth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-cli-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// A fake user profile; the lookup is told its platform, environment and home.
function fakeHome() {
  return fs.mkdtempSync(path.join(root, 'home-'));
}

function touch(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
}

const onWindows = (home, env = {}) => findT3Cli({ platform: 'win32', home, env });

test("finds T3 Code Nightly's t3.cmd shim in the T3 home", () => {
  const home = fakeHome();
  const shim = touch(path.join(home, '.t3', 'bin', 't3.cmd'));
  assert.equal(onWindows(home), shim);
});

test('T3CODE_HOME moves the T3 home, and the default home is then ignored', () => {
  const home = fakeHome();
  touch(path.join(home, '.t3', 'bin', 't3.cmd'));
  const moved = path.join(home, 'elsewhere');
  const shim = touch(path.join(moved, 'bin', 't3.cmd'));
  assert.equal(onWindows(home, { T3CODE_HOME: moved }), shim);
  fs.rmSync(shim);
  assert.equal(onWindows(home, { T3CODE_HOME: moved }), null);
});

test('falls back to a .local/bin shim, then t3.exe', () => {
  const home = fakeHome();
  const exe = touch(path.join(home, '.local', 'bin', 't3.exe'));
  assert.equal(onWindows(home), exe);
  const shim = touch(path.join(home, '.local', 'bin', 't3.cmd'));
  assert.equal(onWindows(home), shim);
  const nightly = touch(path.join(home, '.t3', 'bin', 't3.cmd'));
  assert.equal(onWindows(home), nightly);
});

test('searches PATH split on ";", with quoted entries and Windows extensions', () => {
  const home = fakeHome();
  const first = path.join(home, 'tools');
  const second = path.join(home, 'Program Files', 'T3');
  fs.mkdirSync(first, { recursive: true });
  touch(path.join(first, 't3')); // an extensionless file isn't runnable on Windows
  const cmd = touch(path.join(second, 't3.cmd'));
  const PATH = `${first};"${second}";`;
  assert.equal(onWindows(home, { PATH }), cmd);
  const exe = touch(path.join(first, 't3.exe'));
  assert.equal(onWindows(home, { PATH }), exe);
  assert.equal(onWindows(home, { PATH, PATHEXT: '.CMD' }), cmd);
});

test('T3_CLI overrides every other location', () => {
  const home = fakeHome();
  touch(path.join(home, '.t3', 'bin', 't3.cmd'));
  const custom = touch(path.join(home, 'portable', 't3.cmd'));
  assert.equal(onWindows(home, { T3_CLI: custom }), custom);
});
