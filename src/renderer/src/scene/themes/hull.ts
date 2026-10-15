// TES-FLOOR-WHOLE-188: the hull continued below a framed pack's art, made from the art itself.
// Seen from above and in front, a ship's hull below its deck is a vertical prism: down each pixel
// column it is one colour (a panel, or the dark line of a seam or an edge) until the column's
// bottom outline, a 1-2 px dark line with nothing below it. Lengthening the prism moves every
// bottom outline down; lengthened past the pane's bottom edge, each column simply keeps its
// colour. So the continuation is, per column: from the outline down, the colour above it (a
// column of one colour throughout, a seam or an edge, keeps that colour). The floor draws it once,
// as a cover over the art's outline rows and a one-row strip stretched below the art: no
// per-frame work, and the pane never shows a band above or below the ship.
//
// Pure: StationFloor draws it, test/tes-floor-whole-188 checks it against the pack.

import { blank, type Pixels } from './raster';

/** How far below the art the strip runs, in map px: past the bottom of any pane. */
export const HULL_STRIP_ROWS = 4096;

/** The longest bottom outline, in px, read as an outline (longer runs are a seam or an edge). */
export const HULL_OUTLINE_MAX = 3;

export interface HullSkirt {
  /** The map px of the cover's top-left: the art's left column and its first lengthened row. */
  x: number;
  y: number;
  /** The cover: per column, from where the outline began down to the art's bottom row, the
   *  column's colour (transparent above, and in columns the art does not reach). */
  cover: Pixels;
  /** One row: each column's colour, stretched below the art's bottom row. */
  strip: Pixels;
}

/** The hull continuation of `art` (composited map px) for the art's columns x0..x1, whose bottom
 *  row is y1. Null when no column of the art reaches down to it. */
export function hullSkirt(art: Pixels, x0: number, x1: number, y1: number): HullSkirt | null {
  const w = x1 - x0 + 1;
  const px = (x: number, y: number) => (y * art.width + x) * 4;
  const same = (a: number, b: number) => art.data[a] === art.data[b] && art.data[a + 1] === art.data[b + 1]
    && art.data[a + 2] === art.data[b + 2] && art.data[a + 3] === art.data[b + 3];
  const cols: Array<{ from: number; at: number } | null> = [];
  let top = Infinity;
  for (let x = x0; x <= x1; x++) {
    let L = -1;
    for (let y = Math.min(y1, art.height - 1); y >= 0; y--) if (art.data[px(x, y) + 3] !== 0) { L = y; break; }
    if (L < 0) { cols.push(null); continue; }
    let j = 1;
    while (j <= HULL_OUTLINE_MAX && L - j >= 0 && same(px(x, L - j), px(x, L))) j++;
    const col = j <= HULL_OUTLINE_MAX ? { from: L - j + 1, at: px(x, L - j) } : { from: L + 1, at: px(x, L) };
    cols.push(col);
    top = Math.min(top, col.from);
  }
  if (!Number.isFinite(top)) return null;
  const h = Math.max(1, y1 + 1 - top);
  const cover = blank(w, h), strip = blank(w, 1);
  cols.forEach((c, i) => {
    if (!c) return;
    for (let k = 0; k < 4; k++) strip.data[i * 4 + k] = art.data[c.at + k];
    for (let y = Math.max(c.from, top); y <= y1; y++) for (let k = 0; k < 4; k++) cover.data[((y - top) * w + i) * 4 + k] = art.data[c.at + k];
  });
  return { x: x0, y: top, cover, strip };
}
