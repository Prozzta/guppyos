/**
 * HISTORY-SCROLL-FREEZE F3: a renderer exception leaves a row in log.jsonl.
 *
 * Before 1.1.80 a render error in any component unmounted the WHOLE React root (no error
 * boundary anywhere) and left no trace: the window went dead while main and the agents ran on,
 * and log.jsonl had nothing to show for it. The renderer now reports what it catches (an error
 * boundary, a window `error`, an `unhandledrejection`) and main writes one `renderer-error` row.
 *
 * Pure: the report's shape, its validation, and the flood gate main applies.
 */

export type RendererErrorSource = 'boundary' | 'window-error' | 'unhandledrejection';

export interface RendererErrorReport {
  source: RendererErrorSource;
  /** The boundary that caught it ('History', 'App'), when a boundary did. */
  where?: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export const RENDERER_ERROR_MESSAGE_MAX = 500;
export const RENDERER_ERROR_STACK_MAX = 4000;
export const RENDERER_ERROR_WHERE_MAX = 80;

const SOURCES: readonly RendererErrorSource[] = ['boundary', 'window-error', 'unhandledrejection'];
const cut = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/** The report as main logs it, or null when it is not one (never trusted from the sender). */
export function normalizeRendererError(raw: unknown): RendererErrorReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!SOURCES.includes(r.source as RendererErrorSource)) return null;
  const message = cut(r.message, RENDERER_ERROR_MESSAGE_MAX);
  if (!message) return null;
  const out: RendererErrorReport = { source: r.source as RendererErrorSource, message };
  const where = cut(r.where, RENDERER_ERROR_WHERE_MAX);
  const stack = cut(r.stack, RENDERER_ERROR_STACK_MAX);
  const componentStack = cut(r.componentStack, RENDERER_ERROR_STACK_MAX);
  if (where) out.where = where;
  if (stack) out.stack = stack;
  if (componentStack) out.componentStack = componentStack;
  return out;
}

export const RENDERER_ERROR_PER_MINUTE = 20;
export const RENDERER_ERROR_REPEAT_MS = 2000;

/**
 * The flood gate: at most `perMinute` rows a minute, and the same message again within
 * `repeatMs` is one row (a boundary's catch and the window's echo of it). A row after a dropped
 * stretch says how many were dropped.
 */
export function createRendererErrorGate(opts: { now?: () => number; perMinute?: number; repeatMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const perMinute = opts.perMinute ?? RENDERER_ERROR_PER_MINUTE;
  const repeatMs = opts.repeatMs ?? RENDERER_ERROR_REPEAT_MS;
  let minute = -1;
  let count = 0;
  let dropped = 0;
  let lastMessage = '';
  let lastAt = -Infinity;
  return (report: RendererErrorReport): { log: boolean; dropped: number } => {
    const t = now();
    if (report.message === lastMessage && t - lastAt < repeatMs) { lastAt = t; return { log: false, dropped }; }
    lastMessage = report.message; lastAt = t;
    const m = Math.floor(t / 60_000);
    if (m !== minute) { minute = m; count = 0; }
    if (count >= perMinute) { dropped += 1; return { log: false, dropped }; }
    count += 1;
    const d = dropped; dropped = 0;
    return { log: true, dropped: d };
  };
}
