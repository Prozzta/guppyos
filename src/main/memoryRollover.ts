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

export interface MemorySplit {
  /** The generated head (`# Memory - ...` and its italic line), kept in memory.md. */
  header: string;
  /** The older text, moved to the archive. */
  older: string;
  /** The newest text, kept in memory.md. */
  tail: string;
}

/**
 * Split memory text into header / older / tail. The cut is at the LAST `## ` heading at or
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
  const body = lines.slice(h).join('\n');
  // Work in UTF-8 BYTES (not UTF-16 units), so emoji-heavy text still keeps >= keepBytes.
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= keepBytes) return { header, older: '', tail: body };
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
  if (cut <= 0) return { header, older: '', tail: body };
  return { header, older: buf.subarray(0, cut).toString('utf8'), tail: buf.subarray(cut).toString('utf8') };
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
export const rolloverTestHooks: { beforeReplace?: (file: string) => void } = {};

export interface RolloverResult {
  rotated: boolean;
  bytesBefore?: number;
  bytesAfter?: number;
  archive?: string;
  /** memory.md changed between the read and the replace, so the rollover was abandoned. */
  raced?: boolean;
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
  const { header, older, tail } = splitMemory(text, keepBytes);
  if (!older.trim()) return { rotated: false, bytesBefore: before };
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
  const next = `${header}${!header || header.endsWith('\n\n') ? '' : '\n'}${pointer}${tail}`;
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
    return { rotated: false, bytesBefore: before, raced: true, archive };
  }
  renameSync(tmp, file);
  return { rotated: true, bytesBefore: before, bytesAfter: statSync(file).size, archive };
}
