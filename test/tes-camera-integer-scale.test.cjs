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

function gridFailures(CameraClass = Camera) {
  const bad = [];
  for (const r of [2, 3]) for (let W = 400; W <= 900; W += 7) for (const H of [470, 900]) {
    const c = rest(W, H, r, CameraClass);
    if (!isInt(c.z * r) || !isInt(c.x * r) || !isInt(c.y * r)) bad.push(`${W}x${H}@${r}: z*r=${(c.z * r).toFixed(4)} x*r=${(c.x * r).toFixed(3)} y*r=${(c.y * r).toFixed(3)}`);
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

test('TES camera at rest: zoom*resolution is a whole number and the offsets are whole device px', () => {
  const bad = gridFailures();
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} sizes off the device grid`);
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
