/**
 * CLAIM-LEDGER S0 at claims start (REL-184, Jim option (a), god go 06:01Z).
 *
 * THE GAP. Discovery swaps an agent's memory.md, archives and exports out of search as soon as the
 * agent has a ledger segment (sources.ts ledgerReplaced). With no import, a writer's first claim
 * made that segment and its legacy notes left search and wake-up. So, once per hive root at claims
 * start, every agent whose effective level is shadow or higher gets shadowImport (ingest.ts): the
 * frozen backup, then every legacy entry the ledger lacks (idempotent: a re-run appends nothing; a
 * broken chain or a partial backup refuses and is reported). Its claims-import row is logged there.
 *
 * THE ORDER. main holds every path that forks the memory worker or appends a claim (memory
 * requests, the ledger route, the index sync, the prewarm) until this run has settled, so the first
 * discovery that sees a segment already sees its legacy entries in it.
 *
 * Wiring only: the import, the levels and the M4 gating are unchanged.
 */
import type { LedgerLevel } from '../../shared/claims';
import { shadowImport, type IngestDeps, type IngestReport } from './ingest';

export interface StartupImportDeps extends IngestDeps {
  /** The agents that may be above off (main: the registry plus the memory-sources.json `ledger`). */
  agents: () => string[];
  level: (agentId: string) => LedgerLevel;
}

/** Run S0 for each agent at shadow or higher, one at a time. Never throws: a failure is logged. */
export async function importAtStart(d: StartupImportDeps): Promise<IngestReport[]> {
  const reports: IngestReport[] = [];
  let agents: string[] = [];
  try { agents = [...new Set(d.agents())]; } catch { agents = []; }
  for (const agent of agents) {
    try {
      if (d.level(agent) === 'off') continue;
      reports.push(await shadowImport(d, agent));
    } catch (e) {
      d.log({ kind: 'claims-import-failed', agent, error: String(e).slice(0, 160) });
    }
  }
  return reports;
}
