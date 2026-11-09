import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addPathEntry, removePathEntry, commandShim } from '../src/command-windows.js';

const onWindows = { skip: process.platform !== 'win32' && 'needs cmd.exe' };

// Write the shim for `script` into a temporary folder and run it the way a terminal does.
function shimFor(t, scriptBody, node = process.execPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'app dir', 't3code-wow.js');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, scriptBody);
  const shim = path.join(dir, 'bin', 't3code-wow.cmd');
  fs.mkdirSync(path.dirname(shim));
  fs.writeFileSync(shim, commandShim({ node, script }));
  const run = (args, env = process.env) => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', shim, ...args], { encoding: 'utf8', env });
  return { dir, shim, run };
}

test('the t3code-wow command passes its arguments and exit code through', onWindows, (t) => {
  const { run } = shimFor(t, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 3;');
  const r = run(['install', '--wow-dir', 'D:\\World of Warcraft']);
  assert.deepEqual(JSON.parse(r.stdout), ['install', '--wow-dir', 'D:\\World of Warcraft']);
  assert.equal(r.status, 3);
});

test('the t3code-wow command falls back to node on PATH when the recorded node is gone', onWindows, (t) => {
  const { run } = shimFor(t, 'console.log("ran");', 'C:\\nowhere\\node.exe');
  const r = run([], { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.PATH}` });
  assert.equal(r.stdout.trim(), 'ran');
  assert.equal(r.status, 0);
});

test('the t3code-wow command finishes cleanly when what it runs deletes it (uninstall)', onWindows, (t) => {
  const { shim, run } = shimFor(t, 'require("fs").rmSync(process.env.SHIM); console.log("removed");');
  const r = run([], { ...process.env, SHIM: shim });
  assert.equal(r.stdout.trim(), 'removed');
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
});

const env = { USERPROFILE: 'C:\\Users\\Ana' };

test('adding a folder to the user PATH appends it and keeps the other entries as written', () => {
  assert.equal(
    addPathEntry('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools', 'C:\\Users\\Ana\\.local\\bin', env),
    '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools;C:\\Users\\Ana\\.local\\bin',
  );
});

test('a folder already on the user PATH, however it is written, is not added again', () => {
  for (const written of ['%USERPROFILE%\\.local\\bin', 'c:\\users\\ana\\.LOCAL\\bin\\', 'C:/Users/Ana/.local/bin']) {
    assert.equal(addPathEntry(`C:\\Tools;${written}`, 'C:\\Users\\Ana\\.local\\bin', env), null, written);
  }
});

test('adding to an empty user PATH gives just that folder', () => {
  assert.equal(addPathEntry('', 'C:\\Users\\Ana\\.local\\bin', env), 'C:\\Users\\Ana\\.local\\bin');
});

test('removing a folder from the user PATH takes out every copy of it and leaves the rest as written', () => {
  assert.equal(
    removePathEntry('%USERPROFILE%\\.local\\bin;C:\\Tools;C:\\Users\\Ana\\.local\\bin\\;%SystemRoot%\\x', 'C:\\Users\\Ana\\.local\\bin', env),
    'C:\\Tools;%SystemRoot%\\x',
  );
});

test('removing a folder that is not on the user PATH changes nothing', () => {
  assert.equal(removePathEntry('C:\\Tools', 'C:\\Users\\Ana\\.local\\bin', env), null);
});
