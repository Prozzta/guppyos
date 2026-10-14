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
    const k = 0.6 + rnd() * 3, dx = rnd() * 50 - 20, dy = rnd() * 50 - 20, W = 200, Hh = 120, T = run % 2 ? 32 : 1;
    const cells = C.screenCells(boxes, k, dx, dy, W, Hh, T);
    const inCell = (x, y) => cells.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    // As Pixi draws it: the sprite's quad rounds as a whole, and each device pixel samples the texel
    // under its centre, which can land a texel a pixel before its exact position (tile 1 shows it).
    const X0 = Math.floor(5 * k + dx + 0.5), X1 = Math.floor((5 + px.width) * k + dx + 0.5);
    const Y0 = Math.floor(9 * k + dy + 0.5), Y1 = Math.floor((9 + px.height) * k + dy + 0.5);
    for (let Y = Math.max(0, Y0); Y < Math.min(Hh, Y1); Y++) for (let X = Math.max(0, X0); X < Math.min(W, X1); X++) {
      const x = Math.floor((X + 0.5 - X0) / (X1 - X0) * px.width), y = Math.floor((Y + 0.5 - Y0) / (Y1 - Y0) * px.height);
      if (px.data[(y * px.width + x) * 4 + 3]) assert.ok(inCell(X, Y), `pixel (${x},${y}) at device (${X},${Y}), k=${k}`);
    }
    for (const c of cells) assert.ok(c.x % T === 0 && c.y % T === 0 && c.x + c.w <= W && c.y + c.h <= Hh);
  }
  // In exact arithmetic a texel never lands outside [floor(start), floor(end)] (the quad's edges
  // move by under half a pixel), so the model above cannot need the 1 px margin; it is there for the
  // GPU's fixed-point edges at exact ties, and is pinned in the source instead.
  const src = codeOnly(readSource('src/renderer/src/scene/themes/staticCache.ts'));
  assert.match(src, /Math\.floor\(\(b\.x \* k \+ dx - 1\) \/ tile\)\), x1 = Math\.min\(cols - 1, Math\.floor\(\(\(b\.x \+ b\.w\) \* k \+ dx \+ 1\) \/ tile\)\)/);
  assert.match(src, /Math\.floor\(\(b\.y \* k \+ dy - 1\) \/ tile\)\), y1 = Math\.min\(rows - 1, Math\.floor\(\(\(b\.y \+ b\.h\) \* k \+ dy \+ 1\) \/ tile\)\)/);
});

test('model: rasterised as Pixi does (each sprite rounded on its own, nearest texels), the cache, live statics and the scissored rects around the people make the full picture', () => {
  // Each sprite's quad edges round to the device grid on their own; a device pixel samples the texel
  // under its centre on that rounded quad. Statics are big, mostly transparent boxes with thin
  // strokes (as TES's rails); people have soft alpha. The full picture draws below, then statics
  // and people by depth. The floor's frame:
  // - main pass: the cache (below + the statics that are not live, by staticOrder), then the
  //   statics frontPicker picks with no people (the live ones and, closed in draw order, those
  //   over them);
  // - per rect (each person's device box, 1 px out, inside the screen; rects may overlap): cleared
  //   to the cache, then by depth the people and the statics regionPicker picks for any rect's map
  //   box (one set for all rects), clipped to it.
  // The map is 160x120 so a 12 px cell and its one-cell margin matter. Scales from NEAR_MIN_SCALE.
  const over = (dst, c, a) => (a === 255 ? c : a === 0 ? dst : dst.map((d, k) => Math.round((c[k] * a + d * (255 - a)) / 255)));
  const MW = 160, MH = 120;
  let indexOrderFails = 0;
  for (let run = 0; run < 60; run++) {
    const k = run < 6 ? 1 : C.NEAR_MIN_SCALE + rnd() * 2.5, dx = run < 6 ? 0 : rnd() * 9, dy = run < 6 ? 0 : rnd() * 9;
    const W = Math.ceil(MW * k + dx) + 2, Hh = Math.ceil(MH * k + dy) + 2;
    const below = picture(MW, MH, (x, y) => ((x + y) % 3 ? [x, y, 1, 255] : null));
    const sorted = Array.from({ length: 60 }, (_, n) => {
      const w = 2 + int(40), h = 2 + int(24), a = int(3), b = int(5);
      const stroke = (x, y) => (Math.abs(x - y * a - b) < 1 || rnd() < 0.01 ? [n * 4, int(255), 7, 255] : null);
      return { x: int(MW - w), y: int(MH - h), foot: int(60), rank: int(2), opacity: 1, px: picture(w, h, stroke) };
    });
    const people = Array.from({ length: 8 }, (_, n) => (
      { x: int(MW - 5), y: int(MH - 7), foot: int(60), rank: int(2), px: picture(5, 7, () => [200, n * 30, 90, [0, 128, 255][int(3)]]) }
    ));
    const live = sorted.map(() => rnd() < 0.1);
    const quad = (it) => [Math.floor(it.x * k + dx + 0.5), Math.floor((it.x + it.px.width) * k + dx + 0.5), Math.floor(it.y * k + dy + 0.5), Math.floor((it.y + it.px.height) * k + dy + 0.5)];
    const draw = (img, it, clip) => {
      const [X0, X1, Y0, Y1] = quad(it);
      for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
        if (clip && (X < clip.x || X >= clip.x + clip.w || Y < clip.y || Y >= clip.y + clip.h)) continue;
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
    const cache = base();
    draw(cache, { x: 0, y: 0, px: below });
    for (const i of order) if (!live[i]) draw(cache, sorted[i]);
    const frame = (closureOrder, regionCell, regionMargin) => {
      const img = cache.map((c) => c.slice());
      const main = C.frontPicker(sorted, closureOrder, MW, MH)([], live);
      sorted.filter((_, i) => main[i]).sort(byDepth).forEach((it) => draw(img, it));
      const pick = C.regionPicker(sorted, MW, MH, regionCell, regionMargin);
      const rects = [], on = sorted.map(() => false);
      for (const p of people) {
        const X0 = Math.max(0, Math.floor(p.x * k + dx) - 1), X1 = Math.min(W, Math.ceil((p.x + p.px.width) * k + dx) + 1);
        const Y0 = Math.max(0, Math.floor(p.y * k + dy) - 1), Y1 = Math.min(Hh, Math.ceil((p.y + p.px.height) * k + dy) + 1);
        if (X1 <= X0 || Y1 <= Y0) continue;
        const rect = { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
        rects.push(rect);
        pick({ x: (rect.x - dx) / k, y: (rect.y - dy) / k, w: rect.w / k, h: rect.h / k }).forEach((o, i) => { if (o) on[i] = true; });
      }
      for (const rect of rects) {
        for (let Y = rect.y; Y < rect.y + rect.h; Y++) for (let X = rect.x; X < rect.x + rect.w; X++) img[Y * W + X] = cache[Y * W + X].slice();
        [...sorted.filter((_, i) => on[i]), ...people].sort(byDepth).forEach((it) => draw(img, it, rect));
      }
      return img;
    };
    assert.deepEqual(frame(order, C.NEAR_CELL, 1), full, `run ${run}, k=${k}`);
    // Closed in index order rather than draw order must fail somewhere, or this model could not tell.
    if (JSON.stringify(frame(sorted.map((_, i) => i), C.NEAR_CELL, 1)) !== JSON.stringify(full)) indexOrderFails += 1;
  }
  assert.ok(indexOrderFails > 0, 'a closure walked in index order is caught');
});

test('regionPicker picks every static that samples an opaque texel at a device pixel of the rect, down to NEAR_MIN_SCALE', () => {
  // The rects' requirement itself, pixel by pixel. A static's quad edges round by at most half a
  // device px, so the texel a device pixel samples is within 0.5/k map px of the pixel centre's map
  // position, which is itself 0.5/k inside the rect's map box: the box's own cells hold every texel
  // the rect samples. The one-cell margin is for float ties at the box's edges only, so a picker
  // with no margin passes here too; one picking for a box 1 map px short at each side must not.
  const MW = 160, MH = 120;
  let missedShort = 0;
  for (let run = 0; run < 40; run++) {
    const k = C.NEAR_MIN_SCALE + rnd() * (run % 2 ? 0.3 : 2.5), dx = rnd() * 9, dy = rnd() * 9;
    const statics = Array.from({ length: 40 }, () => {
      const w = 2 + int(40), h = 2 + int(24);
      return { x: int(MW - w), y: int(MH - h), px: picture(w, h, () => (rnd() < 0.05 ? [1, 1, 1, 255] : null)) };
    });
    const pick = C.regionPicker(statics, MW, MH), bare = C.regionPicker(statics, MW, MH, 1, 0);
    for (let n = 0; n < 6; n++) {
      const rect = { x: int(Math.ceil(MW * k)), y: int(Math.ceil(MH * k)), w: 1 + int(40), h: 1 + int(40) };
      const box = { x: (rect.x - dx) / k, y: (rect.y - dy) / k, w: rect.w / k, h: rect.h / k };
      const on = pick(box), onBare = bare(box), onShort = bare({ x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 });
      let shortMissed = false;
      statics.forEach((it, i) => {
        const X0 = Math.floor(it.x * k + dx + 0.5), X1 = Math.floor((it.x + it.px.width) * k + dx + 0.5);
        const Y0 = Math.floor(it.y * k + dy + 0.5), Y1 = Math.floor((it.y + it.px.height) * k + dy + 0.5);
        for (let Y = Math.max(Y0, rect.y); Y < Math.min(Y1, rect.y + rect.h); Y++) for (let X = Math.max(X0, rect.x); X < Math.min(X1, rect.x + rect.w); X++) {
          const u = Math.floor((X + 0.5 - X0) / (X1 - X0) * it.px.width), v = Math.floor((Y + 0.5 - Y0) / (Y1 - Y0) * it.px.height);
          if (!it.px.data[(v * it.px.width + u) * 4 + 3]) continue;
          assert.ok(on[i] && onBare[i], `run ${run}: static ${i} draws at (${X}, ${Y}) in the rect, k=${k}`);
          if (!onShort[i]) shortMissed = true;
        }
      });
      if (shortMissed) missedShort += 1;
    }
  }
  assert.ok(missedShort > 0, 'a box 1 map px short misses a static that draws in the rect');
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
  // The view (canvas size and resolution) heads every key: a resize at the same camera re-caches.
  assert.match(src, /const view = `\$\{app\.canvas\.width\}x\$\{app\.canvas\.height\}@\$\{r\}:`;/);
  assert.match(src, /const exact = k\.exact === null \? null : view \+ k\.exact;\s*const settled = exact !== null && exact === lastExact;\s*lastExact = exact;\s*const key = settled \? exact! : view \+ k\.key, live = settled \? noLive : k\.live;/);
  assert.match(src, /if \(key !== cacheKey && key === lastKey\) \{ refreshCache\(live\); cacheKey = key; \}\s*lastKey = key;\s*const useCache = [^;]*;\s*cacheLayer\.visible = useCache;\s*belowDirect\.visible = !useCache;/);
  assert.match(src, /const pickFront = cached \? frontPicker\(plan\.sorted, order, plan\.below\.width, plan\.below\.height\) : null;/);
  assert.match(src, /const useCache = key === cacheKey && world\.scale\.x \* r >= NEAR_MIN_SCALE && world\.scale\.y \* r >= NEAR_MIN_SCALE;/);
  assert.match(src, /mainFront = useCache \? pickFront!\(\[\], live\) : null;\s*statics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = mainFront \? mainFront\[i\] : true; \}\);\s*for \(const s of sprites\.values\(\)\) s\.sprite\.visible = !useCache;/);
  assert.match(src, /const pickRegion = cached \? regionPicker\(plan\.sorted, plan\.below\.width, plan\.below\.height\) : null;/);
  // The rects: each person's device box, 1 px out, inside the screen; one set picked for them all.
  assert.match(src, /const X0 = Math\.max\(0, Math\.floor\(\(s\.sprite\.x \* kx \+ world\.x\) \* r\) - 1\), X1 = Math\.min\(W, Math\.ceil\(\(\(s\.sprite\.x \+ fw\) \* kx \+ world\.x\) \* r\) \+ 1\);\s*const Y0 = Math\.max\(0, Math\.floor\(\(s\.sprite\.y \* ky \+ world\.y\) \* r\) - 1\), Y1 = Math\.min\(H, Math\.ceil\(\(\(s\.sprite\.y \+ fh\) \* ky \+ world\.y\) \* r\) \+ 1\);/);
  assert.match(src, /passes\.push\(rect\);\s*pickRegion!\(\{ x: \(rect\.x \/ r - world\.x\) \/ kx, y: \(rect\.y \/ r - world\.y\) \/ ky, w: rect\.w \/ r \/ kx, h: rect\.h \/ r \/ ky \}\)\.forEach\(\(on, i\) => \{ if \(on\) passOn\[i\] = true; \}\);/);
  // The rects are drawn inside the frame's own render, after it, scissored, each cleared to the
  // whole-cache quad first.
  assert.match(src, /if \(inPass \|\| o\.container !== app\.stage \|\| !passes\.length\) return;/);
  assert.match(src, /cacheLayer\.visible = false;\s*if \(passCache\) passCache\.visible = true;\s*gl\.enable\(gl\.SCISSOR_TEST\);\s*statics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = passOn\[i\]; \}\);\s*for \(const p of passes\) \{\s*gl\.scissor\(p\.x, H - p\.y - p\.h, p\.w, p\.h\);\s*app\.renderer\.render\(\{ container: app\.stage, clear: true \}\);\s*\}/);
  assert.match(src, /\} finally \{\s*gl\.disable\(gl\.SCISSOR_TEST\);\s*cacheLayer\.visible = true;\s*if \(passCache\) passCache\.visible = false;/);
  assert.match(src, /passCache\.position\.set\(0, H \/ r\);\s*passCache\.scale\.y = -1;\s*passCache\.visible = false;\s*app\.stage\.addChildAt\(passCache, app\.stage\.getChildIndex\(cacheLayer\) \+ 1\);/);
  assert.match(src, /if \(cached\) app\.renderer\.runners\.postrender\.add\(postrender\);/);
  assert.match(src, /const refreshCache = \(liveStatics: boolean\[\]\) => \{\s*cacheStatics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = !liveStatics\[i\]; \}\);/);
  assert.match(src, /const depth = people\.map\(\(q\) => `\$\{q\.id\}:\$\{q\.foot\}:\$\{q\.rank\}`\)\.join\('\|'\);\s*if \(depth === lastDepth\) return;\s*lastDepth = depth;/);
  assert.match(src, /plan\.sorted\.map\(\(it, i\) => \(\{ foot: it\.foot, rank: it\.rank, sprite: statics\[i\] \}\)\);\s*for \(const q of people\) items\.push\(q\);\s*items\.sort\(byDepth\);/);
});

test('StationFloor frees the cache target, its cells and every texture it made on unmount, before the app is destroyed', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /\(app as any\)\.__free = \[\s*\(\) => app\.renderer\.runners\.postrender\.remove\(postrender\),\s*dropCells,\s*\(\) => rt\?\.destroy\(true\),\s*\(\) => cacheRoot\.destroy\(\{ children: true \}\),\s*\(\) => \{ for \(const t of owned\) t\.destroy\(true\); \},\s*\];/);
  assert.match(src, /const dropCells = \(\) => \{\s*for \(const s of cells\.values\(\)\) s\.destroy\(\{ texture: true, textureSource: false \}\);\s*cells\.clear\(\);\s*\};/);
  assert.match(src, /\(a as any\)\.__unsub\?\.\(\); \} catch \{\s*\}\s*teardownFloor\(a, \(a as any\)\.__free \?\? \[\]\);\s*\}/);
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
