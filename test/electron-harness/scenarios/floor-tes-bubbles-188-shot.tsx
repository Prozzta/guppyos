/**
 * SCENARIO - TES-BUBBLES-188 (c): the REAL OfficeFloor drawing the bundled tes pack with every agent
 * at work, so the Captain, Speck1 and Speck2 seats are taken and each person shows a thought cloud.
 * Once all three are seated (and a few frames later, so the clouds have faded in), the canvas is
 * reported whole and as a ZOOM x crop of the Captain/Speck desks, with the geometry the floor drew:
 * each seated person's seat, the drawn sprite rect and the cloud rect, in world pixels.
 * Run on demand: node test/electron-harness/run-floor-tes-bubbles-188-shot.cjs --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Container, Sprite } from 'pixi.js';
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
const MAX_RENDERS = 6000;
const SETTLE = 90; // renders after all three are seated: the clouds fade in
const ZOOM = 4, CROP = { x: 392, y: 96, w: 144, h: 168 }; // world px: the Captain and both Speck desks

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
  if (seatedAt && renders >= seatedAt + SETTLE) {
    const layer = layerOf(this), world = layer?.container.parent as Container | undefined;
    if (!layer || !world) return;
    const sprites = world.children.flatMap((c) => (c as Container).children ?? []).filter((c): c is Sprite => c instanceof Sprite);
    const people = seated.map((p) => {
      const cloud = layer.thoughts.get(p.id)?.bubble.container;
      const b = cloud ? cloud.getLocalBounds() : null;
      // The person's sprite: the one whose frame is drawn over the seat (nearest frame centre).
      const fw = 32, fh = 32;
      const s = sprites.filter((q) => q.width === fw && q.height === fh)
        .sort((a, c) => Math.hypot(a.x + fw / 2 - p.seat!.x, a.y + fh / 2 - p.seat!.y) - Math.hypot(c.x + fw / 2 - p.seat!.x, c.y + fh / 2 - p.seat!.y))[0];
      return {
        id: p.id, seat: p.seat!.name, walker: [p.x, p.y], anchor: (layer as unknown as { anchors: Map<string, unknown> }).anchors.get(p.id) ?? null,
        sprite: s ? { x: s.x, y: s.y, w: s.width, h: s.height } : null,
        cloud: cloud && b ? { x: cloud.x, y: cloud.y, w: b.width * cloud.scale.x, h: b.height * cloud.scale.y, visible: cloud.visible, alpha: cloud.alpha } : null
      };
    });
    const r = this.renderer.resolution, k = world.scale.x;
    const g = world.toGlobal({ x: CROP.x, y: CROP.y });
    const cv = document.createElement('canvas');
    cv.width = CROP.w * ZOOM; cv.height = CROP.h * ZOOM;
    const c2 = cv.getContext('2d')!;
    c2.imageSmoothingEnabled = false;
    c2.drawImage(this.canvas, g.x * r, g.y * r, CROP.w * k * r, CROP.h * k * r, 0, 0, cv.width, cv.height);
    result = { frame: renders, seatedAt, t: Math.round(crew.t), zoom: k, people, png: this.canvas.toDataURL('image/png'), crop: cv.toDataURL('image/png') };
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
