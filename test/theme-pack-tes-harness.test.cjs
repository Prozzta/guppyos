'use strict';
require('./tools/own-job.cjs');
/**
 * TES data (plan step 6), RENDERED (a hidden Electron window, the real OfficeFloor): the repo's own
 * themes/tes pack, bundled through the harness's packSources stub (harness-main.cjs,
 * HARNESS_THEME_PACKS), is a stations pack with nine stations, and the floor draws StationFloor
 * for it with no fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');

test('RENDERED: the bundled TES pack is a stations pack with nine stations, and the floor draws StationFloor for it', { timeout: harnessTestTimeout(90_000) }, async () => {
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'theme-pack-tes-floor.tsx'),
    { timeoutMs: 90_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.themes, ['office:office', 'tes:stations'], 'the catalogue offers the Office and tes');
  assert.equal(r.station, true, "isStationPack('tes')");

  assert.deepEqual(r.data.diagnostics, [], 'tes loads with no diagnostic');
  assert.equal(r.data.stations, 9, 'nine stations');
  assert.deepEqual(r.data.seatOrder, ['Captain', 'Speck1', 'Speck2', 'Chair1', 'Chair2', 'Chair3', 'Chair4', 'Chair5', 'Chair6']);
  assert.equal(r.data.captain, 'Captain');

  assert.equal(r.floor.officeWrapper, false, 'tes is not the Office branch');
  assert.equal(r.floor.hostBackground, 'rgb(20, 22, 27)', "StationFloor's host carries the TES background (#14161b)");
  assert.equal(r.floor.canvas, true, 'and draws');
  assert.equal(r.floor.status, null, 'with no fallback note');
});
