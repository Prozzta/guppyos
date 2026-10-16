/** TES-MAIL-ENVELOPE-187: mount the real station floor and drive its preload listener. */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application } from 'pixi.js';
import { StationFloor } from '../../../src/renderer/src/scene/themes/StationFloor';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { useStore } from '../../../src/renderer/src/store/store';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

type HiveEvent = { from: string; targets: string[]; act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done'; needsHuman?: boolean };
let listener: ((event: HiveEvent) => void) | null = null;
(window as unknown as { cth: unknown }).cth = new Proxy({
  onHiveMessage(fn: (event: HiveEvent) => void) { listener = fn; return () => { listener = null; }; }
}, {
  get: (target, name: string) => {
    if (name in target) return (target as Record<string, unknown>)[name];
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' }
].map((a) => ({ description: '', project: 'Envelope test', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

window.__harnessRun = async () => {
  const apps: Application[] = [];
  const proto = Application.prototype as unknown as { init: (...args: unknown[]) => Promise<void> };
  const realInit = proto.init;
  proto.init = async function (...args: unknown[]) { apps.push(this as unknown as Application); return realInit.apply(this, args); };
  let root: ReturnType<typeof createRoot> | null = null;
  let box: HTMLDivElement | null = null;
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    box = document.createElement('div'); box.style.cssText = 'width:960px;height:640px;position:relative'; document.body.appendChild(box);
    root = createRoot(box);
    await act(async () => { useStore.setState({ agents, liveness: {} } as never); root!.render(<StationFloor pack={loaded.pack!} />); });
    for (let i = 0; i < 80 && (!apps[0] || !(apps[0] as any).__bubbleLayer || !listener); i++) await wait(25);
    const app = apps[0] as any, bubbles = app?.__bubbleLayer as any;
    if (!bubbles || !listener) throw new Error('StationFloor did not expose the mounted Hive bubble listener/layer');
    app.ticker.stop();

    const anchors = [{ id: 'god', x: 84, y: 96 }, { id: 'andy', x: 236, y: 172 }, { id: '__human__', x: loaded.pack.scene.entrance![0], y: loaded.pack.scene.entrance![1] }];
    bubbles.update(0, anchors, { scale: 1, x: 0, y: 0, resolution: 1 });
    const count0 = bubbles.envelopes.length;
    listener({ from: 'god', targets: ['andy'], act: 'request' });
    const andyEnvelope = bubbles.envelopes.at(-1);
    if (bubbles.envelopes.length !== count0 + 1) throw new Error('mail between mounted crew anchors did not create exactly one envelope');
    const between = { sx: andyEnvelope.sx, sy: andyEnvelope.sy, ex: andyEnvelope.ex, ey: andyEnvelope.ey };
    for (let elapsed = 0; elapsed < 2500; elapsed += 100) bubbles.update(100, anchors, { scale: 1, x: 0, y: 0, resolution: 1 });
    const goneAfter2500 = bubbles.envelopes.length === count0;

    listener({ from: 'god', targets: ['human'], act: 'inform', needsHuman: true });
    const humanEnvelope = bubbles.envelopes.at(-1);
    const humanTarget = { ex: humanEnvelope.ex, ey: humanEnvelope.ey };
    const beforeSystem = bubbles.envelopes.length;
    listener({ from: 'god', targets: ['system'], act: 'inform' });
    const systemAdded = bubbles.envelopes.length - beforeSystem;
    window.harness.report({ ok: true, between, goneAfter2500, humanTarget, entrance: loaded.pack.scene.entrance, systemAdded });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    box?.remove();
    proto.init = realInit;
  }
};
