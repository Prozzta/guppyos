/**
 * SCENARIO - PANEL-BLINK-188 (b): the REAL AgentCard (the bottom dock's card) with the app's stylesheet,
 * for three agents: WORKING (hook working, liveness BUSY_PROGRESSING), IDLE (hook idle, liveness IDLE), and
 * hook-working but liveness IDLE (the liveness status wins: no blink). Each card's status dot is read
 * (its running animation, its computed opacity) every 150 ms for 1.5 s (over a 1200 ms blink), and shot.
 */
import { createRoot } from 'react-dom/client';
import { act, createElement } from 'react';
import '../../../src/renderer/src/design/tokens.css';
import '../../../src/renderer/src/design/global.css';
import { AgentCard } from '../../../src/renderer/src/components/AgentCard';
import { useStore } from '../../../src/renderer/src/store/store';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; capture: (w: number, h: number) => Promise<{ png: string }> };
  }
}

(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

const SAMPLES = 10, EVERY_MS = 150, SHOTS = 4;
const now = Date.now();
const CARDS = [
  { id: 'god', name: 'Michael', isGod: true, status: 'working', classification: 'BUSY_PROGRESSING' },
  { id: 'dwight', name: 'Dwight', isGod: false, status: 'idle', classification: 'IDLE' },
  { id: 'jim', name: 'Jim', isGod: false, status: 'working', classification: 'IDLE' }
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.__harnessRun = async () => {
  try {
    useStore.setState({
      agents: CARDS.map((c) => ({ id: c.id, name: c.name, status: c.status, ...(c.status === 'working' ? { runningTools: [{ name: 'Bash', since: now - 4000 }] } : {}) })),
      liveness: Object.fromEntries(CARDS.map((c) => [c.id, { agentId: c.id, incarnation: 1, lifecycle: 'LIVE', classification: c.classification, classifiedSince: now - 60_000, reason: c.classification === 'IDLE' ? 'quiescent' : 'pty-traffic', evidence: { lastPtyTrafficAt: now - 500 } }]))
    } as never);
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement('div', { id: 'dock', style: { display: 'flex', gap: 8, padding: 8, background: 'var(--cth-cream-50)' } }, CARDS.map((c) =>
        createElement('div', { key: c.id, 'data-card': c.id }, createElement(AgentCard, { agentId: c.id, name: c.name, character: 'michael', accent: 'lemon', status: c.status, isGod: c.isGod, project: 'Harness', action: c.status === 'working' ? 'using Bash' : '', progress: 3 })))));
    });
    await act(async () => { await sleep(300); });
    // each card's badge: the chip whose text is its status label; its dot is the chip's first span
    const dots = CARDS.map((c) => {
      const card = document.querySelector(`[data-card="${c.id}"]`)!;
      const chip = [...card.querySelectorAll('span')].find((s) => /^(working|idle)$/.test((s.textContent || '').trim()) && s.firstElementChild?.tagName === 'SPAN');
      return { id: c.id, label: chip ? chip.textContent!.trim() : null, dot: (chip?.firstElementChild as HTMLElement | undefined) ?? null };
    });
    const cards = dots.map((d) => ({
      id: d.id, label: d.label,
      animationName: d.dot ? getComputedStyle(d.dot).animationName : null,
      running: d.dot ? d.dot.getAnimations().map((a) => (a as CSSAnimation).animationName || 'anim') : [],
      opacity: [] as number[]
    }));
    const shots: string[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      dots.forEach((d, k) => cards[k].opacity.push(d.dot ? Number(getComputedStyle(d.dot).opacity) : NaN));
      if (i < SHOTS) shots.push((await window.harness.capture(720, 110)).png);
      await sleep(EVERY_MS);
    }
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, cards, shots });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
