/**
 * SCENARIO - COFFEE-NEVER-186: screenshots of the REAL OfficeFloor drawing the bundled tes pack
 * (StationFloor) while the crew go for coffee, to check by eye where the mug sits: in the hand
 * (each facing) and parked at a station. As floor-tes-shot.tsx: a seeded Math.random and a
 * synthetic rAF clock. The crew is reached by wrapping Crew.prototype.tick; on the first frames
 * where coffeeProps shows a cup in each facing, a parked mug and a coffee line, the canvas is read
 * (whole, and a 6x crop around that mug) and reported as PNG data URLs.
 * Run on demand: node test/electron-harness/run-floor-tes-coffee-shot.cjs --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Container } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { Crew } from '../../../src/renderer/src/scene/themes/crew';
import { coffeeProps, type CoffeeProp } from '../../../src/renderer/src/scene/themes/coffeeProps';

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
const MAX_RENDERS = 40000; // about 22 min of floor time at the 30 fps budget
const ZOOM = 6, CROP = 40; // a CROP x CROP world-pixel window around the mug, drawn ZOOM times

// The window is hidden (show:false), and a hidden document pauses the floor's ticker (as floor-framing-shot.tsx).
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

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

let crew: Crew | null = null;
const tick = Crew.prototype.tick;
Crew.prototype.tick = function (this: Crew, dt: number) { crew = this; return tick.call(this, dt); };

/** The floor's world container: the parent of the bubble layer StationFloor hangs on the app. */
const worldOf = (app: Application): Container | null => ((app as unknown as { __bubbleLayer?: { container: Container } }).__bubbleLayer?.container.parent as Container) ?? null;

const wanted = ['cup:down', 'cup:up', 'cup:left', 'cup:right', 'mug', 'say'];
const shots: Array<{ label: string; frame: number; t: number; at?: [number, number]; text?: string; png: string; crop?: string }> = [];
let renders = 0;
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  realRender.call(this);
  renders += 1;
  if (crew && renders % 2 === 0) {
    const props = coffeeProps(crew);
    for (const label of wanted) {
      if (shots.some((s) => s.label === label)) continue;
      const p = props.find((q: CoffeeProp) => (label === 'mug' ? q.kind === 'mug' : label === 'say' ? q.kind === 'say' : q.kind === 'cup' && `cup:${q.dir}` === label));
      if (!p) continue;
      // A cup or parked mug: crop around it (a cup at the person's feet, so a little above).
      let at: [number, number] | undefined;
      if (p.kind === 'cup') at = [p.x, p.y - 12];
      else if (p.kind === 'mug') at = [p.x + 2, p.y - 2];
      else { const w = crew.get(p.id); if (w) at = [w.x, w.y - 16]; }
      const shot: (typeof shots)[number] = { label, frame: renders, t: Math.round(crew.t), png: this.canvas.toDataURL('image/png'), ...(at ? { at } : {}), ...(p.kind === 'say' ? { text: p.text } : {}) };
      const world = worldOf(this);
      if (at && world) {
        const r = this.renderer.resolution, k = world.scale.x;
        const g = world.toGlobal({ x: at[0] - CROP / 2, y: at[1] - CROP / 2 });
        const cv = document.createElement('canvas');
        cv.width = cv.height = CROP * ZOOM;
        const c2 = cv.getContext('2d')!;
        c2.imageSmoothingEnabled = false;
        c2.drawImage(this.canvas, g.x * r, g.y * r, CROP * k * r, CROP * k * r, 0, 0, cv.width, cv.height);
        shot.crop = cv.toDataURL('image/png');
      }
      shots.push(shot);
    }
  }
  if ((shots.length === wanted.length || renders >= MAX_RENDERS) && done) { done(); done = null; }
};

// Everyone idle, so the coffee picker can send any of them.
const agents = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin'].map((id, i) => ({
  id, name: id, character: id === 'god' ? 'michael' : id, accent: 'sky', isGod: i === 0, status: 'idle',
  description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${id}`
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
    window.harness.report({ ok: true, box: BOX, renders, missing: wanted.filter((l) => !shots.some((s) => s.label === l)), shots });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
