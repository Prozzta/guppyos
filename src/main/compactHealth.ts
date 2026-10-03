/**
 * READS-ROTATE-AT-SIZE pilot (1.1.81): one `compact-health` log row per compaction, so
 * READS-COMPACT-HEALTH and reads-measure can judge the pilot. A SessionStart(compact) marks the
 * agent; at its next Stop the transcript tail is read once, and EVERY compaction not logged yet
 * (Claude's own compact_boundary: trigger, context before and after, duration; one turn can hold
 * several) is logged with the first request after it (its context and what it cost). Logged once
 * per boundary; a tail whose last boundary has no request after it yet is retried at the next
 * Stop, at most COMPACT_HEALTH_TRIES times.
 *
 * Probed on Claude Code 2.1.288 (CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000, Haiku): PreCompact(auto),
 * SessionStart(compact), PostCompact(auto) per compaction, three inside one turn, each at ~75k
 * (Claude keeps a margin below the window), trigger "auto" (t12/probe181/probe-compact.cjs).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { compactHealthsFromTail } from '../shared/autoCompactWindow';

export const COMPACT_TAIL_BYTES = 1024 * 1024;
export const COMPACT_HEALTH_TRIES = 3;

/** The last `bytes` of a file as text, or null. */
export function readTail(file: string, bytes = COMPACT_TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

export class CompactHealthWatch {
  private readonly pending = new Map<string, { path: string; tries: number }>();
  private readonly logged = new Map<string, Set<string>>();

  constructor(private readonly d: {
    log: (row: Record<string, unknown>) => void;
    readTail?: (file: string) => string | null;
    /** The agent's configured window (tokens), when the pilot set one. */
    windowOf?: (agentId: string) => number | null;
  }) {}

  /** SessionStart with source "compact". */
  noteCompact(agentId: string, transcriptPath: string | null | undefined): void {
    if (!transcriptPath) return;
    this.pending.set(agentId, { path: transcriptPath, tries: 0 });
  }

  /** A Stop of the agent: log every compaction not logged yet (one turn can hold several), once
   *  the request after the LAST of them is in the transcript (or after COMPACT_HEALTH_TRIES). */
  onStop(agentId: string): void {
    const p = this.pending.get(agentId);
    if (!p) return;
    p.tries += 1;
    const tail = (this.d.readTail ?? readTail)(p.path);
    const all = tail ? compactHealthsFromTail(tail) : [];
    const last = all[all.length - 1];
    if (!last || (!last.first && p.tries < COMPACT_HEALTH_TRIES)) {
      if (p.tries >= COMPACT_HEALTH_TRIES) this.pending.delete(agentId);
      return;
    }
    this.pending.delete(agentId);
    const seen = this.logged.get(agentId) ?? new Set<string>();
    let window: number | null = null;
    try { window = this.d.windowOf?.(agentId) ?? null; } catch { window = null; }
    for (const h of all) {
      if (seen.has(h.uuid)) continue;
      seen.add(h.uuid);
      try {
        this.d.log({
          kind: 'compact-health', agentId, trigger: h.trigger, window, at: h.at,
          preTokens: h.preTokens, postTokens: h.postTokens, durationMs: h.durationMs,
          firstRequest: h.first
        });
      } catch { /* best effort */ }
    }
    // Bounded: only recent boundaries can reappear in a tail.
    while (seen.size > 50) seen.delete(seen.values().next().value as string);
    this.logged.set(agentId, seen);
  }
}
