/**
 * SCENARIO - TES-SCENE-BOUNCE-188: the REAL App on a TES project, a tall narrow floor pane (the
 * sidebar wide), and an agent card in the bottom roster clicked, one after another. Every rendered
 * frame records the floor pane's box, the canvas's box and the floor camera (the world's scale and
 * origin in device px), so a selection that moves the scene shows as frames whose origin left the
 * rested one. Reports the trace per click.
 * Run by test/tes-scene-bounce-189.test.cjs (the default size), and on demand at any size and DPR
 * by test/electron-harness/run-tes-scene-bounce.cjs (it swaps tes-scene-bounce-size.ts).
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application } from 'pixi.js';
import { App } from '../../../src/renderer/src/App';
import { useStore } from '../../../src/renderer/src/store/store';
import { registerPackThemes } from '../../../src/shared/projectTheme';
import { BOUNCE_SIZE } from './tes-scene-bounce-size';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: {
      report: (payload: unknown) => void;
      capture: (w: number, h: number) => Promise<{ size: { width: number; height: number }; png: string }>;
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.1.88';
try { window.localStorage.removeItem('cth.sidebarWidth'); window.localStorage.removeItem('cth.selectedId'); } catch { /* noop */ }
// A hidden window pauses the floor and starves rAF (floor-framing-shot.tsx): the page says it is
// visible, and frames come from a 16 ms timer.
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16) as unknown as number;
window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
let seed = 0x1e5f;
Math.random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
registerPackThemes([{ id: 'tes', label: 'TES' }]);

const home = 'C:/harness-test-home';
const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', status: 'idle' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'idle' },
  { id: 'creed', name: 'Creed', character: 'creed', accent: 'rose', status: 'idle' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: home, action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ...a }));
const config = { onboardingComplete: true, harnessHome: home, recentHomes: [], officeThemeByHive: { [home]: 'tes' } };
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'recovering') return true;
    if (name === 'platform') return 'win32';
    if (name === 'arch') return 'x64';
    if (name === 'getConfig') return () => Promise.resolve({ ...config });
    if (name === 'takeRecoveryNotice') return () => Promise.resolve(null);
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve(undefined);
  }
});

type Frame = { t: number; n: number; ox: number; oy: number; paneTop: number; paneH: number; canvasTop: number; canvasH: number };
let floorApp: any = null;
let rec: Frame[] | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: any) {
  realRender.call(this);
  if (this.__tesScene) floorApp = this;
  if (rec && this === floorApp) {
    const r = this.renderer.resolution, w = this.__tesScene.world;
    const canvas = this.canvas as HTMLCanvasElement, cr = canvas.getBoundingClientRect();
    const pr = canvas.parentElement!.parentElement!.getBoundingClientRect();
    rec.push({ t: Math.round(performance.now()), n: w.scale.x * r, ox: Math.round(w.x * r), oy: Math.round(w.y * r), paneTop: pr.top, paneH: pr.height, canvasTop: cr.top, canvasH: cr.height });
  }
};

// A roster card: a role=button in the bottom strip whose text, or a label in it, names the agent.
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('div[role="button"]')]
  .filter((el) => el.getBoundingClientRect().top > window.innerHeight * 0.6)
  .find((el) => [el.textContent ?? '', ...[...el.querySelectorAll('[aria-label],[title]')].map((k) => `${k.getAttribute('aria-label')} ${k.getAttribute('title')}`)]
    .some((s) => s.toLowerCase().includes(name.toLowerCase()))) ?? null;

window.__harnessRun = async () => {
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await act(async () => { await sleep(800); });
    await act(async () => { useStore.setState({ agents, messageQueues: {} } as never); });
    const [W, H, sidebar] = BOUNCE_SIZE;
    await window.harness.capture(W, H);
    await act(async () => { useStore.getState().setSidebarWidth(sidebar); });
    await act(async () => { await sleep(6000); });
    const clicks: Array<{ who: string; found: boolean; selected: string | null; frames: Frame[] }> = [];
    for (const who of ['Jim', 'Creed', 'Andy', 'Dwight']) {
      rec = [];
      await act(async () => { await sleep(300); });
      const el = card(who);
      await act(async () => { el?.click(); });
      await act(async () => { await sleep(2500); });
      clicks.push({ who, found: !!el, selected: useStore.getState().selectedId, frames: rec });
      rec = null;
    }
    const shot = await window.harness.capture(W, H);
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, size: BOUNCE_SIZE, dpr: window.devicePixelRatio, clicks, png: shot.png });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
