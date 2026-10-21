/**
 * STALL-WATCH-198, the renderer half: slow input (Event Timing) and long tasks for the whole run,
 * sent to main in small batches (main validates, rate-caps and writes the `input-delay` and
 * `renderer-longtask` rows; see src/main/stallWatch.ts).
 *
 * Cheap: both observers are the browser's own and report only entries past their threshold; a
 * batch leaves at most every 5 s, and only when it has something. NEVER the typed text: an input
 * entry carries its event name, its three timings and its target's data-testid, id or tag name.
 */

export const STALL_FLUSH_MS = 5_000;
/** Event Timing reports only events at least this long (a multiple of 8, >= 16). */
const EVENT_THRESHOLD_MS = 104;
const INPUT_MIN_MS = 100;
const LONGTASK_MIN_MS = 200;
/** Entries a batch carries at most (main folds the rest anyway). */
const BATCH_MAX = 50;
const INPUT_EVENTS = new Set(['keydown', 'keypress', 'beforeinput', 'input', 'pointerdown']);
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

type Batch = {
  inputs?: Array<{ ev: string; at: number; inputMs: number; procMs: number; presMs: number; target?: string }>;
  longtasks?: Array<{ at: number; ms: number; name?: string; attr?: string }>;
};

let started = false;
let inputs: NonNullable<Batch['inputs']> = [];
let longtasks: NonNullable<Batch['longtasks']> = [];

/** Epoch ms of a performance timestamp. */
const epoch = (t: number): number => Math.round(performance.timeOrigin + t);

/** The target's name: the nearest data-testid, else its id, else its tag. Never its value or text. */
export function targetName(node: unknown): string | undefined {
  const el = node as Element | null | undefined;
  if (!el || typeof (el as Element).getAttribute !== 'function') return undefined;
  const tagged = typeof el.closest === 'function' ? el.closest('[data-testid]') : null;
  const testId = tagged?.getAttribute('data-testid');
  if (testId && ID_RE.test(testId)) return testId;
  if (el.id && ID_RE.test(`id:${el.id}`)) return `id:${el.id}`;
  const tag = typeof el.tagName === 'string' ? el.tagName.toLowerCase() : '';
  return ID_RE.test(tag) ? tag : undefined;
}

function send(): void {
  if (inputs.length === 0 && longtasks.length === 0) return;
  const batch: Batch = {};
  if (inputs.length) batch.inputs = inputs;
  if (longtasks.length) batch.longtasks = longtasks;
  inputs = [];
  longtasks = [];
  try { window.cth.stallWatch(batch); } catch { /* best-effort */ }
}

/** Arm both observers once, at renderer boot. They run for the whole run. */
export function startRendererStallWatch(): void {
  if (started) return;
  started = true;
  const types = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes ?? [] : [];
  try {
    if (types.includes('event')) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          if (!INPUT_EVENTS.has(e.name) || e.duration < INPUT_MIN_MS || inputs.length >= BATCH_MAX) continue;
          const end = e.startTime + e.duration;
          const target = targetName(e.target);
          inputs.push({
            ev: e.name, at: epoch(e.startTime),
            inputMs: Math.max(0, Math.round(e.processingStart - e.startTime)),
            procMs: Math.max(0, Math.round(e.processingEnd - e.processingStart)),
            presMs: Math.max(0, Math.round(end - e.processingEnd)),
            ...(target ? { target } : {})
          });
        }
      }).observe({ type: 'event', durationThreshold: EVENT_THRESHOLD_MS, buffered: true } as PerformanceObserverInit);
    }
  } catch { /* no Event Timing: long tasks still work */ }
  try {
    if (types.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < LONGTASK_MIN_MS || longtasks.length >= BATCH_MAX) continue;
          const a = (e as PerformanceEntry & { attribution?: Array<{ containerType?: string }> }).attribution?.[0];
          longtasks.push({ at: epoch(e.startTime), ms: Math.round(e.duration), name: e.name, ...(a?.containerType ? { attr: a.containerType } : {}) });
        }
      }).observe({ type: 'longtask', buffered: true });
    }
  } catch { /* none */ }
  window.setInterval(send, STALL_FLUSH_MS);
}
