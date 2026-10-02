/**
 * HISTORY-SCROLL-FREEZE F3: the `renderer-error` row main writes for what the renderer catches.
 * Jim B2: log.jsonl is read by every agent, so each text is run through redactSecrets (before it is
 * cut), and the flood gate's verdict (repeats, dropped) rides on the row.
 */
import { redactSecrets } from './hive';
import { createRendererErrorGate, normalizeRendererError } from '../shared/rendererError';

export type RendererErrorGate = ReturnType<typeof createRendererErrorGate>;

/** The row to append, or null (not a report, or folded / capped by the gate). */
export function rendererErrorRow(raw: unknown, gate: RendererErrorGate): Record<string, unknown> | null {
  const report = normalizeRendererError(raw, redactSecrets);
  if (!report) return null;
  const v = gate(report);
  if (!v.log) return null;
  return {
    kind: 'renderer-error', ...report,
    ...(v.repeats ? { repeats: v.repeats } : {}),
    ...(v.dropped ? { droppedBefore: v.dropped } : {})
  };
}
