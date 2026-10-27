/**
 * The derived layer's verdict on each done mail it has processed (CLAIMS-WEAKLINK-DONESHA round 4b, god
 * f7c2bc item 2): `fact` when the mail gave a done-sha claim, `older` when a newer done mail from the same
 * sender on the same card outranked it, else the skip reason (noCommit, ambiguous, ...). `memory get`'s
 * mail rule (G1, Jim 784b65/ac6f85) bridges only the lag before the derived layer reaches a done mail:
 * once the mail has a verdict here its sha is never the current done sha by itself. One JSON object
 * {mailId: status} under the hive's state dir, rewritten whole (merged with what it held) by the backfill
 * and by every live pass; read on demand with an mtime check.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DoneMailResult, MailLike } from './derivedFacts';

export const DONE_MAIL_STATUS_FILE = join('state', 'derived-done-mails.json');

export type DoneMailStatus = 'fact' | 'older' | string;

/** The status of every mail in `mails` after a doneMailFacts run over exactly those mails. */
export function doneMailStatuses(mails: readonly MailLike[], done: DoneMailResult): Record<string, DoneMailStatus> {
  const gave = new Set<string>();
  for (const f of done.facts) for (const r of f.refs) if (r.type === 'msg') gave.add(r.value);
  const skipped = new Map(done.skips.map((s) => [s.mail, s.reason]));
  const out: Record<string, DoneMailStatus> = {};
  for (const m of mails) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    out[m.id] = gave.has(m.id.slice(0, 200)) ? 'fact' : (skipped.get(m.id) ?? 'older');
  }
  return out;
}

function readAll(file: string): Record<string, DoneMailStatus> {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    const out: Record<string, DoneMailStatus> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

/** Merge `statuses` into the hive's record (later verdicts replace earlier ones for the same mail). */
export function writeDoneMailStatus(hiveRoot: string, statuses: Record<string, DoneMailStatus>): void {
  if (!Object.keys(statuses).length) return;
  const file = join(hiveRoot, DONE_MAIL_STATUS_FILE);
  const merged = { ...readAll(file), ...statuses };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged), 'utf8');
  renameSync(tmp, file);
}

/** A lookup over the hive's record, re-read when the file changes; null for a mail the derived layer has not reached. */
export function readDoneMailStatus(hiveRoot: string): (mailId: string) => DoneMailStatus | null {
  const file = join(hiveRoot, DONE_MAIL_STATUS_FILE);
  let sig = '';
  let map: Record<string, DoneMailStatus> = {};
  return (mailId) => {
    let now: string;
    try { const s = statSync(file); now = `${s.mtimeMs}:${s.size}`; } catch { now = 'none'; }
    if (now !== sig) { sig = now; map = now === 'none' ? {} : readAll(file); }
    return Object.prototype.hasOwnProperty.call(map, mailId) ? map[mailId] : null;
  };
}
