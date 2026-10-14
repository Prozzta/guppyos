/**
 * ADD-AGENT-TES-ONLY: captures the real Add Agent identity section under Office
 * and TES. It mounts the production dialog, loads the bundled TES pack, and
 * records both pixels and the visible Office-cast census.
 *
 * Run through run-add-agent-theme-shot.cjs; the runner writes both PNGs.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import '../../../src/renderer/src/design/global.css';
import { AddAgentModal } from '../../../src/renderer/src/components/AddAgentModal';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadThemeLooks } from '../../../src/renderer/src/scene/themes/themeCatalog';
import type { HarnessConfig } from '../../../src/renderer/src/store/config';

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
const officeNames = ['Michael', 'Dwight', 'Jim', 'Pam', 'Andy', 'Angela', 'Kevin', 'Stanley', 'Phyllis', 'Meredith', 'Oscar'];
const config: HarnessConfig = {
  onboardingComplete: true,
  harnessHome: 'C:/harness-test-home',
  registeredRepos: ['C:/harness-test-home/project'],
  autoMode: false,
  defaultCommand: 'claude',
  semanticMemory: false
};

// The dialog does not call the bridge until a user takes an action, but give it
// the normal harmless renderer shape so this remains a real component harness.
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_target, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

function visibleCensus() {
  const text = `${document.body.innerText}\n${[...document.querySelectorAll('input')].map((input) => input.value).join('\n')}`;
  return {
    officeNames: officeNames.filter((name) => text.includes(name)),
    officePortraitButtons: document.querySelectorAll('[data-office-character-picker] button').length,
    lookBuilder: document.querySelector('[data-look-builder="tes"]') !== null
  };
}

async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await sleep(40);
  }
  throw new Error(message);
}

window.__harnessRun = async () => {
  try {
    // Force the catalogue to validate/register the actual bundled TES assets
    // before the dialog's asynchronous hook asks for its look sheet.
    if (!await loadThemeLooks('tes')) throw new Error('TES looks did not load');
    const mount = async (theme: 'office' | 'tes') => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => {
        useStore.setState({ officeTheme: theme } as never);
        root.render(<AddAgentModal config={config} onClose={() => {}} />);
      });
      return { host, root };
    };

    let mounted = await mount('office');
    await waitFor(() => visibleCensus().officePortraitButtons > 0, 'Office cast picker did not render');
    const office = { ...(await window.harness.capture(1120, 820)), census: visibleCensus() };

    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
    mounted = await mount('tes');
    await waitFor(() => visibleCensus().lookBuilder, 'TES look builder did not render');
    const tes = { ...(await window.harness.capture(1120, 820)), census: visibleCensus() };
    await act(async () => { mounted.root.unmount(); });

    if (office.census.officePortraitButtons === 0 || office.census.officeNames.length === 0) throw new Error('Office evidence lost its unchanged cast picker');
    if (tes.census.officePortraitButtons !== 0 || tes.census.officeNames.length !== 0 || !tes.census.lookBuilder) {
      throw new Error(`TES still exposes Office identity: ${JSON.stringify(tes.census)}`);
    }
    window.harness.report({ ok: true, office, tes });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
