/**
 * SCENARIO - TES-FLOOR-WHOLE-188, RENDERED: the real OfficeFloor draws the bundled tes pack with a
 * crew, on a synthetic clock (as tes-floor-ease.tsx did), and the host box is resized (the plan) so
 * the camera moves, and crew members are selected (the plan), which must not move it (TES-SCENE-BOUNCE-188). After
 * every render:
 * - the semantic lip-to-lip box has the largest uniform scale that fits and its midpoint is at the
 *   pane midpoint. The static floor is cached at ceil(scale), then downscaled once, linearly (smooth,
 *   the Human's choice);
 * - every CHECK_EVERY renders, the TEXEL CHECK compares the actual stage's former right-hull-lip
 *   failure crop against a reference that uses the same nearest integer cache and one linear
 *   downscale. Its tolerance is exactly zero channel differences;
 * - every CHECK_EVERY renders, the DEPTH CHECK (TES-HULL M1) compares each person's device rect
 *   (cups and parked mugs too) against this frame drawn again in the same layout and filters with
 *   every static in its depth order, with zero tolerance; the same px of a crew-top draw of the
 *   frame must differ (teeth);
 * - every TEETH_EVERY renders, the FRONT-STATIC CHECK (TES-HULL M2): where a static fully covers a
 *   px, the static drawn again over the floor equals the floor alone, so a static does not change
 *   look when someone walks behind it; drawn again nearest, it differs (teeth);
 * - bubbles, text and vector shapes are left out of all of them;
 * - the pane's edges have no transparent pixels. A tall pane may show the pack backdrop below the
 *   supplied hull; it must never manufacture more hull to cover that viewport space.
 * Run by test/tes-floor-whole-188.test.cjs (HARNESS_DPR per case).
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Container, RenderTexture, Sprite, Texture } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { floorFrame, PACK_ART } from '../../../src/renderer/src/scene/themes/framing';
import { BOX, RESIZES, SELECTS, LAST, CHECK_EVERY } from './tes-floor-whole-plan';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

const STEP_MS = 1000 / 60;
const TEETH_EVERY = 40;
const FRONT_PER_CHECK = 16;

let seed = 12345;
Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

{
  let queue = new Map<number, FrameRequestCallback>();
  let seq = 0; let n = 0; let armed = false;
  performance.now = () => n * STEP_MS;
  const frame = () => {
    armed = false;
    n += 1;
    const run = queue; queue = new Map();
    for (const cb of run.values()) cb(n * STEP_MS);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.set(++seq, cb);
    if (!armed) { armed = true; window.setTimeout(frame, 0); }
    return seq;
  };
  window.cancelAnimationFrame = (id: number) => { queue.delete(id); };
}

const pixelsOf = (app: any, rt: RenderTexture) => app.renderer.extract.pixels({ target: rt }).pixels as Uint8ClampedArray;

/** The stage drawn at one px per map px: the floor texture swapped for 'below' and every static
 *  shown, in depth order (the source the floor texel check resamples). */
function mapRef(app: any, S: any, H: number, clearColor: number[]): Uint8ClampedArray {
  const w = S.world, r = app.renderer;
  const sc = w.scale.x, x = w.x, y = w.y;
  const statics = new Set(S.statics.filter(Boolean));
  const kids: any[] = S.sortLayer.children;
  const was = kids.map((c) => c.visible);
  const tmp = new Sprite(S.below);
  w.addChildAt(tmp, w.children.indexOf(S.floorView));
  S.floorView.visible = false;
  w.scale.set(1); w.position.set(0, 0);
  const rt = RenderTexture.create({ width: S.mapW, height: H, resolution: 1, scaleMode: 'nearest' });
  for (const c of kids) if (statics.has(c)) c.visible = true;
  r.render({ container: app.stage, target: rt, clear: true, clearColor });
  kids.forEach((c, i) => { c.visible = was[i]; });
  w.scale.set(sc); w.position.set(x, y);
  S.floorView.visible = true;
  w.removeChild(tmp); tmp.destroy();
  const px = pixelsOf(app, rt);
  rt.destroy(true);
  return px;
}

let fitRefCache: { key: string; px: Uint8ClampedArray } | null = null;
/** Build a full-depth reference only on a new pane/cache scale. Its source rectangle, prescale,
 * and final linear sampling exactly match floorView; per-frame checks then read the former
 * right-lip failure crop from it without adding per-frame composition CPU. */
function fitDepthRef(app: any, S: any, clearColor: number[]): Uint8ClampedArray {
  const b = { x: Math.round(S.floorView.x), y: Math.round(S.floorView.y), w: Math.round(S.floorView.width), h: Math.round(S.floorView.height) };
  const key = [b.x, b.y, b.w, b.h, S.k, S.world.scale.x, S.world.x, S.world.y, app.screen.width, app.screen.height, app.renderer.resolution].join('|');
  if (fitRefCache?.key === key) return fitRefCache.px;
  const ref = mapRef(app, S, S.mapH, clearColor), cv = document.createElement('canvas'); cv.width = b.w; cv.height = b.h;
  // Copy row by row: the map's rows are wider than the floor cache rectangle.
  const image = cv.getContext('2d')!.getImageData(0, 0, b.w, b.h);
  for (let y = 0; y < b.h; y++) image.data.set(ref.subarray(((b.y + y) * S.mapW + b.x) * 4, ((b.y + y) * S.mapW + b.x + b.w) * 4), y * b.w * 4);
  cv.getContext('2d')!.putImageData(image, 0, 0);
  const source = Texture.from(cv); source.source.scaleMode = 'nearest';
  const up = RenderTexture.create({ width: b.w * S.k, height: b.h * S.k, resolution: 1, scaleMode: 'linear' });
  const upRoot = new Container(), upView = upRoot.addChild(new Sprite(source)); upView.scale.set(S.k);
  app.renderer.render({ container: upRoot, target: up, clear: true });
  const world = new Container(), view = world.addChild(new Sprite(up)); view.position.set(b.x, b.y); view.scale.set(1 / S.k);
  world.scale.set(S.world.scale.x); world.position.set(S.world.x, S.world.y);
  const out = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: app.renderer.resolution, scaleMode: 'nearest' });
  app.renderer.render({ container: world, target: out, clear: true, clearColor });
  const px = pixelsOf(app, out); out.destroy(true); up.destroy(true); source.destroy(true); upRoot.destroy({ children: true }); world.destroy({ children: true });
  fitRefCache = { key, px }; return px;
}

/** TES-HULL M1: the live stage drawn again for THIS frame, the same layout and filters as the shot,
 *  with every static shown (Dwight's M1 work). crewTop false: each static at its own zIndex among the
 *  people (the depth sort). crewTop true: every static behind every person (the teeth). */
function depthRef(app: any, S: any, clearColor: number[], crewTop: boolean): Uint8ClampedArray {
  const statics = S.statics.filter(Boolean) as any[];
  const visible = statics.map((s) => s.visible), z = statics.map((s) => s.zIndex);
  const rt = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: app.renderer.resolution, scaleMode: 'nearest' });
  try {
    statics.forEach((s) => { s.visible = true; });
    if (crewTop) statics.forEach((s) => { s.zIndex = -1_000_000; });
    S.sortLayer.sortChildren();
    app.renderer.render({ container: app.stage, target: rt, clear: true, clearColor });
    return pixelsOf(app, rt);
  } finally {
    statics.forEach((s, i) => { s.visible = visible[i]; s.zIndex = z[i]; });
    S.sortLayer.sortChildren();
    rt.destroy(true);
  }
}

/** Each person's (cup's, parked mug's) device rect, taken INWARD: every pixel centre in it is at
 *  least one device px inside the person's box. A static the picker rightly left out (no opaque px
 *  in the box) reaches less than that into the box: its texel grid is the floor's, which roundPixels
 *  moves by up to half a device px, and the linear filter blends half a texel (n <= k: at most half a
 *  device px) past its edge. So it adds nothing there, and a static in front of the person, whose
 *  opaque px in the box the picker draws again, is in the rect. */
function personRects(app: any, S: any, Wd: number, Hd: number): number[][] {
  const r = app.renderer.resolution, out: number[][] = [];
  for (const c of S.people as any[]) {
    if (!c.visible || !c.renderable || c.alpha === 0) continue;
    const b = c.getBounds();
    const x0 = Math.max(0, Math.ceil(b.x * r + 0.5)), y0 = Math.max(0, Math.ceil(b.y * r + 0.5));
    const x1 = Math.min(Wd, Math.floor((b.x + b.width) * r - 0.5)), y1 = Math.min(Hd, Math.floor((b.y + b.height) * r - 0.5));
    if (x1 > x0 && y1 > y0) out.push([x0, y0, x1, y1]);
  }
  return out;
}

/** TES-HULL M2: statics drawn again against the floor's own sampling of them, `count` statics per
 *  call in turn. For static i, on a transparent clear and over the whole pane:
 *  - drawn: its sprite in sortLayer alone, as the people's front draws it;
 *  - floor: the floor's own quad (floorView, its rounding, its linear filter) showing a floor-sized
 *    texture with only static i in it, drawn there as buildFloor draws it (nearest at k);
 *  - teeth: the static as a nearest sprite at its own place (the old front draw).
 *  Returns the px where drawn != floor and the largest channel difference there (the GPU's own
 *  rounding of two interpolated texture coordinates: 1 at most), and the px where teeth differs by more. */
let frontNext = 0;
function frontStaticDiff(app: any, S: any, count: number): { statics: number; covered: number; diff: number; maxDelta: number; teeth: number } {
  const all = (S.statics as any[]).map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const kids: any[] = S.sortLayer.children, wk: any[] = S.world.children;
  const wasK = kids.map((c) => c.visible), wasW = wk.map((c) => c.visible);
  const b = S.bounds, k = S.k, floorTex = S.floorView.texture;
  const shot = () => {
    const rt = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: app.renderer.resolution, scaleMode: 'nearest' });
    app.renderer.render({ container: app.stage, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    const px = pixelsOf(app, rt); rt.destroy(true); return px;
  };
  const only = (c: any) => {
    kids.forEach((q) => { q.visible = q === c; });
    wk.forEach((q) => { q.visible = c ? q === S.sortLayer : q === S.floorView; });
  };
  let covered = 0, diff = 0, maxDelta = 0, teeth = 0, done = 0;
  try {
    for (let n = 0; n < count && n < all.length; n++) {
      const i = all[frontNext++ % all.length], s = S.statics[i], at = S.sortedAt[i], tex = S.staticTex[i];
      only(s);
      const drawn = shot();
      const near = new Sprite(tex); near.position.set(at.x, at.y);
      S.sortLayer.addChild(near); only(near);
      const old = shot();
      S.sortLayer.removeChild(near); near.destroy();
      const one = RenderTexture.create({ width: floorTex.width, height: floorTex.height, resolution: 1, scaleMode: 'linear' });
      const root = new Container(), sp = root.addChild(new Sprite(tex));
      sp.scale.set(k); sp.position.set((at.x - b.x) * k, (at.y - b.y) * k);
      app.renderer.render({ container: root, target: one, clear: true });
      root.destroy({ children: true });
      S.floorView.texture = one; only(null);
      const floor = shot();
      S.floorView.texture = floorTex; one.destroy(true);
      const delta = (a: Uint8ClampedArray, p: number) => Math.max(Math.abs(a[p] - floor[p]), Math.abs(a[p + 1] - floor[p + 1]), Math.abs(a[p + 2] - floor[p + 2]), Math.abs(a[p + 3] - floor[p + 3]));
      for (let p = 0; p < floor.length; p += 4) {
        if (floor[p + 3] !== 0) covered++;
        const d = delta(drawn, p);
        if (d) { diff++; maxDelta = Math.max(maxDelta, d); }
        if (d > 1 && out.frontSamples.length < 6) out.frontSamples.push([renders, i, p / 4, [drawn[p], drawn[p + 1], drawn[p + 2], drawn[p + 3]], [floor[p], floor[p + 1], floor[p + 2], floor[p + 3]]]);
        if (delta(old, p) > 1) teeth++;
      }
      done++;
    }
    return { statics: done, covered, diff, maxDelta, teeth };
  } finally {
    S.floorView.texture = floorTex;
    kids.forEach((c, j) => { c.visible = wasK[j]; });
    wk.forEach((c, j) => { c.visible = wasW[j]; });
  }
}

const out = {
  frames: 0, fitBad: 0, fitAt: '' as string, cacheBad: 0, builds: 0, panned: 0, panAt: '' as string, selects: 0,
  texelChecks: 0, texelBadMax: 0, texelBadAt: '' as string, offMap: 0,
  teethChecks: 0, teethMax: 0, edgeBlank: 0,
  depthChecks: 0, depthBadMax: 0, depthBadAt: '' as string, depthPixels: 0, depthArea: 0, depthSamples: [] as unknown[],
  frontChecks: 0, frontStatics: 0, frontCovered: 0, frontDiff: 0, frontMaxDelta: 0, frontTeeth: 0, frontSamples: [] as unknown[], frontLog: [] as number[][],
  // Every frame: on an axis the art covers, the device px of frame margin (backdrop) in the pane.
  coveredFrames: 0, marginFrames: 0, marginMax: 0, marginAt: '',
  configs: [] as Array<{ box: string; dev: string; n: number; ox: number; oy: number; sideL: number; sideR: number; edges: Record<string, number> }>,
  badFrames: [] as Array<{ at: number; bad: number; box: number[]; samples: unknown[] }>,
  errors: [] as string[]
};
let renders = 0;
let done: (() => void) | null = null;
let hostBox: HTMLDivElement | null = null;
let last = { x: NaN, y: NaN, s: NaN, pane: '' };
let overflowNow = false;
let sawConfig = '';
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: any) {
  realRender.call(this);
  renders += 1;
  const app = this, S = app.__tesScene;
  try {
    if (S) {
      const r = app.renderer.resolution, w = S.world;
      const n = w.scale.x * r, ox = w.x * r, oy = w.y * r;
      const Wd = Math.round(app.screen.width * r), Hd = Math.round(app.screen.height * r);
      out.frames++;
      const fit = S.frame.fit;
      if (!fit) throw new Error('TES frame has no semantic fit box');
      const fw = fit.x1 + 1 - fit.x0, fh = fit.y1 + 1 - fit.y0;
      const expected = Math.min(Wd / fw, Hd / fh);
      const left = ox + fit.x0 * n, right = ox + (fit.x1 + 1) * n;
      const top = oy + fit.y0 * n, bottom = oy + (fit.y1 + 1) * n;
      const fillsWidth = Wd / fw <= Hd / fh;
      const failedFit = Math.abs(n - expected) * (fillsWidth ? fw : fh) > 1 || Math.abs(w.scale.x - w.scale.y) > 1e-6
        || Math.abs((left + right) / 2 - Wd / 2) > 1 || Math.abs((top + bottom) / 2 - Hd / 2) > 1
        || left < -1 || top < -1 || right > Wd + 1 || bottom > Hd + 1
        || (fillsWidth ? Math.abs(right - left - Wd) > 1 : Math.abs(bottom - top - Hd) > 1);
      if (failedFit) { out.fitBad++; if (!out.fitAt) out.fitAt = `${Wd}x${Hd} n=${n} expected=${expected} box=${left},${top},${right},${bottom}`; }
      if (!Number.isInteger(S.k) || S.k < n - 1e-6 || S.k >= n + 1) out.cacheBad++;
      out.builds = app.__tesStaticCacheBuilds ?? 0;
      const moved = w.x !== last.x || w.y !== last.y;
      const sameScale = w.scale.x === last.s;
      // TES-SCENE-BOUNCE-188: in an unchanged pane the scene never moves (a select's nudge lifted it).
      const pane = `${Wd}x${Hd}`;
      if (moved && sameScale && pane === last.pane) { out.panned++; if (!out.panAt) out.panAt = `render ${renders} ${pane} ox=${ox} oy=${oy}`; }
      last = { x: w.x, y: w.y, s: w.scale.x, pane };
      if (renders % CHECK_EVERY === 0 && renders > 2) {
        const N = Math.round(n), OX = Math.round(ox), OY = Math.round(oy);
        const clear = app.renderer.background.color.toArray();
        const bg = clear.map((v: number) => Math.round(v * 255));
        // The bubbles (thought clouds: text and vector shapes over the floor, not pixel art) are left out of both.
        // The envelopes fly in the world and the clouds hang in the screen layer over it (TES-BUBBLE-TAIL-SHARP-189).
        const bub = [app.__bubbleLayer?.container, app.__bubbleLayer?.screen].filter(Boolean);
        for (const b of bub) b.visible = false;
        // Every shot below is of a render texture: the front statics placed for its rounding.
        S.placeFront(false);
        const rt = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: r, scaleMode: 'nearest' });
        app.renderer.render({ container: app.stage, target: rt, clear: true, clearColor: clear });
        const shot = pixelsOf(app, rt);
        const SW = rt.pixelWidth ?? Wd;
        rt.destroy(true);
        // The fit probe is every CHECK_EVERY frames, not only at a whole scale. It compares the
        // former right-lip failure crop against an independently full-depth, identically sampled
        // reference. A zero tolerance is valid once both use the same linear sampling contract.
        if (S.frame.fit) {
        const cropW = 16, cropH = 16, cropX = Math.round(ox + 594 * n) - 4, cropY = Math.round(oy + 97 * n) - 4;
        const ref = fitDepthRef(app, S, clear);
        let bad = 0;
        const bb = [Infinity, Infinity, -1, -1], samples: unknown[] = [];
        // ref and the shot are both screen-sized, so one index i reads both.
        for (let Y = 0; Y < cropH; Y++) for (let X = 0; X < cropW; X++) {
            const i = ((cropY + Y) * SW + cropX + X) * 4;
            if (shot[i] !== ref[i] || shot[i + 1] !== ref[i + 1] || shot[i + 2] !== ref[i + 2] || shot[i + 3] !== ref[i + 3]) {
              bad++;
              bb[0] = Math.min(bb[0], cropX + X); bb[1] = Math.min(bb[1], cropY + Y); bb[2] = Math.max(bb[2], cropX + X); bb[3] = Math.max(bb[3], cropY + Y);
              if (samples.length < 6 && bad % 97 === 1) samples.push([cropX + X, cropY + Y, [shot[i], shot[i + 1], shot[i + 2], shot[i + 3]], [ref[i], ref[i + 1], ref[i + 2], ref[i + 3]]]);
            }
        }
        out.texelChecks++;
        if (bad && out.badFrames.length < 60) out.badFrames.push({ at: renders, bad, box: bb, samples });
        if (bad > out.texelBadMax) { out.texelBadMax = bad; out.texelBadAt = `render ${renders}, n ${N}, ${Wd}x${Hd}`; }
        // TES-HULL M1, the DEPTH CHECK: over each person's device rect, the shot against this frame
        // drawn again with every static shown in depth order (zero tolerance), and the same
        // comparison against a crew-top draw of the same frame (the teeth: it must differ).
        const sorted = depthRef(app, S, clear, false), crewTop = depthRef(app, S, clear, true);
        let dBad = 0, dTeeth = 0, dPix = 0, dArea = 0;
        const seen = new Uint8Array(SW * Hd);
        for (const [x0, y0, x1, y1] of personRects(app, S, SW, Hd)) for (let Y = y0; Y < y1; Y++) for (let X = x0; X < x1; X++) {
          const p = Y * SW + X;
          if (seen[p]) continue;
          seen[p] = 1; dArea++;
          const i = p * 4;
          const vsSorted = shot[i] !== sorted[i] || shot[i + 1] !== sorted[i + 1] || shot[i + 2] !== sorted[i + 2] || shot[i + 3] !== sorted[i + 3];
          const vsTop = shot[i] !== crewTop[i] || shot[i + 1] !== crewTop[i + 1] || shot[i + 2] !== crewTop[i + 2] || shot[i + 3] !== crewTop[i + 3];
          if (sorted[i] !== crewTop[i] || sorted[i + 1] !== crewTop[i + 1] || sorted[i + 2] !== crewTop[i + 2] || sorted[i + 3] !== crewTop[i + 3]) dPix++;
          if (vsTop) dTeeth++;
          if (vsSorted) {
            dBad++;
            if (out.depthSamples.length < 6) out.depthSamples.push([renders, X, Y, [shot[i], shot[i + 1], shot[i + 2], shot[i + 3]], [sorted[i], sorted[i + 1], sorted[i + 2], sorted[i + 3]]]);
          }
        }
        out.depthChecks++; out.depthArea += dArea; out.depthPixels += dPix;
        if (dBad > out.depthBadMax) { out.depthBadMax = dBad; out.depthBadAt = `render ${renders}, n ${N}, ${Wd}x${Hd}`; }
        out.teethChecks++; out.teethMax = Math.max(out.teethMax, dTeeth);
        // TES-HULL M2: a static drawn again looks the same as the floor's own copy of it.
        if (renders % TEETH_EVERY === 0) {
          const f = frontStaticDiff(app, S, FRONT_PER_CHECK);
          out.frontChecks++; out.frontStatics += f.statics; out.frontCovered += f.covered; out.frontDiff += f.diff; out.frontMaxDelta = Math.max(out.frontMaxDelta, f.maxDelta); out.frontTeeth += f.teeth;
          out.frontLog.push([renders, N, f.statics, f.covered, f.diff, f.teeth]);
        }
        }
        for (const b of bub) b.visible = true;
        S.placeFront(true);
        // The pane's edges are never transparent. The bottom may be the palette backdrop when the
        // supplied art ends above it; tes-hull-stretch-189 bounds that rendered case.
        const isBg = (i: number) => shot[i] === bg[0] && shot[i + 1] === bg[1] && shot[i + 2] === bg[2];
        const edges: Record<string, number> = { top: 0, bottom: 0, left: 0, right: 0 };
        const edge = (name: string, X: number, Y: number) => {
          const i = (Y * SW + X) * 4;
          if (shot[i + 3] !== 255) out.edgeBlank++;
          if (!isBg(i)) edges[name]++;
        };
        for (let X = 0; X < Wd; X++) { edge('top', X, 0); edge('bottom', X, Hd - 1); }
        for (let Y = 0; Y < Hd; Y++) { edge('left', 0, Y); edge('right', Wd - 1, Y); }
        const a = PACK_ART.tes;
        const key = `${app.screen.width}x${app.screen.height}`;
        // Per pane, as it is at its last check (at rest).
        const c = { box: key, dev: `${Wd}x${Hd}`, n: N, ox: OX, oy: OY, sideL: OX + a.x0 * N, sideR: Wd - (OX + (a.x1 + 1) * N), edges };
        if (key !== sawConfig) { sawConfig = key; out.configs.push(c); } else out.configs[out.configs.length - 1] = c;
      }
    }
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  const rz = RESIZES.find((q) => q.at === renders);
  if (rz && hostBox) { hostBox.style.width = rz.w + 'px'; hostBox.style.height = rz.h + 'px'; }
  const sel = SELECTS.find((q) => q.at === renders);
  if (sel) { out.selects++; if (sel.id && overflowNow) out.overflowSelects++; useStore.setState({ selectedId: sel.id } as never); }
  if (renders >= LAST && done) { done(); done = null; }
};

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'working' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', status: 'idle' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'rose', status: 'working' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const box = document.createElement('div');
    box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
    document.body.style.margin = '0';
    document.body.appendChild(box);
    hostBox = box;
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    await finished;
    await act(async () => { root.unmount(); });
    const SM = loaded.pack.scene;
    window.harness.report({ ok: true, dpr: window.devicePixelRatio, renders, frame: floorFrame('tes', SM.PW, SM.PH), ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
