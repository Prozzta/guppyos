/**
 * STARTUP-TIMING-162, the renderer half: long tasks (>= 50 ms) and each terminal's first
 * redraw (xterm parsed its first bytes) (and each terminal's open) during the first 55 s, sent to main in small batches
 * (main writes the `startup-timing` rows; see src/main/startupTiming.ts). Then it stops.
 *
 * Cheap: the Long Tasks API is the browser's own; a batch leaves at most every 2 s; the data
 * path pays one boolean check (and one Set lookup per terminal until its first redraw) while
 * recording, and one boolean check after. No content: numbers, ids and attribution names only.
 */

/** R2: 55 s, not 60: this document starts after main's origin, so its final batch must leave
 *  before main's 60 s window closes (a later batch is dropped there). */
export const RENDERER_TIMING_WINDOW_MS = 55_000;
export const RENDERER_TIMING_FLUSH_MS = 2_000;
const LONGTASK_MIN_MS = 50;

type Batch = {
  longtasks?: Array<{ at: number; ms: number; name?: string; attr?: string }>;
  marks?: Array<{ name: string; at: number; id?: string }>;
};

let recording = false;
let longtasks: NonNullable<Batch['longtasks']> = [];
let marks: NonNullable<Batch['marks']> = [];
const redrawn = new Set<string>();

function send(): void {
  if (longtasks.length === 0 && marks.length === 0) return;
  const batch: Batch = {};
  if (longtasks.length) batch.longtasks = longtasks;
  if (marks.length) batch.marks = marks;
  longtasks = [];
  marks = [];
  try { window.cth.startupTiming(batch); } catch { /* best-effort */ }
}

/** Epoch ms of a performance timestamp. */
const epoch = (t: number): number => Math.round(performance.timeOrigin + t);

/** Arm the recorder once, at renderer boot. It stops RENDERER_TIMING_WINDOW_MS after this
 *  document started (the main process drops anything past its own window anyway). */
export function startRendererStartupTiming(): void {
  if (recording) return;
  const left = RENDERER_TIMING_WINDOW_MS - performance.now();
  if (left <= 0) return;
  recording = true;
  let observer: PerformanceObserver | null = null;
  try {
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        if (!recording) return;
        for (const e of list.getEntries()) {
          if (e.duration < LONGTASK_MIN_MS) continue;
          const a = (e as PerformanceEntry & { attribution?: Array<{ containerType?: string }> }).attribution?.[0];
          longtasks.push({ at: epoch(e.startTime), ms: Math.round(e.duration), name: e.name, ...(a?.containerType ? { attr: a.containerType } : {}) });
        }
      });
      // buffered: the tasks that ran before this line (the boot itself) are reported too.
      observer.observe({ type: 'longtask', buffered: true });
    }
  } catch { observer = null; }
  const flush = window.setInterval(send, RENDERER_TIMING_FLUSH_MS);
  window.setTimeout(() => {
    recording = false;
    try { observer?.disconnect(); } catch { /* gone */ }
    window.clearInterval(flush);
    send();
    redrawn.clear();
  }, left);
}

/** R1: a terminal was opened (xterm open; WebGL and layout are long-task candidates). */
export function noteTerminalOpen(ptyId: string): void {
  if (!recording) return;
  marks.push({ name: 'terminal-open', at: epoch(performance.now()), id: ptyId });
}

/** Is this terminal's first redraw still to be reported? (checked before term.write) */
export function startupRedrawPending(ptyId: string): boolean {
  return recording && !redrawn.has(ptyId);
}

/** The terminal's first chunk has been parsed into xterm (called from term.write's callback). */
export function noteFirstAgentRedraw(ptyId: string): void {
  if (!recording || redrawn.has(ptyId)) return;
  redrawn.add(ptyId);
  marks.push({ name: 'first-agent-redraw', at: epoch(performance.now()), id: ptyId });
}
