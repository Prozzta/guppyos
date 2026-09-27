/**
 * CODEX-BLOAT-165 fix 3: memory.md size cap and rollover.
 *
 * Agents append to their memory.md forever (Dwight's reached 86K chars, ~21.6K tokens) and the
 * old protocol told every agent to read it whole at the start of every task. Above
 * MEMORY_ROLLOVER_BYTES the app moves the OLDER part into `memory-archive-<YYYY-MM-DD>.md`
 * next to it and keeps the header plus the newest ~MEMORY_KEEP_TAIL_BYTES in memory.md.
 *
 * Nothing is lost from search: the memory indexer's allow-list takes every direct
 * `agents/<id>/*.md` (nativeMemory/sources.ts), so the archive is indexed as a deliverable and
 * `memory search` still finds it; `memory wake-up` reads the newest memory.md entries, which
 * are exactly the ones kept.
 *
 * Run at spawn (ensureAgent), when the agent's previous process is gone, so no agent is
 * appending while the file is rewritten. Best-effort: any failure leaves memory.md untouched.
 *
 * PINNED-MEMORY (57f3cc): the agent's `## How I work (standing lessons)` section holds its METHOD
 * lessons. 1.1.65 archived them with the dated notes and they were never read again (Phyllis's
 * research collapsed). The section is lifted out before the cut, kept directly under the header,
 * and never archived; the spawn seeds an empty one (seedPinnedSection).
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, unlinkSync, truncateSync } from 'node:fs';
import { basename, join } from 'node:path';

/** memory.md above this many bytes is rolled over. */
export const MEMORY_ROLLOVER_BYTES = 32 * 1024;
/** About this much of the newest text stays in memory.md after a rollover. */
export const MEMORY_KEEP_TAIL_BYTES = 12 * 1024;
/** A heading cut keeps at most this many times MEMORY_KEEP_TAIL_BYTES (else a line-break cut). */
export const MEMORY_KEEP_MAX_FACTOR = 2;
/** An archive file is started afresh (`-2`, `-3`, ...) before it passes this. The indexer
 *  skips any source over 2 MB (nativeMemory/sources.ts MAX_SOURCE_BYTES). */
export const MEMORY_ARCHIVE_MAX_BYTES = 1024 * 1024;

/** The first words of the pointer line a rollover leaves in memory.md. */
export const POINTER_HEAD = '_Older notes are archived in ';

/** The pinned section's heading, matched exactly (trailing blanks aside). */
export const PINNED_HEADING = '## How I work (standing lessons)';
/** The empty section the spawn seeds under the generated header. */
export const PINNED_SEED = `${PINNED_HEADING}\n_Your method lessons (how you work); kept at the top, never archived._\n`;
/** Soft cap: above it the spawn logs `memory-pinned-over-cap` (once a day); nothing is cut. */
export const PINNED_SOFT_CAP_BYTES = 6 * 1024;
/** Hard stop: above it the rollover leaves memory.md untouched (`memory-pinned-too-large`). */
export const PINNED_HARD_CAP_BYTES = 24 * 1024;

export interface MemorySplit {
  /** The generated head (`# Memory - ...` and its italic line), kept in memory.md. */
  header: string;
  /** The `## How I work (standing lessons)` section(s), kept under the header, never archived. */
  pinned: string;
  /** The older text, moved to the archive. */
  older: string;
  /** The newest text, kept in memory.md. */
  tail: string;
}

/**
 * Lift every `## How I work (standing lessons)` section (its heading up to the next `## ` heading,
 * the app's pointer line, or EOF) out of `body`, in order. A repeated heading is merged into the
 * first (its lines kept, the heading line once). The pointer line that ends a section, and the
 * blank line after it, are dropped: the rollover writes a current one. Pure; LF text.
 */
export function liftPinned(body: string): { pinned: string; rest: string } {
  const chunks = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let pinned = '';
  let rest = '';
  let inside = false;
  let dropBlank = false;
  for (const c of chunks) {
    const line = c.replace(/\n$/, '');
    if (dropBlank) {
      dropBlank = false;
      if (line.trim() === '') continue;
    }
    if (line.trimEnd() === PINNED_HEADING) {
      if (!pinned) pinned = c;
      inside = true;
      continue;
    }
    if (inside && line.startsWith(POINTER_HEAD)) {
      inside = false;
      dropBlank = true;
      continue;
    }
    if (inside && line.startsWith('## ')) inside = false;
    if (inside) pinned += c;
    else rest += c;
  }
  return { pinned, rest };
}

/** The pinned section of a memory.md text (LF or CRLF), '' if none. */
export function pinnedSection(text: string): string {
  return splitMemory(text.replace(/\r\n/g, '\n'), Number.POSITIVE_INFINITY).pinned;
}

/**
 * Split memory text into header / pinned / older / tail. The pinned section is lifted out first,
 * so it never counts against `keepBytes` and is never part of `older`. The cut is at the LAST `## ` heading at or
 * before the `keepBytes` mark, so at least `keepBytes` stay, but no further back than
 * MEMORY_KEEP_MAX_FACTOR x `keepBytes`; failing that, at the line break at or before the mark.
 * (Cutting at the first heading AFTER the mark could keep one short section: CB-165 F1.) Pure.
 */
export function splitMemory(text: string, keepBytes: number = MEMORY_KEEP_TAIL_BYTES): MemorySplit {
  const lines = text.split('\n');
  let h = 0;
  if (lines[0]?.startsWith('# ')) {
    h = 1;
    while (h < lines.length && h < 8 && (lines[h].trim() === '' || /^_.*_$/.test(lines[h].trim()))) h++;
  }
  // An earlier rollover's pointer line is dropped here; the caller writes a current one.
  const kept = lines.slice(0, h).filter((l) => !l.startsWith(POINTER_HEAD));
  while (kept.length > 1 && kept[kept.length - 1].trim() === '' && kept[kept.length - 2].trim() === '') kept.pop();
  const header = h ? kept.join('\n') + '\n' : '';
  const { pinned, rest: body } = liftPinned(lines.slice(h).join('\n'));
  // Work in UTF-8 BYTES (not UTF-16 units), so emoji-heavy text still keeps >= keepBytes.
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= keepBytes) return { header, pinned, older: '', tail: body };
  // The byte index exactly `keepBytes` from the end, and the furthest-back index a heading
  // cut may use (MAX_FACTOR x keepBytes kept).
  const from = buf.length - keepBytes;
  const min = Math.max(0, buf.length - keepBytes * MEMORY_KEEP_MAX_FACTOR);
  const heading = buf.lastIndexOf('\n## ', from - 1);
  let cut: number;
  if (heading >= 0 && heading + 1 >= min) cut = heading + 1;
  else {
    const nl = buf.lastIndexOf('\n', from - 1);
    cut = nl >= 0 ? nl + 1 : from;
  }
  // Never split a UTF-8 sequence (only reachable when there is no line break at all).
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  if (cut <= 0) return { header, pinned, older: '', tail: body };
  return { header, pinned, older: buf.subarray(0, cut).toString('utf8'), tail: buf.subarray(cut).toString('utf8') };
}

function localDate(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The archive file for `now`: today's, or the next numbered one once today's is full. */
export function archivePathFor(dir: string, now: number, adding: number): string {
  const date = localDate(now);
  for (let n = 1; n < 100; n++) {
    const p = join(dir, n === 1 ? `memory-archive-${date}.md` : `memory-archive-${date}-${n}.md`);
    let size = 0;
    try { size = statSync(p).size; } catch { return p; }
    if (size + adding <= MEMORY_ARCHIVE_MAX_BYTES) return p;
  }
  return join(dir, `memory-archive-${date}-${now}.md`);
}

/** Tests only: runs after the archive and the tmp file are written, just before the re-check. */
export const rolloverTestHooks: { beforeReplace?: (file: string) => void; beforeSeedReplace?: (file: string) => void } = {};

export interface RolloverResult {
  rotated: boolean;
  bytesBefore?: number;
  bytesAfter?: number;
  archive?: string;
  /** memory.md changed between the read and the replace, so the rollover was abandoned. */
  raced?: boolean;
  /** The pinned section's size, when the file was read. */
  pinnedBytes?: number;
  /** The pinned section is over PINNED_HARD_CAP_BYTES: memory.md was left untouched. */
  pinnedTooLarge?: boolean;
}

/**
 * Roll `<dir>/memory.md` over if it is above `limit`. The archive is written (appended) BEFORE
 * memory.md is replaced, and memory.md is replaced by rename, so a crash never loses text.
 */
export function rolloverMemory(dir: string, now: number = Date.now(), limit: number = MEMORY_ROLLOVER_BYTES, keepBytes: number = MEMORY_KEEP_TAIL_BYTES): RolloverResult {
  const file = join(dir, 'memory.md');
  if (!existsSync(file)) return { rotated: false };
  const st0 = statSync(file);
  const before = st0.size;
  if (before <= limit) return { rotated: false, bytesBefore: before };
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const { header, pinned, older, tail } = splitMemory(text, keepBytes);
  const pinnedBytes = Buffer.byteLength(pinned, 'utf8');
  if (pinnedBytes > PINNED_HARD_CAP_BYTES) return { rotated: false, bytesBefore: before, pinnedBytes, pinnedTooLarge: true };
  if (!older.trim()) return { rotated: false, bytesBefore: before, pinnedBytes };
  const eol = (s: string): string => (crlf ? s.replace(/\n/g, '\r\n') : s);
  const archive = archivePathFor(dir, now, Buffer.byteLength(older, 'utf8'));
  const archiveName = basename(archive);
  const title = (header.split('\n')[0] || '# Memory').replace(/^#\s*/, '');
  // Remember the archive's size so a raced abort can undo its append (no duplicate on retry).
  let archiveSizeBefore = -1;
  try { archiveSizeBefore = statSync(archive).size; } catch { /* a new archive */ }
  const archiveHead = archiveSizeBefore >= 0 ? '\n' : `# Memory archive - ${title}\n\n_Older notes rolled out of memory.md by the app. Indexed: \`memory search\` finds them._\n\n`;
  appendFileSync(archive, eol(`${archiveHead}<!-- rolled ${new Date(now).toISOString()} -->\n${older.replace(/\n*$/, '\n')}`), 'utf8');
  const pointer = `${POINTER_HEAD}${archiveName} (and earlier memory-archive-*.md files); \`memory search\` finds them._\n\n`;
  // The pinned section sits between the header and the pointer (which ends it on the next lift),
  // ending in exactly one blank line, so repeated rollovers keep it byte-identical.
  const top = pinned ? pinned.replace(/\n*$/, '\n\n') : '';
  const next = `${header}${!header || header.endsWith('\n\n') ? '' : '\n'}${top}${pointer}${tail}`;
  const tmp = `${file}.rollover-${process.pid}.tmp`;
  writeFileSync(tmp, eol(next), 'utf8');
  // CB-165 F2: a lingering process may have appended since the read. Replacing the file now
  // would lose that append, so abort: undo this archive append (the text is still in memory.md,
  // and the next spawn's rollover must not archive it twice) and leave memory.md as it is.
  rolloverTestHooks.beforeReplace?.(file);
  const st1 = statSync(file);
  if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    try {
      if (archiveSizeBefore < 0) unlinkSync(archive);
      else truncateSync(archive, archiveSizeBefore);
    } catch { /* best effort: a leftover copy is only a duplicate search hit */ }
    return { rotated: false, bytesBefore: before, raced: true, archive, pinnedBytes };
  }
  renameSync(tmp, file);
  return { rotated: true, bytesBefore: before, bytesAfter: statSync(file).size, archive, pinnedBytes };
}

export interface SeedResult {
  /** An empty pinned section was inserted. */
  seeded: boolean;
  /** memory.md changed between the read and the replace, so the seed was abandoned. */
  raced?: boolean;
  /** The existing pinned section's size (0 when none or just seeded). */
  pinnedBytes: number;
}

/**
 * PINNED-MEMORY migration: if `<dir>/memory.md` has no pinned section, insert an empty one
 * directly under the generated header (after its italic lines, before the pointer or the notes).
 * Idempotent; an existing heading anywhere is adopted as-is (the next rollover moves it to the
 * top). Same crash-safe tmp + re-stat + rename as the rollover. If the notes right after it do not
 * start with a `## ` heading (or the pointer), a `## Notes` heading is added so they are not read
 * as part of the section.
 */
export function seedPinnedSection(dir: string): SeedResult {
  const file = join(dir, 'memory.md');
  if (!existsSync(file)) return { seeded: false, pinnedBytes: 0 };
  const st0 = statSync(file);
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const lines = text.split('\n');
  if (lines.some((l) => l.trimEnd() === PINNED_HEADING)) {
    return { seeded: false, pinnedBytes: Buffer.byteLength(pinnedSection(text), 'utf8') };
  }
  let h = 0;
  if (lines[0]?.startsWith('# ')) {
    h = 1;
    while (h < lines.length && h < 8 && !lines[h].startsWith(POINTER_HEAD) && (lines[h].trim() === '' || /^_.*_$/.test(lines[h].trim()))) h++;
  }
  const head = lines.slice(0, h);
  while (head.length && head[head.length - 1].trim() === '') head.pop();
  const after = lines.slice(h);
  while (after.length && after[0].trim() === '') after.shift();
  const restText = after.join('\n');
  const needsNotes = restText.trim() !== '' && !after[0].startsWith('## ') && !after[0].startsWith(POINTER_HEAD);
  const next = `${head.length ? head.join('\n') + '\n\n' : ''}${PINNED_SEED}${restText ? '\n' : ''}${needsNotes ? '## Notes\n' : ''}${restText}`;
  const tmp = `${file}.seed-${process.pid}.tmp`;
  writeFileSync(tmp, crlf ? next.replace(/\n/g, '\r\n') : next, 'utf8');
  rolloverTestHooks.beforeSeedReplace?.(file);
  const st1 = statSync(file);
  if (st1.size !== st0.size || st1.mtimeMs !== st0.mtimeMs) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return { seeded: false, raced: true, pinnedBytes: 0 };
  }
  renameSync(tmp, file);
  return { seeded: true, pinnedBytes: 0 };
}

/** The per-agent record of the last day `memory-pinned-over-cap` was logged (in the agent's dir). */
export const PINNED_OVER_CAP_DAY_FILE = 'memory-pinned-over-cap-day';

/**
 * True (and today recorded) if `memory-pinned-over-cap` has not been logged for this agent today,
 * so the caller logs it at most once per agent per day. Best-effort: an unreadable record logs.
 */
export function pinnedOverCapDue(dir: string, now: number = Date.now()): boolean {
  const f = join(dir, PINNED_OVER_CAP_DAY_FILE);
  const today = localDate(now);
  try { if (readFileSync(f, 'utf8').trim() === today) return false; } catch { /* never logged */ }
  try { writeFileSync(f, `${today}\n`, 'utf8'); } catch { /* best effort */ }
  return true;
}
