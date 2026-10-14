'use strict';

// TES-GUPPY-RASTER: the stations floor draws its layers as live tiles from shared atlas pages
// (src/renderer/src/scene/themes/atlas.ts), not as whole map-sized pictures. Drawn whole, TES cost
// about twice the office's raster time per frame (480x300, software GL); tiled, it costs less than
// the office. These tests pin that the tiling is EXACT (every visible pixel is drawn, from the same
// texel a whole texture would give, including at a tile's rim), that it is what StationFloor draws,
// and that on the real TES pack it removes the transparent fill.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const A = loadTs('src/renderer/src/scene/themes/atlas.ts');
const R = loadTs('src/renderer/src/scene/themes/raster.ts');

function picture(w, h, paint) {
  const px = R.blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (c) px.data.set(c, (y * w + x) * 4);
  }
  return px;
}
const at = (px, x, y) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

/** Every piece (and its 1 px ring) reads the picture's own pixels, clamped at its edge; every pixel
 *  left out of the pieces is fully transparent. */
function assertExact(images, atlas, label) {
  const P = A.ATLAS_PAD;
  images.forEach((im, i) => {
    if (!im) { assert.equal(atlas.pieces[i].length, 0, `${label}: a null picture has no pieces`); return; }
    if (atlas.unpacked[i]) return;
    const covered = new Uint8Array(im.width * im.height);
    for (const p of atlas.pieces[i]) {
      const page = atlas.pages[p.page];
      for (let y = -P; y < p.h + P; y++) for (let x = -P; x < p.w + P; x++) {
        const sx = Math.min(im.width - 1, Math.max(0, p.x + x)), sy = Math.min(im.height - 1, Math.max(0, p.y + y));
        assert.deepEqual(at(page, p.ax + x, p.ay + y), at(im, sx, sy), `${label} #${i}: piece (${p.x},${p.y}) at ${x},${y}`);
        if (x >= 0 && y >= 0 && x < p.w && y < p.h) covered[(p.y + y) * im.width + p.x + x] = 1;
      }
    }
    for (let k = 0; k < covered.length; k++) {
      if (!covered[k]) assert.equal(im.data[k * 4 + 3], 0, `${label} #${i}: a visible pixel (${k % im.width},${Math.floor(k / im.width)}) is left out`);
    }
  });
}

test('liveTiles keeps exactly the tiles holding a pixel with alpha above 0, including partial edge tiles', () => {
  const px = picture(20, 11, (x, y) => (x === 9 && y === 2) || (x === 19 && y === 10) ? [1, 2, 3, 1] : null);
  assert.deepEqual(A.liveTiles(px, 8), [{ x: 8, y: 0, w: 8, h: 8 }, { x: 16, y: 8, w: 4, h: 3 }]);
  assert.deepEqual(A.liveTiles(R.blank(30, 30), 8), [], 'a fully transparent picture has no tiles');
});

test('tileAtlas is exact: pieces carry the picture\'s own neighbours (not their own edge) and leave out only transparent pixels', () => {
  // Diagonal strokes (like the TES rails), a solid block, a 1x1 dot, nothing at all, and no picture.
  const diag = picture(37, 29, (x, y) => (Math.abs(x - y) < 2 ? [200, (x * 7) % 256, y, 255] : null));
  const block = picture(16, 16, (x, y) => [x * 16, y * 16, 9, 255]);
  const dot = picture(1, 1, () => [5, 6, 7, 128]);
  const images = [diag, null, block, dot, R.blank(40, 40)];
  const atlas = A.tileAtlas(images, 30); // 3x3 cells of 10 px a page
  assertExact(images, atlas, 'synthetic');
  assert.ok(atlas.pages.length > 1, 'a small page size spills onto more pages');
  assert.equal(atlas.pieces[4].length, 0, 'the empty picture draws nothing');
  for (const pg of atlas.pages) assert.ok(pg.width <= 30 && pg.height <= 30, 'pages respect maxSize');
});

test('the real TES pack, tiled: exact, the empty "above" layer drops out, and the statics lose ~90% of their fill', () => {
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const ROOT = path.join(__dirname, '..', 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(ROOT)));
  const f = P.finishPack(r.value, H.decodeImages(ROOT, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  const plan = C.buildScenePlan({ ...f.value.scene, store: f.value.store });
  const images = [plan.below, plan.above, ...plan.sorted.map((it) => it.px)];
  const atlas = A.tileAtlas(images, 4096);
  assertExact(images, atlas, 'tes');
  assert.equal(atlas.pages.length, 1, 'one page: the statics and the floor batch together');
  assert.ok(atlas.unpacked.every((u) => !u));
  assert.equal(atlas.pieces[1].length, 0, "TES's 'above' layer has no visible pixel, so it draws nothing");
  const area = (ims) => ims.reduce((n, im) => n + (im ? im.width * im.height : 0), 0);
  const tiledArea = (from) => atlas.pieces.slice(from).flat().reduce((n, p) => n + p.w * p.h, 0);
  const staticsWhole = area(images.slice(2)), staticsTiled = tiledArea(2);
  assert.ok(staticsTiled < staticsWhole * 0.15, `statics fill ${staticsTiled} px tiled vs ${staticsWhole} px whole`);
  const belowTiled = atlas.pieces[0].reduce((n, p) => n + p.w * p.h, 0);
  assert.ok(belowTiled < plan.below.width * plan.below.height * 0.2, `below fill ${belowTiled} px tiled`);
});

test('StationFloor draws below, above and every static from the tiled atlas, never a whole picture', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /import \{ tileAtlas \} from '\.\/atlas';/);
  assert.match(src, /tileAtlas\(\[plan\.below, plan\.above, \.\.\.plan\.sorted\.map\(\(it\) => it\.px\)\]/);
  assert.match(src, /world\.addChild\(tiled\(0, plan\.below\)\);/);
  assert.match(src, /world\.addChild\(tiled\(1, plan\.above\)\);/);
  assert.match(src, /const s = tiled\(2 \+ i, it\.px\);/);
  assert.doesNotMatch(src, /new Sprite\(texture\(plan\.(below|above)\)\)/, 'no whole map-sized layer');
  // The whole-picture path is only the fallback for a picture the atlas could not take.
  assert.equal((src.match(/new Sprite\(texture\(/g) || []).length, 1);
  assert.match(src, /if \(atlas\.unpacked\[i\]\) \{ c\.addChild\(new Sprite\(texture\(px\)\)\); return c; \}/);
});

test('StationFloor re-sorts depth only when a person\'s depth key or the crew changes', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /const depth = people\.map\(\(q\) => `\$\{q\.id\}:\$\{q\.foot\}:\$\{q\.rank\}`\)\.join\('\|'\);\s*if \(depth === lastDepth\) return;\s*lastDepth = depth;/);
  // The statics still take part in every sort, so a person passes behind a rail or a console as before.
  assert.match(src, /plan\.sorted\.map\(\(it, i\) => \(\{ foot: it\.foot, rank: it\.rank, sprite: statics\[i\] \}\)\);\s*for \(const q of people\) items\.push\(q\);\s*items\.sort\(byDepth\);/);
});
