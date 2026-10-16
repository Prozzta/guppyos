/**
 * CL-M4-CHAINS-PANEL: "possible duplicates" in the production Settings modal (Memory & Knowledge), with
 * a synthetic bridge (window.cth); every component is the real one.
 *   01-agent-open        andy's ledger, with the "possible duplicates 2" button next to the status chips
 *   02-duplicates        the groups: same card (build number dropped) and same label, newest first
 *   03-one-unticked      one note unticked: "keep this one" leaves it as it is
 *   04-kept-one          after "keep this one" (main's confirm is stubbed OK): the card group is gone
 *   05-kept-all          after "keep all" on the label group: nothing left to decide
 *   06-read-only         a read-only ledger: the groups show, every choice is disabled
 * Run with HARNESS_SOURCE_OVERRIDES pointing ClaimLedgerSettings.tsx at the base version for the "before".
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

const claim = (id: string, text: string, wt: string, extra: Partial<LedgerUiClaim> = {}): LedgerUiClaim => ({
  id, kind: 'fact', text, source: 'self', at: wt, wt, status: 'live', sightings: 0, pinned: false, reasons: [], ...extra,
});
const counts = (v: LedgerUiAgentView): LedgerUiAgentView['counts'] => {
  const c = { live: 0, 'superseded?': 0, superseded: 0, retracted: 0, purged: 0 };
  for (const x of v.claims) c[x.status]++;
  return c;
};
const andy: LedgerUiAgentView = {
  agentId: 'andy-mtuk4y4x', level: 'writer', readOnly: null, counts: { live: 0, 'superseded?': 0, superseded: 0, retracted: 0, purged: 0 },
  claims: [
    claim('c-11aa22bb33cc', 'CL-W7 ledger UI built: level buttons, history with revert, the typed purge.', '2026-10-12T09:10:00Z'),
    claim('c-22bb33cc44dd', 'Screenshots go through the jailed harness, never a live window.', '2026-10-13T10:00:00Z', { key: 'list.shots' }),
    claim('c-33cc44dd55ee', 'CL-W7-189 fix round merged at int a8db887e; Jim passed it.', '2026-10-15T16:20:00Z'),
    claim('c-44dd55ee66ff', 'The heavy-job lock allows one heavy job on the machine at a time.', '2026-10-14T08:00:00Z', { kind: 'decision', key: 'project.heavy-lock' }),
    claim('c-55ee66ff7788', 'Shots are 1280x800 at DPR 1, so text is judged at its real size.', '2026-10-16T11:00:00Z', { key: 'list.shots' }),
    claim('c-66ff778899aa', 'CL-W7 is done and merged; the next card is CL-M4-FORWARD-PATH.', '2026-10-16T16:30:00Z'),
  ],
  events: [],
};
andy.counts = counts(andy);
const jim: LedgerUiAgentView = {
  agentId: 'jim-mtujpe28', level: 'writer', readOnly: 'mac at c-0a1b2c3d4e5f', truncatedAt: 'c-0a1b2c3d4e5f',
  counts: { live: 2, 'superseded?': 0, superseded: 0, retracted: 0, purged: 0 },
  claims: [
    claim('c-0a1b2c3d4e5f', 'TES-BUBBLE-NITS-189 audit: PASS with two nits.', '2026-10-14T09:00:00Z'),
    claim('c-1b2c3d4e5f60', 'TES-BUBBLE-NITS mutants M19 and M21 still open.', '2026-10-16T15:05:00Z'),
  ],
  events: [],
};
const summary = (): LedgerUiSummary => ({
  saved: 'writer', effective: 'writer',
  agents: [
    { agentId: 'andy-mtuk4y4x', level: 'writer', claims: andy.claims.length, readOnly: false },
    { agentId: 'jim-mtujpe28', level: 'writer', claims: jim.claims.length, readOnly: true },
  ],
});
let n = 0;
const calls: string[] = [];
const claimsUi = {
  summary: async () => summary(),
  view: async (id: string) => structuredClone(id === 'jim-mtujpe28' ? jim : andy),
  addPreference: async () => ({ ok: false, error: 'not in this scenario' }),
  revert: async () => ({ ok: false, error: 'not in this scenario' }),
  purge: async () => ({ ok: false, error: 'not in this scenario' }),
  setLevel: async () => ({ ok: false, error: 'not in this scenario' }),
  exportNow: async () => ({ ok: false, error: 'not in this scenario' }),
  // As main does after the Human's OK: each other note marked replaced by the kept one (a revertible step).
  keepOne: async (_a: string, keep: string, retire: string[]) => {
    calls.push(`keepOne:${keep}:${retire.join(',')}`);
    for (const id of retire) {
      const c = andy.claims.find((x) => x.id === id)!;
      c.status = 'superseded'; c.supersededBy = keep;
      andy.events.push({ id: `e-${(++n).toString(16).padStart(12, '0')}`, ev: 'reconcile-answer', targets: [id, keep], answer: 'supersedes', by: 'human', at: '2026-10-16T17:20:00Z', reverted: false, revertible: true } as LedgerUiEvent);
    }
    andy.counts = counts(andy);
    return { ok: true, note: `Kept 1 note; ${retire.length} set aside.` };
  },
  keepAll: async (_a: string, ids: string[]) => {
    calls.push(`keepAll:${ids.join(',')}`);
    for (const id of ids.slice(1)) andy.events.push({ id: `e-${(++n).toString(16).padStart(12, '0')}`, ev: 'reconcile-answer', targets: [id, ids[0]], answer: 'keep-both', by: 'human', at: '2026-10-16T17:21:00Z', reverted: false, revertible: true } as LedgerUiEvent);
    return { ok: true, note: `Kept all ${ids.length} notes.` };
  },
};
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'claimsUi') return claimsUi;
    if (name.startsWith('on')) return () => () => {};
    return () => Promise.resolve(null);
  },
});

const byText = (root: ParentNode, sel: string, text: string | RegExp): HTMLElement => {
  const el = [...root.querySelectorAll<HTMLElement>(sel)].find((x) => (typeof text === 'string' ? x.textContent?.trim() === text : text.test(x.textContent ?? '')));
  if (!el) throw new Error(`no ${sel} with text ${String(text)}`);
  return el;
};
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await sleep(150); }); };
const scrollTo = async (el: Element | null) => { await act(async () => { el?.scrollIntoView({ block: 'start' }); await sleep(150); }); };

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
    const panel = document.querySelector('[data-testid="claim-ledger-settings"]')!;
    await click(byText(panel, 'button', 'open'));
    await act(async () => { await sleep(200); });
    const agent = () => document.querySelector('[data-testid="claim-ledger-agent"]');
    await scrollTo(agent());
    await capture('01-agent-open');
    const toggle = [...panel.querySelectorAll<HTMLElement>('button')].find((b) => /^possible duplicates \d+$/.test(b.textContent?.trim() ?? ''));
    if (!toggle) {
      // The base build (the "before"): the ledger without the duplicates view.
      window.harness.report({ ok: true, before: true, shots, calls });
      return;
    }
    await click(toggle);
    await scrollTo(agent());
    await capture('02-duplicates');

    await click(document.querySelector<HTMLElement>('[data-chain="card:CL-W7"] [data-claim="c-11aa22bb33cc"] input[type="checkbox"]')!);
    await capture('03-one-unticked');

    await click(byText(document.querySelector('[data-chain="card:CL-W7"] [data-claim="c-66ff778899aa"]')!, 'button', 'keep this one'));
    await act(async () => { await sleep(200); });
    await scrollTo(agent());
    await capture('04-kept-one');

    await click(byText(document.querySelector('[data-chain="key:list.shots"]')!, 'button', 'keep all'));
    await act(async () => { await sleep(200); });
    await scrollTo(agent());
    await capture('05-kept-all');

    await click(byText(panel, 'button', 'hide'));
    const opens = [...panel.querySelectorAll<HTMLElement>('button')].filter((b) => b.textContent?.trim() === 'open');
    await click(opens[1]);
    await act(async () => { await sleep(200); });
    await click([...panel.querySelectorAll<HTMLElement>('button')].find((b) => /^possible duplicates \d+$/.test(b.textContent?.trim() ?? ''))!);
    await scrollTo(agent());
    await capture('06-read-only');

    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, before: false, shots, calls });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
