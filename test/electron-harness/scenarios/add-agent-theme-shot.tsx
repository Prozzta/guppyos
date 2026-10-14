/**
 * ADD-AGENT-TES-ONLY: renders the production Add and Edit dialogs under Office
 * and TES. The census covers every cast name, all Office portrait canvases, the
 * input value, pack builder, hint, and Color row before taking each shot.
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
// The harness inlines CSS as a style tag, where global.css's @import cannot resolve.
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { AddAgentModal } from '../../../src/renderer/src/components/AddAgentModal';
import { EditAgentModal } from '../../../src/renderer/src/components/EditAgentModal';
import { useStore, type Agent } from '../../../src/renderer/src/store/store';
import { OFFICE_CAST } from '../../../src/renderer/src/scene/office/cast';
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
const officeNames = OFFICE_CAST.map((character) => character.displayName);
const config: HarnessConfig = {
  onboardingComplete: true,
  harnessHome: 'C:/harness-test-home',
  registeredRepos: ['C:/harness-test-home/project'],
  autoMode: false,
  defaultCommand: 'claude',
  semanticMemory: false
};
const editableAgent: Agent = {
  id: 'edit-speck', name: 'Speck', character: 'jim', accent: 'sky',
  description: 'the saved test agent', project: 'test', tmuxTarget: '', cwd: 'C:/harness-test-home/project',
  status: 'idle', action: 'waiting', progress: 0, command: 'claude'
};

// The dialog does not call the bridge until a user takes an action, but give it
// the normal harmless renderer shape so this remains a real component harness.
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_target, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name === 'getConfig') return () => Promise.resolve(config);
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
    officePortraits: document.querySelectorAll('canvas[data-portrait="office"]').length,
    packPortraits: document.querySelectorAll('canvas[data-portrait="pack"]').length,
    lookBuilder: document.querySelector('[data-look-builder="tes"]') !== null,
    themedHint: text.includes('name · look · color'),
    colorRow: /\bcolor\b/i.test(text),
    inputValues: [...document.querySelectorAll('input')].map((input) => input.value)
  };
}

async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await sleep(40);
  }
  throw new Error(message);
}

type Dialog = 'add' | 'edit';
type Theme = 'office' | 'tes' | 'friends';
type Mounted = { host: HTMLDivElement; root: Root };

async function mount(dialog: Dialog, theme: Theme): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    useStore.setState({ officeTheme: theme } as never);
    root.render(dialog === 'add'
      ? <AddAgentModal config={config} onClose={() => {}} />
      : <EditAgentModal agent={editableAgent} onClose={() => {}} />);
  });
  return { host, root };
}

async function unmount(mounted: Mounted) {
  await act(async () => { mounted.root.unmount(); });
  mounted.host.remove();
}

window.__harnessRun = async () => {
  try {
    // Force the catalogue to validate/register the actual bundled TES assets
    // before each dialog's asynchronous hook asks for its look sheet.
    if (!await loadThemeLooks('tes')) throw new Error('TES looks did not load');
    const captures: Record<string, Awaited<ReturnType<typeof window.harness.capture>> & { census: ReturnType<typeof visibleCensus> }> = {};

    for (const dialog of ['add', 'edit'] as const) {
      for (const theme of ['office', 'tes'] as const) {
        const mounted = await mount(dialog, theme);
        await waitFor(() => theme === 'office'
          ? visibleCensus().officePortraitButtons > 0 && visibleCensus().officePortraits > 0
          : visibleCensus().lookBuilder && visibleCensus().packPortraits > 0,
        `${dialog} ${theme} identity controls did not render`);
        captures[`${dialog}-${theme}`] = { ...(await window.harness.capture(1120, 820)), census: visibleCensus() };
        await unmount(mounted);
      }
    }

    for (const dialog of ['add', 'edit'] as const) {
      const office = captures[`${dialog}-office`].census;
      const tes = captures[`${dialog}-tes`].census;
      if (office.officePortraitButtons === 0 || office.officePortraits === 0 || office.officeNames.length === 0 || office.lookBuilder) {
        throw new Error(`${dialog} Office evidence lost its unchanged cast picker: ${JSON.stringify(office)}`);
      }
      if (tes.officePortraitButtons !== 0 || tes.officePortraits !== 0 || tes.officeNames.length !== 0 || !tes.lookBuilder || !tes.themedHint || !tes.colorRow) {
        throw new Error(`${dialog} TES still exposes Office identity or lacks themed controls: ${JSON.stringify(tes)}`);
      }
      if (dialog === 'edit' && !tes.inputValues.includes('Speck')) {
        throw new Error(`Edit TES did not retain its saved name: ${JSON.stringify(tes)}`);
      }
    }
    const tvShowMounted = await mount('add', 'friends');
    await waitFor(() => visibleCensus().officePortraitButtons > 0, 'TV-show Add Office picker did not render');
    const tvShow = visibleCensus();
    await unmount(tvShowMounted);
    if (!tvShow.inputValues.includes('Jim')) {
      throw new Error(`TV-show Add did not default to Jim: ${JSON.stringify(tvShow)}`);
    }

    window.harness.report({ ok: true, ...captures, tvShow });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
