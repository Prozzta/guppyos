/**
 * SCENARIO - TES foundation (Jim S1): the REAL OfficeFloor dispatch with bundled theme packs.
 * The harness bundles two copies of the neutral-deck fixture (HARNESS_THEME_PACKS): `deck-ok`
 * loads, and `deck-broken` catalogues but has a picture with no URL, so it cannot load.
 * - a valid pack renders StationFloor: its own host (pack background, a canvas), no Office wrapper;
 * - an invalid pack renders the Office plus the role=status note naming the pack;
 * - the office id renders the Office with no note.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { listThemes, isStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';

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

/** What the floor rendered for one theme id. */
async function floorFor(id: string) {
  const box = document.createElement('div');
  box.style.cssText = 'width:640px;height:420px;position:relative';
  document.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => { useStore.setState({ officeTheme: id }); root.render(<OfficeFloor />); });
  // The pack loads (image decode) and Pixi initialises asynchronously.
  for (let i = 0; i < 40 && !box.querySelector('canvas'); i++) await wait(150);
  await wait(300);
  const top = box.firstElementChild as HTMLElement | null;
  const status = box.querySelector('[role="status"]');
  const out = {
    officeWrapper: !!top && top.style.position === 'relative', // OfficeFloor's Office branch wrapper
    hostBackground: top ? getComputedStyle(top).backgroundColor : null,
    canvas: !!box.querySelector('canvas'),
    status: status ? status.textContent : null,
  };
  await act(async () => { root.unmount(); });
  box.remove();
  return out;
}

window.__harnessRun = async () => {
  try {
    const themes = listThemes().map((t) => `${t.id}:${t.sceneKind}`);
    const packs = { ok: isStationPack('deck-ok'), broken: isStationPack('deck-broken') };
    const valid = await floorFor('deck-ok');
    const invalid = await floorFor('deck-broken');
    const office = await floorFor('office');
    window.harness.report({ ok: true, themes, packs, valid, invalid, office });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
