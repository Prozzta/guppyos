'use strict';

// TES-GUPPY-RASTER: drawn whole every frame, TES's 'below' and statics cost about twice the
// office's raster time (480x300, software GL). StationFloor now draws them, with the very same
// sprites, into a screen-sized cache when the camera or the view changes, copies the cache's
// reachable cells 1:1 each frame, and draws again only the statics that meet a person
// (src/renderer/src/scene/themes/staticCache.ts). 8d84cece's atlas tiles were rounded one by one
// and seamed at fractional zoom; nothing here splits a sprite. These tests pin the pieces the
// picture's sameness rests on, model the compositing to show it is the same picture, and pin the
// wiring.

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

test('cacheKeyOf: the same key exactly when every cached edge rounds alike; a static near a tie is live, or keyed by its float32 once settled', () => {
  const map = { w: 40, h: 20 }, boxes = [{ x: 0, y: 0, w: 10, h: 5 }, null, { x: 17, y: 3, w: 20, h: 6 }];
  const K = (k, dx, dy, r = 1) => C.cacheKeyOf(map, boxes, k, k, dx, dy, r);
  assert.equal(K(1.46, 3.2, 7.1).key, K(1.46, 3.21, 7.09).key, 'a sub-pixel drift that rounds alike');
  assert.notEqual(K(1.46, 3.2, 7.1).key, K(1.46, 3.8, 7.1).key, 'an edge that rounds elsewhere');
  assert.equal(K(1.46, 3.2, 7.1).exact, K(1.46, 3.2, 7.1).key, 'with no tie, the settled key is the same key');
  // Pixi's float64 vertex: a * w + (a * x + tx); the GPU gets its float32.
  const near = C.cacheKeyOf(map, [{ x: 8, y: 0, w: 2, h: 2 }], 0.46875, 0.46875, 15.0000002, 0.1, 2);
  assert.deepEqual(near.live, [true], 'x = 8 at 15/16 device px (r = 2), offset 30: on a tie, live');
  assert.equal(near.key.split(',')[1], 'live');
  assert.equal(near.exact.split(',')[1], `f ${[0.46875 * 8 + 15.0000002, 0.46875 * 2 + (0.46875 * 8 + 15.0000002), 0.1, 0.46875 * 2 + 0.1].map(Math.fround).join(' ')}`);
  assert.equal(C.cacheKeyOf(map, [{ x: 8, y: 0, w: 2, h: 2 }], 0.46875, 0.46875, 15.00000021, 0.1, 2).exact, near.exact, 'a drift inside one float32 step: settled alike');
  assert.notEqual(C.cacheKeyOf(map, [{ x: 8, y: 0, w: 2, h: 2 }], 0.46875, 0.46875, 15.00001, 0.1, 2).exact, near.exact, 'a float32 step: a new key');
  assert.match(C.cacheKeyOf(map, [], 1, 1, 0.5003, 0, 1).key, /^f /, "'below' near a tie: its float32 edges");
  for (let run = 0; run < 200; run++) {
    const k = 0.5 + rnd() * 3, dx = rnd() * 99, dy = rnd() * 99, r = [1, 1.25, 2][run % 3];
    const { key, live } = C.cacheKeyOf(map, boxes, k, k, dx, dy, r);
    const parts = key.split(',');
    boxes.forEach((b, i) => {
      if (!b) return assert.equal(live[i], false);
      const L = k * b.x + dx, T = k * b.y + dy, e = [L, k * b.w + L, T, k * b.h + T].map((v) => v * r);
      assert.equal(live[i], e.some((v) => Math.abs(v - Math.floor(v) - 0.5) < 2e-3));
      if (!live[i]) assert.ok(parts.includes(e.map(Math.round).join(' ')), `static ${i} keyed by its rounded edges`);
    });
  }
});

test('overlaps is strict: boxes that only touch do not meet (their rounded quads cannot share a pixel)', () => {
  assert.equal(C.overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 4, y: 0, w: 4, h: 4 }), false);
  assert.equal(C.overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 0, y: 4, w: 4, h: 4 }), false);
  assert.equal(C.overlaps({ x: 0, y: 0, w: 4, h: 4 }, { x: 3.5, y: 3, w: 4, h: 4 }), true);
});

test('screenCells covers every device pixel a live map pixel can round onto, at fractional zooms', () => {
  const px = picture(41, 23, () => (rnd() < 0.05 ? [1, 2, 3, 255] : null));
  const boxes = C.liveBoxes(px, 5, 9, 8);
  for (const b of boxes) assert.ok(b.w <= 8 && b.h <= 8);
  for (let run = 0; run < 40; run++) {
    const k = 0.6 + rnd() * 3, dx = rnd() * 50 - 20, dy = rnd() * 50 - 20, W = 200, Hh = 120, T = 32;
    const cells = C.screenCells(boxes, k, dx, dy, W, Hh, T);
    const inCell = (x, y) => cells.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
      if (!px.data[(y * px.width + x) * 4 + 3]) continue;
      const X0 = Math.round((5 + x) * k + dx), X1 = Math.round((6 + x) * k + dx), Y0 = Math.round((9 + y) * k + dy), Y1 = Math.round((10 + y) * k + dy);
      for (let Y = Math.max(0, Y0); Y < Math.min(Hh, Y1); Y++) for (let X = Math.max(0, X0); X < Math.min(W, X1); X++) {
        assert.ok(inCell(X, Y), `pixel (${x},${y}) at device (${X},${Y}), k=${k}`);
      }
    }
    for (const c of cells) assert.ok(c.x % T === 0 && c.y % T === 0 && c.x + c.w <= W && c.y + c.h <= Hh);
  }
});

test('model: rasterised as Pixi does (each sprite rounded on its own, nearest texels), cache + picked statics is the full picture', () => {
  // Each sprite's quad edges round to the device grid on their own; a device pixel samples the texel
  // under its centre on that rounded quad. Statics are big, mostly transparent boxes with thin
  // strokes (as TES's rails); people have soft alpha. The full picture draws below, then statics
  // and people by depth; the cached one draws the cache (below + statics by staticOrder), then, by
  // depth, the people and the statics frontPicker picks. Some statics are live (left out of the
  // cache, drawn in their slot, seeds of the picker). Scales from NEAR_MIN_SCALE up.
  const over = (dst, c, a) => (a === 255 ? c : a === 0 ? dst : dst.map((d, k) => Math.round((c[k] * a + d * (255 - a)) / 255)));
  const MW = 48, MH = 36;
  let naiveFails = 0;
  for (let run = 0; run < 80; run++) {
    const k = run < 10 ? 1 : C.NEAR_MIN_SCALE + rnd() * 2.5, dx = run < 10 ? 0 : rnd() * 9, dy = run < 10 ? 0 : rnd() * 9;
    const W = Math.ceil(MW * k + dx) + 2, Hh = Math.ceil(MH * k + dy) + 2;
    const below = picture(MW, MH, (x, y) => ((x + y) % 3 ? [x, y, 1, 255] : null));
    const sorted = Array.from({ length: 14 }, (_, n) => {
      const w = 2 + int(30), h = 2 + int(20), a = int(3), b = int(5);
      const stroke = (x, y) => (Math.abs(x - y * a - b) < 1 || rnd() < 0.01 ? [n * 17, int(255), 7, 255] : null);
      return { x: int(MW - w), y: int(MH - h), foot: int(30), rank: int(2), opacity: 1, px: picture(w, h, stroke) };
    });
    const people = Array.from({ length: 3 }, (_, n) => (
      { x: int(MW - 5), y: int(MH - 7), foot: int(30), rank: int(2), px: picture(5, 7, () => [200, n * 40, 90, [0, 128, 255][int(3)]]) }
    ));
    assert.equal(C.staticsCacheable({ below, sorted }), true);
    const draw = (img, it) => {
      const X0 = Math.floor(it.x * k + dx + 0.5), X1 = Math.floor((it.x + it.px.width) * k + dx + 0.5);
      const Y0 = Math.floor(it.y * k + dy + 0.5), Y1 = Math.floor((it.y + it.px.height) * k + dy + 0.5);
      for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
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
    const live = sorted.map(() => rnd() < 0.15); // left out of the cache (an edge near a rounding tie)
    const cached = base();
    draw(cached, { x: 0, y: 0, px: below });
    for (const i of order) if (!live[i]) draw(cached, sorted[i]);
    const on = C.frontPicker(sorted, order, MW, MH)(people.map((p) => ({ x: p.x, y: p.y, w: p.px.width, h: p.px.height })), live);
    [...sorted.filter((_, i) => on[i]), ...people].sort(byDepth).forEach((it) => draw(cached, it));
    assert.deepEqual(cached, full, `run ${run}, k=${k}`);
    // The same check, picking only statics with an opaque texel inside a person's box (no margin,
    // no closure), must fail somewhere, or this model could not tell.
    const naive = base();
    draw(naive, { x: 0, y: 0, px: below });
    for (const i of order) draw(naive, sorted[i]);
    const inside = (it, p) => { for (let y = 0; y < it.px.height; y++) for (let x = 0; x < it.px.width; x++) {
      const mx = it.x + x, my = it.y + y;
      if (it.px.data[(y * it.px.width + x) * 4 + 3] && mx >= p.x && mx < p.x + p.px.width && my >= p.y && my < p.y + p.px.height) return true;
    } return false; };
    [...sorted.filter((it) => people.some((p) => inside(it, p))), ...people].sort(byDepth).forEach((it) => draw(naive, it));
    if (JSON.stringify(naive) !== JSON.stringify(full)) naiveFails += 1;
  }
  assert.ok(naiveFails > 0, 'a picker with no margin and no closure is caught by the model');
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

test('StationFloor draws below and the statics through the cache, with the very same sprites', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.doesNotMatch(src, /atlas/i, 'no split tiles: each would be rounded on its own');
  assert.match(src, /const cached = staticsCacheable\(plan\);/);
  assert.match(src, /const cacheWorld = cacheRoot\.addChild\(new Container\(\)\);/);
  assert.match(src, /const order = staticOrder\(plan\.sorted\);/);
  assert.match(src, /cacheWorld\.addChild\(below\);\s*for \(const i of order\) if \(staticTex\[i\]\) cacheStatics\[i\] = cacheWorld\.addChild\(staticSprite\(i\)\);/);
  assert.match(src, /const belowDirect = new Sprite\(below\.texture\);\s*world\.addChild\(belowDirect\);\s*if \(cached\) \{/);
  assert.match(src, /app\.stage\.addChild\(cacheLayer\);\s*\}\s*world\.addChild\(sortLayer\);/);
  assert.match(src, /if \(!cached \|\| hasVisiblePixel\(plan\.above\)\) world\.addChild\(new Sprite\(own\(plan\.above\)\)\);\s*app\.stage\.addChild\(world\);/);
  // Placement and opacity as d267443e: a static's sprite sits at the plan's (x, y) at its opacity.
  assert.match(src, /s\.position\.set\(it\.x, it\.y\);\s*s\.alpha = it\.opacity;/);
  // The cache follows the world's transform, is drawn on the canvas by the canvas's own arithmetic
  // (a render texture's flipped projection tipped rounding ties) and blitted out, bottom row first;
  // cells copy it 1:1, mirrored back.
  assert.match(src, /cacheWorld\.position\.copyFrom\(world\.position\);\s*cacheWorld\.scale\.copyFrom\(world\.scale\);\s*app\.renderer\.render\(\{ container: cacheRoot, clear: true \}\);/);
  assert.match(src, /gl\.bindFramebuffer\(gl\.READ_FRAMEBUFFER, null\);\s*gl\.bindFramebuffer\(gl\.DRAW_FRAMEBUFFER, targets\.getGpuRenderTarget\(targets\.getRenderTarget\(rt\)\)\.framebuffer\);\s*gl\.blitFramebuffer\(0, 0, W, H, 0, 0, W, H, gl\.COLOR_BUFFER_BIT, gl\.NEAREST\);\s*gl\.bindFramebuffer\(gl\.FRAMEBUFFER, null\);/);
  assert.match(src, /const r = app\.renderer\.resolution, W = app\.canvas\.width, H = app\.canvas\.height;/);
  assert.match(src, /RenderTexture\.create\(\{ width: W \/ r, height: H \/ r, resolution: r, scaleMode: 'nearest' \}\);\s*const none = new Container\(\);\s*app\.renderer\.render\(\{ container: none, target: rt, clear: true \}\);[^\n]*\n\s*none\.destroy\(\);/);
  assert.match(src, /new Rectangle\(c\.x \/ r, \(H - c\.y - c\.h\) \/ r, c\.w \/ r, c\.h \/ r\)/);
  assert.match(src, /s\.position\.set\(c\.x \/ r, \(c\.y \+ c\.h\) \/ r\);\s*s\.scale\.y = -1;/);
});

test('StationFloor caches a picture once it holds for a tick, draws directly while it changes, and sorts on the first tick', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /let lastDepth: string \| null = null;/);
  assert.match(src, /const k = cacheKeyOf\(\{ w: plan\.below\.width, h: plan\.below\.height \}, staticBox, world\.scale\.x, world\.scale\.y, world\.x, world\.y, r\);/);
  assert.match(src, /const exact = k\.exact === null \? null : view \+ k\.exact;\s*const settled = exact !== null && exact === lastExact;\s*lastExact = exact;\s*const key = settled \? exact! : view \+ k\.key, live = settled \? noLive : k\.live;/);
  assert.match(src, /if \(key !== cacheKey && key === lastKey\) \{ refreshCache\(live\); cacheKey = key; \}\s*lastKey = key;\s*const useCache = [^;]*;\s*cacheLayer\.visible = useCache;\s*belowDirect\.visible = !useCache;/);
  assert.match(src, /const pickFront = cached \? frontPicker\(plan\.sorted, order, plan\.below\.width, plan\.below\.height\) : null;/);
  assert.match(src, /const useCache = key === cacheKey && world\.scale\.x \* r >= NEAR_MIN_SCALE && world\.scale\.y \* r >= NEAR_MIN_SCALE;/);
  assert.match(src, /const front = useCache \? pickFront!\(people\.map\(\(q\) => \(\{ x: q\.sprite\.x, y: q\.sprite\.y, w: fw, h: fh \}\)\), live\) : null;\s*statics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = front \? front\[i\] : true; \}\);/);
  assert.match(src, /const refreshCache = \(liveStatics: boolean\[\]\) => \{\s*cacheStatics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = !liveStatics\[i\]; \}\);/);
  assert.match(src, /const depth = people\.map\(\(q\) => `\$\{q\.id\}:\$\{q\.foot\}:\$\{q\.rank\}`\)\.join\('\|'\);\s*if \(depth === lastDepth\) return;\s*lastDepth = depth;/);
  assert.match(src, /plan\.sorted\.map\(\(it, i\) => \(\{ foot: it\.foot, rank: it\.rank, sprite: statics\[i\] \}\)\);\s*for \(const q of people\) items\.push\(q\);\s*items\.sort\(byDepth\);/);
});

test('StationFloor frees the cache target, its cells and every texture it made on unmount', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /\(app as any\)\.__free = \(\) => \{\s*dropCells\(\);\s*rt\?\.destroy\(true\);\s*cacheRoot\.destroy\(\{ children: true \}\);\s*for \(const t of owned\) t\.destroy\(true\);/);
  assert.match(src, /safeDestroy\(a\);\s*try \{ \(a as any\)\.__free\?\.\(\); \} catch/);
  assert.match(src, /const own = \(px: Pixels\) => \{ const t = texture\(px\); owned\.push\(t\); return t; \};/);
  assert.equal((src.match(/\btexture\(/g) || []).length, 2, "texture() is defined once and called only by own()");
});
