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
 * writer, with a ledger, its import settled) and stops the rest. main calls `sync` once the S0
 * import has settled (so a watcher never races the import) and again on a timer, which picks up a
 * new ledger, a level change and a new hive root. A watcher only appends through W6's append; the
 * store's onAppend then schedules the index sync, as for any claim. It is additive: an edited bullet
 * becomes a new claim and a deleted one stays in the ledger, as at the S0 import.
 *
 * MID-RUN (god 886ed8). An agent raised to reader or writer while the app runs, or given its first
 * ledger, gets the S0 import here (`ensureImported`: its memory.md, archives and frozen backup)
 * BEFORE its memory.md leaves search: discovery waits for the import's settled file
 * (CLAIMS_IMPORT_SETTLED_FILE), which shadowImport writes last. `onSettled` then tells main to sync
 * the agent's claims into the index, which swaps the markdown out. An agent dropped to shadow or off
 * loses its settled file, so a later raise imports again first.
 */
import { rmSync } from 'node:fs';
import type { LedgerLevel } from '../../shared/claims';
import { importSettled, importSettledFile, ReaderWatcher, READER_DEBOUNCE_MS, shadowImport, type IngestDeps } from './ingest';

/** How often main re-checks which agents need a watcher. */
export const READER_WATCH_SYNC_MS = 60_000;

export interface ReaderWatchDeps extends Omit<IngestDeps, 'hiveRoot'> {
  hiveRoot: () => string | null;
  /** The agents with a ledger (main: claimLedgerAgents, segments plus anchored). */
  agents: () => string[];
  /** The agents that may be above off (main: the registry plus the memory-sources.json `ledger`, as importAtStart). */
  candidates?: () => string[];
  level: (agentId: string) => LedgerLevel;
  /** An agent's import settled mid-run: its claims may now replace its markdown (main: index sync). */
  onSettled?: (agentId: string) => void;
  debounceMs?: number;
}

/** Whether an agent at this level has had memory.md swapped out of search for its ledger. */
export const memoryMdReplaced = (level: LedgerLevel): boolean => level === 'reader' || level === 'writer';

export class ReaderWatchers {
  private root: string | null = null;
  private readonly watchers = new Map<string, ReaderWatcher>();
  private readonly importing = new Map<string, Promise<void>>();

  constructor(private readonly d: ReaderWatchDeps) {}

  private levelOf(agent: string): LedgerLevel | null {
    try { return this.d.level(agent); } catch { return null; }
  }

  /** Start a watcher for every agent that needs one and stop the others. Never throws. */
  sync(): void {
    let root: string | null = null;
    try { root = this.d.hiveRoot(); } catch { root = null; }
    if (root !== this.root) { this.stopAll(); this.root = root; }
    if (!root) return;
    let cands: string[] = [];
    try { cands = [...new Set([...(this.d.candidates?.() ?? []), ...this.d.agents()])]; } catch { cands = []; }
    for (const agent of cands) {
      const level = this.levelOf(agent);
      if (level === null) continue;
      if (memoryMdReplaced(level)) { if (!importSettled(root, agent)) void this.ensureImported(agent); continue; }
      // Shadow or off: memory.md is searched again, so a later raise must import what came meanwhile.
      if (importSettled(root, agent) && !this.importing.has(agent)) {
        try { rmSync(importSettledFile(root, agent), { force: true }); this.d.log({ kind: 'claims-import-unsettled', agent, level }); } catch (e) { this.d.log({ kind: 'claims-watch-error', agent, error: String(e).slice(0, 160) }); }
      }
    }
    let want: string[] = [];
    try { want = [...new Set(this.d.agents())].filter((a) => { const l = this.levelOf(a); return l !== null && memoryMdReplaced(l) && importSettled(root as string, a); }); } catch { want = []; }
    for (const [agent, w] of this.watchers) if (!want.includes(agent)) { w.stop(); this.watchers.delete(agent); }
    for (const agent of want) {
      if (this.watchers.has(agent)) continue;
      const w = new ReaderWatcher({ hiveRoot: root, append: this.d.append, read: this.d.read, log: this.d.log }, agent, this.d.debounceMs ?? READER_DEBOUNCE_MS);
      this.watchers.set(agent, w);
      w.start().catch((e) => this.d.log({ kind: 'claims-watch-error', agent, error: String(e).slice(0, 160) }));
    }
  }

  /**
   * The S0 import for one reader or writer agent whose import has not settled (a raise mid-run, a
   * first ledger). One at a time per agent; a call during it gets the same promise. On settling it
   * calls onSettled and syncs (which starts the agent's watcher). Never rejects; a failure is logged
   * and retried at the next sync, memory.md staying searched until then.
   */
  ensureImported(agent: string): Promise<void> {
    const busy = this.importing.get(agent);
    if (busy) return busy;
    let root: string | null = null;
    try { root = this.d.hiveRoot(); } catch { root = null; }
    const level = this.levelOf(agent);
    if (!root || level === null || !memoryMdReplaced(level) || importSettled(root, agent)) return Promise.resolve();
    const at = root;
    const run = shadowImport({ hiveRoot: at, append: this.d.append, read: this.d.read, log: this.d.log }, agent)
      .then(() => {
        if (!importSettled(at, agent)) return;
        try { this.d.onSettled?.(agent); } catch (e) { this.d.log({ kind: 'claims-watch-error', agent, error: String(e).slice(0, 160) }); }
      }, (e) => { this.d.log({ kind: 'claims-import-failed', agent, error: String(e).slice(0, 160) }); })
      .finally(() => {
        this.importing.delete(agent);
        if (this.root === at && importSettled(at, agent)) this.sync();
      });
    this.importing.set(agent, run);
    return run;
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
