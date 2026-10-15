/**
 * SCENARIO - TES-FLOOR-COLLISION-188: the REAL OfficeFloor drawing the bundled tes pack with nine agents at work,
 * so every seat is taken. For the Captain, Chair3/4/5 (Jim's crops) and Chair6 it films the sitter's way in: every render while that
 * walker is within REACH px of its seat (until it has sat a while) is cropped at ZOOM x around the seat; frames
 * where nothing moved are dropped and up to FRAMES are kept, laid side by side as one strip per seat; and the
 * tail, every kept frame of the last TAIL before the sit plus the first 2 seated (where a back approach spot
 * lies in the chair's art: the SHOULD-1 frames), as a second strip.
 * Run on demand: node test/electron-harness/run-floor-tes-chairs-188-entry.cjs --out <dir>
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
const REACH = 34, SAT = 30, FRAMES = 10, TAIL = 8, ZOOM = 4;
// world px crops: the seat with its approach spot (Captain: front, below; Chair6: back, to the left)
const SHOTS: Record<string, { x: number; y: number; w: number; h: number }> = {
  Captain: { x: 432, y: 140, w: 64, h: 72 },
  Chair6: { x: 524, y: 226, w: 64, h: 60 },
  Chair3: { x: 345, y: 150, w: 56, h: 56 },
  Chair4: { x: 345, y: 229, w: 56, h: 56 },
  Chair5: { x: 522, y: 152, w: 64, h: 56 },
};

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

type Shot = { frames: Array<{ c: HTMLCanvasElement; at: [number, number]; seated: boolean; render: number }>; sat: number; done: boolean };
const shots = new Map<string, Shot>(Object.keys(SHOTS).map((k) => [k, { frames: [], sat: 0, done: false }]));
let renders = 0;
let result: Record<string, unknown> | null = null;
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  realRender.call(this);
  renders += 1;
  if (result || !crew) { if (renders >= MAX_RENDERS && done) { done(); done = null; } return; }
  const world = (this as unknown as { __bubbleLayer?: { container: Container } }).__bubbleLayer?.container.parent as Container | undefined;
  if (!world) return;
  for (const [name, sh] of shots) {
    if (sh.done) continue;
    const p = crew.walkers().find((w) => w.seat && w.seat.name === name);
    if (!p || !p.seat) continue;
    if (Math.hypot(p.x - p.seat.x, p.y - p.seat.y) > REACH && !p.seated) continue;
    const last = sh.frames.at(-1);
    if (!last || Math.hypot(last.at[0] - p.x, last.at[1] - p.y) >= 2 || last.seated !== p.seated) {
      const C = SHOTS[name], r = this.renderer.resolution, k = world.scale.x, g = world.toGlobal({ x: C.x, y: C.y });
      const cv = document.createElement('canvas');
      cv.width = C.w * ZOOM; cv.height = C.h * ZOOM;
      const c2 = cv.getContext('2d')!;
      c2.imageSmoothingEnabled = false;
      c2.drawImage(this.canvas, g.x * r, g.y * r, C.w * k * r, C.h * k * r, 0, 0, cv.width, cv.height);
      sh.frames.push({ c: cv, at: [p.x, p.y], seated: p.seated, render: renders });
    }
    if (p.seated && ++sh.sat >= SAT) sh.done = true;
  }
  if ([...shots.values()].every((s) => s.done)) {
    const out: Record<string, unknown> = {};
    const stripOf = (name: string, pick: Shot['frames']): string => {
      const C = SHOTS[name], gap = 8, W = pick.length * (C.w * ZOOM + gap) - gap;
      const strip = document.createElement('canvas');
      strip.width = W; strip.height = C.h * ZOOM;
      const s2 = strip.getContext('2d')!;
      s2.fillStyle = '#ff00ff'; s2.fillRect(0, 0, W, strip.height);
      pick.forEach((f, i) => s2.drawImage(f.c, i * (C.w * ZOOM + gap), 0));
      return strip.toDataURL('image/png');
    };
    const meta = (pick: Shot['frames']) => pick.map((f) => ({ render: f.render, at: f.at.map((v) => Math.round(v * 10) / 10), seated: f.seated }));
    for (const [name, sh] of shots) {
      const n = sh.frames.length, pick = n <= FRAMES ? sh.frames : Array.from({ length: FRAMES }, (_, i) => sh.frames[Math.round(i * (n - 1) / (FRAMES - 1))]);
      const sat = sh.frames.findIndex((f) => f.seated), end = sat < 0 ? n : sat;
      const tail = sh.frames.slice(Math.max(0, end - TAIL), end + 2);
      out[name] = { strip: stripOf(name, pick), frames: meta(pick), tail: stripOf(name, tail), tailFrames: meta(tail), recorded: n };
    }
    result = { frame: renders, t: Math.round(crew.t), shots: out };
    if (done) { done(); done = null; }
  }
};

// Nine at work: the orchestrator takes the Captain's chair, the crew every station down to Chair6.
const agents = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin', 'creed', 'oscar', 'angela'].map((id, i) => ({
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
    const status = Object.fromEntries([...shots].map(([k, s]) => [k, { recorded: s.frames.length, done: s.done }]));
    window.harness.report(result ? { ok: true, box: BOX, ...result } : { ok: false, error: `not every entry was filmed in ${renders} renders: ${JSON.stringify(status)}` });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
