/**
 * CLAIM-LEDGER W1 -> W6: the append W6 is handed (god 5a86f6, Creed 066833).
 *   W6AppendFn = (agentId, draft, 'w6-internal', { r5 }) => Promise<AppendResult>
 * It appends with the 'w6-internal' origin (the only path to the 4000-character legacy limit).
 * R5 is centralized on W5's after-index main append path; this wrapper never queries the embedder.
 */
import type { AppendResult, RecordDraft } from '../../shared/claims';
import type { ClaimStore } from './store';

export type W6AppendFn = (agentId: string, draft: RecordDraft, origin: 'w6-internal', opts: { r5: boolean }) => Promise<AppendResult>;

export function makeW6Append(
  store: Pick<ClaimStore, 'appendRecord'>,
): W6AppendFn {
  return async (agentId, draft, origin, _opts) => {
    if (origin !== 'w6-internal') return { ok: false, error: 'the W6 append is w6-internal only' };
    const res = await store.appendRecord(agentId, draft, 'w6-internal');
    return res;
  };
}
