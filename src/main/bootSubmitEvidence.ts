/**
 * GOD-STARTUP-WAITS-ENTER (1.1.80): the provider's own evidence for a BOOT_SEQUENCE prompt.
 *
 * On 2026-10-02 the app typed god's orientation and its Enter 0.57 s after Claude's first
 * output (the terminal-ready rule: output + 400 ms) and 1.5 s BEFORE Claude's SessionStart. The
 * keys waited in the input buffer, Claude read text and Enter as one paste, the Enter became a
 * newline, and the prompt sat unsent until the Human pressed Enter 22.6 s later. The owner then
 * logged COMMITTED: for Claude nothing checked the outcome.
 *
 *   G1  a boot prompt is typed only after this incarnation's SessionStart (+ a settle);
 *   G2  it is COMMITTED only on a UserPromptSubmit of this incarnation at or after the Enter.
 *
 * "This incarnation" = a hook that ARRIVED after the PTY was spawned (the previous process is
 * killed before the spawn). Pure apart from the clock it is handed.
 */

/** G1: quiet time after SessionStart before a boot prompt is typed (the prompt is mounted by
 *  then; G2 covers a slower one). */
export const BOOT_SESSION_SETTLE_MS = 1_000;
/** G1: no SessionStart this long after the spawn (hooks broken or not installed) = the old rule
 *  applies, so a broken hook path cannot cost the agent its orientation; G2 still checks it. */
export const BOOT_SESSION_FALLBACK_MS = 20_000;

export class BootHookClock {
  private readonly at = new Map<string, { sessionStart?: number; promptSubmit?: number }>();

  /** One provider hook for an agent, as it arrived. Only the two boot events are kept. */
  note(agentId: string | undefined, event: string | undefined, now: number): void {
    if (!agentId || (event !== 'SessionStart' && event !== 'UserPromptSubmit')) return;
    const e = this.at.get(agentId) ?? {};
    if (event === 'SessionStart') e.sessionStart = now; else e.promptSubmit = now;
    this.at.set(agentId, e);
  }

  /** G1: may a boot prompt be typed into the agent's PTY spawned at `spawnedAt`? */
  bootReady(agentId: string, spawnedAt: number, now: number, settleMs = BOOT_SESSION_SETTLE_MS, fallbackMs = BOOT_SESSION_FALLBACK_MS): boolean {
    if (spawnedAt <= 0) return false;
    const s = this.at.get(agentId)?.sessionStart;
    if (s !== undefined && s >= spawnedAt) return now - s >= settleMs;
    return now - spawnedAt >= fallbackMs;
  }

  /** G2: did the agent's PTY spawned at `spawnedAt` report a prompt submitted at or after `since`? */
  submittedSince(agentId: string, spawnedAt: number, since: number): boolean {
    const p = this.at.get(agentId)?.promptSubmit;
    return p !== undefined && spawnedAt > 0 && p >= spawnedAt && p >= since;
  }
}
