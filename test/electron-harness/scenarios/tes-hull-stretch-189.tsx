/**
 * RENDERED regression: the TES hull ends at the pack art's real bottom.  A tall pane must not
 * turn its last hull row into a wall merely because there is unused vertical viewport below it.
 * The declared back-wall-to-front-lip / outer-lip box must instead use the largest uniform fit
 * and sit at the pane's centre. It returns jailed renders for release evidence.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, RenderTexture } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { PACK_ART } from '../../../src/renderer/src/scene/themes/framing';

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
const aspects = [
  { name: 'tall', w: 360, h: 760 },
  { name: 'screenshot', w: 458, h: 587 },
  { name: 'human', w: 575, h: 612 },
  { name: 'square', w: 640, h: 640 },
  { name: 'wide', w: 960, h: 500 },
];

// A hidden BrowserWindow otherwise throttles the floor ticker.  The real app is visible.
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
window.cancelAnimationFrame = (id: number) => clearTimeout(id);

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

let app: any = null;
const appRender = Application.prototype.render;
Application.prototype.render = function (this: any) {
  if (this.__tesScene) app = this;
  return appRender.call(this);
};

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'idle' },
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

function placement() {
  const S = app?.__tesScene;
  if (!S) throw new Error('TES scene was not mounted');
  const fit = S.frame.fit;
  if (!fit) throw new Error('TES frame has no visual fit box');
  const r = app.renderer, world = S.world;
  const W = app.canvas.width, H = app.canvas.height;
  const rt = RenderTexture.create({ width: W, height: H, resolution: 1, scaleMode: 'nearest' });
  const bg = r.background.color.toArray();
  r.render({ container: app.stage, target: rt, clear: true, clearColor: bg });
  const px = r.extract.pixels({ target: rt }).pixels as Uint8ClampedArray;
  rt.destroy(true);
  const sx = world.scale.x * r.resolution, sy = world.scale.y * r.resolution;
  const box = {
    x0: (world.x + fit.x0 * world.scale.x) * r.resolution,
    x1: (world.x + (fit.x1 + 1) * world.scale.x) * r.resolution,
    y0: (world.y + fit.y0 * world.scale.y) * r.resolution,
    y1: (world.y + (fit.y1 + 1) * world.scale.y) * r.resolution,
  };
  const x0 = Math.max(0, Math.ceil((world.x + PACK_ART.tes.x0 * world.scale.x) * r.resolution));
  const x1 = Math.min(W, Math.floor((world.x + (PACK_ART.tes.x1 + 1) * world.scale.x) * r.resolution));
  const y0 = Math.max(0, Math.ceil((world.y + (PACK_ART.tes.y1 + 1) * world.scale.y) * r.resolution));
  let syntheticPixels = 0;
  for (let y = y0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (px[i] !== Math.round(bg[0] * 255) || px[i + 1] !== Math.round(bg[1] * 255) || px[i + 2] !== Math.round(bg[2] * 255)) syntheticPixels++;
    }
  }
  return {
    fit, box, scaleX: sx, scaleY: sy, expectedScale: Math.min(W / (fit.x1 - fit.x0 + 1), H / (fit.y1 - fit.y0 + 1)),
    cacheScale: S.k, naturalBottom: y0, syntheticPixels,
  };
}

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const box = document.createElement('div');
    box.style.cssText = 'position:relative';
    document.body.style.margin = '0';
    document.body.appendChild(box);
    const root = createRoot(box);
    const out: Array<Record<string, unknown>> = [];
    box.style.width = `${aspects[0].w}px`; box.style.height = `${aspects[0].h}px`;
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    for (const aspect of aspects) {
      box.style.width = `${aspect.w}px`; box.style.height = `${aspect.h}px`;
      for (let i = 0; i < 12 && !app; i++) await wait(100);
      await wait(250);
      const metric = placement();
      const shot = await window.harness.capture(aspect.w, aspect.h);
      out.push({ ...aspect, ...metric, size: shot.size, png: shot.png });
    }
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, aspects: out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
