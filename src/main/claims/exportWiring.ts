/**
 * CLAIM-LEDGER W6 wiring (plan §3 W6 "Exports"; S2 writer items, plan L509): the production callers
 * of exportLedger.ts, the way delivery.ts wires W4: every dependency injected, main supplies them.
 *
 * - CONTINUOUS EXPORT. After each acked append of an agent at the effective level 'writer', the
 *   agent's export catches up with `syncExport` (the new record, and anything a crash left out; the
 *   archive-backed legacy claims stay out, recomputed per call), then `appendStatusMarkers` writes a
 *   marker line for every status the append changed (the state with and without that record). It
 *   runs off the append's path (setImmediate), one agent at a time, and never throws: a failure is a
 *   `claims-export-failed` log row, and the next append or start-up sync catches up.
 * - START-UP SYNC (the switch to writer mode, a restart after a crash): `syncAll` runs `syncExport` for
 *   every writer agent with a ledger. No markers: their moment is the append.
 * - COMPLETE EXPORT (`memory export --complete`, the planned downgrade path): `complete` replaces the
 *   agent's memory.md with W4's complete rendering, without the archive-backed entries (ruling 2).
 *   The export format is exportLedger.ts's and W4's; nothing here renders.
 */
import type { ClaimsState, DeriveFn, KeyRegistry, LedgerLevel, LedgerRec, WorldView } from '../../shared/claims';
import { appendStatusMarkers, archiveBackedIds, exportComplete, syncExport } from './exportLedger';
import { createClaimViews } from './views';

export interface ClaimExportDeps {
  level: (agentId: string) => LedgerLevel;
  /** The agent's folder (where memory.md and the export files live); null for an unknown agent. */
  agentDir: (agentId: string) => string | null;
  /** The verified ledger (the store's readLedger). */
  readLedger: (agentId: string) => { records: LedgerRec[] };
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

  const exportAppend = (agentId: string, id: string, rec: LedgerRec): void => {
    if (d.level(agentId) !== 'writer') return;
    const dir = d.agentDir(agentId);
    if (!dir) return;
    const records = d.readLedger(agentId).records;
    const state = derive(records);
    const lines = syncExport(dir, records, state, createClaimViews(records, NO_TOKENS).renderExportLine);
    const before = derive(records.filter((r) => r.id !== id));
    const markers = appendStatusMarkers(dir, agentId, before, state, rec.wt);
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
          const records = d.readLedger(agentId).records;
          if (!records.length) continue;
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
        const records = d.readLedger(agentId).records;
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
