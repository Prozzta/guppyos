/**
 * SCENARIO - TES-BUBBLE-TAIL-SHARP-189: the REAL OfficeFloor, on the tes pack and on the plain office,
 * in three panes (the Human's 575x612, a tall 360x760 and a wide 960x500) on the camera's own fit,
 * every person holding a cloud. Per pane it reports, for every cloud drawn: the head it hangs over
 * (the anchor through the world's transform), its tail's tip, its body and its text's device px per
 * texel and origin, all in device px; plus a PNG of the pane. The DPR is the window's (HARNESS_DPR).
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
    harness: {
      report: (payload: unknown) => void;
      capture: (w: number, h: number) => Promise<{ size: { width: number; height: number }; png: string }>;
    };
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PANES = [{ name: 'human', w: 575, h: 612 }, { name: 'tall', w: 360, h: 760 }, { name: 'wide', w: 960, h: 500 }];

Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
window.cancelAnimationFrame = (id: number) => clearTimeout(id);
let seed = 189;
Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

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

const errors: string[] = [];
window.addEventListener('error', (e) => { if (errors.length < 20) errors.push(String(e.error?.stack || e.message)); });
window.addEventListener('unhandledrejection', (e) => { if (errors.length < 20) errors.push('rej ' + String((e as any).reason?.stack || (e as any).reason)); });
let app: any = null;
const appRender = Application.prototype.render;
Application.prototype.render = function (this: any) {
  if (this.__tesScene || this.__officeThoughts) app = this;
  return appRender.call(this);
};

const crew = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'rose' },
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));
const LINES: Record<string, string> = { god: 'Status report, Number One.', dwight: 'Shields at full.', jim: 'Course plotted.', andy: 'Coffee is ready.' };

type Cloud = { id: string; text: string; head: { x: number; y: number }; tailTip: { x: number; y: number }; body: { x: number; y: number; w: number; h: number }; bodyMidX: number; textInfo: { devPerTexel: number; originDev: { x: number; y: number }; scaleMode: string } };

/** Every cloud drawn, in device px, with the head (world anchor) it hangs over. */
function clouds(heads: Map<string, { x: number; y: number }>, bubbleOf: Map<string, any>, world: any): Cloud[] {
  const r = app.renderer.resolution;
  const out: Cloud[] = [];
  for (const [id, b] of bubbleOf) {
    const a = heads.get(id);
    if (!a || b.state === 'hidden' || !b.container.visible || !b.container.parent) continue;
    const head = world.toGlobal({ x: a.x, y: a.y });
    const tip = b.tip.getBounds(), body = b.bg.getBounds(), m = b.label.worldTransform;
    out.push({
      id, text: b.label.text,
      head: { x: head.x * r, y: head.y * r },
      tailTip: { x: (tip.x + tip.width / 2) * r, y: (tip.y + tip.height / 2) * r },
      body: { x: body.x * r, y: body.y * r, w: body.width * r, h: body.height * r },
      bodyMidX: (body.x + body.width / 2) * r,
      // The Text is rasterised at the renderer's resolution: a texel is m.a device px.
      textInfo: { devPerTexel: m.a, originDev: { x: m.tx * r, y: m.ty * r }, scaleMode: String(b.label.textureStyle?.scaleMode) },
    });
  }
  return out;
}

async function floor(theme: 'tes' | 'office', box: HTMLDivElement) {
  app = null;
  const agents = crew.map((a) => ({ ...a, status: 'working', action: theme === 'office' ? LINES[a.id] : 'awaiting' }));
  const root = createRoot(box);
  await act(async () => { useStore.setState({ officeTheme: theme, agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
  for (let i = 0; i < 80 && !app; i++) await wait(100);
  if (!app) throw new Error(`the ${theme} scene was not mounted`);
  const panes: unknown[] = [];
  for (const pane of PANES) {
    box.style.width = `${pane.w}px`; box.style.height = `${pane.h}px`;
    if (theme === 'tes') {
      const say = () => { for (const a of crew) app.__bubbleLayer.say(a.id, LINES[a.id], { ttl: 600_000, key: 'tail-sharp' }); };
      say(); await wait(4000); say(); await wait(600);
    } else await wait(4500); // the office camera eases to its fit
    // The heads and the clouds are read together, between two frames (the office's people walk).
    const read = (): Cloud[] => {
      if (theme === 'tes') {
        const layer = app.__bubbleLayer;
        return clouds(layer.anchors, new Map([...layer.thoughts].map(([id, t]: [string, any]) => [id, t.bubble])), app.__tesScene.world);
      }
      const o = app.__officeThoughts, heads = new Map(), bubbleOf = new Map();
      for (const [id, rt] of o.runtimes as Map<string, any>) { heads.set(id, rt.character.getPixelPosition()); bubbleOf.set(id, rt.character.thought); }
      return clouds(heads, bubbleOf, o.world);
    };
    const world = theme === 'tes' ? app.__tesScene.world : app.__officeThoughts.world;
    const at = read();
    const shot = await window.harness.capture(pane.w, pane.h);
    panes.push({ ...pane, worldScale: world.scale.x, worldPos: { x: world.x, y: world.y }, resolution: app.renderer.resolution, clouds: at, png: shot.png });
  }
  await act(async () => { root.unmount(); });
  return panes;
}

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    document.body.style.margin = '0';
    const result: Record<string, unknown> = { dpr: window.devicePixelRatio };
    for (const theme of ['tes', 'office'] as const) {
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:0;top:0';
      document.body.appendChild(box);
      result[theme] = await floor(theme, box);
      box.remove();
    }
    window.harness.report({ ok: true, errors, ...result });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
