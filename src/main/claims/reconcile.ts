/** W5's durable, main-owned reconciliation queue and per-agent turn sequence. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaimRec, ClaimsState, KeyRegistry, R5Candidate, ReconcileItem } from '../../shared/claims';
import { canonicalJson, sha256Hex } from './canonical';
import { editDistance } from './registry';

/** Provisional W8 replay threshold; tighten if floor reconcile injection exceeds 10k/day. */
export const TAU2 = 0.80;
const queues = new Map<string, ReconcileQueue>();

interface AgentQueue { sequence: number; items: ReconcileItem[]; r5?: R5Candidate[] }
interface QueueState { v: 1; agents: Record<string, AgentQueue>; dailyTokens?: Record<string, number> }
export interface ReconcileCandidate { itemId: string; kind: ReconcileItem['kind']; a: string; b: string; text: string }
export interface TurnOffer { turn: string; items: ReconcileItem[] }
export interface ReconcileDelivery { text: string; tokens: number; itemIds: string[]; turn: string }
export interface ReconcileApiDeps {
  queue: ReconcileQueue;
  countTokens: (text: string) => number;
  log: (row: Record<string, unknown>) => void;
  appendSoftSupersede: (agentId: string, loser: string, winner: string, itemId: string) => Promise<{ ok: boolean }>;
  /** Resolves the deterministic newest-wins direction from verified claim records. */
  newestWins: (item: ReconcileItem) => { loser: string; winner: string } | null;
  isOwner: (agentId: string) => boolean;
}

/** Claims-owned delivery/completion API. Providers only need to call these two methods. */
export class ReconcileApi {
  constructor(private readonly d: ReconcileApiDeps) {}
  reconcileForTurn(agentId: string, day: string): ReconcileDelivery {
    const offer = this.d.isOwner(agentId) ? this.d.queue.beginTurn(agentId, 3) : { turn: '', items: [] };
    const injected: ReconcileItem[] = [];
    for (const item of offer.items) {
      const next = [...injected, item];
      const tokens = next.reduce((n, i) => n + Math.max(0, this.d.countTokens(reconcilePromptText(i))), 0);
      if (tokens > 0 && !this.d.queue.chargeDailyTokens(day, tokens - injected.reduce((n, i) => n + Math.max(0, this.d.countTokens(reconcilePromptText(i))), 0))) break;
      injected.push(item);
    }
    this.d.queue.release(agentId, offer.turn, new Set(injected.map((i) => i.itemId)));
    const text = injected.map(reconcilePromptText).join('\n');
    const tokens = injected.reduce((n, i) => n + Math.max(0, this.d.countTokens(reconcilePromptText(i))), 0);
    const itemIds = injected.map((i) => i.itemId);
    if (tokens > 0) this.d.log({ kind: 'claims-reconcile-injected', agentId, turn: offer.turn, day, tokens, items: itemIds });
    return { text, tokens, itemIds, turn: offer.turn };
  }
  async onTurnCompleted(agentId: string, turn?: string): Promise<void> {
    if (!this.d.isOwner(agentId)) return;
    // The provider supplies the turn returned by reconcileForTurn; omitted means current leased turn.
    const active = turn ?? this.d.queue.items(agentId, 3)[0]?.leaseTurn;
    if (!active) return;
    for (const item of this.d.queue.completeTurn(agentId, active)) {
      if (item.turnsUnanswered < 3 || item.kind !== 'conflict') continue;
      const direction = this.d.newestWins(item);
      if (!direction) continue;
      const result = await this.d.appendSoftSupersede(agentId, direction.loser, direction.winner, item.itemId);
      if (result.ok) this.d.queue.answered(agentId, item.itemId);
    }
  }
}

/** Persists the only W5 authority: monotonic turns, queued items and their current leases. */
export class ReconcileQueue {
  private state: QueueState;
  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {
    this.state = this.load();
  }
  private load(): QueueState {
    try {
      const x = JSON.parse(readFileSync(this.file, 'utf8')) as QueueState;
      if (x?.v === 1 && x.agents && typeof x.agents === 'object') return x;
    } catch { /* absent or invalid state is not trusted */ }
    return { v: 1, agents: {} };
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, canonicalJson(this.state) + '\n', 'utf8');
    // Same-volume rename is atomic; never expose a partially-written lease file.
    renameSync(tmp, this.file);
  }
  private agent(id: string): { sequence: number; items: ReconcileItem[] } {
    return this.state.agents[id] ?? (this.state.agents[id] = { sequence: 0, items: [], r5: [] });
  }
  /** Merge census results without resetting unanswered counts. */
  refresh(agentId: string, candidates: ReconcileCandidate[]): void {
    const s = this.agent(agentId);
    const byId = new Map(s.items.map((i) => [i.itemId, i]));
    const allCandidates = [...candidates, ...this.r5Candidates(agentId)];
    const incoming = new Set(allCandidates.map((c) => c.itemId));
    for (const c of allCandidates) {
      if (!c.itemId || c.a === c.b) continue;
      const old = byId.get(c.itemId);
      byId.set(c.itemId, { itemId: c.itemId, agent: agentId, kind: c.kind, a: c.a, b: c.b, text: c.text,
        turnsUnanswered: old?.turnsUnanswered ?? 0, ...(old?.leasedAt ? { leasedAt: old.leasedAt } : {}), ...(old?.leaseTurn ? { leaseTurn: old.leaseTurn } : {}) });
    }
    // A derived conflict that has been answered (or an alias no longer live) leaves the queue.
    s.items = [...byId.values()].filter((item) => incoming.has(item.itemId));
    this.save();
  }
  enqueueR5(agentId: string, pairs: R5Candidate[]): void {
    const s = this.agent(agentId) as AgentQueue;
    s.r5 ??= [];
    const seen = new Set(s.r5.map((p) => [p.a, p.b].sort().join('\0')));
    for (const p of pairs) {
      if (!Number.isFinite(p.cosine) || !Number.isFinite(p.tau2) || p.cosine < p.tau2 || p.a === p.b) continue;
      const key = [p.a, p.b].sort().join('\0');
      if (!seen.has(key)) { s.r5.push(p); seen.add(key); }
    }
    const byId = new Map(s.items.map((i) => [i.itemId, i]));
    for (const c of this.r5Candidates(agentId)) if (!byId.has(c.itemId)) byId.set(c.itemId, {
      ...c, agent: agentId, turnsUnanswered: 0,
    });
    s.items = [...byId.values()];
    this.save();
  }
  r5Candidates(agentId: string): ReconcileCandidate[] {
    return ((this.state.agents[agentId] as AgentQueue | undefined)?.r5 ?? []).map((p) => {
      const [a, b] = [p.a, p.b].sort();
      return { itemId: reconcileItemId(agentId, 'conflict', a, b), kind: 'conflict', a, b,
        text: `R5 candidate (${p.cosine.toFixed(3)} ≥ ${p.tau2.toFixed(2)}): ${a} / ${b}` };
    });
  }
  answeredPair(agentId: string, a: string, b: string): void {
    const s = this.agent(agentId) as AgentQueue;
    const pair = [a, b].sort().join('\0');
    const before = s.r5?.length ?? 0;
    const itemCount = s.items.length;
    s.r5 = (s.r5 ?? []).filter((p) => [p.a, p.b].sort().join('\0') !== pair);
    s.items = s.items.filter((i) => [i.a, i.b].sort().join('\0') !== pair);
    if ((s.r5?.length ?? 0) !== before || s.items.length !== itemCount) this.save();
  }
  /** Starts a turn using a persisted per-agent counter, never a provider/session identifier. */
  beginTurn(agentId: string, limit = 3): TurnOffer {
    const s = this.agent(agentId);
    // Leases surviving process restart are orphans: reclaim, but do not count unanswered.
    for (const item of s.items) { delete item.leaseTurn; delete item.leasedAt; }
    s.sequence += 1;
    const turn = `${agentId}:${s.sequence}`;
    const items = s.items.filter((i) => !i.leaseTurn).slice(0, Math.max(0, Math.min(3, Math.floor(limit))));
    const leasedAt = this.now().toISOString();
    for (const item of items) { item.leaseTurn = turn; item.leasedAt = leasedAt; }
    this.save();
    return { turn, items: items.map((i) => ({ ...i })) };
  }
  /** A normal completed turn counts only still-leased items; repeated Stop is idempotent. */
  completeTurn(agentId: string, turn: string): ReconcileItem[] {
    const s = this.agent(agentId);
    const completed: ReconcileItem[] = [];
    for (const item of s.items) if (item.leaseTurn === turn) {
      item.turnsUnanswered += 1;
      delete item.leaseTurn; delete item.leasedAt;
      completed.push({ ...item });
    }
    if (completed.length) this.save();
    return completed;
  }
  /** Remove answered items after the ordinary reconcile-answer append has been acknowledged. */
  answered(agentId: string, itemId: string): void {
    const s = this.agent(agentId); const before = s.items.length;
    s.items = s.items.filter((item) => item.itemId !== itemId);
    if (s.items.length !== before) this.save();
  }
  items(agentId: string, max = 3): ReconcileItem[] {
    return this.agent(agentId).items.filter((i) => !!i.leaseTurn).slice(0, Math.max(0, Math.min(3, max))).map((i) => ({ ...i }));
  }
  sequence(agentId: string): number { return this.agent(agentId).sequence; }
  dailyTokens(day: string): number { return this.state.dailyTokens?.[day] ?? 0; }
  chargeDailyTokens(day: string, tokens: number, cap = 10_000): boolean {
    if (!Number.isInteger(tokens) || tokens < 0) return false;
    this.state.dailyTokens ??= {};
    if ((this.state.dailyTokens[day] ?? 0) + tokens > cap) return false;
    this.state.dailyTokens[day] = (this.state.dailyTokens[day] ?? 0) + tokens;
    this.save();
    return true;
  }
  release(agentId: string, turn: string, keep: ReadonlySet<string>): void {
    const s = this.agent(agentId); let changed = false;
    for (const item of s.items) if (item.leaseTurn === turn && !keep.has(item.itemId)) {
      delete item.leaseTurn; delete item.leasedAt; changed = true;
    }
    if (changed) this.save();
  }
}

export function reconcileQueueForHive(hiveRoot: string): ReconcileQueue {
  let q = queues.get(hiveRoot);
  if (!q) { q = new ReconcileQueue(join(hiveRoot, 'claims-reconcile-queue.json')); queues.set(hiveRoot, q); }
  return q;
}

/** R5's main-owned order: verified index first, then ask W3 candidates, then durably enqueue/log. */
export async function enqueueR5AfterIndex(agentId: string, claimId: string, deps: {
  syncIndex: () => Promise<{ sent: boolean; reply?: { ok: boolean } } | null>;
  candidates: (agentId: string, claimId: string, tau2: number) => Promise<R5Candidate[]>;
  enqueue: (agentId: string, pairs: R5Candidate[]) => void;
  log: (row: Record<string, unknown>) => void;
}): Promise<void> {
  try {
    const indexed = await deps.syncIndex();
    if (!indexed?.sent || !indexed.reply?.ok) return;
    const pairs = await deps.candidates(agentId, claimId, TAU2);
    const valid = pairs.filter((p) => Number.isFinite(p.cosine) && p.cosine >= TAU2 && p.a === claimId && p.a !== p.b);
    deps.enqueue(agentId, valid);
    for (const p of valid) deps.log({ kind: 'claims-reconcile-r5-enqueued', agentId, claimId, a: p.a, b: p.b, cosine: p.cosine, tau2: TAU2 });
  } catch { /* indexing/R5 are advisory and cannot roll back an acknowledged append */ }
}

/** Stable item ids are independent of enqueue order and process lifetime. */
export function reconcileItemId(agentId: string, kind: ReconcileItem['kind'], a: string, b: string): string {
  const pair = [a, b].sort().join('\0');
  return `${kind}:${sha256Hex(`${agentId}\0${pair}`).slice(0, 20)}`;
}

export function reconcilePromptText(item: ReconcileItem): string {
  return `⚠ reconcile ${item.itemId}: ${item.text} — Answer: memory reconcile ${item.a} ${item.b} --answer keep-both|supersedes`;
}

/** Pure proposal-only census: same registered namespace, live owner claims, similar distinct keys. */
export function keyAliasCandidates(agentId: string, records: ClaimRec[], state: ClaimsState, registry: KeyRegistry): ReconcileCandidate[] {
  const rows = records.filter((r) => r.agent === agentId && !!r.key && state.claims[r.id]?.status === 'live')
    .sort((a, b) => a.id.localeCompare(b.id));
  const namespace = (key: string) => registry.namespaces
    .map((ns) => ns.pattern.endsWith('.*') ? ns.pattern.slice(0, -1).replace('<id>', agentId) : '')
    .filter((prefix) => prefix && key.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0] ?? '';
  const out: ReconcileCandidate[] = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j], ka = a.key!, kb = b.key!;
    if (ka === kb || namespace(ka) === '' || namespace(ka) !== namespace(kb)) continue;
    const na = ka.replace(/[-_]/g, ''), nb = kb.replace(/[-_]/g, '');
    if (na !== nb && editDistance(ka, kb) > 2) continue;
    const pair = [a.id, b.id].sort();
    out.push({ itemId: reconcileItemId(agentId, 'key-alias', pair[0], pair[1]), kind: 'key-alias', a: pair[0], b: pair[1], text: `Possible key alias: ${ka} / ${kb}` });
  }
  return out;
}
