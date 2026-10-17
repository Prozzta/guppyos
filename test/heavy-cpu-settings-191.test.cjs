'use strict';
/**
 * HEAVY-CPU-OPTIONS-191: the two options persist. Each of the four combinations is written through
 * the real config module, lands in config.json, and is what the heavy jobs read back (heavyCpuOptions).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(): a throwaway userData root, never the real config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-settings-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { heavyCpuOptions } = loadTs('src/main/heavyCpu.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('both options default off', () => {
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: false, half: false });
});

test('each of the four combinations persists to config.json and is read back; one option never moves the other', () => {
  for (const [b, h] of [[true, false], [false, true], [true, true], [false, false]]) {
    writeConfig({ heavyJobsBackgroundPriority: b, heavyJobsHalfCores: h });
    const disk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    assert.equal(disk.heavyJobsBackgroundPriority, b);
    assert.equal(disk.heavyJobsHalfCores, h);
    assert.deepEqual(heavyCpuOptions(readConfig()), { background: b, half: h });
  }
  writeConfig({ heavyJobsHalfCores: true });
  writeConfig({ heavyJobsBackgroundPriority: true });
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: true, half: true }, 'a patch of one keeps the other');
  writeConfig({ heavyJobsAtOnce: 'off' });
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: true, half: true }, 'independent of the heavy lock');
});
