/**
 * WAKE-SCREEN-GUARD (1.1.76), main side: the two pieces of the Codex screen gate that are
 * not the submit owner's own transaction (automaticSubmit.ts holds the gate, the latch and
 * the checks next to each write; shared/codexScreen.ts reads the screen).
 *
 *   1. R2-4, the per-incarnation token. Every Codex PTY gets an unguessable
 *      `MUNDER_WAKE_INCARNATION` in its spawn env; the hive hook shim copies it into each hook
 *      payload. A `SessionStart` carrying the token of the LIVE incarnation of that agent's PTY
 *      is an extra way to latch "past startup". It is never required (a hive spawn has no
 *      first turn, so SessionStart comes late or never: R2-1), and a token from a replaced
 *      incarnation latches nothing.
 *   2. F5, the alert. Each refusal is ordinary; the SAME agent refused by the screen gate for
 *      minutes on end is not. Then it is said once, loudly, with the reason, so a person looks
 *      at the screen. No automatic keystroke is ever the remedy.
 *
 * Pure: no clock, no Electron, no log. The caller supplies `now` and does the announcing.
 */
import { randomBytes } from 'node:crypto';

/** The spawn-env variable the hook shim copies into its payload. */
export const WAKE_INCARNATION_ENV = 'MUNDER_WAKE_INCARNATION';

interface TokenOwner { agentId: string; ptyId: string; incarnation: unknown }

export class WakeIncarnationTokens {
  private readonly byToken = new Map<string, TokenOwner>();

  /** A fresh token for a spawn about to happen. */
  static mint(): string {
    return randomBytes(18).toString('base64url');
  }

  /** The spawn succeeded: the token now names this live incarnation. Any earlier token of the
   *  same PTY is forgotten (its incarnation is gone). */
  register(token: string, agentId: string, ptyId: string, incarnation: unknown): void {
    if (!token || incarnation === undefined) return;
    for (const [t, o] of this.byToken) if (o.ptyId === ptyId) this.byToken.delete(t);
    this.byToken.set(token, { agentId, ptyId, incarnation });
  }

  /** The PTY is gone: its token names nothing any more. */
  forgetPty(ptyId: string): void {
    for (const [t, o] of this.byToken) if (o.ptyId === ptyId) this.byToken.delete(t);
  }

  /**
   * A SessionStart arrived with `token` for `agentId`. The PTY and incarnation it proves, or
   * null: unknown token, another agent's token, or a PTY that is no longer that agent's live
   * incarnation.
   */
  resolve(token: unknown, agentId: string | undefined, live: { ptyForAgent: (a: string) => string | undefined; incarnation: (p: string) => unknown }): { ptyId: string; incarnation: unknown } | null {
    if (typeof token !== 'string' || !token || !agentId) return null;
    const o = this.byToken.get(token);
    if (!o || o.agentId !== agentId) return null;
    if (live.ptyForAgent(agentId) !== o.ptyId || live.incarnation(o.ptyId) !== o.incarnation) return null;
    return { ptyId: o.ptyId, incarnation: o.incarnation };
  }

  get size(): number {
    return this.byToken.size;
  }
}

/** How long one agent must be refused by the screen gate, with no admission between, before
 *  it is an alert. The same as the wake stall watchdog's WAKE_STALL_AFTER_MS. */
export const SCREEN_GUARD_ALERT_MS = 5 * 60_000;

export interface ScreenGuardAlert { agentId: string; reason: string; refusedMs: number; refusals: number }

/**
 * The F5 watch. `note` every screen-gate evaluation; it returns an alert ONCE per refusal run
 * that has lasted SCREEN_GUARD_ALERT_MS. An admission ends the run. The reason in the alert is
 * the latest one (for example `startup:header-loading`, `UNKNOWN:not-the-empty-composer`,
 * `no-reading` when no renderer answers).
 */
export class ScreenGuardAlertWatch {
  private readonly runs = new Map<string, { since: number; refusals: number; alerted: boolean }>();

  constructor(private readonly afterMs: number = SCREEN_GUARD_ALERT_MS) {}

  note(agentId: string, ok: boolean, reason: string, now: number): ScreenGuardAlert | null {
    if (ok) { this.runs.delete(agentId); return null; }
    let run = this.runs.get(agentId);
    if (!run) { run = { since: now, refusals: 0, alerted: false }; this.runs.set(agentId, run); }
    run.refusals += 1;
    if (run.alerted || now - run.since < this.afterMs) return null;
    run.alerted = true;
    return { agentId, reason, refusedMs: now - run.since, refusals: run.refusals };
  }

  /** The agent's PTY went away or was replaced: a new process starts a new run. */
  clear(agentId: string): void {
    this.runs.delete(agentId);
  }
}
