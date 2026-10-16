/**
 * CARDS-TAB-190: the real CardsTab (real useHiveTasks poll, real store, production CSS) fed a
 * synthetic ledger through a stubbed bridge — no hive, no live floor. Shots: a busy card, a done
 * card with a result, and a card with humanQA history, each isolated by typing its id into the
 * tab's own search box, at desktop and phone width.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { CardsTab } from '../../../src/renderer/src/components/CardsTab';
import { useStore, type Agent } from '../../../src/renderer/src/store/store';

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
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

const LEDGER = {
  tasks: [
    {
      id: 'CAPACITY-STRIP-77', title: 'Capacity strip: a weekly window that resets mid-run shows the old number until the next tick',
      status: 'doing', assignee: 'andy-1', priority: 0, createdAt: iso(600), fixVersion: '1.1.90',
      description: 'The strip keeps the **pre-reset** weekly value until a fresh tick lands. Expected: a passed `resets_at` reads as reset at once.',
      notes: [
        '', `[${iso(540)}] god: dispatched to Andy; Jim audits.`,
        `[${iso(420)}] Andy: reproduced on a copy of the tracker state; the presenter reads \`resetsAt\` only on ingest.`,
        `[${iso(300)}] Andy: fix on fix/capacity-reset-77 @ 1a2b3c4d; red-to-green test \`capacity-reset-77.test.cjs\`.`,
        `[${iso(95)}] Andy: suite queued behind the heavy lock (Creed holds the slot until 20:10Z).`,
        `[${iso(25)}] Andy: mutants 4/4 killed; tsc web + node clean. Waiting for the slot.`
      ].join('\n')
    },
    {
      id: 'RELEASE-1.1.89', title: 'Release 1.1.89', status: 'done', assignee: 'jim-1', priority: 'high',
      createdAt: iso(3000), doneAt: iso(1500),
      result: `[${iso(1500)}] **Released** v1.1.89: https://github.com/example/guppy/releases/tag/v1.1.89\n- 3 assets (setup, blockmap, latest.yml)\n- suite 5276 / 0 fail / 16 skip; tsc clean`,
      notes: `\n[${iso(2900)}] god: cut from int-1.1.89 @ 9f8e7d6c.\n[${iso(1700)}] Jim: install checklist passed on the Human's PC.`
    },
    {
      id: 'THEME-DEFAULT-42', title: 'Which theme should a fresh install open on?', status: 'blocked', assignee: 'dwight-1', priority: 1,
      createdAt: iso(2000), parked: true, waitingFor: 'human',
      humanQA: [
        {
          q: 'Fresh installs: which theme first?\n\nThe Office is the **default today**; TES is the newer pack.',
          options: [{ label: 'Office', detail: 'what every install has shown so far', recommended: true }, { label: 'TES', detail: 'the newer pack' }],
          askedAt: iso(1900), a: 'Office', chosen: [0], answeredAt: iso(1800)
        },
        { q: 'Should the theme picker show on first run?', options: [{ label: 'Yes' }, { label: 'No' }], askedAt: iso(240) }
      ],
      // notes as an ARRAY of strings (16 real cards store them so): one timeline line each
      notes: [`[${iso(1950)}] Dwight: two asks for the Human (theme, picker).`, `[${iso(1800)}] Human answered the theme ask: Office.`],
      dependsOn: ['RELEASE-1.1.89']
    },
    { id: 'DOCS-SWEEP-9', title: 'Docs sweep: stale screenshots in the README', status: 'todo', assignee: 'oscar-1', createdAt: iso(4000) }
  ]
};
const META = { cards: { 'CAPACITY-STRIP-77': { statusSince: Date.now() - 540 * 60_000, statusSinceExact: true }, 'THEME-DEFAULT-42': { statusSince: Date.now() - 1950 * 60_000, statusSinceExact: true } } };

(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_target, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name === 'hiveTasks') return () => Promise.resolve(LEDGER);
    if (name === 'hiveTaskMeta') return () => Promise.resolve(META.cards);
    if (name === 'hiveBoardFlags') return () => Promise.resolve([]);
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

const agent = (id: string, name: string, character: string): Agent => ({
  id, name, character, accent: 'sky', description: '', project: 'p', tmuxTarget: '', cwd: 'C:/harness-test-home/project',
  status: 'idle', action: 'waiting', progress: 0, command: 'claude'
} as Agent);

function setInput(el: HTMLInputElement, value: string, checked?: boolean) {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, checked === undefined ? 'value' : 'checked')!;
  proto.set!.call(el, checked === undefined ? value : checked);
  el.dispatchEvent(new Event(checked === undefined ? 'input' : 'click', { bubbles: true }));
}

async function waitFor(check: () => boolean, message: string) {
  for (let i = 0; i < 100; i += 1) { if (check()) return; await sleep(50); }
  throw new Error(message);
}

window.__harnessRun = async () => {
  try {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;';
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      useStore.setState({ agents: [agent('andy-1', 'Andy', 'jim'), agent('dwight-1', 'Dwight', 'dwight')], restorableAgents: [agent('jim-1', 'Jim', 'jim')] } as never);
      root.render(<CardsTab />);
    });
    await waitFor(() => document.querySelectorAll('[data-card]').length > 0, 'no cards rendered');
    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    const done = document.querySelector('.cth-cards-filters input[type="checkbox"]') as HTMLInputElement;
    const shots: Record<string, unknown> = {};
    const census = () => ({ cards: [...document.querySelectorAll('[data-card]')].map((e) => e.getAttribute('data-card')), text: document.body.innerText.slice(0, 4000) });

    await act(async () => { done.click(); });
    for (const [kind, id] of [['list', ''], ['busy', 'CAPACITY-STRIP-77'], ['done', 'RELEASE-1.1.89'], ['qa', 'THEME-DEFAULT-42']] as const) {
      await act(async () => { setInput(search, id); });
      await waitFor(() => (id ? census().cards.length === 1 && census().cards[0] === id : census().cards.length === 4), `${kind}: filter did not settle`);
      for (const [w, h] of [[1100, 900], [390, 1300]] as const) {
        await sleep(150);
        shots[`${kind}-${w}`] = { ...(await window.harness.capture(w, h)), census: census() };
      }
    }
    window.harness.report({ ok: true, ...shots });
  } catch (error) {
    window.harness.report({ ok: false, error: String((error as Error)?.stack ?? error) });
  }
};
