'use strict';

// TES-FLOOR-WHOLE-188 (was TES-WALL-RESIZE-LINES-187): a framed floor with a keep box is drawn at
// a whole number n of device px per map px, the largest at which its keep box fits, with the
// map's origin on a whole device px: every art pixel is n x n device px on every frame, easing
// included. A frame without a keep box (and the office) keeps the raw fit, as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const { floorFrame, wholeScale } = loadTs('src/renderer/src/scene/themes/framing.ts');

const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;
const TES = floorFrame('tes', 960, 640);
const RAW = (() => { const f = { ...TES }; delete f.keep; return f; })();

function make(W, H, r, { CameraClass = Camera, frame = TES } = {}) {
  const c = { x: 0, y: 0, z: 1, scale: { set(v) { c.z = v; } } };
  const rr = typeof r === 'function' ? r : () => r;
  const k = new CameraClass(c, { resolution: rr });
  k.setMapSize(960, 640);
  k.setFrame(frame);
  k.setViewSize(W, H);
  k.fitToScreen();
  return { c, k };
}
function rest(W, H, r, opts) {
  const m = make(W, H, r, opts);
  for (let i = 0; i < 600; i++) m.k.update(1 / 30);
  return m.c;
}
const KEEP = TES.keep, KW = KEEP.x1 - KEEP.x0 + 1, KH = KEEP.y1 - KEEP.y0 + 1;
const ART = TES.art, AW = ART.x1 - ART.x0 + 1, AH = ART.y1 - ART.y0 + 1;
/** On an axis the art covers (art * n >= pane), the pane lies inside the art: no margin (backdrop) shows. */
function artFailures(Wd, Hd, n, ox, oy) {
  const bad = [];
  if (AW * n >= Wd && (ox + ART.x0 * n > 1e-6 || ox + (ART.x1 + 1) * n < Wd - 1e-6)) bad.push(`margin shows in x: ${ox} (art ${ox + ART.x0 * n}..${ox + (ART.x1 + 1) * n} of ${Wd})`);
  if (AH * n >= Hd && (oy + ART.y0 * n > 1e-6 || oy + (ART.y1 + 1) * n < Hd - 1e-6)) bad.push(`margin shows in y: ${oy} (art ${oy + ART.y0 * n}..${oy + (ART.y1 + 1) * n} of ${Hd})`);
  return bad;
}

/** Every way a rested whole camera can be wrong, for a pane W x H CSS px at DPR r. */
function wholeFailures(W, H, r, c) {
  const bad = [], Wd = Math.round(W * r), Hd = Math.round(H * r), n = c.z * r;
  const ox = c.x * r, oy = c.y * r;
  if (!isInt(n) || !isInt(ox) || !isInt(oy)) bad.push(`not whole: n=${n} x=${ox} y=${oy}`);
  const want = Math.max(1, Math.floor(Math.min(Wd / KW, Hd / KH)));
  if (Math.round(n) !== want) bad.push(`n=${n}, want ${want}`);
  const fits = KW * n <= Wd && KH * n <= Hd;
  if (fits) {
    if (ox + KEEP.x0 * n < -1e-6 || ox + (KEEP.x1 + 1) * n > Wd + 1e-6) bad.push(`keep cut in x: ${ox}`);
    if (oy + KEEP.y0 * n < -1e-6 || oy + (KEEP.y1 + 1) * n > Hd + 1e-6) bad.push(`keep cut in y: ${oy}`);
  }
  // The frame's content fits and the art does not cover the height: the frame's top meets the
  // pane's top (the hull runs past the bottom). Where the art covers it, the art's top does.
  if ((TES.h - TES.deadBottom) * n <= Hd && AH * n < Hd && Math.abs(oy + TES.y * n) > 1e-6) bad.push(`frame top not at the pane top: ${oy}`);
  if ((TES.h - TES.deadBottom) * n <= Hd && AH * n >= Hd && Math.abs(oy + ART.y0 * n) > 1e-6) bad.push(`art top not at the pane top: ${oy}`);
  bad.push(...artFailures(Wd, Hd, n, ox, oy));
  // The frame fits across: centred to within half a device px.
  if (TES.w * n <= Wd && Math.abs(ox + TES.x * n - (Wd - TES.w * n) / 2) > 0.5 + 1e-6) bad.push(`not centred: ${ox}`);
  return bad;
}
const GRID_R = [1, 1.25, 1.5, 1.75, 2, 3];
const GRID_H = [201, 301, 470, 517, 555, 640, 899];
function gridFailures(opts) {
  const bad = [];
  for (const r of GRID_R) for (let W = 400; W <= 960; W += 7) for (const H of GRID_H) {
    for (const f of wholeFailures(W, H, r, rest(W, H, r, opts))) bad.push(`${W}x${H}@${r}: ${f}`);
  }
  return bad;
}

test('wholeScale: the largest whole n at which the keep box fits, at least 1', () => {
  assert.deepEqual(KEEP, { x0: 335, y0: 84, x1: 591, y1: 367 });
  assert.equal(wholeScale(KEEP, 560, 555), 1, 'the bare 560x555 pane: 2 x 284 = 568 rows > 555');
  assert.equal(wholeScale(KEEP, 576, 587), 2, 'the same pane with its row padding');
  assert.equal(wholeScale(KEEP, 1680, 1120), 3);
  assert.equal(wholeScale(KEEP, 2 * 257 - 1, 10000), 1);
  assert.equal(wholeScale(KEEP, 2 * 257, 2 * 284), 2);
  for (const [w, h] of [[0, 0], [10, 10], [NaN, 5], [-5, 100]]) assert.equal(wholeScale(KEEP, w, h), 1, `${w}x${h}`);
});

test('TES camera at rest: whole n, whole-device-px origin, keep box in view, frame top at the pane top, centred', () => {
  const bad = gridFailures();
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} panes`);
});

test('TES camera in a tiny pane: n = 1, never zoom 0, the keep box centred when it cannot fit', () => {
  for (const [W, H] of [[200, 150], [61, 50], [150, 1200]]) for (const r of [1, 1.25, 2]) {
    const c = rest(W, H, r);
    assert.ok(Math.abs(c.z * r - 1) < 1e-9, `${W}x${H}@${r}: z*r=${c.z * r}`);
    assert.ok(isInt(c.x * r) && isInt(c.y * r), `${W}x${H}@${r}: whole origin`);
    const Wd = Math.round(W * r);
    if (KW > Wd) assert.ok(Math.abs(c.x * r + (KEEP.x0 + KEEP.x1 + 1) / 2 - Wd / 2) <= 0.5 + 1e-9, `${W}x${H}@${r}: keep centred across`);
  }
});

test('TES camera is whole on every frame: a resize steps n at once, on whole device px', () => {
  const r = 1.5;
  const { c, k } = make(1201, 901, r);
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  k.setViewSize(517, 301);
  k.update(1 / 60);
  assert.equal(Math.round(c.z * r), wholeScale(KEEP, Math.round(517 * r), Math.round(301 * r)), 'the new n on the first frame: the zoom is never eased');
  for (let i = 0; i < 300; i++) {
    k.update(1 / 60);
    assert.ok(isInt(c.z * r) && isInt(c.x * r) && isInt(c.y * r), `frame ${i}: z*r=${c.z * r} x*r=${c.x * r} y*r=${c.y * r}`);
  }
});

/** TES-SCENE-BOUNCE-188: a pane the frame overflows at its n (575x612@1: n = 2, 688 content rows in
 *  612) used to follow a select's nudge, lifting the whole scene up to 44 device px and back. */
const STILL_PANES = [[575, 612, 1], [555, 612, 1], [470, 520, 1.25], [720, 800, 1.25], [576, 587, 1], [716, 502, 1.25], [517, 301, 1.5], [450, 900, 2]];
const TOWARD = [[300, 30], [620, 30], [300, 420], [620, 420], [463, 0], [463, 640], [0, 220], [960, 220], [400, 300], [520, 360]];

/** Every frame on which a whole camera moved in an unchanged pane: from its first frame to its rest
 *  (a slide in), and across a nudge toward each point (a select). And how many panes it overflows. */
function stillFailures(opts) {
  const bad = [];
  let overflow = 0;
  const at = (c) => ({ x: c.x, y: c.y, z: c.z });
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
  for (const [W, H, r] of STILL_PANES) {
    const m = make(W, H, r, opts);
    m.k.update(1 / 60);
    const first = at(m.c);
    for (let i = 0; i < 300; i++) m.k.update(1 / 30);
    const rested = at(m.c);
    if (!same(first, rested)) bad.push(`${W}x${H}@${r}: slid in from ${JSON.stringify(first)} to ${JSON.stringify(rested)}`);
    if ((TES.h - TES.deadBottom) * rested.z * r > Math.round(H * r) || TES.w * rested.z * r > Math.round(W * r)) overflow++;
    for (const [tx, ty] of TOWARD) {
      m.k.nudgeToward(tx, ty, 1200);
      for (let i = 0; i < 80; i++) {
        m.k.update(1 / 60);
        if (!same(at(m.c), rested)) bad.push(`${W}x${H}@${r} toward ${tx},${ty} frame ${i}: ${JSON.stringify(at(m.c))}, rested ${JSON.stringify(rested)}`);
      }
    }
  }
  return { bad, overflow };
}

/** TES-SCENE-BOUNCE-188: the TES frame is centred on its art across, so at rest (the camera stands
 *  on its target) the art's x clamp binds nowhere (measured: 0 of 93,149 panes); only the old nudge
 *  reached it. A frame off-centre on the same art (24 more px of margin on the left) needs it. */
const OFF_CENTRE = { ...TES, x: TES.x - 24, w: TES.w + 24 };
function offCentreFailures(opts) {
  const bad = [];
  for (const r of [1, 1.25, 1.5, 2]) for (let W = 300; W <= 1300; W += 9) for (const H of [301, 612, 900]) {
    const c = rest(W, H, r, { ...opts, frame: OFF_CENTRE });
    for (const f of artFailures(Math.round(W * r), Math.round(H * r), c.z * r, c.x * r, c.y * r)) bad.push(`${W}x${H}@${r}: ${f}`);
  }
  return bad;
}

test('TES camera, a frame off-centre on its art: at rest the margin never shows on an axis the art covers', () => {
  const bad = offCentreFailures();
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} panes`);
});

test('TES camera: a select\'s nudge leaves the whole scene where it rests, on every frame, and it never slides in (TES-SCENE-BOUNCE-188)', () => {
  const { bad, overflow } = stillFailures();
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} moved frames`);
  assert.ok(overflow >= 5, `panes the frame overflows (where the old camera panned): ${overflow}`);
});

/** Nudges toward the art's corners, edges and centre in several panes: every frame's failures, and
 *  how many frames had an axis the art covers. 576x587@1 is the 560x555 window's bled pane: n = 2
 *  and the art exactly the pane's width. */
function nudgeFailures(opts) {
  const panes = [[576, 587, 1], [576, 587, 1.25], [716, 502, 1.25], [976, 672, 1.5], [720, 800, 1.25], [517, 301, 1.5], [450, 900, 2]];
  const bad = [];
  let covered = 0;
  for (const [W, H, r] of panes) {
    const m = make(W, H, r, opts);
    for (let i = 0; i < 300; i++) m.k.update(1 / 30);
    const Wd = Math.round(W * r), Hd = Math.round(H * r);
    for (const [tx, ty] of [[300, 30], [620, 30], [300, 420], [620, 420], [463, 0], [463, 640], [0, 220], [960, 220], [400, 300]]) {
      m.k.nudgeToward(tx, ty, 1000);
      for (let i = 0; i < 80; i++) {
        m.k.update(1 / 60);
        const n = m.c.z * r, ox = m.c.x * r, oy = m.c.y * r;
        if (!isInt(n) || !isInt(ox) || !isInt(oy)) bad.push(`${W}x${H}@${r} toward ${tx},${ty} frame ${i}: not whole`);
        for (const f of artFailures(Wd, Hd, n, ox, oy)) bad.push(`${W}x${H}@${r} toward ${tx},${ty} frame ${i}: ${f}`);
        if (AW * n >= Wd || AH * n >= Hd) covered++;
      }
    }
  }
  return { bad, covered };
}

test('TES camera nudged anywhere: on an axis the art covers, no frame of the pan shows the margin (Jim: up to 8n device px of backdrop)', () => {
  const { bad, covered } = nudgeFailures();
  assert.deepEqual(bad.slice(0, 5), []);
  assert.ok(covered > 1000, `frames with a covered axis: ${covered}`);
});

test('TES camera follows a DPR change after mount: n for the new device size', () => {
  let r = 1;
  const { c, k } = make(576, 587, () => r);
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.equal(c.z * r, 2);
  r = 1.5; // UI zoom (Ctrl+=) or a move to a 150% monitor
  k.setViewSize(576, 587); // what StationFloor's DPR watcher does after renderer.resize
  for (let i = 0; i < 600; i++) k.update(1 / 30);
  assert.equal(Math.round(c.z * r), 3);
  assert.deepEqual(wholeFailures(576, 587, r, c), []);
});

test('a frame without a keep box keeps the raw fit (the office path): fractional, the hull across the bottom', () => {
  const bad = [];
  for (const r of GRID_R) for (let W = 400; W <= 900; W += 7) for (const H of [301, 470, 517, 899]) {
    const c = rest(W, H, r, { frame: RAW });
    const expected = Math.max(1 / r, Math.min(W / 304, H / 344));
    if (Math.abs(c.z - expected) > 1e-8) bad.push(`${W}x${H}@${r}: got ${c.z}, expected ${expected}`);
    if (c.y + (RAW.y + RAW.h) * c.z < H - 1e-6) bad.push(`${W}x${H}@${r}: hull above the bottom`);
  }
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} panes`);
  assert.ok(!isInt(rest(560, 555, 1, { frame: RAW }).z), 'the ordinary DPR-1 pane is fractional there');
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

test('the scene scale k is an integer at or above the device scale, so its one resample to the screen never magnifies', () => {
  const { sceneScale } = loadTs('src/renderer/src/scene/themes/staticCache.ts');
  const b = { x: 336, y: 128, w: 288, h: 384 };
  for (const r of [1, 1.25, 1.5, 1.75, 2]) for (const scale of [555 / 344, 470 / 344, 640 / 344, 0.47]) {
    const S = scale * r, k = sceneScale(S, b);
    assert.ok(Number.isInteger(k) && k >= 1, `${r}x${scale}: k = ${k} is a whole number of texels per map px`);
    assert.ok(k >= S - 1e-9 && k < Math.max(1, S) + 1, `${r}x${scale}: k = ${k} is the first integer at or above ${S}`);
  }
});

test('StationFloor draws the floor texture straight in the world: no scene texture, no per-frame render', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/themes/StationFloor.tsx'), 'utf8');
  assert.match(src, /const k = sceneScale\(world\.scale\.x \* app\.renderer\.resolution, bounds!\);\s*if \(k !== floorK\) buildFloor\(k\);/);
  assert.match(src, /floorView\.texture = floorRT;\s*floorView\.position\.set\(b\.x, b\.y\);\s*floorView\.scale\.set\(1 \/ k\);/);
  assert.match(src, /world\.addChild\(floorView\);\s*\} else world\.addChild\(new Sprite\(below\.texture\)\);\s*world\.addChild\(sortLayer\);/);
  assert.equal((src.match(/app\.renderer\.render\(/g) || []).length, 1, 'one render call: the floor texture build');
  assert.doesNotMatch(src, /sceneRT|sceneSprite|sortLayer\.alpha|screenCells\(|gl\.blitFramebuffer/);
  // PERF-FLOOR-FILL-188: the only scissor is paint()'s changed rects (pinned in tes-raster).
  assert.equal((src.match(/SCISSOR_TEST/g) || []).length, 2);
  assert.match(src, /camera\.setFrame\(frame0\);/);
});

test('TES whole-camera mutant census: each guard is caught', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/Camera.ts'), 'utf8');
  const mutants = [
    { name: 'origin not rounded (x)', from: 'x = Math.round(fit(x, -keep.x0 * n, W - (keep.x1 + 1) * n));', to: 'x = fit(x, -keep.x0 * n, W - (keep.x1 + 1) * n);' },
    { name: 'origin not rounded (y)', from: 'y = Math.round(fit(y, -keep.y0 * n, H - (keep.y1 + 1) * n));', to: 'y = fit(y, -keep.y0 * n, H - (keep.y1 + 1) * n);' },
    { name: 'keep not clamped', from: 'y = Math.round(fit(y, -keep.y0 * n, H - (keep.y1 + 1) * n));', to: 'y = Math.round(y);' },
    { name: 'frame centred vertically', from: '      ? -b.y * n\n', to: '      ? (H - (b.h - b.deadBottom) * n) / 2 - b.y * n\n' },
    { name: 'n floored from the frame', from: 'return { n: wholeScale(keep, Math.round(this.viewWidth * r), Math.round(this.viewHeight * r)), r, keep };', to: 'return { n: Math.max(1, Math.floor(Math.min(this.viewWidth * r / this.box().w, this.viewHeight * r / (this.box().h - this.box().deadBottom)))), r, keep };' },
    { name: 'not whole: raw fit', from: '    if (w) { this.placeWhole(w.n, w.r, w.keep); return; }\n', to: '' },
    { name: 'art clamp dropped (x)', from: '    if (a && (a.x1 + 1 - a.x0) * n >= W) x = fit(x, W - (a.x1 + 1) * n, -a.x0 * n);\n', to: '' },
    { name: 'art clamp dropped (y)', from: '    if (a && (a.y1 + 1 - a.y0) * n >= H) y = fit(y, H - (a.y1 + 1) * n, -a.y0 * n);\n', to: '' },
    // TES-SCENE-BOUNCE-188: a whole camera placed on its eased point (a select's nudge, the mount's slide).
    { name: 'whole camera placed on the eased point', from: '    this.currentX = this.targetX;\n    this.currentY = this.targetY;\n', to: '' },
    { name: 'whole camera placed on the eased point (y only)', from: '    this.currentX = this.targetX;\n    this.currentY = this.targetY;\n', to: '    this.currentX = this.targetX;\n' },
  ];
  const norm = source.replace(/\r\n/g, '\n');
  for (const mutant of mutants) {
    const hits = norm.split(mutant.from).length - 1;
    assert.equal(hits, 1, `mutant ${mutant.name} must match exactly once`);
    const MutantCamera = loadTs.fromText('src/renderer/src/scene/office/Camera.ts', norm.replace(mutant.from, mutant.to)).Camera;
    const failures = [...gridFailures({ CameraClass: MutantCamera }), ...nudgeFailures({ CameraClass: MutantCamera }).bad, ...stillFailures({ CameraClass: MutantCamera }).bad, ...offCentreFailures({ CameraClass: MutantCamera })];
    assert.ok(failures.length > 0, `SURVIVED: ${mutant.name}`);
  }
});
