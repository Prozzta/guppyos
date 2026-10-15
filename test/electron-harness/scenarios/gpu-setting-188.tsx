/**
 * GPU-SETTING-188: the production GraphicsSetting section (Settings -> General) in each state the Human
 * will meet, one shot per state, on the Settings page's own background:
 *   auto-gpu      Auto, a hardware renderer         -> "Rendering: <GPU name> (GPU)"
 *   cpu-cpu       CPU only in force                 -> "Rendering: software (CPU)"
 *   gpu-fallback  GPU chosen, no usable GPU          -> "...software (CPU): no usable GPU, fell back to the CPU"
 *   restart       CPU only saved while Auto runs     -> the restart notice
 *   confirm       ... with 2 agents running, restart clicked -> the confirm prompt
 * auto-gpu uses the real WebGL probe's name when it is hardware (run under Creed's --gpu hw main), else a
 * stubbed one (default harness renders run with disable-gpu, so the probe is SwiftShader). Reported as `real`.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { GraphicsSetting } from '../../../src/renderer/src/components/GraphicsSetting';
import { recordFloorRenderer, probeWebglRenderer } from '../../../src/renderer/src/scene/graphicsProbe';
import { isSoftwareRenderer, type GraphicsStatusView } from '../../../src/shared/graphicsMode';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: {
      report: (payload: unknown) => void;
      capture: (w: number, h: number) => Promise<{ size: { width: number; height: number }; png: string }>;
    };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER (0x00002702) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

let status: GraphicsStatusView = { applied: 'auto', stored: 'auto', hardwareDisabled: false, hardwareCompositing: true, runningAgents: 0 };
const restarts: string[] = [];
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_target, name: string) => {
    if (name === 'graphicsStatus') return () => Promise.resolve(status);
    if (name === 'setGraphicsMode') return (mode: GraphicsStatusView['stored']) => { status = { ...status, stored: mode }; return Promise.resolve(status); };
    if (name === 'restartForGraphics') return () => { restarts.push(status.stored); return Promise.resolve(); };
    if (name.startsWith('on')) return () => () => {};
    return () => Promise.resolve({ ok: true });
  }
});

const fakeApp = (renderer: string) => ({ renderer: { gl: { getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }), getParameter: () => renderer } } });

async function shot(name: string, s: GraphicsStatusView, renderer: string | null, after?: (host: HTMLElement) => Promise<void>) {
  status = s;
  if (renderer) recordFloorRenderer(fakeApp(renderer));
  const host = document.createElement('div');
  host.style.cssText = 'width:560px;padding:20px 24px;background:var(--cth-cream-200);box-sizing:border-box';
  document.body.replaceChildren(host);
  const root = createRoot(host);
  await act(async () => { root.render(<GraphicsSetting />); });
  await act(async () => { await sleep(150); });
  if (after) await after(host);
  await act(async () => { await sleep(100); });
  const h = Math.ceil(host.getBoundingClientRect().height);
  const cap = await window.harness.capture(560, h);
  const view = {
    select: (host.querySelector('[data-graphics-mode]') as HTMLSelectElement | null)?.value ?? null,
    indicator: host.querySelector('[data-graphics-indicator]')?.textContent ?? null,
    restart: host.querySelector('[data-graphics-restart]')?.textContent ?? null
  };
  await act(async () => { root.unmount(); });
  return { name, ...cap, view };
}

window.__harnessRun = async () => {
  try {
    document.body.style.margin = '0';
    const shots = [];
    const realName = probeWebglRenderer();
    const real = !!realName && !isSoftwareRenderer(realName);
    shots.push(await shot('auto-gpu', { applied: 'auto', stored: 'auto', hardwareDisabled: false, hardwareCompositing: true, runningAgents: 0 }, real ? realName : NVIDIA));
    shots.push(await shot('cpu-cpu', { applied: 'cpu', stored: 'cpu', hardwareDisabled: true, hardwareCompositing: false, runningAgents: 0 }, SWIFTSHADER));
    shots.push(await shot('gpu-fallback', { applied: 'gpu', stored: 'gpu', hardwareDisabled: false, hardwareCompositing: false, runningAgents: 0 }, SWIFTSHADER));
    shots.push(await shot('restart', { applied: 'auto', stored: 'cpu', hardwareDisabled: false, hardwareCompositing: true, runningAgents: 2 }, NVIDIA));
    shots.push(await shot('confirm', { applied: 'auto', stored: 'cpu', hardwareDisabled: false, hardwareCompositing: true, runningAgents: 2 }, NVIDIA, async (host) => {
      const btn = [...host.querySelectorAll('[data-graphics-restart] button')][0] as HTMLButtonElement;
      await act(async () => { btn.click(); await sleep(50); });
    }));
    window.harness.report({ ok: true, real, realName, shots, restarts });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
