/**
 * SCENARIO - PANEL-BLINK-188 CPU: floor-fps-cpu.tsx with seven agents WORKING (hook working, liveness
 * BUSY_PROGRESSING), warmed until they sit, so the chair panels blink through the measured window; runs
 * idle, tes, tes, idle. run-panel-blink-188-cpu.cjs --station <base StationFloor.tsx> prices the floor
 * without the panels, the same way. What follows is floor-fps-cpu.tsx's own account.
 *
 * SCENARIO - TES-GUPPY-FPS: the REAL OfficeFloor, office and then the bundled tes pack (StationFloor),
 * each measured the same way over a fixed window:
 * - frames: calls of Pixi's Application.render (the ticker's render step), counted for both floors;
 * - CPU: cumulative CPU seconds of the renderer and the GPU process, read by main (harness:cpu);
 * - the page's own rAF rate over the same window, for the display rate the floor is capped against.
 * A hidden window's rAF runs at 1 Hz (and offscreen rendering saturates the GPU process on the
 * frame readback), so the page's requestAnimationFrame is paced here at DISPLAY_HZ, the 165 Hz
 * display measured for LAG-150: both floors see the same simulated display, and their WebGL work
 * still runs for real. 'idle' (nothing mounted) is the baseline the floors are read against.
 * The same four agents stand on both floors. The order alternates (idle, office, tes, office, tes,
 * idle), so drift shows. Run on demand: node test/electron-harness/run-floor-fps-cpu.cjs
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import plan, { type FloorRun } from './floor-fps-cpu-plan';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; cpu: () => Promise<{ renderer: number | null; gpu: number | null }> };
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

const WINDOW_MS = 10_000;
const DISPLAY_HZ = 165;
// The harness's GL is SwiftShader (software); the floor draws at resolution 2, so a full-size box
// is bound by the rasteriser, far under 30 fps. The default 160x100 box lets the frame budget, not
// the rasteriser, set the rate; a plan can ask for a bigger one. Both floors get the same box.
const BOX = plan.box;
{
  // One display frame runs every callback queued for it, as real rAF does.
  let queue = new Map<number, FrameRequestCallback>();
  let seq = 0; let due = performance.now(); let armed = false;
  const frame = () => {
    armed = false;
    const run = queue; queue = new Map();
    const now = performance.now();
    for (const cb of run.values()) cb(now);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.set(++seq, cb);
    if (!armed) {
      armed = true;
      due = Math.max(due + 1000 / DISPLAY_HZ, performance.now());
      window.setTimeout(frame, Math.max(0, due - performance.now()));
    }
    return seq;
  };
  window.cancelAnimationFrame = (id: number) => { queue.delete(id); };
}
const WARM_MS = 15_000; // everyone walks to their seat and sits: the panels blink in the window
const RUNS: FloorRun[] = [{ theme: 'idle' }, { theme: 'tes' }, { theme: 'tes' }, { theme: 'idle' }];
void plan;
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'sky' },
  { id: 'kevin', name: 'Kevin', character: 'kevin', accent: 'mint' },
  { id: 'creed', name: 'Creed', character: 'creed', accent: 'gold' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', status: 'working', action: 'using Bash', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));
const liveness = Object.fromEntries(agents.map((a) => [a.id, {
  agentId: a.id, incarnation: 1, lifecycle: 'LIVE', classification: 'BUSY_PROGRESSING', classifiedSince: Date.now() - 60_000, reason: 'pty-traffic', evidence: { lastPtyTrafficAt: Date.now() - 500 }
}]));

let renders = 0;
let lastStage: unknown = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: { stage: unknown }) { renders += 1; lastStage = this.stage; return realRender.call(this); };

// TES-GUPPY-RASTER: what each frame asks of GL, counted the same way for both floors.
const GL_CALLS = ['drawElements', 'drawArrays', 'bindTexture', 'texImage2D', 'texSubImage2D', 'bufferData', 'bufferSubData', 'useProgram'] as const;
const gl: Record<string, number> = Object.fromEntries(GL_CALLS.map((n) => [n, 0]));
for (const ctx of [WebGL2RenderingContext, WebGLRenderingContext]) {
  const p = ctx.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const n of GL_CALLS) {
    const real = p[n];
    if (typeof real !== 'function') continue;
    p[n] = function (this: unknown, ...a: unknown[]) { gl[n] += 1; return real.apply(this, a); };
  }
}
function census(root: unknown) {
  let sprites = 0; let containers = 0; const textures = new Set<unknown>();
  const walk = (n: Node) => {
    if (!n || n.visible === false) return;
    if (n.texture) { sprites += 1; textures.add((n.texture as { source?: unknown }).source ?? n.texture); }
    else containers += 1;
    for (const c of n.children ?? []) walk(c);
  };
  walk(root as Node);
  return { sprites, containers, textureSources: textures.size };
}

type Node = { children?: Node[]; visible?: boolean; texture?: unknown; eventMode?: string };
/** TES: stage > world > [below, sort layer (statics, and people with eventMode 'static'), above]. */
function hideLayers(stage: unknown, hide: FloorRun['hide']) {
  const world = (stage as Node).children?.[0];
  const [below, sorted, above] = world?.children ?? [];
  for (const h of hide ?? []) {
    if (h === 'below' && below) below.visible = false;
    if (h === 'above' && above) above.visible = false;
    for (const c of sorted?.children ?? []) {
      const person = c.eventMode === 'static';
      if ((h === 'people' && person) || (h === 'statics' && !person)) c.visible = false;
    }
  }
}

async function measure({ theme, hide }: FloorRun) {
  const box = document.createElement('div');
  box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
  document.body.appendChild(box);
  const root = createRoot(box);
  if (theme !== 'idle') await act(async () => { useStore.setState({ officeTheme: theme, agents, liveness, messageQueues: {} } as never); root.render(<OfficeFloor />); });
  for (let i = 0; i < 60 && !box.querySelector('canvas'); i++) await act(async () => { await sleep(150); });
  const canvas = !!box.querySelector('canvas');
  await sleep(WARM_MS);
  if (hide?.length) hideLayers(lastStage, hide);

  let rafs = 0; let live = true;
  const raf = () => { rafs += 1; if (live) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const g0 = { ...gl };
  const c0 = await window.harness.cpu(); const r0 = renders; const t0 = performance.now();
  await sleep(WINDOW_MS);
  const c1 = await window.harness.cpu(); const r1 = renders; const t1 = performance.now();
  const frames = Math.max(1, r1 - r0);
  const perFrame = Object.fromEntries(GL_CALLS.map((n) => [n, Math.round(((gl[n] - g0[n]) / frames) * 10) / 10]));
  live = false;
  const s = (t1 - t0) / 1000;
  const pct = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round(((b - a) / s) * 1000) / 10);
  const out = {
    theme, ...(hide?.length ? { hide } : {}), canvas, seconds: Math.round(s * 100) / 100,
    fps: Math.round(((r1 - r0) / s) * 10) / 10,
    rafHz: Math.round((rafs / s) * 10) / 10,
    rendererCpuPct: pct(c0.renderer, c1.renderer),
    gpuCpuPct: pct(c0.gpu, c1.gpu),
    ...(theme === 'idle' ? {} : { perFrame, scene: census(lastStage) }),
  };
  await act(async () => { root.unmount(); });
  box.remove();
  await sleep(500);
  return out;
}

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const runs = [];
    for (const run of RUNS) runs.push(await measure(run));
    window.harness.report({ ok: true, windowMs: WINDOW_MS, displayHz: DISPLAY_HZ, box: BOX, runs });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
