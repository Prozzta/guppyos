/**
 * WAKE-STALL-INTERFERED-192 (Jim SHOULD-1): an automatic wake to a PTY that never goes quiet for
 * the stage gate's window is REFUSED SCREEN_NOT_READY 'output-not-quiet' with nothing typed. That is
 * retryable and never held, so a terminal that redraws for ever would have every wake refused, with
 * nothing to say so: the stall of WAKE-STALL-INTERFERED in the other direction.
 *
 * Measured on the live floor (MEMSPIKE-167 pty-traffic rows, 2026-10-14..18): an idle Claude worker
 * draws nothing at all for hours (Dwight 16.4 h and Phyllis 10.5 h with no output; an idle minute
 * with output had 2 chunks). There is no statusline tick for the gate to ignore, so a run of these
 * refusals is never the normal idle state. After QUIET_REFUSAL_ALERT_AFTER in a row for one agent:
 * one 'wake-not-quiet' row (raised), and the agent is a floor-digest decision until a wake gets past
 * the gate (cleared). Observation only: it never changes a submit.
 */
import type { SubmitOutcome } from './automaticSubmit';

/** Consecutive output-not-quiet refusals for one agent before it is a decision. */
export const QUIET_REFUSAL_ALERT_AFTER = 3;

export interface QuietStall { agentId: string; count: number; since: number }

export class QuietRefusalWatch {
  private runs = new Map<string, { count: number; since: number; raised: boolean }>();

  constructor(private readonly log: (row: Record<string, unknown>) => void) {}

  /** Every settled automatic-submit outcome (the owner's onOutcome). */
  outcome(agentId: string, outcome: SubmitOutcome, at: number): void {
    if (outcome.kind === 'REFUSED' && outcome.reason === 'SCREEN_NOT_READY' && outcome.detail === 'output-not-quiet') {
      const r = this.runs.get(agentId) ?? { count: 0, since: at, raised: false };
      r.count += 1;
      this.runs.set(agentId, r);
      if (!r.raised && r.count >= QUIET_REFUSAL_ALERT_AFTER) {
        r.raised = true;
        this.log({ kind: 'wake-not-quiet', event: 'raised', agentId, count: r.count, since: r.since });
      }
      return;
    }
    // A refusal before the quiet gate (capacity, an inhibited PTY, ...) says nothing about quiet;
    // anything else got past it (the screen gate's own refusal included), and ends the run.
    if (outcome.kind === 'REFUSED' && outcome.reason !== 'SCREEN_NOT_READY') return;
    const r = this.runs.get(agentId);
    if (!r) return;
    this.runs.delete(agentId);
    if (r.raised) this.log({ kind: 'wake-not-quiet', event: 'cleared', agentId, count: r.count, since: r.since });
  }

  /** The agents whose run has reached the alert, for the floor digest. */
  stalls(): QuietStall[] {
    return [...this.runs].filter(([, r]) => r.raised).map(([agentId, r]) => ({ agentId, count: r.count, since: r.since }));
  }
}
