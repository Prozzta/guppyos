'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a scenario timeout includes the renderer progress checkpoint and main emits it every ten seconds', () => {
  const main = read('test/electron-harness/harness-main.cjs');
  assert.match(main, /latestProgress = \{ frames: 0, phase: 'setup', step: 'bundle', at:/);
  assert.match(main, /setInterval\(logProgress, 10_000\)/);
  assert.match(main, /progress \$\{JSON\.stringify\(latestProgress\)\}/);
  assert.match(main, /ipcMain\.on\('harness:progress'/);
  assert.match(read('test/electron-harness/harness-preload.cjs'), /progress: \(payload\) => ipcRenderer\.send\('harness:progress', payload\)/);
  const scenario = read('test/electron-harness/scenarios/tes-floor-damage.tsx');
  assert.match(scenario, /reportProgress = \(\) => window\.harness\.progress\(\{ frames: out\.frames, renders, phase: progressPhase, step: progressStep \}\)/);
  assert.match(scenario, /out\.frames % 60 === 0/);
});
