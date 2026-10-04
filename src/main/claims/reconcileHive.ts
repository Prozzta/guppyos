import type { ClaimsState, KeyRegistry, LedgerRec, ReconcileItem } from '../../shared/claims';
import { derive } from './derive';
import { verifiedPrefix } from './indexSync';
import { ReconcileApi, keyAliasCandidates, reconcileItemId, type ReconcileQueue } from './reconcile';
import type { ClaimStore } from './store';

type RuntimeStore = Pick<ClaimStore, 'readLedger' | 'appendSoftSupersede'>;
export interface ReconcileHiveDeps {
  endpoint: () => { store: RuntimeStore } | null;
  queue: (root: string) => ReconcileQueue;
  countTokens: (text: string) => number;
  log: (row: Record<string, unknown>) => void;
  registry: (root: string) => KeyRegistry;
  isOwner: (agentId: string) => boolean;
}

/** Refresh the derived census from the verified ledger; R5 candidates are merged by queue.refresh. */
export function refreshReconcileQueueForHive(root: string, agentId: string, deps: ReconcileHiveDeps): number {
  const endpoint = deps.endpoint();
  if (!endpoint) return 0;
  const prefix = verifiedPrefix(endpoint.store.readLedger(agentId));
  if (!prefix) return 0;
  const registry = deps.registry(root);
  const state = derive(prefix.records, registry, { r4: false });
  const claims = prefix.records.filter((rec): rec is Extract<LedgerRec, { t: 'claim' }> => rec.t === 'claim');
  const conflicts = state.conflicts.filter((item) => item.rule === 'R2-mail').map((item) => ({
    itemId: reconcileItemId(agentId, 'conflict', item.a, item.b), kind: 'conflict' as const,
    a: item.a, b: item.b, text: `Conflicting claims: ${item.a} / ${item.b}`,
  }));
  const candidates = [...conflicts, ...keyAliasCandidates(agentId, claims, state, registry)];
  deps.queue(root).refresh(agentId, candidates);
  deps.log({ kind: 'claims-reconcile-refresh', agentId, candidates: candidates.length });
  return candidates.length;
}

type LiveDecision = { live: Set<string>; direction: { loser: string; winner: string } | null };
/** A per-API liveness closure; concurrent agents cannot overwrite one another's verified set. */
export function createReconcileLiveClaims(decide: (item: ReconcileItem) => LiveDecision) {
  let reconcileLiveClaims = new Set<string>();
  const newestWins = (item: ReconcileItem): { loser: string; winner: string } | null => {
    const decision = decide(item);
    reconcileLiveClaims = decision.live;
    return decision.direction;
  };
  return { newestWins, isLiveClaim: (claimId: string) => reconcileLiveClaims.has(claimId) };
}

/** Production hive wiring, extracted so the actual API factory and its per-agent isolation are testable. */
export function reconcileApiForHive(root: string, deps: ReconcileHiveDeps): ReconcileApi | null {
  const endpoint = deps.endpoint();
  if (!endpoint) return null;
  const live = createReconcileLiveClaims((item) => {
    const prefix = verifiedPrefix(endpoint.store.readLedger(item.agent));
    if (!prefix) return { live: new Set(), direction: null };
    const state: ClaimsState = derive(prefix.records, deps.registry(root), { r4: false });
    const claims = prefix.records.filter((rec): rec is Extract<LedgerRec, { t: 'claim' }> => rec.t === 'claim');
    const a = claims.find((claim) => claim.id === item.a); const b = claims.find((claim) => claim.id === item.b);
    const live = new Set(claims.filter((claim) => state.claims[claim.id]?.status === 'live').map((claim) => claim.id));
    if (!a || !b || !live.has(a.id) || !live.has(b.id)) return { live, direction: null };
    const aNewer = a.at > b.at || (a.at === b.at && a.id > b.id);
    return { live, direction: aNewer ? { loser: b.id, winner: a.id } : { loser: a.id, winner: b.id } };
  });
  return new ReconcileApi({
    queue: deps.queue(root), countTokens: deps.countTokens, log: deps.log,
    appendSoftSupersede: (agentId, loser, winner, itemId) => endpoint.store.appendSoftSupersede(agentId, loser, winner, itemId),
    newestWins: live.newestWins, isLiveClaim: live.isLiveClaim, isOwner: deps.isOwner,
  });
}
