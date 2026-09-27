'use strict';
/**
 * RR-164 (Jim finding 1), RENDERED on the REAL App (a hidden Electron window): a recovered view
 * opens on the live floor with the "restored" notice, not the launch-time HivePicker; a normal
 * launch still shows the picker.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

test('RENDERED (real App): recovered -> no HivePicker + the notice; a normal launch -> the picker', { timeout: 180_000 }, async () => {
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'app-recovery.tsx'), { timeoutMs: 150_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.recovered.picker, false, 'a recovered view skips the picker (its switch path would tear down live agents)');
  assert.equal(r.recovered.notice, true, 'and shows the restored notice on the floor');
  assert.match(r.recovered.noticeText, /The view crashed and was restored/);
  assert.equal(r.normal.picker, true, 'a normal launch still shows the picker');
  assert.equal(r.normal.notice, false);
});
