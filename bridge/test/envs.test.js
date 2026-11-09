import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertOwnerOnly } from './owner-only.js';

// envs.js picks its folder when it loads, so point it at a temporary one first.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-envs-'));
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
