/**
 * HISTORY-SCROLL-FREEZE F3: forward what the renderer catches to main, which writes one
 * `renderer-error` row in log.jsonl (shared/rendererError.ts). Best-effort: reporting never throws.
 */
import type { RendererErrorReport } from '@shared/rendererError';

type Send = (report: RendererErrorReport) => void;

const defaultSend: Send = (report) => {
  (window as unknown as { cth?: { logRendererError?: Send } }).cth?.logRendererError?.(report);
};

/** Jim B2: an Error's message or a string; anything else by its TYPE only (a rejected object can
 *  carry tokens or account data, so none of its fields are sent). */
export const text = (v: unknown): string => {
  if (v instanceof Error) return v.message || v.name;
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return `a rejected ${(v as object).constructor?.name || 'object'} (fields not logged)`;
  return `a rejected ${typeof v}`;
};

export function reportRendererError(report: RendererErrorReport, send: Send = defaultSend): void {
  try { send(report); } catch { /* reporting never throws */ }
}

let installed = false;

/** Window `error` and `unhandledrejection` → one report each. Idempotent. */
export function installRendererErrorForwarder(target: Window = window, send: Send = defaultSend): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (e: ErrorEvent) => {
    reportRendererError({
      source: 'window-error',
      message: e.message || text(e.error),
      stack: e.error instanceof Error ? e.error.stack : undefined
    }, send);
  });
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportRendererError({
      source: 'unhandledrejection',
      message: text(e.reason),
      stack: e.reason instanceof Error ? e.reason.stack : undefined
    }, send);
  });
}
