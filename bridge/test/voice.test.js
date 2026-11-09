import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Voice } from '../src/voice.js';

test('on Windows, speech and dictation report not available even with engines on PATH', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-voice-'));
  for (const name of ['spd-say', 'espeak-ng', 'voxtype', 'pw-record']) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    const logs = [];
    const voice = new Voice({ platform: 'win32', ttsCommand: 'my-tts', log: (l) => logs.push(l) });
    assert.deepEqual(voice.describe(), { tts: null, dictation: null, unavailable: 'not available on Windows' });
    assert.equal(voice.speak('hello'), false);
    assert.match(logs.join('\n'), /not available on Windows/);
    assert.match(voice.missingDictation(), /not available on Windows/);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
