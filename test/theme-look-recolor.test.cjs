'use strict';

// Theme looks, part 1: recolouring a pack body (skin, shirt, hair) from the
// manifest's part colours, on the neutral fixture's sheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const R = loadTs('src/renderer/src/scene/themes/recolor.ts');
const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');

const manifest = Mf.validateManifest(JSON.parse(H.readPackDir(H.NEUTRAL)['theme.json'])).manifest;
const B = manifest.builder;
const sheet = H.decodePng(fs.readFileSync(path.join(H.NEUTRAL, 'pictures/sheet.png')));
const [light, dark] = B.bodies;
const region = (body) => ({ x0: body.column * 32, fw: 32, fh: 32 });
const at = (px, w, x, y) => { const i = (y * w + x) * 4; return R.rgbHex([px[i], px[i + 1], px[i + 2]]); };
const lumOf = (hex) => { const [r, g, b] = R.hexRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

test('the original colours leave the body exactly as drawn', () => {
  const out = R.recolorBody(sheet, light, R.originalColors(light), region(light), B);
  for (let y = 0; y < sheet.height; y++) for (let x = 0; x < 32; x++)
    assert.equal(at(out.data, 32, x, y), at(sheet.data, sheet.width, x, y), `pixel ${x},${y}`);
});

test('a chosen colour replaces its part only, and keeps the shading', () => {
  const out = R.recolorBody(sheet, light, { skin: '#7b4d34', shirt: '#c0302c', hair: '#ececec' }, region(light), B);
  const w = 32, x0 = 10;
  assert.equal(at(out.data, w, x0 + 5, 9), '#7b4d34', 'main skin becomes the choice');
  assert.equal(at(out.data, w, x0 + 5, 18), '#c0302c', 'shirt');
  const shadow = at(out.data, w, x0 + 5, 13);
  assert.notEqual(shadow, '#e86a73', 'the skin shadow is recoloured too');
  assert.ok(lumOf(shadow) < lumOf('#7b4d34'), 'and stays darker than the new skin');
  // untouched: outline, eyes, trousers
  assert.equal(at(out.data, w, x0, 20), '#242234');
  assert.equal(at(out.data, w, x0 + 3, 10), '#ffffff');
  assert.equal(at(out.data, w, x0 + 5, 28), '#333941');
  // near-white hair keeps a highlight lighter than its main shade
  const main = at(out.data, w, x0 + 1, 7), hi = at(out.data, w, x0 + 4, 5);
  assert.ok(lumOf(hi) > lumOf(main), `hair highlight ${hi} above ${main}`);
});

test('hair drawn in the outline colour is found by shape: inner pixels only, never the brow by an eye', () => {
  const mask = R.partMask(sheet, dark, region(dark), B);
  const x0 = 32 + 10, W = sheet.width, m = (x, y) => mask[y * W + x];
  assert.equal(m(x0 + 5, 5), 2, 'inside the hair block');
  assert.equal(m(x0 + 5, 4), 0, 'the top edge is outline, not hair');
  assert.equal(m(x0, 6), 0, 'the side edge is outline');
  assert.equal(m(x0 + 3, 9), 0, 'the brow beside an eye stays');
  assert.equal(m(x0, 20), 0, 'the body outline stays');
  assert.equal(m(x0 + 5, 9), 1, 'skin');
  assert.equal(m(x0 + 5, 18), 3, 'shirt');
  const out = R.recolorBody(sheet, dark, { hair: '#e3c070' }, region(dark), B);
  assert.equal(at(out.data, 32, 10 + 5, 5), '#e3c070');
  assert.equal(at(out.data, 32, 10 + 3, 9), '#242234');
  // every frame of the column is recoloured, not only the first
  assert.equal(at(out.data, 32, 10 + 5, 7 * 32 + 5), '#e3c070');
});

test('only the body column is read: the other body never leaks in', () => {
  const out = R.recolorBody(sheet, light, { shirt: '#a07a1c' }, region(light), B);
  assert.equal(out.width, 32);
  assert.equal(at(out.data, 32, 10 + 5, 6), '#71413b', 'light body hair, not the dark one');
});

test('a dark skin choice keeps its shadow off the outline (the face stays readable)', () => {
  // the deep swatch: the shadow is lifted to the 1.45 contrast floor (measured 1.457)
  const ramp = R.ramp(light.parts.skin, '#7b4d34', B.outline);
  const shadow = ramp.get('#e86a73');
  assert.ok(shadow, 'shadow mapped');
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  assert.ok((L(shadow) + 0.05) / (L(R.hexRgb(B.outline)) + 0.05) >= 1.44);
});

test('colour helpers reject what is not a colour', () => {
  assert.equal(R.normColour('#ABCDEF'), '#abcdef');
  assert.equal(R.normColour('#abc'), '#aabbcc');
  assert.equal(R.normColour('red'), null);
  assert.equal(R.normColour(5), null);
});

test('ramp golden vectors (the viewer oracle crew-colors.js gives the same, checked when written)', () => {
  const SKIN = { main: '#fad6b8', shades: ['#fad6b8', '#f5a097', '#e86a73'] };
  const BROWN = { main: '#71413b', shades: ['#71413b', '#bb7547'] };
  const BLACK = { main: '#242234', shades: ['#242234'], byShape: true };
  const golden = [
    [SKIN, '#7b4d34', { '#fad6b8': '#7b4d34', '#f5a097': '#713232', '#e86a73': '#612f38' }], // the 0.6 step floor
    [SKIN, '#8fbf6a', { '#fad6b8': '#8fbf6a', '#f5a097': '#a2b55a', '#e86a73': '#989b4d' }], // hue offset kept
    [SKIN, '#fbe3d3', { '#fad6b8': '#fbe3d3', '#f5a097': '#f6b3b0', '#e86a73': '#e97f8c' }],
    [SKIN, '#1f1d1d', { '#fad6b8': '#1f1d1d', '#f5a097': '#191718', '#e86a73': '#0f0e0f' }],
    [BROWN, '#ececec', { '#71413b': '#d7d7d7', '#bb7547': '#ececec' }], // near-white: the choice becomes the highlight
    [BROWN, '#e3c070', { '#71413b': '#e3c070', '#bb7547': '#fefc80' }],
    [BROWN, '#1f1d1d', { '#71413b': '#1f1d1d', '#bb7547': '#5c5553' }],
    [BLACK, '#1f1d1d', { '#242234': '#1f1d1d' }],
    [BLACK, '#ececec', { '#242234': '#ececec' }],
  ];
  for (const [part, chosen, want] of golden) {
    const got = Object.fromEntries([...R.ramp(part, chosen, '#242234')].map(([k, v]) => [k, R.rgbHex(v)]));
    assert.deepEqual(got, want, chosen);
  }
});

test('hair by shape stops at an eye: an outline pixel joined to the hair but beside an eye is not hair', () => {
  const img = { width: sheet.width, height: sheet.height, data: Uint8ClampedArray.from(sheet.data) };
  const W = img.width, x0 = 32 + 10, put = (x, y, hex) => { const [r, g, b] = R.hexRgb(hex), i = (y * W + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255; };
  put(x0 + 6, 8, '#242234'); // joined to the hair block above
  put(x0 + 6, 9, '#ffffff'); // an eye right below it
  const mask = R.partMask(img, dark, region(dark), B);
  assert.equal(mask[7 * W + x0 + 6], 2, 'the hair above stays hair');
  assert.equal(mask[8 * W + x0 + 6], 0, 'the pixel beside the eye is not hair');
  put(x0 + 6, 9, '#fad6b8'); // no eye: the same pixel is hair
  assert.equal(R.partMask(img, dark, region(dark), B)[8 * W + x0 + 6], 2);
});
