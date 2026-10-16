/**
 * CL-W7: the production Settings modal on Memory & Knowledge, with the claim ledger UI in each state
 * the Human meets. The bridge (window.cth) is synthetic; every component is the real one.
 *   01-memory-section   the section: level buttons and the agents with a ledger
 *   02-agent-open       andy's ledger: export, the preference composer, status chips, live claims
 *   03-all-statuses     the 'all' filter: every status badge
 *   04-history          one claim open: "Why it believes this", a revert per step, a reverted step
 *   05-purge-typed      the purge row with the word typed (main's own dialog comes after)
 *   06-preference       a preference being written, and one over 400 characters (refused, not cut)
 *   07-read-only        a read-only ledger (a chain break): nothing can be written
 *   08-level-applied    the level changed, with main's answer
 * Run with HARNESS_SOURCE_OVERRIDES pointing SettingsModal.tsx at the base version for the "before".
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { SettingsModal } from '../../../src/renderer/src/components/SettingsModal';
import type { LedgerUiAgentView, LedgerUiClaim, LedgerUiEvent, LedgerUiSummary } from '../../../src/shared/claimsUi';
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
const W = 1280, H = 800;

const claim = (id: string, text: string, status: LedgerUiClaim['status'], wt: string, extra: Partial<LedgerUiClaim> = {}): LedgerUiClaim => ({
  id, kind: 'fact', text, source: 'self', at: wt, wt, status, sightings: 0, pinned: false, reasons: [], ...extra,
});
const ev = (id: string, e: LedgerUiEvent['ev'], targets: string[], at: string, extra: Partial<LedgerUiEvent> = {}): LedgerUiEvent => ({
  id, ev: e, targets, by: 'code', at, reverted: false, revertible: true, ...extra,
});
const andy: LedgerUiAgentView = {
  agentId: 'andy-mtuk4y4x', level: 'writer', readOnly: null,
  counts: { live: 5, 'superseded?': 1, superseded: 1, retracted: 1, purged: 1 },
  claims: [
    claim('c-1a2b3c4d5e6f', 'The heavy-job lock allows one heavy job on the machine at a time; suites, typecheck and benches queue.', 'live', '2026-10-09T08:12:00Z', { kind: 'decision', key: 'project.heavy-lock', sightings: 2 }),
    claim('c-2b3c4d5e6f70', 'int-1.1.88 is the integration branch.', 'superseded', '2026-10-10T09:00:00Z', { key: 'release.int-branch', supersededBy: 'c-3c4d5e6f7081', reasons: ['replaced by c-3c4d5e6f7081 (newer fact on key release.int-branch)'] }),
    claim('c-3c4d5e6f7081', 'int-1.1.89 is the integration branch; merges go on 0ffa737a.', 'live', '2026-10-16T15:09:00Z', { key: 'release.int-branch', supersedes: ['c-2b3c4d5e6f70'], supersedesReason: { category: 'version-bump' }, pinned: true }),
    claim('c-4d5e6f708192', 'The TES floor renders at 2x on every pane.', 'superseded?', '2026-10-12T11:30:00Z', { reasons: ['a newer claim on the same key may replace it (newest wins, awaiting the reconcile)'] }),
    claim('c-5e6f708192a3', 'Bubble tails are drawn at the root depth.', 'retracted', '2026-10-13T10:00:00Z', { reasons: ['retracted by c-6f708192a3b4'] }),
    claim('c-6f708192a3b4', 'Bubble tails are drawn above the cloud; the root stays inside it.', 'live', '2026-10-15T14:00:00Z', { retracts: ['c-5e6f708192a3'] }),
    claim('c-708192a3b4c5', '[purged]', 'purged', '2026-10-11T12:00:00Z', { reasons: ['purged by the Human'] }),
    claim('c-8192a3b4c5d6', 'Always resolve the base from origin, never a local branch.', 'live', '2026-10-16T15:40:00Z', { kind: 'preference', source: 'human', key: 'pref.git.base' }),
    claim('c-92a3b4c5d6e7', 'Screenshots at DPR 1.25 from capturePage are resampled; judge them on canvas readback.', 'live', '2026-10-16T15:18:00Z', { source: 'mail:jim-mtujpe28' }),
  ],
  events: [
    ev('e-a1b2c3d4e5f6', 'sighting', ['c-1a2b3c4d5e6f'], '2026-10-10T07:00:00Z', { by: 'self' }),
    ev('e-b2c3d4e5f607', 'sighting', ['c-1a2b3c4d5e6f'], '2026-10-14T07:00:00Z', { by: 'self' }),
    ev('e-c3d4e5f60718', 'pin', ['c-3c4d5e6f7081'], '2026-10-16T15:10:00Z', { by: 'self' }),
    ev('e-d4e5f6071829', 'soft-supersede', ['c-4d5e6f708192', 'c-3c4d5e6f7081'], '2026-10-16T15:12:00Z', { rule: 'R3' }),
    ev('e-e5f60718293a', 'accept', ['c-4d5e6f708192'], '2026-10-16T15:13:00Z', { by: 'self', reverted: true, revertible: false }),
    ev('e-f60718293a4b', 'revert', ['e-e5f60718293a'], '2026-10-16T15:20:00Z', { by: 'human', revertible: false }),
    ev('e-0718293a4b5c', 'purge', ['c-708192a3b4c5'], '2026-10-16T15:25:00Z', { by: 'human', revertible: false }),
  ],
};
const jim: LedgerUiAgentView = {
  agentId: 'jim-mtujpe28', level: 'writer', readOnly: 'mac at c-0a1b2c3d4e5f', truncatedAt: 'c-0a1b2c3d4e5f',
  counts: { live: 2, 'superseded?': 0, superseded: 0, retracted: 0, purged: 0 },
  claims: [
    claim('c-0a1b2c3d4e5f', 'Hull compositing is one draw call per pane.', 'live', '2026-10-14T09:00:00Z'),
    claim('c-1b2c3d4e5f60', 'Office text at DPR 1 meets the bar; resolution = DPR is not needed.', 'live', '2026-10-16T15:05:00Z'),
  ],
  events: [],
};
let saved = 'writer';
const summary = (): LedgerUiSummary => ({
  saved, effective: saved as LedgerUiSummary['effective'],
  agents: [
    { agentId: 'andy-mtuk4y4x', level: 'writer', claims: andy.claims.length, readOnly: false },
    { agentId: 'jim-mtujpe28', level: 'writer', claims: jim.claims.length, readOnly: true },
  ],
});
const calls: string[] = [];
const claimsUi = {
  summary: async () => summary(),
  view: async (id: string) => (id === 'jim-mtujpe28' ? jim : andy),
  addPreference: async () => { calls.push('addPreference'); return { ok: true, id: 'c-ffffffffffff' }; },
  revert: async () => { calls.push('revert'); return { ok: false, error: 'cancelled: nothing was written', cancelled: true }; },
  purge: async () => { calls.push('purge'); return { ok: false, error: 'cancelled: nothing was written', cancelled: true }; },
  setLevel: async (l: string) => { calls.push(`setLevel:${l}`); saved = l; return { ok: true, note: 'Exported 2 memory.md file(s) first.' }; },
  exportNow: async () => { calls.push('exportNow'); return { ok: true, note: '18234 bytes written.' }; },
};
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'claimsUi') return claimsUi;
    if (name.startsWith('on')) return () => () => {};
    return () => Promise.resolve(null);
  },
});

const byText = (root: ParentNode, sel: string, text: string | RegExp): HTMLElement => {
  const el = [...root.querySelectorAll<HTMLElement>(sel)].find((n) => (typeof text === 'string' ? n.textContent?.trim() === text : text.test(n.textContent ?? '')));
  if (!el) throw new Error(`no ${sel} with text ${String(text)}`);
  return el;
};
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await sleep(120); }); };
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
  });
};
const scrollTo = async (el: Element | null) => {
  await act(async () => { el?.scrollIntoView({ block: 'start' }); await sleep(150); });
};

window.__harnessRun = async () => {
  try {
    document.body.style.margin = '0';
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const config = { claimLedger: 'writer', semanticMemory: true } as unknown as HarnessConfig;
    await act(async () => { root.render(<SettingsModal config={config} onClose={() => undefined} initialSection={'Memory & Knowledge'} />); });
    await act(async () => { await sleep(600); });
    const shots: Array<{ name: string; size: { width: number; height: number }; png: string; dpr: number }> = [];
    const capture = async (name: string) => { const c = await window.harness.capture(W, H); shots.push({ name, ...c, dpr: window.devicePixelRatio }); };
    const panel = document.querySelector('[data-testid="claim-ledger-settings"]');
    if (!panel) {
      // The base build (the "before"): the section without the ledger UI.
      await capture('01-memory-section');
      window.harness.report({ ok: true, before: true, shots, calls });
      return;
    }
    await scrollTo(panel);
    await capture('01-memory-section');

    await click(byText(panel, 'button', 'open'));
    await act(async () => { await sleep(200); });
    await scrollTo(panel);
    await capture('02-agent-open');

    await click(byText(panel, 'button', /^all \d+$/));
    await scrollTo(document.querySelector('[data-testid="claim-ledger-agent"]'));
    await capture('03-all-statuses');

    await click(document.querySelector<HTMLElement>('[data-claim="c-4d5e6f708192"] button')!);
    await scrollTo(document.querySelector('[data-claim="c-4d5e6f708192"]'));
    await capture('04-history');

    await click(document.querySelector<HTMLElement>('[data-claim="c-4d5e6f708192"] button')!);
    await click(document.querySelector<HTMLElement>('[data-claim="c-6f708192a3b4"] button')!);
    await click(byText(panel, 'button', 'purge...'));
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Type purge to confirm"]')!, 'purge');
    await scrollTo(document.querySelector('[data-claim="c-6f708192a3b4"]'));
    await capture('05-purge-typed');

    await click(byText(panel, 'button', 'cancel'));
    const pref = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Preference"]')!;
    await type(pref, 'Ask me before deleting any branch, even a merged one.');
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Preference key"]')!, 'pref.git.branches');
    await scrollTo(document.querySelector('[data-testid="claim-ledger-agent"]'));
    await capture('06-preference');
    await type(pref, 'x '.repeat(205).trim());
    await capture('06b-preference-too-long');
    await type(pref, '');

    await click(byText(panel, 'button', 'close'));
    const opens = [...panel.querySelectorAll<HTMLElement>('button')].filter((b) => b.textContent?.trim() === 'open');
    await click(opens[1]);
    await act(async () => { await sleep(200); });
    await scrollTo(panel);
    await capture('07-read-only');

    await click(byText(panel, 'button', 'close'));
    await click(byText(panel, 'button', 'reader'));
    await act(async () => { await sleep(200); });
    await scrollTo(panel);
    await capture('08-level-applied');

    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, before: false, shots, calls });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
