/**
 * SCENARIO - TES-FLOOR-WHOLE-188, RENDERED: the real OfficeFloor draws the bundled tes pack with a
 * crew, on a synthetic clock (as tes-floor-ease.tsx did), and the host box is resized (the plan) so
 * the camera moves, and crew members are selected (the plan), which must not move it (TES-SCENE-BOUNCE-188). After
 * every render:
 * - the camera is whole: n = world scale x DPR is a whole number, and so are the world's x and y in
 *   device px; n is wholeScale of the pane's device size, and the floor texture's k is n;
 * - every CHECK_EVERY renders, the TEXEL CHECK: the stage as drawn, read back in device px, against
 *   the full depth sort drawn at one px per map px ('below', then the people and EVERY static sorted
 *   together, the hull, 'above'): device px (X, Y) must equal map px (floor((X - ox) / n),
 *   floor((Y - oy) / n)), the backdrop off the map. So every art px is n x n device px, there is no
 *   seam, and nobody is drawn over a static in front of them (the bubbles, text and vector shapes
 *   over the floor, are left out of both). A draw with the people over every
 *   static differs (the check has teeth);
 * - the pane's edges: no blank px; across the ship's columns the bottom row shows the ship or its
 *   hull, never the backdrop (no band below the ship).
 * Run by test/tes-floor-whole-188.test.cjs (HARNESS_DPR per case).
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, RenderTexture, Sprite } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { floorFrame, wholeScale, PACK_ART } from '../../../src/renderer/src/scene/themes/framing';
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

const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
const pixelsOf = (app: any, rt: RenderTexture) => app.renderer.extract.pixels({ target: rt }).pixels as Uint8ClampedArray;

/** The stage drawn at one px per map px, the full depth sort: the floor texture swapped for 'below'
 *  and every static shown. With crewTop, the statics first and the people after them all. */
function mapRef(app: any, S: any, H: number, clearColor: number[], crewTop: boolean): Uint8ClampedArray {
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
  if (!crewTop) r.render({ container: app.stage, target: rt, clear: true, clearColor });
  else {
    kids.forEach((c, i) => { c.visible = statics.has(c); });
    r.render({ container: app.stage, target: rt, clear: true, clearColor });
    kids.forEach((c, i) => { c.visible = !statics.has(c) && was[i]; });
    r.render({ container: S.sortLayer, target: rt, clear: false });
  }
  kids.forEach((c, i) => { c.visible = was[i]; });
  w.scale.set(sc); w.position.set(x, y);
  S.floorView.visible = true;
  w.removeChild(tmp); tmp.destroy();
  const px = pixelsOf(app, rt);
  rt.destroy(true);
  return px;
}

const out = {
  frames: 0, wholeBad: 0, nBad: 0, kBad: 0, nSeen: [] as number[], builds: 0, easing: 0, panned: 0, panAt: '' as string, selects: 0, overflowSelects: 0,
  texelChecks: 0, texelEasing: 0, texelBadMax: 0, texelBadAt: '' as string, offMap: 0,
  teethChecks: 0, teethMax: 0, edgeBlank: 0, bottomBand: 0, bottomChecks: 0,
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
      if (!isInt(n) || !isInt(ox) || !isInt(oy)) out.wholeBad++;
      const keep = S.frame.keep;
      if (Math.round(n) !== wholeScale(keep, Wd, Hd)) out.nBad++;
      if (S.k !== Math.round(n)) out.kBad++;
      const art = S.frame.art;
      const cx = (art.x1 + 1 - art.x0) * n >= Wd, cy = (art.y1 + 1 - art.y0) * n >= Hd;
      if (cx || cy) {
        out.coveredFrames++;
        const m = (cx ? Math.max(0, ox + art.x0 * n) + Math.max(0, Wd - (ox + (art.x1 + 1) * n)) : 0)
          + (cy ? Math.max(0, oy + art.y0 * n) + Math.max(0, Hd - (oy + (art.y1 + 1) * n)) : 0);
        if (m > 0) { out.marginFrames++; if (m > out.marginMax) { out.marginMax = m; out.marginAt = `${renders} ${Wd}x${Hd} n=${n} ox=${ox} oy=${oy}`; } }
      }
      if (out.nSeen[out.nSeen.length - 1] !== Math.round(n)) out.nSeen.push(Math.round(n));
      out.builds = app.__tesStaticCacheBuilds ?? 0;
      const moved = w.x !== last.x || w.y !== last.y;
      const sameScale = w.scale.x === last.s;
      if (moved && sameScale) out.easing++;
      // TES-SCENE-BOUNCE-188: in an unchanged pane the scene never moves (a select's nudge lifted it).
      const pane = `${Wd}x${Hd}`;
      if (moved && sameScale && pane === last.pane) { out.panned++; if (!out.panAt) out.panAt = `render ${renders} ${pane} ox=${ox} oy=${oy}`; }
      overflowNow = S.frame.w * n > Wd || (S.frame.h - S.frame.deadBottom) * n > Hd;
      last = { x: w.x, y: w.y, s: w.scale.x, pane };
      if (renders % CHECK_EVERY === 0 && renders > 2) {
        const N = Math.round(n), OX = Math.round(ox), OY = Math.round(oy);
        const clear = app.renderer.background.color.toArray();
        const bg = clear.map((v: number) => Math.round(v * 255));
        // The bubbles (thought clouds: text and vector shapes over the floor, not pixel art) are left out of both.
        const bub = app.__bubbleLayer?.container;
        if (bub) bub.visible = false;
        const rt = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: r, scaleMode: 'nearest' });
        app.renderer.render({ container: app.stage, target: rt, clear: true, clearColor: clear });
        const shot = pixelsOf(app, rt);
        const SW = rt.pixelWidth ?? Wd;
        rt.destroy(true);
        const H = Math.max(S.mapH, Math.ceil((Hd - OY) / N) + 1);
        const ref = mapRef(app, S, H, clear, false);
        let bad = 0;
        const bb = [Infinity, Infinity, -1, -1], samples: unknown[] = [];
        for (let Y = 0; Y < Hd; Y++) {
          const my = Math.floor((Y - OY) / N);
          for (let X = 0; X < Wd; X++) {
            const mx = Math.floor((X - OX) / N), i = (Y * SW + X) * 4;
            let e0, e1, e2, e3;
            if (mx < 0 || my < 0 || mx >= S.mapW || my >= H) { out.offMap++; e0 = bg[0]; e1 = bg[1]; e2 = bg[2]; e3 = bg[3]; } else {
              const j = (my * S.mapW + mx) * 4;
              e0 = ref[j]; e1 = ref[j + 1]; e2 = ref[j + 2]; e3 = ref[j + 3];
            }
            if (shot[i] !== e0 || shot[i + 1] !== e1 || shot[i + 2] !== e2 || shot[i + 3] !== e3) {
              bad++;
              bb[0] = Math.min(bb[0], X); bb[1] = Math.min(bb[1], Y); bb[2] = Math.max(bb[2], X); bb[3] = Math.max(bb[3], Y);
              if (samples.length < 6 && bad % 97 === 1) samples.push([X, Y, mx, my, [shot[i], shot[i + 1], shot[i + 2], shot[i + 3]], [e0, e1, e2, e3]]);
            }
          }
        }
        out.texelChecks++;
        if (bad && out.badFrames.length < 60) out.badFrames.push({ at: renders, bad, box: bb, samples });
        if (moved && sameScale) out.texelEasing++;
        if (bad > out.texelBadMax) { out.texelBadMax = bad; out.texelBadAt = `render ${renders}, n ${N}, ${Wd}x${Hd}`; }
        if (renders % TEETH_EVERY === 0) {
          const top = mapRef(app, S, H, clear, true);
          let t = 0;
          for (let j = 0; j < ref.length; j += 4) if (ref[j] !== top[j] || ref[j + 1] !== top[j + 1] || ref[j + 2] !== top[j + 2]) t++;
          out.teethChecks++; out.teethMax = Math.max(out.teethMax, t);
        }
        if (bub) bub.visible = true;
        // The pane's edges: never blank; across the ship's columns the bottom row is never the backdrop.
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
        out.bottomChecks++;
        for (let X = Math.max(0, OX + a.x0 * N); X < Math.min(Wd, OX + (a.x1 + 1) * N); X++) if (isBg(((Hd - 1) * SW + X) * 4)) { out.bottomBand++; break; }
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
