// The stations floor's static picture cache (TES-GUPPY-RASTER), the pure half.
//
// Drawn whole every frame, TES filled its map-sized 'below' and 187 static
// boxes (1.27 M px for 28 k visible pixels): about twice the office's raster
// time. StationFloor now draws 'below' and every static, with the very same
// sprites and so the very same rounding, over the background into a screen-sized
// cache, and each frame draws only:
// - the cache's cells that 'below' or a static can reach, screen-aligned and
//   1:1 (each device pixel copies exactly one cache pixel; a cell left out is
//   the background alone, which the clear already draws);
// - the people;
// - again, in depth order with the people, each static with an opaque pixel
//   near a person, and every later static with one near those (frontPicker).
// When every pixel of 'below' and the statics is fully opaque or fully
// transparent, and every static is at opacity 1, that is the same picture
// pixel for pixel. Per pixel, the topmost opaque item wins: away from people
// the cache holds it, and where a person stands every static that can cover
// them is drawn again in its depth slot. Otherwise (partial alpha) the floor
// draws as before.
//
// The cache is redrawn only when the picture it holds would change: the camera
// eases toward its target by ever smaller steps for many seconds, and redrawing
// on each step cost more than drawing directly. While the picture is changing,
// the floor draws directly; once it holds for a tick, it is cached.

import { byDepth } from './compositor';
import type { Pixels } from './raster';

export interface Box { x: number; y: number; w: number; h: number }

/** True when every pixel's alpha is 0 or 255. */
export function binaryAlpha(px: Pixels): boolean {
  for (let i = 3; i < px.data.length; i += 4) { const a = px.data[i]; if (a !== 0 && a !== 255) return false; }
  return true;
}

/** True when any pixel has alpha above 0. */
export function hasVisiblePixel(px: Pixels): boolean {
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i] !== 0) return true;
  return false;
}

/** The cache draws the same picture only for binary alpha at opacity 1. */
export function staticsCacheable(plan: { below: Pixels; sorted: Array<{ px?: Pixels | null; opacity: number }> }): boolean {
  return binaryAlpha(plan.below) && plan.sorted.every((it) => !it.px || (it.opacity === 1 && binaryAlpha(it.px)));
}

/** The statics' draw order on their own: the order a full depth sort gives them
 *  among themselves (byDepth, stable, as the floor sorts them with the people). */
export function staticOrder(sorted: Array<{ foot: number; rank: number }>): number[] {
  return sorted.map((it, i) => ({ foot: it.foot, rank: it.rank, i })).sort(byDepth).map((it) => it.i);
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The grid that decides which statics are drawn again over the cache, in map px. */
export const NEAR_CELL = 12;
/** The smallest map-to-device scale the grid's one-cell margin covers. A sprite
 *  rounded on its own samples a device pixel within 1.5/k + 1 map px of where its
 *  exact quad would (half a device px of edge rounding, one of size rounding,
 *  one texel of nearest sampling); two sprites, 3/k + 2 apart. One NEAR_CELL of
 *  margin covers that down to k = 0.3 (TES fits a 480x300 view at k = 0.47). */
export const NEAR_MIN_SCALE = 0.3;

/** Which statics to draw again over the cache, given the people's boxes and the
 *  statics left out of it (`live`): those, those with an opaque pixel near a
 *  person, and, closed in draw order, every later
 *  static with an opaque pixel near one of those (else a static drawn again
 *  would cover, away from the person, a later one). "Near" is the same or a
 *  neighbouring NEAR_CELL cell, a margin for each sprite's own rounding.
 *  Boxes would do, but TES stacks big, mostly transparent rail boxes, and box
 *  overlap chained most statics together. */
export function frontPicker(statics: Array<{ px?: Pixels | null; x: number; y: number }>, order: number[], mapW: number, mapH: number): (people: Box[], live?: boolean[]) => boolean[] {
  const C = NEAR_CELL, cols = Math.ceil(mapW / C) + 2, rows = Math.ceil(mapH / C) + 2;
  // Cells are offset by one so a static or person one cell off the map still fits.
  const cell = (x: number, y: number) => (Math.min(rows - 1, Math.max(0, Math.floor(y / C) + 1))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(x / C) + 1));
  const own: number[][] = statics.map((it) => {
    const out = new Set<number>();
    if (it.px) for (let y = 0; y < it.px.height; y++) for (let x = 0; x < it.px.width; x++) {
      if (it.px.data[(y * it.px.width + x) * 4 + 3] !== 0) out.add(cell(it.x + x, it.y + y));
    }
    return [...out];
  });
  const near = own.map((cs) => {
    const out = new Set<number>();
    for (const c of cs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cy = Math.floor(c / cols) + dy, cx = (c % cols) + dx;
      if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) out.add(cy * cols + cx);
    }
    return out;
  });
  // later[i]: the statics after i in draw order with an opaque pixel near one of i's.
  const rank = new Map<number, number>();
  order.forEach((i, k) => rank.set(i, k));
  const holders = new Map<number, number[]>();
  own.forEach((cs, i) => { for (const c of cs) { let h = holders.get(c); if (!h) holders.set(c, (h = [])); h.push(i); } });
  const later = near.map((cs, i) => {
    const out = new Set<number>();
    for (const c of cs) for (const j of holders.get(c) ?? []) if (j !== i && rank.get(j)! > rank.get(i)!) out.add(j);
    return [...out];
  });
  return (people, live = []) => {
    const on = statics.map((_, i) => !!live[i]);
    const at = new Set<number>();
    for (const q of people) {
      for (let y = q.y; y < q.y + q.h + C; y += C) for (let x = q.x; x < q.x + q.w + C; x += C) at.add(cell(Math.min(x, q.x + q.w - 1e-9), Math.min(y, q.y + q.h - 1e-9)));
    }
    for (const i of order) {
      if (!on[i] && own[i].length && [...near[i]].some((c) => at.has(c))) on[i] = true;
      if (on[i]) for (const j of later[i]) on[j] = true;
    }
    return on;
  };
}

/** Which statics can draw a pixel inside a map box: those with an opaque pixel in,
 *  or within `margin` cells of, the box's NEAR_CELL cells. A sprite rounded on its
 *  own samples within 1.5/k + 1 map px of a device pixel's exact map position (see
 *  NEAR_MIN_SCALE), which one cell of margin covers. Redrawn in depth order over the
 *  cache with the people, clipped to the box's device rect, these give that rect the
 *  full picture: per pixel the last opaque static wins, and it is among them. No
 *  closure: nothing is drawn outside the rect. (`cell`, `margin`: for the tests.) */
export function regionPicker(statics: Array<{ px?: Pixels | null; x: number; y: number }>, mapW: number, mapH: number, cell = NEAR_CELL, margin = 1): (box: Box) => boolean[] {
  const C = cell, cols = Math.ceil(mapW / C) + 2, rows = Math.ceil(mapH / C) + 2;
  const cx = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor(x / C) + 1));
  const cy = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor(y / C) + 1));
  // holders[c]: the statics with an opaque pixel within `margin` cells of cell c.
  const holders: number[][] = Array.from({ length: cols * rows }, () => []);
  statics.forEach((it, i) => {
    if (!it.px) return;
    const own = new Set<number>();
    for (let y = 0; y < it.px.height; y++) for (let x = 0; x < it.px.width; x++) {
      if (it.px.data[(y * it.px.width + x) * 4 + 3] !== 0) own.add(cy(it.y + y) * cols + cx(it.x + x));
    }
    const near = new Set<number>();
    for (const c of own) for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) {
      const r = Math.floor(c / cols) + dy, q = (c % cols) + dx;
      if (r >= 0 && r < rows && q >= 0 && q < cols) near.add(r * cols + q);
    }
    for (const c of near) holders[c].push(i);
  });
  return (box) => {
    const on = statics.map(() => false);
    for (let r = cy(box.y); r <= cy(box.y + box.h); r++) for (let q = cx(box.x); q <= cx(box.x + box.w); q++) {
      for (const i of holders[r * cols + q]) on[i] = true;
    }
    return on;
  };
}

/** Whether the cache's render texture must be rebuilt for a canvas of W x H device
 *  pixels at resolution r: none yet, or made for another pixel size or another
 *  resolution. A UI zoom changes the DPR (and so r) but often not the canvas's
 *  pixel size; an RT kept at the old r gives its cells wrong UVs and positions. */
export function cacheStale(rt: { source: { pixelWidth: number; pixelHeight: number; resolution: number } } | null, W: number, H: number, r: number): boolean {
  return !rt || rt.source.pixelWidth !== W || rt.source.pixelHeight !== H || rt.source.resolution !== r;
}

/** Keys for the cache's picture under the world transform (scale ax, ay, then
 *  offset tx, ty, in CSS px; `r` device px per CSS px): equal keys, same picture.
 *  Pixi computes each sprite vertex in float64 (a * w + tx, as below), hands the
 *  GPU its float32, and rounds it to the device grid there (roundPixels); the
 *  texture coordinates ride on the rounded vertices. So the picture depends only
 *  on where each edge rounds to, and an edge's float32 decides even a tie.
 *  - `key`: each edge's device rounding; a static with an edge within `eps` device
 *    px of a tie is `live` (left out of the cache, drawn every frame in its depth
 *    slot, and a seed of frontPicker).
 *  - `exact`: the same, but a tie's edges keyed by their float32 values, for a
 *    camera that has settled (an easing camera crawls toward a target where, at
 *    zooms such as 15/16, many edges sit exactly on ties); null if a float32
 *    boundary is near.
 *  'below' is keyed as in `exact` in both. */
export function cacheKeyOf(map: { w: number; h: number }, boxes: Array<Box | null>, ax: number, ay: number, tx: number, ty: number, r: number, eps = 2e-3): { key: string; exact: string | null; live: boolean[] } {
  const tie = (v: number) => Math.abs(v * r - Math.floor(v * r) - 0.5) < eps;
  const edges = (b: Box) => { const L = ax * b.x + tx, T = ay * b.y + ty; return [L, ax * b.w + L, T, ay * b.h + T]; };
  const rounded = (e: number[]) => e.map((v) => Math.floor(v * r + 0.5)).join(' ');
  let exactOk = true;
  const f32 = (e: number[]) => e.map((v) => {
    const f = Math.fround(v), m = Math.abs(v) * 1e-12 + 1e-300;
    if (Math.fround(v - m) !== f || Math.fround(v + m) !== f) exactOk = false;
    return f;
  }).join(' ');
  const be = edges({ x: 0, y: 0, w: map.w, h: map.h });
  const head = be.some(tie) ? `f ${f32(be)}` : rounded(be);
  const keyParts = [head], exactParts = [head];
  const live = boxes.map((b) => {
    if (!b) return false;
    const e = edges(b);
    if (e.some(tie)) { keyParts.push('live'); exactParts.push(`f ${f32(e)}`); return true; }
    const p = rounded(e);
    keyParts.push(p); exactParts.push(p);
    return false;
  });
  return { key: keyParts.join(','), exact: exactOk ? exactParts.join(',') : null, live };
}

/** The `tile`-pixel cells of a picture that hold a pixel with alpha above 0,
 *  offset by (ox, oy): where the picture can draw, in map coordinates. */
export function liveBoxes(px: Pixels, ox: number, oy: number, tile: number): Box[] {
  const out: Box[] = [];
  for (let ty = 0; ty < px.height; ty += tile) {
    for (let tx = 0; tx < px.width; tx += tile) {
      const w = Math.min(tile, px.width - tx), h = Math.min(tile, px.height - ty);
      let live = false;
      for (let y = ty; y < ty + h && !live; y++) {
        for (let x = tx; x < tx + w; x++) if (px.data[(y * px.width + x) * 4 + 3] !== 0) { live = true; break; }
      }
      if (live) out.push({ x: ox + tx, y: oy + ty, w, h });
    }
  }
  return out;
}

/** The `tile`-pixel cells of a `width` x `height` device-pixel screen that a map
 *  box can reach under the map-to-device transform (scale k, then offset dx, dy),
 *  with a 1 px margin for vertex rounding: a superset of the cache's live pixels.
 *  A cell left out holds only the background. */
export function screenCells(boxes: Box[], k: number, dx: number, dy: number, width: number, height: number, tile: number): Box[] {
  const cols = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const hit = new Uint8Array(cols * rows);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor((b.x * k + dx - 1) / tile)), x1 = Math.min(cols - 1, Math.floor(((b.x + b.w) * k + dx + 1) / tile));
    const y0 = Math.max(0, Math.floor((b.y * k + dy - 1) / tile)), y1 = Math.min(rows - 1, Math.floor(((b.y + b.h) * k + dy + 1) / tile));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hit[y * cols + x] = 1;
  }
  const out: Box[] = [];
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i]) continue;
    const x = (i % cols) * tile, y = Math.floor(i / cols) * tile;
    out.push({ x, y, w: Math.min(tile, width - x), h: Math.min(tile, height - y) });
  }
  return out;
}
