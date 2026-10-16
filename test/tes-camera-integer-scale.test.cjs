'use strict';

// The shipped TES camera uses the semantic lip-to-lip fit. Its source cache is integer-sized,
// but the displayed scale is intentionally exact and may be fractional.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const { floorFrame } = loadTs('src/renderer/src/scene/themes/framing.ts');
const FIT = floorFrame('tes', 960, 640);
const BOX = FIT.fit;
const FW = BOX.x1 - BOX.x0 + 1, FH = BOX.y1 - BOX.y0 + 1;

function make(W, H, r, CameraClass = Camera) {
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new CameraClass(c, { resolution: () => r });
  k.setMapSize(960, 640); k.setFrame(FIT); k.setViewSize(W, H); k.fitToScreen();
  return { c, k };
}
function step(k, n = 1) { for (let i = 0; i < n; i++) k.update(1 / 60); }
function at(c) { return { x: c.x, y: c.y, z: c.z }; }
function fitFailures(W, H, r, c) {
  const out = [], Wd = Math.round(W * r), Hd = Math.round(H * r), n = c.z * r;
  const want = Math.min(W * r / FW, H * r / FH);
  if (Math.abs(n - want) > 1e-8) out.push(`scale ${n}, want ${want}`);
  // The origin must land on a device pixel; that removes the cache phase shift at the right lip.
  if (Math.abs(c.x * r - Math.round(c.x * r)) > 1e-8 || Math.abs(c.y * r - Math.round(c.y * r)) > 1e-8) out.push(`unsnapped origin ${c.x * r},${c.y * r}`);
  const cx = c.x * r + (BOX.x0 + BOX.x1 + 1) * n / 2;
  const cy = c.y * r + (BOX.y0 + BOX.y1 + 1) * n / 2;
  if (Math.abs(cx - Wd / 2) > 1 + 1e-8 || Math.abs(cy - Hd / 2) > 1 + 1e-8) out.push(`not centred ${cx},${cy}`);
  return out;
}

test('TES placeFit uses the exact limiting scale and a device-aligned, centred origin', () => {
  const bad = [];
  for (const r of [1, 1.25, 1.5, 1.75, 2]) for (const [W, H] of [[360, 760], [575, 612], [458, 587], [700, 700], [1200, 520]]) {
    const { c, k } = make(W, H, r); step(k); bad.push(...fitFailures(W, H, r, c).map((x) => `${W}x${H}@${r}: ${x}`));
  }
  assert.deepEqual(bad, []);
});

test('TES placeFit is still through updates and selection nudges, then re-centres immediately on resize', () => {
  const { c, k } = make(575, 612, 1.25); step(k);
  const first = at(c); step(k, 80); assert.deepEqual(at(c), first, 'no mount slide');
  for (const [x, y] of [[320, 32], [607, 367], [463, 200], [0, 640]]) {
    k.nudgeToward(x, y, 1200); step(k, 80); assert.deepEqual(at(c), first, `select toward ${x},${y} does not move the fit`);
  }
  k.setViewSize(360, 760); step(k);
  assert.deepEqual(fitFailures(360, 760, 1.25, c), [], 'resize immediately re-centres the semantic box');
});

test('unframed office camera keeps its ordinary raw-fit path', () => {
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const k = new Camera(c, { resolution: () => 1 });
  k.setMapSize(960, 640); k.setViewSize(560, 555); k.fitToScreen(); step(k, 600);
  assert.equal(c.z, 1, 'the ordinary settle path retains its minimum 1/device-px zoom');
});

test('TES placeFit mutant census catches scale, centring, and device-origin regressions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/Camera.ts'), 'utf8').replace(/\r\n/g, '\n');
  const mutants = [
    { name: 'no device alignment', from: 'this.container.x = Math.round((this.viewWidth / 2 - (fit.x0 + fit.x1 + 1) / 2 * z) * r) / r;', to: 'this.container.x = this.viewWidth / 2 - (fit.x0 + fit.x1 + 1) / 2 * z;' },
    { name: 'no device alignment y', from: 'this.container.y = Math.round((this.viewHeight / 2 - (fit.y0 + fit.y1 + 1) / 2 * z) * r) / r;', to: 'this.container.y = this.viewHeight / 2 - (fit.y0 + fit.y1 + 1) / 2 * z;' },
    { name: 'not the largest fit', from: 'const z = this.getMinZoom();', to: 'const z = this.getMinZoom() * .9;' },
    { name: 'fit bypassed', from: 'if (fitted) { this.placeFit(fitted); return; }\n', to: '' },
  ];
  for (const mutant of mutants) {
    assert.equal(source.split(mutant.from).length - 1, 1, `${mutant.name} matches once`);
    const Mutant = loadTs.fromText('src/renderer/src/scene/office/Camera.ts', source.replace(mutant.from, mutant.to)).Camera;
    const { c, k } = make(575, 612, 1.25, Mutant); step(k);
    const failures = fitFailures(575, 612, 1.25, c);
    const before = at(c); k.nudgeToward(0, 640, 1200); step(k, 4);
    if (JSON.stringify(at(c)) !== JSON.stringify(before)) failures.push('nudge moved fit');
    assert.ok(failures.length > 0, `SURVIVED: ${mutant.name}`);
  }
});

test('StationFloor uses a single linear semantic-fit cache downscale and no per-frame composition', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/themes/StationFloor.tsx'), 'utf8');
  assert.match(src, /RenderTexture\.create\(\{ width: b\.w \* k, height: b\.h \* k, resolution: 1, scaleMode: frame0\.fit \? 'linear' : 'nearest' \}\)/);
  assert.match(src, /const pickFront = cached \? \(frame0\.fit \? exactPicker : frontPicker\)/);
  assert.equal((src.match(/app\.renderer\.render\(/g) || []).length, 1, 'only the cache build renders');
});
