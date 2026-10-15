'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');
let run = null;
const result = () => (run ??= runScenario(join(__dirname, 'electron-harness', 'scenarios', 'tes-mail-envelope-187.tsx'), {
  timeoutMs: 120_000,
  env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) }
}));

test('RENDERED: TES mail creates one crew envelope, expires, routes human to the entrance, and ignores system', { timeout: harnessTestTimeout(120_000) }, async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.between, { sx: 84, sy: 74, ex: 236, ey: 150 }, 'the envelope flies between the mounted god and Andy anchors');
  assert.equal(r.goneAfter2500, true, 'the completed envelope is removed within 2.5 seconds');
  assert.deepEqual(r.humanTarget, { ex: r.entrance[0], ey: r.entrance[1] - 22 }, 'human mail flies to the TES entrance anchor');
  assert.equal(r.systemAdded, 0, 'system has no floor anchor, so no envelope is spawned');
});
