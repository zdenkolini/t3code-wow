import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { T3Client, LOCAL_DOWN } from '../src/t3.js';
import { fakeT3, closedPort, waitForState } from './fake-t3.js';

// The local client finds T3 Code through $T3CODE_HOME/userdata/server-runtime.json.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-t3home-'));
process.env.T3CODE_HOME = home;
const runtimeFile = path.join(home, 'userdata', 'server-runtime.json');
const writeRuntime = (origin) => {
  fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
  fs.writeFileSync(runtimeFile, JSON.stringify({ origin }));
};

test('a closed local T3 Code says to open it, and the client reconnects on its own when it comes back', async (t) => {
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = new T3Client({ tokenProvider: async () => 'token' });
  t.after(() => client.stop());

  // Never opened since boot: no runtime file.
  client.start();
  await waitForState(client, 'offline');
  assert.match(client.error, /open T3 Code/i);

  // Closed again: the runtime file still names the old, now dead, port.
  writeRuntime(`http://127.0.0.1:${await closedPort()}`);
  await waitForState(client, 'connecting');
  await waitForState(client, 'offline');
  assert.match(client.error, /open T3 Code/i);

  // Opened again, on a new port.
  const server = await fakeT3();
  writeRuntime(server.origin);
  await waitForState(client, 'connected', 20000);

  // Closed while connected, then opened again.
  await server.close();
  await waitForState(client, 'offline');
  await waitForState(client, (s, e) => e === LOCAL_DOWN);
  const again = await fakeT3();
  t.after(() => again.close());
  writeRuntime(again.origin);
  await waitForState(client, 'connected', 20000);
});
