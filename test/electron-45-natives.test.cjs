'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads test-temp.cjs, a file a census mutates
// in place; refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { tempDir } = require('./tools/test-temp.cjs');

const root = path.join(__dirname, '..');
const electron = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const probe = path.join(__dirname, 'electron-45-native-probe.cjs');
const available = fs.existsSync(electron);

function run(runAsNode) {
  // The probe's own folder (WAL database, isolated Electron app paths): removed when this file ends.
  const env = { ...process.env, MUNDER_HIDDEN: '1', E45_PROBE_DIR: tempDir('electron45-probe-') };
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(electron, [probe], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

for (const [label, runAsNode] of [['normal Electron', false], ['ELECTRON_RUN_AS_NODE', true]]) {
  test(`Electron 45 loads every native module under ${label}`, { skip: !available && 'Electron not installed' }, () => {
    const result = run(runAsNode);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const line = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(line), {
      electron: '45.3.0', node: '24.22.2', napi: '10',
      betterSqlite3Binary: 'prebuilds/win32-x64.node', sqlite: '3.53.4', runAsNode
    });
  });
}

// ELECTRON-EXIT-AV: Electron 45's app.exit() called right after ready crashes in browser teardown
// about 1 in 1000 runs under load, with or without natives (bisect 3000 runs per variant). The
// race is too rare to catch in one run, so pin the shape: the probe quits normally and never
// calls app.exit.
test('the native probe quits normally (no app.exit right after ready)', () => {
  const src = fs.readFileSync(probe, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /app\.exit\s*\(/, 'app.exit() right after ready races Electron startup');
  assert.match(src, /whenReady\(\)\.then\(\(\) => \{ console\.log\(report\); app\.quit\(\); \}\)/);
});
