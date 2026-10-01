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

/** WSG-CODEX-STARTUP-NO-MARKER: quiet time after an output burst before the startup reading
 *  (the header box is drawn by then; a reading mid-burst would just be taken again). */
export const STARTUP_PROBE_SETTLE_MS = 400;

export interface StartupProbeDeps {
  /** The screen gate applies to this PTY and its live incarnation is not latched yet. */
  wanted: (ptyId: string) => boolean;
  /** Take one startup reading (it can only add the latch). */
  probe: (ptyId: string) => Promise<unknown>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * WSG-CODEX-STARTUP-NO-MARKER fix 1(a), the scheduler: every output chunk of an un-latched
 * Codex PTY (re)arms one settle timer; when the PTY has been quiet for STARTUP_PROBE_SETTLE_MS a
 * reading is taken. So the header is read right after spawn (the first burst draws it), and
 * again after each later burst until a reading or a turn latches the incarnation. A latched
 * PTY costs one Map lookup per chunk. At most one reading per PTY is in flight.
 */
export class StartupProbe {
  private readonly timers = new Map<string, unknown>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: StartupProbeDeps, private readonly settleMs: number = STARTUP_PROBE_SETTLE_MS) {}

  output(ptyId: string): void {
    let wanted = false;
    try { wanted = this.deps.wanted(ptyId); } catch { wanted = false; }
    if (!wanted) { this.cancel(ptyId); return; }
    const prev = this.timers.get(ptyId);
    if (prev !== undefined) this.deps.clearTimer(prev);
    this.timers.set(ptyId, this.deps.setTimer(() => this.fire(ptyId), this.settleMs));
  }

  /** The PTY went away or was replaced. */
  cancel(ptyId: string): void {
    const t = this.timers.get(ptyId);
    if (t !== undefined) { this.deps.clearTimer(t); this.timers.delete(ptyId); }
  }

  get pending(): number {
    return this.timers.size;
  }

  private fire(ptyId: string): void {
    this.timers.delete(ptyId);
    if (this.inFlight.has(ptyId)) return;
    let wanted = false;
    try { wanted = this.deps.wanted(ptyId); } catch { wanted = false; }
    if (!wanted) return;
    this.inFlight.add(ptyId);
    let p: Promise<unknown>;
    try { p = this.deps.probe(ptyId); } catch { this.inFlight.delete(ptyId); return; }
    Promise.resolve(p).catch(() => undefined).then(() => { this.inFlight.delete(ptyId); });
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

/** How long the latest automatic refusal stands as "the screen check is holding this agent"
 *  without a newer one (the drain asks every few seconds while anything is queued). */
export const SCREEN_HOLD_FRESH_MS = 60_000;

/** What the composer is told about a screen-check hold (main computes it; the renderer words it). */
export interface ScreenHoldView {
  /** The gate's reason, for example `startup:no-marker` or `UNKNOWN:not-the-empty-composer`. */
  reason: string;
  /** Would a person's "send now" (USER_RELEASED) pass where automatic delivery does not?
   *  Only for `startup:no-marker` (see AutomaticSubmitOwner.screenGate, fix 3). */
  sendNowPasses: boolean;
}

/** Where the alert goes: the mail ledger's `hive:integrity` notice. */
export interface ScreenGuardNoticeSink {
  raise(alert: ScreenGuardAlert): void;
  clear(agentId: string): void;
}

/**
 * WSG-ALERT-NOT-DISMISSABLE: the alert's whole lifecycle, in one place. Raised once per refusal
 * run of automatic deliveries that lasts SCREEN_GUARD_ALERT_MS (the F5 watch); LIFTED the
 * moment the hold is: the first `ok` reading for the agent, a condition-1 latch of its live
 * incarnation (a startup reading or its own turn), or a respawn. Before 1.1.78 only a respawn
 * cleared it, so the notice outlived the hold. Lifting also ends the run, so a hold that comes
 * back later is a new run and alerts again.
 */
export class ScreenGuardNotices {
  private readonly watch: ScreenGuardAlertWatch;
  private readonly lastRefusal = new Map<string, { reason: string; at: number }>();

  constructor(private readonly sink: ScreenGuardNoticeSink, afterMs: number = SCREEN_GUARD_ALERT_MS) {
    this.watch = new ScreenGuardAlertWatch(afterMs);
  }

  /** Every screen-gate evaluation. Only automatic starts (`automatic`, CAPACITY_GATED) are
   *  waited on and alerted; an admission of any class lifts the hold. */
  reading(agentId: string, ok: boolean, reason: string, automatic: boolean, now: number): ScreenGuardAlert | null {
    if (ok) { this.lift(agentId); return null; }
    if (!automatic) return null;
    this.lastRefusal.set(agentId, { reason, at: now });
    const alert = this.watch.note(agentId, false, reason, now);
    if (alert) this.sink.raise(alert);
    return alert;
  }

  /** Condition 1 latched for the agent's live incarnation. */
  latched(agentId: string): void {
    this.lift(agentId);
  }

  /** A new process for the agent (Jim N3: it gets a new run, and a new banner if refused). */
  respawned(agentId: string): void {
    this.lift(agentId);
  }

  /** The screen-check hold on this agent's automatic deliveries now, or null. */
  hold(agentId: string, now: number): ScreenHoldView | null {
    const r = this.lastRefusal.get(agentId);
    if (!r || now - r.at > SCREEN_HOLD_FRESH_MS) return null;
    return { reason: r.reason, sendNowPasses: r.reason === 'startup:no-marker' };
  }

  private lift(agentId: string): void {
    this.watch.clear(agentId);
    this.lastRefusal.delete(agentId);
    try { this.sink.clear(agentId); } catch { /* the notice is diagnostics; it never decides */ }
  }
}
