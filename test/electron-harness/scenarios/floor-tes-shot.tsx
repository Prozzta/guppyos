/**
 * SCENARIO - TES-GUPPY-RASTER: deterministic screenshots of the REAL OfficeFloor drawing the bundled
 * tes pack (StationFloor), so two builds of the floor can be compared pixel for pixel.
 * - Math.random is a seeded generator before the floor mounts (the crew's walks and seats use it);
 * - requestAnimationFrame runs on a synthetic clock, frame n at n * STEP_MS, as fast as the page
 *   can draw, and performance.now() reads the same clock (Pixi's ticker takes its start time from
 *   it), so the ticker's deltas (and the 30 fps budget's skips) are the same on every run;
 * - after the render of each frame in SHOT_FRAMES, the canvas is read (same task, so the drawing
 *   buffer is still the frame just drawn) and reported as a PNG data URL.
 * Run on demand: node test/electron-harness/run-floor-tes-shot.cjs [--station <StationFloor.tsx>] --out <dir>
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

const BOX = { w: 960, h: 640 };
const STEP_MS = 1000 / 60;
const SHOT_FRAMES = [1, 90, 300, 600];

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

const shots: Array<{ frame: number; png: string }> = [];
let renders = 0;
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: { canvas: HTMLCanvasElement }) {
  realRender.call(this);
  renders += 1;
  if (SHOT_FRAMES.includes(renders)) shots.push({ frame: renders, png: this.canvas.toDataURL('image/png') });
  if (renders >= SHOT_FRAMES[SHOT_FRAMES.length - 1] && done) { done(); done = null; }
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
    document.body.appendChild(box);
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    await finished;
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, box: BOX, stepMs: STEP_MS, shots });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
