/**
 * CL-READERWATCHER: keep a reader or writer agent's hand edits of memory.md searchable while the app runs.
 *
 * THE GAP. Discovery drops memory.md from search for an agent at reader or writer level that has a
 * ledger (sources.ts ledgerReplaced); its claims are searched instead. The only path from memory.md
 * into the ledger was the S0 import at claims start (startupImport.ts), so a bullet written into
 * memory.md while the app ran stayed out of search until the next start. W6's ReaderWatcher
 * (ingest.ts: a scan at start, then a scan after each change) was built and tested, but nothing
 * started it.
 *
 * THIS MODULE starts one ReaderWatcher per agent whose memory.md has left search (level reader or
 * writer, with a ledger) and stops the rest. main calls `sync` once the S0 import has settled (so a
 * watcher never races the import) and again on a timer, which picks up a new ledger, a level change
 * and a new hive root. A watcher only appends through W6's append; the store's onAppend then
 * schedules the index sync, as for any claim. It is additive: an edited bullet becomes a new claim
 * and a deleted one stays in the ledger, as at the S0 import.
 */
import type { LedgerLevel } from '../../shared/claims';
import { ReaderWatcher, READER_DEBOUNCE_MS, type IngestDeps } from './ingest';

/** How often main re-checks which agents need a watcher. */
export const READER_WATCH_SYNC_MS = 60_000;

export interface ReaderWatchDeps extends Omit<IngestDeps, 'hiveRoot'> {
  hiveRoot: () => string | null;
  /** The agents with a ledger (main: claimLedgerAgents, segments plus anchored). */
  agents: () => string[];
  level: (agentId: string) => LedgerLevel;
  debounceMs?: number;
}

/** Whether an agent at this level has had memory.md swapped out of search for its ledger. */
export const memoryMdReplaced = (level: LedgerLevel): boolean => level === 'reader' || level === 'writer';

export class ReaderWatchers {
  private root: string | null = null;
  private readonly watchers = new Map<string, ReaderWatcher>();

  constructor(private readonly d: ReaderWatchDeps) {}

  /** Start a watcher for every agent that needs one and stop the others. Never throws. */
  sync(): void {
    let root: string | null = null;
    try { root = this.d.hiveRoot(); } catch { root = null; }
    if (root !== this.root) { this.stopAll(); this.root = root; }
    if (!root) return;
    let want: string[] = [];
    try { want = [...new Set(this.d.agents())].filter((a) => { try { return memoryMdReplaced(this.d.level(a)); } catch { return false; } }); } catch { want = []; }
    for (const [agent, w] of this.watchers) if (!want.includes(agent)) { w.stop(); this.watchers.delete(agent); }
    for (const agent of want) {
      if (this.watchers.has(agent)) continue;
      const w = new ReaderWatcher({ hiveRoot: root, append: this.d.append, read: this.d.read, log: this.d.log }, agent, this.d.debounceMs ?? READER_DEBOUNCE_MS);
      this.watchers.set(agent, w);
      w.start().catch((e) => this.d.log({ kind: 'claims-watch-error', agent, error: String(e).slice(0, 160) }));
    }
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }

  /** The agents watched now (for tests and logs). */
  watching(): string[] {
    return [...this.watchers.keys()].sort();
  }
}
