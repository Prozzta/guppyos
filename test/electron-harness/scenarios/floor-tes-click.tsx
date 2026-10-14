/**
 * SCENARIO - TES-GUPPY-RASTER: the crew of a settled, CACHED TES floor can be clicked. The real
 * OfficeFloor draws the bundled tes pack at 960x640 on a synthetic clock (as floor-tes-shot), and
 * once the cache passes have run (they scissor), the frames stop and each person gets a real
 * pointerdown/pointerup on the canvas at its centre - between frames, which is when the browser
 * dispatches pointer events, so Pixi hit-tests the sprites as the last frame left them.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Sprite, type Container } from 'pixi.js';
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

const STEP_MS = 1000 / 60;
const LAST_FRAME = 600; // well past the camera's landing (about 4 s), so the cache is on

let seed = 12345;
Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// A synthetic clock that stops for good once `frozen` is set: no frame runs during the clicks.
let frozen = false;
{
  let queue = new Map<number, FrameRequestCallback>();
  let seq = 0; let n = 0; let armed = false;
  performance.now = () => n * STEP_MS;
  const frame = () => {
    armed = false;
    if (frozen) return;
    n += 1;
    const run = queue; queue = new Map();
    for (const cb of run.values()) cb(n * STEP_MS);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.set(++seq, cb);
    if (!armed && !frozen) { armed = true; window.setTimeout(frame, 0); }
    return seq;
  };
  window.cancelAnimationFrame = (id: number) => { queue.delete(id); };
}

// The cache passes are the only scissored draws, so a scissor in the last frame means it was cached.
let scissors = 0;
const realScissor = WebGL2RenderingContext.prototype.scissor;
WebGL2RenderingContext.prototype.scissor = function (this: WebGL2RenderingContext, ...a: [number, number, number, number]) {
  scissors += 1;
  return realScissor.apply(this, a);
};

let app: Application | null = null;
let renders = 0, lastFrameScissors = -1;
let done: (() => void) | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  const before = scissors;
  realRender.call(this);
  app = this;
  renders += 1;
  if (renders >= LAST_FRAME && done) { frozen = true; lastFrameScissors = scissors - before; done(); done = null; }
};

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'working' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', status: 'idle' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'rose', status: 'working' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

/** The person sprites: the floor's only sprites that answer a tap. */
const people = (c: Container, out: Sprite[] = []): Sprite[] => {
  for (const ch of c.children) {
    if (ch instanceof Sprite && ch.listenerCount('pointertap') > 0) out.push(ch);
    people(ch as Container, out);
  }
  return out;
};

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const box = document.createElement('div');
    box.style.cssText = 'width:960px;height:640px;position:relative';
    document.body.appendChild(box);
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {}, selectedId: null } as never); root.render(<OfficeFloor />); });
    await finished;
    const a = app as Application | null;
    if (!a) throw new Error('no render');
    const canvas = a.canvas as HTMLCanvasElement;
    const cr = canvas.getBoundingClientRect();
    const sprites = people(a.stage);
    const byId = new Map(agents.map((g) => [g.id, g]));
    const clicks: Array<{ selected: string | null; visible: boolean }> = [];
    let pid = 1;
    for (const sp of sprites) {
      useStore.setState({ selectedId: null } as never);
      const b = sp.getBounds();
      const init = { bubbles: true, cancelable: true, composed: true, pointerId: ++pid, pointerType: 'mouse', isPrimary: true,
        button: 0, clientX: cr.left + b.x + b.width / 2, clientY: cr.top + b.y + b.height / 2 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      clicks.push({ selected: useStore.getState().selectedId, visible: sp.visible });
    }
    const report = { ok: true, renders, lastFrameScissors, people: sprites.length, known: clicks.filter((c) => c.selected && byId.has(c.selected)).length, clicks };
    await act(async () => { root.unmount(); });
    box.remove();
    window.harness.report(report);
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
