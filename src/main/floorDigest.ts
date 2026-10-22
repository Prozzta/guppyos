/**
 * ZT-I4: the floor digest. One harness-built summary of the floor (`hive/floor-digest.md`),
 * recomputed every few minutes and on every flag change for ZERO model tokens: nobody is
 * woken to produce it. It replaces the hourly ops standup (now off by default) and the
 * heartbeat (retired) as the way god learns what needs attention.
 *
 * God is woken ONLY for a decision item it has not been woken for yet, batched over a short
 * window into one message (`Floor: N decision(s)`), sent as `'digest'`. That sender is
 * deliberately NOT a system sender (mailReaders.ts SYSTEM_SENDERS): a digest wake carries
 * only decisions, so it is actionable mail and counts in god's backlog and the standup
 * gate exactly like a worker's request (Jim C5).
 *
 * `buildFloorDigest` and `decideGodWake` are pure; `FloorDigest` is the scheduler.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { atomicWriteJson, renameWithRetry } from './atomicJson';
import type { BoardFlag } from '../shared/boardStale';
import { firstOccurrenceById, type LedgerIssue } from '../shared/taskLedger';
import { ageText } from '../shared/agentBadges';
import { floorHoldWords, type FloorHold } from './floorHold';
import type { SilentTurn } from './silentTurn';
import { refusedStallLine, type RefusedStall } from './refusedSettleWatch';

export interface FloorDigestConfig {
  enabled: boolean;
  digestEveryMs: number;
  wakeBatchMs: number;
}

export const FLOOR_DIGEST_DEFAULTS: FloorDigestConfig = {
  enabled: true,
  digestEveryMs: 5 * 60_000,
  wakeBatchMs: 10 * 60_000
};

export const FLOOR_DIGEST_FILE = 'floor-digest.md';
export const DIGEST_WOKEN_FILE = 'digest-woken.json';
/** The sender of a digest wake. NOT in SYSTEM_SENDERS: decisions are actionable mail. */
export const DIGEST_SENDER = 'digest';

export interface DecisionItem { id: string; cardId: string | null; line: string }

export interface DigestAgent {
  id: string;
  name?: string;
  inboxBacklog?: number;
  onHold?: boolean;
  liveness?: { classification?: string; reason?: string } | null;
}

/** DWIGHT-HELD-INTERFERED-2028 fix 2: an automatic wake held after it was interrupted, past the
 *  notice threshold (the Human has a banner; god gets a decision). */
export interface DigestHeldWake { agentId: string; name?: string; messages: number; since: number; /** GTC-ID: the hold's requestId, what `term rule --id` needs. */ requestId?: string }

/** WAKE-STALL-INTERFERED-192: automatic wakes refused in a row because the terminal never went
 *  quiet (quietRefusalWatch.ts): nothing typed, so nothing else alarms. */
export interface DigestQuietStall { agentId: string; name?: string; count: number; since: number }

/** WAKE-OWNER-HOLD-ORPHAN (1.1.91): any wake stall (wakeStall.ts) past WAKE_STALL_AFTER_MS, whatever
 *  guard refuses (`owner-inhibited` included), so no stall is only a log row. */
export interface DigestWakeStall { agentId: string; name?: string; why: string; inboxIds: number; since: number }
/** WAKE-STUCK-REFUSAL-ESCALATE: a run of identical refused settles on one terminal incarnation (refusedSettleWatch.ts). */
export interface DigestRefusedSettle extends RefusedStall { name?: string }

/** REQUESTS-AUTO-190: an ask the backstop closed (hive.autoCloseStaleObligations writes them). */
export interface DigestBackstopClosed { agentId: string; from: string; id: string; subject: string; at: number }
/** Under state/: the backstop closes of the last week, newest last, at most ASKS_BACKSTOP_KEEP. */
export const ASKS_BACKSTOP_FILE = 'asks-backstop.json';
export const ASKS_BACKSTOP_KEEP = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readBackstopClosed(root: string): DigestBackstopClosed[] {
  try {
    const s = JSON.parse(readFileSync(join(root, 'state', ASKS_BACKSTOP_FILE), 'utf8')) as { closed?: unknown };
    return Array.isArray(s?.closed) ? s.closed.filter((c): c is DigestBackstopClosed => !!c && typeof c === 'object'
      && typeof (c as DigestBackstopClosed).id === 'string' && typeof (c as DigestBackstopClosed).at === 'number') : [];
  } catch { return []; }
}

export function recordBackstopClosed(root: string, add: readonly DigestBackstopClosed[], now: number): void {
  if (add.length === 0) return;
  const keep = [...readBackstopClosed(root).filter((c) => now - c.at < 7 * DAY_MS), ...add].slice(-ASKS_BACKSTOP_KEEP);
  mkdirSync(join(root, 'state'), { recursive: true });
  atomicWriteJson(join(root, 'state', ASKS_BACKSTOP_FILE), { v: 1, closed: keep });
}

/** NEEDS-HUMAN-NO-ESCALATE-192: an inform or done an agent flagged needs_human (hive.ts writes them);
 *  god decides whether it is worth the Human's time. Asks go to ASK ME on their card instead. */
export interface DigestFlaggedForHuman { agentId: string; name?: string; card: string | null; id: string; subject: string; at: number }
/** Under state/: the flagged FYIs of the last week, newest last, at most NEEDS_HUMAN_FLAGGED_KEEP. */
export const NEEDS_HUMAN_FLAGGED_FILE = 'needs-human-flagged.json';
export const NEEDS_HUMAN_FLAGGED_KEEP = 200;

export function readFlaggedForHuman(root: string): DigestFlaggedForHuman[] {
  try {
    const s = JSON.parse(readFileSync(join(root, 'state', NEEDS_HUMAN_FLAGGED_FILE), 'utf8')) as { flagged?: unknown };
    return Array.isArray(s?.flagged) ? s.flagged.filter((c): c is DigestFlaggedForHuman => !!c && typeof c === 'object'
      && typeof (c as DigestFlaggedForHuman).id === 'string' && typeof (c as DigestFlaggedForHuman).at === 'number') : [];
  } catch { return []; }
}

export function recordFlaggedForHuman(root: string, add: readonly DigestFlaggedForHuman[], now: number): void {
  if (add.length === 0) return;
  const keep = [...readFlaggedForHuman(root).filter((c) => now - c.at < 7 * DAY_MS), ...add].slice(-NEEDS_HUMAN_FLAGGED_KEEP);
  mkdirSync(join(root, 'state'), { recursive: true });
  atomicWriteJson(join(root, 'state', NEEDS_HUMAN_FLAGGED_FILE), { v: 1, flagged: keep });
}

export interface FloorDigestInput {
  /** NEEDS-HUMAN-NO-ESCALATE-192: listed when any is from the last 24 h. */
  flaggedForHuman?: DigestFlaggedForHuman[];
  /** REQUESTS-AUTO-190: listed when any is from the last 24 h. */
  backstopClosed?: DigestBackstopClosed[];
  heldWakes?: DigestHeldWake[];
  silentTurns?: SilentTurn[];
  quietStalls?: DigestQuietStall[];
  wakeStalls?: DigestWakeStall[];
  refusedSettles?: DigestRefusedSettle[];
  mirrorOff?: DigestMirrorOff | null;
  messageBox?: DigestMessageBox[];
  floorStall?: DigestFloorStall | null;
  /** HIVE-DWIGHT-BG-REINVOKE: the floor hold god set (floorHold.ts), shown under the title. */
  floorHold?: FloorHold | null;
  modelHooks?: DigestModelHooks[];
  tasks: unknown;
  meta: Record<string, { statusSince: number; statusSinceExact?: boolean } | undefined>;
  flags: BoardFlag[];
  ledgerIssues: LedgerIssue[];
  agents: DigestAgent[];
  now: number;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export { ageText };

/** The decision items: decision flags, plus every ledger ERROR (a duplicate id, an unknown
 *  status), which only god can fix by hand. A STALE item's id carries the day, so it
 *  re-arms once a day while the card stays stale. */
export function decisionItems(flags: readonly BoardFlag[], ledgerIssues: readonly LedgerIssue[], now: number, heldWakes: readonly DigestHeldWake[] = [], silentTurns: readonly SilentTurn[] = [], quietStalls: readonly DigestQuietStall[] = [], wakeStalls: readonly DigestWakeStall[] = [], refusedSettles: readonly DigestRefusedSettle[] = []): DecisionItem[] {
  const items: DecisionItem[] = [];
  // One item per stall run (its id carries when the run began). A hold or a never-quiet terminal
  // already has its own item below, with what to do about it: one decision per agent, not two.
  const covered = new Set([...heldWakes.map((h) => h.agentId), ...quietStalls.map((q) => q.agentId)]);
  for (const s of wakeStalls) {
    if (covered.has(s.agentId) || s.why === 'held-interfered') continue;
    const who = s.name ?? s.agentId;
    items.push({
      id: `wake-stall:${s.agentId}:${s.since}`, cardId: null,
      line: `${who}: ${s.inboxIds} message(s) undrained for ${ageText(now - s.since)}, every automatic wake refused as "${s.why}" - look at ${who}'s terminal and chat box`
    });
  }
  // WAKE-STUCK-REFUSAL-ESCALATE: one item per run of identical refused settles on one incarnation
  // (its id carries the incarnation and when the run began: one wake of god per run). An agent
  // with a hold, a never-quiet terminal or a wake stall already has its item: one decision, not two.
  const stalled = new Set(wakeStalls.map((s) => s.agentId));
  for (const r of refusedSettles) {
    if (covered.has(r.agentId) || stalled.has(r.agentId)) continue;
    items.push({
      id: `wake-refusal-stuck:${r.agentId}:${r.incarnation}:${r.since}`, cardId: null,
      line: refusedStallLine(r, r.name ?? r.agentId, now)
    });
  }
  // One item per run of refusals (its id carries when the run began).
  for (const q of quietStalls) {
    const who = q.name ?? q.agentId;
    items.push({
      id: `wake-not-quiet:${q.agentId}:${q.since}`, cardId: null,
      line: `${who}: ${q.count} automatic wakes in a row refused over ${ageText(now - q.since)}, nothing typed, because ${who}'s terminal never went quiet (output-not-quiet) - its mail is not being delivered; look at ${who}'s terminal for something that keeps redrawing`
    });
  }
  // FLEET-LIVENESS-BLIND: shown working, no hook or tool call (silentTurn.ts). The id carries when
  // the silence began, so one silence wakes god once and a later one is a new decision.
  for (const s of silentTurns) {
    const who = s.name ?? s.agentId;
    const unread = s.mailWaiting > 0 ? `, ${s.mailWaiting} unread` : '';
    items.push(s.kind === 'silent'
      ? { id: `silent-turn:${s.agentId}:${s.since}`, cardId: null,
        line: `${who} is shown working but has made no hook or tool call for ${ageText(now - s.since)}${unread} - the turn may be hung; look at ${who}'s terminal (nothing was stopped or restarted)` }
      : { id: `tool-open-long:${s.agentId}:${s.since}`, cardId: null,
        line: `${who} has had one tool call (${s.tool ?? 'unknown'}) open for ${ageText(now - s.since)}${unread} - it may be hung or its end was lost; look at ${who}'s terminal (nothing was stopped or restarted)` });
  }
  // One item per hold (its id carries when it began, so a new hold is a new decision).
  for (const h of heldWakes) {
    const who = h.name ?? h.agentId;
    items.push({
      id: `held-interfered:${h.agentId}:${h.since}`, cardId: null,
      line: `${who}: ${h.messages} message(s) held for ${ageText(now - h.since)} after an interrupted automatic message - look at ${who}'s chat box (the banner says how), or rule it in ${who}'s message box (god: term read ${h.agentId}, then term rule ${h.agentId} send-again|already-handled --id ${h.requestId ?? '<requestId from term read>'})`
    });
  }
  for (const f of flags) {
    if (!f.decision) continue;
    // STALE re-arms daily; ASK_ANSWERED_IDLE re-arms only on a NEW answer (its since = the
    // latest answer's time), so an old answer wakes god once, and "parked": true silences it.
    const id = f.kind === 'STALE' ? `stale:${f.cardId}:${day(now)}`
      : f.kind === 'ASK_ANSWERED_IDLE' ? `ask_answered_idle:${f.cardId}:${f.since}`
        // READS-QUIET-NOREPLY: once per fix version (a new fixVersion is a new decision).
        : f.kind === 'SHIPPED_INSTALLED' ? `shipped_installed:${f.cardId}:${f.fixVersion ?? ''}`
          : `${f.kind.toLowerCase()}:${f.cardId}`;
    const ask: Record<string, string> = {
      STALE: 'still doing?',
      ASSIGNEE_UNKNOWN: 'reassign?',
      ASSIGNEE_DOWN: 'restart the agent or reassign?',
      ASSIGNEE_STUCK: 'unstick the agent or reassign?',
      ASK_ANSWERED_IDLE: 'answered: act on it and unblock',
      SHIPPED_INSTALLED: 'installed: verify the fix and close the card?'
    };
    items.push({ id, cardId: f.cardId, line: `${f.cardId}: ${f.evidence} - ${ask[f.kind] ?? 'decide'}` });
  }
  for (const i of ledgerIssues) {
    if (i.level !== 'error') continue;
    items.push({ id: i.key, cardId: i.cardId, line: `tasks.json: ${i.message} - which is canonical? Fix it by hand.` });
  }
  return items;
}

/** MIRROR-STARTUP-196: the mirror cost guard's auto-off (mirrorCost.ts MirrorOffStatus). */
export interface DigestMirrorOff { reason: string; since: number; offs: number; rearmAt: number }

/** One item per off (its id carries when it began, so each off wakes god once). */
export function mirrorOffItem(m: DigestMirrorOff, now: number): DecisionItem {
  const rearm = m.rearmAt > now ? `re-arms in ${ageText(m.rearmAt - now)}` : 're-arms on the next sample';
  return {
    id: `mirror-off:${m.since}`, cardId: null,
    line: `terminal mirrors auto-off for ${ageText(now - m.since)} (${m.reason}, off #${m.offs}); term read is refused (type/send still write, blind) until it ${rearm} - nothing to do unless it keeps going off (see mirror-auto-off in the log)`
  };
}

/** GTC M3: a Human message-box send nobody can vouch for (messageBox.ts): typed but not confirmed,
 *  typed but not sent, or a wait for idle that looks stale. */
export interface DigestMessageBox { agentId: string; name?: string; why: string; at: number }

/** One item per event (its id carries when it happened). */
export function messageBoxItem(m: DigestMessageBox, now: number): DecisionItem {
  const who = m.name ?? m.agentId;
  const what = m.why === 'UNKNOWN' ? 'was typed and Entered, but the agent never confirmed it'
    : m.why === 'STALE_WAIT' ? 'has waited over 5 min for the agent to go idle while its terminal is quiet (the hooks may be wrong)'
      : `was typed but not sent (${m.why})`;
  return {
    id: `message-box:${m.agentId}:${m.why}:${m.at}`, cardId: null,
    line: `${who}: the Human's message ${what}, ${ageText(now - m.at)} ago - term read ${m.agentId} (nothing is retried)`
  };
}

/** SCREEN-GUARD-ALERT-FLOOR-193: the floor-wide wake stall (wakeStall.ts FloorWakeStallWatch). */
export interface DigestFloorStall {
  since: number;
  agents: Array<{ agentId: string; name?: string; pending: number; since: number }>;
  refusals: number;
  top: { why: string; count: number } | null;
}

/** One item per stall (its id carries when the stall was first seen, so a stall wakes god once and
 *  the next one, after it cleared, is a new decision). */
export function floorStallItem(s: DigestFloorStall, now: number): DecisionItem {
  const who = s.agents.map((a) => `${a.name ?? a.agentId} ${a.pending}`).join(', ');
  const oldest = Math.min(...s.agents.map((a) => a.since));
  const top = s.top ? `; most refusals were "${s.top.why}" (${s.top.count} of ${s.refusals})` : '; no refusal was even recorded';
  return {
    id: `floor-wake-stall:${s.since}`, cardId: null,
    line: `floor: ${s.agents.length} agents have mail waiting with no wake committed and nothing delivered to them for ${ageText(now - oldest)} (${who})${top} - wake delivery looks stalled; look at a waiting agent's terminal (nothing was retried or restarted)`
  };
}

/** RULE-FIX-HOOK-NO-MODEL: a file Guppy does not own that gives a CLI model-invoking hooks
 *  (hive.ts modelHookWarnings). `stripped` = Guppy drops them from its agents' copies (the Codex
 *  seed); otherwise the CLI merges the file itself and only its owner can remove them. */
export interface DigestModelHooks { file: string; label: string; provider: string; findings: string; stripped: boolean; since: number }

/** One item per file and finding set (a changed set is a new decision; a fixed file drops out). */
export function modelHooksItem(m: DigestModelHooks, now: number): DecisionItem {
  const effect = m.stripped
    ? `Guppy drops them from every ${m.provider} agent's copy, but the file still has them`
    : `every ${m.provider} agent merges them in and calls a model on each event (silent usage burn)`;
  return {
    id: `hook-model:${createHash('sha1').update(`${m.file}\n${m.findings}`).digest('hex').slice(0, 12)}`, cardId: null,
    line: `${m.label} (${m.file}) has model-invoking hooks (${m.findings}), seen ${ageText(now - m.since)} ago: ${effect} - remove them or change them to command hooks (Guppy never edits this file)`
  };
}

type Card = Record<string, unknown> & { id: string };

export function buildFloorDigest(input: FloorDigestInput): { markdown: string; decisionItems: DecisionItem[] } {
  const { now } = input;
  const list = (() => {
    const t = input.tasks;
    const raw = Array.isArray(t) ? t : (t && typeof t === 'object' && Array.isArray((t as { tasks?: unknown }).tasks)) ? (t as { tasks: unknown[] }).tasks : [];
    return firstOccurrenceById(raw.filter((c): c is Card => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'), (c) => c.id);
  })();
  const items = decisionItems(input.flags, input.ledgerIssues, now, input.heldWakes ?? [], input.silentTurns ?? [], input.quietStalls ?? [], input.wakeStalls ?? [], input.refusedSettles ?? []);
  if (input.floorStall) items.unshift(floorStallItem(input.floorStall, now));
  if (input.mirrorOff) items.unshift(mirrorOffItem(input.mirrorOff, now));
  for (const m of input.messageBox ?? []) items.push(messageBoxItem(m, now));
  for (const m of input.modelHooks ?? []) items.push(modelHooksItem(m, now));
  const flagsByCard = new Map<string, BoardFlag[]>();
  for (const f of input.flags) flagsByCard.set(f.cardId, [...(flagsByCard.get(f.cardId) ?? []), f]);
  const age = (c: Card): string => {
    const m = input.meta[c.id];
    if (!m) return '';
    return ` (${m.statusSinceExact === false ? '>= ' : ''}${ageText(now - m.statusSince)})`;
  };
  const who = (c: Card): string => (typeof c.assignee === 'string' && c.assignee && c.assignee !== 'unassigned' ? c.assignee : 'unassigned');
  const out: string[] = [`# Floor digest`, '', `_Written by the harness at ${new Date(now).toISOString()}. Zero model tokens; do not edit._`, ''];
  if (input.floorHold) out.push(`**${floorHoldWords(input.floorHold, now)}**`, '');

  out.push('## Decisions needed', '');
  if (items.length === 0) out.push('None.');
  for (const i of items) out.push(`- [${i.id}] ${i.line}`);
  out.push('');

  out.push('## In flight', '');
  const doing = list.filter((c) => c.status === 'doing');
  if (doing.length === 0) out.push('Nothing in progress.');
  const byAgent = new Map<string, Card[]>();
  for (const c of doing) byAgent.set(who(c), [...(byAgent.get(who(c)) ?? []), c]);
  for (const [agent, cards] of [...byAgent].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`- ${agent}: ${cards.map((c) => `${c.id}${age(c)}`).join(', ')}`);
  }
  out.push('');

  out.push('## Blocked / ask-me', '');
  const openQs = (c: Card): number => (Array.isArray(c.humanQA) ? c.humanQA as Array<Record<string, unknown>> : [])
    .filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt).length;
  const blocked = list.filter((c) => c.status === 'blocked');
  // NEEDS-HUMAN-NO-ESCALATE-192: an agent's needs_human ask lands on its card without blocking it
  // (the board is god's): listed too, so god sets blocked when the work really waits.
  const asking = list.filter((c) => c.status !== 'blocked' && c.status !== 'done' && openQs(c) > 0);
  if (blocked.length === 0 && asking.length === 0) out.push('Nothing blocked.');
  for (const c of blocked) {
    const open = openQs(c);
    out.push(`- ${c.id} (${who(c)})${age(c)}${open ? `: ${open} question(s) for the Human` : ''}`);
  }
  for (const c of asking) out.push(`- ${c.id} (${who(c)})${age(c)}: ${openQs(c)} question(s) for the Human, card not blocked (set it blocked if the work waits)`);
  out.push('');

  out.push('## Flags', '');
  if (input.flags.length === 0) out.push('None.');
  for (const f of input.flags) out.push(`- ${f.kind} ${f.cardId}: ${f.evidence}${f.decision ? ' (decision)' : ''}`);
  for (const i of input.ledgerIssues.filter((x) => x.level === 'warning')) out.push(`- LEDGER ${i.cardId ?? ''}: ${i.message}`);
  out.push('');

  const backstop = (input.backstopClosed ?? []).filter((c) => now - c.at < DAY_MS);
  if (backstop.length) {
    out.push('## Asks closed by the backstop (last 24 h)', '');
    for (const c of backstop) out.push(`- ${c.agentId} <- ${c.from}: ${c.subject} (${c.id})`);
    out.push('');
  }

  const flagged = (input.flaggedForHuman ?? []).filter((c) => now - c.at < DAY_MS);
  if (flagged.length) {
    out.push('## Flagged for the Human (last 24 h)', '');
    for (const c of flagged) out.push(`- ${c.name ?? c.agentId} on ${c.card ?? 'no card'}: ${c.subject} (${c.id})`);
    out.push('');
  }

  out.push('## Roster', '');
  if (input.agents.length === 0) out.push('No agents.');
  for (const a of input.agents) {
    const state = a.onHold ? 'on hold' : a.liveness?.classification ? a.liveness.classification.toLowerCase() : 'unknown';
    const hold = a.liveness?.reason === 'operator-hold' ? ' (on hold)' : '';
    out.push(`- ${a.name ?? a.id} (${a.id}): ${state}${hold}; ${a.inboxBacklog ?? 0} message(s) waiting`);
  }
  out.push('');
  return { markdown: out.join('\n'), decisionItems: items };
}

/** fleet.json's agents, each joined with its liveness record: the top-level liveness[] that
 *  fix/177-liveness publishes (keyed by agentId) wins; an agents[].liveness is the fallback.
 *  Same precedence as BoardMonitor. */
export function readFleetAgents(root: string): DigestAgent[] {
  try {
    const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { agents?: DigestAgent[]; liveness?: Array<{ agentId?: string; classification?: string; reason?: string }> };
    const byId = new Map<string, { classification?: string; reason?: string }>();
    for (const r of Array.isArray(snap.liveness) ? snap.liveness : []) if (r && typeof r.agentId === 'string') byId.set(r.agentId, r);
    return (Array.isArray(snap.agents) ? snap.agents : [])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => (byId.has(a.id) ? { ...a, liveness: byId.get(a.id) } : a));
  } catch { return []; }
}

export interface WakeState {
  /** decision item id -> when god was woken for it. */
  woken: Record<string, number>;
  /** When the current batch window opened (the first not-yet-woken item was seen). */
  pendingSince: number | null;
}

/**
 * Pure wake policy. Wake god only for items it has not been woken for, and only once the
 * batch window (from the first such item) has passed; then one message carries all of them.
 * An item that is no longer current is forgotten, so a flag that clears and comes back
 * (or a STALE card on a new day, whose id changes) can wake again.
 */
export function decideGodWake(items: readonly DecisionItem[], state: WakeState, now: number, wakeBatchMs: number): { wake: DecisionItem[]; state: WakeState } {
  const current = new Set(items.map((i) => i.id));
  const woken: Record<string, number> = {};
  for (const [id, at] of Object.entries(state.woken)) if (current.has(id)) woken[id] = at;
  const fresh = items.filter((i) => !(i.id in woken));
  if (fresh.length === 0) return { wake: [], state: { woken, pendingSince: null } };
  const since = state.pendingSince ?? now;
  if (now - since < wakeBatchMs) return { wake: [], state: { woken, pendingSince: since } };
  for (const i of fresh) woken[i.id] = now;
  return { wake: fresh, state: { woken, pendingSince: null } };
}

export function wakeBody(items: readonly DecisionItem[], digestPath: string): string {
  return [
    ...items.map((i) => `- [${i.id}] ${i.line}`),
    '',
    `The full floor picture is in ${digestPath}.`
  ].join('\n');
}

/** What the scheduler needs from the app (narrow, so tests drive it without Electron). */
export interface FloorDigestHost {
  root(): string | null;
  tasks(): unknown;
  taskMeta(): Record<string, { statusSince: number; statusSinceExact?: boolean } | undefined>;
  flags(): BoardFlag[];
  ledgerIssues(): LedgerIssue[];
  /** DWIGHT-HELD-INTERFERED: held wakes the Human has been told about. Optional. */
  heldWakes?(): DigestHeldWake[];
  /** FLEET-LIVENESS-BLIND: agents shown working with no hook or tool call. Optional. */
  silentTurns?(): SilentTurn[];
  /** WAKE-STALL-INTERFERED-192: agents whose wakes keep being refused output-not-quiet. Optional. */
  quietStalls?(): DigestQuietStall[];
  /** WAKE-OWNER-HOLD-ORPHAN: every announced wake stall. Optional. */
  wakeStalls?(): DigestWakeStall[];
  /** WAKE-STUCK-REFUSAL-ESCALATE: runs of identical refused settles. Optional. */
  refusedSettles?(): DigestRefusedSettle[];
  /** MIRROR-STARTUP-196: the terminal mirrors' auto-off, while it lasts. Optional. */
  mirrorOff?(): DigestMirrorOff | null;
  /** GTC M3: the Human's message-box sends that need a look (the last hour). Optional. */
  messageBox?(): DigestMessageBox[];
  /** SCREEN-GUARD-ALERT-FLOOR-193: samples the floor's pending mail, then its stall if any. Optional. */
  floorStall?(): DigestFloorStall | null;
  /** HIVE-DWIGHT-BG-REINVOKE: the floor hold, while it is on. Optional. */
  floorHold?(): FloorHold | null;
  /** RULE-FIX-HOOK-NO-MODEL: model-invoking hooks in files Guppy does not own. Optional. */
  modelHooks?(): DigestModelHooks[];
  send(msg: { to: string; act: 'inform'; subject: string; body: string }, from: string): void;
  appendLog(row: Record<string, unknown>): void;
}

/** Atomic text publish (temp + rename), for the markdown files the harness renders. */
export function writeTextAtomic(p: string, text: string): void {
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  try { writeFileSync(tmp, text, 'utf8'); renameWithRetry(tmp, p); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch { /* keep the error */ } throw e; }
}

export class FloorDigest {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMarkdownBody = '';

  constructor(
    private readonly host: FloorDigestHost,
    private readonly cfg: () => FloorDigestConfig = () => FLOOR_DIGEST_DEFAULTS,
    private readonly now: () => number = Date.now
  ) {}

  private agents(root: string): DigestAgent[] { return readFleetAgents(root); }

  private loadState(root: string): WakeState {
    try {
      const s = JSON.parse(readFileSync(join(root, 'state', DIGEST_WOKEN_FILE), 'utf8')) as WakeState;
      if (s && typeof s.woken === 'object' && s.woken) return { woken: s.woken, pendingSince: typeof s.pendingSince === 'number' ? s.pendingSince : null };
    } catch { /* first run */ }
    return { woken: {}, pendingSince: null };
  }

  /** Build and write the digest, then wake god if the policy says so. Returns what it sent. */
  run(): DecisionItem[] {
    const root = this.host.root();
    if (!root || !this.cfg().enabled) return [];
    const now = this.now();
    const { markdown, decisionItems: items } = buildFloorDigest({
      tasks: this.host.tasks(), meta: this.host.taskMeta(), flags: this.host.flags(),
      ledgerIssues: this.host.ledgerIssues(), agents: this.agents(root), now,
      heldWakes: (() => { try { return this.host.heldWakes?.() ?? []; } catch { return []; } })(),
      silentTurns: (() => { try { return this.host.silentTurns?.() ?? []; } catch { return []; } })(),
      quietStalls: (() => { try { return this.host.quietStalls?.() ?? []; } catch { return []; } })(),
      wakeStalls: (() => { try { return this.host.wakeStalls?.() ?? []; } catch { return []; } })(),
      refusedSettles: (() => { try { return this.host.refusedSettles?.() ?? []; } catch { return []; } })(),
      mirrorOff: (() => { try { return this.host.mirrorOff?.() ?? null; } catch { return null; } })(),
      messageBox: (() => { try { return this.host.messageBox?.() ?? []; } catch { return []; } })(),
      floorStall: (() => { try { return this.host.floorStall?.() ?? null; } catch { return null; } })(),
      floorHold: (() => { try { return this.host.floorHold?.() ?? null; } catch { return null; } })(),
      modelHooks: (() => { try { return this.host.modelHooks?.() ?? []; } catch { return []; } })(),
      backstopClosed: readBackstopClosed(root),
      flaggedForHuman: readFlaggedForHuman(root)
    });
    // The timestamp line changes every run; rewrite the file only when the content did.
    const body = markdown.split('\n').filter((l) => !l.startsWith('_Written by the harness')).join('\n');
    if (body !== this.lastMarkdownBody) {
      try { writeTextAtomic(join(root, FLOOR_DIGEST_FILE), markdown); this.lastMarkdownBody = body; }
      catch (e) { this.host.appendLog({ kind: 'floor-digest-write-failed', error: String(e).slice(0, 300) }); }
    }
    const before = this.loadState(root);
    const { wake, state } = decideGodWake(items, before, now, this.cfg().wakeBatchMs);
    if (wake.length > 0) {
      // Jim: act INFORM. A request from 'digest' left god a reply obligation nobody could
      // close (one per wake); an inform from a non-system sender is still actionable mail.
      this.host.send({ to: 'god', act: 'inform', subject: `Floor: ${wake.length} decision(s)`, body: wakeBody(wake, join(root, FLOOR_DIGEST_FILE)) }, DIGEST_SENDER);
      this.host.appendLog({ kind: 'floor-digest-wake', items: wake.map((i) => i.id) });
    }
    if (JSON.stringify(state) !== JSON.stringify(before)) {
      try { mkdirSync(join(root, 'state'), { recursive: true }); atomicWriteJson(join(root, 'state', DIGEST_WOKEN_FILE), state); }
      catch (e) { this.host.appendLog({ kind: 'floor-digest-write-failed', error: String(e).slice(0, 300) }); }
    }
    return wake;
  }

  start(): void {
    this.stop();
    const tick = (): void => { try { this.run(); } catch (e) { try { this.host.appendLog({ kind: 'floor-digest-error', error: String(e).slice(0, 300) }); } catch { /* noop */ } } };
    tick();
    this.timer = setInterval(tick, this.cfg().digestEveryMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastMarkdownBody = '';
  }
}
