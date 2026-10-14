'use strict';

// Theme packs, part 1: the XML reader, the TMX/TSX/TMJ normalizer and the
// pixel rasterizer, on the neutral fixture pack (test/fixtures/themes).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const X = loadTs('src/renderer/src/scene/themes/xml.ts');
const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const R = loadTs('src/renderer/src/scene/themes/raster.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');

const neutral = () => H.readPackDir(H.NEUTRAL);
const parse = (entries, path) => { const d = []; const M = T.parseMap(P.memoryFiles(entries), path, d); return { M, d }; };

test('xml: elements, attributes, entities, CDATA and comments', () => {
  const el = X.parseXml('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'&#65;\'><b/><c><![CDATA[<raw>]]></c></a>');
  assert.equal(el.tag, 'a');
  assert.equal(el.attrs.x, '1 & 2');
  assert.equal(el.attrs.y, 'A');
  assert.deepEqual(el.children.map((c) => c.tag), ['b', 'c']);
  assert.equal(X.childOf(el, 'c').text, '<raw>');
});

test('xml: malformed documents throw (mismatched, unclosed, two roots)', () => {
  assert.throws(() => X.parseXml('<a><b></a>'));
  assert.throws(() => X.parseXml('<a>'));
  assert.throws(() => X.parseXml('<a/><b/>'));
  assert.throws(() => X.parseXml('<a x=1/>'));
});

test('TMX with external TSX: tilesets, first gids, native tile size, ordered layers', () => {
  const { M, d } = parse(neutral(), 'deck.tmx');
  assert.deepEqual(d.map((x) => x.level), ['info']); // only the missing tracing image (never drawn)
  assert.equal(M.width, 12); assert.equal(M.height, 10); assert.equal(M.tw, 16); assert.equal(M.th, 16);
  assert.deepEqual(M.tilesets.map((t) => [t.firstgid, t.name, t.tw, t.th, t.columns]), [[1, 'tiles', 16, 16, 4], [9, 'props', 16, 16, 0]]);
  assert.deepEqual(M.layers.map((l) => [l.kind, l.name]), [
    ['image', 'reference'], ['tile', 'Floor'], ['tile', 'Walls'], ['tile', 'Rail'],
    ['object', 'collision-shapes'], ['object', 'Props'], ['object', 'Stations'], ['object', 'Mugs'],
  ]);
  // the tiles atlas resolves next to its TSX; the props TSX was referenced by an absolute
  // path on another machine and resolves by its file name; its tile picture by its own path
  assert.equal(M.tilesets[0].image.path, 'tiles/tiles.png');
  assert.equal(M.tilesets[1].tiles.get(0).image.path, 'pictures/chair.png');
  const chair = T.tileFor(M, 9);
  assert.equal(chair.image.path, 'pictures/chair.png');
  assert.deepEqual([chair.sw, chair.sh], [16, 16]);
  const rail = T.tileFor(M, 3);
  assert.deepEqual([rail.ts.name, rail.sx, rail.sy], ['tiles', 32, 0]);
});

test('flip bits survive normalization and drive the rasterizer', () => {
  const { M } = parse(neutral(), 'deck.tmx');
  const floor = M.layers.find((l) => l.name === 'Floor');
  const raw = floor.data[9 * 12 + 0];
  assert.equal(raw & T.GID_MASK, 5);
  const t = T.tileFor(M, raw);
  assert.deepEqual([t.h, t.v, t.d], [true, false, false]);
  const store = H.decodeImages(H.NEUTRAL, T.normPath, ['tiles/tiles.png']);
  const px = R.blank(16, 16);
  R.drawTile(px, store, t, 0, 0, 16, 16, 1);
  const at = (x, y) => Array.from(px.data.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 3));
  // the marker is red | blue; flipped horizontally it is blue | red
  assert.deepEqual(at(2, 8), [40, 40, 220]);
  assert.deepEqual(at(13, 8), [220, 40, 40]);
  const plain = R.blank(16, 16);
  R.drawTile(plain, store, T.tileFor(M, 5), 0, 0, 16, 16, 1);
  assert.deepEqual(Array.from(plain.data.slice((8 * 16 + 2) * 4, (8 * 16 + 2) * 4 + 3)), [220, 40, 40]);
  // D (anti-diagonal) transposes: the left/right halves become top/bottom
  const dpx = R.blank(16, 16);
  R.drawTile(dpx, store, T.tileFor(M, (5 | T.FLIP_D) >>> 0), 0, 0, 16, 16, 1);
  assert.deepEqual(Array.from(dpx.data.slice((2 * 16 + 8) * 4, (2 * 16 + 8) * 4 + 3)), [220, 40, 40]);
  assert.deepEqual(Array.from(dpx.data.slice((13 * 16 + 8) * 4, (13 * 16 + 8) * 4 + 3)), [40, 40, 220]);
});

test('TMJ and TMX normalize to the same model', () => {
  const a = parse(neutral(), 'deck.tmx').M, b = parse(neutral(), 'deck.tmj').M;
  const shape = (M) => ({
    size: [M.width, M.height, M.tw, M.th],
    tilesets: M.tilesets.map((t) => [t.firstgid, t.name, t.tw, t.th, t.image && t.image.path, [...t.tiles.values()].map((x) => x.image && x.image.path)]),
    layers: M.layers.map((l) => l.kind === 'tile' ? [l.name, l.visible, l.data.join(',')]
      : l.kind === 'object' ? [l.name, l.visible, l.objects.map((o) => [o.name, o.gid, o.x, o.y, o.width, o.height, o.shape, JSON.stringify(o.points), JSON.stringify(o.props)])]
        : [l.name, l.kind]),
  });
  assert.deepEqual(shape(b), shape(a));
});

test('source-independent asset paths: a pack moved anywhere reads the same', () => {
  const moved = {};
  for (const [k, v] of Object.entries(neutral())) moved[k] = v;
  const { M } = parse(moved, 'DECK.TMX'); // case-insensitive pack paths
  assert.equal(M.tilesets[0].image.path, 'tiles/tiles.png');
});

test('malformed maps: diagnostics or a throw that the pack loader turns into a diagnostic', () => {
  const e = neutral();
  e['deck.tmx'] = e['deck.tmx'].replace('</map>', '');
  const r = P.readPack(P.memoryFiles(e));
  assert.equal(r.value, null);
  assert.ok(r.diagnostics.some((d) => d.level === 'error' && /cannot be read/.test(d.message)), JSON.stringify(r.diagnostics));
  const z = neutral();
  z['deck.tmx'] = z['deck.tmx'].replace('<data encoding="csv">', '<data encoding="base64" compression="zlib">');
  const rz = P.readPack(P.memoryFiles(z));
  assert.equal(rz.value, null);
  assert.ok(rz.diagnostics.some((d) => /compression/.test(d.message)));
  const iso = neutral();
  iso['deck.tmx'] = iso['deck.tmx'].replace('orientation="orthogonal"', 'orientation="isometric"');
  assert.ok(P.readPack(P.memoryFiles(iso)).diagnostics.some((d) => d.level === 'error' && /isometric/.test(d.message)));
});

test('base64 tile data decodes like CSV', () => {
  const e = neutral();
  const { M } = parse(e, 'deck.tmx');
  const walls = M.layers.find((l) => l.name === 'Walls').data;
  const buf = Buffer.alloc(walls.length * 4);
  walls.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4));
  const csvBlock = /(<layer id="2" name="Walls"[^>]*>\s*<data encoding=")csv(">)[^<]*(<\/data>)/;
  assert.ok(csvBlock.test(e['deck.tmx']));
  e['deck.tmx'] = e['deck.tmx'].replace(csvBlock, `$1base64$2${buf.toString('base64')}$3`);
  const again = parse(e, 'deck.tmx').M.layers.find((l) => l.name === 'Walls').data;
  assert.deepEqual(again, walls);
});
