/**
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
// is bound by the rasteriser, far under 30 fps. A small box lets the frame budget, not the
// rasteriser, set the rate. Both floors get the same box.
const BOX = { w: 160, h: 100 };
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
const WARM_MS = 3_000;
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', status: 'idle', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

let renders = 0;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: unknown) { renders += 1; return realRender.call(this); };

async function measure(theme: string) {
  const box = document.createElement('div');
  box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
  document.body.appendChild(box);
  const root = createRoot(box);
  if (theme !== 'idle') await act(async () => { useStore.setState({ officeTheme: theme, agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
  for (let i = 0; i < 60 && !box.querySelector('canvas'); i++) await act(async () => { await sleep(150); });
  const canvas = !!box.querySelector('canvas');
  await sleep(WARM_MS);

  let rafs = 0; let live = true;
  const raf = () => { rafs += 1; if (live) requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  const c0 = await window.harness.cpu(); const r0 = renders; const t0 = performance.now();
  await sleep(WINDOW_MS);
  const c1 = await window.harness.cpu(); const r1 = renders; const t1 = performance.now();
  live = false;
  const s = (t1 - t0) / 1000;
  const pct = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round(((b - a) / s) * 1000) / 10);
  const out = {
    theme, canvas, seconds: Math.round(s * 100) / 100,
    fps: Math.round(((r1 - r0) / s) * 10) / 10,
    rafHz: Math.round((rafs / s) * 10) / 10,
    rendererCpuPct: pct(c0.renderer, c1.renderer),
    gpuCpuPct: pct(c0.gpu, c1.gpu),
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
    for (const theme of ['idle', 'office', 'tes', 'office', 'tes', 'idle']) runs.push(await measure(theme));
    window.harness.report({ ok: true, windowMs: WINDOW_MS, displayHz: DISPLAY_HZ, box: BOX, runs });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
