/**
 * CARDS-TAB-CLEANUP-191: the real CardsView in a real renderer, its SHOW DONE toggle CLICKED. Reports
 * what localStorage holds after each click and what a remounted view reads back, so the "choice is
 * remembered" half of the card is pinned by behaviour, not by a source regex.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { CardsView } from '../../../src/renderer/src/components/CardsView';
import { reviewCards, SHOW_DONE_KEY } from '../../../src/renderer/src/components/cardsReview';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

const task = (id: string, status: string) => ({ id, title: `card ${id}`, status, createdAt: '2026-10-16T10:00:00Z', dependsOn: [] });
const cards = reviewCards([task('OPEN-1', 'todo'), task('DONE-1', 'done'), task('DONE-2', 'done')] as never, new Map(), {});
const NOW = new Date('2026-10-17T08:00:00Z');

window.__harnessRun = async () => {
  try {
    localStorage.removeItem(SHOW_DONE_KEY);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = () => ({
      cards: [...host.querySelectorAll('[data-card]')].map((e) => e.getAttribute('data-card')).sort(),
      toggle: host.querySelector('.cth-cards-done-toggle')?.textContent ?? null,
      stored: localStorage.getItem(SHOW_DONE_KEY)
    });
    const mount = async () => {
      const root = createRoot(host);
      await act(async () => { root.render(<CardsView cards={cards} now={NOW} />); });
      return root;
    };
    const click = async () => {
      await act(async () => { (host.querySelector('.cth-cards-done-toggle') as HTMLButtonElement).click(); });
    };

    let root = await mount();
    const initial = view();
    await click();
    const afterShow = view();
    await act(async () => { root.unmount(); });
    root = await mount();
    const remountShown = view();
    await click();
    const afterHide = view();
    await act(async () => { root.unmount(); });
    root = await mount();
    const remountHidden = view();
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, initial, afterShow, remountShown, afterHide, remountHidden });
  } catch (error) {
    window.harness.report({ ok: false, error: String((error as Error)?.stack ?? error) });
  }
};
