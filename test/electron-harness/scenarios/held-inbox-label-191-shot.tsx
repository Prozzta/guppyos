/** Visual evidence for HELD-INBOX-LABEL-191: a quiet-held mail badge names its release time. */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { AgentCard } from '../../../src/renderer/src/components/AgentCard';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; capture: (width: number, height: number) => Promise<{ png: string }> };
  }
}

(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_target, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    return () => Promise.resolve({ ok: true });
  }
});

window.__harnessRun = async () => {
  try {
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement('main', { style: { padding: 12, background: 'var(--cth-cream-50)' } },
        createElement(AgentCard, {
          agentId: 'phyllis', name: 'Phyllis', character: 'michael', accent: 'lemon', status: 'idle',
          project: 'Guppy', action: 'waiting for quiet mail', progress: 2,
          inboxBacklog: 1, inboxHeld: 1, heldUntil: Date.UTC(2030, 0, 2, 6, 53)
        })));
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const mail = document.querySelector('[data-badge="mail"]') as HTMLElement | undefined;
    const png = await window.harness.capture(480, 140);
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, png: png.png, mail: { text: mail?.textContent, title: mail?.title } });
  } catch (error) {
    window.harness.report({ ok: false, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
