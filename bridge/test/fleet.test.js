import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeT3, waitForState } from './fake-t3.js';

// Remote tokens live under $XDG_CONFIG_HOME/t3code-wow/envs, read when the modules load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-fleet-'));
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
process.env.T3CODE_HOME = path.join(tmp, 't3'); // no runtime file: T3 Code closed here
const { Fleet } = await import('../src/fleet.js');
const { saveToken } = await import('../src/envs.js');
const { LOCAL_DOWN } = await import('../src/t3.js');

test('a closed local T3 Code does not hold up other machines', async (t) => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const mac = await fakeT3({ environmentId: 'env-mac' });
  t.after(() => mac.close());
  await saveToken('env-mac', { token: 'remote-token' });

  const fleet = new Fleet({
    localTokens: async () => 'local-token',
    environments: [{ code: 'e1', id: 'env-mac', label: 'mac', urls: [mac.origin] }],
  });
  t.after(() => fleet.stop());
  fleet.start();

  const [local, remote] = fleet.envs;
  await waitForState(remote.client, 'connected');
  await waitForState(local.client, 'offline');
  assert.equal(fleet.error, LOCAL_DOWN);
  assert.deepEqual(
    fleet.environments().map((e) => [e.code, e.state]),
    [['', 'offline'], ['e1', 'connected']],
  );
});
