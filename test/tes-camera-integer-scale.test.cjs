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

// Fractional and whole device scales, and odd heights, so H * r (and the bottom-anchored y) is
// often not a whole device pixel before the snap.
const GRID_R = [1, 1.25, 1.5, 1.75, 2, 3];
const GRID_H = [301, 470, 517, 899];

function gridFailures(CameraClass = Camera) {
  const bad = [];
  for (const r of GRID_R) for (let W = 400; W <= 900; W += 7) for (const H of GRID_H) {
    const c = rest(W, H, r, CameraClass);
    if (!isInt(c.z * r) || !isInt(c.x * r) || !isInt(c.y * r)) bad.push(`${W}x${H}@${r}: z*r=${(c.z * r).toFixed(4)} x*r=${(c.x * r).toFixed(3)} y*r=${(c.y * r).toFixed(3)}`);
  }
  return bad;
}

/** Where the whole deck fits, its bottom row ends inside the panel: y is floored to the grid,
 *  never rounded down past the edge (the hull below it still crosses the bottom). */
function deckFailures(CameraClass = Camera) {
  const frame = floorFrame('tes', 960, 640);
  const bad = [];
  let fits = 0, raised = 0;
  for (const r of GRID_R) for (let W = 400; W <= 900; W += 7) for (const H of GRID_H) {
    const c = rest(W, H, r, CameraClass);
    const deckTop = c.y + frame.y * c.z, deckBottom = c.y + (frame.y + frame.h - frame.deadBottom) * c.z;
    if (deckTop < 0) continue; // cropped: below 304x344 device px the deck is held at 1 device px
    fits++;
    if (deckBottom > H + 1e-6) bad.push(`${W}x${H}@${r}: deck bottom ${deckBottom.toFixed(3)} > ${H}`);
    else if (deckBottom < H - 1e-6) raised++;
  }
  return { bad, fits, raised };
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

test('TES camera at rest: zoom*resolution is a whole number and the offsets are whole device px', () => {
  const bad = gridFailures();
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} sizes off the device grid`);
});

test('TES camera: where the deck fits, its last row is inside the panel (y floored, not rounded)', () => {
  const { bad, fits, raised } = deckFailures();
  assert.ok(fits > 500, `${fits} panes fit the whole deck`);
  assert.ok(raised > 0, 'some panes need the floor (H * r not whole)');
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} panes clip the deck's bottom row`);
});

test('TES camera in a tiny pane keeps one device px per map px, never zoom 0, and the hull crosses the bottom', () => {
  const frame = floorFrame('tes', 960, 640);
  for (const [W, H] of [[200, 150], [61, 50], [150, 1200]]) for (const r of [1, 1.25, 2]) {
    const c = rest(W, H, r);
    assert.ok(c.z * r >= 1 - 1e-9, `${W}x${H}@${r}: z*r=${c.z * r}`);
    assert.ok(isInt(c.z * r) && isInt(c.x * r) && isInt(c.y * r), `${W}x${H}@${r}: on the device grid`);
    assert.ok(c.y + (frame.y + frame.h) * c.z > H, `${W}x${H}@${r}: the hull crosses the bottom`);
  }
});

test('TES camera snaps only once settled: not while the zoom eases after a resize, nor during a nudge', () => {
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
    if (!isInt(c.z * r) && (!isInt(c.x * r) || !isInt(c.y * r))) off++;
  } while (frames < 600 && !isInt(c.z * r));
  assert.ok(frames > 5, `the zoom eases over ${frames} frames`);
  assert.ok(off > 0, 'mid-ease offsets are not snapped');
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.ok(isInt(c.z * r) && isInt(c.x * r) && isInt(c.y * r), 'snapped once settled');
  // A nudge toward the target itself moves nothing, but while it runs the camera is not settled:
  // the offsets are the raw centring (this pane's is off the grid), snapped again once it ends.
  const n = make(433, 501);
  const raw = { x: n.c.x, y: n.c.y };
  n.k.nudgeToward(n.k.targetX, n.k.targetY, 1000);
  n.k.update(1 / 60);
  const mid = { x: n.c.x * r, y: n.c.y * r };
  assert.ok(!isInt(mid.x) || !isInt(mid.y), `mid-nudge offsets are raw: x*r=${mid.x} y*r=${mid.y}`);
  for (let i = 0; i < 120; i++) n.k.update(1 / 30);
  assert.ok(isInt(n.c.x * r) && isInt(n.c.y * r), 'snapped after the nudge');
  assert.deepEqual({ x: n.c.x, y: n.c.y }, raw, 'back where it rested');
});

test('TES camera follows a DPR change after mount: setViewSize again re-snaps to the new grid', () => {
  let r = 1;
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new Camera(c, { resolution: () => r });
  k.setMapSize(960, 640);
  k.setFrame(floorFrame('tes', 960, 640));
  k.setViewSize(701, 517);
  k.fitToScreen();
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.ok(isInt(c.z) && isInt(c.x) && isInt(c.y));
  r = 1.25; // UI zoom (Ctrl+=) or a move to a 125% monitor
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.ok(!(isInt(c.z * r) && isInt(c.x * r) && isInt(c.y * r)), 'without a re-fit, the old grid is off the new one');
  k.setViewSize(701, 517); // what StationFloor's DPR watcher does after renderer.resize
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.ok(isInt(c.z * r) && isInt(c.x * r) && isInt(c.y * r), `on the 1.25 grid: z*r=${c.z * r} x*r=${c.x * r} y*r=${c.y * r}`);
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

test('TES whole-pixel mutant census: removing scale quantisation or bottom anchoring is caught', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/Camera.ts'), 'utf8');
  const mutants = [
    { name: 'raw fractional zoom', from: 'Math.floor(minZoom * resolution) / resolution', to: 'minZoom' },
    { name: 'vertical centring exposes background below the hull', from: '? top + this.viewHeight - contentH', to: '? top + (this.viewHeight - contentH) / 2' },
  ];
  for (const mutant of mutants) {
    const hits = source.split(mutant.from).length - 1;
    assert.equal(hits, 1, `mutant ${mutant.name} must match exactly once`);
    const MutantCamera = loadTs.fromText('src/renderer/src/scene/office/Camera.ts', source.replace(mutant.from, mutant.to)).Camera;
    const failures = mutant.name === 'raw fractional zoom' ? gridFailures(MutantCamera) : bottomFailures(MutantCamera);
    assert.ok(failures.length > 0, `SURVIVED: ${mutant.name}`);
  }
});
