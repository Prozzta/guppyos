/**
 * CLAIM-LEDGER W6: the S0 import run and the reader-mode watcher (plan §3 W6, gates G6.1, G6.5, G6.7).
 *
 * Both append ONLY through W1's appendRecord with origin 'w6-internal' (claims.ts AppendOrigin): the
 * one origin allowed the legacy provenance field and up to CLAIM_TEXT_MAX_LEGACY. They are injected
 * (IngestDeps), so this file holds no store code and the tests use a fake ledger.
 *
 * No R5 on the import (god c446a1, binding): the W6 import never calls R5CandidatesFn. The caller that
 * wires appendRecord for 'w6-internal' must not run the R5 hook for these appends.
 *
 * Refusals are REPORTED, never dropped silently (god ce0e54): every refused draft is in the report
 * and in one `claims-import-refused` log row each.
 *
 * A broken chain or a missing key (ReadResult.chain !== 'ok') means the ledger is read-only: nothing
 * is appended, and the report says why.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { AppendRecordFn, ReadLedgerFn, RecordDraft } from '../../shared/claims';
import { frozenBackup, knownIdsFor, newLegacyDrafts, parseNewBullets } from './migrate';

export interface IngestDeps {
  hiveRoot: string;
  append: AppendRecordFn;
  read: ReadLedgerFn;
  log: (row: Record<string, unknown>) => void;
}

export interface Refusal { file: string; line: number; chars: number; error: string }
export interface IngestReport {
  agent: string;
  offered: number;
  appended: number;
  refused: Refusal[];
  /** Set when nothing was appended because the ledger is read-only. */
  readOnly?: string;
  backup?: { written: boolean; files: number };
}

export const FROZEN_BACKUP_DIR = 'claims-frozen';

const agentDir = (deps: IngestDeps, agent: string): string => join(deps.hiveRoot, 'agents', agent);

async function appendAll(deps: IngestDeps, agent: string, drafts: RecordDraft[], report: IngestReport, kind: string): Promise<void> {
  report.offered += drafts.length;
  // One at a time, in order: the parts of a split entry go in back to back.
  for (const d of drafts) {
    const r = await deps.append(agent, d, 'w6-internal');
    if (r.ok) { report.appended++; continue; }
    const c = d as Extract<RecordDraft, { t: 'claim' }>;
    const refusal: Refusal = { file: c.legacy?.file ?? '', line: c.legacy?.line ?? 0, chars: c.text.length, error: r.error };
    report.refused.push(refusal);
    deps.log({ kind: 'claims-import-refused', agent, via: kind, ...refusal });
  }
}

/**
 * S0: freeze the agent's memory files (G6.5, once), then append every legacy entry the ledger does
 * not hold yet (G6.2: a re-run appends nothing).
 */
export async function shadowImport(deps: IngestDeps, agent: string): Promise<IngestReport> {
  const dir = agentDir(deps, agent);
  const report: IngestReport = { agent, offered: 0, appended: 0, refused: [] };
  const b = frozenBackup(dir, join(deps.hiveRoot, 'backups', FROZEN_BACKUP_DIR, agent));
  report.backup = { written: b.written, files: b.files.length };
  const led = deps.read(agent);
  if (led.chain !== 'ok') {
    report.readOnly = `${led.chain.reason} at ${led.chain.brokenAt}`;
  } else {
    await appendAll(deps, agent, newLegacyDrafts(dir, led.records), report, 'import');
  }
  deps.log({ kind: 'claims-import', agent, offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null, backupWritten: b.written });
  return report;
}

/**
 * Reader mode (F14, G6.7): the agent still writes memory.md, which has left the search sources, so its
 * new entries reach the ledger here: a scan at spawn, then a scan DEBOUNCE_MS after each change.
 * While the agent may be mid-write, a watch scan ignores a last line with no newline yet; the scan
 * at spawn (`final`) takes everything.
 */
export const READER_DEBOUNCE_MS = 2000;

export class ReaderWatcher {
  private fsw: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<IngestReport> | null = null;
  private again = false;

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
    if (led.chain !== 'ok') {
      report.readOnly = `${led.chain.reason} at ${led.chain.brokenAt}`;
    } else {
      await appendAll(this.deps, this.agent, parseNewBullets(text, knownIdsFor(led.records)), report, final ? 'spawn-scan' : 'watch');
    }
    if (report.offered || report.readOnly) {
      this.deps.log({ kind: 'claims-reader-scan', agent: this.agent, final, offered: report.offered, appended: report.appended, refused: report.refused.length, readOnly: report.readOnly ?? null });
    }
    return report;
  }
}
