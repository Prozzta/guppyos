/**
 * SCENARIO - HISTORY-SCROLL-FREEZE. The PRODUCTION HistoryView, scrolled back the way a person
 * does it: 40 wheel-sized steps up through the mount boundary, then idle.
 *
 * Before the fix, a message row was measured 6 px short (its margins collapsed out of the
 * measured wrapper) and Chromium's scroll anchoring moved scrollTop by those 6 px each time a
 * row crossed the boundary; the layout effect fed scrollTop back into the virtual window, the
 * two flipped forever, React aborted ("Maximum update depth exceeded") and, with no error
 * boundary, the whole root unmounted. Shipped code failed at step 8 (short rows) or 25 (long).
 *
 * Trials, each on a fresh root:
 *  - short rows and real-shaped rows (long agent replies), as built;
 *  - F1 ALONE: the browser's scroll anchoring forced back ON by a stylesheet (only the true
 *    measurement can keep the view still);
 *  - F2 ALONE: the measured wrapper forced back to display:block, so the margins collapse out
 *    again (only overflow-anchor:none can keep the view still);
 *  - F3: a component that throws inside the History boundary, beside a sibling that must stay;
 *  - B1: the ROOT boundary's "Reload the window" goes through main, never location.reload().
 * A hidden window renders no frames, so a user scroll is setting scrollTop + a scroll event.
 */
import { createRoot, type Root } from 'react-dom/client';
import { HistoryView } from '../../../src/renderer/src/components/HistoryView';
import { ErrorBoundary } from '../../../src/renderer/src/components/ErrorBoundary';
import type { HistoryItem, HistoryPage, HistoryRequest } from '../../../src/shared/history';
import type { RendererErrorReport } from '../../../src/shared/rendererError';

declare global { interface Window { __harnessRun: () => Promise<void>; harness: { report: (p: unknown) => void } } }
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const LINE = 100;
const N = 450;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, k) => `word${(seed * 31 + k) % 997}`).join(' ');
let file: HistoryItem[] = [];
function build(shape: 'short' | 'real') {
  file = [];
  for (let i = 0; i < N; i += 1) {
    const kind = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'tool';
    const text = kind === 'tool' ? `Bash: step ${i}`
      : shape === 'short' ? `turn ${i}`
        : kind === 'assistant' ? `reply ${i} ${words(150 + (i * 37) % 450, i)}` : `prompt ${i} ${words(20 + (i % 5) * 30, i)}`;
    file.push({ id: `${i * LINE}.0`, kind, at: Date.UTC(2026, 0, 1, 10, 0, i % 60), offset: i * LINE, text });
  }
}
const historyPage = async (req: HistoryRequest): Promise<HistoryPage> => {
  const head = { ok: true as const, provider: 'claude' as const, fileId: 'f1', fileName: 'x.jsonl', size: file.length * LINE };
  const limit = req.limit ?? 150;
  if (typeof req.after === 'number') return { ...head, items: file.slice(req.after / LINE), start: req.after, end: file.length * LINE, atStart: req.after === 0 };
  const endIdx = typeof req.before === 'number' ? req.before / LINE : file.length;
  const startIdx = Math.max(0, endIdx - limit);
  return { ...head, items: file.slice(startIdx, endIdx), start: startIdx * LINE, end: endIdx * LINE, atStart: startIdx === 0 };
};
const reports: RendererErrorReport[] = [];
const reloadCalls: string[] = [];
(window as unknown as { cth: unknown }).cth = {
  historyPage,
  logRendererError: (r: RendererErrorReport) => { reports.push(r); },
  reloadAfterError: (where: string) => { reloadCalls.push(where); }
};
// Jim B1: a bare location.reload() must never happen. Count any unload attempt and cancel it
// (Electron cancels a navigation whose beforeunload returns a value), so the run survives a mutant.
let unloadAttempts = 0;
window.onbeforeunload = (e: BeforeUnloadEvent) => { unloadAttempts += 1; e.returnValue = false; return false; };

const errors: string[] = [];
const origErr = console.error;
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ').slice(0, 300)); origErr(...a); };
window.addEventListener('error', (e) => { errors.push(`onerror: ${String(e.message).slice(0, 300)}`); });
const loopError = (from: number) => errors.slice(from).find((e) => /Maximum update depth/.test(e)) ?? null;

async function scrollTrial(shape: 'short' | 'real', css: string) {
  build(shape);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const root: Root = createRoot(host);
  root.render(<div style={{ width: 520, height: 600, display: 'flex' }}><HistoryView agentId="a1" /></div>);
  await sleep(1200);
  const sc = host.querySelector('[data-history-view]') as HTMLElement;
  const from = errors.length;
  let failStep = -1;
  for (let k = 0; k < 40; k += 1) {
    sc.scrollTop = Math.max(0, sc.scrollTop - 240);
    sc.dispatchEvent(new Event('scroll'));
    await sleep(16);
    if (failStep < 0 && loopError(from)) failStep = k;
  }
  // Idle: a healthy view goes still.
  const tops: number[] = [];
  for (let k = 0; k < 20; k += 1) { await sleep(50); tops.push(Math.round(sc.scrollTop)); }
  // The true stride: each mounted row's wrapper height is the distance to the next row.
  const rows = [...host.querySelectorAll<HTMLElement>('[data-hid]')];
  let strideOff = 0;
  for (let i = 0; i + 1 < rows.length; i += 1) strideOff = Math.max(strideOff, Math.abs(rows[i + 1].offsetTop - rows[i].offsetTop - rows[i].offsetHeight));
  const out = {
    loop: loopError(from), failStep, mounted: rows.length, scrollHeight: sc.scrollHeight,
    idleDistinctTops: new Set(tops).size, strideOff
  };
  root.unmount(); host.remove(); style.remove();
  return out;
}

function Thrower(): never { throw new Error('history render failed (test)'); }

async function boundaryTrial() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const before = reports.length;
  root.render(
    <div>
      <div data-sibling>the rest of the panel</div>
      <ErrorBoundary where="History"><Thrower /></ErrorBoundary>
    </div>
  );
  await sleep(300);
  const alert = host.querySelector('[data-error-boundary="History"]');
  const out = {
    siblingMounted: !!host.querySelector('[data-sibling]'),
    fallbackShown: !!alert,
    fallbackText: alert?.textContent ?? '',
    reported: reports.slice(before).filter((r) => r.source === 'boundary').map((r) => ({ where: r.where, message: r.message, hasComponentStack: !!r.componentStack }))
  };
  root.unmount(); host.remove();
  return out;
}

/** Jim B1: the ROOT boundary's button reloads through main (the recovery notice), never by itself. */
async function rootReloadTrial() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  root.render(<ErrorBoundary where="The app" recover="reload"><Thrower /></ErrorBoundary>);
  await sleep(300);
  const button = [...host.querySelectorAll('button')].find((b) => /Reload the window/.test(b.textContent ?? ''));
  const before = reloadCalls.length;
  button?.click();
  await sleep(400);
  const out = { buttonShown: !!button, reloadCalls: reloadCalls.slice(before), unloadAttempts };
  root.unmount(); host.remove();
  return out;
}

window.__harnessRun = async () => {
  try {
    const short = await scrollTrial('short', '');
    const real = await scrollTrial('real', '');
    const f1Only = await scrollTrial('real', '[data-history-view]{overflow-anchor:auto !important}');
    const f1OnlyShort = await scrollTrial('short', '[data-history-view]{overflow-anchor:auto !important}');
    const f2Only = await scrollTrial('real', '[data-hid]{display:block !important}');
    const f2OnlyShort = await scrollTrial('short', '[data-hid]{display:block !important}');
    const boundary = await boundaryTrial();
    const rootReload = await rootReloadTrial();
    window.harness.report({ ok: true, short, real, f1Only, f1OnlyShort, f2Only, f2OnlyShort, boundary, rootReload });
  } catch (e) {
    window.harness.report({ ok: false, error: String((e as Error)?.stack ?? e) });
  }
};
