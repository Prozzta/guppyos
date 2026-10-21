/**
 * TASKS-JSON-SPLIT: the hot/cold task ledger.
 *
 * `tasks.json` (hot) keeps every live card plus recently-done ones; it is the file every
 * reader, the guard and god's hand edits already use, with the same name and shape. Old
 * done cards move in batches to `tasks-archive/YYYY-MM.jsonl` (cold): append-only, one
 * JSON line per event, fsync'd, never rewritten. Jim MAIL-AV F5: the on-access scanner
 * costs grow with file size on every open and close, and the whole ledger was rewritten
 * on every change while ~90% of it was cards nobody edits again.
 *
 * Archive lines:
 *   { v: 1, at, card }      the card as it left hot (the latest line for an id wins)
 *   { v: 1, at, revived }   a tombstone: the card went back to hot (ledger patch / tasks-revive)
 *
 * Crash order: an archive pass appends first, then rewrites hot; a revive rewrites hot first,
 * then appends the tombstone. A card in both files is therefore never lost, and the hot copy
 * always wins (`mergeHotCold`).
 */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const ARCHIVE_DIR = 'tasks-archive';
/** Longer than board-status's 24 h done window and the Slack/webhook done-pollers' need. */
export const ARCHIVE_KEEP_MS = 48 * 60 * 60_000;
export const ARCHIVE_PASS_MS = 60 * 60_000;

type Card = Record<string, unknown> & { id?: unknown };

const idOf = (c: unknown): string | null =>
  c && typeof c === 'object' && typeof (c as Card).id === 'string' && (c as Card).id ? (c as Card).id as string : null;

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== false && v !== '' && !(Array.isArray(v) && v.length === 0);

export function hasOpenAsk(card: Card): boolean {
  const qa = card.humanQA;
  return Array.isArray(qa) && qa.some((q) => !!q && typeof q === 'object'
    && typeof (q as Record<string, unknown>).q === 'string'
    && !(q as Record<string, unknown>).a && !(q as Record<string, unknown>).dismissedAt);
}

/** When the card became done: its own doneAt, else the guard's statusSince while done. Not
 *  hive.ts cardDoneAt: that one wants a LOWER bound (closing asks) and falls back to the
 *  earliest result stamp; archiving wants the opposite, and statusSince (exact or bounded)
 *  is never earlier than the real done, so a card can only move late, never early.
 *  A revive (revivedAt) restarts the clock: a revived card stays hot for the keep window. */
export function doneTime(card: Card, meta?: { status?: string; statusSince?: number }): number | null {
  const d = typeof card.doneAt === 'string' ? Date.parse(card.doneAt) : NaN;
  let at: number | null = Number.isFinite(d) ? d : null;
  if (at === null && meta && meta.status === 'done' && typeof meta.statusSince === 'number' && Number.isFinite(meta.statusSince)) at = meta.statusSince;
  if (at === null) return null;
  const r = typeof card.revivedAt === 'string' ? Date.parse(card.revivedAt) : NaN;
  return Number.isFinite(r) && r > at ? r : at;
}

/**
 * The ids an archive pass may move. Only status exactly 'done', done for at least `keepMs`,
 * with no open ask, no waitingFor/parked (god 4eb6eb: never a doing/blocked/parked card, even
 * with done-like fields), and a unique id (a duplicate is god's to fix, not ours to split).
 */
export function planArchive(
  tasks: readonly unknown[],
  meta: Record<string, { status?: string; statusSince?: number } | undefined>,
  now: number,
  keepMs: number = ARCHIVE_KEEP_MS
): string[] {
  const count = new Map<string, number>();
  for (const c of tasks) { const id = idOf(c); if (id) count.set(id, (count.get(id) ?? 0) + 1); }
  const out: string[] = [];
  for (const c of tasks) {
    const id = idOf(c);
    if (!id || count.get(id) !== 1) continue;
    const card = c as Card;
    if (card.status !== 'done') continue;
    if (isSet(card.waitingFor) || isSet(card.parked)) continue;
    if (hasOpenAsk(card)) continue;
    const at = doneTime(card, meta[id]);
    if (at === null || now - at < keepMs) continue;
    out.push(id);
  }
  return out;
}

function monthFile(now: number): string {
  return `${new Date(now).toISOString().slice(0, 7)}.jsonl`;
}

function archiveFiles(root: string): string[] {
  const dir = join(root, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().map((f) => join(dir, f));
}

/** Append lines to this month's archive file with one open, one fsync, one close. */
function appendLines(root: string, lines: readonly unknown[], now: number): void {
  if (lines.length === 0) return;
  const dir = join(root, ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, monthFile(now)), 'a+');
  try {
    // A torn tail (a crash, AV or a full disk mid-append) has no newline: end it first, or the
    // first new line would be glued onto it and read back as one unparsable line (Jim MUST).
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, (torn ? '\n' : '') + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function appendArchived(root: string, cards: readonly unknown[], now: number): void {
  const at = new Date(now).toISOString();
  appendLines(root, cards.map((card) => ({ v: 1, at, card })), now);
}

export function appendRevived(root: string, id: string, now: number): void {
  appendLines(root, [{ v: 1, at: new Date(now).toISOString(), revived: id }], now);
}

/**
 * The archived cards, in first-archived order, latest line per id, tombstones applied.
 * An unparsable line (a torn tail after a crash) is skipped, never fatal.
 */
export function readArchive(root: string): Map<string, Card> {
  const out = new Map<string, Card>();
  for (const file of archiveFiles(root)) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const r = row as { card?: unknown; revived?: unknown };
      if (typeof r.revived === 'string') { out.delete(r.revived); continue; }
      const id = idOf(r.card);
      if (id) out.set(id, r.card as Card);
    }
  }
  return out;
}

/** A cheap fingerprint of the archive (names, sizes, mtimes) for the reader cache. */
export function archiveStamp(root: string): string {
  return archiveFiles(root).map((f) => {
    try { const s = statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:?`; }
  }).join('|');
}

/** Hot first, then archived cards hot lacks: under the first-occurrence rule hot always wins. */
export function mergeHotCold(hot: readonly unknown[], archived: Map<string, Card>): unknown[] {
  const inHot = new Set<string>();
  for (const c of hot) { const id = idOf(c); if (id) inHot.add(id); }
  const out: unknown[] = hot.slice();
  for (const [id, card] of archived) if (!inHot.has(id)) out.push(card);
  return out;
}

/** tasks-unsplit: archived cards in archive order, then hot; a card in both keeps the hot copy. */
export function unsplitList(hot: readonly unknown[], archived: Map<string, Card>): unknown[] {
  const inHot = new Set<string>();
  for (const c of hot) { const id = idOf(c); if (id) inHot.add(id); }
  const out: unknown[] = [];
  for (const [id, card] of archived) if (!inHot.has(id)) out.push(card);
  return out.concat(hot);
}
