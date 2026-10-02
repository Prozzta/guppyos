/**
 * HISTORY-SCROLL-FREEZE F3: forward what the renderer catches to main, which writes one
 * `renderer-error` row in log.jsonl (shared/rendererError.ts). Best-effort: reporting never throws.
 */
import type { RendererErrorReport } from '@shared/rendererError';

type Send = (report: RendererErrorReport) => void;

const defaultSend: Send = (report) => {
  (window as unknown as { cth?: { logRendererError?: Send } }).cth?.logRendererError?.(report);
};

const text = (v: unknown): string => {
  if (v instanceof Error) return v.message || v.name;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
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
