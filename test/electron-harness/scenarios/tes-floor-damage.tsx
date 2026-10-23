/**
 * SCENARIO - PERF-FLOOR-FILL-188, RENDERED: the TES floor draws again only the rects that changed
 * (damage.ts); this proves a frame so drawn is the frame a full draw makes, on EVERY frame.
 * The real OfficeFloor draws the bundled tes pack with a crew on a synthetic clock while the plan
 * resizes the host box, selects crew (a nudge, a no-op for the whole camera), takes an agent away and back, flips statuses
 * (thought clouds come and go) and loses the WebGL context (the floor rebuilds). After every render:
 * the canvas as drawn (its kept buffer) is read, then the same state is drawn whole onto the canvas
 * and read again: the two must not differ by a single px, bubbles included. (By induction this
 * covers every chain of frames: each frame's step from a right canvas is right, and the tracker
 * keeps the same state after a whole draw as after its own.) It reports what the frames drew: how
 * many were whole, incremental (rects, passes, device px) or nothing at all.
 * Run by test/tes-floor-damage-188.test.cjs (HARNESS_DPR per case; mutant sources swapped in).
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { BOX, RESIZES, SELECTS, CREW, LOSE_AT, LAST, AFTER, LOOKS, LOOKS_FROM, EDGE_FROM } from './tes-floor-damage-plan';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; progress: (payload: unknown) => void };
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
let seed = 4242;
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

type Rect = { x: number; y: number; w: number; h: number };
const out = {
  frames: 0, whole: 0, incremental: 0, nothing: 0, passes: 0, incPx: 0, canvasPx: 0,
  diffFrames: 0, diffMax: 0, diffAt: '', diffKinds: { whole: 0, incremental: 0, nothing: 0 } as Record<string, number>,
  apps: 0, afterRebuild: 0, configs: [] as string[], lost: false,
  looks: 0, stillFound: false, looksAt: -1,
  // EDGE: a still person lifted half over the backdrop above the art, then put back (the clear's pin).
  edgeAt: -1, edgeCheckAt: -1, edgeCfg: '', edgeKind: '', edgeBackdropPx: -1, edgeDiff: 0,
  badFrames: [] as Array<{ at: number; kind: string; bad: number; box: number[]; rects: Rect[] | string }>,
  errors: [] as string[]
};
let renders = 0;
let progressPhase = 'startup', progressStep = 'awaiting first render';
let lastReportedFrames = -1, lastReportedStep = '';
const reportProgress = (force = false) => {
  const changedStep = progressStep !== lastReportedStep;
  if (!force && !changedStep && renders % 60 !== 0 && !(out.frames === 1 && lastReportedFrames !== out.frames)) return;
  lastReportedFrames = out.frames;
  lastReportedStep = progressStep;
  window.harness.progress({ frames: out.frames, renders, phase: progressPhase, step: progressStep });
};
let done: (() => void) | null = null;
let hostBox: HTMLDivElement | null = null;
let lastApp: unknown = null;
let agentsNow: any[] = [];
// LOOKS: a person (an interactive sprite of the shared layer) that has not moved since 'pick'.
let picked: Array<{ s: any; x: number; y: number }> = [], still: any = null, kept: { s: any; was: object } | null = null;
let calm = 0, looksAt = -1, lastKind = 'whole';
let hold: (() => void) | null = null;
let edgeHold: (() => void) | null = null, edgeP: { s: any; x: number } | null = null, edgeRect: number[] | null = null;
const read = (gl: WebGL2RenderingContext, W: number, H: number) => {
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
};

const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: any) {
  realRender.call(this);
  renders += 1;
  const app = this, S = app.__tesScene;
  try {
    const gl = app.renderer?.gl as WebGL2RenderingContext | undefined;
    if (S && gl && !gl.isContextLost()) {
      progressPhase = 'render';
      if (app !== lastApp) { lastApp = app; out.apps++; }
      if (out.lost) out.afterRebuild++;
      out.frames++;
      const W = app.canvas.width, H = app.canvas.height;
      const cfg = `${W}x${H}@${app.renderer.resolution}`;
      if (!out.configs.includes(cfg)) out.configs.push(cfg);
      const todo = S.lastPaint as 'full' | Rect[];
      const kind = todo === 'full' ? 'whole' : todo.length ? 'incremental' : 'nothing';
      lastKind = kind;
      if (kind === 'whole') out.whole++;
      else if (kind === 'nothing') out.nothing++;
      else { out.incremental++; out.passes += todo.length; out.incPx += todo.reduce((s, r) => s + r.w * r.h, 0); out.canvasPx += W * H; }
      const drawn = read(gl, W, H);
      S.damage.invalidate();
      app.renderer.render({ container: app.stage });
      const whole = read(gl, W, H);
      let bad = 0; const bb = [W, H, -1, -1];
      for (let i = 0; i < drawn.length; i += 4) {
        if (drawn[i] === whole[i] && drawn[i + 1] === whole[i + 1] && drawn[i + 2] === whole[i + 2] && drawn[i + 3] === whole[i + 3]) continue;
        bad++;
        const X = (i / 4) % W, Y = H - 1 - Math.floor(i / 4 / W);
        bb[0] = Math.min(bb[0], X); bb[1] = Math.min(bb[1], Y); bb[2] = Math.max(bb[2], X); bb[3] = Math.max(bb[3], Y);
      }
      if (bad) {
        out.diffFrames++;
        out.diffKinds[kind]++;
        if (out.badFrames.length < 20) out.badFrames.push({ at: renders, kind, bad, box: bb, rects: todo === 'full' ? 'full' : todo });
        if (bad > out.diffMax) { out.diffMax = bad; out.diffAt = `render ${renders}, ${cfg}, ${kind}`; }
        if (renders === out.edgeCheckAt) out.edgeDiff = bad;
      }
      if (renders === out.edgeCheckAt && edgeRect) {
        // The vacuity guard: with the person back, its lifted rect must hold backdrop px in a whole
        // draw, or an art or framing change has left the clear nothing to clear here.
        const bg = app.renderer.background.color.toArray().map((v: number) => Math.round(v * 255));
        const [x0, y0, x1, y1] = edgeRect;
        let c = 0;
        for (let Y = Math.max(0, y0); Y < Math.min(H, y1); Y++) for (let X = Math.max(0, x0); X < Math.min(W, x1); X++) {
          const i = ((H - 1 - Y) * W + X) * 4;
          if (whole[i] === bg[0] && whole[i + 1] === bg[1] && whole[i + 2] === bg[2]) c++;
        }
        out.edgeBackdropPx = c; out.edgeCfg = cfg; out.edgeKind = kind; edgeRect = null;
      }
    }
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  const rz = RESIZES.find((q) => q.at === renders);
  if (rz && hostBox) { progressStep = `resize ${rz.w}x${rz.h}`; hostBox.style.width = rz.w + 'px'; hostBox.style.height = rz.h + 'px'; }
  const sel = SELECTS.find((q) => q.at === renders);
  if (sel) { progressStep = `select ${sel.id}`; useStore.setState({ selectedId: sel.id } as never); }
  const cr = CREW.find((q) => q.at === renders);
  if (cr) {
    if (cr.leave) agentsNow = agentsNow.filter((a) => a.id !== cr.leave);
    if (cr.back) agentsNow = [...agentsNow, agents.find((a) => a.id === cr.back)!];
    if (cr.status) agentsNow = agentsNow.map((a) => (a.id === cr.status![0] ? { ...a, status: cr.status![1], action: cr.status![1] === 'working' ? 'Edit' : 'awaiting' } : a));
    useStore.setState({ agents: agentsNow } as never);
  }
  calm = lastKind === 'whole' || out.lost ? 0 : calm + 1; // (the check's own whole draw is not the frame's)
  if (looksAt < 0 && renders >= LOOKS_FROM && calm >= 8) looksAt = renders;
  const lk = looksAt < 0 ? undefined : LOOKS.find((q) => q.at === renders - looksAt);
  const layer = this.__tesScene?.sortLayer;
  if (lk && layer) {
    if (lk.look === 'pick') out.looksAt = looksAt;
    if (lk.look === 'pick') picked = layer.children.filter((c: any) => c.eventMode === 'static').map((s: any) => ({ s, x: s.x, y: s.y }));
    else if (lk.look.startsWith('layer')) {
      if (lk.look === 'layerAlpha') layer.alpha = 0.6;
      else if (lk.look === 'layerHidden') layer.renderable = false;
      else { layer.alpha = 1; layer.renderable = true; }
      out.looks++;
    } else {
      const stills = () => picked.filter((p) => p.s.x === p.x && p.s.y === p.y).map((p) => p.s);
      if (!still) { still = stills()[0] ?? null; out.stillFound = !!still; }
      if (lk.look === 'back') {
        if (hold) { this.ticker.remove(hold); hold = null; }
        if (kept) Object.assign(kept.s, kept.was);
        kept = null; out.looks++;
      }
      else if (lk.look === 'behind') {
        // A still person whose move behind every prop changes the picture (one over a chair or desk)
        // outside the rects the frame drew anyway (thought clouds are drawn every frame): each is tried
        // with whole draws, and the canvas is left drawn whole in the state as it was.
        const drew = this.__tesScene.lastPaint as 'full' | Rect[];
        const anyway = (k: number) => { const X = (k / 4) % W, Y = H - 1 - Math.floor(k / 4 / W); return drew !== 'full' && drew.some((q) => X >= q.x && X < q.x + q.w && Y >= q.y && Y < q.y + q.h); };
        const gl = this.renderer.gl as WebGL2RenderingContext, W = this.canvas.width, H = this.canvas.height;
        const whole = () => { this.__tesScene.damage.invalidate(); this.renderer.render({ container: this.stage }); return read(gl, W, H); };
        let deep: any = null;
        for (const s of stills()) {
          const z = s.zIndex;
          s.zIndex = -1; const a = whole(); s.zIndex = z; const b = whole();
          if (a.some((v, k) => v !== b[k] && !anyway(k - (k % 4)))) { deep = s; break; }
        }
        if (deep) {
          // The floor's own depth sort (each tick a walker changes the order) sets every zIndex again,
          // so the change is held by a tick after the floor's (priority 0) and before the render (-25);
          // put back, the person gets the depth the floor last gave it.
          const was = { zIndex: deep.zIndex };
          kept = { s: deep, was };
          hold = () => { if (deep.zIndex !== -1) was.zIndex = deep.zIndex; deep.zIndex = -1; };
          this.ticker.add(hold, null, -10);
          hold();
          out.looks++;
        }
      } else if (still) {
        kept = { s: still, was: { alpha: still.alpha, tint: still.tint, blendMode: still.blendMode } };
        if (lk.look === 'alpha') still.alpha = 0.5;
        else if (lk.look === 'tint') still.tint = 0xff6040;
        else still.blendMode = 'add';
        out.looks++;
      }
    }
  }
  // EDGE (at 700x470@1, n = 1, the horizontal axis is uncovered): a still person is moved so its sprite
  // straddles the outer left lip, held 3 frames by a tick after the floor's, then put back. On the
  // frame it goes back, its old rect over the backdrop is drawn again with nothing in it: only the
  // clear inside the scissor takes its px away.
  // (The canvas takes a resize a few frames late: the step waits for the last pane to be drawn. It
  // also waits for the LOOKS to end, so the two never hold the same person.)
  const looksEnd = looksAt + LOOKS[LOOKS.length - 1].at;
  if (out.edgeAt < 0 && renders >= EDGE_FROM && calm >= 8 && looksAt >= 0 && renders > looksEnd && out.configs.length === RESIZES.length + 1) out.edgeAt = renders;
  const S2 = this.__tesScene;
  if (out.edgeAt >= 0 && layer && S2?.bounds) {
    if (renders === out.edgeAt) {
      const s = picked.filter((p) => p.s.x === p.x && p.s.y === p.y).map((p) => p.s)[0];
      if (s) {
        const b = s.getBounds(), left = layer.toGlobal({ x: S2.frame.fit.x0, y: 0 }).x;
        const x = s.x, to = x + (left - b.width / 2 - b.x) / layer.worldTransform.a;
        edgeP = { s, x };
        edgeHold = () => { s.x = to; };
        this.ticker.add(edgeHold, null, -10);
        edgeHold();
      }
    } else if (renders === out.edgeAt + 3 && edgeP) {
      const b = edgeP.s.getBounds(), r = this.renderer.resolution;
      edgeRect = [Math.floor(b.x * r), Math.floor(b.y * r), Math.ceil((b.x + b.width) * r), Math.ceil((b.y + b.height) * r)];
      if (edgeHold) { this.ticker.remove(edgeHold); edgeHold = null; }
      edgeP.s.x = edgeP.x; edgeP = null;
      out.edgeCheckAt = renders + 1;
    }
  }
  if (renders === LOSE_AT) {
    progressStep = 'lose WebGL context';
    const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext) { out.lost = true; ext.loseContext(); }
  }
  reportProgress();
  // The rebuild waits out glRecovery's delay (real time) while the synthetic clock runs on; the
  // run ends once the rebuilt floor has drawn a while too.
  if (renders >= LAST && (!out.lost || out.afterRebuild >= AFTER) && done) { done(); done = null; }
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
    progressPhase = 'pack'; progressStep = 'loading TES pack'; reportProgress(true);
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const box = document.createElement('div');
    box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
    document.body.style.margin = '0';
    document.body.appendChild(box);
    hostBox = box;
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    agentsNow = agents;
    progressPhase = 'mount'; progressStep = 'mounting OfficeFloor'; reportProgress(true);
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    progressPhase = 'render'; progressStep = 'awaiting first render'; reportProgress(true);
    await finished;
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, dpr: window.devicePixelRatio, renders, ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
