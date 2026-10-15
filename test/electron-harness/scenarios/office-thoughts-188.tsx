/**
 * SCENARIO - TES-BUBBLES-188 SHOULD-3: the REAL OfficeFloor (the plain office, no station pack) with
 * agents thinking (the animated '.', '..', '...' cloud, the narrowest the office draws) and working
 * (a text cloud). The clock and Math.random are fixed, so the same source draws the same pixels; the
 * canvas is reported at FRAMES renders, across several thinking-dots cycles. The runner writes
 * them as PNGs and their hashes, so two builds can be compared byte for byte.
 * Run on demand: node test/electron-harness/run-office-thoughts-188.cjs --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';

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
// From 4 s on (the clouds are up), every 9 renders: three shots per 0.45 s dots phase, 4 cycles.
const FRAMES = Array.from({ length: 36 }, (_, i) => 240 + i * 9);

Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

let n = 0;
let seed = 188;
Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
Date.now = () => 1_800_000_000_000 + n * STEP_MS;

{
  let queue = new Map<number, FrameRequestCallback>();
  let seq = 0; let armed = false;
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

let renders = 0;
const shots: Array<{ frame: number; png: string }> = [];
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  realRender.call(this);
  renders += 1;
  if (FRAMES.includes(renders)) shots.push({ frame: renders, png: this.canvas.toDataURL('image/png') });
  if (renders >= FRAMES[FRAMES.length - 1] && done) { done(); done = null; }
};

// Thinking (empty action: the dots) and working (a line of text), as the office floor shows them.
const agents = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin', 'creed'].map((id, i) => ({
  id, name: id, character: id === 'god' ? 'michael' : id, accent: 'sky', isGod: i === 0, status: i % 2 ? 'thinking' : 'working',
  description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: i % 2 ? '' : `using Bash ${id}`, progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${id}`
}));

window.__harnessRun = async () => {
  try {
    const box = document.createElement('div');
    box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
    document.body.appendChild(box);
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'office', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    await finished;
    await act(async () => { root.unmount(); });
    window.harness.report(shots.length === FRAMES.length ? { ok: true, box: BOX, shots } : { ok: false, error: `${shots.length} of ${FRAMES.length} shots in ${renders} renders` });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
