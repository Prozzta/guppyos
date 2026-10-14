// The stations floor's layers, cut into small tiles with the fully transparent
// ones dropped, and packed into atlas pages at load (TES-GUPPY-RASTER).
//
// Drawn whole, TES filled the map-sized 'below' and 'above' pictures (the TES
// 'above' has no visible pixel at all) and 187 statics whose boxes cover
// 1.27 M px for 28 k visible ones, every frame: about twice the office's raster
// cost per frame under the harness's software GL. A fully transparent pixel
// changes nothing under Pixi's blending, so leaving its tile out draws the same
// picture; the live tiles share a few textures, so they also batch.
//
// Each tile carries a 1 px border of the picture's own neighbouring pixels
// (clamped at the picture's edge, as a texture of its own would be), so nearest
// sampling at a tile's rim reads what the whole picture would have.

import { blank, type Pixels } from './raster';

/** One live tile: (x, y, w, h) in the picture, at (ax, ay) on atlas page `page`. */
export interface AtlasPiece { page: number; ax: number; ay: number; x: number; y: number; w: number; h: number }
export interface Atlas { pages: Pixels[]; pieces: AtlasPiece[][]; unpacked: boolean[] }

export const ATLAS_TILE = 8;
export const ATLAS_PAD = 1;

/** The tiles of `px` that hold at least one pixel with alpha above 0. */
export function liveTiles(px: Pixels, tile = ATLAS_TILE): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let ty = 0; ty < px.height; ty += tile) {
    for (let tx = 0; tx < px.width; tx += tile) {
      const w = Math.min(tile, px.width - tx), h = Math.min(tile, px.height - ty);
      let live = false;
      for (let y = ty; y < ty + h && !live; y++) {
        for (let x = tx; x < tx + w; x++) if (px.data[(y * px.width + x) * 4 + 3] !== 0) { live = true; break; }
      }
      if (live) out.push({ x: tx, y: ty, w, h });
    }
  }
  return out;
}

/** Tile every picture and shelf-pack the live tiles into pages of at most
 *  `maxSize` square. A picture whose tiles do not all fit is marked `unpacked`
 *  (no pieces): the caller draws it whole, as before. A null picture has none. */
export function tileAtlas(images: Array<Pixels | null | undefined>, maxSize: number, tile = ATLAS_TILE): Atlas {
  const P = ATLAS_PAD, cell = tile + 2 * P;
  const pieces: AtlasPiece[][] = images.map(() => []);
  const unpacked = images.map(() => false);
  const perPage = Math.floor(maxSize / cell) ** 2;
  const total = images.reduce((n, im) => n + (im ? liveTiles(im, tile).length : 0), 0);
  if (perPage < 1) return { pages: [], pieces, unpacked: images.map((im) => !!im) };

  // Every tile takes one cell of a square grid; pages are as small as their cells need.
  const cols = Math.min(Math.floor(maxSize / cell), Math.max(1, Math.ceil(Math.sqrt(total))));
  const pages: Pixels[] = [];
  let n = 0;
  images.forEach((im, i) => {
    if (!im) return;
    for (const t of liveTiles(im, tile)) {
      const page = Math.floor(n / perPage), k = n % perPage;
      if (page === pages.length) {
        const left = Math.min(perPage, total - n), rows = Math.ceil(left / cols);
        pages.push(blank(Math.min(left, cols) * cell, rows * cell));
      }
      const ax = (k % cols) * cell + P, ay = Math.floor(k / cols) * cell + P;
      blitBordered(pages[page], im, t, ax, ay);
      pieces[i].push({ page, ax, ay, ...t });
      n += 1;
    }
  });
  return { pages, pieces, unpacked };
}

/** Copy the box `t` of `src` to (ax, ay) of `dst`, with a 1 px ring of `src`'s own
 *  neighbouring pixels around it (clamped at `src`'s edge). */
function blitBordered(dst: Pixels, src: Pixels, t: { x: number; y: number; w: number; h: number }, ax: number, ay: number): void {
  const P = ATLAS_PAD, W = src.width, H = src.height;
  for (let y = -P; y < t.h + P; y++) {
    const sy = Math.min(H - 1, Math.max(0, t.y + y));
    for (let x = -P; x < t.w + P; x++) {
      const sx = Math.min(W - 1, Math.max(0, t.x + x));
      const si = (sy * W + sx) * 4, di = ((ay + y) * dst.width + ax + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}
