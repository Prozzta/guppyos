'use strict';
/**
 * TES-BUBBLE-TAIL-SHARP-189: the Human's bar for a thought cloud, on both floors and at every fit.
 * - The tail points at the speaker's head. 1.1.88 drew it at 0.32 of the cloud's width and stepped
 *   it 5 px further left, under a cloud centred on the head: every tip landed 21-41 px left of it.
 * - The text is sharp: one texel per device px, from a whole device px. 1.1.88 drew the clouds in
 *   the scaled world at half scale, so the text was resampled by 0.5 x the world scale (0.911 on
 *   the smooth fit) from wherever the world put it.
 * The clouds now hang in an unscaled screen-space layer, placed through the world's transform and
 * rounded to whole device px, and the tail is aimed at the head every frame.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { readSource, codeOnly } = require('./read-source.cjs');

const BUBBLE = 'src/renderer/src/scene/office/ThoughtBubble.ts';

/** The real ThoughtBubble on a stand-in pixi that keeps parents, scales and every circle drawn. */
function realBubble() {
  class Container {
    constructor() {
      this.x = 0; this.y = 0; this.alpha = 1; this.visible = true; this.children = []; this.parent = null;
      this.scale = { x: 1, y: 1, set(a, b = a) { this.x = a; this.y = b; } };
    }
    addChild(...c) { for (const k of c) { k.parent = this; this.children.push(k); } return c[0]; }
    destroy() {}
  }
  class Graphics extends Container {
    constructor() { super(); this.circles = []; }
    clear() { this.circles = []; return this; } roundRect() { return this; } fill() { return this; } stroke() { return this; }
    circle(x, y, r) { this.circles.push({ x, y, r }); return this; }
  }
  class Text extends Container {
    constructor(o) { super(); this.options = o; this.text = o.text; }
    get width() { return this.text.length * 7; } get height() { return 14; }
  }
  const out = ts.transpileModule(readSource(BUBBLE), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const shade = new Proxy({}, { get: () => '#000000' });
  const req = (id) => ({ 'pixi.js': { Container, Graphics, Text }, '@/design/tokens': { colors: new Proxy({}, { get: () => shade }) }, './ToolBubble': { toolIcon: () => '*' } })[id];
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  const b = new mod.exports.ThoughtBubble();
  b.setBounds(960, 640);
  return { b, Graphics, Text };
}

/** A point in `node`'s own space, in the space of its root (the stage the floor adds it to). */
function toRoot(node, x, y) {
  for (let n = node; n; n = n.parent) { x = n.x + n.scale.x * x; y = n.y + n.scale.y * y; }
  return { x, y };
}
function scaleToRoot(node) {
  let s = 1;
  for (let n = node; n; n = n.parent) s *= n.scale.x;
  return s;
}
/** Every circle the cloud drew, in root (screen) px, lowest last. */
function puffs(b, Graphics) {
  const all = [];
  const walk = (n) => {
    if (n instanceof Graphics) for (const c of n.circles) all.push({ ...toRoot(n, c.x, c.y), r: c.r * scaleToRoot(n) });
    for (const k of n.children) walk(k);
  };
  walk(b.container);
  return all.sort((p, q) => p.y - q.y);
}
function aim(b, view) {
  if (typeof b.setView === 'function') b.setView(view);
  else b.setZoom(view.scale); // 1.1.88: the cloud only knew the zoom
}

// The world's transform as the floors set it: 1.1.88 at 2, the hull branch's smooth fit at 575x612,
// a DPR 1.25 pane, the office at 1 and zoomed in at 3 on DPR 1.5.
const VIEWS = [
  { scale: 2, x: -640, y: -124, resolution: 1 },
  { scale: 1.8214285714285714, x: -558, y: -58, resolution: 1 },
  { scale: 1.6, x: -301.3, y: -77.7, resolution: 1.25 },
  { scale: 1, x: 0, y: 0, resolution: 1 },
  { scale: 3, x: -903.4, y: -211.9, resolution: 1.5 },
];
// Heads (the anchor: the drawn sprite's foot-line middle, world px) and how the floor slid the cloud.
const HEADS = [
  { what: 'centre', px: 480, py: 300, slide: 0 },
  { what: 'slid left', px: 480, py: 300, slide: -20 },
  // Next frame, slid further: a narrow cloud's tail root stays at its edge, but the tip must follow.
  { what: 'slid further left', px: 480, py: 300, slide: -30 },
  { what: 'slid right', px: 480, py: 300, slide: 20 },
  { what: 'left half', px: 140, py: 260, slide: 0 },
  { what: 'right half', px: 820, py: 260, slide: 0 },
  { what: 'clamped at the left edge', px: 6, py: 300, slide: 0 },
  { what: 'clamped at the right edge', px: 954, py: 300, slide: 0 },
  { what: 'clamped at the top', px: 480, py: 20, slide: 0 },
];
const LINES = ['hello there', 'a longer line of work that wraps', ''];

test('T1 the tail tip is over the head (within 2 px) for centred, slid, clamped, left- and right-half clouds, at every view', () => {
  const misses = [];
  for (const view of VIEWS) {
    for (const line of LINES) {
      const { b, Graphics } = realBubble();
      b.show(line);
      for (const h of HEADS) {
        aim(b, view);
        b.setPosition(h.px, h.py, h.slide);
        const p = puffs(b, Graphics);
        const tip = p.at(-1), head = view.x + h.px * view.scale;
        const where = `${h.what}, '${line}', scale ${view.scale.toFixed(3)} DPR ${view.resolution}`;
        if (!(Math.abs(tip.x - head) <= 2)) misses.push(`${where}: tip ${tip.x.toFixed(1)} vs head ${head.toFixed(1)}`);
        const top = toRoot(b.bg, 0, 0).y, bottom = toRoot(b.bg, 0, b.bgH).y;
        assert.ok(p.length >= 2 && p.every((q) => q.y > bottom), `${where}: the puffs hang below the cloud (${top}..${bottom})`);
        const left = toRoot(b.bg, 0, 0).x, right = toRoot(b.bg, b.bgW, 0).x;
        assert.ok(p[0].x >= left && p[0].x <= right, `${where}: the tail leaves from under the cloud`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

test('T2 the text is drawn one texel per device px: nothing between it and the screen scales it, at every view', () => {
  for (const view of VIEWS) {
    const { b } = realBubble();
    b.show('hello there');
    aim(b, view);
    b.setPosition(480, 300);
    // Pixi rasterises a Text at the renderer resolution (autoResolution): a texel is one device px
    // exactly when the label's scale to the unscaled stage is 1.
    assert.equal(scaleToRoot(b.label), 1, `scale ${view.scale} DPR ${view.resolution}`);
    assert.equal(b.label.options.textureStyle?.scaleMode, 'nearest', 'a texel is never blended with its neighbour');
  }
});

test('T3 the text starts on a whole device px, at every view and anchor', () => {
  for (const view of VIEWS) {
    const { b } = realBubble();
    b.show('hello there');
    for (const h of HEADS) {
      aim(b, view);
      b.setPosition(h.px + 0.37, h.py + 0.61, h.slide);
      const o = toRoot(b.label, 0, 0);
      for (const v of [o.x, o.y]) assert.ok(Math.abs(v * view.resolution - Math.round(v * view.resolution)) < 1e-6, `${h.what} scale ${view.scale} DPR ${view.resolution}: ${v} is not on a device px`);
    }
  }
});

test('T4 the layout the floors part clouds with is in world px, and matches where the cloud is drawn', () => {
  for (const view of VIEWS) {
    const { b } = realBubble();
    b.show('hello there');
    aim(b, view);
    const lay = b.getLayout(480, 300);
    b.setPosition(480, 300);
    const at = toRoot(b.container, 0, 0);
    assert.ok(Math.abs(lay.w * view.scale - b.bgW) < 1e-6, 'the cloud is bgW screen px wide whatever the world scale');
    assert.ok(Math.abs(view.x + lay.x * view.scale - at.x) <= 0.5 / view.resolution + 1e-9, `drawn where laid out (${at.x} vs ${view.x + lay.x * view.scale})`);
    assert.ok(Math.abs(view.y + lay.y * view.scale - at.y) <= 0.5 / view.resolution + 1e-9);
  }
});

test('T5 both floors hang the clouds in an unscaled layer on the stage, over the world, and hand them the world transform', () => {
  const layer = codeOnly(readSource('src/renderer/src/scene/themes/BubbleLayer.ts'), 'BubbleLayer.ts');
  assert.match(layer, /readonly screen = new Container\(\);/);
  assert.match(layer, /this\.screen\.addChild\(bubble\.container\);/, 'TES clouds go to the screen layer');
  assert.doesNotMatch(layer, /this\.container\.addChild\(bubble\.container\)/, 'never into the world');
  assert.match(layer, /active\.bubble\.setView\(view\);/);
  const station = codeOnly(readSource('src/renderer/src/scene/themes/StationFloor.tsx'), 'StationFloor.tsx');
  assert.match(station, /app\.stage\.addChild\(world\);\s*app\.stage\.addChild\(bubbles\.screen\);/);
  assert.match(station, /bubbles\.update\(dt, anchors, \{ scale: world\.scale\.x, x: world\.x, y: world\.y, resolution: app\.renderer\.resolution \}\);/);
  const office = codeOnly(readSource('src/renderer/src/scene/office/OfficeFloor.tsx'), 'OfficeFloor.tsx');
  assert.match(office, /app\.stage\.addChild\(world\);(?:(?!addChild)[\s\S])*app\.stage\.addChild\(thoughtLayer\);/, 'the next thing on the stage after the world');
  assert.match(office, /character\.show\(charLayer, thoughtLayer\);/);
  assert.match(office, /const view = \{ scale: world\.scale\.x, x: world\.x, y: world\.y, resolution: app\.renderer\.resolution \};/);
  assert.match(office, /rt\.character\.setBubbleView\(view\);/);
  const character = codeOnly(readSource('src/renderer/src/scene/office/Character.ts'), 'Character.ts');
  assert.match(character, /thoughtParent\.addChild\(this\.thoughtBubble\.container\);/);
});
