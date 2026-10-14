'use strict';
/**
 * Guppy brand mark — Speck on the brand yellow tile.
 *
 * ICON-SPECK (1.1.86, the Human): the mark is Speck, the TES pack's preset in the
 * Add Agent look builder, in place of Michael. Speck is not drawn here: the pack's
 * own sheet (themes/tes) goes through the app's own path, validateManifest ->
 * pickPreset('speck') -> portraitPlan -> recolorBody, and the portrait crop the
 * builder shows is placed on the tile at an integer, nearest-neighbour scale.
 *
 * THE SVG IS THE SOURCE OF TRUTH. docs/logo.svg is authored here as pure
 * vector — every sprite pixel is a run-merged <rect>, no fonts, no gradients,
 * no filters — so it renders identically in every browser and scales from a
 * 16px favicon to print. Every raster below is generated from the same geometry,
 * never traced back from a PNG.
 *
 * Writes the APP's icons only. The rest of docs/ (logo.svg, logo-light.png,
 * favicon-32.png, apple-touch-icon.png) is upstream's website, so it is left alone.
 *   docs/logo.png          512  — in-app toolbar + app favicon, README header
 *   build/icon.svg         design source for the app icon
 *   build/icon.png        1024  — Linux, and the electron-builder base
 *   build/icon.ico               — Windows, full bleed, 16..256
 *   build/icon.icns              — macOS, drop shadow, 16..1024 (written here,
 *                                 no iconutil, so it builds on any OS)
 *
 *   node tools/make-logo.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Resolve from THIS file, not a hardcoded checkout: the path below pointed at a
// different clone entirely, so running the generator here would have read that
// repo's sprite and written its assets.
const ROOT = path.resolve(__dirname, '..');
const loadTs = require(path.join(ROOT, 'test/load-ts.cjs'));
const manifestTs = loadTs('src/renderer/src/scene/themes/manifest.ts');
const looksTs = loadTs('src/renderer/src/scene/themes/looks.ts');
const recolorTs = loadTs('src/renderer/src/scene/themes/recolor.ts');

const PACK = 'tes';
const PRESET = 'speck';

// ── palette ───────────────────────────────────────────────────────────────
const GROUND = [241, 181, 61];    // #F1B53D — brand yellow, sampled from the shipping icon

// Two border weights, matching the pair the site already ships: near-black for
// dark surfaces, warm brown for the light theme (sampled from logo-light.png).
const BORDERS = { ink: [26, 19, 32], warm: [110, 75, 12] };

// Tile geometry, inherited from the old build/icon.svg so the new mark lands in
// the same family. Ratios are of the TILE, so both framings stay proportional.
const R_RADIUS = 144 / 800;
const R_STROKE = 26 / 800;

// Two framings from one source, used for different things:
//   mark — full bleed. Site, README, favicons, in-app toolbar, Windows .ico.
//          A transparent margin is dead space in every one of those.
//   icon — macOS-style margined tile with a drop shadow, for the .icns.
// Both framings are now FULL BLEED (frame 'icon' only adds the drop shadow).
//
// The margined variant put a band of brand yellow between the tile edge and the
// figure, and that gap is what made the sprite's outermost columns — the far
// edge of the hair (rows 3-11) and the outer shoulder (rows 19-24), with the
// face between them — read as two detached dark tabs rather than as the (then Michael's)
// own silhouette. At Dock size they looked like the edges of other characters.
//
// Full bleed fixes it without touching a single sprite pixel: the figure meets
// the tile, so those columns read as the outline they are. Cropping them off
// instead was tried and was wrong — it cut away real hair and shoulder.
const FRAMES = { mark: 0, icon: 0 };

// ── sprite ────────────────────────────────────────────────────────────────
// PNG in, RGBA out: the pack's sheet is 8-bit RGBA, non-interlaced (asserted).
function decodePng(buf) {
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      if (d[8] !== 8 || d[9] !== 6 || d[12] !== 0) throw new Error('the sheet must be 8-bit RGBA, non-interlaced');
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0, b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? out[(y - 1) * stride + x - 4] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`PNG filter ${f}`);
      out[y * stride + x] = v & 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Speck as the look builder shows him: the TES manifest validated as the app
 * validates it, the preset picked into a draft, the portrait planned (body,
 * colours, front frame, crop) and the body's sheet column recoloured. Returns
 * the cropped portrait, row-major RGBA, cw x ch.
 */
function speckPortrait() {
  const dir = path.join(ROOT, 'themes', PACK);
  const res = manifestTs.validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')), PACK);
  if (!res.manifest) throw new Error('the TES manifest does not validate: ' + JSON.stringify(res.diagnostics));
  const { builder, spriteRenderer: sprite } = res.manifest;
  const sheet = decodePng(fs.readFileSync(path.join(dir, sprite.sheet)));
  const columns = Math.floor(sheet.width / sprite.frameWidth);
  const { draft } = looksTs.pickPreset(builder, columns, looksTs.startDraft(builder, columns), PRESET);
  const plan = looksTs.portraitPlan(PACK, { themeId: PACK, builder, sprite, columns }, { draft, character: PRESET }, { w: 1, h: 1 });
  if (plan.kind !== 'pack') throw new Error('no pack portrait for ' + PRESET);
  const fw = sprite.frameWidth;
  const col = recolorTs.recolorBody(sheet, plan.body, plan.colors, { x0: plan.body.column * fw, fw, fh: sprite.frameHeight }, builder);
  const [cx, cy, cw, ch] = plan.crop;
  const px = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((plan.sy + cy + y) * col.width + (cx + x)) * 4;   // the column is fw wide: x is frame-relative
      px.set(col.data.subarray(i, i + 4), (y * cw + x) * 4);
    }
  }
  return { w: cw, h: ch, px };
}

// Framing lifted from the thumbnail, whose proportions are the ones that work:
// the figure's opaque columns span 58% of the frame, with 5% air above the hair.
// That leaves the brand yellow reading as a field, which matters — at small
// sizes the yellow is recognised before the face is. Speck's crop (ears and
// arms, 18 columns) then fits whole from 32px up; at 16px the integer scale is
// 1 and the tile shows his head.
const R_FIGURE = 140 / 240;
const R_HEADROOM = 12 / 240;

/** Portrait -> a grid of colour|null, one cell per sprite pixel. No contour is drawn. */
function buildGrid({ w, h, px }) {
  const cells = [];
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const i = (gy * w + gx) * 4;
      if (px[i + 3] < 128) continue;
      cells.push({ gx, gy, c: [px[i], px[i + 1], px[i + 2]] });
    }
  }
  const ys = cells.map((c) => c.gy), xs = cells.map((c) => c.gx);
  return {
    gw: w, gh: h, cells,
    x0: Math.min(...xs), x1: Math.max(...xs) + 1,
    y0: Math.min(...ys), y1: Math.max(...ys) + 1
  };
}

/** Place the grid in the tile at an INTEGER scale, bleeding off the bottom. */
function layout(N, grid, frame) {
  const margin = N * FRAMES[frame];
  const tile = { x: margin, y: margin, w: N - 2 * margin, h: N - 2 * margin };
  tile.r = tile.w * R_RADIUS;
  const stroke = tile.w * R_STROKE;
  // Integer scale keeps every sprite pixel square — the whole point of the mark.
  // ROUNDED, not floored: flooring throws away up to a whole pixel of scale,
  // which at 64px is a third of the figure. Overflow is clipped by the tile.
  const scale = Math.max(1, Math.round((tile.w * R_FIGURE) / (grid.x1 - grid.x0)));
  const drawnW = (grid.x1 - grid.x0) * scale;
  return {
    tile, stroke, scale,
    ox: Math.round(tile.x + (tile.w - drawnW) / 2 - grid.x0 * scale),
    oy: Math.round(tile.y + tile.h * R_HEADROOM - grid.y0 * scale)
  };
}

// ── SVG ───────────────────────────────────────────────────────────────────
/** Merge each row's identical-colour runs into one rect — fewer, cleaner nodes. */
function runs(grid) {
  const at = new Map(grid.cells.map((c) => [c.gy * grid.gw + c.gx, c.c]));
  const out = [];
  for (let gy = 0; gy < grid.gh; gy++) {
    let start = null, cur = null;
    const flush = (end) => { if (start !== null) out.push({ gy, gx: start, len: end - start, c: cur }); start = null; };
    for (let gx = 0; gx <= grid.gw; gx++) {
      const c = at.get(gy * grid.gw + gx);
      const key = c ? c.join(',') : null;
      if (key !== (cur ? cur.join(',') : null)) { flush(gx); if (c) { start = gx; cur = c; } else cur = null; }
    }
    flush(grid.gw);
  }
  return out;
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function buildSvg(N, grid, frame, border) {
  const L = layout(N, grid, frame);
  const t = L.tile, s = L.stroke;
  // Stroke straddles the path, so inset by half of it — otherwise the border
  // spills past the tile and gets clipped by the viewBox edge.
  const rx = t.x + s / 2, ry = t.y + s / 2, rw = t.w - s, rh = t.h - s, rr = t.r - s / 2;
  const body = runs(grid).map((r) => {
    const x = L.ox + r.gx * L.scale, y = L.oy + r.gy * L.scale;
    return `    <rect x="${x}" y="${y}" width="${r.len * L.scale}" height="${L.scale}" fill="${hex(r.c)}"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">
  <!-- Guppy — the brand mark, and the source of truth for every raster
       in build/ and docs/. Generated by tools/make-logo.cjs; edit that, not this.
       Pure vector: no fonts, no gradients, no filters. -->
  <title>Guppy</title>
  <defs>
    <clipPath id="tile">
      <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${rr}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#tile)">
    <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${hex(GROUND)}"/>
${body}
  </g>
  <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="${rr}"
        fill="none" stroke="${hex(border)}" stroke-width="${s}" shape-rendering="geometricPrecision"/>
</svg>
`;
}

// ── PNG ───────────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(N, rgba) {
  const stride = N * 4 + 1;
  const raw = Buffer.alloc(N * stride);
  for (let y = 0; y < N; y++) {
    raw[y * stride] = 0;                                       // filter: none
    rgba.copy(raw, y * stride + 1, y * N * 4, (y + 1) * N * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6;                                    // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Signed distance to a rounded rect — negative inside. */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r), qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

const SS = 4;   // 4x4 supersampling — smooth tile edge, hard pixel-art edges

/**
 * The tile is an analytic rounded rect, so its drop shadow is the SAME shape
 * offset down — no convolution needed, just a soft falloff on the distance
 * field. Exact at any size and effectively free.
 */
function rasterise(N, grid, frame, border) {
  const L = layout(N, grid, frame);
  const t = L.tile, s = L.stroke;
  const rx = t.x + s / 2, ry = t.y + s / 2, rw = t.w - s, rh = t.h - s, rr = t.r - s / 2;
  const shadow = frame === 'icon' ? { dy: N * 0.020, blur: N * 0.030, a: 0.30 } : null;

  const at = new Map(grid.cells.map((c) => [c.gy * grid.gw + c.gx, c.c]));
  const spriteAt = (px, py) => {
    const gx = Math.floor((px - L.ox) / L.scale), gy = Math.floor((py - L.oy) / L.scale);
    // Bounded: a cell key is gy * gw + gx, so an x past the grid would wrap into the next row.
    if (gx < 0 || gx >= grid.gw || gy < 0 || gy >= grid.gh) return null;
    return at.get(gy * grid.gw + gx) ?? null;
  };

  const out = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let cov = 0, ink = 0, rSum = 0, gSum = 0, bSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          const d = sdRoundRect(px, py, rx, ry, rw, rh, rr);
          if (d > s / 2) continue;                    // outside the stroke entirely
          cov++;
          if (d > -s / 2) { ink++; continue; }        // within the border band
          const c = spriteAt(px, py) ?? GROUND;
          rSum += c[0]; gSum += c[1]; bSum += c[2];
        }
      }
      const tileA = cov / (SS * SS);

      let sa = 0;
      if (shadow) {
        const d = sdRoundRect(x + 0.5, y + 0.5 - shadow.dy, rx, ry, rw, rh, rr) - s / 2;
        sa = Math.min(1, Math.max(0, 0.5 - d / shadow.blur)) * shadow.a;
      }
      if (!tileA && !sa) continue;

      // Tile over shadow, straight (un-premultiplied) output.
      const outA = tileA + sa * (1 - tileA);
      const wT = tileA / outA, wS = 1 - wT;          // shadow colour is pure black
      const i = (y * N + x) * 4;
      if (cov) {
        out[i] = Math.round(((rSum + ink * border[0]) / cov) * wT);
        out[i + 1] = Math.round(((gSum + ink * border[1]) / cov) * wT);
        out[i + 2] = Math.round(((bSum + ink * border[2]) / cov) * wT);
      }
      void wS;                                        // black contributes nothing
      out[i + 3] = Math.round(outA * 255);
    }
  }
  return encodePng(N, out);
}

// ── ICO ───────────────────────────────────────────────────────────────────
/** ICO container of PNG entries (Vista+). 256px is encoded as width byte 0. */
function buildIco(pngs) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = [], bodies = [];
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); bodies.push(data);
    offset += data.length;
  }
  return Buffer.concat([dir, ...entries, ...bodies]);
}

// ── ICNS ──────────────────────────────────────────────────────────────────
/** icns ARGB: 'ARGB', then the A, R, G and B planes, each run-length coded
 *  (byte n < 128: n + 1 literal bytes; n >= 128: the next byte n - 125 times). */
function icnsRle(plane) {
  const out = [];
  for (let i = 0; i < plane.length;) {
    let run = 1;
    while (i + run < plane.length && plane[i + run] === plane[i] && run < 130) run++;
    if (run >= 3) { out.push(run + 125, plane[i]); i += run; continue; }
    let j = i, lit = [];
    while (j < plane.length && lit.length < 128) {
      if (j + 2 < plane.length && plane[j] === plane[j + 1] && plane[j] === plane[j + 2]) break;
      lit.push(plane[j++]);
    }
    out.push(lit.length - 1, ...lit); i = j;
  }
  return Buffer.from(out);
}

function icnsArgb(png) {
  const { width: n, data } = decodePng(png);
  const planes = [3, 0, 1, 2].map((c) => { const p = new Uint8Array(n * n); for (let k = 0; k < n * n; k++) p[k] = data[k * 4 + c]; return icnsRle(p); });
  return Buffer.concat([Buffer.from('ARGB', 'ascii'), ...planes]);
}

/** The .icns the previous iconutil build carried, type for type (16 and 32 as ARGB, the rest PNG). */
function buildIcns(png) {
  const entries = [
    ['ic12', png(64)], ['ic07', png(128)], ['ic13', png(256)], ['ic08', png(256)], ['ic04', icnsArgb(png(16))],
    ['ic14', png(512)], ['ic09', png(512)], ['ic05', icnsArgb(png(32))], ['ic10', png(1024)], ['ic11', png(32)]
  ].map(([type, data]) => {
    const head = Buffer.alloc(8); head.write(type, 0, 'ascii'); head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8); head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

// ── run ───────────────────────────────────────────────────────────────────
const grid = buildGrid(speckPortrait());
const D = (p) => path.join(ROOT, p);
const wrote = [];
const write = (rel, buf) => {
  fs.writeFileSync(D(rel), buf);
  wrote.push(`${rel.padEnd(28)} ${(buf.length / 1024).toFixed(1)} KB`);
};

// The in-app and README mark (full bleed).
write('docs/logo.png', rasterise(512, grid, 'mark', BORDERS.ink));

// App icons.
write('build/icon.svg', Buffer.from(buildSvg(1024, grid, 'icon', BORDERS.ink)));
write('build/icon.png', rasterise(1024, grid, 'icon', BORDERS.ink));
write('build/icon.ico', buildIco([16, 32, 48, 64, 128, 256].map((size) => ({
  size, data: rasterise(size, grid, 'mark', BORDERS.ink)
}))));
const icnsPng = new Map();
write('build/icon.icns', buildIcns((size) => {
  if (!icnsPng.has(size)) icnsPng.set(size, rasterise(size, grid, 'icon', BORDERS.ink));
  return icnsPng.get(size);
}));

console.log(wrote.join('\n'));
