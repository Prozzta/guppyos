/**
 * THE INBOX-WAKE STALL WATCHDOG.
 *
 * The 1.1.46 packaged failure was not that a wake went wrong. It was that it went wrong
 * SILENTLY, for fifteen minutes, on a floor whose whole job is to keep moving. Every guard
 * in `claim()` is fail-closed, and every individual refusal is ordinary and expected — an
 * agent mid-turn, inside boot grace, on cooldown. No single refusal means anything.
 *
 * What DOES mean something is the same refusal, with the same reason, for an agent that has
 * undrained mail, for minutes on end. That is not a hold, it is a deadlock.
 *
 * This decides when to say so. It cannot fix a bad guard — nothing here can — but it turns
 * the entire class of "main refuses forever and the floor quietly dies" from invisible into
 * a named, durable row that points at the guard responsible. For this bug, and the next one.
 *
 * Pure: no clock, no log, no Electron. The caller supplies `now` and does the announcing.
 */

/** How long one unchanging refusal, with mail waiting, has to hold before it is a stall. */
export const WAKE_STALL_AFTER_MS = 5 * 60_000;

/**
 * Refusal reasons that are a DELIBERATE state rather than a stall. A paused, halted or
 * auto-delivery-paused agent is refusing because a human said so; a HITL prompt is likewise
 * explicitly waiting on a human answer. An INTERFERED hold is different: it may be a stale
 * automatic draft (as in WAKE-SELF-TEXT-HOLD), so pending mail must become an audible stall
 * rather than disappearing behind a silent hold.
 */
const DELIBERATE = new Set([
  'no-pending-ids', 'paused', 'halted', 'auto-delivery-paused', 'hitl-hold',
  // READS-QUIET-NOREPLY (1.1.81): only quiet mail waits, inside its bounded hold (the claim
  // releases it when the hold ends): a decision, not a deadlock.
  'quiet-held'
]);

/** What the caller should do about this refusal. */
export interface WakeStall {
  agentId: string;
  why: string;
  inboxIds: number;
  stalledMs: number;
}

export class WakeStallWatch {
  private readonly watching = new Map<string, { why: string; since: number; announced: boolean; inboxIds: number }>();

  /**
   * Fold one refusal in. Returns a stall to announce EXACTLY ONCE per unbroken run of the
   * same reason — a stalled floor must not also flood its own log.
   */
  note(agentId: string, why: string, inboxIds: number, now: number): WakeStall | null {
    if (!agentId) return null;
    // Nothing pending means nothing is stuck: that is the floor at rest.
    if (inboxIds <= 0 || DELIBERATE.has(why)) { this.watching.delete(agentId); return null; }
    const cur = this.watching.get(agentId);
    // A DIFFERENT reason is progress of a kind — the state machine is moving. Restart the
    // clock rather than blaming the new guard for the old one's wait.
    if (!cur || cur.why !== why) { this.watching.set(agentId, { why, since: now, announced: false, inboxIds }); return null; }
    cur.inboxIds = inboxIds;
    if (cur.announced) return null;
    const stalledMs = now - cur.since;
    if (stalledMs < WAKE_STALL_AFTER_MS) return null;
    cur.announced = true;
    return { agentId, why, inboxIds, stalledMs };
  }

  /** The agent took a wake: whatever it was waiting on, it is not stuck. */
  clear(agentId: string): void {
    this.watching.delete(agentId);
  }

  /** Read-only view for diagnostics and tests. */
  watchingFor(agentId: string): { why: string; since: number; announced: boolean; inboxIds: number } | null {
    return this.watching.get(agentId) ?? null;
  }

  /** WAKE-OWNER-HOLD-ORPHAN (1.1.91): the stalls announced and still running, for god's floor
   *  digest. A row alone was silent: Jim and Andy sat `owner-inhibited` for hours. */
  stalls(): Array<{ agentId: string; why: string; since: number; inboxIds: number }> {
    return [...this.watching].filter(([, w]) => w.announced).map(([agentId, w]) => ({ agentId, why: w.why, since: w.since, inboxIds: w.inboxIds }));
  }
}

/**
 * SCREEN-GUARD-ALERT-FLOOR-193: the FLOOR-WIDE stall. In 1.1.91 every Claude agent's wakes were
 * refused for 90 min and god was never told: the refusal reason kept changing (screen gate,
 * cooldown, lifecycle, in-flight), so no per-agent run above ever held one reason for 5 min,
 * and then the refusals stopped being made at all. This watch asks nothing about reasons: mail
 * waits for FLOOR_STALL_MIN_AGENTS agents, none of whom moved for FLOOR_STALL_AFTER_MS, whatever
 * path refused it (screen gate, term, owner). Each agent's own progress counts, not the floor's:
 * one healthy agent committing must not hide two stuck ones (Jim SHOULD).
 */
export const FLOOR_STALL_AFTER_MS = 20 * 60_000;
export const FLOOR_STALL_MIN_AGENTS = 2;

/** One agent's mail at a sample: its pending ids, and whether a human state holds them NOW
 *  (live state only: a past refusal's reason must not hide an agent for good, Jim MUST 1). */
export interface FloorPending { agentId: string; ids: readonly string[]; deliberate: boolean }

export interface FloorWakeStall {
  /** When this stall was first seen; fixed while it lasts, so it is one decision. */
  since: number;
  agents: Array<{ agentId: string; pending: number; since: number }>;
  /** The stuck agents' refusals since each began waiting, and the most frequent reason. */
  refusals: number;
  top: { why: string; count: number } | null;
}

export class FloorWakeStallWatch {
  private readonly waiting = new Map<string, { since: number; ids: Set<string> }>();
  private readonly reasons = new Map<string, Map<string, number>>();
  private seenSince: number | null = null;

  private moved(agentId: string): void { this.waiting.delete(agentId); this.reasons.delete(agentId); }

  /** A wake committed for this agent (any path: event submit, Stop-continue): it moves. */
  commit(agentId: string): void {
    this.moved(agentId);
  }

  /** Any refusal (a no-claim or a refused settle): counted for the decision's text only. */
  refusal(agentId: string, why: string): void {
    if (!agentId || DELIBERATE.has(why)) return;
    const m = this.reasons.get(agentId) ?? new Map<string, number>();
    m.set(why, (m.get(why) ?? 0) + 1);
    this.reasons.set(agentId, m);
  }

  /** Fold one sample of every live agent's pending mail in. A pending id that is gone since the
   *  last sample was delivered (a hook surfaced it, the agent read it): that agent moved. */
  sample(rows: readonly FloorPending[], now: number): void {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.ids.length === 0 || r.deliberate) { this.moved(r.agentId); continue; }
      seen.add(r.agentId);
      const ids = new Set(r.ids);
      const before = this.waiting.get(r.agentId);
      const drained = before ? [...before.ids].some((id) => !ids.has(id)) : false;
      if (drained) this.reasons.delete(r.agentId);
      this.waiting.set(r.agentId, { since: before && !drained ? before.since : now, ids });
    }
    for (const id of [...this.waiting.keys()]) if (!seen.has(id)) this.moved(id);
  }

  /** The stall, while it lasts (called once per digest run). */
  stall(now: number): FloorWakeStall | null {
    const agents = [...this.waiting].filter(([, w]) => now - w.since >= FLOOR_STALL_AFTER_MS)
      .map(([agentId, w]) => ({ agentId, pending: w.ids.size, since: w.since }));
    if (agents.length < FLOOR_STALL_MIN_AGENTS) { this.seenSince = null; return null; }
    this.seenSince ??= now;
    const all = new Map<string, number>();
    for (const a of agents) for (const [why, n] of this.reasons.get(a.agentId) ?? []) all.set(why, (all.get(why) ?? 0) + n);
    let top: { why: string; count: number } | null = null;
    let refusals = 0;
    for (const [why, count] of all) { refusals += count; if (!top || count > top.count) top = { why, count }; }
    return { since: this.seenSince, agents, refusals, top };
  }
}
