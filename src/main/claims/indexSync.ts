/**
 * CLAIM-LEDGER W3: main's side of claim indexing (spec amendment A6).
 *
 * Only main holds the MAC key, so only main can tell a verified ledger from a forged one. After an
 * append (and when the memory worker (re)starts: G3.3), main reads the agent's ledger VERIFIED,
 * derives its state (W2's pure derive), builds the claim chunks (chunksFor) and sends them to the
 * worker, which embeds only new parts and updates statuses in place. The worker never reads ledger
 * lines itself.
 *   - Only agents at an effective level of reader or writer are sent (shadow: not indexed).
 *   - A chain break (mac, prev, parse): only the records BEFORE the break are sent, so a forged or
 *     edited line never reaches search (M9); the index drops anything after it.
 *   - A lost key, or a head-anchor break (a cut or deleted ledger): nothing is sent; the index
 *     keeps what was verified.
 *   - Syncs are debounced per agent (a burst of notes is one sync) and never overlap per agent.
 */
import type { DeriveFn, KeyRegistry, LedgerLevel, LedgerRec, ReadResult } from '../../shared/claims';
import { claimsSourcePath } from '../nativeMemory/sources';
import { chunksFor, withParts } from './chunks';

export const CLAIMS_SYNC_DEBOUNCE_MS = 300;

export interface IndexSyncDeps {
  readLedger: (agentId: string) => ReadResult;
  /** W2's derive (null until W2 is integrated: then nothing is indexed, and that is logged once). */
  derive: () => DeriveFn | null;
  registry: () => KeyRegistry;
  ruleConfig: () => { r4: boolean };
  level: (agentId: string) => LedgerLevel;
  /** Agents that have a ledger. */
  agents: () => string[];
  send: (args: { wing: string; path: string; head: string; chunks: unknown[]; delta?: boolean }) => Promise<{ ok: boolean; error?: string; json?: unknown }>;
  /** Called after a verified snapshot is successfully indexed. */
  onIndexed?: (agentId: string) => void;
  log?: (row: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export type SyncOutcome =
  | { sent: true; records: number; chunks: number; truncatedAt?: string; reply: { ok: boolean; error?: string; json?: unknown } }
  | { sent: false; why: 'level' | 'no-derive' | 'key-missing' | 'head-anchor' | 'empty' };

/** The records a sync may index: all of them, or those before a chain break; none on a lost key. */
export function verifiedPrefix(r: ReadResult): { records: LedgerRec[]; truncatedAt?: string } | null {
  const chain = r.chain;
  if (chain === 'ok') return { records: r.records };
  // A lost key, or a ledger that no longer reaches its anchored head (cut, deleted: Jim's
  // CLAIMS-HEAD-ANCHOR should): nothing is sent, so the index keeps its verified state.
  if (chain.reason === 'key-missing' || chain.brokenAt === 'head-anchor') return null;
  const i = r.records.findIndex((x) => x.id === chain.brokenAt);
  return { records: i < 0 ? [] : r.records.slice(0, i), truncatedAt: chain.brokenAt };
}

export class ClaimsIndexSync {
  private timers = new Map<string, unknown>();
  private running = new Map<string, Promise<SyncOutcome>>();
  // A verified snapshot lets an acked store append avoid reading any old segment.  Calls without
  // an acknowledged record (startup, a watcher/import or recovery) deliberately take the full,
  // integrity-checking read path.
  private snapshots = new Map<string, { records: LedgerRec[]; chunks: Array<{ claimId: string; part: number; contentSha256: string; status: string }> }>();
  private pending = new Map<string, LedgerRec[]>();
  private noDeriveLogged = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: IndexSyncDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** After an append: sync this agent soon (debounced). */
  schedule(agentId: string, appended?: LedgerRec): void {
    if (appended) this.pending.set(agentId, [...(this.pending.get(agentId) ?? []), appended]);
    const t = this.timers.get(agentId);
    if (t) this.clearTimer(t);
    this.timers.set(agentId, this.setTimer(() => { this.timers.delete(agentId); void this.syncNow(agentId); }, CLAIMS_SYNC_DEBOUNCE_MS));
  }

  /** A (re)started worker: every agent with a ledger, now. */
  syncAll(): Promise<SyncOutcome[]> {
    return Promise.all(this.d.agents().map((a) => this.syncNow(a)));
  }

  syncNow(agentId: string, appended?: LedgerRec): Promise<SyncOutcome> {
    if (appended) this.pending.set(agentId, [...(this.pending.get(agentId) ?? []), appended]);
    const prior = this.running.get(agentId) ?? Promise.resolve(null);
    const run = prior.catch(() => null).then(() => this.syncOnce(agentId));
    this.running.set(agentId, run);
    return run;
  }

  private async syncOnce(agentId: string): Promise<SyncOutcome> {
    const level = this.d.level(agentId);
    if (level !== 'reader' && level !== 'writer') return { sent: false, why: 'level' };
    const derive = this.d.derive();
    if (!derive) {
      if (!this.noDeriveLogged) { this.noDeriveLogged = true; this.d.log?.({ kind: 'claims-index-no-derive' }); }
      return { sent: false, why: 'no-derive' };
    }
    const queued = this.pending.get(agentId) ?? [];
    const previous = this.snapshots.get(agentId);
    // Only ClaimStore's fsync-acked callback supplies `queued`; it is safe to extend the already
    // verified snapshot with it.  Every other reason to sync reads and verifies the ledger again.
    const delta = !!previous && queued.length > 0;
    const read: ReadResult = delta
      ? { records: [...previous.records, ...queued], torn: null, chain: 'ok' }
      : this.d.readLedger(agentId);
    const prefix = verifiedPrefix(read);
    if (!prefix) {
      const why = read.chain !== 'ok' && read.chain.brokenAt === 'head-anchor' ? 'head-anchor' : 'key-missing';
      this.d.log?.({ kind: 'claims-index-skipped', agentId, why });
      return { sent: false, why };
    }
    const state = derive(prefix.records, this.d.registry(), this.d.ruleConfig());
    const allChunks = withParts(chunksFor(prefix.records, state));
    const old = new Map((previous?.chunks ?? []).map((c) => [`${c.claimId}\0${c.part}`, `${c.contentSha256}\0${c.status}`]));
    // A delta carries additions and claims whose derived status changed.  The worker preserves
    // omitted rows for this mode; a full verification remains authoritative for removals/recovery.
    const chunks = delta ? allChunks.filter((c) => old.get(`${c.claimId}\0${c.part}`) !== `${c.contentSha256}\0${c.status}`) : allChunks;
    const head = state.ledgerHead || (prefix.records.length ? prefix.records[prefix.records.length - 1].mac : '');
    const reply = await this.d.send({ wing: agentId, path: claimsSourcePath(agentId), head, chunks, ...(delta ? { delta: true } : {}) });
    if (!reply.ok) this.d.log?.({ kind: 'claims-index-failed', agentId, error: String(reply.error ?? '').slice(0, 160) });
    else {
      this.snapshots.set(agentId, { records: prefix.records, chunks: allChunks });
      // Do not discard an append that arrived while the worker request was in flight.
      const later = this.pending.get(agentId) ?? [];
      if (later.length <= queued.length) this.pending.delete(agentId);
      else this.pending.set(agentId, later.slice(queued.length));
      this.d.onIndexed?.(agentId);
    }
    return { sent: true, records: prefix.records.length, chunks: chunks.length, ...(prefix.truncatedAt ? { truncatedAt: prefix.truncatedAt } : {}), reply };
  }
}
