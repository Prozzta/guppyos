/**
 * CLAIM-LEDGER W6: the S0 import run and the reader-mode watcher (plan §3 W6, gates G6.1, G6.5, G6.7).
 *
 * THE APPEND PATH. Both append only through W6AppendFn: W1's appendRecord with origin 'w6-internal'
 * (claims.ts AppendOrigin, the one origin allowed the legacy provenance field and up to
 * CLAIM_TEXT_MAX_LEGACY) plus an explicit `{ r5 }` option. Main's wrapper runs the R5 hook
 * (R5CandidatesFn → EnqueueCandidatesFn) only when `r5` is true. It is injected (IngestDeps), so this
 * file holds no store code and the tests use a fake ledger.
 *
 * NO R5 ON THE IMPORT (god c446a1, binding; enforced, god 5a86f6): shadowImport passes `r5: false`
 * on every append, and its test shows an N-claim import enqueues 0. The reader watcher's entries are
 * NEW notes written after the import, so they pass `r5: true`.
 *
 * Refusals are REPORTED, never dropped silently (god ce0e54, 5a86f6): an entry W6 cannot split (a
 * single line over the limit) and every draft appendRecord refuses go into the report and one
 * `claims-import-refused` log row each.
 *
 * Nothing is appended when:
 *   - the ledger is read-only (ReadResult.chain !== 'ok': a broken chain or a lost key);
 *   - the frozen backup found a partial destination it must not overwrite (import only).
 * The report says why.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { CLAIMS_IMPORT_SETTLED_FILE, type AppendResult, type ReadLedgerFn, type RecordDraft } from '../../shared/claims';
import { frozenBackup, knownIdsFor, newLegacyImport, parseNewBulletsDetailed, type Refusal } from './migrate';

export type { Refusal } from './migrate';

/** Whether main's wrapper runs the R5 hook after this append. */
export interface W6AppendOpts { r5: boolean }
/** appendRecord(agentId, draft, 'w6-internal') plus the R5 switch. Main's wrapper honours `r5`. */
export type W6AppendFn = (agentId: string, draft: RecordDraft, origin: 'w6-internal', opts: W6AppendOpts) => Promise<AppendResult>;

export interface IngestDeps {
  hiveRoot: string;
  append: W6AppendFn;
  read: ReadLedgerFn;
  log: (row: Record<string, unknown>) => void;
}

export interface IngestReport {
  agent: string;
  offered: number;
  appended: number;
  refused: Refusal[];
  /** Set when nothing was appended, with the reason. */
  readOnly?: string;
  backup?: { written: boolean; files: number; partial: boolean };
}

export const FROZEN_BACKUP_DIR = 'claims-frozen';

const agentDir = (deps: IngestDeps, agent: string): string => join(deps.hiveRoot, 'agents', agent);

/** CL-READERWATCHER: the file that says this agent's S0 import has settled (discovery waits for it). */
export const importSettledFile = (hiveRoot: string, agent: string): string => join(hiveRoot, 'agents', agent, 'memory', CLAIMS_IMPORT_SETTLED_FILE);
export const importSettled = (hiveRoot: string, agent: string): boolean => existsSync(importSettledFile(hiveRoot, agent));

function refuse(deps: IngestDeps, agent: string, report: IngestReport, refusal: Refusal, via: string): void {
  report.refused.push(refusal);
  deps.log({ kind: 'claims-import-refused', agent, via, ...refusal });
}

async function appendAll(deps: IngestDeps, agent: string, drafts: RecordDraft[], report: IngestReport, via: string, r5: boolean): Promise<void> {
  report.offered += drafts.length;
  // One at a time, in order: the parts of a split entry go in back to back.
  for (const d of drafts) {
    const r = await deps.append(agent, d, 'w6-internal', { r5 });
    if (r.ok) { report.appended++; continue; }
    const c = d as Extract<RecordDraft, { t: 'claim' }>;
    refuse(deps, agent, report, { file: c.legacy?.file ?? '', line: c.legacy?.line ?? 0, chars: c.text.length, error: r.error }, via);
  }
}

/**
 * S0: freeze the agent's memory files (G6.5, once; never over anything), then append every legacy
 * entry the ledger does not hold yet (G6.2: a re-run appends nothing), with no R5.
 */
export async function shadowImport(deps: IngestDeps, agent: string, opts: { settle?: boolean } = {}): Promise<IngestReport> {
  const dir = agentDir(deps, agent);
  const report: IngestReport = { agent, offered: 0, appended: 0, refused: [] };
  const b = frozenBackup(dir, join(deps.hiveRoot, 'backups', FROZEN_BACKUP_DIR, agent));
  report.backup = { written: b.written, files: b.files.length, partial: b.partial === true };
  const led = deps.read(agent);
  if (b.partial) {
    report.readOnly = 'backup-partial: the frozen backup folder exists without its manifest; nothing overwritten, nothing imported';
  } else if (led.chain !== 'ok') {
    report.readOnly = `${led.chain.reason} at ${led.chain.brokenAt}`;
  } else {
    const plan = newLegacyImport(dir, led.records);
    for (const r of plan.refusals) refuse(deps, agent, report, r, 'import');
    await appendAll(deps, agent, plan.drafts, report, 'import', false);
  }
  // CL-READERWATCHER: settled = the agent has a ledger to search AND its legacy entries are in it
  // (or reported refused); an established ledger keeps its swap even when this run found it
  // read-only. Written last, so discovery swaps memory.md out only after the import, never in the
  // middle. opts.settle false (a shadow agent: its memory.md stays searched) writes no marker, so a
  // later raise imports again first. NIT-1 (Jim): nothing to import (no entries, none refused, not
  // read-only) also settles, so a new hire's empty memory.md is not re-imported every 60 s forever;
  // its watcher takes the bullets it writes later.
  const nothingToImport = !report.readOnly && report.offered === 0 && report.refused.length === 0 && existsSync(dir);
  const settled = led.records.length > 0 || (!report.readOnly && report.appended > 0) || nothingToImport;
  if (opts.settle !== false && settled && !importSettled(deps.hiveRoot, agent)) {
    const file = importSettledFile(deps.hiveRoot, agent);
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, at: new Date().toISOString(), offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null }) + '\n');
    renameSync(`${file}.tmp`, file);
  }
  deps.log({ kind: 'claims-import', agent, offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null, backupWritten: b.written, backupPartial: b.partial === true });
  return report;
}

/**
 * Reader mode (F14, G6.7): the agent still writes memory.md, which has left the search sources, so its
 * new entries reach the ledger here: a scan at spawn, then a scan DEBOUNCE_MS after each change.
 * While the agent may be mid-write, a watch scan ignores a last line with no newline yet; the scan
 * at spawn (`final`) takes everything. A refused entry is logged once per watcher, not on every scan.
 */
export const READER_DEBOUNCE_MS = 2000;
const ARCHIVE_FILE = /^memory-archive-.*\.md$/;

export class ReaderWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<IngestReport> | null = null;
  private again = false;
  private stopped = false;
  private archives = false;
  private readonly reported = new Set<string>();
  private readonly archiveRefused = new Set<string>();

  constructor(private readonly deps: IngestDeps, readonly agent: string, private readonly debounceMs = READER_DEBOUNCE_MS) {}

  /** Scan once (the spawn scan), then watch the agent folder for memory.md changes. */
  start(): Promise<IngestReport> {
    const first = this.scan(true);
    try {
      this.fsw = watch(agentDir(this.deps, this.agent), (_ev, name) => {
        const n = name ? String(name).toLowerCase() : '';
        if (n === 'memory.md') this.schedule();
        // CL-READERWATCHER known limit 1: a rollover can move a bullet into an archive before the
        // memory.md scan sees it; the next scan then also imports the archives (as the S0 import).
        else if (ARCHIVE_FILE.test(n)) { this.archives = true; this.schedule(); }
      });
      this.fsw.on('error', (e) => this.deps.log({ kind: 'claims-watch-error', agent: this.agent, error: String(e) }));
    } catch (e) {
      this.deps.log({ kind: 'claims-watch-error', agent: this.agent, error: String(e) });
    }
    return first;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fsw?.close();
    this.fsw = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.background(); }, this.debounceMs);
  }

  /** CL-READERWATCHER: a scan nobody awaits (a change, or one more after a scan) is logged on
   *  failure, never an unhandled rejection in main; none starts after stop(). */
  private background(): void {
    if (this.stopped) return;
    this.scan(false).catch((e) => this.deps.log({ kind: 'claims-watch-error', agent: this.agent, error: String(e).slice(0, 160) }));
  }

  /** One scan at a time; a change during a scan runs one more scan after it. */
  scan(final: boolean): Promise<IngestReport> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.scanOnce(final).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.background(); }
    });
    return this.running;
  }

  private async scanOnce(final: boolean): Promise<IngestReport> {
    const report: IngestReport = { agent: this.agent, offered: 0, appended: 0, refused: [] };
    const file = join(agentDir(this.deps, this.agent), 'memory.md');
    if (!existsSync(file)) return report;
    let text = readFileSync(file, 'utf8');
    if (!final && !/\n$/.test(text)) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const led = this.deps.read(this.agent);
    const via = final ? 'spawn-scan' : 'watch';
    if (led.chain !== 'ok') {
      report.readOnly = `${led.chain.reason} at ${led.chain.brokenAt}`;
    } else {
      const plan = parseNewBulletsDetailed(text, knownIdsFor(led.records));
      for (const r of plan.refusals) {
        const k = `${r.line}\u0000${r.chars}`;
        if (this.reported.has(k)) { report.refused.push(r); continue; }
        this.reported.add(k);
        refuse(this.deps, this.agent, report, r, via);
      }
      await appendAll(this.deps, this.agent, plan.drafts, report, via, true);
      if (this.archives) {
        this.archives = false;
        // Every archive entry the ledger lacks (counted by hash, so a bullet already taken from
        // memory.md and then rolled over is not offered again); memory.md is the scan above's.
        const arch = newLegacyImport(agentDir(this.deps, this.agent), this.deps.read(this.agent).records);
        // NIT-2 (Jim): an archive entry refused once is not offered (and logged) again at every
        // archive change, like the memory.md scan's refusals above.
        const keyOf = (d: RecordDraft): string => { const c = d as Extract<RecordDraft, { t: 'claim' }>; return `${c.legacy?.file ?? ''}\u0000${c.legacy?.line ?? 0}\u0000${c.text.length}`; };
        const drafts = arch.drafts.filter((d) => (d as Extract<RecordDraft, { t: 'claim' }>).legacy?.file !== 'memory.md' && !this.archiveRefused.has(keyOf(d)));
        const before = report.refused.length;
        await appendAll(this.deps, this.agent, drafts, report, 'watch-archive', false);
        for (const r of report.refused.slice(before)) this.archiveRefused.add(`${r.file}\u0000${r.line}\u0000${r.chars}`);
      }
    }
    if (report.offered || report.readOnly) {
      this.deps.log({ kind: 'claims-reader-scan', agent: this.agent, final, offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null });
    }
    return report;
  }
}
