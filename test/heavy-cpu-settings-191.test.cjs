'use strict';
/**
 * HALFCORES-OVERSUBSCRIBE: the two options persist. Each of the four combinations is written through
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

test('background defaults off and the 50% CPU-rate cap defaults on', () => {
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: false, cap: true });
});

test('each of the four combinations persists to config.json and is read back; one option never moves the other', () => {
  for (const [b, c] of [[true, false], [false, true], [true, true], [false, false]]) {
    writeConfig({ heavyJobsBackgroundPriority: b, heavyJobsCpuCap: c });
    const disk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    assert.equal(disk.heavyJobsBackgroundPriority, b);
    assert.equal(disk.heavyJobsCpuCap, c);
    assert.deepEqual(heavyCpuOptions(readConfig()), { background: b, cap: c });
  }
  writeConfig({ heavyJobsCpuCap: true });
  writeConfig({ heavyJobsBackgroundPriority: true });
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: true, cap: true }, 'a patch of one keeps the other');
  writeConfig({ heavyJobsAtOnce: 'off' });
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: true, cap: true }, 'independent of the heavy lock');
});

test('the retired half-core preference migrates once to the CPU-rate cap', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ heavyJobsHalfCores: false }));
  assert.deepEqual(heavyCpuOptions(readConfig()), { background: false, cap: false });
  writeConfig({ heavyJobsBackgroundPriority: true });
  const disk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(disk.heavyJobsCpuCap, false);
  assert.equal('heavyJobsHalfCores' in disk, false);
});
