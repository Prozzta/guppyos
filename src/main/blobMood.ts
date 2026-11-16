/**
 * BLOB-ORCH-MOOD: the one main-process mood source. The Blob reflects the orchestrator (god):
 * its liveness, the floor's circuit breaker, open ASK ME entries and cards reaching done.
 * The overlay (setMood), the tray icon and the toasts all read this one value.
 *
 * Priority, highest first (god-approved 2026-11-12):
 *   sad      god CRASHED, STUCK_WAKE, or EXITED without being asked to
 *   sick     any agent's breaker is steering, constrained or stopped
 *   happy    a 6 s burst after a card reaches done (dones inside a burst do not extend it)
 *   waiting  a not-done card has an open ASK ME (humanQA) entry
 *   working  god is BUSY_PROGRESSING
 *   sleepy   god has been IDLE for 30 min or more
 *   idle     otherwise
 * The shown mood changes at most once every 2 s (hysteresis) so the tray does not thrash.
 */
import type { BlobMood } from '../shared/blob';

export interface GodLivenessFacts {
  classification: string;
  classifiedSince: number;
  reason?: string;
  lifecycle?: string;
}

export interface MoodInputs {
  /** God's liveness record, or null when there is no god or no record yet. */
  god: GodLivenessFacts | null;
  /** The breaker level of every agent ('healthy' | 'steering' | 'constrained' | 'stopped'). */
  breakerLevels: readonly string[];
  /** Not-done cards with an open humanQA entry. */
  openAsks: number;
}

export const MOOD_HOLD_MS = 2_000;
export const MOOD_HAPPY_MS = 6_000;
export const MOOD_SLEEPY_MS = 30 * 60_000;

export function deriveMood(i: MoodInputs, now: number, happyUntil: number, sleepyMs = MOOD_SLEEPY_MS): BlobMood {
  const g = i.god;
  const gone = !!g && (g.lifecycle === 'DELETED' || g.lifecycle === 'ARCHIVED');
  if (g && !gone) {
    if (g.classification === 'CRASHED' || g.classification === 'STUCK_WAKE') return 'sad';
    if (g.classification === 'EXITED' && g.reason !== 'pty-exit-requested') return 'sad';
  }
  if (i.breakerLevels.some((l) => l === 'steering' || l === 'constrained' || l === 'stopped')) return 'sick';
  if (now < happyUntil) return 'happy';
  if (i.openAsks > 0) return 'waiting';
  if (g && !gone) {
    if (g.classification === 'BUSY_PROGRESSING') return 'working';
    if (g.classification === 'IDLE' && now - g.classifiedSince >= sleepyMs) return 'sleepy';
  }
  return 'idle';
}

export interface MoodTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: MoodTimers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface OrchestratorMoodDeps {
  read(): MoodInputs;
  now(): number;
  timers?: MoodTimers;
  holdMs?: number;
  happyMs?: number;
  sleepyMs?: number;
  log?(row: Record<string, unknown>): void;
}

export class OrchestratorMood {
  private current: BlobMood = 'idle';
  private changedAt = Number.NEGATIVE_INFINITY;
  private happyUntil = 0;
  private retry: unknown = null;
  private readonly listeners = new Set<(m: BlobMood) => void>();
  private readonly timers: MoodTimers;

  constructor(private readonly d: OrchestratorMoodDeps) { this.timers = d.timers ?? realTimers; }

  mood(): BlobMood { return this.current; }

  onChange(cb: (m: BlobMood) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** A card reached done: one happy burst. Further dones inside the burst do not extend it. */
  noteCardDone(): void {
    const now = this.d.now();
    if (now < this.happyUntil) return;
    this.happyUntil = now + (this.d.happyMs ?? MOOD_HAPPY_MS);
    this.tick();
    // Re-evaluate when the burst ends, so happy does not outlive it until the next beat.
    this.schedule(this.happyUntil - now);
  }

  /** Recompute from fresh inputs; returns the shown mood (which may lag the wanted one by the hold). */
  tick(): BlobMood {
    const now = this.d.now();
    let inputs: MoodInputs;
    try { inputs = this.d.read(); } catch (e) {
      this.d.log?.({ kind: 'blob-mood-read-failed', error: e instanceof Error ? e.message : String(e) });
      return this.current;
    }
    const want = deriveMood(inputs, now, this.happyUntil, this.d.sleepyMs);
    if (want === this.current) return this.current;
    const hold = this.d.holdMs ?? MOOD_HOLD_MS;
    const wait = this.changedAt + hold - now;
    if (wait > 0) { this.schedule(wait); return this.current; }
    this.current = want;
    this.changedAt = now;
    for (const cb of this.listeners) {
      try { cb(want); } catch (e) { this.d.log?.({ kind: 'blob-mood-listener-failed', error: e instanceof Error ? e.message : String(e) }); }
    }
    return this.current;
  }

  dispose(): void {
    if (this.retry !== null) { this.timers.clear(this.retry); this.retry = null; }
    this.listeners.clear();
  }

  private schedule(ms: number): void {
    if (this.retry !== null) this.timers.clear(this.retry);
    this.retry = this.timers.set(() => { this.retry = null; this.tick(); }, Math.max(0, ms));
  }
}

/** Ids of cards that are done now but were not in `prev` (the first call seeds and reports none). */
export function newlyDone(prev: Set<string> | null, tasks: readonly unknown[]): { done: Set<string>; fresh: number } {
  const done = new Set<string>();
  for (const t of tasks) {
    const c = t as { id?: unknown; status?: unknown } | null;
    if (c && typeof c.id === 'string' && c.status === 'done') done.add(c.id);
  }
  if (!prev) return { done, fresh: 0 };
  let fresh = 0;
  for (const id of done) if (!prev.has(id)) fresh += 1;
  return { done, fresh };
}

/** Not-done cards with an open humanQA entry (the same test as ASK ME). */
export function countOpenAsks(tasks: readonly unknown[]): number {
  let n = 0;
  for (const t of tasks) {
    const c = t as { status?: unknown; humanQA?: unknown } | null;
    if (!c || c.status === 'done' || !Array.isArray(c.humanQA)) continue;
    if (c.humanQA.some((q: { q?: unknown; a?: unknown; dismissedAt?: unknown } | null) => !!q && typeof q.q === 'string' && !q.a && !q.dismissedAt)) n += 1;
  }
  return n;
}
