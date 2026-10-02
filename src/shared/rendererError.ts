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
/** Jim N3: small enough that the hourly cap below bounds the log's growth (~2.5 KB a row at most). */
export const RENDERER_ERROR_STACK_MAX = 1000;
export const RENDERER_ERROR_WHERE_MAX = 80;

const SOURCES: readonly RendererErrorSource[] = ['boundary', 'window-error', 'unhandledrejection'];
/**
 * The report as main logs it, or null when it is not one (never trusted from the sender).
 * Jim B2: every text goes through `redact` (main passes hive.redactSecrets) BEFORE it is cut, so a
 * cut can never leave the head of a secret that is too short to be recognised any more.
 */
export function normalizeRendererError(raw: unknown, redact: (s: string) => string = (s) => s): RendererErrorReport | null {
  const cut = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? redact(v).slice(0, max) : undefined);
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
/** Jim N3: at most this many rows an hour (about 300 KB at the caps): errors can never rotate log.jsonl. */
export const RENDERER_ERROR_PER_HOUR = 120;
/** Jim N2: the same message again within this window adds to a count instead of a row. */
export const RENDERER_ERROR_REPEAT_MS = 60_000;
const REMEMBERED = 50;

export interface RendererErrorVerdict {
  log: boolean;
  /** Rows dropped by the minute/hour caps since the last logged row. */
  dropped: number;
  /** Times THIS message came again (folded) since its previous row. */
  repeats: number;
}

/**
 * The flood gate. The same message again within `repeatMs` of its last ROW is counted, not logged
 * (a boundary's catch and the window's echo of it; a loop throwing every frame); its next row, once
 * the window has passed, carries `repeats`. Distinct messages are capped per minute and per hour;
 * the next row after a capped stretch carries `dropped`.
 */
export function createRendererErrorGate(opts: { now?: () => number; perMinute?: number; perHour?: number; repeatMs?: number } = {}) {
  const now = opts.now ?? Date.now;
  const perMinute = opts.perMinute ?? RENDERER_ERROR_PER_MINUTE;
  const perHour = opts.perHour ?? RENDERER_ERROR_PER_HOUR;
  const repeatMs = opts.repeatMs ?? RENDERER_ERROR_REPEAT_MS;
  let minute = -1; let inMinute = 0;
  let hour = -1; let inHour = 0;
  let dropped = 0;
  // message -> when it was last LOGGED, and how often it came since (insertion order = age)
  const seen = new Map<string, { at: number; repeats: number }>();
  return (report: RendererErrorReport): RendererErrorVerdict => {
    const t = now();
    const prev = seen.get(report.message);
    if (prev && t - prev.at < repeatMs) { prev.repeats += 1; return { log: false, dropped, repeats: prev.repeats }; }
    const m = Math.floor(t / 60_000);
    const h = Math.floor(t / 3_600_000);
    if (m !== minute) { minute = m; inMinute = 0; }
    if (h !== hour) { hour = h; inHour = 0; }
    if (inMinute >= perMinute || inHour >= perHour) { dropped += 1; return { log: false, dropped, repeats: 0 }; }
    inMinute += 1; inHour += 1;
    const repeats = prev ? prev.repeats : 0;
    seen.delete(report.message);
    seen.set(report.message, { at: t, repeats: 0 });
    if (seen.size > REMEMBERED) seen.delete(seen.keys().next().value as string);
    const d = dropped; dropped = 0;
    return { log: true, dropped: d, repeats };
  };
}
