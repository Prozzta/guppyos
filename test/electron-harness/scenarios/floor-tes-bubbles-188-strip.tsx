/**
 * SCENARIO - TES-BUBBLES-188 (d): the REAL OfficeFloor drawing the bundled tes pack with every agent
 * at work, as a strip: once the Captain/Speck seats are taken, a frame every STEP renders (about
 * 10 s of floor time), FRAMES of them, each with the number of clouds showing. 1.1.87 showed a cloud over
 * every head in every frame; (d) makes most frames show few or none.
 * Run on demand: node test/electron-harness/run-floor-tes-bubbles-188-strip.cjs --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Container } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { Crew } from '../../../src/renderer/src/scene/themes/crew';

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

const BOX = { w: 1000, h: 680 };
const STEP_MS = 1000 / 60;
const MAX_RENDERS = 9000;

Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

let seed = 188;
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

let crew: Crew | null = null;
const tick = Crew.prototype.tick;
Crew.prototype.tick = function (this: Crew, dt: number) { crew = this; return tick.call(this, dt); };

type Layer = { container: Container; thoughts: Map<string, { bubble: { container: Container } }> };
const layerOf = (app: Application): Layer | null => (app as unknown as { __bubbleLayer?: Layer }).__bubbleLayer ?? null;
const SEATS = ['Captain', 'Speck1', 'Speck2'];

let renders = 0, seatedAt = 0;
const STEP = 300, FRAMES = 12;
const frames: Array<{ at: number; clouds: string[]; png: string }> = [];
let result: Record<string, unknown> | null = null;
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  realRender.call(this);
  renders += 1;
  if (result || !crew) { if (renders >= MAX_RENDERS && done) { done(); done = null; } return; }
  const seated = crew.walkers().filter((p) => p.seated && p.seat && SEATS.includes(p.seat.name));
  if (seated.length === SEATS.length && !seatedAt) seatedAt = renders;
  if (!seatedAt || (renders - seatedAt) % STEP !== 0) return;
  const layer = layerOf(this);
  if (!layer) return;
  const clouds = [...layer.thoughts].filter(([, a]) => a.bubble.container.visible && a.bubble.container.alpha > 0.05).map(([id]) => id);
  frames.push({ at: Math.round(crew.t), clouds, png: this.canvas.toDataURL('image/png') });
  if (frames.length === FRAMES) {
    result = { seatedAt, frames };
    if (done) { done(); done = null; }
  }
};

// Everyone at work: the orchestrator takes the Captain's chair, the crew the stations.
const agents = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin', 'creed'].map((id, i) => ({
  id, name: id, character: id === 'god' ? 'michael' : id, accent: 'sky', isGod: i === 0, status: 'working',
  description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: `using Bash ${id}`, progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${id}`
}));

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
    window.harness.report(result ? { ok: true, box: BOX, ...result } : { ok: false, error: `the three seats were not all taken in ${renders} renders (seatedAt ${seatedAt})` });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
