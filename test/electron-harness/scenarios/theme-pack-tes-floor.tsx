/**
 * SCENARIO - TES data (plan step 6): the REAL OfficeFloor with the real themes/tes pack bundled
 * (HARNESS_THEME_PACKS points the packSources stub at the repo's themes/tes folder, unchanged).
 * - the catalogue offers tes as a stations pack;
 * - loadStationPack('tes') loads it with no diagnostic: nine stations, Captain first;
 * - the floor renders StationFloor for tes: its own host (the pack background), a canvas, no
 *   Office wrapper and no fallback note.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { listThemes, isStationPack, loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';

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
    return () => Promise.resolve({ ok: true });
  }
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

window.__harnessRun = async () => {
  try {
    const themes = listThemes().map((t) => `${t.id}:${t.sceneKind}`);
    const station = isStationPack('tes');
    const loaded = await loadStationPack('tes');
    const scene = loaded.pack?.scene;
    const data = {
      diagnostics: loaded.diagnostics.map((d) => `${d.level}: ${d.message}`),
      stations: scene ? scene.stations.length : -1,
      seatOrder: scene ? scene.seatOrder.map((s) => s.name) : [],
      captain: scene?.captain?.name ?? null,
    };

    const box = document.createElement('div');
    box.style.cssText = 'width:960px;height:640px;position:relative';
    document.body.appendChild(box);
    const root = createRoot(box);
    await act(async () => { useStore.setState({ officeTheme: 'tes' }); root.render(<OfficeFloor />); });
    // The pack loads (image decode) and Pixi initialises asynchronously.
    for (let i = 0; i < 60 && !box.querySelector('canvas'); i++) await wait(150);
    await wait(300);
    const top = box.firstElementChild as HTMLElement | null;
    const status = box.querySelector('[role="status"]');
    const floor = {
      officeWrapper: !!top && top.style.position === 'relative', // OfficeFloor's Office branch wrapper
      hostBackground: top ? getComputedStyle(top).backgroundColor : null,
      canvas: !!box.querySelector('canvas'),
      status: status ? status.textContent : null,
    };
    await act(async () => { root.unmount(); });
    box.remove();
    window.harness.report({ ok: true, themes, station, data, floor });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
