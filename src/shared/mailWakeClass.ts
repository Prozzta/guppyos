/**
 * READS-QUIET-NOREPLY (1.1.81): which delivered mail may wait for the agent's next real turn
 * instead of starting one.
 *
 * Every wake re-sends the agent's whole conversation (god: up to ~290k per turn), and on
 * 2026-10-02 176 of 348 mail wakes carried only FYI mail (quiet-time on/off, status relays).
 * For an `inject` agent (Claude, Codex, AGY) the mail BODIES never ride the wake: the hooks
 * surface every delivered id on the next UserPromptSubmit / PostToolUse, woken for or not. So a
 * quiet message only has to stay out of the wake coordinator's pending set; it reaches the agent
 * on its next real turn, or after QUIET_MAIL_HOLD_MIN_DEFAULT minutes at most, when the whole
 * held batch is released as one ordinary wake.
 *
 * QUIET = ALL of:
 *   - the recipient's mail mode is `inject` (the others read mail BECAUSE of the wake prompt);
 *   - act `inform` or `agree` (done is how results come back: it always wakes, god c95516);
 *   - no reply required;
 *   - a sender that is not the Human, the breaker, the floor digest or a harness sender;
 *   - the sender did not ask for `"wake": "now"`.
 * Everything else wakes exactly as before. Pure: no clock, no I/O.
 */

export const QUIET_MAIL_HOLD_MIN_DEFAULT = 30;

/** The acts that may be held. */
export const QUIET_ACTS: ReadonlySet<string> = new Set(['inform', 'agree']);

/** Senders whose mail always wakes: the Human, Floor decisions, the circuit breaker, webhooks,
 *  and every harness sender (mailReaders SYSTEM_SENDERS). */
export const ALWAYS_WAKE_SENDERS: ReadonlySet<string> = new Set([
  'human', 'digest', 'breaker', 'webhook', 'system', 'heartbeat', 'scheduler'
]);

/** The ledger fields the class reads (MailEntry has them all). */
export interface MailWakeFacts {
  id: string;
  from: string;
  act?: string;
  requiresReply: boolean;
  /** The sender asked for `"wake": "now"`. */
  wakeNow?: boolean;
  deliveredAt: number;
}

export type MailWakeClass = 'wake' | 'quiet';

export function mailWakeClass(e: MailWakeFacts, mailMode: string): MailWakeClass {
  if (mailMode !== 'inject') return 'wake';
  if (!QUIET_ACTS.has(String(e.act ?? ''))) return 'wake';
  if (e.requiresReply) return 'wake';
  if (ALWAYS_WAKE_SENDERS.has(e.from)) return 'wake';
  if (e.wakeNow === true) return 'wake';
  return 'quiet';
}

/** The config value (minutes) as milliseconds: a finite number >= 0, else the default; 0 = off. */
export function quietMailHoldMs(configMin: unknown): number {
  const n = typeof configMin === 'number' && Number.isFinite(configMin) && configMin >= 0 ? configMin : QUIET_MAIL_HOLD_MIN_DEFAULT;
  return Math.round(n * 60_000);
}

/**
 * The quiet ids among `entries` that may still wait at `now`, each with the time its hold ends
 * (deliveredAt + holdMs, so a restart never extends it). An id past its hold, or any id when the
 * hold is off, is absent: it wakes.
 */
export function quietHolds(entries: readonly MailWakeFacts[], mailMode: string, holdMs: number, now: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!(holdMs > 0)) return out;
  for (const e of entries) {
    if (mailWakeClass(e, mailMode) !== 'quiet') continue;
    const until = e.deliveredAt + holdMs;
    if (until > now) out.set(e.id, until);
  }
  return out;
}

/** A sender's `wake` field: only the exact string "now" counts. */
export function normalizeWakeField(v: unknown): { wake?: 'now' } {
  return v === 'now' ? { wake: 'now' } : {};
}
