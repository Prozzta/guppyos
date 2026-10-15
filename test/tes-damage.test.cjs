'use strict';
// PERF-FLOOR-FILL-188: the TES floor's damage tracking (damage.ts): which device-px rects a frame
// draws again. The rendered proof that a frame so drawn equals a full draw is in the harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const D = loadTs('src/renderer/src/scene/themes/damage.ts');

let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const int = (n) => Math.floor(rnd() * n);
const inside = (rs, x, y) => rs.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

test('deviceRect: every device px the bounds touch, one px more each side, clipped to the canvas', () => {
  assert.deepEqual(D.deviceRect({ minX: 10, minY: 20, maxX: 15, maxY: 30 }, 1, 100, 100), { x: 9, y: 19, w: 7, h: 12 });
  assert.deepEqual(D.deviceRect({ minX: 10.25, minY: 20.5, maxX: 15.5, maxY: 30 }, 2, 100, 100), { x: 19, y: 40, w: 13, h: 21 });
  assert.deepEqual(D.deviceRect({ minX: -5, minY: -5, maxX: 3, maxY: 3 }, 1, 100, 100), { x: 0, y: 0, w: 4, h: 4 });
  assert.equal(D.deviceRect({ minX: 200, minY: 0, maxX: 210, maxY: 5 }, 1, 100, 100), null, 'off the canvas');
  assert.equal(D.deviceRect({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, 1, 100, 100), null, 'empty bounds');
});

test('mergeRects: every input px stays covered, the result holds at most maxRects disjoint rects', () => {
  for (let run = 0; run < 300; run++) {
    const rects = Array.from({ length: 1 + int(14) }, () => ({ x: int(90), y: int(90), w: 1 + int(20), h: 1 + int(20) }));
    const max = 1 + int(6);
    const out = D.mergeRects(rects, max);
    assert.ok(out.length <= max, `run ${run}: ${out.length} > ${max}`);
    for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) assert.ok(inside(out, x, y), `run ${run}: (${x},${y}) dropped`);
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      assert.ok(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y, `run ${run}: rects ${i} and ${j} touch`);
    }
  }
  assert.deepEqual(D.mergeRects([]), []);
});

test('DamageTracker: a new view draws it all; a mover damages its old and new rect; a removed thing its old one', () => {
  const t = new D.DamageTracker();
  const a = {}, b = {}, c = {};
  const R = (x, y) => ({ x, y, w: 10, h: 10 });
  const frame = (view, entries) => t.frame(view, new Map(entries), [], 1000, 1000);
  assert.equal(frame('v1', [[a, { rect: R(0, 0), sig: 's' }]]), 'full', 'the first frame');
  assert.deepEqual(frame('v1', [[a, { rect: R(0, 0), sig: 's' }]]), [], 'nothing changed: nothing drawn');
  assert.deepEqual(frame('v1', [[a, { rect: R(100, 0), sig: 's' }]]), [R(0, 0), R(100, 0)], 'moved: old and new');
  assert.deepEqual(frame('v1', [[a, { rect: R(100, 0), sig: 't' }]]), [R(100, 0)], 'changed in place');
  assert.deepEqual(frame('v1', [[a, { rect: R(100, 0), sig: 't' }], [b, { rect: R(300, 300), sig: 's' }]]), [R(300, 300)], 'appeared');
  assert.deepEqual(frame('v1', [[b, { rect: R(300, 300), sig: 's' }]]), [R(100, 0)], 'removed: its old rect');
  assert.deepEqual(frame('v1', [[b, { rect: null, sig: 's' }]]), [R(300, 300)], 'hidden (no rect): its old rect');
  assert.deepEqual(frame('v1', [[b, { rect: R(300, 300), sig: 's' }]]), [R(300, 300)], 'shown again');
  assert.equal(frame('v2', [[b, { rect: R(300, 300), sig: 's' }]]), 'full', 'the view changed');
  assert.deepEqual(frame('v2', [[b, { rect: R(300, 300), sig: 's' }], [c, { rect: { x: 0, y: 0, w: 800, h: 700 }, sig: 's' }]]), 'full', 'past half the canvas');
  t.invalidate();
  assert.equal(frame('v2', [[b, { rect: R(300, 300), sig: 's' }]]), 'full', 'invalidated');
  assert.deepEqual(t.frame('v2', new Map([[b, { rect: R(300, 300), sig: 's' }]]), [R(5, 5)], 1000, 1000), [R(5, 5)], 'always-rects are drawn');
});
