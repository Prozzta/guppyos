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
import { readFile, readdir, stat } from 'node:fs/promises';
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

/** An archive file's name (YYYY-MM.jsonl); the files are read in name order. */
export const isArchiveFile = (name: string): boolean => /^\d{4}-\d{2}\.jsonl$/.test(name);

function archiveFiles(root: string): string[] {
  const dir = join(root, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isArchiveFile).sort().map((f) => join(dir, f));
}

/** LAG-SYNC-IO-107: counts this process's archive appends. An asynchronous read that an append
 *  overtook (the count moved while it was reading) is thrown away, so a write is the last word. */
let writeGen = 0;
export const archiveWriteGen = (): number => writeGen;

/** Where an append landed: the file and the size it had before. */
export type ArchiveMark = { file: string; from: number };

/** Append lines to this month's archive file with one open, one fsync, one close. Returns where
 *  the append landed, or null when there was nothing to write. */
function appendLines(root: string, lines: readonly unknown[], now: number): ArchiveMark | null {
  if (lines.length === 0) return null;
  const dir = join(root, ARCHIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, monthFile(now));
  const fd = openSync(file, 'a+');
  writeGen++;
  try {
    // A torn tail (a crash, AV or a full disk mid-append) has no newline: end it first, or the
    // first new line would be glued onto it and read back as one unparsable line (Jim MUST).
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeSync(fd, (torn ? '\n' : '') + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fsyncSync(fd);
    return { file, from: size };
  } finally { closeSync(fd); writeGen++; }
}

export function appendArchived(root: string, cards: readonly unknown[], now: number): ArchiveMark | null {
  const at = new Date(now).toISOString();
  return appendLines(root, cards.map((card) => ({ v: 1, at, card })), now);
}

/**
 * LAG-SYNC-IO-107: which of `cards` (just appended by `appendArchived`, which returned `mark`)
 * read back from the archive exactly as they were. The answer is `readArchive`'s, card for card.
 * When the append is the end of the last archive file and every card reads back whole from the
 * appended bytes alone, those bytes decide it (a few KB): the latest line for an id wins, and
 * they are the latest lines. In every other case (a torn or partial append, an archive file with
 * a later name, any error) the whole archive is read as before. That full read is megabytes and
 * ran synchronously on Electron main at every archive pass.
 * `full` is the whole archive when it had to be read, else null.
 */
export function landedCards(root: string, mark: ArchiveMark | null, cards: readonly unknown[]): { landed: Set<string>; full: Map<string, Card> | null } {
  const same = (back: Map<string, Card>, c: unknown): boolean => { const id = idOf(c); return !!id && JSON.stringify(back.get(id)) === JSON.stringify(c); };
  if (mark && cards.length > 0) {
    try {
      const files = archiveFiles(root);
      if (files[files.length - 1] === mark.file) {
        const fd = openSync(mark.file, 'r');
        let text = '';
        try {
          const buf = Buffer.alloc(Math.max(0, fstatSync(fd).size - mark.from));
          let got = 0;
          while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, mark.from + got); if (n <= 0) break; got += n; }
          if (got === buf.length) text = buf.toString('utf8');
        } finally { closeSync(fd); }
        const tail = parseArchive([text]);
        if (cards.every((c) => same(tail, c))) return { landed: new Set(cards.map((c) => idOf(c) as string)), full: null };
      }
    } catch { /* decided by the full read below */ }
  }
  const back = readArchive(root);
  return { landed: new Set(cards.filter((c) => same(back, c)).map((c) => idOf(c) as string)), full: back };
}

export function appendRevived(root: string, id: string, now: number): void {
  void appendLines(root, [{ v: 1, at: new Date(now).toISOString(), revived: id }], now);
}

/**
 * The archived cards, in first-archived order, latest line per id, tombstones applied.
 * An unparsable line (a torn tail after a crash) is skipped, never fatal.
 */
export function readArchive(root: string): Map<string, Card> {
  const texts: string[] = [];
  for (const file of archiveFiles(root)) {
    try { texts.push(readFileSync(file, 'utf8')); } catch { continue; }
  }
  return parseArchive(texts);
}

/** `readArchive` over the archive files' texts, in file-name order. */
export function parseArchive(texts: Iterable<string>): Map<string, Card> {
  const out = new Map<string, Card>();
  for (const text of texts) {
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

/** What `readArchiveTextsAsync` read: each file with its text (null = unreadable, skipped by
 *  `readArchive`), in name order, and the `archiveStamp` of the same moment. */
export type ArchiveTexts = { files: { file: string; text: string | null }[]; texts: string[]; stamp: string };

/**
 * LAG-SYNC-IO-107: the archive files' texts and their `archiveStamp`, read off the main thread.
 * The archive is megabytes (2026-10.jsonl alone 2.65 MB) and `readArchive` read it synchronously
 * on Electron main at every derived cards pass, every archive pass and every cache refresh; live
 * stall rows showed readFileSync:2026-10.jsonl twice a minute.
 *
 * A file's text is kept while its size and mtime are unchanged (archive files are append-only and
 * a finished month never changes), so a repeat read costs one stat per file. Concurrent callers
 * share one flight. An append by this process during the read (`archiveWriteGen` moved) restarts
 * it; after three overtaken reads, or when the folder cannot be listed for any reason but its
 * absence, the answer is null: the caller then uses the synchronous reader, as before.
 */
export function readArchiveTextsAsync(root: string): Promise<ArchiveTexts | null> {
  const running = textFlights.get(root);
  if (running) return running;
  const flight: Promise<ArchiveTexts | null> = readArchiveTexts(root).finally(() => { if (textFlights.get(root) === flight) textFlights.delete(root); });
  textFlights.set(root, flight);
  return flight;
}

const textFlights = new Map<string, Promise<ArchiveTexts | null>>();
/** One root's file texts (the hive root; another root replaces it). */
let textCache: { root: string; files: Map<string, { key: string; text: string }> } | null = null;

async function readArchiveTexts(root: string): Promise<ArchiveTexts | null> {
  const dir = join(root, ARCHIVE_DIR);
  for (let attempt = 0; attempt < 3; attempt++) {
    const gen = writeGen;
    let names: string[];
    try { names = (await readdir(dir)).filter(isArchiveFile).sort(); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
      names = [];
    }
    const kept = textCache?.root === root ? textCache.files : new Map<string, { key: string; text: string }>();
    const keep = new Map<string, { key: string; text: string }>();
    const read = await Promise.all(names.map(async (name) => {
      const file = join(dir, name);
      let key = '?';
      try { const s = await stat(file); key = `${s.size}:${s.mtimeMs}`; } catch { /* '?', as archiveStamp */ }
      const had = kept.get(file);
      if (key !== '?' && had?.key === key) { keep.set(file, had); return { file, key, text: had.text as string | null }; }
      let text: string | null = null;
      try { text = await readFile(file, 'utf8'); } catch { text = null; }
      if (text !== null && key !== '?') {
        // Keep the text only if the file did not change while it was read.
        try { const s = await stat(file); if (`${s.size}:${s.mtimeMs}` === key) keep.set(file, { key, text }); } catch { /* not kept */ }
      }
      return { file, key, text };
    }));
    if (gen !== writeGen) continue;
    textCache = { root, files: keep };
    return {
      files: read.map((r) => ({ file: r.file, text: r.text })),
      texts: read.filter((r) => r.text !== null).map((r) => r.text as string),
      stamp: read.map((r) => `${r.file}:${r.key}`).join('|')
    };
  }
  return null;
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
