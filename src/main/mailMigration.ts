/**
 * ZT-I1-MAIL 1.1.75 slice 6: the one-shot, idempotent upgrade pass (INBOX-DESIGN.md §7.1,
 * §11.12(c), §11.17 N4, §11.18 #8).
 *
 * Run once per hive at boot, BEFORE `archiveOrphanedAgents` (which archives every agent without a
 * live PTY at boot, so after it the `archived` flag no longer tells a closed agent from one whose
 * tab is about to be restored):
 *  1. every active registry agent's ledger is touched, so the lazy §7.1 first-touch import runs
 *     for all of them now (`inbox/*.json` → `delivered legacy:true`; `.done` is history, never
 *     imported);
 *  2. every ARCHIVED agent's `inbox/*.json` is moved to `inbox/.undelivered/` and listed in
 *     `state/mail/undelivered-report.json`, shown once to the Human in the Command Center. No
 *     ledger is loaded for it and nothing wakes it (archived agents are never touched otherwise);
 *  3. each agent's `## How I work (standing lessons)` section is scanned, READ-ONLY, for
 *     inbox-move rules (§11.12(c)); hits go into `state/mail/migration-report.json` and the log.
 *     Memory files are never edited: the Human or god decides.
 * The marker `state/mail/migration.json` is written LAST, so a crash mid-pass re-runs it: every
 * step is idempotent (a ledger that exists is never re-imported, a moved file is gone from inbox/,
 * the undelivered report merges by agent + id, the lesson report is rewritten).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, renameWithRetry } from './atomicJson';
import { isValidMailId, type MailLedgerDoc } from './mailLedger';
import { pinnedSection } from './memoryRollover';

export const MAIL_MIGRATION_VERSION = 1;
/** Relative to the hive root. */
export const MAIL_MIGRATION_MARKER = join('state', 'mail', 'migration.json');
export const MAIL_MIGRATION_REPORT = join('state', 'mail', 'migration-report.json');
export const MAIL_UNDELIVERED_REPORT = join('state', 'mail', 'undelivered-report.json');
/** The folder an archived agent's unread mail is moved to (§7.1 step 2). */
export const UNDELIVERED_DIR = '.undelivered';
const MESSAGE_FILE_MAX_BYTES = 1024 * 1024;
const MEMORY_MAX_BYTES = 4 * 1024 * 1024;
const LESSON_TEXT_MAX = 300;

// ————————————————————————————————————————————————————————————————— lesson scan (pure)

export interface MailLessonHit {
  /** 1-based line number inside the `## How I work` section (its heading is line 1). */
  line: number;
  text: string;
}

const MOVE_WORD = /\b(move|moved|moves|moving|mv|rename|renamed|renaming|archive|archived|archiving)\b/i;

/**
 * §11.12(c): the lines of the `## How I work (standing lessons)` section that state an inbox-move
 * rule: any line naming `inbox/.done` / `.done`, or naming the inbox together with a move verb.
 * Pure and read-only; the section is found exactly as the memory rollover finds it.
 */
export function scanMailLessons(memoryText: string): MailLessonHit[] {
  const section = pinnedSection(memoryText);
  if (!section) return [];
  const out: MailLessonHit[] = [];
  section.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const done = /(^|[^A-Za-z0-9])\.done\b/i.test(line);
    const inboxMove = /\binbox\b/i.test(line) && MOVE_WORD.test(line);
    if (done || inboxMove) out.push({ line: i + 1, text: line.slice(0, LESSON_TEXT_MAX) });
  });
  return out;
}

// ————————————————————————————————————————————————————————————————— report shapes

export interface UndeliveredItem {
  agentId: string;
  id: string;
  /** Relative to the hive root, with forward slashes. */
  file: string;
  from: string | null;
  act: string | null;
  subject: string | null;
  createdAt: string | null;
  movedAt: number;
}

export interface UndeliveredReport {
  version: 1;
  createdAt: number;
  updatedAt: number;
  /** When the Human dismissed it in the Command Center; null = still to show (once). */
  seenAt: number | null;
  items: UndeliveredItem[];
}

export interface MigrationAgentRow {
  agentId: string;
  archived: boolean;
  /** Active agents: ledger entries imported from inbox/ with the legacy marker (on this pass or a
   *  previous first touch), still delivered. */
  legacyPending?: number;
  /** Archived agents: files moved to inbox/.undelivered on this pass. */
  undelivered?: number;
  error?: string;
}

export interface MigrationReport {
  version: 1;
  at: number;
  agents: MigrationAgentRow[];
  /** §11.12(c): inbox-move rules found in `## How I work`. Never edited; the Human or god decides. */
  lessons: Array<{ agentId: string; archived: boolean; hits: MailLessonHit[] }>;
}

export interface MailMigrationDeps {
  root: string;
  /** The registry's agents, own keys only. `archived` = archived EXPLICITLY (Q31: the caller
   *  passes archivedForMail; an orphan or pty-exit archive counts as active here). */
  agents: Array<{ id: string; archived: boolean }>;
  mail: { ledger(agentId: string): MailLedgerDoc; flushAll(): void };
  appendLog: (row: Record<string, unknown>) => void;
  now?: () => number;
}

export interface MailMigrationResult {
  ran: boolean;
  report?: MigrationReport;
  undelivered?: UndeliveredItem[];
}

// ————————————————————————————————————————————————————————————————— helpers

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}

function validUndeliveredReport(x: unknown): x is UndeliveredReport {
  const r = x as UndeliveredReport;
  return !!r && typeof r === 'object' && r.version === 1 && Array.isArray(r.items);
}

/** The undelivered report, or null when there is none (or it is unreadable). */
export function readUndeliveredReport(root: string): UndeliveredReport | null {
  const r = readJson<unknown>(join(root, MAIL_UNDELIVERED_REPORT));
  return validUndeliveredReport(r) ? r : null;
}

/** The Human dismissed the report: persisted, so it is shown once. Returns true on change. */
export function markUndeliveredSeen(root: string, now: number = Date.now()): boolean {
  const r = readUndeliveredReport(root);
  if (!r || r.seenAt !== null) return false;
  atomicWriteJson(join(root, MAIL_UNDELIVERED_REPORT), { ...r, seenAt: now });
  return true;
}

export function mailMigrationDone(root: string): boolean {
  const m = readJson<{ version?: unknown }>(join(root, MAIL_MIGRATION_MARKER));
  return !!m && typeof m.version === 'number' && m.version >= MAIL_MIGRATION_VERSION;
}

function header(p: string): { from: string | null; act: string | null; subject: string | null; createdAt: string | null } {
  const none = { from: null, act: null, subject: null, createdAt: null };
  try {
    if (statSync(p).size > MESSAGE_FILE_MAX_BYTES) return none;
    const m = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const s = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
    return { from: s(m?.from), act: s(m?.act, 40), subject: s(m?.subject), createdAt: s(m?.created_at, 40) };
  } catch { return none; }
}

/**
 * §7.1 step 2 for one archived agent: inbox/*.json → inbox/.undelivered/. Never overwrites. Each
 * file is tried on its own (Jim, slice 6/7 audit): a rename that throws (an AV lock) is counted in
 * `errors` and the rest still move. What reaches the report is read back from .undelivered/ itself
 * (listUndelivered), never from this pass's own list, so a crash or a failure between the renames
 * and the report write loses nothing: the retry lists what the earlier pass moved.
 */
function moveUndelivered(root: string, agentId: string): { moved: number; errors: string[] } {
  const inbox = join(root, 'agents', agentId, 'inbox');
  let names: string[];
  try { names = readdirSync(inbox); } catch { return { moved: 0, errors: [] }; }
  const files = names.filter((n) => n.endsWith('.json') && !n.includes('.tmp'));
  if (!files.length) return { moved: 0, errors: [] };
  const dest = join(inbox, UNDELIVERED_DIR);
  mkdirSync(dest, { recursive: true });
  let moved = 0;
  const errors: string[] = [];
  for (const n of files) {
    const src = join(inbox, n);
    try {
      if (!statSync(src).isFile()) continue;
      const stem = n.slice(0, -'.json'.length);
      let target = n;
      for (let i = 1; existsSync(join(dest, target)); i++) target = `${stem}.${i}.json`;
      renameWithRetry(src, join(dest, target));
      moved++;
    } catch (error) {
      errors.push(`${n}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { moved, errors };
}

/** The report items for what sits in an agent's inbox/.undelivered/ now (the source of truth). */
function listUndelivered(root: string, agentId: string, now: number): UndeliveredItem[] {
  const dir = join(root, 'agents', agentId, 'inbox', UNDELIVERED_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: UndeliveredItem[] = [];
  for (const n of names.filter((x) => x.endsWith('.json') && !x.includes('.tmp')).sort()) {
    const p = join(dir, n);
    try { if (!statSync(p).isFile()) continue; } catch { continue; }
    out.push({ agentId, id: n.slice(0, -'.json'.length), file: `agents/${agentId}/inbox/${UNDELIVERED_DIR}/${n}`, ...header(p), movedAt: now });
  }
  return out;
}

/**
 * ZT-I1-MAIL Q32 refinement (god 0f1672): an agent is restored, so its `inbox/.undelivered/*.json`
 * go back to `inbox/`. A stem already taken (a file in inbox/ or .done/, or `taken(stem)`, the
 * ledger) becomes `<stem>.N`; nothing is ever overwritten. Returns what moved: the new id (the
 * inbox file stem) and the report path of the file it came from. Idempotent: a moved file is gone.
 */
export function restoreUndeliveredFiles(root: string, agentId: string, taken: (stem: string) => boolean): Array<{ id: string; file: string }> {
  const inbox = join(root, 'agents', agentId, 'inbox');
  const src = join(inbox, UNDELIVERED_DIR);
  let names: string[];
  try { names = readdirSync(src); } catch { return []; }
  const out: Array<{ id: string; file: string }> = [];
  for (const n of names.filter((x) => x.endsWith('.json') && !x.includes('.tmp')).sort()) {
    const from = join(src, n);
    try { if (!statSync(from).isFile()) continue; } catch { continue; }
    const stem = n.slice(0, -'.json'.length);
    const free = (id: string): boolean => isValidMailId(id) && !taken(id)
      && !existsSync(join(inbox, `${id}.json`)) && !existsSync(join(inbox, '.done', `${id}.json`));
    let id = stem;
    for (let i = 1; !free(id) && i < 1000; i++) id = `${stem}.${i}`;
    if (!free(id)) continue;
    renameWithRetry(from, join(inbox, `${id}.json`));
    out.push({ id, file: `agents/${agentId}/inbox/${UNDELIVERED_DIR}/${n}` });
  }
  return out;
}

/** Q32 refinement: restored files leave the undelivered report (their mail is delivered now). */
export function dropUndeliveredItems(root: string, agentId: string, files: readonly string[]): boolean {
  const r = readUndeliveredReport(root);
  if (!r || !files.length) return false;
  const gone = new Set(files);
  const items = r.items.filter((i) => !(i.agentId === agentId && gone.has(i.file)));
  if (items.length === r.items.length) return false;
  atomicWriteJson(join(root, MAIL_UNDELIVERED_REPORT), { ...r, updatedAt: Date.now(), items } satisfies UndeliveredReport);
  return true;
}

/**
 * The undelivered report merges by agent + file, so a re-run after a crash never loses items. It is
 * written only when an item is new; new items reset `seenAt` (the banner shows again), otherwise a
 * report the Human already saw stays seen. Returns the report's items.
 */
function mergeUndeliveredReport(root: string, listed: readonly UndeliveredItem[], now: number): UndeliveredItem[] {
  const prior = readUndeliveredReport(root);
  const items: UndeliveredItem[] = prior?.items ?? [];
  const key = (i: UndeliveredItem): string => `${i.agentId}|${i.file}`;
  const seen = new Set(items.map(key));
  const fresh = listed.filter((i) => !seen.has(key(i)));
  if (!fresh.length) return items;
  mkdirSync(join(root, 'state', 'mail'), { recursive: true });
  atomicWriteJson(join(root, MAIL_UNDELIVERED_REPORT), {
    version: 1, createdAt: prior?.createdAt ?? now, updatedAt: now, seenAt: null, items: [...items, ...fresh]
  } satisfies UndeliveredReport);
  return [...items, ...fresh];
}

/**
 * God df70e4 / 016ccd: an EXPLICIT archive after the upgrade runs the migration's own §7.1 step 2
 * for that agent: moveUndelivered (inbox/*.json → inbox/.undelivered/) and the report built from
 * the directory. Idempotent (a second call finds nothing new). Returns the files moved on this
 * call (their original stems) and any per-file errors; throws only when the report cannot be written.
 */
export function setAsideUndelivered(root: string, agentId: string, now: number = Date.now()): { moved: number; errors: string[] } {
  if (!isValidMailId(agentId)) return { moved: 0, errors: [] };
  const r = moveUndelivered(root, agentId);
  mergeUndeliveredReport(root, listUndelivered(root, agentId, now), now);
  return r;
}

// ————————————————————————————————————————————————————————————————— the pass

/**
 * The one-shot boot pass. A no-op (`ran:false`) once the marker is written. Throws only when the
 * reports or the marker cannot be written (the caller logs it; the next boot re-runs the pass).
 */
export function runMailMigration(deps: MailMigrationDeps): MailMigrationResult {
  const { root, appendLog } = deps;
  const now = (deps.now ?? Date.now)();
  if (mailMigrationDone(root)) return { ran: false };
  mkdirSync(join(root, 'state', 'mail'), { recursive: true });

  const rows: MigrationAgentRow[] = [];
  const lessons: MigrationReport['lessons'] = [];
  const moved: UndeliveredItem[] = [];
  let movedCount = 0;
  for (const a of deps.agents) {
    if (!isValidMailId(a.id)) continue;
    const row: MigrationAgentRow = { agentId: a.id, archived: a.archived };
    try {
      if (a.archived) {
        const r = moveUndelivered(root, a.id);
        row.undelivered = r.moved;
        movedCount += r.moved;
        // Listed from the directory, also when a file failed: every file moved so far (on this
        // pass or an earlier, interrupted one) reaches the report before any marker.
        moved.push(...listUndelivered(root, a.id, now));
        if (r.errors.length) throw new Error(`${r.errors.length} file(s) not moved to ${UNDELIVERED_DIR}: ${r.errors[0]}`);
      } else {
        // The first touch runs the §7.1 import (idempotent: an existing ledger is only loaded).
        const doc = deps.mail.ledger(a.id);
        row.legacyPending = Object.values(doc.entries).filter((e) => e.legacy && e.state === 'delivered').length;
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      appendLog({ kind: 'mail-migration-error', agentId: a.id, archived: a.archived, error: row.error.slice(0, 300) });
    }
    rows.push(row);
    // §11.12(c): read-only lesson scan.
    try {
      const p = join(root, 'agents', a.id, 'memory.md');
      if (existsSync(p) && statSync(p).size <= MEMORY_MAX_BYTES) {
        const hits = scanMailLessons(readFileSync(p, 'utf8'));
        if (hits.length) {
          lessons.push({ agentId: a.id, archived: a.archived, hits });
          appendLog({ kind: 'mail-migration-lesson', agentId: a.id, lines: hits.map((h) => h.line), texts: hits.map((h) => h.text) });
        }
      }
    } catch { /* unreadable memory: nothing to report */ }
  }
  deps.mail.flushAll();

  const undelivered = mergeUndeliveredReport(root, moved, now);

  const report: MigrationReport = { version: 1, at: now, agents: rows, lessons };
  atomicWriteJson(join(root, MAIL_MIGRATION_REPORT), report);
  appendLog({
    kind: 'mail-migration',
    agents: rows.length,
    legacyPending: rows.reduce((n, r) => n + (r.legacyPending ?? 0), 0),
    undelivered: movedCount,
    lessons: lessons.length,
    errors: rows.filter((r) => r.error).length
  });
  // An error leaves the marker unwritten: the next boot re-runs the (idempotent) pass.
  if (!rows.some((r) => r.error)) atomicWriteJson(join(root, MAIL_MIGRATION_MARKER), { version: MAIL_MIGRATION_VERSION, completedAt: now });
  return { ran: true, report, undelivered };
}
