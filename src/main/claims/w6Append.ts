/**
 * CLAIM-LEDGER W1 -> W6: the append W6 is handed (god 5a86f6, Creed 066833).
 *   W6AppendFn = (agentId, draft, 'w6-internal', { r5 }) => Promise<AppendResult>
 * It appends with the 'w6-internal' origin (the only path to the 4000-character legacy limit), then,
 * ONLY when opts.r5 is true and the append was acked, asks W3 for R5 candidates and hands them to W5.
 * The legacy import passes { r5: false }, so an N-claim import enqueues nothing (Jim, binding); the
 * reader-mode watcher passes { r5: true }. A failed candidate lookup never fails the append.
 */
import type { AppendResult, EnqueueCandidatesFn, R5CandidatesFn, RecordDraft } from '../../shared/claims';
import type { ClaimStore } from './store';

export type W6AppendFn = (agentId: string, draft: RecordDraft, origin: 'w6-internal', opts: { r5: boolean }) => Promise<AppendResult>;

export function makeW6Append(
  store: Pick<ClaimStore, 'appendRecord'>,
  r5: { candidates: R5CandidatesFn; enqueue: EnqueueCandidatesFn } | null,
  log: (row: Record<string, unknown>) => void = () => undefined,
): W6AppendFn {
  return async (agentId, draft, origin, opts) => {
    if (origin !== 'w6-internal') return { ok: false, error: 'the W6 append is w6-internal only' };
    const res = await store.appendRecord(agentId, draft, 'w6-internal');
    if (res.ok && opts?.r5 === true && r5 && draft.t === 'claim') {
      try {
        const pairs = await r5.candidates(agentId, res.id);
        if (pairs.length) r5.enqueue(agentId, pairs);
      } catch (e) {
        log({ kind: 'claims-r5-failed', agentId, id: res.id, error: String(e).slice(0, 160) });
      }
    }
    return res;
  };
}
