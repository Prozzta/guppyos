'use strict';
require('./tools/own-job.cjs');
/**
 * TES foundation, RENDERED (a hidden Electron window, the real OfficeFloor): the pack dispatch
 * and its fallback, with the neutral-deck fixture bundled through the harness's packSources
 * stub (harness-main.cjs, HARNESS_THEME_PACKS). Jim S1 on 0d85ca1c.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const DECK = join(__dirname, 'fixtures', 'themes', 'neutral-deck');

test('RENDERED: a valid pack draws StationFloor; an invalid pack draws the Office plus a status note', { timeout: harnessTestTimeout(90_000) }, async () => {
  const packs = [
    { dir: 'deck-ok', from: DECK, id: 'deck-ok' },
    { dir: 'deck-broken', from: DECK, id: 'deck-broken', dropPictures: ['pictures/chair.png'] },
  ];
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'theme-pack-floor.tsx'),
    { timeoutMs: 90_000, env: { HARNESS_THEME_PACKS: JSON.stringify(packs) } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.themes, ['office:office', 'deck-broken:stations', 'deck-ok:stations'], 'both packs catalogue');
  assert.deepEqual(r.packs, { ok: true, broken: true });

  assert.equal(r.valid.officeWrapper, false, 'a valid pack is not the Office branch');
  assert.equal(r.valid.hostBackground, 'rgb(16, 20, 24)', "StationFloor's host carries the pack background (#101418)");
  assert.equal(r.valid.canvas, true, 'and draws');
  assert.equal(r.valid.status, null);

  assert.equal(r.invalid.officeWrapper, true, 'an unloadable pack falls back to the Office');
  assert.equal(r.invalid.canvas, true);
  assert.match(r.invalid.status, /^Theme "deck-broken" could not be loaded, so the Office is shown\. The picture "pictures\/chair\.png" could not be decoded\./);

  assert.equal(r.office.officeWrapper, true, 'the office id is the Office');
  assert.equal(r.office.status, null, 'with no note');
});
