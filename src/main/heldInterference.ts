/**
 * DWIGHT-HELD-INTERFERED-2028 (1.1.78): an automatic wake held INTERFERED used to be a dead end.
 * The submit owner holds it "until a person rules", the only ruling control is inside that one
 * agent's message box, and nothing alerted anyone (Dwight, 2026-10-01 20:28Z: two messages were
 * stuck for over an hour; Jim's DWIGHT-HELD-INTERFERED.md).
 *
 * This watch is main's side of fixes 1 and 2, for HELD WAKE CLAIMS only (a person's queued
 * message is never re-examined here):
 *   fix 1  about once a minute, the owner takes a fresh look (`recheckHeld`): positive evidence
 *          that the prompt is clean releases the hold as "let it retry" (`interference-self-released`);
 *          our own text on the prompt row lets the verified erase run; anything else stays held.
 *   fix 2  a hold that lasts HELD_NOTICE_AFTER_MS raises a plain-words notice for the Human (the
 *          `hive:integrity` banner, dismissible like the screen-guard notice) and is listed for
 *          god's floor digest as a decision; both go the moment the hold does, however it ends
 *          (released here, by a person, by a respawn, or the ids leaving the inbox).
 *
 * The decisions are the owner's (automaticSubmit.ts); this class only schedules and reports.
 *
 * CODEX-MODEL-SWITCH-PROMPT P2 (1.1.79): when the latest look saw a Codex popup (the owner's
 * `MODAL:codex-popup:<text>`), the notice names it, and is worded again when that changes.
 */
import type { HeldRecheck } from './automaticSubmit';
import { popupInReason } from '../shared/codexScreen';

/** How often a held wake is looked at again. */
export const HELD_RECHECK_MS = 60_000;
/** How long a wake is held before the Human is told (the same as the wake stall watchdog's). */
export const HELD_NOTICE_AFTER_MS = 5 * 60_000;
/** How often main ticks the watch (the recheck cadence above is per hold). */
export const HELD_TICK_MS = 15_000;

/** One held wake: the coordinator's claim, and the owner's hold for the same request. */
export interface HeldWake {
  agentId: string;
  requestId: string;
  ptyId: string;
  /** How many messages the claim carries. */
  messages: number;
  /** When the owner's hold began. */
  since: number;
  /** The owner's interference reason. */
  reason: string;
}

export type HeldRelease = Extract<HeldRecheck, { kind: 'RELEASED' | 'ERASED' }>;

export interface HeldInterferenceDeps {
  /** Every wake claim the coordinator holds INTERFERED whose owner hold is that same request. */
  heldWakes(): HeldWake[];
  /** The owner's fresh look (`AutomaticSubmitOwner.recheckHeld`). */
  recheck(h: HeldWake): Promise<HeldRecheck>;
  /** The owner released it: end the coordinator's hold as "let it retry" (SEND_AGAIN). */
  released(h: HeldWake, r: HeldRelease, now: number): void;
  /** `asking`: the Codex popup the latest look saw, or null (P2). */
  notice: { raise(h: HeldWake, now: number, asking: string | null): void; clear(agentId: string): void };
  log(row: Record<string, unknown>): void;
  now(): number;
}

export class HeldInterferenceWatch {
  private readonly lastCheck = new Map<string, number>();
  private readonly lastWhy = new Map<string, string>();
  /** P2: per hold, the Codex popup its latest look saw. */
  private readonly asking = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  /** agentId -> the request its notice was raised for. */
  private readonly raised = new Map<string, string>();
  private current: HeldWake[] = [];

  constructor(
    private readonly deps: HeldInterferenceDeps,
    private readonly recheckMs: number = HELD_RECHECK_MS,
    private readonly noticeAfterMs: number = HELD_NOTICE_AFTER_MS
  ) {}

  tick(now: number = this.deps.now()): void {
    let holds: HeldWake[];
    try { holds = this.deps.heldWakes(); } catch { holds = []; }
    this.current = holds;
    const keys = new Set(holds.map(keyOf));
    // A hold that ended any other way (a person, a respawn, the ids gone): its notice goes too.
    for (const [agentId, requestId] of [...this.raised]) {
      if (!keys.has(`${agentId}|${requestId}`)) this.lift(agentId);
    }
    for (const k of [...this.lastCheck.keys()]) if (!keys.has(k)) { this.lastCheck.delete(k); this.lastWhy.delete(k); this.asking.delete(k); }
    for (const h of holds) {
      const key = keyOf(h);
      if (now - h.since >= this.noticeAfterMs && this.raised.get(h.agentId) !== h.requestId) {
        this.raised.set(h.agentId, h.requestId);
        try { this.deps.notice.raise(h, now, this.asking.get(key) ?? null); } catch { /* the notice is diagnostics; it never decides */ }
      }
      if (this.inFlight.has(key) || now - (this.lastCheck.get(key) ?? h.since) < this.recheckMs) continue;
      this.lastCheck.set(key, now);
      this.inFlight.add(key);
      let p: Promise<HeldRecheck>;
      try { p = this.deps.recheck(h); } catch (e) { p = Promise.resolve({ kind: 'HELD', why: `threw: ${String(e)}`, screen: null }); }
      void Promise.resolve(p).then((r) => this.settle(h, key, r), (e) => this.settle(h, key, { kind: 'HELD', why: `threw: ${String(e)}`, screen: null }));
    }
  }

  /** The holds the Human has been told about, for the floor digest's decisions. */
  noticed(): HeldWake[] {
    return this.current.filter((h) => this.raised.get(h.agentId) === h.requestId);
  }

  private settle(h: HeldWake, key: string, r: HeldRecheck): void {
    this.inFlight.delete(key);
    const now = this.deps.now();
    if (r.kind === 'RELEASED' || r.kind === 'ERASED') {
      this.lastCheck.delete(key);
      this.lastWhy.delete(key);
      this.asking.delete(key);
      this.lift(h.agentId);
      try { this.deps.released(h, r, now); } catch { /* reported by the caller */ }
      return;
    }
    if (r.kind === 'HELD' && this.lastWhy.get(key) !== r.why) {
      // One row per change of reason, not one a minute.
      this.lastWhy.set(key, r.why);
      try { this.deps.log({ kind: 'held-interfered-recheck', agentId: h.agentId, requestId: h.requestId, why: r.why, heldMs: now - h.since, ...(r.screen ? { screen: r.screen } : {}) }); } catch { /* logging only */ }
    }
    if (r.kind === 'HELD') {
      // P2: a popup seen (or gone) changes what the Human is told; a raised notice is worded again.
      const popup = popupInReason(r.why);
      if (popup === (this.asking.get(key) ?? null)) return;
      if (popup) this.asking.set(key, popup); else this.asking.delete(key);
      if (this.raised.get(h.agentId) === h.requestId) {
        try { this.deps.notice.raise(h, now, popup); } catch { /* the notice is diagnostics; it never decides */ }
      }
    }
  }

  private lift(agentId: string): void {
    if (!this.raised.delete(agentId)) return;
    try { this.deps.notice.clear(agentId); } catch { /* diagnostics */ }
  }
}

const keyOf = (h: { agentId: string; requestId: string }): string => `${h.agentId}|${h.requestId}`;
