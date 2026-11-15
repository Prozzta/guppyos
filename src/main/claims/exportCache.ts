/**
 * STARTUP-FREEZE-104 A5 (Jim audit A5, SCALE-CLAIMS-EXPORT-DELTA): the continuous export in O(new).
 *
 * exportLedger.ts reads every export file (exportedIds), every memory-archive-*.md (archiveBackedIds)
 * and does one open + write + fsync per line (appendExport). At 10x that is about 0.7 s of reads per
 * agent per append, and a catch-up of 20,000 lines blocked main for 88 s. This module gives one
 * ClaimExport a per-agent cache that writes exactly the same bytes:
 *
 * - EXPORTED IDS: read once (asynchronously at the start-up sync), then kept by this module's own
 *   writes. One readdir per call checks the export file names; a changed list (a file deleted, added
 *   or renamed by anyone else) reads them all again. Only the part a line goes into is stat'd, and a
 *   size other than the one written last reads them all again. Old parts are never read or stat'd.
 *   A purge's scrub keeps every [c:<id>] tag (a tombstone line), so the id set stays right.
 * - ARCHIVES: each archive's entry hashes are kept with its size and mtime; a stat per call, a read
 *   only when one of them changed (or the file came back). Still content-checked per ruling 2.
 * - WRITES: the lines of one call are grouped per file (the same split points: a part closes when a
 *   line would take it over EXPORT_SPLIT_BYTES, and a new part starts with the same heading), one
 *   write per file, fsynced once per file.
 */
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaimsState, LedgerRec, RenderExportLineFn } from '../../shared/claims';
import { EXPORT_RE, EXPORT_SPLIT_BYTES, exportHead, exportLine, exportName, statusChanges, statusMarkerLine, type ExportFlush } from './exportLedger';
import { splitEntries } from './migrate';

const TAG_RE = /\[c:([^\]\s]+)\]/g;
const ARCHIVE_RE = /^memory-archive-.*\.md$/i;
/** Lines of an export file parsed per slice in the asynchronous fill. */
const FILL_LINES = 4096;
/** Records rendered per slice in the asynchronous sync. */
const RENDER_STEP = 256;

export interface ExportCache {
  /** The export file names this cache holds, in exportFiles' order; null: not filled. */
  names: string[] | null;
  ids: Set<string>;
  /** Each export file's size as read or as this module last wrote it. */
  sizes: Map<string, number>;
  archives: Map<string, { size: number; mtimeMs: number; shas: Set<string> | null }>;
}

export const newExportCache = (): ExportCache => ({ names: null, ids: new Set(), sizes: new Map(), archives: new Map() });

/** exportFiles' order: month, then part. */
export function sortExportNames(names: string[]): string[] {
  return names.filter((n) => EXPORT_RE.test(n)).sort((a, b) => {
    const ma = EXPORT_RE.exec(a)!, mb = EXPORT_RE.exec(b)!;
    return ma[1] === mb[1] ? Number(ma[2] ?? 1) - Number(mb[2] ?? 1) : ma[1] < mb[1] ? -1 : 1;
  });
}

const sameList = (a: string[] | null, b: string[]): boolean => !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/** exportedIds' rule for one file's text. */
function addIds(lines: string[], from: number, to: number, ids: Set<string>): void {
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (line.includes(' status of [c:')) continue;   // a marker names a claim, it does not export it
    for (const m of line.matchAll(TAG_RE)) ids.add(m[1]);
  }
}

function listExports(agentDir: string): string[] {
  try { return sortExportNames(readdirSync(agentDir)); } catch { return []; }
}

/** Fill the cache from the export files (synchronous: a cache that was never filled, or a changed list). */
function fillSync(agentDir: string, c: ExportCache, names: string[]): void {
  c.ids = new Set(); c.sizes = new Map(); c.names = null;
  for (const f of names) {
    const buf = readFileSync(join(agentDir, f));
    c.sizes.set(f, buf.length);
    const lines = buf.toString('utf8').split('\n');
    addIds(lines, 0, lines.length, c.ids);
  }
  c.names = names;
}

/** The same fill with fs/promises and the text parsed in slices. */
async function fillAsync(agentDir: string, c: ExportCache, names: string[], tick: () => Promise<void>): Promise<void> {
  c.ids = new Set(); c.sizes = new Map(); c.names = null;
  for (const f of names) {
    const buf = await fsp.readFile(join(agentDir, f));
    c.sizes.set(f, buf.length);
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i += FILL_LINES) { addIds(lines, i, Math.min(lines.length, i + FILL_LINES), c.ids); await tick(); }
  }
  c.names = names;
}

/** The exported ids, from the cache when the export file list is the one it holds. */
export function cachedExportedIds(agentDir: string, c: ExportCache): Set<string> {
  const names = listExports(agentDir);
  if (!sameList(c.names, names)) fillSync(agentDir, c, names);
  return c.ids;
}

type Stat = { size: number; mtimeMs: number };
/** archiveBackedIds' rule, each archive's hashes kept while its size and mtime are the ones read. */
function backed(records: LedgerRec[], state: ClaimsState, shasOf: (file: string) => Set<string> | null): Set<string> {
  if (!state || typeof state !== 'object' || !state.claims) throw new Error('archiveBackedIds: the derived state is required');
  const out = new Set<string>();
  for (const r of records) {
    if (r.t !== 'claim' || r.kind === 'lesson' || !r.legacy || !ARCHIVE_RE.test(r.legacy.file) || /[\\/]/.test(r.legacy.file)) continue;
    const st = state.claims[r.id]?.status ?? 'live';
    if (st !== 'live' && st !== 'superseded?') continue;
    if (shasOf(r.legacy.file)?.has(r.legacy.sha256)) out.add(r.id);
  }
  return out;
}

/** The archive files these records name (the ones backed() may ask about). */
function namedArchives(records: LedgerRec[]): string[] {
  const out = new Set<string>();
  for (const r of records) if (r.t === 'claim' && r.kind !== 'lesson' && r.legacy && ARCHIVE_RE.test(r.legacy.file) && !/[\\/]/.test(r.legacy.file)) out.add(r.legacy.file);
  return [...out];
}

const keep = (c: ExportCache, file: string, st: Stat | null, text: (() => string) | null): Set<string> | null => {
  if (!st) { c.archives.delete(file); return null; }
  const hit = c.archives.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.shas;
  let shas: Set<string> | null = null;
  try { shas = new Set(splitEntries((text as () => string)(), file).entries.map((e) => e.sha256)); } catch { shas = null; }
  c.archives.set(file, { size: st.size, mtimeMs: st.mtimeMs, shas });
  return shas;
};

export function cachedArchiveBackedIds(agentDir: string, records: LedgerRec[], state: ClaimsState, c: ExportCache): Set<string> {
  const memo = new Map<string, Set<string> | null>();
  return backed(records, state, (file) => {
    if (!memo.has(file)) {
      const p = join(agentDir, file);
      let st: Stat | null = null;
      try { const s = statSync(p); st = { size: s.size, mtimeMs: s.mtimeMs }; } catch { st = null; }
      memo.set(file, keep(c, file, st, () => readFileSync(p, 'utf8')));
    }
    return memo.get(file) ?? null;
  });
}

/** Read (asynchronously) every archive these records name whose size or mtime is not the cached one. */
async function refreshArchives(agentDir: string, records: LedgerRec[], c: ExportCache, tick: () => Promise<void>): Promise<void> {
  for (const file of namedArchives(records)) {
    const p = join(agentDir, file);
    let st: Stat | null = null;
    try { const s = await fsp.stat(p); st = { size: s.size, mtimeMs: s.mtimeMs }; } catch { st = null; }
    const hit = c.archives.get(file);
    if (st && !(hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs)) {
      let text: string | null = null;
      try { text = await fsp.readFile(p, 'utf8'); } catch { text = null; }
      if (text === null) c.archives.delete(file); else keep(c, file, st, () => text as string);
      await tick();
    } else if (!st) c.archives.delete(file);
  }
}

/**
 * Where each piece of text goes, grouped per file in first-write order: appendText's rule applied in
 * order (the month's last part while the text fits, else the next part with the heading). The part a
 * month continues is stat'd; a size the cache did not write is a changed file: refill and plan again.
 */
type Item = { id?: string; month: string; text: string };

function plan(agentDir: string, agent: string, items: Item[], c: ExportCache): Array<[string, string]> | null {
  const out = new Map<string, string>();
  const cur = new Map<string, { name: string; size: number; part: number } | null>();
  const names = c.names ?? [];
  for (const { month, text } of items) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > EXPORT_SPLIT_BYTES) throw new Error(`export: one line of ${bytes} bytes is over the split size`);
    if (!cur.has(month)) {
      const parts = names.filter((n) => EXPORT_RE.exec(n)![1] === month);
      if (!parts.length) cur.set(month, null);
      else {
        const last = parts[parts.length - 1];
        let size = -1;
        try { size = statSync(join(agentDir, last)).size; } catch { size = -1; }
        if (size !== c.sizes.get(last)) return null;
        cur.set(month, { name: last, size, part: Number(EXPORT_RE.exec(last)![2] ?? 1) });
      }
    }
    const at = cur.get(month) ?? null;
    let name: string; let add: string;
    if (at && at.size + bytes <= EXPORT_SPLIT_BYTES) { name = at.name; add = text; at.size += bytes; }
    else {
      const part = at ? at.part + 1 : 1;
      name = exportName(month, part);
      add = exportHead(agent, month) + text;
      cur.set(month, { name, size: Buffer.byteLength(add, 'utf8'), part });
    }
    out.set(name, (out.get(name) ?? '') + add);
  }
  return [...out];
}

/** Record a plan's writes in the cache (names, sizes). */
function noteWrites(c: ExportCache, writes: Array<[string, string]>): void {
  const names = new Set(c.names ?? []);
  for (const [name, text] of writes) { names.add(name); c.sizes.set(name, (c.sizes.get(name) ?? 0) + Buffer.byteLength(text, 'utf8')); }
  c.names = sortExportNames([...names]);
}

/** The writes for `items`. A changed export file is read again first, and then the lines whose claim it
 *  now holds (exported by someone else) are dropped, as syncExport would never have rendered them. */
function planOrRefill(agentDir: string, agent: string, items: Item[], c: ExportCache): { writes: Array<[string, string]>; items: Item[] } {
  let p = plan(agentDir, agent, items, c);
  if (!p) {
    fillSync(agentDir, c, listExports(agentDir));
    items = items.filter((x) => !x.id || !c.ids.has(x.id));
    p = plan(agentDir, agent, items, c);
  }
  if (!p) throw new Error('export: an export file changed while it was planned');
  return { writes: p, items };
}

function writeSyncAll(agentDir: string, writes: Array<[string, string]>, flush?: ExportFlush): void {
  for (const [name, text] of writes) {
    const file = join(agentDir, name);
    const fd = openSync(file, 'a');
    try { writeSync(fd, text); if (!flush) fsyncSync(fd); } finally { closeSync(fd); }
    flush?.add(file);
  }
}

/** Plan, write and note the export lines `items` (each with its claim id); the number written. */
function writePlanned(agentDir: string, agent: string, items: Item[], c: ExportCache, flush?: ExportFlush): number {
  const p = planOrRefill(agentDir, agent, items, c);
  if (!p.items.length) return 0;
  writeSyncAll(agentDir, p.writes, flush);
  noteWrites(c, p.writes);
  for (const x of p.items) if (x.id) c.ids.add(x.id);
  return p.items.length;
}

/** syncExport with the cache: the same lines, in the same files, one write per file. */
export function cachedSyncExport(agentDir: string, records: LedgerRec[], state: ClaimsState, render: RenderExportLineFn, c: ExportCache, flush?: ExportFlush): number {
  const have = cachedExportedIds(agentDir, c);
  const exclude = cachedArchiveBackedIds(agentDir, records, state, c);
  const items: Item[] = [];
  for (const r of records) if (!have.has(r.id) && !exclude.has(r.id)) items.push({ id: r.id, month: r.wt.slice(0, 7), text: exportLine(r, state, render) });
  if (!items.length) return 0;
  return writePlanned(agentDir, records[0].agent, items, c, flush);
}

/** appendStatusMarkers with the cache. */
export function cachedStatusMarkers(agentDir: string, agent: string, prev: ClaimsState | null, next: ClaimsState, at: string, c: ExportCache, flush?: ExportFlush): number {
  const ch = statusChanges(prev, next);
  if (!ch.length) return 0;
  cachedExportedIds(agentDir, c);
  const { writes } = planOrRefill(agentDir, agent, [{ month: at.slice(0, 7), text: ch.map((x) => statusMarkerLine(x.id, x.from, x.to, at)).join('') }], c);
  writeSyncAll(agentDir, writes, flush);
  noteWrites(c, writes);
  return ch.length;
}

/**
 * The start-up catch-up off the event loop: fs/promises reads, parsing and rendering in slices
 * (`tick` pauses when the slice's budget is spent). Then, in ONE turn, `same()` must still hold (the
 * ledger read these lines were rendered from is still the current one: a purge's scrub between two
 * slices must never be followed by its old text) and the lines are written, one write per file; the
 * files go into `flush` for one fsync each off the loop. Returns null when `same()` failed (nothing
 * written; the next append's catch-up exports them).
 */
export async function cachedSyncExportAsync(agentDir: string, records: LedgerRec[], state: ClaimsState, render: RenderExportLineFn, c: ExportCache, tick: () => Promise<void>, same: () => boolean, flush: ExportFlush): Promise<number | null> {
  let names: string[] = [];
  try { names = sortExportNames(await fsp.readdir(agentDir)); } catch { names = []; }
  if (!sameList(c.names, names)) await fillAsync(agentDir, c, names, tick);
  await refreshArchives(agentDir, records, c, tick);
  const exclude = cachedArchiveBackedIds(agentDir, records, state, c);
  await tick();
  const items: Item[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!c.ids.has(r.id) && !exclude.has(r.id)) items.push({ id: r.id, month: r.wt.slice(0, 7), text: exportLine(r, state, render) });
    if (i % RENDER_STEP === RENDER_STEP - 1) await tick();
  }
  if (!items.length) return 0;
  if (!same()) return null;
  return writePlanned(agentDir, records[0].agent, items, c, flush);
}
