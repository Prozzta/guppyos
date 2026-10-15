'use strict';

// TES-FLOOR-WHOLE-188: the hull continued below a framed pack's art (hull.ts). Per column, from
// the bottom outline down, the colour above it; a seam or edge column keeps its own colour. Checked
// on small arts and against the tes pack: the strip covers every column of the art, and no person
// standing anywhere on the deck is ever under the cover.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const ROOT = path.join(__dirname, '..');
const R = loadTs('src/renderer/src/scene/themes/raster.ts');
const Hu = loadTs('src/renderer/src/scene/themes/hull.ts');
const F = loadTs('src/renderer/src/scene/themes/framing.ts');

const put = (px, x, y, c) => { for (let k = 0; k < 4; k++) px.data[(y * px.width + x) * 4 + k] = c[k]; };
const get = (px, x, y) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));
const FACE = [90, 100, 110, 255], LINE = [10, 10, 20, 255], SEAM = [30, 30, 40, 255];

test('hullSkirt: a face column continues its face, a seam column its seam, an empty column stays empty', () => {
  const art = R.blank(4, 10);
  // Column 0: face down to row 6, a 2 px outline (rows 7, 8). Column 1: face to row 4, a 1 px
  // outline at row 5. Column 2: a seam colour all the way down to row 8. Column 3: nothing.
  for (let y = 0; y <= 6; y++) put(art, 0, y, FACE);
  put(art, 0, 7, LINE); put(art, 0, 8, LINE);
  for (let y = 0; y <= 4; y++) put(art, 1, y, FACE);
  put(art, 1, 5, LINE);
  for (let y = 0; y <= 8; y++) put(art, 2, y, SEAM);
  const sk = Hu.hullSkirt(art, 0, 3, 9);
  assert.equal(sk.x, 0);
  assert.equal(sk.y, 5, 'the cover starts at the highest outline row');
  assert.deepEqual([sk.cover.width, sk.cover.height], [4, 5]);
  assert.deepEqual([0, 1, 2, 3].map((x) => get(sk.strip, x, 0)), [FACE, FACE, SEAM, [0, 0, 0, 0]]);
  // Column 0: clear above its outline (row 7), the face from there down.
  assert.deepEqual([5, 6, 7, 8, 9].map((y) => get(sk.cover, 0, y - 5)[3]), [0, 0, 255, 255, 255]);
  assert.deepEqual(get(sk.cover, 0, 4), FACE);
  assert.deepEqual([5, 6, 7, 8, 9].map((y) => get(sk.cover, 1, y - 5)), [FACE, FACE, FACE, FACE, FACE]);
  // The seam column is kept as it is and continued below its last row.
  assert.deepEqual([5, 6, 7, 8, 9].map((y) => get(sk.cover, 2, y - 5)[3]), [0, 0, 0, 0, 255]);
  assert.deepEqual(get(sk.cover, 2, 4), SEAM);
  assert.deepEqual([5, 6, 7, 8, 9].map((y) => get(sk.cover, 3, y - 5)[3]), [0, 0, 0, 0, 0]);
  assert.equal(Hu.hullSkirt(R.blank(3, 3), 0, 2, 2), null, 'no art: no skirt');
});

test('hullSkirt on the tes pack: every art column continues, the cover holds no person, the strip runs past any pane', () => {
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const dir = path.join(ROOT, 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(dir)));
  const f = P.finishPack(r.value, H.decodeImages(dir, T.normPath, r.value.images), r.diagnostics).value;
  const SM = f.scene;
  const plan = C.buildScenePlan({ ...SM, store: f.store });
  const art = R.blank(SM.PW, SM.PH);
  C.compose(art, plan.below, 0, 0);
  for (const it of plan.sorted) if (it.px) C.compose(art, it.px, Math.round(it.x), Math.round(it.y), it.opacity);
  const fr = F.floorFrame('tes', SM.PW, SM.PH);
  const x0 = fr.x + F.FRAME_MARGIN, x1 = fr.x + fr.w - F.FRAME_MARGIN - 1, y1 = fr.y + fr.h - 1;
  assert.deepEqual([x0, x1, y1], [F.PACK_ART.tes.x0, F.PACK_ART.tes.x1, F.PACK_ART.tes.y1]);
  const sk = Hu.hullSkirt(art, x0, x1, y1);
  assert.equal(sk.strip.width, x1 - x0 + 1);
  for (let i = 0; i < sk.strip.width; i++) assert.equal(sk.strip.data[i * 4 + 3], 255, `strip column ${x0 + i} is opaque: no gap below the ship`);
  // The cover lies below the deck: under no reachable cell, and under no person on one (the
  // sheet's opaque box, drawn at round(x - fw/2), round(y - fh), one px higher mid-step).
  assert.ok(sk.y > F.PACK_ART.tes.keep.y1 - 64 && sk.y + sk.cover.height - 1 === y1);
  const covered = (x, y) => {
    const cx = x - sk.x, cy = y - sk.y;
    return cx >= 0 && cy >= 0 && cx < sk.cover.width && cy < sk.cover.height && sk.cover.data[(cy * sk.cover.width + cx) * 4 + 3] !== 0;
  };
  const Rd = f.manifest.spriteRenderer, fw = Rd.frameWidth, fh = Rd.frameHeight, sh = f.store.get(f.sheet);
  const o = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let y = 0; y < sh.height; y++) for (let x = 0; x < sh.width; x++) if (sh.data[(y * sh.width + x) * 4 + 3]) {
    o.x0 = Math.min(o.x0, x % fw); o.x1 = Math.max(o.x1, x % fw); o.y0 = Math.min(o.y0, y % fh); o.y1 = Math.max(o.y1, y % fh);
  }
  const g = SM.grid.g;
  let cells = 0;
  for (let i = 0; i < SM.reach.length; i++) if (SM.reach[i]) {
    cells++;
    const cx = (i % SM.grid.W) * g, cy = Math.floor(i / SM.grid.W) * g;
    for (let py = cy; py < cy + g; py++) for (let px = cx; px < cx + g; px++) {
      assert.ok(!covered(px, py), `reachable px ${px},${py} under the cover`);
      const sx = px - fw / 2, sy = py - fh;
      for (let y = o.y0 - 1; y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) assert.ok(!covered(sx + x, sy + y), `a person at ${px},${py} under the cover`);
    }
  }
  assert.ok(cells > 100, 'the deck is read');
  assert.ok(Hu.HULL_STRIP_ROWS * 1 > 4000, 'the strip runs past the bottom of any pane');
});
