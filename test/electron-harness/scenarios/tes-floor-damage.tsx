/**
 * SCENARIO - PERF-FLOOR-FILL-188, RENDERED: the TES floor draws again only the rects that changed
 * (damage.ts); this proves a frame so drawn is the frame a full draw makes, on EVERY frame.
 * The real OfficeFloor draws the bundled tes pack with a crew on a synthetic clock while the plan
 * resizes the host box, selects crew (camera nudges), takes an agent away and back, flips statuses
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
import { BOX, RESIZES, SELECTS, CREW, LOSE_AT, LAST, AFTER } from './tes-floor-damage-plan';

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
  badFrames: [] as Array<{ at: number; kind: string; bad: number; box: number[]; rects: Rect[] | string }>,
  errors: [] as string[]
};
let renders = 0;
let done: (() => void) | null = null;
let hostBox: HTMLDivElement | null = null;
let lastApp: unknown = null;
let agentsNow: any[] = [];
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
      if (app !== lastApp) { lastApp = app; out.apps++; }
      if (out.lost) out.afterRebuild++;
      out.frames++;
      const W = app.canvas.width, H = app.canvas.height;
      const cfg = `${W}x${H}@${app.renderer.resolution}`;
      if (!out.configs.includes(cfg)) out.configs.push(cfg);
      const todo = S.lastPaint as 'full' | Rect[];
      const kind = todo === 'full' ? 'whole' : todo.length ? 'incremental' : 'nothing';
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
      }
    }
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  const rz = RESIZES.find((q) => q.at === renders);
  if (rz && hostBox) { hostBox.style.width = rz.w + 'px'; hostBox.style.height = rz.h + 'px'; }
  const sel = SELECTS.find((q) => q.at === renders);
  if (sel) useStore.setState({ selectedId: sel.id } as never);
  const cr = CREW.find((q) => q.at === renders);
  if (cr) {
    if (cr.leave) agentsNow = agentsNow.filter((a) => a.id !== cr.leave);
    if (cr.back) agentsNow = [...agentsNow, agents.find((a) => a.id === cr.back)!];
    if (cr.status) agentsNow = agentsNow.map((a) => (a.id === cr.status![0] ? { ...a, status: cr.status![1], action: cr.status![1] === 'working' ? 'Edit' : 'awaiting' } : a));
    useStore.setState({ agents: agentsNow } as never);
  }
  if (renders === LOSE_AT) {
    const gl = this.renderer?.gl as WebGL2RenderingContext | undefined;
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (ext) { out.lost = true; ext.loseContext(); }
  }
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
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    await finished;
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, dpr: window.devicePixelRatio, renders, ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
