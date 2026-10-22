/**
 * WAKE-STUCK-REFUSAL-ESCALATE: a refused SETTLE (the claim passed, then the owner refused with a
 * static screen guard such as SCREEN_NOT_READY startup:header-loading) never reaches WakeStallWatch
 * (only no-claims do, and every reconcile claim clears it), QuietRefusalWatch counts only
 * output-not-quiet, and FloorWakeStallWatch needs two agents. Dwight's stale 'model: loading'
 * header (1.1.97, 2026-10-21) was therefore re-asked by every reconcile, in silence, with mail
 * waiting, until a person typed. Worse, wakeBreadcrumb folds identical reconcile rows, so the log
 * showed one refusal of a run.
 *
 * This watch counts identical refusals per agent AND incarnation, before any folding, from the
 * owner's onOutcome. After REFUSED_SETTLE_ALERT_AFTER in a row, or REFUSED_SETTLE_ALERT_MS since
 * the run began with at least two refusals, it writes one 'wake-refusal-stuck' row (raised) and
 * the agent is a floor-digest decision and a board-status flag until the run ends (cleared).
 * Observation only: it holds no handle to the owner or the terminal, and never types a thing.
 */
import type { SubmitOutcome } from './automaticSubmit';
import type { BoardFlag } from '../shared/boardStale';
import { DELIBERATE } from './wakeStall';
import { ageText } from '../shared/agentBadges';

/** Identical refusals in a row (with mail waiting) before the run is a decision. */
export const REFUSED_SETTLE_ALERT_AFTER = 3;
/** Or this long since the run's first refusal, with at least two refusals. */
export const REFUSED_SETTLE_ALERT_MS = 4 * 60_000;
/** Raised runs per agent+incarnation per hour; beyond it the item stays, the rows stop. */
export const REFUSED_SETTLE_RAISE_CAP = 3;
const CAP_WINDOW_MS = 60 * 60_000;
/** QuietRefusalWatch owns this detail: one decision per agent, not two. */
const QUIET_DETAIL = 'output-not-quiet';

export interface RefusedSettleRecord {
  agentId: string;
  /** The owner's incarnation value for the live PTY (ptyId#spawn); opaque, equality only. */
  incarnation: unknown;
  outcome: SubmitOutcome;
  at: number;
  requestId: string;
  /** Pending mail for the agent at the time of the outcome. */
  inboxIds: number;
}

export interface RefusedStall {
  agentId: string;
  incarnation: string;
  why: string;
  count: number;
  since: number;
  inboxIds: number;
  requestId: string;
}

interface Run extends RefusedStall { raised: boolean }

/**
 * What the floor knows at read time (Jim SHOULD1): a raised run clears only on the agent's next
 * owner outcome, and after a person types there may never be one. So each read drops a run whose
 * agent has no mail pending any more, or whose live incarnation is not the run's.
 */
export interface RefusedSettleLive {
  pending(agentId: string): number;
  incarnation(agentId: string): unknown;
}

const incarnationKey = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export class RefusedSettleWatch {
  private runs = new Map<string, Run>();
  /** Raise times per agent#incarnation, for the cap. */
  private raises = new Map<string, number[]>();
  private capped = new Set<string>();

  constructor(private readonly log: (row: Record<string, unknown>) => void) {}

  /** Every settled automatic-submit outcome (the owner's onOutcome), with the mail still pending. */
  outcome(rec: RefusedSettleRecord): void {
    const { agentId, outcome, at } = rec;
    const incarnation = incarnationKey(rec.incarnation);
    let cur = this.runs.get(agentId);
    if (cur && cur.incarnation !== incarnation) { this.end(cur, 'incarnation'); cur = undefined; }
    if (outcome.kind === 'COMMITTED') { if (cur) this.end(cur, 'committed'); return; }
    if (outcome.kind !== 'REFUSED') return;
    const detail = outcome.detail ?? '';
    if (DELIBERATE.has(outcome.reason) || DELIBERATE.has(detail)) { if (cur) this.end(cur, 'deliberate'); return; }
    if (detail === QUIET_DETAIL) return;
    if (rec.inboxIds <= 0) { if (cur) this.end(cur, 'drained'); return; }
    const why = `${outcome.reason}:${detail}`;
    if (cur && cur.why !== why) { this.end(cur, 'reason-changed'); cur = undefined; }
    if (!cur) {
      cur = { agentId, incarnation, why, count: 0, since: at, inboxIds: rec.inboxIds, requestId: rec.requestId, raised: false };
      this.runs.set(agentId, cur);
    }
    cur.count += 1;
    cur.inboxIds = rec.inboxIds;
    cur.requestId = rec.requestId;
    if (cur.raised) return;
    const byCount = cur.count >= REFUSED_SETTLE_ALERT_AFTER;
    const byTime = cur.count >= 2 && at - cur.since >= REFUSED_SETTLE_ALERT_MS;
    if (byCount || byTime) this.raise(cur, at);
  }

  private raise(run: Run, at: number): void {
    run.raised = true;
    const key = `${run.agentId}#${run.incarnation}`;
    const recent = (this.raises.get(key) ?? []).filter((t) => at - t < CAP_WINDOW_MS);
    if (recent.length >= REFUSED_SETTLE_RAISE_CAP) {
      this.raises.set(key, recent);
      if (!this.capped.has(key)) { this.capped.add(key); this.log(this.row('capped', run)); }
      return;
    }
    recent.push(at);
    this.raises.set(key, recent);
    this.log(this.row('raised', run));
  }

  /** The agent's PTY was torn down (teardownPty): nothing will ever end its run otherwise. */
  forget(agentId: string): void {
    const cur = this.runs.get(agentId);
    if (cur) this.end(cur, 'forget');
  }

  private prune(live?: RefusedSettleLive): void {
    if (!live) return;
    for (const run of [...this.runs.values()]) {
      if (live.pending(run.agentId) <= 0) { this.end(run, 'drained'); continue; }
      if (incarnationKey(live.incarnation(run.agentId)) !== run.incarnation) this.end(run, 'incarnation');
    }
  }

  private end(run: Run, reason: string): void {
    this.runs.delete(run.agentId);
    if (run.raised) this.log({ ...this.row('cleared', run), reason });
  }

  private row(event: string, run: Run): Record<string, unknown> {
    return {
      kind: 'wake-refusal-stuck', event, agentId: run.agentId, incarnation: run.incarnation, why: run.why,
      count: run.count, since: run.since, requestId: run.requestId, inboxIds: run.inboxIds
    };
  }

  /** The runs that have reached the alert, for the floor digest. */
  stalls(live?: RefusedSettleLive): RefusedStall[] {
    this.prune(live);
    return [...this.runs.values()].filter((r) => r.raised).map((r) => ({
      agentId: r.agentId, incarnation: r.incarnation, why: r.why, count: r.count, since: r.since, inboxIds: r.inboxIds, requestId: r.requestId
    }));
  }

  /** The same runs as board-status '## Flags' lines (kind wake-refusal-stuck, no card). */
  flags(now: number, name: (agentId: string) => string = (id) => id, live?: RefusedSettleLive): BoardFlag[] {
    return this.stalls(live).map((s) => ({
      cardId: '-', kind: 'wake-refusal-stuck', agentId: s.agentId, since: s.since, decision: false,
      evidence: refusedStallLine(s, name(s.agentId), now)
    }));
  }
}

/** The decision line (shared by the digest item and the board-status flag). */
export function refusedStallLine(s: RefusedStall, who: string, now: number): string {
  const n = s.incarnation.includes('#') ? s.incarnation.slice(s.incarnation.lastIndexOf('#') + 1) : s.incarnation || '?';
  return `${who}: ${s.inboxIds} message(s) waiting ${ageText(now - s.since)}; every reconcile wake refused ${s.count} times as "${s.why}" on this terminal (incarnation ${n}) - read ${who}'s screen; a stale header or popup needs a person`;
}
