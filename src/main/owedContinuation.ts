/**
 * HIVE-DWIGHT-BG-REINVOKE (god 7e4159): the owed-work continuation.
 *
 * A Codex turn ends on the first assistant message without a tool call, so an agent that writes
 * a progress note ("pushed X, doing Y next") is idle at the prompt with the work still owed. The
 * wake only claims for delivered mail (workerWake: "Nothing re-offers mail by time alone"), and
 * the Stop marks the surfaced mail acted, so nothing re-invoked Dwight until god nudged him
 * (2026-10-20 02:59Z: 1h26m after an inform-only reply; 07:18Z: 47 min with two requests unreplied).
 *
 * This watcher, on the 15 s beat, sends ONE system mail (wake:'now', the normal claim path and all
 * its guards) to an agent that is idle past OWED_GRACE_MS after its last Stop while it owes work:
 * a request it has acted on and not discharged (no reply, or only an inform/agree reply; see
 * mailLedger.owesWork). Legitimate waits suppress it: the agent's own outgoing request still
 * open, a heavy-lock slot it holds (its own background run) or a queue place or reservation, its
 * newest sent message being a request, the floor hold (floorHold.ts: a Human pause), pause, halt,
 * auto-delivery pause, a recent HITL prompt. Caps: one nudge per obligation per hour (and only
 * after a new Stop), two in total; then one stall row and one notice to god, never a loop.
 * Pure: main supplies the facts and sends what it returns.
 *
 * Restarts (Jim 0dbf11 NIT): `startedAt` is the app start and the tallies live in memory, so a
 * restart drops every obligation acted before it (a stall that straddles a restart is not
 * followed) and resets the caps. Accepted: the 6 h window bounds what could be followed anyway.
 */
import { owesWork, type MailEntry } from './mailLedger';

/** Idle time after the last Stop before a continuation is owed. */
export const OWED_GRACE_MS = 3 * 60_000;
/** At most one continuation per obligation in this time. */
export const OWED_REPEAT_MS = 60 * 60_000;
/** Continuations per obligation; the next eligible point gives up instead. */
export const OWED_MAX = 2;
/** Obligations (and outgoing requests) older than this are not followed. */
export const OWED_WINDOW_MS = 6 * 60 * 60_000;

/** A message the agent sent, as seen in the recipient's ledger. */
export interface OwedSent {
  id: string;
  to: string;
  act: string;
  at: number;
  /** The recipient still owes an answer (mailLedger.owesWork on its entry). */
  open: boolean;
}

export interface OwedFacts {
  now: number;
  lifecycle: string;
  lastTurnEndAt: number;
  inFlight: boolean;
  pendingMail: number;
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  /** A HITL prompt inside its re-arm window. */
  hitl: boolean;
  /** Queued on the heavy lock or holding a reservation. */
  heavyQueued: boolean;
  /** Holds a heavy-lock slot (its own suite or bench is running). */
  heavyHolder: boolean;
  /** The floor hold is on (god's `term hold on`, a Human pause). */
  floorHeld: boolean;
  /** The agent's own ledger entries. */
  entries: MailEntry[];
  /** Messages the agent sent (from the other agents' ledgers). */
  sent: OwedSent[];
}

export type OwedSuppressor = 'floor-paused' | 'paused' | 'halted' | 'auto-delivery-paused' | 'hitl' | 'heavy-holder' | 'heavy-queued' | 'outgoing-request' | 'newest-sent-request';

export interface OwedNudge {
  message: { to: string; act: 'inform'; requires_reply: false; subject: string; body: string; wake: 'now' };
  from: 'system';
}

export interface OwedDecision {
  /** Log rows to append (kind 'wake'). */
  rows: Array<Record<string, unknown>>;
  /** The continuation mail for the agent, if one is due. */
  nudge?: OwedNudge;
  /** The stall notice for god, if the agent used up its continuations. */
  notice?: OwedNudge;
}

interface Tally { count: number; lastAt: number; gaveUp: boolean }

/** The obligations this agent still owes work on, oldest first. */
export function owedEntries(agentId: string, entries: MailEntry[], since: number, now: number): MailEntry[] {
  return entries
    .filter((e) => e.act === 'request' && e.from !== 'system' && e.from !== agentId && e.state === 'acted' && owesWork(e)
      && (e.actedAt ?? 0) >= since && e.deliveredAt >= now - OWED_WINDOW_MS)
    .sort((a, b) => a.deliveredAt - b.deliveredAt || a.seq - b.seq);
}

/**
 * The first legitimate wait that holds the continuation back, or null. The newest message the
 * agent sent being a request only counts while nothing has reached the agent since (its answer, or
 * the owed work itself, would have): the 07:18Z replay has an audit request Jim had already
 * answered before the owed work arrived.
 */
export function owedSuppressor(f: OwedFacts): OwedSuppressor | null {
  if (f.floorHeld) return 'floor-paused';
  if (f.paused) return 'paused';
  if (f.halted) return 'halted';
  if (f.autoDeliveryPaused) return 'auto-delivery-paused';
  if (f.hitl) return 'hitl';
  if (f.heavyHolder) return 'heavy-holder';
  if (f.heavyQueued) return 'heavy-queued';
  const recent = f.sent.filter((s) => s.at >= f.now - OWED_WINDOW_MS);
  if (recent.some((s) => s.act === 'request' && s.open)) return 'outgoing-request';
  const newest = [...recent].sort((a, b) => b.at - a.at)[0];
  if (newest?.act === 'request' && !f.entries.some((e) => e.from !== 'system' && e.deliveredAt > newest.at)) return 'newest-sent-request';
  return null;
}

export function owedNudge(agentId: string, owed: MailEntry[]): OwedNudge {
  const list = owed.map((e) => `- ${e.id} from ${e.from}${e.subject ? `: "${e.subject}"` : ''}`).join('\n');
  const subject = `CONTINUE: your turn ended with work still owed (${owed.length} request${owed.length === 1 ? '' : 's'})`;
  const body = `Your last turn ended while these requests are still owed (not answered, or answered only with an inform/agree):\n${list}\n\nIf this is finished, reply done with in_reply_to <id> (one short reply per request; that ends it). Otherwise continue the work now and send a done (or refuse) with in_reply_to the request id when it is. If you are waiting on someone or something, say so in a reply with needs_human, or send your own request to who you are waiting on.`;
  return { message: { to: agentId, act: 'inform', requires_reply: false, subject, body, wake: 'now' }, from: 'system' };
}

export class OwedContinuation {
  private readonly tallies = new Map<string, Map<string, Tally>>();
  private readonly lastSuppressed = new Map<string, string>();

  /** `startedAt`: obligations acted before it are not followed (no backlog flood at upgrade). */
  constructor(private readonly startedAt: number, private readonly godId: () => string | null) {}

  /** One beat for one live agent. */
  tick(agentId: string, f: OwedFacts): OwedDecision {
    const owed = owedEntries(agentId, f.entries, this.startedAt, f.now);
    const tallies = this.tallies.get(agentId) ?? new Map<string, Tally>();
    this.tallies.set(agentId, tallies);
    for (const id of [...tallies.keys()]) if (!owed.some((e) => e.id === id)) tallies.delete(id);
    if (!owed.length) { this.lastSuppressed.delete(agentId); return { rows: [] }; }
    // The agent is not idle past the grace after a Stop: nothing is owed yet (no row).
    if (f.lifecycle !== 'idle' || f.inFlight || f.pendingMail > 0 || !f.lastTurnEndAt || f.now - f.lastTurnEndAt < OWED_GRACE_MS) return { rows: [] };
    const due = owed.filter((e) => {
      const t = tallies.get(e.id);
      return !t || (!t.gaveUp && f.lastTurnEndAt > t.lastAt && f.now - t.lastAt >= OWED_REPEAT_MS);
    });
    if (!due.length) return { rows: [] };
    const why = owedSuppressor(f);
    if (why) {
      const key = `${why}:${due.map((e) => e.id).join(',')}`;
      if (this.lastSuppressed.get(agentId) === key) return { rows: [] };
      this.lastSuppressed.set(agentId, key);
      return { rows: [{ kind: 'wake', stage: 'continuation', agentId, ids: due.map((e) => e.id), graceMs: OWED_GRACE_MS, suppressedBy: why }] };
    }
    this.lastSuppressed.delete(agentId);
    const spent = due.filter((e) => (tallies.get(e.id)?.count ?? 0) >= OWED_MAX);
    const send = due.filter((e) => (tallies.get(e.id)?.count ?? 0) < OWED_MAX);
    const rows: Array<Record<string, unknown>> = [];
    const out: OwedDecision = { rows };
    if (spent.length) {
      for (const e of spent) tallies.set(e.id, { ...(tallies.get(e.id) as Tally), gaveUp: true });
      const ids = spent.map((e) => e.id);
      rows.push({ kind: 'wake', stage: 'continuation-gave-up', agentId, ids, continuations: OWED_MAX, idleMs: f.now - f.lastTurnEndAt });
      const god = this.godId();
      if (god && god !== agentId) {
        const subject = `STALL: ${agentId} is idle with work still owed after ${OWED_MAX} continuations`;
        const body = `${agentId} was sent ${OWED_MAX} continuation mails for these requests and is idle again without discharging them:\n${spent.map((e) => `- ${e.id} from ${e.from}`).join('\n')}\n\nGuppy will not send it more continuations for them. Check on it (a term read of its screen), or close the requests if they are no longer needed.`;
        out.notice = { message: { to: god, act: 'inform', requires_reply: false, subject, body, wake: 'now' }, from: 'system' };
      }
    }
    if (send.length) {
      for (const e of send) tallies.set(e.id, { count: (tallies.get(e.id)?.count ?? 0) + 1, lastAt: f.now, gaveUp: false });
      rows.push({ kind: 'wake', stage: 'continuation', agentId, ids: send.map((e) => e.id), graceMs: OWED_GRACE_MS, idleMs: f.now - f.lastTurnEndAt });
      out.nudge = owedNudge(agentId, send);
    }
    return out;
  }
}
