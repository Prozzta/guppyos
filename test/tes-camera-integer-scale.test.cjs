'use strict';

// TES-WALL-RESIZE-LINES-187: at rest, the TES floor camera puts every art
// pixel and frame edge on the device-pixel grid, so per-foot raster strips
// cannot form resize-dependent seams.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const { floorFrame } = loadTs('src/renderer/src/scene/themes/framing.ts');

const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;

function rest(W, H, r, CameraClass = Camera) {
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new CameraClass(c, { resolution: () => r });
  k.setMapSize(960, 640);
  k.setFrame(floorFrame('tes', 960, 640));
  k.setViewSize(W, H);
  k.fitToScreen();
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  return c;
}

// Fractional and whole device scales: raw fitting must fill these ordinary panes,
// rather than shrinking to a whole-device-pixel camera scale.
const GRID_R = [1, 1.25, 1.5, 1.75, 2, 3];
const GRID_H = [301, 470, 517, 899];

function rawFitFailures(CameraClass = Camera) {
  const bad = [];
  for (const r of GRID_R) for (let W = 400; W <= 900; W += 7) for (const H of GRID_H) {
    const c = rest(W, H, r, CameraClass);
    const expected = Math.max(1 / r, Math.min(W / 304, H / 344));
    if (Math.abs(c.z - expected) > 1e-8) bad.push(`${W}x${H}@${r}: got ${c.z}, expected ${expected}`);
  }
  return bad;
}

function bottomFailures(CameraClass = Camera) {
  const frame = floorFrame('tes', 960, 640);
  const bad = [];
  for (const [W, H] of [[500, 300], [650, 300], [742, 284]]) for (const r of [1, 1.25, 1.5, 2]) {
    const c = rest(W, H, r, CameraClass);
    const hullBottom = c.y + (frame.y + frame.h) * c.z;
    if (hullBottom < H - 1e-6) bad.push(`${W}x${H}@${r}: hull=${hullBottom.toFixed(3)} panel=${H}`);
  }
  return bad;
}

function centringFailures(CameraClass = Camera) {
  const frame = floorFrame('tes', 960, 640);
  const bad = [];
  for (const r of [1, 1.25, 1.5, 2]) for (const [W, H] of [[400, 899], [500, 700], [701, 899]]) {
    const c = rest(W, H, r, CameraClass);
    const hullBottom = c.y + (frame.y + frame.h) * c.z;
    if (hullBottom < H - 1e-6) bad.push(`${W}x${H}@${r}: hull=${hullBottom.toFixed(3)} panel=${H}`);
  }
  return bad;
}

test('TES camera at rest fills raw fit at every DPR; it does not floor to a raster grid', () => {
  const bad = rawFitFailures();
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} panes lost raw fit`);
  assert.ok(!isInt(rest(560, 555, 1).z), 'the ordinary DPR-1 pane is intentionally fractional');
});

test('TES camera in a tiny pane keeps one device px per map px, never zoom 0, and the hull crosses the bottom', () => {
  const frame = floorFrame('tes', 960, 640);
  for (const [W, H] of [[200, 150], [61, 50], [150, 1200]]) for (const r of [1, 1.25, 2]) {
    const c = rest(W, H, r);
    assert.ok(c.z * r >= 1 - 1e-9, `${W}x${H}@${r}: z*r=${c.z * r}`);
    assert.ok(c.y + (frame.y + frame.h) * c.z > H, `${W}x${H}@${r}: the hull crosses the bottom`);
  }
});

test('TES camera stays raw through settling and a nudge', () => {
  const r = 1.5, frame = floorFrame('tes', 960, 640);
  const make = (W, H) => {
    const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
    const k = new Camera(c, { resolution: () => r });
    k.setMapSize(960, 640);
    k.setFrame(frame);
    k.setViewSize(W, H);
    k.fitToScreen();
    for (let i = 0; i < 600; i++) k.update(1 / 30);
    return { c, k };
  };
  // A resize: only the zoom eases (the frame centre is the target before and after), so the
  // offsets follow the easing zoom exactly, off the grid, until it lands.
  const { c, k } = make(1201, 901);
  k.setViewSize(517, 301);
  let off = 0, frames = 0;
  do {
    k.update(1 / 60);
    frames++;
    if (!isInt(c.z * r)) off++;
  } while (frames < 600 && Math.abs(c.z - Math.min(517 / 304, 301 / 344)) > 1e-8);
  assert.ok(frames > 5, `the zoom eases over ${frames} frames`);
  assert.ok(off > 0, 'mid-ease offsets are not snapped');
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.ok(!isInt(c.z * r), 'settled camera remains at raw scale');
  // A nudge toward the target itself moves nothing, but while it runs the camera is not settled:
  // the offsets are the raw centring (this pane's is off the grid), snapped again once it ends.
  const n = make(433, 501);
  const raw = { x: n.c.x, y: n.c.y };
  n.k.nudgeToward(n.k.targetX, n.k.targetY, 1000);
  n.k.update(1 / 60);
  const mid = { x: n.c.x * r, y: n.c.y * r };
  assert.ok(!isInt(mid.x) || !isInt(mid.y), `mid-nudge offsets are raw: x*r=${mid.x} y*r=${mid.y}`);
  for (let i = 0; i < 120; i++) n.k.update(1 / 30);
  assert.ok(!isInt(n.c.x * r) || !isInt(n.c.y * r), 'raw centring remains after the nudge');
  assert.deepEqual({ x: n.c.x, y: n.c.y }, raw, 'back where it rested');
});

test('TES camera follows a DPR change after mount without changing a non-tiny raw fit', () => {
  let r = 1;
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new Camera(c, { resolution: () => r });
  k.setMapSize(960, 640);
  k.setFrame(floorFrame('tes', 960, 640));
  k.setViewSize(701, 517);
  k.fitToScreen();
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  const before = c.z;
  r = 1.25; // UI zoom (Ctrl+=) or a move to a 125% monitor
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.equal(c.z, before, 'DPR does not alter the established raw fit');
  k.setViewSize(701, 517); // what StationFloor's DPR watcher does after renderer.resize
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.equal(c.z, before, 'refit keeps the raw fit');
});

test('watchDevicePixelRatio: one query for the current DPR, re-armed for each new one, removed on cleanup', () => {
  const { watchDevicePixelRatio } = loadTs('src/renderer/src/scene/office/Camera.ts');
  const queries = [];
  const win = {
    devicePixelRatio: 1,
    matchMedia(q) {
      const mq = { q, listeners: new Set(), addEventListener(t, f) { assert.equal(t, 'change'); this.listeners.add(f); }, removeEventListener(t, f) { this.listeners.delete(f); } };
      queries.push(mq);
      return mq;
    },
  };
  const seen = [];
  const stop = watchDevicePixelRatio(win, (dpr) => seen.push(dpr));
  assert.deepEqual(queries.map((m) => m.q), ['(resolution: 1dppx)']);
  const change = (dpr) => { win.devicePixelRatio = dpr; for (const f of [...queries[queries.length - 1].listeners]) f(); };
  change(1.25);
  change(2);
  assert.deepEqual(seen, [1.25, 2]);
  assert.deepEqual(queries.map((m) => m.q), ['(resolution: 1dppx)', '(resolution: 1.25dppx)', '(resolution: 2dppx)']);
  assert.deepEqual(queries.map((m) => m.listeners.size), [0, 0, 1], 'only the current query listens');
  stop();
  assert.equal(queries[2].listeners.size, 0, 'cleanup removes it');
  change(1);
  assert.deepEqual(seen, [1.25, 2], 'nothing after cleanup');
});

test('StationFloor wires the DPR watcher: renderer resolution, resize, camera; cleaned up on unmount', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/themes/StationFloor.tsx'), 'utf8');
  assert.match(src, /import \{ Camera, watchDevicePixelRatio \} from '\.\.\/office\/Camera';/);
  assert.match(src, /\(app as any\)\.__dpr = watchDevicePixelRatio\(window, \(dpr\) => \{\s*if \(!app\.renderer\) return;\s*app\.renderer\.resolution = dpr;\s*const width = host\.clientWidth, height = host\.clientHeight;\s*if \(width === 0 \|\| height === 0\) return;\s*app\.renderer\.resize\(width, height\);\s*camera\.setViewSize\(width, height\);\s*\}\);/);
  assert.match(src, /\(a as any\)\.__resize\?\.disconnect\?\.\(\);\s*try \{ \(a as any\)\.__dpr\?\.\(\); \} catch \{/);
});

test('TES camera keeps the hull across the bottom edge at every supported pane and device scale', () => {
  const bad = bottomFailures();
  assert.deepEqual(bad, [], 'the dead-bottom hull band must cover the panel bottom without a margin');
});

test('whole-scene raster rounds the source scale up and composites it once', () => {
  const { wholeSceneRaster } = loadTs('src/renderer/src/scene/themes/staticCache.ts');
  for (const r of [1, 1.25, 1.5, 2]) {
    const scale = 555 / 344;
    const p = wholeSceneRaster(scale, r, 560 * r, 555 * r);
    assert.ok(Number.isInteger(scale * r * p.factor), `${r}: source scale is device integral`);
    assert.ok(p.pixelW >= 560 * r && p.pixelH >= 555 * r, `${r}: raster covers its output`);
  }
});

test('StationFloor presents one whole-scene RT below live crew, never per-cell strips', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/themes/StationFloor.tsx'), 'utf8');
  assert.match(src, /const raster = wholeSceneRaster\(world\.scale\.x, r, W, H\);/);
  assert.match(src, /cacheSprite = new Sprite\(rt\);\s*cacheSprite\.scale\.set\(1 \/ raster\.factor\);/);
  assert.match(src, /__tesStaticCacheBuilds/);
  assert.doesNotMatch(src, /screenCells\(|gl\.blitFramebuffer|SCISSOR_TEST/);
});

test('TES raw-fit mutant census: restoring scale quantisation or centring the hull is caught', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/Camera.ts'), 'utf8');
  const mutants = [
    { name: 'floored zoom', from: 'return Math.max(1 / resolution, minZoom);', to: 'return Math.max(1 / resolution, Math.floor(minZoom * resolution) / resolution);' },
    { name: 'vertical centring exposes background below the hull', from: '? top + this.viewHeight - contentH', to: '? top + (this.viewHeight - contentH) / 2' },
  ];
  for (const mutant of mutants) {
    const hits = source.split(mutant.from).length - 1;
    assert.equal(hits, 1, `mutant ${mutant.name} must match exactly once`);
    const MutantCamera = loadTs.fromText('src/renderer/src/scene/office/Camera.ts', source.replace(mutant.from, mutant.to)).Camera;
    const failures = mutant.name === 'floored zoom' ? rawFitFailures(MutantCamera) : centringFailures(MutantCamera);
    assert.ok(failures.length > 0, `SURVIVED: ${mutant.name}`);
  }
});
