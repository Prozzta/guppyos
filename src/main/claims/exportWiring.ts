/**
 * CLAIM-LEDGER W6 wiring (plan §3 W6 "Exports"; S2 writer items, plan L509): the production callers
 * of exportLedger.ts, the way delivery.ts wires W4: every dependency injected, main supplies them.
 *
 * - CONTINUOUS EXPORT. After each acked append of an agent at the effective level 'writer', the
 *   agent's export catches up with `syncExport` (the new record, and anything a crash left out; the
 *   archive-backed legacy claims stay out, recomputed per call), then `appendStatusMarkers` writes a
 *   marker line for every status that record changed: POSITIONAL states, the ledger up to but
 *   excluding the record and up to and including it (Creed M-B), so a burst of appends with no yield
 *   between them still marks each real change exactly once. It runs off the append's path
 *   (setImmediate), one agent at a time, and never throws: a failure is a `claims-export-failed` log
 *   row, and the next append or start-up sync catches up.
 * - ONLY VERIFIED RECORDS (Creed M-A): every path reads through W3's `verifiedPrefix`. No prefix (a lost
 *   key, a ledger cut below its anchored head): nothing is exported, and a `claims-export-unverified`
 *   row says why. A chain or MAC break: only the records before it, and `claims-export-truncated` names
 *   it. `complete` refuses both: a complete memory.md must be the whole verified ledger.
 * - START-UP SYNC (the switch to writer mode, a restart after a crash): `syncAll` runs `syncExport` for
 *   every writer agent with a ledger. No markers: their moment is the append.
 * - COMPLETE EXPORT (`memory export --complete`, the planned downgrade path): `complete` replaces the
 *   agent's memory.md with W4's complete rendering, without the archive-backed entries (ruling 2).
 *   The export format is exportLedger.ts's and W4's; nothing here renders.
 */
import type { ClaimsState, DeriveFn, KeyRegistry, LedgerLevel, LedgerRec, ReadResult, WorldView } from '../../shared/claims';
import { appendStatusMarkers, archiveBackedIds, exportComplete, syncExport } from './exportLedger';
import { verifiedPrefix } from './indexSync';
import { createClaimViews } from './views';

export interface ClaimExportDeps {
  level: (agentId: string) => LedgerLevel;
  /** The agent's folder (where memory.md and the export files live); null for an unknown agent. */
  agentDir: (agentId: string) => string | null;
  /** The store's readLedger; only its verifiedPrefix is ever exported. */
  readLedger: (agentId: string) => ReadResult;
  registry: () => KeyRegistry;
  derive: DeriveFn;
  /** The world view for the complete rendering (statuses come from the state; flags from here). */
  view: (agentId: string, records: LedgerRec[], state: ClaimsState) => WorldView;
  log: (row: Record<string, unknown>) => void;
  /** Tests run the queued work at once; main defers it off the append's path. */
  defer?: (fn: () => void) => void;
}

export type CompleteExportResult = { ok: true; file: string; bytes: number; note: string } | { ok: false; error: string };

export interface ClaimExport {
  /** The store's onAppend: queue the continuous export of this record (writer agents only). */
  onAppend: (agentId: string, id: string, rec: LedgerRec) => void;
  /** Catch up the continuous export of these agents (writer agents only); the number of lines added. */
  syncAll: (agents: string[]) => number;
  /** `memory export --complete` for one agent. */
  complete: (agentId: string) => CompleteExportResult;
  /** Resolves when every queued export has run (tests, shutdown). */
  drain: () => Promise<void>;
}

/** The renderers do not budget an export, so a token count is never needed; this stands in for one. */
const NO_TOKENS = (text: string): number => Math.ceil(text.length / 4);

export function createClaimExport(d: ClaimExportDeps): ClaimExport {
  const defer = d.defer ?? ((fn) => { setImmediate(fn); });
  const derive = (records: LedgerRec[]): ClaimsState => d.derive(records, d.registry(), { r4: false });
  const fail = (agentId: string, step: string, e: unknown): void => {
    try { d.log({ kind: 'claims-export-failed', agentId, step, error: String(e).slice(0, 160) }); } catch { /* best effort */ }
  };
  // One agent's export work at a time, in append order (a chain per agent).
  const chains = new Map<string, Promise<void>>();
  const enqueue = (agentId: string, fn: () => void): void => {
    const run = (): void => { try { fn(); } catch (e) { fail(agentId, 'append', e); } };
    const prev = chains.get(agentId) ?? Promise.resolve();
    const next = prev.then(() => new Promise<void>((resolve) => defer(() => { run(); resolve(); })));
    chains.set(agentId, next);
    void next.then(() => { if (chains.get(agentId) === next) chains.delete(agentId); });
  };

  /** The agent's verified records (W3's verifiedPrefix), logging a refusal or a truncation (ids only). */
  const verified = (agentId: string, step: string): { records: LedgerRec[]; truncatedAt?: string } | null => {
    const read = d.readLedger(agentId);
    const prefix = verifiedPrefix(read);
    if (!prefix) {
      const chain = read.chain === 'ok' ? null : read.chain;
      d.log({ kind: 'claims-export-unverified', agentId, step, reason: chain?.reason ?? 'unknown', brokenAt: chain?.brokenAt ?? null });
      return null;
    }
    if (prefix.truncatedAt) d.log({ kind: 'claims-export-truncated', agentId, step, truncatedAt: prefix.truncatedAt, records: prefix.records.length });
    return prefix;
  };

  const exportAppend = (agentId: string, id: string, rec: LedgerRec): void => {
    if (d.level(agentId) !== 'writer') return;
    const dir = d.agentDir(agentId);
    if (!dir) return;
    const prefix = verified(agentId, 'append');
    if (!prefix) return;
    const records = prefix.records;
    // M-B: the states just before and just after THIS record, whatever was appended since.
    const at = records.findIndex((r) => r.id === id);
    const after = at < 0 ? null : derive(records.slice(0, at + 1));
    const state = after && at === records.length - 1 ? after : derive(records);
    const lines = syncExport(dir, records, state, createClaimViews(records, NO_TOKENS).renderExportLine);
    const markers = after ? appendStatusMarkers(dir, agentId, derive(records.slice(0, at)), after, rec.wt) : 0;
    d.log({ kind: 'claims-export-append', agentId, id, lines, markers });
  };

  return {
    onAppend: (agentId, id, rec) => {
      try { enqueue(agentId, () => exportAppend(agentId, id, rec)); } catch (e) { fail(agentId, 'append', e); }
    },
    syncAll: (agents) => {
      let total = 0;
      for (const agentId of agents) {
        try {
          if (d.level(agentId) !== 'writer') continue;
          const dir = d.agentDir(agentId);
          if (!dir) continue;
          const prefix = verified(agentId, 'sync');
          if (!prefix?.records.length) continue;
          const records = prefix.records;
          const n = syncExport(dir, records, derive(records), createClaimViews(records, NO_TOKENS).renderExportLine);
          if (n) d.log({ kind: 'claims-export-sync', agentId, lines: n });
          total += n;
        } catch (e) { fail(agentId, 'sync', e); }
      }
      return total;
    },
    drain: async () => { await Promise.all([...chains.values()]); },
    complete: (agentId) => {
      try {
        const dir = d.agentDir(agentId);
        if (!dir) return { ok: false, error: `${agentId} has no agent folder` };
        const prefix = verified(agentId, 'complete');
        if (!prefix) return { ok: false, error: 'refused: your claim ledger cannot be verified (a lost key or a cut ledger); memory.md was not changed' };
        if (prefix.truncatedAt) return { ok: false, error: `refused: your claim ledger fails verification at ${prefix.truncatedAt}; a complete export would drop what follows, so memory.md was not changed` };
        const records = prefix.records;
        const state = derive(records);
        const r = exportComplete(dir, state, d.view(agentId, records, state), createClaimViews(records, NO_TOKENS).renderMemoryMd, archiveBackedIds(dir, records, state));
        d.log({ kind: 'claims-export-complete', agentId, bytes: r.bytes });
        return { ok: true, ...r };
      } catch (e) {
        fail(agentId, 'complete', e);
        return { ok: false, error: `export --complete failed: ${String(e).slice(0, 160)}` };
      }
    },
  };
}
