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
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { AppendResult, ReadLedgerFn, RecordDraft } from '../../shared/claims';
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
export async function shadowImport(deps: IngestDeps, agent: string): Promise<IngestReport> {
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

export class ReaderWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<IngestReport> | null = null;
  private again = false;
  private readonly reported = new Set<string>();

  constructor(private readonly deps: IngestDeps, readonly agent: string, private readonly debounceMs = READER_DEBOUNCE_MS) {}

  /** Scan once (the spawn scan), then watch the agent folder for memory.md changes. */
  start(): Promise<IngestReport> {
    const first = this.scan(true);
    try {
      this.fsw = watch(agentDir(this.deps, this.agent), (_ev, name) => {
        if (name && String(name).toLowerCase() === 'memory.md') this.schedule();
      });
      this.fsw.on('error', (e) => this.deps.log({ kind: 'claims-watch-error', agent: this.agent, error: String(e) }));
    } catch (e) {
      this.deps.log({ kind: 'claims-watch-error', agent: this.agent, error: String(e) });
    }
    return first;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fsw?.close();
    this.fsw = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.scan(false); }, this.debounceMs);
  }

  /** One scan at a time; a change during a scan runs one more scan after it. */
  scan(final: boolean): Promise<IngestReport> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.scanOnce(final).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; void this.scan(false); }
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
    }
    if (report.offered || report.readOnly) {
      this.deps.log({ kind: 'claims-reader-scan', agent: this.agent, final, offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null });
    }
    return report;
  }
}
