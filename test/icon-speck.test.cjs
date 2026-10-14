'use strict';

// ICON-SPECK: the app icon is Speck, the TES pack's look-builder preset, in place of
// Michael. tools/make-logo.cjs renders him through the app's own path (manifest ->
// preset -> portrait plan -> recolour) and writes every app icon file under the same
// names. docs/ is upstream's website: the generator never writes there, and the app's
// brand logo (@brand) is a fork-owned file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

/** Size, and the set of opaque colours, of an 8-bit RGBA PNG (filter-aware). */
function pngInfo(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert.deepEqual([buf[24], buf[25]], [8, 6], '8-bit RGBA');
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 255) colours.add('#' + px.subarray(i, i + 3).toString('hex'));
  return { w, h, colours, px };
}

test('the generator renders the Speck preset through the app\'s own look path, and draws nothing', () => {
  const src = read('tools/make-logo.cjs').toString('utf8');
  assert.match(src, /const PACK = 'tes';\r?\nconst PRESET = 'speck';/);
  for (const call of ['manifestTs.validateManifest(', 'looksTs.pickPreset(builder, columns, looksTs.startDraft(builder, columns), PRESET)',
    'looksTs.portraitPlan(PACK,', 'recolorTs.recolorBody(sheet, plan.body, plan.colors,']) assert.ok(src.includes(call), call);
  assert.doesNotMatch(src, /sceneFrameBufs|centreEyes|portraitArt|child_process|execFileSync/, 'no Michael sprite, no pixel edits, no macOS-only tool');
  // Integer scale: whole sprite pixels stay square.
  assert.match(src, /const scale = Math\.max\(1, Math\.round\(/);
  // Only the app's icon files are written.
  const writes = [...src.matchAll(/(?<![.\w])write\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(writes, ['.github/media/guppy-logo.png', 'build/icon.icns', 'build/icon.ico', 'build/icon.png', 'build/icon.svg', 'src/renderer/src/assets/brand/logo.png']);
  assert.doesNotMatch(src, /write\('docs\//, 'docs/ is upstream\'s website');
});

test('every app icon file keeps its name, format and sizes, and shows Speck\'s preset colours', () => {
  const speck = ['#fbe3d3', '#285cc4', '#1f1d1d'];   // themes/tes/theme.json preset "speck"
  const png = pngInfo(read('build/icon.png'));
  assert.deepEqual([png.w, png.h], [1024, 1024]);
  for (const c of speck) assert.ok(png.colours.has(c), `build/icon.png has ${c}`);
  const logo = pngInfo(read('src/renderer/src/assets/brand/logo.png'));
  assert.deepEqual([logo.w, logo.h], [512, 512]);
  for (const c of speck) assert.ok(logo.colours.has(c), `brand logo.png has ${c}`);
  assert.ok(read('.github/media/guppy-logo.png').equals(read('src/renderer/src/assets/brand/logo.png')), 'the README copy is the same mark');

  const ico = read('build/icon.ico');
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const o = 6 + 16 * i, off = ico.readUInt32LE(o + 12), body = ico.subarray(off, off + ico.readUInt32LE(o + 8));
    sizes.push(pngInfo(body).w);
    assert.equal(ico[o] || 256, sizes[i]);
  }
  assert.deepEqual(sizes, [16, 32, 48, 64, 128, 256]);

  const icns = read('build/icon.icns');
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = {};
  for (let o = 8; o < icns.length;) {
    const t = icns.toString('ascii', o + 0, o + 4), l = icns.readUInt32BE(o + 4), d = icns.subarray(o + 8, o + l);
    types[t] = d.toString('ascii', 0, 4) === 'ARGB' ? 'ARGB' : pngInfo(d).w;
    o += l;
  }
  assert.deepEqual(types, { ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic04: 'ARGB', ic14: 512, ic09: 512, ic05: 'ARGB', ic10: 1024, ic11: 32 });

  // electron-builder still finds them where it always did.
  const eb = read('electron-builder.yml').toString('utf8');
  for (const f of ['build/icon.icns', 'build/icon.ico', 'build/icon.png']) assert.ok(eb.includes(`icon: ${f}`), f);
});

/** Speck's portrait as the app paints it (SpritePortrait / paintPackPortrait): the TES manifest
 *  validated, the 'speck' preset picked, the portrait planned and the body column recoloured. Built
 *  here independently of the generator. Cells: the crop's pixels with alpha >= 128, RGB. */
function appPortrait() {
  const M = loadTs('src/renderer/src/scene/themes/manifest.ts');
  const L = loadTs('src/renderer/src/scene/themes/looks.ts');
  const Rc = loadTs('src/renderer/src/scene/themes/recolor.ts');
  const dir = path.join(ROOT, 'themes', 'tes');
  const { manifest } = M.validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')), 'tes');
  const { builder, spriteRenderer: sprite } = manifest;
  const sheetPng = fs.readFileSync(path.join(dir, sprite.sheet));
  const s = pngInfo(sheetPng);
  const sheet = { width: s.w, height: s.h, data: s.px };
  const columns = Math.floor(sheet.width / sprite.frameWidth);
  const { draft } = L.pickPreset(builder, columns, L.startDraft(builder, columns), 'speck');
  const plan = L.portraitPlan('tes', { themeId: 'tes', builder, sprite, columns }, { draft, character: 'speck' }, { w: 18, h: 28 });
  assert.equal(plan.kind, 'pack');
  const fw = sprite.frameWidth;
  const col = Rc.recolorBody(sheet, plan.body, plan.colors, { x0: plan.body.column * fw, fw, fh: sprite.frameHeight }, builder);
  const [cx, cy, cw, ch] = plan.crop;
  const cells = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((plan.sy + cy + y) * col.width + cx + x) * 4;
    if (col.data[i + 3] >= 128) cells.push({ x, y, c: [col.data[i], col.data[i + 1], col.data[i + 2]] });
  }
  return { w: cw, h: ch, cells };
}

test("icon.png 1024 and ico 32 hold the app's Speck pixel for pixel, and no sprite pixel anywhere else", () => {
  const p = appPortrait();
  assert.equal(p.cells.length, 392);
  const ico = read('build/icon.ico');
  let ico32;
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const o = 6 + 16 * i, off = ico.readUInt32LE(o + 12);
    if (ico[o] === 32) ico32 = pngInfo(ico.subarray(off, off + ico.readUInt32LE(o + 8)));
  }
  const palette = new Set(p.cells.map((c) => c.c.join(',')));
  palette.delete('241,181,61'); palette.delete('26,19,32');   // the tile's ground and ink, if a sprite shared them
  // Scale and origin: the generator's layout (an integer scale; centred, with headroom).
  for (const [name, img, s, ox, oy] of [['build/icon.png', pngInfo(read('build/icon.png')), 33, 215, 51], ['ico 32', ico32, 1, 7, 2]]) {
    const inBlock = new Uint8Array(img.w * img.h);
    for (const c of p.cells) {
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
        const x = ox + c.x * s + dx, y = oy + c.y * s + dy, i = (y * img.w + x) * 4;
        inBlock[y * img.w + x] = 1;
        assert.deepEqual([...img.px.subarray(i, i + 4)], [...c.c, 255], `${name}: cell ${c.x},${c.y} at ${x},${y}`);
      }
    }
    // Nothing of the sprite outside its own blocks (no wrapped columns, no stray pixels).
    for (let j = 0; j < img.w * img.h; j++) {
      if (inBlock[j] || img.px[j * 4 + 3] !== 255) continue;
      const rgb = [img.px[j * 4], img.px[j * 4 + 1], img.px[j * 4 + 2]].join(',');
      assert.ok(!palette.has(rgb), `${name}: a sprite colour ${rgb} outside the portrait at ${j % img.w},${Math.floor(j / img.w)}`);
    }
  }
});

test("the app's brand logo is fork-owned; docs/ is upstream's and untouched", () => {
  for (const f of ['electron.vite.config.ts', 'tsconfig.web.json', 'test/electron-harness/harness-main.cjs']) {
    const src = read(f).toString('utf8');
    assert.match(src, /src\/renderer\/src\/assets\/brand|'src', 'renderer', 'src', 'assets', 'brand'/, f);
    assert.doesNotMatch(src, /@brand['"]?:\s*\[?\s*(resolve\(__dirname, )?['"]docs|res\(root, 'docs'/, f);
  }
  for (const f of ['src/renderer/src/App.tsx', 'src/renderer/src/main.tsx']) assert.match(read(f).toString('utf8'), /from '@brand\/logo\.png\?url'/, f);
});
