'use strict';

// TES-GUPPY-FRAMING: the TES floor is framed on its art, not its 960x640 map: centred, the default
// pane takes the art's proportions, and the hull's outer face below the deck (a dead band of
// pixel rows) is the only thing the fit may clip. The office's numbers are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const ROOT = path.join(__dirname, '..');
const F = loadTs('src/renderer/src/scene/themes/framing.ts');
const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The tes pack as StationFloor gets it, and its static art composited as the floor draws it. */
function tesScene() {
  const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
  const R = loadTs('src/renderer/src/scene/themes/raster.ts');
  const dir = path.join(ROOT, 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(dir)));
  const f = P.finishPack(r.value, H.decodeImages(dir, T.normPath, r.value.images), r.diagnostics).value;
  const SM = f.scene;
  const plan = C.buildScenePlan({ ...SM, store: f.store });
  const art = R.blank(SM.PW, SM.PH);
  C.compose(art, plan.below, 0, 0);
  for (const it of plan.sorted) if (it.px) C.compose(art, it.px, Math.round(it.x), Math.round(it.y), it.opacity);
  return { SM, art, id: f.manifest.id };
}

/** A camera on a fake container, settled (the ease run out) at a view size. */
function settled(mapW, mapH, frame, vw, vh) {
  const container = { x: 0, y: 0, z: 1, scale: { set(v) { container.z = v; } } };
  const cam = new Camera(container);
  cam.setMapSize(mapW, mapH);
  if (frame !== undefined) cam.setFrame(frame);
  cam.setViewSize(vw, vh);
  cam.fitToScreen();
  for (let i = 0; i < 2000; i++) cam.update(1 / 60);
  return container;
}

/** The map rectangle a settled view shows. */
const shown = (c, vw, vh) => ({ x0: -c.x / c.z, y0: -c.y / c.z, x1: (vw - c.x) / c.z, y1: (vh - c.y) / c.z });
const EPS = 1e-6;

// The pane sizes of the screenshots (700x470, 960x640, 1290x850 windows), framed and office-default.
const VIEWS = [[318, 260], [380, 430], [566, 640], [238, 260], [498, 430], [828, 640], [1600, 300], [200, 900]];

test('PACK_ART.tes is re-measured from the pack: the art box, and a 48-row dead band below the deck', () => {
  const { SM, art, id } = tesScene();
  assert.equal(id, 'tes');
  assert.deepEqual([SM.PW, SM.PH], [960, 640]);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < art.height; y++) for (let x = 0; x < art.width; x++) {
    if (art.data[(y * art.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const a = F.PACK_ART.tes;
  assert.deepEqual({ x0, y0, x1, y1 }, { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 });
  // Content: every cell anyone can stand on, and every station, seat, brew spot and the entrance.
  const cell = SM.PW / SM.grid.W;
  let reachBottom = -1;
  for (let i = 0; i < SM.reach.length; i++) if (SM.reach[i]) reachBottom = Math.max(reachBottom, (Math.floor(i / SM.grid.W) + 1) * cell - 1);
  const points = [...SM.stations, ...(SM.seatOrder || []), ...(SM.brew || []), SM.entrance, SM.start].filter(Boolean);
  const ys = points.map((p) => (Array.isArray(p) ? p[1] : p.y));
  assert.ok(ys.length > 10 && ys.every(Number.isFinite), 'the content points are read');
  const contentBottom = Math.max(reachBottom, ...ys);
  assert.equal(reachBottom, 367, 'the deck floor ends at row 367');
  assert.ok(contentBottom <= 367, `no content point below row 367 (got ${contentBottom})`);
  // The dead band is exactly the art's rows below the content: drawn (the hull face), holding nothing.
  assert.equal(a.deadBottom, a.y1 - contentBottom, 'deadBottom = art bottom - content bottom');
  assert.equal(a.deadBottom, 48);
});

test('PACK_ART.tes keep box is re-measured from the pack: chairs, consoles, Stuff objects, a person on every reachable cell', () => {
  const TL = loadTs('src/renderer/src/scene/themes/tiled.ts');
  const P = loadTs('src/renderer/src/scene/themes/packs.ts');
  const dir = path.join(ROOT, 'themes', 'tes');
  const r = P.readPack(P.memoryFiles(H.readPackDir(dir)));
  const f = P.finishPack(r.value, H.decodeImages(dir, TL.normPath, r.value.images), r.diagnostics).value;
  const SM = f.scene, M = SM.M, L = (n) => M.layers.find((l) => l.name === n);
  const e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const add = (x, y) => { e.x0 = Math.min(e.x0, x); e.y0 = Math.min(e.y0, y); e.x1 = Math.max(e.x1, x); e.y1 = Math.max(e.y1, y); };
  const tilePx = (rt, ox, oy) => {
    const px = f.store.get(rt.image.path);
    for (let y = 0; y < rt.sh; y++) for (let x = 0; x < rt.sw; x++) {
      const sx = rt.h ? rt.sw - 1 - x : x, sy = rt.v ? rt.sh - 1 - y : y;
      if (px.data[((rt.sy + sy) * px.width + rt.sx + sx) * 4 + 3]) add(ox + x, oy + y);
    }
  };
  const chairs = L('Chairs').objects;
  assert.ok(chairs.length >= 9, 'the chairs are read');
  for (const o of chairs) { const b = TL.objBox(M, o); tilePx(b.T, b.x, b.y); }
  const con = L('Console');
  con.data.forEach((g, i) => { if (g) tilePx(TL.tileFor(M, g), (i % con.w) * M.tw, Math.floor(i / con.w) * M.th); });
  for (const o of L('Stuff').objects) { add(o.x, o.y); add(o.x + Math.max(0, (o.width || 0) - 1), o.y + Math.max(0, (o.height || 0) - 1)); }
  // A person: the frame's opaque box (over every frame of the sheet), drawn at round(x - fw/2),
  // round(y - fh), one px higher mid-step (the bob), standing anywhere on a reachable cell.
  const R = f.manifest.spriteRenderer, fw = R.frameWidth, fh = R.frameHeight, sh = f.store.get(f.sheet);
  const o = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let y = 0; y < sh.height; y++) for (let x = 0; x < sh.width; x++) if (sh.data[(y * sh.width + x) * 4 + 3]) {
    o.x0 = Math.min(o.x0, x % fw); o.x1 = Math.max(o.x1, x % fw); o.y0 = Math.min(o.y0, y % fh); o.y1 = Math.max(o.y1, y % fh);
  }
  const g = SM.grid.g;
  for (let i = 0; i < SM.reach.length; i++) if (SM.reach[i]) {
    const cx = (i % SM.grid.W) * g, cy = Math.floor(i / SM.grid.W) * g;
    add(cx, cy); add(cx + g - 1, cy + g - 1); // the floor stood on
    add(cx - fw / 2 + o.x0, cy - fh + o.y0 - 1);
    add(cx + g - 1 - fw / 2 + o.x1, cy + g - 1 - fh + o.y1);
  }
  for (const s of SM.seatOrder) add(s.x - fw / 2 + o.x0, s.y - fh + o.y0);
  assert.deepEqual(e, F.PACK_ART.tes.keep);
  // Outside it the art holds only the rim, the upper wall and the hull: the keep box sits inside the art.
  const a = F.PACK_ART.tes;
  assert.ok(a.x0 < e.x0 && e.x1 < a.x1 && a.y0 < e.y0 && e.y1 < a.y1);
});

test('floorFrame: TES frames its art with the margin; the office (and any other id) fits the whole map', () => {
  const t = F.floorFrame('tes', 960, 640);
  assert.deepEqual(t, { x: 312, y: 24, w: 304, h: 392, deadBottom: 48, keep: { x0: 335, y0: 84, x1: 591, y1: 367 }, art: { x0: 320, y0: 32, x1: 607, y1: 415 } });
  assert.deepEqual(F.packFrame('tes'), t);
  for (const id of ['office', 'dunder', undefined, null, '', 'toString', '__proto__']) {
    assert.deepEqual(F.floorFrame(id, 1024, 768), { x: 0, y: 0, w: 1024, h: 768, deadBottom: 0 }, String(id));
    assert.equal(F.packFrame(id), null, String(id));
  }
  // A map too small for the measured art (a changed pack) falls back to the whole map.
  assert.deepEqual(F.floorFrame('tes', 600, 640), { x: 0, y: 0, w: 600, h: 640, deadBottom: 0 });
  assert.deepEqual(F.floorFrame('tes', 960, 400), { x: 0, y: 0, w: 960, h: 400, deadBottom: 0 });
});

test('Camera, TES: the content is centred both ways, never clipped, and only dead-band rows leave the pane', () => {
  const f = F.floorFrame('tes', 960, 640);
  const content = { x0: f.x, y0: f.y, x1: f.x + f.w, y1: f.y + f.h - f.deadBottom };
  for (const [vw, vh] of VIEWS) {
    const c = settled(960, 640, f, vw, vh);
    const z = Math.min(vw / f.w, vh / (f.h - f.deadBottom));
    assert.ok(Math.abs(c.z - z) < 1e-9, `${vw}x${vh}: zoom fits the content (${c.z} vs ${z})`);
    const s = shown(c, vw, vh);
    assert.ok(s.x0 <= content.x0 + EPS && s.x1 >= content.x1 - EPS, `${vw}x${vh}: content not clipped left/right ${JSON.stringify(s)}`);
    assert.ok(s.y0 <= content.y0 + EPS && s.y1 >= content.y1 - EPS, `${vw}x${vh}: content not clipped top/bottom ${JSON.stringify(s)}`);
    // Centred: the content's centre is the pane's centre.
    assert.ok(Math.abs((content.x0 + content.x1) / 2 * c.z + c.x - vw / 2) < 1e-6, `${vw}x${vh}: centred horizontally`);
    assert.ok(Math.abs((content.y0 + content.y1) / 2 * c.z + c.y - vh / 2) < 1e-6, `${vw}x${vh}: centred vertically`);
  }
  // At the TES default aspect the content fills the pane exactly and the whole dead band is below it.
  const vh = 430, vw = Math.round(vh * F.frameAspect(f));
  const c = settled(960, 640, f, vw, vh), s = shown(c, vw, vh);
  assert.ok(Math.abs(s.y1 - content.y1) < 0.01 && Math.abs(s.y0 - content.y0) < 0.01, `framed top ${s.y0} and bottom ${s.y1}`);
  assert.ok(s.y1 < f.y + f.h, 'the dead band runs off the bottom');
});

test('Camera, office: no frame gives exactly the old fit (whole map, centred)', () => {
  for (const [mw, mh] of [[1024, 768], [960, 640], [1280, 720]]) {
    for (const [vw, vh] of VIEWS) {
      const old = { z: Math.min(vw / mw, vh / mh) };
      old.x = (vw - mw * old.z) / 2; old.y = (vh - mh * old.z) / 2;
      for (const c of [settled(mw, mh, undefined, vw, vh), settled(mw, mh, null, vw, vh), settled(mw, mh, F.floorFrame('office', mw, mh), vw, vh)]) {
        assert.ok(Math.abs(c.z - old.z) < 1e-9 && Math.abs(c.x - old.x) < 1e-6 && Math.abs(c.y - old.y) < 1e-6,
          `${mw}x${mh} in ${vw}x${vh}: ${JSON.stringify(c)} vs ${JSON.stringify(old)}`);
      }
    }
  }
});

test('framedSidebarWidth: the default pane takes the TES content aspect, clamped as the splitter clamps', () => {
  const f = F.packFrame('tes');
  assert.ok(Math.abs(F.frameAspect(f) - 304 / 344) < 1e-12);
  assert.equal(F.FLOOR_ROW_CHROME, 42);
  // TES-FLOOR-WHOLE-188: the framed pane takes the row's left padding, so only the right padding
  // and the splitter lie beside it.
  assert.equal(F.FLOOR_PANE_BLEED, 16);
  // The screenshot windows: pane heights 430 and 640 give panes 380 and 566 wide.
  assert.equal(F.framedSidebarWidth(f, 960, 430), 960 - 26 - 380);
  assert.equal(F.framedSidebarWidth(f, 1290, 640), 1290 - 26 - 566);
  // Clamps: never under 320, never over 1200 nor viewport - 360.
  assert.equal(F.framedSidebarWidth(f, 700, 260), 340, '700 wide: viewport - 360');
  assert.equal(F.framedSidebarWidth(f, 600, 900), 320);
  assert.equal(F.framedSidebarWidth(f, 4000, 300), 1200);
});

/** The real store, loaded fresh in a child process with `stored` as the saved sidebar width. */
function storeWith(stored, steps) {
  const script = `
    const ls = new Map(${JSON.stringify(stored)} === null ? [] : [['cth.sidebarWidth', ${JSON.stringify(stored)}]]);
    globalThis.window = { innerWidth: 1290, addEventListener() {}, removeEventListener() {},
      localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) } };
    globalThis.localStorage = window.localStorage;
    const { useStore } = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/renderer/src/store/store.ts');
    const seen = [];
    const look = () => { const s = useStore.getState(); seen.push([s.sidebarWidth, s.sidebarWidthSet, ls.get('cth.sidebarWidth') ?? null]); };
    look();
    for (const st of ${JSON.stringify(steps)}) { if (st === 'reset') useStore.getState().resetSidebarWidth(); else useStore.getState().setSidebarWidth(st); look(); }
    process.stdout.write(JSON.stringify(seen));`;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('store: nothing stored is "not set" (so a fresh install gets the TES default); a stored or dragged width is set', () => {
  // Jim's mutant: initialSidebarWidth returning 420 when nothing is stored would mark every fresh
  // install as user-sized, and the TES default would never apply.
  assert.deepEqual(storeWith(null, []), [[420, false, null]]);
  for (const bad of ['', 'junk', '100', '5000']) assert.deepEqual(storeWith(bad, []), [[420, false, bad]], `stored ${JSON.stringify(bad)}`);
  assert.deepEqual(storeWith('600', []), [[600, true, '600']]);
  // Dragging sets it (and stores it); the splitter's double-click reset forgets it.
  assert.deepEqual(storeWith(null, [500, 'reset']), [[420, false, null], [500, true, '500'], [420, false, null]]);
});

test('App/store wiring: a framed floor sets only the default width; a user width is kept; the office keeps 420', () => {
  const app = src('src/renderer/src/App.tsx');
  assert.match(app, /const floorFrameNow = packFrame\(officeTheme\);/);
  assert.match(app, /const shownSidebarWidth = !sidebarWidthSet && floorFrameNow && floorPaneHeight > 0\r?\n\s+\? framedSidebarWidth\(floorFrameNow, vpWidth, floorPaneHeight\)\r?\n\s+: sidebarWidth;/);
  assert.equal((app.match(/width=\{shownSidebarWidth\}/g) || []).length, 1, 'the splitter shows the shown width');
  assert.equal((app.match(/width: shownSidebarWidth, flexShrink: 0,/g) || []).length, 1, 'the sidebar takes the shown width');
  assert.doesNotMatch(app, /width: sidebarWidth, flexShrink/);
  assert.match(app, /<div ref=\{setFloorPane\} style=\{\{ flex: 1,/);
  assert.match(app, /onReset=\{resetSidebarWidth\}/);
  const store = src('src/renderer/src/store/store.ts');
  assert.match(store, /sidebarWidth: initialSidebarWidth \?\? 420,\r?\n\s+sidebarWidthSet: initialSidebarWidth !== null,/);
  assert.match(store, /set\(\{ sidebarWidth: clamped, sidebarWidthSet: true \}\);/);
  assert.match(store, /removeItem\(LS_SIDEBAR_WIDTH\)[^\n]*\r?\n\s+set\(\{ sidebarWidth: 420, sidebarWidthSet: false \}\);/);
  const splitter = src('src/renderer/src/components/SidebarSplitter.tsx');
  assert.match(splitter, /onDoubleClick=\{\(\) => \(onReset \? onReset\(\) : onChange\(420\)\)\}/);
  const floor = src('src/renderer/src/scene/themes/StationFloor.tsx');
  assert.match(floor, /const frame0 = floorFrame\(pack\.manifest\.id, SM\.PW, SM\.PH\);/);
  assert.match(floor, /camera\.setFrame\(frame0\);\r?\n\s+camera\.setViewSize/);
  // TES-FLOOR-WHOLE-188: a framed floor pane takes the row's padding on the top, left and bottom.
  assert.match(app, /<div ref=\{setFloorPane\} style=\{\{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', \.\.\.\(floorFrameNow \? \{ margin: `-\$\{FLOOR_PANE_BLEED\}px 0 -\$\{FLOOR_PANE_BLEED\}px -\$\{FLOOR_PANE_BLEED\}px` \} : null\) \}\}>/);
  // The office floor sets no frame.
  assert.doesNotMatch(src('src/renderer/src/scene/office/OfficeFloor.tsx'), /setFrame\(/);
});
