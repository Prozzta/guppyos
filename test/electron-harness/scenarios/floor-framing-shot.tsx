/**
 * SCENARIO - TES-GUPPY-FRAMING: full-window screenshots of the REAL App on a project whose theme is
 * HARNESS_SHOT_THEME ('tes' or 'office'), at each content size in HARNESS_SHOT_SIZES, with no stored
 * sidebar width (the default framing). Each shot also reports the floor pane's box, the sidebar's
 * width and the floor camera's numbers, so the framing can be read as well as seen.
 * Run on demand: node test/electron-harness/run-floor-framing-shot.cjs --theme tes|office --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { App } from '../../../src/renderer/src/App';
import { useStore } from '../../../src/renderer/src/store/store';
import { registerPackThemes } from '../../../src/shared/projectTheme';
import { SHOT_THEME } from './floor-framing-theme';

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
const theme = SHOT_THEME;
const sizes: Array<[number, number]> = [[700, 470], [960, 640], [1290, 850]];
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.1.85';
try { window.localStorage.removeItem('cth.sidebarWidth'); } catch { /* noop */ }
// The window is hidden (show:false), and a hidden document pauses the floor's ticker, so the camera
// would never settle on its fit. The page says it is visible, as the real window is.
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
// A hidden window's requestAnimationFrame barely runs, so the camera's ease would not finish:
// frames come from a 16 ms timer instead.
window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16) as unknown as number;
window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
// The crew's walks and seats use Math.random: seeded, so before/after shots start alike.
let seed = 0x1e5f;
Math.random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
if (theme !== 'office') registerPackThemes([{ id: theme, label: theme.toUpperCase() }]);

const home = 'C:/harness-test-home';
const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'working' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', status: 'idle' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'rose', status: 'working' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: home, action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ...a }));
const config = { onboardingComplete: true, harnessHome: home, recentHomes: [], officeThemeByHive: theme === 'office' ? {} : { [home]: theme } };
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

function readFraming() {
  const canvas = document.querySelector('canvas');
  const pane = canvas?.parentElement?.closest('div[style*="flex: 1"]') as HTMLElement | null;
  const aside = [...document.querySelectorAll('div')].find((d) => d.style.flexShrink === '0' && d.style.width.endsWith('px') && d.style.width !== '10px');
  const r = pane?.getBoundingClientRect();
  return {
    officeTheme: useStore.getState().officeTheme,
    sidebarWidth: useStore.getState().sidebarWidth,
    shownSidebar: aside ? aside.style.width : null,
    pane: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null
  };
}

window.__harnessRun = async () => {
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await act(async () => { await sleep(800); });
    await act(async () => { useStore.setState({ agents, messageQueues: {} } as never); });
    const shots: Array<Record<string, unknown>> = [];
    for (const [w, h] of sizes) {
      await window.harness.capture(w, h);
      await act(async () => { await sleep(6000); });
      const shot = await window.harness.capture(w, h);
      shots.push({ w, h, size: shot.size, framing: readFraming(), png: shot.png });
    }
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, theme, shots });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
