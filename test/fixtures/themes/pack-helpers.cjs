'use strict';

// Test helpers for theme packs: read a pack folder into a PackFiles, decode its
// PNGs into a PixelStore (8-bit RGBA/RGB PNGs, every filter type).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType})`);
  const bpp = colorType === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = px[i * bpp + k]; data[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255; }
  return { width: w, height: h, data };
}

/** Every file under `root`, as pack-relative paths -> text (null for pictures). */
function readPackDir(root) {
  const out = {};
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else { const rel = path.relative(root, p).split(path.sep).join('/'); out[rel] = /\.png$/i.test(f) ? null : fs.readFileSync(p, 'utf8'); }
    }
  })(root);
  return out;
}

/** Decode the pack's pictures by normalized path (as the map model names them). */
function decodeImages(root, normPath, wanted) {
  const store = new Map();
  const all = Object.keys(readPackDir(root));
  for (const want of wanted) {
    const hit = all.find((f) => normPath(f) === want);
    if (hit) store.set(want, decodePng(fs.readFileSync(path.join(root, hit))));
  }
  return store;
}

module.exports = { decodePng, readPackDir, decodeImages, NEUTRAL: path.join(__dirname, 'neutral-deck') };
