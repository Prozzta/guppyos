/**
 * ZT-I1-MAIL 1.1.75 slice 4: the harness readers that used to take "a file in inbox/" to mean
 * "unhandled" (INBOX-DESIGN.md §3 #6, §11.8 #9-#14), rewritten over the per-agent mail ledger.
 *
 * Since 1.1.75 the HARNESS moves a message file into inbox/.done when the message is acted (the
 * turn that surfaced it ended normally), so file position and directory mtimes say nothing about
 * what an agent did. Every reader here takes the ledger instead:
 *  - #6  fleet `inboxBacklog` = not acted (work orders excluded, N2); `awaitingReply[]` (§4.3) and
 *        `openRequests[]` (§11.13 option B), each with its age;
 *  - #9  the standup delta's `actionableInbox` = not-acted count, system senders excluded;
 *  - #10 the heartbeat quiet-floor gate = the ledger's last NON-harness transition (a harness
 *        rename into .done, a back-edge, a prune or a rebuild is never activity);
 *  - #11 no-progress coordination = the agent's `acted` transitions (plus its own outbox and
 *        memory writes, which index.ts still stats), never a .done mtime;
 *  - #12 the heartbeat digest's "with inbox" list = agents with a ledger backlog;
 *  - #13 god's actionable count = the same rule as #9, for god;
 *  - #14 the voice completion watcher = the ledger's entries (every state, archived or not), so
 *        a reply the harness archived at god's Stop is still seen.
 *
 * Pure over a small ledger interface (the MailLedger satisfies it); no I/O of its own.
 */
import type { MailEntry, MailObligation } from './mailLedger';

/** The inputs of the coordinator's pending source (index.ts wires them to the HookServer and
 *  the hive). */
export interface PendingSourceDeps {
  mode: (agentId: string) => string;
  pending: (agentId: string) => Array<{ id: string }>;
  skipped: (agentId: string) => Iterable<string>;
  files: (agentId: string) => unknown[];
}

/**
 * §3 #1-#3 / §11.8 #16: the ids the wake coordinator treats as pending for an agent, and the
 * renderer queue's "something to announce" precondition.
 *  - inject and legacy-read agents: the ledger's `delivered` ids (arrival order), minus the Q13
 *    skipped ids (a body the harness cannot show must never loop wakes);
 *  - legacy-move (cursor, §11.7) and work-order agents: the inbox files, 1.1.74 semantics (for
 *    them file position IS state); likewise when the ledger cannot be read.
 */
export function coordinatorPendingIds(agentId: string, deps: PendingSourceDeps): string[] {
  const files = (): string[] => deps.files(agentId).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const mode = deps.mode(agentId);
  if (mode === 'legacy-move' || mode === 'work-order') return files();
  try {
    const skip = new Set(deps.skipped(agentId));
    return deps.pending(agentId).map((e) => e.id).filter((id) => !skip.has(id));
  } catch {
    return files();
  }
}

/** The ledger queries the readers use (MailLedger's public API). */
export interface MailReaderLedger {
  backlog(agentId: string): MailEntry[];
  awaitingReply(agentId: string): MailObligation[];
  openRequests(agentId: string): MailObligation[];
  lastActivityAt(agentId: string): number | null;
  lastActedAt(agentId: string): number | null;
  ledger(agentId: string): { entries: Record<string, MailEntry> };
}

/** Senders whose mail is the scheduler's OWN noise (heartbeat beats, ops-standup via
 *  'scheduler', breaker steers, generic 'system'), never a reason to wake god. Everything else
 *  (a worker agent id, 'webhook', a human reply) is real mail. */
export const SYSTEM_SENDERS: ReadonlySet<string> = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/** #9 / #13: the agent's not-acted mail, excluding system senders. Throws if the ledger does
 *  (the standup names the agent `unknown` rather than guessing zero). */
export function actionableBacklog(mail: MailReaderLedger, agentId: string, system: ReadonlySet<string> = SYSTEM_SENDERS): number {
  return mail.backlog(agentId).filter((e) => !system.has(e.from)).length;
}

/** #12: does the agent have mail not yet acted? */
export function hasBacklog(mail: MailReaderLedger, agentId: string): boolean {
  return mail.backlog(agentId).length > 0;
}

/**
 * #10: the newest non-harness mail transition across these agents (delivered, surfacing,
 * surfaced, acted, replied, work order), or null when none is known. An agent whose ledger
 * cannot be read is returned in `failed`, so the caller can fall back to another signal.
 */
export function floorMailActivityAt(mail: MailReaderLedger, agentIds: Iterable<string>): { at: number | null; failed: string[] } {
  let at: number | null = null;
  const failed: string[] = [];
  for (const id of agentIds) {
    try {
      const t = mail.lastActivityAt(id);
      if (typeof t === 'number' && (at === null || t > at)) at = t;
    } catch { failed.push(id); }
  }
  return { at, failed };
}

/** #11: the agent's last `acted` transition (its turn completed with the mail seen), or 0. A
 *  harness rename into .done is the CONSEQUENCE of this, never a separate signal. */
export function mailCoordinationAt(mail: MailReaderLedger, agentId: string): number {
  try { return mail.lastActedAt(agentId) ?? 0; } catch { return 0; }
}

/** One obligation in fleet.json: small, header-only, ages in whole seconds. */
export interface FleetObligation {
  id: string;
  from: string;
  act: string;
  subject: string;
  state: string;
  ageSec: number;
  conversation?: string;
  /** Q15: the body was in neither inbox/ nor inbox/.done/; closed by the harness, still owed. */
  missing?: true;
}

/** fleet.json caps each per-agent list (god reads fleet.json every standup; tokens count). The
 *  full count is always given. */
export const FLEET_OBLIGATIONS_MAX = 10;

export interface FleetMailFields {
  inboxBacklog: number;
  /** §4.3: acted, requires_reply, not replied (oldest first, at most FLEET_OBLIGATIONS_MAX). */
  awaitingReply: FleetObligation[];
  awaitingReplyCount: number;
  /** §11.13 option B: every act:"request" not yet answered, in any state (same bound). */
  openRequests: FleetObligation[];
  openRequestCount: number;
}

function obligation(o: MailObligation): FleetObligation {
  const e = o.entry;
  return {
    id: e.id, from: e.from, act: e.act, subject: e.subject.slice(0, 120), state: e.state,
    ageSec: Math.max(0, Math.round(o.ageMs / 1000)),
    ...(e.conversation ? { conversation: e.conversation } : {}),
    ...(e.missingAt ? { missing: true as const } : {})
  };
}

/** #6: the ledger part of one agent's fleet.json row. */
export function fleetMailFields(mail: MailReaderLedger, agentId: string, max = FLEET_OBLIGATIONS_MAX): FleetMailFields {
  const awaiting = mail.awaitingReply(agentId);
  const open = mail.openRequests(agentId);
  return {
    inboxBacklog: mail.backlog(agentId).length,
    awaitingReply: awaiting.slice(0, max).map(obligation),
    awaitingReplyCount: awaiting.length,
    openRequests: open.slice(0, max).map(obligation),
    openRequestCount: open.length
  };
}

/** The header shape the voice completion watcher scans (realtimeCompletionWatcher InboxMessage). */
export interface LedgerInboxMessage {
  id: string;
  from: string;
  act: string;
  in_reply_to: string | null;
  subject: string;
  created_at: string;
}

/**
 * #14: every inbox-delivered message the agent's ledger still holds, in ANY state, so a reply
 * archived at the agent's Stop is still visible to the watcher (acted entries are kept 7 days;
 * the watcher's own pending dispatches expire long before that). `created_at` is the delivery
 * time. Headers only: the watcher never reads a body.
 */
export function ledgerInboxMessages(mail: MailReaderLedger, agentId: string): LedgerInboxMessage[] {
  return Object.values(mail.ledger(agentId).entries)
    .filter((e) => e.via === 'inbox')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({
      id: e.id, from: e.from, act: e.act, in_reply_to: e.inReplyTo ?? null, subject: e.subject,
      created_at: new Date(e.deliveredAt).toISOString()
    }));
}

/** One agent's row in the Command Center open-request list (§4.3, §11.13 option B). */
export interface MailObligationsAgent {
  /** The agent that owes the reply (the recipient of the request). */
  agentId: string;
  name: string;
  awaitingReply: FleetObligation[];
  awaitingReplyCount: number;
  openRequests: FleetObligation[];
  openRequestCount: number;
}

/** The UI's list bound per agent (the counts are always full). */
export const UI_OBLIGATIONS_MAX = 50;

/**
 * §4.3 / option B: the Command Center's open-request view over the given (active) agents. Only
 * agents that owe something are listed. An agent whose ledger cannot be read is skipped (the
 * fleet row keeps its file backlog; the UI shows no guess). Zero-token: data only, no wake.
 */
export function mailObligationsView(mail: MailReaderLedger, agents: Array<{ id: string; name?: string }>, max = UI_OBLIGATIONS_MAX): MailObligationsAgent[] {
  const out: MailObligationsAgent[] = [];
  for (const a of agents) {
    let f: FleetMailFields;
    try { f = fleetMailFields(mail, a.id, max); } catch { continue; }
    if (!f.awaitingReplyCount && !f.openRequestCount) continue;
    out.push({
      agentId: a.id, name: a.name || a.id,
      awaitingReply: f.awaitingReply, awaitingReplyCount: f.awaitingReplyCount,
      openRequests: f.openRequests, openRequestCount: f.openRequestCount
    });
  }
  return out;
}

/** The distinct open obligations across the view (an entry can be both a request and
 *  requires_reply): the Command Center badge count. */
export function openObligationCount(view: MailObligationsAgent[]): number {
  let n = 0;
  for (const a of view) {
    const ids = new Set([...a.awaitingReply, ...a.openRequests].map((o) => o.id));
    // Beyond the display bound, the full counts are the best lower bound.
    n += Math.max(ids.size, a.awaitingReplyCount, a.openRequestCount);
  }
  return n;
}
