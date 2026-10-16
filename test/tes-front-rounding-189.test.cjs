'use strict';
/**
 * TES-HULL M2, Jim NIT 2: placeFront rounds a front static's quad corners as Pixi's vertex shader
 * rounds the floor's, per target. Pixi's roundPixels works in clip space and the canvas projection is
 * flipped in y (a render texture's is not), so on the canvas a corner lands on ceil(y - 0.5) and on a
 * render texture on floor(y + 0.5); x is floor(x + 0.5) on both. The two differ only at an exact
 * half device px, which the rendered run never hits (Jim's mutants C and D survive it), so this pure
 * test pins the pair against Pixi's own shader text and projection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PIXI = path.join(ROOT, 'node_modules/pixi.js');
const read = (rel) => fs.readFileSync(rel, 'utf8').replace(/\r\n/g, '\n');

/** placeFront's rx and ry, taken from the source (root = the canvas). */
function placeFrontRounding(src = read(path.join(ROOT, 'src/renderer/src/scene/themes/StationFloor.tsx'))) {
  const rx = src.match(/const rx = \(x: number\) => (.+);\n/);
  const ry = src.match(/const ry = \(y: number\) => \(root \? (.+) : (.+)\);\n/);
  assert.ok(rx && ry, 'placeFront still has its rx/ry rounding pair');
  return { rx: new Function('x', `return ${rx[1]};`), ryCanvas: new Function('y', `return ${ry[1]};`), ryTexture: new Function('y', `return ${ry[2]};`) };
}

/** Where Pixi puts a vertex at device coordinate v on a target `size` device px long, from its own
 *  projection (flipped or not) and its roundPixels shader formula; returned as a device px from the top/left. */
async function pixiRounding() {
  const glsl = read(path.join(PIXI, 'lib/rendering/high-shader/shader-bits/roundPixelsBit.mjs'));
  assert.match(glsl, /return \(floor\(\(\(position \* 0\.5 \+ 0\.5\) \* targetSize\) \+ 0\.5\) \/ targetSize\) \* 2\.0 - 1\.0;/, "Pixi's roundPixels formula is the one modelled here");
  const rts = read(path.join(PIXI, 'lib/rendering/renderers/shared/renderTarget/RenderTargetSystem.mjs'));
  assert.match(rts, /calculateProjection\(\n\s+this\.projectionMatrix,\n\s+0,\n\s+0,\n[^\n]+\n[^\n]+\n\s+!renderTarget\.isRoot\n\s+\);/, 'flipY = !isRoot');
  const { calculateProjection } = await import(pathToFileURL(path.join(PIXI, 'lib/rendering/renderers/gpu/renderTarget/calculateProjection.mjs')).href);
  const round = (clip, size) => (Math.floor((clip * 0.5 + 0.5) * size + 0.5) / size) * 2 - 1;
  // Powers of two: the clip-space arithmetic is then exact, exact halves included (the GPU's float32 is too on such a size).
  const W = 2048, H = 1024;
  const at = (isRoot) => {
    const pm = { identity() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.tx = 0; this.ty = 0; return this; } };
    calculateProjection(pm, 0, 0, W, H, !isRoot);
    return {
      x: (x) => (round(pm.a * x + pm.tx, W) * 0.5 + 0.5) * W,
      // GL rows count from the bottom of the framebuffer: the canvas shows its last row on top; a
      // render texture's row 0 is its top (its projection is the flipped one).
      y: (y) => { const glRow = (round(pm.d * y + pm.ty, H) * 0.5 + 0.5) * H; return isRoot ? H - glRow : glRow; }
    };
  };
  return { canvas: at(true), texture: at(false) };
}

const SAMPLES = [];
for (let i = 0; i <= 40; i++) for (const f of [0, 0.25, 0.4999, 0.5, 0.5001, 0.75]) SAMPLES.push(i * 7 + f);

/** Each rounding of placeFront equals Pixi's for its target, exact halves included. */
async function roundingPairMatchesPixi(mine = placeFrontRounding()) {
  const pixi = await pixiRounding();
  for (const v of SAMPLES) {
    assert.equal(mine.rx(v) + 0, Math.round(pixi.canvas.x(v)) + 0, `x ${v} on the canvas`);
    assert.equal(mine.rx(v) + 0, Math.round(pixi.texture.x(v)) + 0, `x ${v} on a render texture`);
    assert.equal(mine.ryCanvas(v) + 0, Math.round(pixi.canvas.y(v)) + 0, `THE CANVAS ROUNDS Y AS PIXI'S FLIPPED PROJECTION (y ${v})`);
    assert.equal(mine.ryTexture(v) + 0, Math.round(pixi.texture.y(v)) + 0, `A RENDER TEXTURE ROUNDS Y AS PIXI'S UNFLIPPED PROJECTION (y ${v})`);
  }
  // The pair differs exactly at a half (else one rule would do).
  assert.notEqual(mine.ryCanvas(10.5), mine.ryTexture(10.5));
}

test('TES-HULL M2 (Jim NIT 2): placeFront rounds y as Pixi does on each target (canvas ceil(y-.5), render texture floor(y+.5))', () => roundingPairMatchesPixi());

test('mutants: Jim C (the canvas rounded as a render texture) and D (the branches swapped) die', async () => {
  const src = read(path.join(ROOT, 'src/renderer/src/scene/themes/StationFloor.tsx'));
  const from = 'const ry = (y: number) => (root ? Math.ceil(y - 0.5) : Math.floor(y + 0.5));';
  assert.equal(src.split(from).length - 1, 1, 'the mutated line is there once');
  for (const [name, to, dies] of [
    ['C', 'const ry = (y: number) => (root ? Math.floor(y + 0.5) : Math.floor(y + 0.5));', /THE CANVAS ROUNDS Y/],
    ['D', 'const ry = (y: number) => (root ? Math.floor(y + 0.5) : Math.ceil(y - 0.5));', /THE CANVAS ROUNDS Y/],
    ['texture as canvas', 'const ry = (y: number) => (root ? Math.ceil(y - 0.5) : Math.ceil(y - 0.5));', /A RENDER TEXTURE ROUNDS Y/]
  ]) {
    await assert.rejects(roundingPairMatchesPixi(placeFrontRounding(src.replace(from, () => to))), (e) => e instanceof assert.AssertionError && dies.test(e.message), `mutant ${name} dies at its assertion`);
  }
});
