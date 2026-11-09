import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertOwnerOnly } from './owner-only.js';

// envs.js picks its folder when it loads, so point it at a temporary one first.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-envs-'));
after(() => fs.rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true }));
const { saveToken, readTokenData, tokenFile } = await import('../src/envs.js');

test('remote tokens: readable only by this account, also when one is renewed', async () => {
  const file = tokenFile('env-1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A token file from an older bridge, with the folder's default access.
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  await saveToken('env-1', { token: 'dummy', expiresAt: '2030-01-01T00:00:00Z' });
  assert.equal(readTokenData('env-1').token, 'dummy');
  assertOwnerOnly(file);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['env-1.json']);
});

test('two saves of the same token at once both end up readable only by this account', async () => {
  const file = tokenFile('env-2');
  // Staggered, so one save starts while another is between locking its side file and writing it.
  const tokens = Array.from({ length: 8 }, (_, i) => `t${i}`);
  const saves = tokens.map((token, i) => new Promise((r) => setTimeout(r, i * 10))
    .then(() => saveToken('env-2', { token, expiresAt: '2030-01-01T00:00:00Z' })));
  const results = await Promise.allSettled(saves);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.ok(tokens.includes(readTokenData('env-2').token));
  assertOwnerOnly(file);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('env-2')), ['env-2.json']);
});
