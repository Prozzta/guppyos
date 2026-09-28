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
  /** The registry's agents, own keys only. */
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

/** §7.1 step 2 for one archived agent: inbox/*.json → inbox/.undelivered/. Never overwrites. */
function moveUndelivered(root: string, agentId: string, now: number): UndeliveredItem[] {
  const inbox = join(root, 'agents', agentId, 'inbox');
  let names: string[];
  try { names = readdirSync(inbox); } catch { return []; }
  const files = names.filter((n) => n.endsWith('.json') && !n.includes('.tmp'));
  if (!files.length) return [];
  const dest = join(inbox, UNDELIVERED_DIR);
  mkdirSync(dest, { recursive: true });
  const out: UndeliveredItem[] = [];
  for (const n of files) {
    const src = join(inbox, n);
    try { if (!statSync(src).isFile()) continue; } catch { continue; }
    const stem = n.slice(0, -'.json'.length);
    let target = n;
    for (let i = 1; existsSync(join(dest, target)); i++) target = `${stem}.${i}.json`;
    const h = header(src);
    renameWithRetry(src, join(dest, target));
    out.push({ agentId, id: stem, file: `agents/${agentId}/inbox/${UNDELIVERED_DIR}/${target}`, ...h, movedAt: now });
  }
  return out;
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
  for (const a of deps.agents) {
    if (!isValidMailId(a.id)) continue;
    const row: MigrationAgentRow = { agentId: a.id, archived: a.archived };
    try {
      if (a.archived) {
        const items = moveUndelivered(root, a.id, now);
        moved.push(...items);
        row.undelivered = items.length;
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

  // The undelivered report merges by agent + id, so a re-run after a crash never loses items.
  const reportPath = join(root, MAIL_UNDELIVERED_REPORT);
  const prior = readUndeliveredReport(root);
  let undelivered: UndeliveredItem[] = prior?.items ?? [];
  if (moved.length) {
    const key = (i: UndeliveredItem): string => `${i.agentId}|${i.file}`;
    const seen = new Set(undelivered.map(key));
    const fresh = moved.filter((i) => !seen.has(key(i)));
    undelivered = [...undelivered, ...fresh];
    atomicWriteJson(reportPath, {
      version: 1, createdAt: prior?.createdAt ?? now, updatedAt: now,
      // New items are shown again; a report the Human already saw stays seen otherwise.
      seenAt: fresh.length ? null : prior?.seenAt ?? null,
      items: undelivered
    } satisfies UndeliveredReport);
  }

  const report: MigrationReport = { version: 1, at: now, agents: rows, lessons };
  atomicWriteJson(join(root, MAIL_MIGRATION_REPORT), report);
  appendLog({
    kind: 'mail-migration',
    agents: rows.length,
    legacyPending: rows.reduce((n, r) => n + (r.legacyPending ?? 0), 0),
    undelivered: moved.length,
    lessons: lessons.length,
    errors: rows.filter((r) => r.error).length
  });
  // An error leaves the marker unwritten: the next boot re-runs the (idempotent) pass.
  if (!rows.some((r) => r.error)) atomicWriteJson(join(root, MAIL_MIGRATION_MARKER), { version: MAIL_MIGRATION_VERSION, completedAt: now });
  return { ran: true, report, undelivered };
}
