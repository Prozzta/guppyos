/**
 * CODEX-BLOAT-165 fix 1: a Codex agent's thread is ROTATED, not resumed forever.
 *
 * Every restore, revive and restart used to run `codex resume <registry.sessionId>`, so one
 * agent lived on one thread for its whole life (Dwight: 132.7 MB, 595 turns, 32 compactions).
 * Codex's remote compaction keeps every user turn, so each compaction restarted at ~87K tokens
 * where a fresh thread starts at ~14K (CODEX-BLOAT-WHY.md, section 1).
 *
 * The policy: an automatic resume (app restart, auto-revive) starts a FRESH thread when the
 * recorded thread
 *   - started before today's LOCAL midnight ("one thread per day"), or
 *   - has a rollout file larger than CODEX_ROTATE_MAX_ROLLOUT_BYTES.
 * Identity survives: it is the agent's developer_instructions (regenerated every spawn) plus its
 * memory and inbox, not the thread. A session id the user TYPED, and "Restart & Continue"
 * (requireResume), still resume: the human asked for that thread.
 *
 * Pure decisions plus two bounded filesystem reads (a directory walk and a stat). Electron-free.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A rollout above this is rotated. Dwight's first day was ~15 MB; his thread reached 132 MB. */
export const CODEX_ROTATE_MAX_ROLLOUT_BYTES = 20 * 1024 * 1024;
/** Antigravity's per-conversation SQLite db, same rule (Phyllis: 9.1 MB then 22 MB). */
export const AGY_ROTATE_MAX_DB_BYTES = 20 * 1024 * 1024;

export type ThreadRotationReason = 'day-boundary' | 'size';

export interface ThreadFileInfo {
  path: string;
  bytes: number;
  /** When the thread started (ms since epoch). */
  startedAt: number;
}

export interface ThreadRotationDecision {
  rotate: boolean;
  reason: ThreadRotationReason | null;
  bytes: number;
  ageMs: number;
}

/** Local midnight at the start of the day that contains `now`. */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The thread's start from a Codex rollout file name, `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`.
 * Codex writes that stamp in LOCAL time (seen: file `T21-45-10`, first event `19:45Z`, UTC+2).
 */
export function rolloutStartFromName(name: string): number | null {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Rotate, or keep resuming? Size first (it is the stronger signal), then the day boundary. */
export function decideThreadRotation(
  info: ThreadFileInfo,
  now: number,
  maxBytes: number = CODEX_ROTATE_MAX_ROLLOUT_BYTES
): ThreadRotationDecision {
  const ageMs = Math.max(0, now - info.startedAt);
  const base = { bytes: info.bytes, ageMs };
  if (info.bytes > maxBytes) return { rotate: true, reason: 'size', ...base };
  if (info.startedAt < localDayStart(now)) return { rotate: true, reason: 'day-boundary', ...base };
  return { rotate: false, reason: null, ...base };
}

/** The rollout for `sessionId` under `<codexHome>/sessions` (walked; bounded depth), or null. */
export function findCodexRollout(codexHome: string, sessionId: string): ThreadFileInfo | null {
  if (!codexHome || !sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: join(codexHome, 'sessions'), depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    let ents: import('node:fs').Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) stack.push({ dir: p, depth: depth + 1 }); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl') || !e.name.includes(sessionId)) continue;
      try {
        const st = statSync(p);
        const startedAt = rolloutStartFromName(e.name) ?? (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
        return { path: p, bytes: st.size, startedAt };
      } catch { return null; }
    }
  }
  return null;
}

/** An Antigravity conversation db, `<geminiHome>/antigravity-cli/conversations/<id>.db`, or null.
 *  AGY stores no start stamp in the name, so the file's birth time stands in for it. */
export function findAgyConversation(geminiHome: string, conversationId: string): ThreadFileInfo | null {
  if (!geminiHome || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(conversationId || '')) return null;
  const p = join(geminiHome, 'antigravity-cli', 'conversations', `${conversationId}.db`);
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    return { path: p, bytes: st.size, startedAt: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs };
  } catch { return null; }
}

/** The hive log row: `codex-thread-rotated` for Codex, `<provider>-thread-rotated` otherwise. */
export function threadRotatedLogRow(
  agentId: string, provider: string, oldSessionId: string, d: ThreadRotationDecision
): Record<string, unknown> {
  return {
    kind: `${provider}-thread-rotated`,
    agentId,
    provider,
    oldSessionId,
    reason: d.reason,
    bytes: d.bytes,
    ageHours: Math.round((d.ageMs / 3_600_000) * 10) / 10
  };
}
