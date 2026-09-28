/**
 * Codex capacity, read from the rollout the agent is already writing.
 *
 * WHY THIS SOURCE. Codex stamps its current rate-limit snapshot onto the
 * `token_count` event of every turn, inside the session rollout under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. Reading it costs one tail read
 * of a file the agent wrote anyway: no provider request, no app-server call, no
 * probe traffic, and no credential. The authenticated `account/rateLimits/read` is
 * a better snapshot but it is a real network operation, so it belongs at a reset
 * boundary rather than on a hook.
 *
 * WHAT IT COSTS, AND THE TWO GUARDS THAT KEEP IT SMALL.
 *   - Locating a rollout means walking three levels of dated directories, so the
 *     resolved path is CACHED and only re-resolved at a session boundary, when its
 *     hook session changes, or when the cached file disappears.
 *   - A cached file is `stat`ed and only read when its size grows or its mtime
 *     advances. An unchanged file is not reopened, so an idle agent costs one stat.
 * Only the tail is read. A rollout grows without bound, and the newest snapshot is
 * at the end - though not necessarily within reach; see TAIL_BYTES.
 *
 * This module never reads, resolves or reports credential material. It touches
 * exactly one thing in a Codex home: the session rollout.
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CapacityObservation } from '../shared/providerCapacity';
import { normalizeCodexRateLimits } from './capacityNormalize';
import { codexAccountScope } from './capacityScope';

/**
 * How far back a read reaches. 256 KiB is not a chosen number: it is L0-SEM section
 * 8's own per-read budget ("max 256 KiB appended bytes per read"), and this reader
 * was running four times under its own specification.
 *
 * WHAT IT DOES AND DOES NOT BUY. Measured on a real 26.2 MiB rollout, 64 KiB could
 * not reach the last usable snapshot (~212 KiB from the end) and 256 KiB could, at
 * 0.93 ms per read against a 5 ms p95 budget. But the idle chatter rate on that
 * same file is ~9.5 KiB/min, so 256 KiB reaches back about 27 MINUTES rather than
 * the ~7 that 64 KiB managed. An agent idle longer than that still walks out of
 * range. This closes nothing; it makes the implementation match its own spec for
 * free and moves the failure from routine to frequent.
 *
 * The pathological case is LONG IDLE AFTER ACTIVITY: during active work a snapshot
 * is written every turn and is in the tail anyway, so a high chatter rate is the
 * safe case, not the dangerous one.
 */
const TAIL_BYTES = 256 * 1024;

interface HomeCache {
  file: string | null;
  mtimeMs: number;
  size: number;
}

/** Newest `rollout-*.jsonl` for this session under `<home>/sessions`, by mtime.
 *
 * A hook's session id is the authority here: an agent can have several dated
 * rollouts at once, and picking whichever one was most recently touched can bind
 * a new hook to an older thread. The filename is Codex's stable association.
 */
export function findNewestRollout(codexHome: string, sessionId?: string): string | null {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;
  let newest: { file: string; mtimeMs: number } | null = null;
  // sessions/YYYY/MM/DD/rollout-*.jsonl — a fixed three-level shape, walked
  // explicitly rather than recursively so a stray directory cannot turn this into
  // an unbounded scan of someone's home.
  const dirs = (p: string): string[] => {
    try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { return []; }
  };
  for (const y of dirs(root)) {
    for (const m of dirs(join(root, y))) {
      for (const d of dirs(join(root, y, m))) {
        const dayDir = join(root, y, m, d);
        let names: string[] = [];
        try { names = readdirSync(dayDir); } catch { continue; }
        for (const name of names) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          if (sessionId && !name.endsWith(`-${sessionId}.jsonl`)) continue;
          const file = join(dayDir, name);
          try {
            const st = statSync(file);
            if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
          } catch { /* vanished mid-walk */ }
        }
      }
    }
  }
  return newest?.file ?? null;
}

/** Read the last `TAIL_BYTES` of a file as text, without loading the whole rollout. */
export function readTail(file: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

/**
 * The newest USABLE rate-limit snapshot in a rollout tail.
 *
 * "Newest line with a `rate_limits` key" is NOT the same thing, and the difference
 * is not theoretical: Codex emits TWO limit identities into one stream. `codex`
 * carries real windows; `premium` carries `primary: null, secondary: null` and
 * lands about once a minute. A reader that stops at the newest line holding the KEY
 * therefore stops on an empty snapshot and never sees the good one behind it - and
 * because an empty snapshot legitimately produces no observation, capacity
 * collection goes silent while the file is full of readings.
 *
 * USABILITY IS DECIDED BY THE CALLER'S `accept`, which in practice is the
 * normaliser itself. That is deliberate. A local "looks usable" test would be a
 * second opinion about the same question, and the two would eventually disagree -
 * dropping good lines, or handing back candidates the normaliser then refuses.
 * Asking the normaliser makes the agreement structural instead of maintained.
 *
 * The accepted line keeps ITS OWN embedded timestamp, so an older `codex` snapshot
 * selected past newer empty ones ages out on the normal TTL rather than being
 * passed off as current.
 *
 * The tail is the bound. Scanning stops at the first accepted line, so the ordinary
 * case costs one attempt and the worst case is the handful of snapshots that fit in
 * the tail window.
 */
export function latestUsableRateLimits<T>(
  tail: string,
  accept: (rateLimits: unknown, observedAt: number | null, sequence: number | null) => T | null
): T | null {
  const lines = tail.split('\n');
  // Backwards: the newest snapshot wins, and the first line of a tail is usually a
  // fragment of a longer line, which simply fails to parse and is skipped.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('rate_limits')) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const payload = (typeof rec.payload === 'object' && rec.payload !== null)
      ? rec.payload as Record<string, unknown>
      : null;
    const rateLimits = payload?.rate_limits ?? rec.rate_limits;
    if (!rateLimits) continue;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    // The rollout numbers its own lines. Two events written inside the same
    // whole-second timestamp are indistinguishable without it, and Codex stamps
    // whole seconds - so this is the field that makes equal-time events orderable.
    const ordinal = typeof rec.ordinal === 'number' && Number.isFinite(rec.ordinal) ? rec.ordinal : null;
    const accepted = accept(rateLimits, Number.isFinite(ts) ? ts : null, ordinal);
    // Not usable - an empty `premium` snapshot, or a line whose time cannot be
    // established. Keep walking back rather than reporting nothing at all.
    if (accepted !== null) return accepted;
  }
  return null;
}

/**
 * MODEL-PINBACK G2: the model of the newest `turn_context` in a rollout tail, with its own
 * timestamp. Codex writes one `turn_context` per turn carrying the model that turn runs, so after
 * an in-TUI `/model` the next turn's line names the new model. Null when the tail holds none.
 */
export function latestTurnContextModel(tail: string): { model: string; observedAt: number | null } | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('turn_context')) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    if (rec.type !== 'turn_context') continue;
    const payload = (typeof rec.payload === 'object' && rec.payload !== null) ? rec.payload as Record<string, unknown> : null;
    const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
    if (!model) continue;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    return { model, observedAt: Number.isFinite(ts) ? ts : null };
  }
  return null;
}

/** One rollout read: the capacity observation and the thread's live model, from ONE tail. */
export interface CodexRolloutRead {
  capacity: CapacityObservation | null;
  /** The newest turn_context's model, when the tail was read (the file changed) and held one. */
  turnModel: { model: string; observedAt: number | null } | null;
}

/**
 * Stateful reader over a set of Codex homes. One instance lives in main; the state
 * it holds is only the per-home cache described at the top of the file.
 */
export class CodexRolloutCapacitySource {
  private cache = new Map<string, HomeCache>();

  constructor(private readonly scopeOf: (home: string) => string = codexAccountScope) {}

  /**
   * Observe one Codex home. Returns null when there is nothing NEW to report —
   * which is the common case and is deliberately cheap.
   *
   * `rescan` forces re-resolution. A session id is stronger still: a cached file
   * for another session is always replaced with the matching rollout.
   */
  observe(codexHome: string, opts: { rescan?: boolean; sessionId?: string; now?: number } = {}): CapacityObservation | null {
    return this.observeRollout(codexHome, opts).capacity;
  }

  /** `observe`, plus the live model from the SAME tail read (MODEL-PINBACK G2). Nothing new
   *  (an unchanged file) is `{ capacity: null, turnModel: null }`. */
  observeRollout(codexHome: string, opts: { rescan?: boolean; sessionId?: string; now?: number } = {}): CodexRolloutRead {
    const none: CodexRolloutRead = { capacity: null, turnModel: null };
    const now = opts.now ?? Date.now();
    let entry = this.cache.get(codexHome);
    const cachedSessionMatches = !opts.sessionId || (entry?.file !== null && entry?.file !== undefined
      && basename(entry.file).endsWith(`-${opts.sessionId}.jsonl`));
    if (!entry || opts.rescan || !entry.file || !existsSync(entry.file) || !cachedSessionMatches) {
      const file = findNewestRollout(codexHome, opts.sessionId);
      entry = { file, mtimeMs: 0, size: 0 };
      this.cache.set(codexHome, entry);
    }
    if (!entry.file) return none;

    let mtimeMs: number;
    let size: number;
    try {
      const stat = statSync(entry.file);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch { entry.file = null; return none; }
    // Windows can hold an open rollout's mtime at creation while it grows. Either
    // a size increase OR an mtime advance makes the tail worth reading; an idle
    // agent still pays just this one stat per hook boundary.
    if (size <= entry.size && mtimeMs <= entry.mtimeMs) return none;
    entry.mtimeMs = mtimeMs;
    entry.size = size;

    const scope = this.scopeOf(codexHome);
    const tail = readTail(entry.file);
    const file = entry.file;
    const capacity = latestUsableRateLimits(tail, (rateLimits, observedAt, sequence) => normalizeCodexRateLimits({
      rateLimits,
      accountScope: scope,
      // The FILE is the stream: `ordinal` restarts at zero in each new session
      // file, so an ordinal only orders events within the file it came from.
      streamId: `codex-rollout:${file}`,
      sourceSequence: sequence,
      // The event's own timestamp, not now: a rollout copy is authoritative at the
      // time it was written, and the tracker orders readings by that. An older
      // `codex` line selected past newer empty ones therefore ages out on the normal
      // TTL instead of being passed off as current.
      observedAt,
      receivedAt: now,
      source: 'codex-rollout'
    }));
    return { capacity, turnModel: latestTurnContextModel(tail) };
  }

  /** Drop a home's cache — used when an agent is removed. */
  forget(codexHome: string): void {
    this.cache.delete(codexHome);
  }
}
