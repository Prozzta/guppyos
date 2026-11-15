/**
 * CODEX-TURN-ENDS-EARLY P1 (god c7c868): the owed-work Stop-continue, for Codex.
 *
 * A Codex turn ends on its first final_answer, and gpt-5.6 writes one after each milestone of a
 * multi-step request ("the branch is ready, the rest in progress"). The only re-invoke for the
 * owed work was OwedContinuation (3 min, then hourly, two in all, then STALL), so each early stop
 * cost about an hour and the third left the agent idle until a person acted (Dwight, 2026-11-14).
 *
 * Here, inside the agent's OWN Stop hook, a Stop with a request still owed is blocked with a short
 * fixed reason, which Codex runs as the next prompt in the same turn. It carries no mail and claims
 * nothing (the GTC M4 Stop-continue carries waiting mail; that one goes first). Bounds:
 *  - only while the segment just ended made at least one tool call: a tool-free segment is an
 *    answer or a real wait, and that Stop goes through (OwedContinuation and STALL as before);
 *  - at most OWED_STOP_MAX blocks per obligation per chain (a chain ends at a Stop that goes through);
 *  - every legitimate wait OwedContinuation knows (owedSuppressor), mail waiting to be delivered
 *    (the wake brings it, and it may change the work), plus the human guards of the M4 stopClaim:
 *    no PTY, an inhibited PTY, a draft, a picker or an exited prompt, a person's key within
 *    HUMAN_QUIET_MS.
 * Setting `owedStopContinue.codex` (config.ts): on unless literally false. Claude and AGY never
 * get it (they do not show the pattern; their Stop is unchanged).
 * Pure: HookServer supplies the provider and the segment's tool calls, main the facts.
 */
import { owesWork, type MailEntry } from './mailLedger';
import { OWED_WINDOW_MS, owedSuppressor, type OwedSuppressFacts, type OwedSuppressor } from './owedContinuation';

/** Owed blocks per obligation in one chain of continued Stops. */
export const OWED_STOP_MAX = 4;
/** A person's key this recently holds the block back (automaticSubmit HUMAN_QUIET_MS). */
export const OWED_STOP_HUMAN_QUIET_MS = 1_500;

export interface OwedStopSetting { codex?: boolean }

/** Is the owed-work Stop-continue on for this provider? Codex unless literally false; never another provider. */
export function owedStopOn(provider: string | null | undefined, setting: unknown): boolean {
  if (provider !== 'codex') return false;
  if (setting && typeof setting === 'object' && (setting as Record<string, unknown>).codex === false) return false;
  return true;
}

export interface OwedStopFacts extends OwedSuppressFacts {
  /** Mail delivered and not yet shown to the agent. */
  pendingMail: number;
  /** The agent's PTY, if it has one. */
  pty: boolean;
  inhibited: boolean;
  /** promptState block of the PTY ('draft' | 'picker' | 'exited' hold the block back). */
  promptBlock?: string;
  lastHumanInputAt?: number;
}

export type OwedStopWhy = OwedSuppressor | 'off' | 'no-tools' | 'pending-mail' | 'no-pty' | 'inhibited' | 'draft' | 'picker' | 'exited' | 'human-input' | 'cap';

export interface OwedStopDecision {
  /** The block reason, or null: the Stop goes through. */
  reason: string | null;
  /** A log row (kind 'wake-stop') when something is owed; null when nothing is. */
  row: Record<string, unknown> | null;
}

/** Requests the agent has been shown and still owes work on, oldest first. */
export function owedAtStop(agentId: string, entries: MailEntry[], since: number, now: number): MailEntry[] {
  return entries
    .filter((e) => e.act === 'request' && e.from !== 'system' && e.from !== agentId && e.state !== 'delivered' && owesWork(e)
      && (e.actedAt ?? e.surfacingAt ?? e.updatedAt ?? 0) >= since && e.deliveredAt >= now - OWED_WINDOW_MS)
    .sort((a, b) => a.deliveredAt - b.deliveredAt || a.seq - b.seq);
}

export function owedStopReason(e: Pick<MailEntry, 'id' | 'from'>): string {
  return `Request ${e.id} from ${e.from} is still owed. Do the next step now. End your turn only after you send done or refuse (in_reply_to ${e.id}), or a query or request naming what you wait on.`;
}

export class OwedStopContinue {
  /** Per agent, the blocks per obligation in the current chain. */
  private readonly chains = new Map<string, Map<string, number>>();

  /** `startedAt`: obligations shown before it are not followed (OwedContinuation's rule). */
  constructor(private readonly startedAt: number) {}

  /** The blocks this chain has spent on an obligation (tests, diagnostics). */
  spent(agentId: string, id: string): number {
    return this.chains.get(agentId)?.get(id) ?? 0;
  }

  /** One Stop of the agent's own session, after the M4 mail Stop-continue declined it. `facts` is
   *  read only when the setting is on and something is owed (it walks every ledger for `sent`). */
  decide(agentId: string, provider: string | null | undefined, setting: unknown, segmentTools: number, now: number, entries: MailEntry[], facts: () => Omit<OwedStopFacts, 'entries' | 'now'>): OwedStopDecision {
    const owed = owedStopOn(provider, setting) ? owedAtStop(agentId, entries, this.startedAt, now) : [];
    const chain = this.chains.get(agentId) ?? new Map<string, number>();
    const pass = (why: OwedStopWhy | null): OwedStopDecision => {
      this.chains.delete(agentId);
      if (!owed.length || why === 'off') return { reason: null, row: null };
      return { reason: null, row: { kind: 'wake-stop', agentId, provider, outcome: 'OWED_NOT_BLOCKED', why, ids: owed.map((e) => e.id), segmentTools } };
    };
    if (!owedStopOn(provider, setting)) return pass('off');
    if (!owed.length) return pass(null);
    if (segmentTools < 1) return pass('no-tools');
    const f: OwedStopFacts = { ...facts(), entries, now };
    if (f.pendingMail > 0) return pass('pending-mail');
    const why = owedSuppressor(f);
    if (why) return pass(why);
    if (!f.pty) return pass('no-pty');
    if (f.inhibited) return pass('inhibited');
    if (f.promptBlock === 'draft' || f.promptBlock === 'picker' || f.promptBlock === 'exited') return pass(f.promptBlock);
    if (f.lastHumanInputAt !== undefined && f.now - f.lastHumanInputAt < OWED_STOP_HUMAN_QUIET_MS) return pass('human-input');
    const e = owed.find((o) => (chain.get(o.id) ?? 0) < OWED_STOP_MAX);
    if (!e) return pass('cap');
    const n = (chain.get(e.id) ?? 0) + 1;
    chain.set(e.id, n);
    this.chains.set(agentId, chain);
    const reason = owedStopReason(e);
    return { reason, row: { kind: 'wake-stop', agentId, provider, outcome: 'OWED_BLOCKED', id: e.id, block: n, max: OWED_STOP_MAX, segmentTools, reasonChars: reason.length } };
  }
}
