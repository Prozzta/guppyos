'use strict';
// PANEL-BLINK-188: on 1.1.87 the bridge's chair panels never blinked while their agent worked (the
// viewer's paintPanels was never ported to the floor), and the bottom cards' status dots stood still.
// (a) panels.ts: the ToSBridge *Panel shapes, their seats and lights, working/idle/empty, the 240 ms
// cycle; PanelLayer swaps prebuilt textures (no per-frame raster). (b) PixelBadge blinks while working.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const C = loadTs('src/renderer/src/scene/themes/compositor.ts');
const PN = loadTs('src/renderer/src/scene/themes/panels.ts');
const TES_DIR = path.join(__dirname, '..', 'themes', 'tes');

let tes = null;
function tesPanels() {
  if (tes) return tes;
  const r = P.readPack(P.memoryFiles(H.readPackDir(TES_DIR)));
  const pk = P.finishPack(r.value, H.decodeImages(TES_DIR, T.normPath, r.value.images), r.diagnostics).value;
  const plan = C.buildScenePlan({ ...pk.scene, store: pk.store });
  tes = { pk, plan, panels: PN.findPanels(pk.scene, pk.manifest.stations.layer, plan) };
  return tes;
}
const byName = (n) => tesPanels().panels.find((p) => p.name === n);

// ── (a) the panels of the ToSBridge map ──────────────────────────────────────

test('(a) every *Panel shape of the bridge goes with its own seat (the viewer\'s nearest-seat rule)', () => {
  const got = Object.fromEntries(tesPanels().panels.map((p) => [p.name, p.seat.name]));
  assert.deepEqual(got, {
    '1Panel': 'Chair1', '2Panel': 'Chair2', '3Panel': 'Chair3', '4panel': 'Chair4', '5Panel': 'Chair5', '6Panel': 'Chair6',
    s1Panel: 'Speck1', s2Panel: 'Speck2', CapPanel: 'Captain'
  });
});

test('(a) the lights: the viewer\'s counts, each drawn by what the floor draws on top there', () => {
  const want = { '1Panel': 70, '2Panel': 36, '3Panel': 24, '4panel': 36, '5Panel': 24, '6Panel': 36, s1Panel: 50, s2Panel: 50, CapPanel: 16 };
  for (const [n, k] of Object.entries(want)) assert.equal(byName(n).lights, k, n);
  const { plan } = tesPanels();
  // the chair consoles are in the flattened floor under everyone; the Speck desks and the Captain's are sorted statics
  for (const n of ['1Panel', '2Panel', '3Panel', '4panel', '5Panel', '6Panel']) assert.deepEqual(byName(n).groups.map((g) => g.owner), ['below'], n);
  for (const n of ['s1Panel', 's2Panel', 'CapPanel']) {
    const owners = byName(n).groups.map((g) => g.owner);
    assert.equal(owners.length, 1, n);
    assert.equal(typeof owners[0], 'number', n);
    assert.ok(plan.sorted[owners[0]].px, n);
  }
  // each group's box holds its lights, and each light keeps the viewer's phase
  for (const p of tesPanels().panels) for (const g of p.groups) for (const q of g.lights) {
    assert.ok(q.x >= g.x && q.x < g.x + g.w && q.y >= g.y && q.y < g.y + g.h, p.name);
    assert.equal(q.h, (q.x * 7 + q.y * 13) % 5);
  }
});

test('(a) panelLights: a tiny panel is all light; else its small one-colour spots; else its bright pixels', () => {
  const W = 12, Hh = 12, px = (fill) => { const d = new Uint8ClampedArray(W * Hh * 4); for (let i = 0; i < W * Hh; i++) { const [r, g, b] = fill(i % W, (i / W) | 0); d.set([r, g, b, 255], i * 4); } return { width: W, height: Hh, data: d }; };
  const clear = { width: W, height: Hh, data: new Uint8ClampedArray(W * Hh * 4) };
  const plan = (below) => ({ below, above: clear, sorted: [] });
  const box = (x, y, w, h) => ({ shape: 'rect', x, y, w, h });
  // 4x4 = 16 pixels: all lights
  assert.equal(PN.panelLights(plan(px(() => [10, 10, 10])), box(0, 0, 4, 4)).length, 16);
  // 6x6 grey with two 2x2 LEDs (4 px each, one colour): just the LEDs
  const leds = px((x, y) => ((x === 1 || x === 2) && (y === 1 || y === 2)) || ((x === 4 || x === 5) && (y === 4)) ? [0, 200, 0] : [40, 40, 40]);
  const L = PN.panelLights(plan(leds), box(0, 0, 6, 6));
  assert.equal(L.length, 6);
  assert.ok(L.every((q) => q.owner === 'below'));
  // 6x6 with no small one-colour spot (a 6 px bright stripe over 30 px of grey): the pixels brighter than median + 20
  const stripe = px((x, y) => (y === 0 ? [250, 250, 250] : [30, 30, 30]));
  assert.deepEqual(PN.panelLights(plan(stripe), box(0, 0, 6, 6)).map((q) => q.y), [0, 0, 0, 0, 0, 0]);
});

const seat = (name) => ({ name });
test('(a) panelStates: working only when the seat\'s sitter is seated at the desk; idle when held or left idle; else empty', () => {
  const A = seat('A'), B = seat('B'), Cc = seat('C');
  const panels = [{ seat: A }, { seat: B }, { seat: Cc }];
  const w = (o) => ({ seat: null, lastSeat: null, seated: false, status: 'working', ...o });
  assert.deepEqual(PN.panelStates(panels, [w({ seat: A, seated: true })]), ['working', 'empty', 'empty']);
  // still walking to the seat: held, not yet working
  assert.deepEqual(PN.panelStates(panels, [w({ seat: A })]), ['idle', 'empty', 'empty']);
  // seated but idle: amber
  assert.deepEqual(PN.panelStates(panels, [w({ seat: A, seated: true, status: 'idle' })]), ['idle', 'empty', 'empty']);
  // gone idle and left the chair: its last seat stays amber; someone else working leaves theirs
  assert.deepEqual(PN.panelStates(panels, [w({ lastSeat: B, status: 'idle' }), w({ lastSeat: Cc, status: 'working' })]), ['empty', 'idle', 'empty']);
  // a working sitter wins over someone idle whose last seat it was
  assert.deepEqual(PN.panelStates(panels, [w({ lastSeat: A, status: 'idle' }), w({ seat: A, seated: true })]), ['working', 'empty', 'empty']);
  // the out array is reused
  const out = ['x', 'y', 'z', 'w'];
  assert.equal(PN.panelStates(panels, [], out), out);
  assert.deepEqual(out, ['empty', 'empty', 'empty']);
});

test('(a) the frame steps every 240 ms through 5 phases while working; idle and empty hold', () => {
  assert.equal(PN.PANEL_STEP_MS, 240);
  assert.deepEqual([0, 239, 240, 479, 480, 960, 1199, 1200].map((t) => PN.panelFrame('working', t)), [0, 0, 1, 1, 2, 4, 4, 0]);
  for (const t of [0, 240, 99999]) { assert.equal(PN.panelFrame('idle', t), 'idle'); assert.equal(PN.panelFrame('empty', t), 'empty'); }
  assert.deepEqual([...PN.PANEL_GREEN], ['#a6ffb8', '#5cf07f', '#5cf07f', '#2fbf55', '#17602c']);
  assert.equal(PN.PANEL_IDLE, '#9a6a1e');
  assert.equal(PN.PANEL_EMPTY, '#2a2e38');
  assert.equal(PN.lightColour(3, 4), PN.PANEL_GREEN[2]);
  assert.equal(PN.lightColour('idle', 4), PN.PANEL_IDLE);
  assert.equal(PN.lightColour('empty', 0), PN.PANEL_EMPTY);
});

test('(a) groupPixels: the lights opaque in the frame\'s colour, everything else clear', () => {
  const g = { owner: 'below', x: 10, y: 20, w: 3, h: 2, lights: [{ x: 10, y: 20, h: 0 }, { x: 12, y: 21, h: 2 }] };
  const rgba = (p, x, y) => [...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const f1 = PN.groupPixels(g, 1);
  assert.equal(f1.width, 3); assert.equal(f1.height, 2);
  assert.deepEqual(rgba(f1, 0, 0), [...hex(PN.PANEL_GREEN[1]), 255]);
  assert.deepEqual(rgba(f1, 2, 1), [...hex(PN.PANEL_GREEN[3]), 255]);
  assert.deepEqual(rgba(f1, 1, 0), [0, 0, 0, 0]);
  assert.deepEqual(rgba(PN.groupPixels(g, 'idle'), 2, 1), [...hex(PN.PANEL_IDLE), 255]);
  assert.deepEqual(rgba(PN.groupPixels(g, 'empty'), 0, 0), [...hex(PN.PANEL_EMPTY), 255]);
});

test('(a) the floor wiring: PanelLayer built over the cached floor, updated each tick, sorted with the statics', () => {
  const src = readSource('src/renderer/src/scene/themes/StationFloor.tsx');
  assert.match(src, /import \{ PanelLayer \} from '\.\/PanelLayer';/);
  assert.match(src, /const panelLayer = new PanelLayer\(plan, SM, pack\.manifest\.stations\.layer, own, sortLayer, world\.addChild\(new Container\(\)\)\);/);
  assert.match(src, /crew\.tick\([^\n]*\n[\s\S]{0,400}panelLayer\.update\(clock, crew\.walkers\(\)\);/);
  assert.match(src, /for \(const q of panelLayer\.sorted\) items\.push\(q\);/);
  const layer = readSource('src/renderer/src/scene/themes/PanelLayer.ts');
  // the no-CPU bar: a texture is rastered once per group and frame, and swapped only when the frame changes
  assert.match(layer, /if \(f === L\.shown\) continue;/);
  assert.match(layer, /if \(!t\) \{ t = this\.own\(groupPixels\(L\.group, f\)\); L\.tex\.set\(f, t\); \}/);
});

// ── (b) the cards ────────────────────────────────────────────────────────────

test('(b) the card\'s status dot blinks while working (thinking reads "working" too), never otherwise', () => {
  const B = loadTs('src/renderer/src/components/PixelBadge.tsx');
  for (const s of ['working', 'thinking']) assert.equal(B.badgeBlinks(s), true, s);
  for (const s of ['idle', 'waiting', 'blocked', 'success', 'ghost', 'compacting', 'looping', 'typing']) assert.equal(B.badgeBlinks(s), false, s);
  assert.equal(B.BADGE_BLINK, 'cth-led 1200ms steps(1, end) infinite');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { createElement } = require('react');
  assert.match(renderToStaticMarkup(createElement(B.PixelBadge, { status: 'working', blink: true })), /animation:cth-led 1200ms steps\(1, end\) infinite/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(B.PixelBadge, { status: 'idle', blink: false })), /animation/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(B.PixelBadge, { status: 'working' })), /animation/);
  const card = readSource('src/renderer/src/components/AgentCard.tsx');
  assert.equal((card.match(/blink=\{badgeBlinks\(held\.status\)\}/g) || []).length, 2);
  const css = readSource('src/renderer/src/design/global.css');
  assert.match(css, /@keyframes cth-led \{\s*0%, 49% \{ opacity: 1; \}\s*50%, 100% \{ opacity: 0\.35; \}\s*\}/);
});
