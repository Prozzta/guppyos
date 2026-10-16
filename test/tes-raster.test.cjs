'use strict';

// TES-GUPPY-RASTER, TES-FLOOR-EASE-188: drawn whole every frame, TES's 'below' and statics cost
// about twice the office's raster time, and at a fractional zoom each sprite rounded on its own
// and seamed. StationFloor composes the scene in map space at an integer scale k instead: a floor
// texture with 'below' and every static (the very same sprites), then by depth the people and the
// statics near them (frontPicker), then 'above'; one quad shows it through the camera
// (src/renderer/src/scene/themes/staticCache.ts). These tests pin the pieces the picture's
// sameness rests on, model the compositing to show it is the same picture, and pin the wiring;
// tes-floor-ease-188.test.cjs checks the rendered scene against the full depth sort.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const C = loadTs('src/renderer/src/scene/themes/staticCache.ts');
const R = loadTs('src/renderer/src/scene/themes/raster.ts');

function picture(w, h, paint) {
  const px = R.blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (c) px.data.set(c, (y * w + x) * 4);
  }
  return px;
}
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const int = (n) => Math.floor(rnd() * n);
const byDepth = (a, b) => a.foot - b.foot || a.rank - b.rank;

test('binaryAlpha, hasVisiblePixel and staticsCacheable: only 0/255 alpha at opacity 1 is cached', () => {
  const solid = picture(3, 2, (x) => (x ? [9, 9, 9, 255] : null));
  const soft = picture(3, 2, (x) => (x ? [9, 9, 9, 128] : null));
  assert.equal(C.binaryAlpha(solid), true);
  assert.equal(C.binaryAlpha(soft), false);
  assert.equal(C.hasVisiblePixel(R.blank(4, 4)), false);
  assert.equal(C.hasVisiblePixel(solid), true);
  assert.equal(C.staticsCacheable({ below: solid, sorted: [{ px: solid, opacity: 1 }, { px: null, opacity: 1 }] }), true);
  assert.equal(C.staticsCacheable({ below: soft, sorted: [] }), false, 'a soft below');
  assert.equal(C.staticsCacheable({ below: solid, sorted: [{ px: soft, opacity: 1 }] }), false, 'a soft static');
  assert.equal(C.staticsCacheable({ below: solid, sorted: [{ px: solid, opacity: 0.5 }] }), false, 'a static below opacity 1');
});

test("staticOrder is the statics' relative order in the full depth sort with people", () => {
  for (let run = 0; run < 50; run++) {
    const statics = Array.from({ length: 30 }, () => ({ foot: int(10), rank: int(3) }));
    const people = Array.from({ length: 6 }, () => ({ foot: int(10), rank: int(3), person: true }));
    const full = [...statics.map((s, i) => ({ ...s, i })), ...people].sort(byDepth).filter((it) => !it.person).map((it) => it.i);
    assert.deepEqual(C.staticOrder(statics), full);
  }
});

test('frontPicker: statics with an opaque pixel near a person, closed in draw order over opaque pixels, not boxes', () => {
  // Two big boxes overlap, but their opaque strokes are far apart: only the one near the person is drawn again.
  const u = C.NEAR_CELL / 8; // the layout below is drawn for an 8 px grid; scale it to the grid
  const stroke = (w, h, at) => picture(w, h, (x, y) => (x === at ? [1, 1, 1, 255] : null));
  const statics = [
    { x: 0, y: 0, px: stroke(60 * u, 40 * u, 2 * u) }, // opaque column at map x = 2u
    { x: 10 * u, y: 0, px: stroke(60 * u, 40 * u, 50 * u) }, // box overlaps the first; opaque column at map x = 60u
    { x: 0, y: 28 * u, px: stroke(8 * u, 8 * u, 6 * u) }, // opaque near the first's column, not near the person
    { x: 0, y: 0, px: null }
  ];
  const pick = C.frontPicker(statics, [0, 1, 2, 3], 80 * u, 48 * u);
  assert.deepEqual(pick([{ x: 0, y: 10 * u, w: 4 * u, h: 4 * u }]), [true, false, true, false], 'the stroke near the person, and the later one near it');
  assert.deepEqual(pick([{ x: 58 * u, y: 10 * u, w: 4 * u, h: 4 * u }]), [false, true, false, false]);
  assert.deepEqual(pick([]), [false, false, false, false]);
  // Draw order matters: an earlier static near a picked one is under it in the cache already.
  assert.deepEqual(C.frontPicker(statics, [2, 0, 1, 3], 80 * u, 48 * u)([{ x: 0, y: 10 * u, w: 4 * u, h: 4 * u }]), [true, false, false, false]);
});

test('model: at an integer scale k, the floor texture, then by depth the people and the statics frontPicker picks, is the full depth sort', () => {
  // A sprite's quad edges round to the texel grid; a texel samples the sprite texel under its
  // centre on that rounded quad. At an integer k every static sits on whole texels, so drawn
  // again over the floor texture it lands exactly where the texture has it; a person may stand
  // between texels, and rounds the same in both pictures. Statics are big, mostly transparent
  // boxes with thin strokes (as TES's rails); people have soft alpha. The full picture draws
  // below, then statics and people by depth. The scene: the floor texture (below, then every
  // static by staticOrder), then by depth the people and the statics frontPicker picks for them.
  // The map is 160x120 so a 12 px cell and its one-cell margin matter.
  const over = (dst, c, a) => (a === 255 ? c : a === 0 ? dst : dst.map((d, k) => Math.round((c[k] * a + d * (255 - a)) / 255)));
  const MW = 160, MH = 120;
  let indexOrderFails = 0, crewTopFails = 0;
  for (let run = 0; run < 48; run++) {
    const k = 1 + (run % 4), W = MW * k, Hh = MH * k;
    const below = picture(MW, MH, (x, y) => ((x + y) % 3 ? [x, y, 1, 255] : null));
    const sorted = Array.from({ length: 60 }, (_, n) => {
      const w = 2 + int(40), h = 2 + int(24), a = int(3), b = int(5);
      const stroke = (x, y) => (Math.abs(x - y * a - b) < 1 || rnd() < 0.01 ? [n * 4, int(255), 7, 255] : null);
      return { x: int(MW - w), y: int(MH - h), foot: int(60), rank: int(2), opacity: 1, px: picture(w, h, stroke) };
    });
    const people = Array.from({ length: 8 }, (_, n) => (
      { x: rnd() * (MW - 5), y: rnd() * (MH - 7), foot: int(60), rank: int(2), px: picture(5, 7, () => [200, n * 30, 90, [0, 128, 255][int(3)]]) }
    ));
    const quad = (it) => [Math.floor(it.x * k + 0.5), Math.floor((it.x + it.px.width) * k + 0.5), Math.floor(it.y * k + 0.5), Math.floor((it.y + it.px.height) * k + 0.5)];
    const draw = (img, it) => {
      const [X0, X1, Y0, Y1] = quad(it);
      for (let Y = Math.max(0, Y0); Y < Math.min(Hh, Y1); Y++) for (let X = Math.max(0, X0); X < Math.min(W, X1); X++) {
        const u = Math.floor((X + 0.5 - X0) / (X1 - X0) * it.px.width), v = Math.floor((Y + 0.5 - Y0) / (Y1 - Y0) * it.px.height);
        const s = (v * it.px.width + u) * 4, d = Y * W + X;
        img[d] = over(img[d], Array.from(it.px.data.slice(s, s + 3)), it.px.data[s + 3]);
      }
    };
    const base = () => Array.from({ length: W * Hh }, () => [0, 0, 0]);
    const full = base();
    draw(full, { x: 0, y: 0, px: below });
    [...sorted, ...people].sort(byDepth).forEach((it) => draw(full, it));
    const order = C.staticOrder(sorted);
    const floor = base();
    draw(floor, { x: 0, y: 0, px: below });
    for (const i of order) draw(floor, sorted[i]);
    const boxes = people.map((q) => ({ x: q.x, y: q.y, w: q.px.width, h: q.px.height }));
    const scene = (closureOrder) => {
      const img = floor.map((c) => c.slice());
      const on = closureOrder ? C.frontPicker(sorted, closureOrder, MW, MH)(boxes) : sorted.map(() => false);
      [...sorted.filter((_, i) => on[i]), ...people].sort(byDepth).forEach((it) => draw(img, it));
      return img;
    };
    assert.deepEqual(scene(order), full, `run ${run}, k=${k}`);
    // Closed in index order rather than draw order, or with no statics drawn again (the people
    // over every static, as 3164805f), it must fail somewhere, or this model could not tell.
    if (JSON.stringify(scene(sorted.map((_, i) => i))) !== JSON.stringify(full)) indexOrderFails += 1;
    if (JSON.stringify(scene(null)) !== JSON.stringify(full)) crewTopFails += 1;
  }
  assert.ok(indexOrderFails > 0, 'a closure walked in index order is caught');
  assert.ok(crewTopFails > 0, 'the people drawn over every static are caught');
});

test('exactPicker: statics with an opaque pixel inside a person, closed in draw order over shared opaque pixels only', () => {
  const dot = (w, h, pts) => picture(w, h, (x, y) => (pts.some(([a, b]) => a === x && b === y) ? [1, 1, 1, 255] : null));
  const statics = [
    { x: 10, y: 10, px: dot(10, 10, [[0, 0], [9, 9]]) }, // opaque at (10,10) and (19,19)
    { x: 19, y: 19, px: dot(4, 4, [[0, 0]]) }, // shares (19,19) with the first
    { x: 20, y: 19, px: dot(4, 4, [[0, 0]]) }, // (20,19): next to the first, no shared pixel
    { x: 0, y: 0, px: null },
    { x: 30, y: 30, px: dot(4, 4, [[3, 3]]) }, // (33,33)
  ];
  const pick = C.exactPicker(statics, [0, 1, 2, 3, 4], 64, 64);
  assert.deepEqual(pick([{ x: 8, y: 8, w: 3, h: 3 }]), [true, true, false, false, false], 'the one under the person, and the later one sharing a pixel with it');
  assert.deepEqual(pick([{ x: 11, y: 11, w: 8, h: 8 }]), [false, false, false, false, false], 'a box over only transparent pixels picks nothing');
  assert.deepEqual(pick([{ x: 32.5, y: 32.5, w: 0.6, h: 0.6 }]), [false, false, false, false, true], 'a box between px reaches every px it touches');
  assert.deepEqual(pick([{ x: 33.5, y: 33.5, w: 2, h: 2 }]), [false, false, false, false, true]);
  assert.deepEqual(pick([{ x: 34, y: 34, w: 2, h: 2 }]), [false, false, false, false, false]);
  assert.deepEqual(pick([]), [false, false, false, false, false]);
  // Draw order matters: an earlier static sharing a pixel is under the picked one in the floor already.
  assert.deepEqual(C.exactPicker(statics, [1, 0, 2, 3, 4], 64, 64)([{ x: 8, y: 8, w: 3, h: 3 }]), [true, false, false, false, false]);
});

test('exactPicker: a static is under a box exactly when a scan of the box finds an opaque pixel (no closure)', () => {
  // The per-tick test reads a summed-area table; this scans every px the box touches instead.
  let picked = 0;
  for (let run = 0; run < 400; run++) {
    const w = 1 + int(24), h = 1 + int(24), sx = int(40), sy = int(40), p = [0, 0.02, 0.3, 1][run % 4];
    const it = { x: sx, y: sy, px: picture(w, h, () => (rnd() < p ? [1, 1, 1, 1 + int(255)] : null)) };
    const q = { x: sx - 8 + rnd() * (w + 10), y: sy - 8 + rnd() * (h + 10), w: rnd() * 12, h: rnd() * 12 };
    let want = false;
    for (let y = Math.floor(q.y); y < Math.ceil(q.y + q.h); y++) for (let x = Math.floor(q.x); x < Math.ceil(q.x + q.w); x++) {
      const u = x - sx, v = y - sy;
      if (u >= 0 && v >= 0 && u < w && v < h && it.px.data[(v * w + u) * 4 + 3] !== 0) want = true;
    }
    picked += want;
    assert.equal(C.exactPicker([it], [0], 64, 64)([q])[0], want, `run ${run}`);
  }
  assert.ok(picked > 40 && picked < 360, `both outcomes exercised (${picked} of 400 picked)`);
});

test('model: at a whole scale, the floor texture, then by depth the people and the statics exactPicker picks, is the full depth sort', () => {
  // TES-FLOOR-WHOLE-188: the world at n device px per map px on whole device px; statics on whole
  // map px land exactly on their pixels in the floor texture, people anywhere (the quad rounds).
  const over = (dst, c, a) => (a === 255 ? c : a === 0 ? dst : dst.map((d, k) => Math.round((c[k] * a + d * (255 - a)) / 255)));
  const MW = 120, MH = 90;
  let indexOrderFails = 0, noClosureFails = 0, crewTopFails = 0;
  for (let run = 0; run < 48; run++) {
    const n = 1 + (run % 3), W = MW * n, Hh = MH * n;
    const below = picture(MW, MH, (x, y) => ((x + y) % 3 ? [x, y, 1, 255] : null));
    const sorted = Array.from({ length: 50 }, (_, i) => {
      const w = 2 + int(30), h = 2 + int(20), a = int(3), b = int(5);
      const stroke = (x, y) => (Math.abs(x - y * a - b) < 1 || rnd() < 0.02 ? [i * 5, int(255), 7, 255] : null);
      return { x: int(MW - w), y: int(MH - h), foot: int(60), rank: int(2), opacity: 1, px: picture(w, h, stroke) };
    });
    const people = Array.from({ length: 8 }, (_, i) => (
      { x: rnd() * (MW - 5), y: rnd() * (MH - 7), foot: int(60), rank: int(2), px: picture(5, 7, () => [200, i * 30, 90, [0, 128, 255][int(3)]]) }
    ));
    const quad = (it) => [Math.floor(it.x * n + 0.5), Math.floor((it.x + it.px.width) * n + 0.5), Math.floor(it.y * n + 0.5), Math.floor((it.y + it.px.height) * n + 0.5)];
    const draw = (img, it) => {
      const [X0, X1, Y0, Y1] = quad(it);
      for (let Y = Math.max(0, Y0); Y < Math.min(Hh, Y1); Y++) for (let X = Math.max(0, X0); X < Math.min(W, X1); X++) {
        const u = Math.floor((X + 0.5 - X0) / (X1 - X0) * it.px.width), v = Math.floor((Y + 0.5 - Y0) / (Y1 - Y0) * it.px.height);
        const s = (v * it.px.width + u) * 4, d = Y * W + X;
        img[d] = over(img[d], Array.from(it.px.data.slice(s, s + 3)), it.px.data[s + 3]);
      }
    };
    const base = () => Array.from({ length: W * Hh }, () => [0, 0, 0]);
    const full = base();
    draw(full, { x: 0, y: 0, px: below });
    [...sorted, ...people].sort(byDepth).forEach((it) => draw(full, it));
    const order = C.staticOrder(sorted);
    const floor = base();
    draw(floor, { x: 0, y: 0, px: below });
    for (const i of order) draw(floor, sorted[i]);
    const boxes = people.map((q) => ({ x: q.x, y: q.y, w: q.px.width, h: q.px.height }));
    const scene = (on) => {
      const img = floor.map((c) => c.slice());
      [...sorted.filter((_, i) => on[i]), ...people].sort(byDepth).forEach((it) => draw(img, it));
      return JSON.stringify(img);
    };
    const want = JSON.stringify(full);
    assert.equal(scene(C.exactPicker(sorted, order, MW, MH)(boxes)), want, `run ${run}, n=${n}`);
    if (scene(C.exactPicker(sorted, sorted.map((_, i) => i), MW, MH)(boxes)) !== want) indexOrderFails += 1;
    // No closure: only the statics under a person.
    const direct = sorted.map((it) => C.exactPicker([it], [0], MW, MH)(boxes)[0]);
    if (scene(direct) !== want) noClosureFails += 1;
    if (scene(sorted.map(() => false)) !== want) crewTopFails += 1;
  }
  assert.ok(indexOrderFails > 0, 'a closure walked in index order is caught');
  assert.ok(noClosureFails > 0, 'no closure is caught');
  assert.ok(crewTopFails > 0, 'the people drawn over every static are caught');
});

test('exactPicker on the TES pack: a person on any reachable cell has few statics drawn again (frontPicker chained 56 on average)', () => {
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const CO = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const dir = path.join(__dirname, '..', 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(dir)));
  const f = P.finishPack(r.value, H.decodeImages(dir, T.normPath, r.value.images), r.diagnostics).value;
  const SM = f.scene;
  const plan = CO.buildScenePlan({ ...SM, store: f.store });
  const order = C.staticOrder(plan.sorted);
  const exact = C.exactPicker(plan.sorted, order, plan.below.width, plan.below.height);
  const near = C.frontPicker(plan.sorted, order, plan.below.width, plan.below.height);
  const g = SM.grid.g;
  let cells = 0, sumE = 0, maxE = 0, sumN = 0;
  for (let i = 0; i < SM.reach.length; i++) if (SM.reach[i]) {
    const box = [{ x: Math.round((i % SM.grid.W) * g + 2 - 16), y: Math.round(Math.floor(i / SM.grid.W) * g + 2 - 32), w: 32, h: 32 }];
    const e = exact(box), nb = near(box);
    const ne = e.filter(Boolean).length;
    cells++; sumE += ne; maxE = Math.max(maxE, ne); sumN += nb.filter(Boolean).length;
    e.forEach((on, j) => { if (on) assert.ok(nb[j], `cell ${i}: static ${j} picked by exactPicker only`); });
  }
  assert.ok(cells > 1000);
  assert.ok(sumE / cells < 8 && maxE <= 40, `mean ${(sumE / cells).toFixed(1)}, max ${maxE} statics per person`);
  assert.ok(sumN / cells > 4 * (sumE / cells), 'far fewer than frontPicker');
});

test('sceneBounds: the box of every opaque pixel of below, above and the statics; null when there is none', () => {
  const dot = (w, h, at) => picture(w, h, (x, y) => (x === at[0] && y === at[1] ? [1, 2, 3, 255] : null));
  const empty = R.blank(40, 30);
  assert.deepEqual(C.sceneBounds({ below: dot(40, 30, [5, 7]), above: empty, sorted: [] }), { x: 5, y: 7, w: 1, h: 1 });
  assert.deepEqual(C.sceneBounds({ below: dot(40, 30, [5, 7]), above: dot(40, 30, [20, 2]), sorted: [{ x: 30, y: 20, px: dot(4, 4, [3, 3]) }, { x: 0, y: 0, px: null }] }), { x: 5, y: 2, w: 29, h: 22 });
  // Transparent pixels do not count, however wide the sprite.
  assert.deepEqual(C.sceneBounds({ below: empty, above: empty, sorted: [{ x: 1, y: 1, px: picture(30, 20, (x, y) => (x === 2 && y === 3 ? [9, 9, 9, 1] : null)) }] }), { x: 3, y: 4, w: 1, h: 1 });
  assert.equal(C.sceneBounds({ below: empty, above: empty, sorted: [] }), null);
});

// 1.1.87 whole-branch audit, MUST 1: a UI zoom (Ctrl+= / Ctrl+-) changes the device pixel ratio
// but usually not the canvas's pixel size. k is taken from the world's scale times the
// renderer's resolution, so a new resolution gives a new k, and a new k rebuilds the floor.
test('sceneScale: the smallest integer at or above the device scale, at least 1, within the texel limit', () => {
  const b = { x: 0, y: 0, w: 288, h: 384 };
  assert.equal(C.sceneScale(1, b), 1);
  assert.equal(C.sceneScale(1.0000000001, b), 1, 'a float a hair over an integer is that integer');
  assert.equal(C.sceneScale(1.001, b), 2);
  assert.equal(C.sceneScale(2, b), 2);
  assert.equal(C.sceneScale(2.0166, b), 3, 'DPR 1.25 at 560x555');
  assert.equal(C.sceneScale(0.47, b), 1, 'never below 1: a tiny pane still has one texel per map px');
  assert.equal(C.sceneScale(12, b), 10, '4096 / 384 = 10.67: the RT stays within SCENE_MAX_TEXELS');
  assert.equal(C.sceneScale(12, b, 768), 2);
  assert.equal(C.sceneScale(5, { x: 0, y: 0, w: 9000, h: 10 }), 1, 'at least 1 even past the limit');
  assert.equal(C.SCENE_MAX_TEXELS, 4096);
});

test('the real TES pack is cacheable: binary alpha at opacity 1, and its "above" layer is empty', () => {
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const CO = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const ROOT = path.join(__dirname, '..', 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(ROOT)));
  const f = P.finishPack(r.value, H.decodeImages(ROOT, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  const plan = CO.buildScenePlan({ ...f.value.scene, store: f.value.store });
  assert.equal(C.staticsCacheable(plan), true);
  assert.equal(C.hasVisiblePixel(plan.above), false);
});

test('StationFloor draws the floor straight in the world: the floor texture holds below and every static, the very same sprites; the hull over it; no scene texture', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.doesNotMatch(src, /atlas/i, 'no split tiles: each would be rounded on its own');
  assert.doesNotMatch(src, /blitFramebuffer|screenCells|regionPicker|cacheKeyOf|wholeSceneRaster|NEAR_MIN_SCALE/);
  // PERF-FLOOR-FILL-188: the one scissor is paint()'s, each changed rect drawn again whole
  // (tes-floor-damage-188 proves every such frame equals a full draw).
  assert.equal((src.match(/SCISSOR_TEST/g) || []).length, 2, 'enabled and disabled once, in paint()');
  assert.match(src, /gl\.enable\(gl\.SCISSOR_TEST\);\s*try \{\s*for \(const p of todo\) \{\s*gl\.scissor\(p\.x, H - p\.y - p\.h, p\.w, p\.h\);\s*realRender\(\{ container: app\.stage, clear: true \}\);\s*\}\s*\} finally \{ gl\.disable\(gl\.SCISSOR_TEST\); \}/);
  // TES-FLOOR-WHOLE-188: the camera puts every frame on whole device px, so nothing is composed per frame.
  assert.doesNotMatch(src, /sceneRT|sceneSprite|sceneM\b|aboveRoot|sortLayer\.alpha/);
  assert.equal((src.match(/app\.renderer\.render\(/g) || []).length, 1, 'one render call: the floor texture build');
  assert.match(src, /const bounds = sceneBounds\(plan\);\s*const cached = bounds !== null && staticsCacheable\(plan\);\s*const order = staticOrder\(plan\.sorted\);\s*const frame0 = floorFrame\(pack\.manifest\.id, SM\.PW, SM\.PH\);\s*const pickFront = cached \? \(frame0\.keep \? exactPicker : frontPicker\)\(plan\.sorted, order, plan\.below\.width, plan\.below\.height\) : null;/);
  assert.match(src, /const floorRoot = new Container\(\);\s*const floorWorld = floorRoot\.addChild\(new Container\(\)\);/);
  // Placement and opacity as d267443e: a static's sprite sits at the plan's (x, y) at its opacity.
  assert.match(src, /s\.position\.set\(it\.x, it\.y\);\s*s\.alpha = it\.opacity;/);
  // Cached: the floor texture's tree holds below and every static by staticOrder, and the world
  // shows it. Not cached: below itself. Then the sort layer (people, and statics drawn again), the
  // hull, 'above' and the bubbles.
  assert.match(src, /if \(cached\) \{\s*floorWorld\.addChild\(below\);\s*for \(const i of order\) if \(staticTex\[i\]\) floorWorld\.addChild\(staticSprite\(i\)\);\s*world\.addChild\(floorView\);\s*\} else world\.addChild\(new Sprite\(below\.texture\)\);\s*world\.addChild\(sortLayer\);/);
  // The hull is made once, from the composited art, below the deck and over the hull's own
  // statics: no person is ever under it (tes-hull).
  assert.match(src, /const hull = new Container\(\);\s*if \(frame0\.deadBottom > 0\) \{\s*const art = blank\(SM\.PW, SM\.PH\);\s*composePx\(art, plan\.below, 0, 0\);\s*for \(const it of plan\.sorted\) if \(it\.px\) composePx\(art, it\.px, Math\.round\(it\.x\), Math\.round\(it\.y\), it\.opacity\);\s*const sk = hullSkirt\(art, frame0\.x \+ FRAME_MARGIN, frame0\.x \+ frame0\.w - FRAME_MARGIN - 1, frame0\.y \+ frame0\.h - 1\);/);
  assert.match(src, /strip\.position\.set\(sk\.x, frame0\.y \+ frame0\.h\);\s*strip\.height = HULL_STRIP_ROWS;/);
  // The live bubble layer belongs above the map's above plane, but below the world's stage mount.
  // PANEL-BLINK-188: the chair panels' layer right after 'above', before the bubbles.
  assert.match(src, /world\.addChild\(hull\);\s*if \(hasVisiblePixel\(plan\.above\)\) world\.addChild\(new Sprite\(own\(plan\.above\)\)\);\s*(?:\/\/[^\n]*\n\s*)*const panelLayer = new PanelLayer\(plan, SM, pack\.manifest\.stations\.layer, own, sortLayer, world\.addChild\(new Container\(\)\)\);\s*(?:\/\/[^\n]*\n\s*)*const bubbles = new BubbleLayer\(\{ width: SM\.PW, height: SM\.PH \}\);\s*world\.addChild\(bubbles\.container\);\s*\(app as any\)\.__bubbleLayer = bubbles;\s*app\.stage\.addChild\(world\);/);
  assert.equal((src.match(/own\(plan\.above\)/g) || []).length, 1, "'above' is made once");
  // The floor texture: the bounds at k texels per map px, 1:1, nearest; the old one freed first.
  // Its tree is scaled by k and moved to the bounds; the sprite is the bounds in map px.
  assert.match(src, /const buildFloor = \(k: number\) => \{\s*const b = bounds!;\s*floorView\.texture = Texture\.EMPTY;\s*floorRT\?\.destroy\(true\);\s*floorRT = RenderTexture\.create\(\{ width: b\.w \* k, height: b\.h \* k, resolution: 1, scaleMode: 'nearest' \}\);\s*floorWorld\.scale\.set\(k\);\s*floorWorld\.position\.set\(-b\.x \* k, -b\.y \* k\);\s*app\.renderer\.render\(\{ container: floorRoot, target: floorRT, clear: true \}\);\s*floorView\.texture = floorRT;\s*floorView\.position\.set\(b\.x, b\.y\);\s*floorView\.scale\.set\(1 \/ k\);\s*floorK = k;/);
});

test('StationFloor picks after each tick: the floor rebuilt on a new k, the statics near a person drawn again; and sorts on a depth change', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  // NIT-2 (Jim): the floor depends on k alone, so it is rebuilt exactly when k changes, at once.
  assert.match(src, /const compose = \(\) => \{\s*if \(!cached\) return;\s*const k = sceneScale\(world\.scale\.x \* app\.renderer\.resolution, bounds!\);\s*if \(k !== floorK\) buildFloor\(k\);/);
  // COFFEE-NEVER-186: the cups in hand and the parked mugs are boxes too: a static in front of a mug is drawn again over it.
  assert.match(src, /const near: Box\[\] = \[\];\s*for \(const s of sprites\.values\(\)\) near\.push\(\{ x: s\.sprite\.x, y: s\.sprite\.y, w: fw, h: fh \}\);\s*for \(const c of cups\.values\(\)\) near\.push\(\{ x: c\.sprite\.x, y: c\.sprite\.y, w: MUG_W, h: MUG_H \}\);\s*for \(const m of mugs\.values\(\)\) near\.push\(\{ x: m\.sprite\.x, y: m\.sprite\.y, w: MUG_W, h: MUG_H \}\);\s*const front = pickFront!\(near\);\s*statics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = front\[i\]; \}\);\s*\};/);
  // After onTick, so the pick has this tick's people and depth order.
  assert.match(src, /app\.ticker\.add\(onTick\);\s*(?:\/\/[^\n]*\n\s*)*applyFloorFrameBudget\(app\.ticker\);\s*(?:\/\/[^\n]*\n\s*)*app\.ticker\.add\(compose\);/);
  assert.match(src, /let lastDepth: string \| null = null;/);
  // COFFEE-NEVER-186: the key also holds the coffee mugs (a cup's side, a parked mug's depth).
  assert.match(src, /const depth = people\.map\(\(q\) => `\$\{q\.id\}:\$\{q\.foot\}:\$\{q\.rank\}:\$\{cups\.get\(q\.id\)\?\.back \?\? '-'\}`\)\.join\('\|'\) \+ '#' \+ \[\.\.\.mugs\]\.map\(\(\[id, m\]\) => `\$\{id\}:\$\{m\.foot\}:\$\{m\.rank\}`\)\.join\('\|'\);\s*if \(depth === lastDepth\) return;\s*lastDepth = depth;/);
  assert.match(src, /plan\.sorted\.map\(\(it, i\) => \(\{ foot: it\.foot, rank: it\.rank, sprite: statics\[i\] \}\)\);\s*for \(const q of people\) items\.push\(q\);\s*for \(const m of mugs\.values\(\)\) items\.push\(m\);\s*for \(const q of panelLayer\.sorted\) items\.push\(q\);\s*items\.sort\(byDepth\);/);
});

test('StationFloor frees the floor texture, its tree and every texture it made on unmount, before the app is destroyed', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /\(app as any\)\.__free = \[\s*\(\) => floorRT\?\.destroy\(true\),\s*\(\) => floorRoot\.destroy\(\{ children: true \}\),\s*\(\) => \{ for \(const t of owned\) t\.destroy\(true\); \},\s*\];/);
  assert.doesNotMatch(src, /dropCells|postrender/);
  // The behavioral bubble test owns bridge disposal; this pin keeps it before cache/app teardown.
  assert.match(src, /\(a as any\)\.__unsub\?\.\(\); \} catch \{\s*\}\s*try \{ \(a as any\)\.__disposeHiveBubbles\?\.\(\); \} catch \{\s*\}\s*teardownFloor\(a, \(a as any\)\.__free \?\? \[\]\);\s*\}/);
  assert.doesNotMatch(src, /safeDestroy\(a\)/, 'the unmount destroys the app only through teardownFloor');
  assert.match(src, /const own = \(px: Pixels\) => \{ const t = texture\(px\); owned\.push\(t\); return t; \};/);
  assert.equal((src.match(/\btexture\(/g) || []).length, 2, "texture() is defined once and called only by own()");
});

test('teardownFloor, with real pixi: frees the floor whole; the old order (free after app.destroy, one catch) did not', async () => {
  const { pathToFileURL } = require('node:url');
  if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' };
  const P = await import(pathToFileURL(path.resolve(__dirname, '..', 'node_modules/pixi.js/lib/index.mjs')).href);
  const T = loadTs('src/renderer/src/scene/themes/teardown.ts');
  // The floor's shapes: cells over the cache target on the stage, a cache tree off it whose
  // statics share owned textures with the world's, and the owned textures.
  const floor = () => {
    const stage = new P.Container(), cacheLayer = stage.addChild(new P.Container()), world = stage.addChild(new P.Container());
    const rt = P.RenderTexture.create({ width: 64, height: 32, resolution: 2, scaleMode: 'nearest' });
    const cells = new Map();
    for (let i = 0; i < 4; i++) cells.set(i, cacheLayer.addChild(new P.Sprite(new P.Texture({ source: rt.source, frame: new P.Rectangle(i * 16, 0, 16, 16) }))));
    const owned = [0, 1].map(() => new P.Texture({ source: new P.TextureSource({ width: 4, height: 4 }) }));
    const cacheRoot = new P.Container(), cacheWorld = cacheRoot.addChild(new P.Container());
    for (const t of owned) { cacheWorld.addChild(new P.Sprite(t)); world.addChild(new P.Sprite(t)); }
    let stopped = false;
    const app = { ticker: { stop: () => { stopped = true; } }, destroy: (_removeView, options) => stage.destroy(options) };
    const dropCells = () => { for (const s of cells.values()) s.destroy({ texture: true, textureSource: false }); cells.clear(); };
    const frees = [dropCells, () => rt.destroy(true), () => cacheRoot.destroy({ children: true }), () => { for (const t of owned) t.destroy(true); }];
    const cellTextures = [...cells.values()].map((s) => s.texture), rtSource = rt.source;
    const freed = () => stopped && stage.destroyed && cellTextures.every((t) => t.destroyed) && rt.destroyed && rtSource.destroyed
      && cacheRoot.destroyed && cacheWorld.destroyed && owned.every((t) => t.destroyed && t.source === null);
    return { app, frees, freed };
  };
  const now = floor();
  T.teardownFloor(now.app, now.frees);
  assert.equal(now.freed(), true, 'teardownFloor frees everything');
  // 6ef1773a's order: safeDestroy, then the whole free under one catch. The cells were already
  // destroyed with the stage; destroying them again throws, and the rest is never freed.
  const old = floor();
  old.app.ticker.stop();
  old.app.destroy(true, { children: true });
  let threw = false;
  try { for (const f of old.frees) f(); } catch { threw = true; }
  assert.equal(threw, true);
  assert.equal(old.freed(), false, 'the old order leaves the cache target, its tree and the textures behind');
  // One step throwing does not skip the rest.
  const one = floor();
  T.teardownFloor(one.app, [() => { throw new Error('a step'); }, ...one.frees]);
  assert.equal(one.freed(), true);
});
