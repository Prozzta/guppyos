/**
 * SCENARIO - the agent card's NAME outranks its badges (MunderDev 97bda465 + c6b98de9).
 * Mounts the REAL AgentCard with the app's stylesheet and measures the name span.
 *
 * Guppy loads Press Start 2P from Google Fonts at run time; the harness has no network and Guppy
 * bundles no copy. So the display face is a local stand-in registered under the same family name:
 * Consolas, size-adjusted to Press Start 2P's 1em-per-glyph advance, so names take the width they
 * take in the app. As upstream, the cards first mount under a narrow 4px stand-in, and the display
 * face only loads afterwards, so only the fonts 'loadingdone' re-measure can catch the wider names.
 * Then one card's status changes after mount (idle -> compacting) and everything is measured again.
 */
import { createRoot } from 'react-dom/client';
import { act, createElement } from 'react';
// The harness inlines CSS as a style tag, where global.css's @import './tokens.css' cannot resolve.
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { AgentCard } from '../../../src/renderer/src/components/AgentCard';
import type { StatusKind } from '../../../src/renderer/src/components/PixelBadge';

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

interface Case { id: string; name: string; isGod?: boolean; status: StatusKind; later?: StatusKind; rename: boolean }
const CASES: Case[] = [
  { id: 'godMichael', name: 'Michael', isGod: true, status: 'working', rename: true },
  { id: 'godCptKerk', name: 'Cpt Kerk', isGod: true, status: 'idle', rename: true },
  { id: 'godLong', name: 'Michael Gary Scott', isGod: true, status: 'blocked', rename: true },
  { id: 'godPlain', name: 'Cpt Kerk', isGod: true, status: 'working', rename: false },
  { id: 'worker', name: 'Scetty', status: 'working', rename: true },
  { id: 'worker8', name: 'Jackov12', status: 'compacting', rename: true },
  { id: 'workerLong', name: 'McCey the engineer', status: 'blocked', rename: true },
  { id: 'goesBusy', name: 'Jackov12', status: 'idle', later: 'compacting', rename: true }, // fits beside "idle", not "compacting"
];

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });
const rename = async () => ({ ok: true });

function measure() {
  const res: Record<string, unknown> = {};
  for (const c of CASES) {
    const box = document.getElementById(c.id)!, shown = c.name.toUpperCase();
    const el = [...box.querySelectorAll('span')].find((s) => s.childElementCount === 0 && s.textContent === shown);
    const glyph = el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    const dot = box.querySelector('span[role="img"]') as HTMLElement | null;
    res[c.id] = {
      found: !!el, client: el ? el.clientWidth : 0, full: el ? el.scrollWidth : 0, glyph,
      titled: !!(el && el.title && el.title.startsWith(c.name)),
      dot: dot ? { title: dot.title, aria: dot.getAttribute('aria-label') } : null,
      badgeText: [...box.querySelectorAll('span')].some((s) => /^(working|idle|needs you|compacting)$/.test((s.textContent || '').trim())),
    };
  }
  return res;
}

window.__harnessRun = async () => {
  try {
    // A narrow stand-in first: every name fits, so no card is dotted at mount.
    const early = document.createElement('style');
    early.textContent = ':root { --cth-font-display: monospace; --cth-text-display-sm: 4px; }';
    document.head.appendChild(early);
    const face = new FontFace('Press Start 2P', 'local("Consolas")', { sizeAdjust: '182%' });
    document.fonts.add(face);

    const host = document.getElementById('root')!;
    const root = createRoot(host);
    const draw = (statusOf: (c: Case) => StatusKind) => root.render(createElement('div', null, CASES.map((c) =>
      createElement('div', { key: c.id, id: c.id, style: { padding: 6, width: 220 } },
        createElement(AgentCard, {
          name: c.name, character: 'michael', accent: 'lemon', status: statusOf(c), isGod: !!c.isGod,
          project: 'tos-bridge', progress: 3, onRename: c.rename ? rename : undefined
        })))));
    await act(async () => { draw((c) => c.status); });
    await settle();
    const atMount = measure();

    // The app's display face arrives: drop the stand-in; the face loads because the names use it.
    early.remove();
    await act(async () => { await document.fonts.load('8px "Press Start 2P"'); await document.fonts.ready; });
    await settle();
    const out: Record<string, unknown> = { font: document.fonts.check('8px "Press Start 2P"') && face.status === 'loaded', atMount, cases: measure() };

    await act(async () => { draw((c) => c.later ?? c.status); }); // a status change after mount
    await settle();
    out.after = measure();
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
