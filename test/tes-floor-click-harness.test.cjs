'use strict';
require('./tools/own-job.cjs');
/**
 * TES-GUPPY-RASTER, RENDERED (a hidden Electron window, the real OfficeFloor and the bundled tes
 * pack): once the floor draws from its static cache and draws again only what changed (the
 * scissored passes of damage.ts ran in the last frame), a real click on each person, between frames, selects that person. The passes must not leave the
 * people invisible after the frame: Pixi's EventBoundary prunes invisible sprites from hit tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario, harnessTestTimeout } = require('./electron-harness/run.cjs');

const TES = join(__dirname, '..', 'themes', 'tes');

test('RENDERED: on a cached TES floor, clicking each person selects that person', { timeout: harnessTestTimeout(120_000) }, async () => {
  const r = await runScenario(join(__dirname, 'electron-harness', 'scenarios', 'floor-tes-click.tsx'),
    { timeoutMs: 120_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.lastFrameScissors > 0, `the last frame drew only what changed (scissored passes, PERF-FLOOR-FILL-188: ${r.lastFrameScissors})`);
  assert.equal(r.people, 5, 'five people on the floor');
  const selected = r.clicks.map((c) => c.selected);
  assert.deepEqual([...selected].sort(), ['andy', 'dwight', 'god', 'jim', 'pam'], `each click selects its own person: ${JSON.stringify(r.clicks)}`);
});
