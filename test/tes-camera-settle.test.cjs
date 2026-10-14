'use strict';

// TES-GUPPY-SETTLE: the TES floor's camera eases by elapsed time (the office's per-tick step,
// compounded at 30 per second) and lands exactly on its target once what is left would move the
// picture by under half a device pixel, so a slow frame rate cannot keep the picture moving (and
// the raster cache off). Without the option (the office) the camera is exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const ROOT = path.join(__dirname, '..');

const FRAME = { x: 40, y: 30, w: 880, h: 560, deadBottom: 48 };
function cam(settle, frame = FRAME) {
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new Camera(c, settle);
  k.setMapSize(960, 640);
  if (frame) k.setFrame(frame);
  k.setViewSize(200, 150); // the size a pane has before its first resize
  k.fitToScreen();
  k.update(1 / 30);
  k.setViewSize(960, 640);
  return { c, k };
}
const state = ({ c }) => [c.x, c.y, c.z];
/** The device px a point of the frame moves between two container states. */
const moved = (a, b, r) => {
  let m = 0;
  for (const x of [FRAME.x, FRAME.x + FRAME.w]) for (const y of [FRAME.y, FRAME.y + FRAME.h]) {
    m = Math.max(m, Math.abs((x * a[2] + a[0]) - (x * b[2] + b[0])) * r, Math.abs((y * a[2] + a[1]) - (y * b[2] + b[1])) * r);
  }
  return m;
};

test('office: no settle option eases per tick, whatever the dt, exactly as the 0.08 lerp', () => {
  for (const frame of [null, FRAME]) {
    const a = cam(null, frame), b = cam(null, frame);
    // The reference: the old per-tick lerp, re-derived from the target the camera ends at.
    for (let i = 0; i < 400; i++) {
      a.k.update(1 / 30);
      b.k.update(i % 2 ? 0.2 : 0.001);
      assert.deepEqual(state(a), state(b), `tick ${i}`);
    }
    const ref = cam(null, frame), k = ref.k;
    const cur = () => [k.currentX, k.currentY, k.currentZoom];
    for (let i = 0; i < 50; i++) {
      const [x, y, z] = cur();
      k.update(1 / 30);
      assert.deepEqual(cur(), [x + (k.targetX - x) * 0.08, y + (k.targetY - y) * 0.08, z + (k.targetZoom - z) * 0.08]);
    }
  }
});

test('settle: at 30 fps it eases as the office does, until it lands', () => {
  const a = cam(null), b = cam({ resolution: () => 2 });
  for (let i = 0; i < 60; i++) {
    a.k.update(1 / 30); b.k.update(1 / 30);
    assert.ok(moved(state(a), state(b), 2) < 1e-6, `tick ${i}`);
  }
});

test('settle: frame-rate independent, and lands on the target in about 4 s at any rate', () => {
  const runs = [30, 10, 5, 2].map((fps) => {
    const s = cam({ resolution: () => 2 });
    const at1s = [];
    let t = 0, landed = null;
    while (t < 10) {
      s.k.update(1 / fps); t += 1 / fps;
      if (!at1s.length && t >= 1 - 1e-9) at1s.push(...state(s));
      if (landed === null && s.k.currentZoom === s.k.targetZoom && s.k.currentX === s.k.targetX && s.k.currentY === s.k.targetY) landed = t;
    }
    return { fps, at1s, landed, end: state(s) };
  });
  for (const r of runs) {
    assert.ok(r.landed !== null && r.landed < 5, `${r.fps} fps lands (${r.landed} s)`);
    assert.ok(moved(r.at1s, runs[0].at1s, 2) < 1, `${r.fps} fps at 1 s is where 30 fps is`);
    assert.deepEqual(r.end, runs[0].end, 'every rate ends on the same exact picture');
  }
});

test('settle: the landing step moves the picture by under half a device pixel', () => {
  for (const r of [1, 2, 3]) {
    // One camera lands, its twin (infinite resolution) never does; at the landing they differ by
    // exactly what the landing skipped.
    const a = cam({ resolution: () => r }), b = cam({ resolution: () => Infinity });
    let landedAt = -1;
    for (let i = 0; i < 400 && landedAt < 0; i++) {
      a.k.update(1 / 30); b.k.update(1 / 30);
      if (a.k.currentZoom === a.k.targetZoom) landedAt = i;
      else assert.deepEqual(state(a), state(b));
    }
    assert.ok(landedAt > 0);
    const skipped = moved(state(a), state(b), r);
    assert.ok(skipped > 0 && skipped < 0.5, `r=${r}: skipped ${skipped} device px`);
  }
});

test('settle: no landing during a nudge, and the nudge is time-based too', () => {
  const a = cam({ resolution: () => 2 }), b = cam({ resolution: () => 2 });
  for (let i = 0; i < 300; i++) { a.k.update(1 / 30); b.k.update(1 / 30); }
  a.k.nudgeToward(100, 100); b.k.nudgeToward(100, 100);
  a.k.update(1 / 30);
  assert.notEqual(a.k.currentX, a.k.targetX);
  for (let t = 1 / 30; t < 0.6 - 1e-9; t += 1 / 30) a.k.update(1 / 30);
  for (let t = 0; t < 0.6 - 1e-9; t += 0.1) b.k.update(0.1);
  assert.ok(Math.abs(a.k.currentX - b.k.currentX) < 1, `${a.k.currentX} vs ${b.k.currentX}`);
});

test('the TES floor turns settle on with the renderer resolution and eases by the real dt; the office does not', () => {
  const station = fs.readFileSync(path.join(ROOT, 'src/renderer/src/scene/themes/StationFloor.tsx'), 'utf8');
  assert.match(station, /const camera = new Camera\(world, \{ resolution: \(\) => app\.renderer\.resolution \}\);/);
  // By the time between the floor's own ticks, not the ticker's capped, per-display-frame deltaMS.
  assert.match(station, /let lastTickAt = performance\.now\(\);/);
  assert.match(station, /const now = performance\.now\(\);\s*camera\.update\(Math\.max\(0, now - lastTickAt\) \/ 1000\);\s*lastTickAt = now;/);
  assert.doesNotMatch(station, /camera\.update\([^)]*deltaMS/);
  const office = fs.readFileSync(path.join(ROOT, 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  assert.match(office, /new Camera\(world\);/);
});
