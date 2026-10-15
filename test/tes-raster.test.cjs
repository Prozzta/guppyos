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

test('StationFloor composes the scene in map space: the floor texture holds below and every static, the very same sprites, and one quad shows it', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.doesNotMatch(src, /atlas/i, 'no split tiles: each would be rounded on its own');
  assert.doesNotMatch(src, /blitFramebuffer|SCISSOR_TEST|screenCells|regionPicker|cacheKeyOf|wholeSceneRaster|NEAR_MIN_SCALE/);
  assert.match(src, /const bounds = sceneBounds\(plan\);\s*const cached = bounds !== null && staticsCacheable\(plan\);\s*const order = staticOrder\(plan\.sorted\);\s*const pickFront = cached \? frontPicker\(plan\.sorted, order, plan\.below\.width, plan\.below\.height\) : null;/);
  assert.match(src, /const floorRoot = new Container\(\);\s*const floorWorld = floorRoot\.addChild\(new Container\(\)\);/);
  // Placement and opacity as d267443e: a static's sprite sits at the plan's (x, y) at its opacity.
  assert.match(src, /s\.position\.set\(it\.x, it\.y\);\s*s\.alpha = it\.opacity;/);
  // Cached: the floor texture's tree holds below and every static by staticOrder; 'above' has its
  // own root, drawn after the people; the world shows the scene quad, then the sort layer, unseen
  // (alpha 0: still there for the people's hit tests), then the bubbles. Not cached: below, the
  // sort layer and 'above' live in the world, in that order.
  assert.match(src, /if \(cached\) \{\s*floorWorld\.addChild\(below\);\s*for \(const i of order\) if \(staticTex\[i\]\) floorWorld\.addChild\(staticSprite\(i\)\);\s*if \(hasVisiblePixel\(plan\.above\)\) aboveRoot\.addChild\(new Sprite\(own\(plan\.above\)\)\);\s*world\.addChild\(sceneSprite\);\s*sortLayer\.alpha = 0;\s*\} else world\.addChild\(belowDirect\);\s*world\.addChild\(sortLayer\);/);
  // The live bubble layer belongs above the map's above plane, but below the world's stage mount.
  assert.match(src, /world\.addChild\(sortLayer\);\s*if \(!cached && hasVisiblePixel\(plan\.above\)\) world\.addChild\(new Sprite\(own\(plan\.above\)\)\);\s*const bubbles = new BubbleLayer\(\{ width: SM\.PW, height: SM\.PH \}\);\s*world\.addChild\(bubbles\.container\);\s*\(app as any\)\.__bubbleLayer = bubbles;\s*app\.stage\.addChild\(world\);/);
  assert.equal((src.match(/own\(plan\.above\)/g) || []).length, 2, "'above' is made in one place or the other, never both");
  // The floor texture and the scene: the bounds at k texels per map px, 1:1, nearest; the old
  // ones are freed first. The floor's tree is scaled by k and moved to the bounds; the quad is
  // the bounds in map px, and the scene's own matrix the same move.
  assert.match(src, /const buildFloor = \(k: number\) => \{\s*const b = bounds!;\s*floorView\.texture = Texture\.EMPTY;\s*sceneSprite\.texture = Texture\.EMPTY;\s*floorRT\?\.destroy\(true\);\s*sceneRT\?\.destroy\(true\);\s*floorRT = RenderTexture\.create\(\{ width: b\.w \* k, height: b\.h \* k, resolution: 1, scaleMode: 'nearest' \}\);\s*sceneRT = RenderTexture\.create\(\{ width: b\.w \* k, height: b\.h \* k, resolution: 1, scaleMode: 'nearest' \}\);\s*floorWorld\.scale\.set\(k\);\s*floorWorld\.position\.set\(-b\.x \* k, -b\.y \* k\);\s*app\.renderer\.render\(\{ container: floorRoot, target: floorRT, clear: true \}\);\s*floorView\.texture = floorRT;\s*sceneSprite\.texture = sceneRT;\s*sceneSprite\.position\.set\(b\.x, b\.y\);\s*sceneSprite\.scale\.set\(1 \/ k\);\s*sceneM\.set\(k, 0, 0, k, -b\.x \* k, -b\.y \* k\);\s*sceneK = k;/);
});

test('StationFloor composes the scene after each tick: the floor rebuilt on a new k, then by depth the people and the statics near them, then above; and sorts on a depth change', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  // NIT-2 (Jim): the floor depends on k alone, so it is rebuilt exactly when k changes, at once.
  assert.match(src, /const compose = \(\) => \{\s*if \(!cached\) return;\s*const k = sceneScale\(world\.scale\.x \* app\.renderer\.resolution, bounds!\);\s*if \(k !== sceneK\) buildFloor\(k\);/);
  // COFFEE-NEVER-186: the cups in hand and the parked mugs are boxes too: a static in front of a mug is drawn again over it.
  assert.match(src, /const near: Box\[\] = \[\];\s*for \(const s of sprites\.values\(\)\) near\.push\(\{ x: s\.sprite\.x, y: s\.sprite\.y, w: fw, h: fh \}\);\s*for \(const c of cups\.values\(\)\) near\.push\(\{ x: c\.sprite\.x, y: c\.sprite\.y, w: MUG_W, h: MUG_H \}\);\s*for \(const m of mugs\.values\(\)\) near\.push\(\{ x: m\.sprite\.x, y: m\.sprite\.y, w: MUG_W, h: MUG_H \}\);\s*const front = pickFront!\(near\);\s*statics\.forEach\(\(s, i\) => \{ if \(s\) s\.visible = front\[i\]; \}\);/);
  // Each frame from a clean copy of the floor; the sort layer drawn into the scene, then unseen
  // again on the stage; 'above' last (SHOULD-3).
  assert.match(src, /app\.renderer\.render\(\{ container: floorView, target: sceneRT!, clear: true \}\);\s*sortLayer\.alpha = 1;\s*app\.renderer\.render\(\{ container: sortLayer, target: sceneRT!, clear: false, transform: sceneM \}\);\s*sortLayer\.alpha = 0;\s*if \(aboveRoot\.children\.length\) app\.renderer\.render\(\{ container: aboveRoot, target: sceneRT!, clear: false, transform: sceneM \}\);\s*\};/);
  // After onTick, so the scene has this tick's people and depth order.
  assert.match(src, /app\.ticker\.add\(onTick\);\s*(?:\/\/[^\n]*\n\s*)*applyFloorFrameBudget\(app\.ticker\);\s*(?:\/\/[^\n]*\n\s*)*app\.ticker\.add\(compose\);/);
  assert.match(src, /let lastDepth: string \| null = null;/);
  // COFFEE-NEVER-186: the key also holds the coffee mugs (a cup's side, a parked mug's depth).
  assert.match(src, /const depth = people\.map\(\(q\) => `\$\{q\.id\}:\$\{q\.foot\}:\$\{q\.rank\}:\$\{cups\.get\(q\.id\)\?\.back \?\? '-'\}`\)\.join\('\|'\) \+ '#' \+ \[\.\.\.mugs\]\.map\(\(\[id, m\]\) => `\$\{id\}:\$\{m\.foot\}:\$\{m\.rank\}`\)\.join\('\|'\);\s*if \(depth === lastDepth\) return;\s*lastDepth = depth;/);
  assert.match(src, /plan\.sorted\.map\(\(it, i\) => \(\{ foot: it\.foot, rank: it\.rank, sprite: statics\[i\] \}\)\);\s*for \(const q of people\) items\.push\(q\);\s*for \(const m of mugs\.values\(\)\) items\.push\(m\);\s*items\.sort\(byDepth\);/);
});

test('StationFloor frees the floor and scene textures, their trees and every texture it made on unmount, before the app is destroyed', () => {
  const src = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'));
  assert.match(src, /\(app as any\)\.__free = \[\s*\(\) => floorRT\?\.destroy\(true\),\s*\(\) => sceneRT\?\.destroy\(true\),\s*\(\) => floorRoot\.destroy\(\{ children: true \}\),\s*\(\) => aboveRoot\.destroy\(\{ children: true \}\),\s*\(\) => \{ for \(const t of owned\) t\.destroy\(true\); \},\s*\];/);
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
