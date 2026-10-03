/**
 * CLAIM-LEDGER W6: the rollback exports (plan §3 W6 "Exports", spec amendment A7; gates G6.3, G6.4, G6.8).
 *
 * 1. CONTINUOUS EXPORT (writer mode; the UNPLANNED-downgrade path). Every ledger record is also
 *    appended, as one rendered line, to `memory-ledger-export-<YYYY-MM>.md` in the agent's folder:
 *    - append-only, one line per record; a status change appends a marker line (never an edit);
 *    - a file is closed at EXPORT_SPLIT_BYTES (1.5 MiB) and the month continues in
 *      `memory-ledger-export-<YYYY-MM>-2.md`, -3, …, so no file reaches the 2 MiB
 *      MAX_SOURCE_BYTES an older build would skip as too big (F5, G6.8);
 *    - every line carries `[c:<id>]`, so `syncExport` can catch up after a crash between the ledger
 *      append and the export append, and the fallback parser never re-imports a line.
 *    An older build indexes these files as ordinary deliverables, so every claim stays searchable
 *    with no export step. The new build excludes them from its sources (W3, G3.4).
 *
 * 2. COMPLETE EXPORT (`memory export --complete`, the PLANNED path). memory.md is replaced (temp file
 *    + rename) by W4's 'complete' rendering: the header, `## How I work` from the pinned lessons, then
 *    every claim in time order with statuses marked. It carries NO generated marker, so a build
 *    without the ledger treats it as an ordinary memory.md and rolls it over (32 KB) in its normal way.
 *    The caller turns the flag down only after this returns ok. A7.1: the old build will index both
 *    this file and the continuous exports, so some hits show twice there; harmless.
 *
 * W4 owns the renderers (RenderExportLineFn, RenderMemoryMdFn); they are injected. The stand-ins below
 * keep W6 testable until W4 lands, and are replaced by W4's functions in main's wiring.
 */
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimsState, LedgerRec, RenderExportLineFn, RenderMemoryMdFn, Status, WorldView } from '../../shared/claims';
import { GENERATED_MEMORY_PREFIX, isGeneratedMemory } from './generated';
import { RENDERED_RE } from './migrate';

export const EXPORT_SPLIT_BYTES = 1.5 * 1024 * 1024;
/** The older build's per-source cap (sources.ts MAX_SOURCE_BYTES): no export file may reach it. */
export const OLD_BUILD_MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const EXPORT_RE = /^memory-ledger-export-(\d{4}-\d{2})(?:-(\d+))?\.md$/;
const TAG_RE = /\[c:([^\]\s]+)\]/g;

const exportName = (month: string, part: number): string => `memory-ledger-export-${month}${part > 1 ? `-${part}` : ''}.md`;

/** The export files of an agent folder, oldest first (month, then part). */
export function exportFiles(agentDir: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(agentDir); } catch { return []; }
  return names.filter((n) => EXPORT_RE.test(n)).sort((a, b) => {
    const ma = EXPORT_RE.exec(a)!, mb = EXPORT_RE.exec(b)!;
    return ma[1] === mb[1] ? Number(ma[2] ?? 1) - Number(mb[2] ?? 1) : ma[1] < mb[1] ? -1 : 1;
  });
}

/** The file a line of `adding` bytes for `month` goes into: the month's last part, or a new part if it would pass the split. */
export function exportFileFor(agentDir: string, month: string, adding: number): { name: string; fresh: boolean } {
  const parts = exportFiles(agentDir).filter((n) => EXPORT_RE.exec(n)![1] === month);
  if (!parts.length) return { name: exportName(month, 1), fresh: true };
  const last = parts[parts.length - 1];
  const size = statSync(join(agentDir, last)).size;
  if (size + adding <= EXPORT_SPLIT_BYTES) return { name: last, fresh: false };
  return { name: exportName(month, Number(EXPORT_RE.exec(last)![2] ?? 1) + 1), fresh: true };
}

function appendDurable(file: string, text: string): void {
  const fd = openSync(file, 'a');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/** One record's export text: W4's line, guaranteed to carry its [c:<id>] tag and to end with a newline. */
export function exportLine(rec: LedgerRec, state: ClaimsState, render: RenderExportLineFn): string {
  let line = render(rec, state).replace(/\r?\n$/, '');
  if (!line.includes(`[c:${rec.id}]`)) line += ` [c:${rec.id}]`;
  return line + '\n';
}

/** A status-change marker line (appended, never an edit). */
export function statusMarkerLine(id: string, from: Status | null, to: Status, at: string): string {
  return `- ${at} status of [c:${id}]: ${from ?? 'new'} -> ${to}\n`;
}

function appendText(agentDir: string, agent: string, month: string, text: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > EXPORT_SPLIT_BYTES) throw new Error(`export: one line of ${bytes} bytes is over the split size`);
  const { name, fresh } = exportFileFor(agentDir, month, bytes);
  const head = fresh ? `# Memory ledger export - ${agent} - ${month}\n\n_A continuous, append-only export of this agent's claims ledger, for older app versions. Generated; do not edit._\n\n` : '';
  appendDurable(join(agentDir, name), head + text);
  return name;
}

/** Append one record to the continuous export (writer mode, after the ledger append succeeded). */
export function appendExport(agentDir: string, rec: LedgerRec, state: ClaimsState, render: RenderExportLineFn): string {
  return appendText(agentDir, rec.agent, rec.wt.slice(0, 7), exportLine(rec, state, render));
}

/** The status changes between two derived states (a claim new in `next` counts only if not live). */
export function statusChanges(prev: ClaimsState | null, next: ClaimsState): Array<{ id: string; from: Status | null; to: Status }> {
  const out: Array<{ id: string; from: Status | null; to: Status }> = [];
  for (const id of Object.keys(next.claims).sort()) {
    const from = prev?.claims[id]?.status ?? null;
    const to = next.claims[id].status;
    if (from === to || (from === null && to === 'live')) continue;
    out.push({ id, from, to });
  }
  return out;
}

/** Append marker lines for every status change (month of `at`). */
export function appendStatusMarkers(agentDir: string, agent: string, prev: ClaimsState | null, next: ClaimsState, at: string): number {
  const ch = statusChanges(prev, next);
  if (ch.length) appendText(agentDir, agent, at.slice(0, 7), ch.map((c) => statusMarkerLine(c.id, c.from, c.to, at)).join(''));
  return ch.length;
}

/** The record ids already in the continuous export (every [c:<id>] tag on a record line). */
export function exportedIds(agentDir: string): Set<string> {
  const ids = new Set<string>();
  for (const f of exportFiles(agentDir)) {
    for (const line of readFileSync(join(agentDir, f), 'utf8').split('\n')) {
      if (line.includes(' status of [c:')) continue;   // a marker names a claim, it does not export it
      for (const m of line.matchAll(TAG_RE)) ids.add(m[1]);
    }
  }
  return ids;
}

/** Catch up the continuous export after a crash or at the switch to writer mode: append every record not yet in it, in order. */
export function syncExport(agentDir: string, records: LedgerRec[], state: ClaimsState, render: RenderExportLineFn): number {
  const have = exportedIds(agentDir);
  let n = 0;
  for (const r of records) if (!have.has(r.id)) { appendExport(agentDir, r, state, render); n++; }
  return n;
}

export const COMPLETE_EXPORT_NOTE = 'After a downgrade, the older app indexes both this complete memory.md and the memory-ledger-export files, so some search hits appear twice there. That is harmless.';

/**
 * `memory export --complete` for one agent: replace memory.md with W4's complete rendering (temp file +
 * rename). The text must not start with the generated marker (an older build has to roll it over like
 * any memory.md): a leading marker line is removed. Returns the file written and the A7.1 note.
 */
export function exportComplete(agentDir: string, state: ClaimsState, view: WorldView, render: RenderMemoryMdFn): { file: string; bytes: number; note: string } {
  let text = render(state, view, 'complete');
  if (isGeneratedMemory(text)) text = text.replace(/^﻿?[^\n]*\n?/, '');
  if (text.startsWith(GENERATED_MEMORY_PREFIX)) throw new Error('export --complete: the rendering still starts with the generated marker');
  const file = join(agentDir, 'memory.md');
  const tmp = `${file}.complete-${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(text, 'utf8'), note: COMPLETE_EXPORT_NOTE };
}

// ——— Stand-ins for W4's renderers (replaced in main's wiring once W4 lands) ———

/** Stand-in RenderExportLineFn: one line per record, newlines in claim text indented. */
export const standInExportLine: RenderExportLineFn = (rec, state) => {
  if (rec.t === 'event') return `- ${rec.at} event ${rec.ev} on ${rec.targets.join(', ')} [c:${rec.id}]`;
  const st = state.claims[rec.id]?.status ?? 'live';
  const key = rec.key ? ` (${rec.key})` : '';
  const text = rec.text.replace(/\r?\n/g, '\n  ');
  return `- ${rec.at.slice(0, 10)} ${rec.kind}${key}${st === 'live' ? '' : ` [${st}]`}: ${text} [c:${rec.id}]`;
};

/** Stand-in RenderMemoryMdFn ('complete' only matters to W6): header, How I work, every claim by time. */
export function standInCompleteMemory(records: LedgerRec[], agent: string): RenderMemoryMdFn {
  return (state, _view, mode) => {
    const claims = records.filter((r) => r.t === 'claim') as Array<Extract<LedgerRec, { t: 'claim' }>>;
    const lessons = claims.filter((c) => c.kind === 'lesson' && state.claims[c.id]?.status === 'live');
    const lines = [`# Memory - ${agent}`, '', '## How I work (standing lessons)', ...lessons.map((c) => `${c.text} [c:${c.id}]`), '', '## All claims (complete export)'];
    const sorted = [...claims].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    for (const c of sorted) {
      const st = state.claims[c.id]?.status ?? 'live';
      lines.push(`- ${c.at.slice(0, 10)}${st === 'live' ? '' : ` [${st}]`} ${c.text.replace(/\r?\n/g, '\n  ')} [c:${c.id}]`);
    }
    return mode === 'complete' ? lines.join('\n') + '\n' : `${lines.slice(0, 4).join('\n')}\n`;
  };
}

/** Whether every line of an export or memory text that names a record carries a parsable tag (for checks). */
export function taggedIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = RENDERED_RE.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}
