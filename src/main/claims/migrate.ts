/**
 * CLAIM-LEDGER W6: the legacy import, the fallback parser and the frozen backup
 * (_work/system1/CLAIM-LEDGER-BUILD-PLAN.md §3 W6; gates G6.1, G6.2, G6.4, G6.5).
 *
 * THE SPLIT (god ce0e54, A2). An entry is exactly what the replay bed's reference split
 * (claims-bed/tools/snapshot.cjs `splitEntries`, Jim) calls an entry, so the import reconciles 1:1
 * against the bed's manifest and the bed and the ledger share keys:
 *   - a top-level `- ` / `* ` / `N. ` bullet with its indented continuation lines (sub-bullets fold
 *     into their parent), or one plain line; a hard-wrapped line joins the entry before it;
 *   - headings set the section and the date context; comments, the `# Memory` title and
 *     italic-only template lines are skipped;
 *   - a fenced block joins the entry before it. Addition (mirrored in snapshot.cjs): a fence with
 *     no entry open becomes its own plain entry instead of being dropped.
 * Skipped lines are COUNTED (FileManifest.skippedLines), so entry lines + skipped lines = every
 * non-blank line and nothing leaves silently.
 *
 * TEXT AND PROVENANCE. The claim text is the entry text word for word (marker included).
 * `legacy.sha256` = sha256(entry text), the bed's hash. An entry over LEGACY_TEXT_MAX is split at line
 * boundaries into parts that concatenate back to it exactly (G6.1 checks the hash of the
 * concatenation); every part carries the same `legacy {file, line, sha256}`.
 *
 * DEDUP (god 90881d, binding). Keyed on the entry's sha256 (its parts follow it), NEVER file:line:
 * the 1.1.83 rollover moves entries from memory.md into an archive. The full import compares
 * per-hash COUNTS across the agent's whole corpus with the ledger, so every entry (repeats included)
 * becomes one claim once, and a moved entry is not imported again. The memory.md-only parser skips
 * any entry whose hash the ledger already holds: an exact repeat is an R1 duplicate, so no fact is lost.
 *
 * WHO MAY USE THE 4000 LIMIT (god ce0e54). Only main's appendRecord with its internal caller flag,
 * set by the callers of these functions; never the HTTP, /ledger or IPC paths. A legacy import gets
 * `source: 'legacy'`; a parsed memory.md entry gets `source: 'self'`; both carry `legacy` provenance.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAIM_TEXT_MAX_LEGACY } from '../../shared/claims';
import type { ClaimKind, LedgerRec, RecordDraft } from '../../shared/claims';
import { isGeneratedMemory, isGeneratedViewHeading } from './generated';

/** The longest text a W6 draft may carry: claims.ts CLAIM_TEXT_MAX_LEGACY, through origin 'w6-internal' only. */
export const LEGACY_TEXT_MAX = CLAIM_TEXT_MAX_LEGACY;
export const ARCHIVE_RE = /^memory-archive-.*\.md$/;
/** W4 tags every generated line with its claim id; such an entry is never re-imported. */
export const RENDERED_RE = /\[c:([^\]\s]+)\]/;

// The reference split's patterns (snapshot.cjs), unchanged.
const DATE = /\b(20\d\d-\d\d-\d\d)(?:[ T](\d\d:\d\d))?/;
const BOILER = [/^# Memory/, /^_[^_].*_\s*$/];
const ENDS = /[.!?:;)\]`*]\s*$/;
const LESSONS = /^How I work\b/i;

export interface Entry {
  file: string;
  /** 1-based line of the entry's first line. */
  line: number;
  style: 'bullet' | 'plain';
  multiLine: boolean;
  section: string | null;
  date: string | null;
  dateSource: 'text' | 'heading' | 'rolled-upper-bound' | 'file-name' | 'none';
  sha256: string;
  text: string;
  /** Inside the `## How I work` section (W6 only; not part of the bed's entry). */
  lesson: boolean;
}

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The reference split (snapshot.cjs splitEntries) plus the orphan-fence addition and a skipped-line count. */
export function splitEntries(text: string, file: string): { entries: Entry[]; skippedLines: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  type Cur = { line: number; style: 'bullet' | 'plain'; lines: string[]; section: string | null; sectionDate: string | null; rolled: string | null; lesson: boolean };
  const out: Cur[] = [];
  let section: string | null = null;
  let sectionDate: string | null = null;
  let rolled: string | null = null;
  let lesson = false;
  let cur: Cur | null = null;
  let fence = false;
  let skippedLines = 0;
  const open = (i: number, style: 'bullet' | 'plain', ln: string): Cur => ({ line: i + 1, style, lines: [ln], section, sectionDate, rolled, lesson });
  const close = (): void => { if (cur) { out.push(cur); cur = null; } };
  lines.forEach((ln, i) => {
    if (/^\s*```/.test(ln)) {
      if (!fence && !cur) { cur = open(i, 'plain', ln); fence = true; return; }   // addition: an orphan fence is its own entry
      fence = !fence;
      if (cur) cur.lines.push(ln);
      return;
    }
    if (fence) { if (cur) cur.lines.push(ln); return; }
    const rc = /^<!-- rolled (\S+) -->/.exec(ln);
    if (rc) { close(); rolled = rc[1]; skippedLines++; return; }
    if (/^<!--.*-->\s*$/.test(ln)) { close(); skippedLines++; return; }
    if (/^#{1,6} /.test(ln)) {
      close();
      section = ln.replace(/^#+ /, '');
      if (/^#{1,2} /.test(ln)) lesson = LESSONS.test(section);
      const d = DATE.exec(section);
      sectionDate = d ? d[1] : sectionDate;
      skippedLines++;
      return;
    }
    if (!ln.trim()) { close(); return; }
    if (BOILER.some((r) => r.test(ln))) { close(); skippedLines++; return; }
    const bullet = /^(- |\* |\d+\. )/.test(ln);
    const cont = /^\s+\S/.test(ln) && cur;
    if (cont) { cur!.lines.push(ln); return; }
    if (cur && !bullet && lines[i - 1] && lines[i - 1].trim() && (!ENDS.test(lines[i - 1]) || /^[a-z]/.test(ln))) { (cur as Cur).lines.push(ln); return; }
    close();
    cur = open(i, bullet ? 'bullet' : 'plain', ln);
  });
  close();
  const entries = out.map((e): Entry => {
    const t = e.lines.join('\n');
    const d = DATE.exec(e.lines[0]);
    let date: string | null = null;
    let dateSource: Entry['dateSource'] = 'none';
    if (d) { date = d[1] + (d[2] ? `T${d[2]}` : ''); dateSource = 'text'; }
    else if (e.sectionDate) { date = e.sectionDate; dateSource = 'heading'; }
    else if (e.rolled) { date = e.rolled.slice(0, 10); dateSource = 'rolled-upper-bound'; }
    else { const fd = /(20\d\d-\d\d-\d\d)/.exec(file); date = fd ? fd[1] : null; dateSource = fd ? 'file-name' : 'none'; }
    return { file, line: e.line, style: e.style, multiLine: e.lines.length > 1, section: e.section, date, dateSource, sha256: sha(t), text: t, lesson: e.lesson };
  });
  return { entries, skippedLines };
}

/**
 * Split text at LINE BOUNDARIES ONLY into parts of at most `max` chars that concatenate back to it
 * exactly. A single line longer than `max` cannot be split that way: the result is null, and the
 * caller refuses and reports the entry (god 5a86f6). Text is never cut inside a line.
 */
export function splitText(text: string, max = LEGACY_TEXT_MAX): string[] | null {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const piece of text.split(/(?<=\n)/)) {
    if (piece.length > max) return null;
    if (cur.length + piece.length <= max) { cur += piece; continue; }
    parts.push(cur);
    cur = piece;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** An entry W6 could not turn into claims: reported (import manifest, report, log row), never dropped silently. */
export interface Refusal { file: string; line: number; chars: number; error: string }

export const LINE_TOO_LONG = `a single line over ${LEGACY_TEXT_MAX} characters (split only at line boundaries)`;

/** An entry's date as an ISO `at` (claims.ts: main still clamps it to the write time). */
export function isoAt(date: string | null): string | undefined {
  if (!date) return undefined;
  const d = new Date(date.length === 10 ? `${date}T00:00:00Z` : `${date}:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The drafts for one entry (one per part, all with the same legacy provenance), or its refusal. */
/** G3.5: the longest section (heading) a claim carries; a longer one is cut, never refused. */
export const SECTION_MAX = 200;

/** A heading as a claim's `section`: trimmed, cut to SECTION_MAX UTF-16 units on a code-point boundary
 *  (never a lone surrogate), deterministically; undefined for none. */
export function clampSection(section: unknown): string | undefined {
  if (typeof section !== 'string') return undefined;
  let s = section.trim();
  if (!s) return undefined;
  if (s.length > SECTION_MAX) {
    s = s.slice(0, SECTION_MAX);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s || undefined;
}

export function entryDrafts(e: Entry, source: 'legacy' | 'self'): { drafts: RecordDraft[]; refusal: Refusal | null } {
  const parts = splitText(e.text);
  if (!parts) {
    const longest = Math.max(...e.text.split('\n').map((l) => l.length));
    return { drafts: [], refusal: { file: e.file, line: e.line, chars: longest, error: LINE_TOO_LONG } };
  }
  const kind: ClaimKind = e.lesson ? 'lesson' : 'fact';
  const at = isoAt(e.date);
  // G3.5: the heading the entry stood under, on BOTH W6 paths (the import and parseNewBullets).
  const section = clampSection(e.section);
  const drafts = parts.map((text) => {
    const d: RecordDraft = { t: 'claim', kind, text, source, legacy: { file: e.file, line: e.line, sha256: e.sha256 }, ...(section ? { section } : {}) };
    if (at) d.at = at;
    if (kind === 'lesson') d.pin = true;
    return d;
  });
  return { drafts, refusal: null };
}

/** The drafts for one entry; [] for a refused one (use entryDrafts to see the refusal). */
export function draftsFor(e: Entry, source: 'legacy' | 'self'): RecordDraft[] {
  return entryDrafts(e, source).drafts;
}

export interface FileManifest { file: string; bytes: number; sha256: string; entries: number; nonBlankLines: number; entryLines: number; skippedLines: number; refused: number }

/** The agent's legacy files in import order: archives by name (they are dated), then memory.md. */
export function legacyFiles(agentDir: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(agentDir); } catch { return []; }
  const archives = names.filter((n) => ARCHIVE_RE.test(n)).sort();
  return names.includes('memory.md') ? [...archives, 'memory.md'] : archives;
}

/** G6.1 (F15): every entry of the agent's legacy files, with a per-file manifest to reconcile against. */
export function importLegacyDetailed(agentDir: string): { entries: Entry[]; manifest: FileManifest[] } {
  const entries: Entry[] = [];
  const manifest: FileManifest[] = [];
  for (const f of legacyFiles(agentDir)) {
    const buf = readFileSync(join(agentDir, f));
    const text = buf.toString('utf8');
    const r = splitEntries(text, f);
    entries.push(...r.entries);
    manifest.push({
      file: f, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), entries: r.entries.length,
      nonBlankLines: text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '').length,
      entryLines: r.entries.reduce((s, e) => s + e.text.split('\n').filter((l) => l.trim() !== '').length, 0),
      skippedLines: r.skippedLines,
      refused: r.entries.filter((e) => splitText(e.text) === null).length
    });
  }
  return { entries, manifest };
}

/** ImportLegacyFn (claims.ts): every entry of the agent's memory.md and archives as `legacy` drafts, in order. */
export function importLegacy(agentDir: string): RecordDraft[] {
  return importLegacyDetailed(agentDir).entries.flatMap((e) => draftsFor(e, 'legacy'));
}

/** R1's reason on a sighting that stands for a whole legacy entry (store.ts), so it counts as imported. */
export const R1_LEGACY_REASON = (sha256: string): string => `legacy ${sha256}`;
export const R1_LEGACY_REASON_RE = /^legacy ([0-9a-f]{64})$/;

/**
 * How many whole entries of each hash the ledger already holds. The parts of a split entry share
 * {file, line, sha256}; they are re-assembled in ledger order until their concatenation hashes to
 * that sha256, and only then count as one entry. So another writer's record landing between two
 * parts changes nothing, and a lone part never counts as a whole entry.
 */
export function ledgerEntryCounts(records: LedgerRec[]): Map<string, number> {
  const counts = new Map<string, number>();
  // Per triple, the open candidate assemblies. A record extends every open candidate and also starts
  // a new one, so a part orphaned by a crash (and then re-imported whole) never blocks the count.
  const open = new Map<string, string[]>();
  for (const r of records) {
    // R1: an exact restatement of a whole entry became a sighting naming the entry hash; it was
    // imported (as a sighting), so it counts, and a re-run never offers it again.
    if (r.t === 'event' && r.ev === 'sighting' && r.rule === 'R1') {
      const m = R1_LEGACY_REASON_RE.exec(r.reason ?? '');
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      continue;
    }
    if (r.t !== 'claim' || !r.legacy) continue;
    const triple = `${r.legacy.file}\u0000${r.legacy.line}\u0000${r.legacy.sha256}`;
    const cands = [...(open.get(triple) ?? []).map((acc) => acc + r.text), r.text];
    const hit = cands.findIndex((acc) => sha(acc) === r.legacy!.sha256);
    if (hit >= 0) {
      counts.set(r.legacy.sha256, (counts.get(r.legacy.sha256) ?? 0) + 1);
      cands.splice(hit, 1);
    }
    const keep = cands.filter((acc) => acc.length < LEGACY_ASSEMBLY_MAX).slice(-OPEN_ASSEMBLIES_MAX);
    if (keep.length) open.set(triple, keep); else open.delete(triple);
  }
  return counts;
}
/** Bounds for ledgerEntryCounts: no legacy entry is near this long, and orphans are rare. */
const LEGACY_ASSEMBLY_MAX = 1024 * 1024;
const OPEN_ASSEMBLIES_MAX = 16;

/** G6.2/G6.4: the legacy drafts the ledger does not hold yet. Per-hash counts, never file:line. */
export function newLegacyDrafts(agentDir: string, records: LedgerRec[]): RecordDraft[] {
  return newLegacyImport(agentDir, records).drafts;
}

/** newLegacyDrafts plus the entries refused (reported every run: they never reach the ledger). */
export function newLegacyImport(agentDir: string, records: LedgerRec[]): { drafts: RecordDraft[]; refusals: Refusal[] } {
  const have = ledgerEntryCounts(records);
  const seen = new Map<string, number>();
  const drafts: RecordDraft[] = [];
  const refusals: Refusal[] = [];
  for (const e of importLegacyDetailed(agentDir).entries) {
    const n = (seen.get(e.sha256) ?? 0) + 1;
    seen.set(e.sha256, n);
    if (n <= (have.get(e.sha256) ?? 0)) continue;
    const r = entryDrafts(e, 'legacy');
    drafts.push(...r.drafts);
    if (r.refusal) refusals.push(r.refusal);
  }
  return { drafts, refusals };
}

/**
 * The `knownIds` for parseNewBullets: every claim id, plus `b:<sha256>` for every WHOLE entry in the
 * ledger (a part orphaned by a crash does not make its entry "known", so the entry is not lost).
 */
export function knownIdsFor(records: LedgerRec[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) if (r.t === 'claim') ids.add(r.id);
  for (const h of ledgerEntryCounts(records).keys()) ids.add(`b:${h}`);
  return ids;
}

/**
 * ParseNewBulletsFn (claims.ts): the fallback parser for an agent-written memory.md (reader mode,
 * and after a downgrade and re-upgrade). An entry is skipped when its hash is known (`b:<sha256>`)
 * or when it carries a rendered `[c:<id>]` tag of a known claim. Every other entry becomes a `self`
 * claim, word for word.
 */
export function parseNewBullets(memoryMd: string, knownIds: Set<string>): RecordDraft[] {
  return parseNewBulletsDetailed(memoryMd, knownIds).drafts;
}

/** parseNewBullets plus the entries refused (a single line over the limit). */
export function parseNewBulletsDetailed(memoryMd: string, knownIds: Set<string>): { drafts: RecordDraft[]; refusals: Refusal[] } {
  const drafts: RecordDraft[] = [];
  const refusals: Refusal[] = [];
  // CL-W6-VIEW-SECTION: in a generated view, W4's own headings are scaffolding, so they yield no section.
  const generated = isGeneratedMemory(memoryMd);
  for (const e of splitEntries(memoryMd, 'memory.md').entries) {
    if (knownIds.has(`b:${e.sha256}`)) continue;
    const tag = RENDERED_RE.exec(e.text);
    if (tag && knownIds.has(tag[1])) continue;
    const r = entryDrafts(generated && e.section !== null && isGeneratedViewHeading(e.section) ? { ...e, section: null } : e, 'self');
    drafts.push(...r.drafts);
    if (r.refusal) refusals.push(r.refusal);
  }
  return { drafts, refusals };
}

export interface BackupResult {
  /** A new backup was written now. */
  written: boolean;
  files: Array<{ file: string; sha256: string; bytes: number }>;
  /** destDir exists without its completion manifest: NOTHING was written, and the caller must stop. */
  partial?: boolean;
}

/**
 * G6.5: the frozen S0 backup of an agent's memory.md and archives, byte for byte, with a manifest.
 * It NEVER overwrites anything (god 5a86f6):
 *   - a complete backup (destDir with manifest.json) is kept as it is: the first freeze counts;
 *   - destDir existing in any other form (a partial backup, a stray file) is left untouched and
 *     reported as `partial`, so the caller stops;
 *   - a new backup is built in a fresh sibling folder, files copied with COPYFILE_EXCL, the manifest
 *     written last, then the folder is renamed into place, so destDir only ever appears complete.
 */
export function frozenBackup(agentDir: string, destDir: string): BackupResult {
  const manifestPath = join(destDir, 'manifest.json');
  if (existsSync(manifestPath)) return { written: false, files: JSON.parse(readFileSync(manifestPath, 'utf8')).files };
  if (existsSync(destDir)) return { written: false, files: [], partial: true };
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = mkdtempSync(`${destDir}.tmp-`);
  const files = legacyFiles(agentDir).map((f) => {
    const buf = readFileSync(join(agentDir, f));
    copyFileSync(join(agentDir, f), join(tmp, f), fsConstants.COPYFILE_EXCL);
    return { file: f, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  });
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify({ v: 1, files }, null, 1), { flag: 'wx' });
  if (existsSync(destDir)) { rmSync(tmp, { recursive: true, force: true }); return { written: false, files: [], partial: true }; }   // appeared meanwhile: leave it, drop ours
  renameSync(tmp, destDir);
  return { written: true, files };
}
