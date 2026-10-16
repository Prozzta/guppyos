/**
 * CLAIM-LEDGER W7: the Human's ledger UI (plan §3 W7). The view main sends the renderer, and the pure
 * history ("why does it believe X") both sides use. Every UI write is an APPEND (G7.1) except the
 * purge, which only the Human can start and confirm (G7.2); main owns every write.
 */
import type { ClaimKind, EventKind, LedgerLevel, Ref, Status } from './claims';

export const UI_STATUSES: readonly Status[] = ['live', 'superseded?', 'superseded', 'retracted', 'purged'];

export interface LedgerUiClaim {
  id: string; kind: ClaimKind; text: string; key?: string; source: string; at: string; wt: string;
  status: Status; supersededBy?: string; sightings: number; pinned: boolean; reasons: string[];
  refs?: Ref[]; ttl?: string | null; supersedes?: string[]; retracts?: string[];
  supersedesReason?: { category: string; note?: string };
}

export interface LedgerUiEvent {
  id: string; ev: EventKind; targets: string[]; by: 'code' | 'self' | 'human'; at: string;
  rule?: string; answer?: string; reason?: string;
  /** A later `revert` names this event, so derive ignores it. */
  reverted: boolean;
  /** The Human may revert it from the UI (see REVERTIBLE_EVENTS). */
  revertible: boolean;
}

export interface LedgerUiAgentView {
  agentId: string;
  /** The agent's effective ledger level. */
  level: LedgerLevel;
  /** Why the ledger is read-only (a chain break, a lost key), else null: nothing can be written. */
  readOnly: string | null;
  /** The verified prefix stops at this record (a chain break after it). */
  truncatedAt?: string;
  counts: Record<Status, number>;
  claims: LedgerUiClaim[];
  events: LedgerUiEvent[];
}

export interface LedgerUiSummary {
  /** The saved Settings level (absent = off) and what this build makes of it. */
  saved: string | null; effective: LedgerLevel;
  agents: Array<{ agentId: string; level: LedgerLevel; claims: number; readOnly: boolean }>;
}

export type LedgerUiResult = { ok: true; id?: string; note?: string } | { ok: false; error: string; cancelled?: true };

/**
 * The events a Human revert undoes. derive() makes a reverted event inert, so reverting one of these
 * restores the state before it (G5.4). Never: a revert (derive ignores a revert of a revert), a
 * purge (its content is gone), a rekey or a key-alias (key material), a status-mark (export only),
 * a sighting (CL-W7 S1: derive counts sightings without consulting reverts, so a revert would
 * change nothing).
 */
export const REVERTIBLE_EVENTS: ReadonlySet<EventKind> = new Set<EventKind>([
  'accept', 'dismiss', 'reconcile-answer', 'soft-supersede', 'inferred-supersede', 'pin', 'unpin',
]);

export interface HistoryItem {
  at: string;
  /** One plain sentence: what happened and why. */
  text: string;
  /** The record it comes from. */
  id: string;
  /** Set when the Human can revert this step (an event that is not reverted yet). */
  revert?: string;
  reverted?: true;
}

const short = (id: string): string => id;

/**
 * "Why does it believe X": every record that touched claim `id`, oldest first, from the receipts in
 * the view (its own record, claims that supersede or retract it or that it supersedes, and events that
 * name it), plus derive's reasons for its status now.
 */
export function claimHistory(view: Pick<LedgerUiAgentView, 'claims' | 'events'>, id: string): { items: HistoryItem[]; status: Status | null; reasons: string[] } {
  const claim = view.claims.find((c) => c.id === id);
  if (!claim) return { items: [], status: null, reasons: [] };
  const items: HistoryItem[] = [];
  const by = (src: string): string => (src === 'human' ? 'the Human' : src === 'self' ? 'the agent' : src === 'legacy' ? 'the memory.md import' : src.startsWith('mail:') ? `mail ${src.slice(5)}` : src);
  items.push({ at: claim.wt, id, text: `Written by ${by(claim.source)} as a ${claim.kind}${claim.key ? ` on key ${claim.key}` : ''}.` });
  for (const old of claim.supersedes ?? []) {
    items.push({ at: claim.wt, id, text: `It replaces ${short(old)}${claim.supersedesReason ? ` (${claim.supersedesReason.category}${claim.supersedesReason.note ? `: ${claim.supersedesReason.note}` : ''})` : ''}.` });
  }
  for (const gone of claim.retracts ?? []) items.push({ at: claim.wt, id, text: `It retracts ${short(gone)}.` });
  for (const c of view.claims) {
    if (c.id === id) continue;
    if (c.supersedes?.includes(id)) items.push({ at: c.wt, id: c.id, text: `${short(c.id)} by ${by(c.source)} replaces it${c.supersedesReason ? ` (${c.supersedesReason.category})` : ''}.` });
    if (c.retracts?.includes(id)) items.push({ at: c.wt, id: c.id, text: `${short(c.id)} by ${by(c.source)} retracts it.` });
  }
  for (const e of view.events) {
    if (!e.targets.includes(id)) continue;
    const who = e.by === 'human' ? 'the Human' : e.by === 'self' ? 'the agent' : 'the ledger rules';
    const role = e.targets.length >= 2 && (e.ev === 'reconcile-answer' || e.ev === 'soft-supersede' || e.ev === 'inferred-supersede')
      ? (e.targets[0] === id ? ' (this claim lost)' : ' (this claim won)') : '';
    const what: Record<string, string> = {
      sighting: 'seen again (an exact restatement)', 'inferred-supersede': 'replaced by an inferred supersede', 'soft-supersede': 'proposed as replaced (newest wins)',
      'reconcile-answer': `a reconcile answer: ${e.answer ?? '?'}`, accept: 'accepted', dismiss: 'dismissed', pin: 'pinned', unpin: 'unpinned',
      purge: 'purged (its content was erased)', 'status-mark': 'status marked', 'key-alias': 'key aliased', revert: 'a step was reverted', rekey: 'rekeyed',
    };
    items.push({
      at: e.at, id: e.id,
      text: `${what[e.ev] ?? e.ev} by ${who}${e.rule ? ` (rule ${e.rule})` : ''}${role}${e.reason ? `: ${e.reason}` : ''}.`,
      ...(e.revertible && !e.reverted ? { revert: e.id } : {}),
      ...(e.reverted ? { reverted: true as const } : {}),
    });
  }
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { items, status: claim.status, reasons: claim.reasons };
}

/** The label and tone of a status badge. */
export function statusBadge(s: Status): { label: string; tone: 'ok' | 'warn' | 'muted' | 'danger' } {
  switch (s) {
    case 'live': return { label: 'live', tone: 'ok' };
    case 'superseded?': return { label: 'superseded?', tone: 'warn' };
    case 'superseded': return { label: 'superseded', tone: 'muted' };
    case 'retracted': return { label: 'retracted', tone: 'muted' };
    case 'purged': return { label: 'purged', tone: 'danger' };
  }
}

/**
 * Jim's G7.3 SHOULD 1: why a ledger is read-only, in plain words, and the way out (view.readOnly is
 * "<reason> at <where>"). There is no rekey or restore button in Settings yet, so it names who acts.
 */
export function readOnlyText(readOnly: string): string {
  const m = /^(\S+) at (.*)$/.exec(readOnly);
  const reason = m ? m[1] : '';
  const raw = m ? m[2] : readOnly;
  const where = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  const why = reason === 'mac' ? `its integrity check failed at ${where}: a record was changed after it was written`
    : reason === 'prev' && where === 'head-anchor' ? 'records are missing from its end: the ledger was cut or replaced'
    : reason === 'prev' ? `its chain of records breaks at ${where}: a record was removed, added or reordered`
    : reason === 'parse' ? `a line at ${where} cannot be read`
    : reason === 'key-missing' ? "this machine's ledger key is missing, so its records cannot be checked"
    : `its check failed (${readOnly})`;
  return `This ledger is locked because ${why}. Nothing is written to it until it is fixed. `
    + 'The way out: ask god to review it; the fix is restoring a backup day, or your anchor reset after that review (neither is a button in Settings yet).';
}

/**
 * CL-M4-CHAINS-PANEL (Jim's CL-M4 backlog prefilter, option a; the Human's choice): "possible
 * duplicates". Live claims of one ledger that share a label (key) or name the same card, grouped,
 * newest first, for the Human or the owner to pick which stays live. 0 tokens and nothing automatic:
 * this only lists; each choice is a Human reconcile answer (revertible) that main writes.
 */
export interface DupChain {
  /** Stable id of the group: `key:<key>` or `card:<CARD>` (joined with `+` when the same claims share several). */
  id: string;
  reasons: Array<{ kind: 'key' | 'card'; value: string }>;
  /** The live claims, newest first (by write time, then id). */
  members: string[];
}

/**
 * Card ids in a note (Jim's calibration rule): upper-case hyphenated tokens like CL-M4-FORWARD-PATH,
 * a trailing build number dropped (TES-BUBBLE-NITS-189 -> TES-BUBBLE-NITS). A `card.<id>` key names its card too.
 */
export function claimCardIds(text: string, key?: string): string[] {
  const fromKey = key?.startsWith('card.') ? key.slice(5).toUpperCase() : '';
  const toks = `${text} ${fromKey}`.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(toks.map((t) => t.replace(/-\d+$/, '')).filter((t) => t.includes('-')))];
}

const pairOf = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Pairs already said to both stand (a keep-both answer, or a dismissed pair) and not reverted. */
export function settledPairs(events: LedgerUiEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.reverted || e.targets.length < 2) continue;
    if ((e.ev === 'reconcile-answer' && e.answer === 'keep-both') || e.ev === 'dismiss') out.add(pairOf(e.targets[0], e.targets[1]));
  }
  return out;
}

const newestFirst = (a: LedgerUiClaim, b: LedgerUiClaim): number =>
  a.wt < b.wt ? 1 : a.wt > b.wt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The groups of 2+ live claims sharing a key or a card id, the group with the newest claim first.
 * A group is left out once every older member was said to stand beside the newest (keep-both);
 * a newer claim joining it brings it back.
 */
export function duplicateChains(view: Pick<LedgerUiAgentView, 'claims' | 'events'>): DupChain[] {
  const groups = new Map<string, { kind: 'key' | 'card'; value: string; members: LedgerUiClaim[] }>();
  const add = (kind: 'key' | 'card', value: string, c: LedgerUiClaim): void => {
    const gid = `${kind}:${value}`;
    let g = groups.get(gid);
    if (!g) groups.set(gid, (g = { kind, value, members: [] }));
    g.members.push(c);
  };
  for (const c of view.claims) {
    if (c.status !== 'live') continue;
    if (c.key) add('key', c.key, c);
    for (const card of claimCardIds(c.text, c.key)) add('card', card, c);
  }
  const settled = settledPairs(view.events);
  const bySet = new Map<string, DupChain & { top: LedgerUiClaim }>();
  for (const gid of [...groups.keys()].sort()) {
    const g = groups.get(gid)!;
    if (g.members.length < 2) continue;
    const members = g.members.slice().sort(newestFirst);
    const [top, ...older] = members;
    if (older.every((c) => settled.has(pairOf(c.id, top.id)))) continue;
    const ids = members.map((c) => c.id);
    const have = bySet.get(ids.join(','));
    if (have) { have.id = `${have.id}+${gid}`; have.reasons.push({ kind: g.kind, value: g.value }); continue; }
    bySet.set(ids.join(','), { id: gid, reasons: [{ kind: g.kind, value: g.value }], members: ids, top });
  }
  return [...bySet.values()]
    .sort((a, b) => newestFirst(a.top, b.top) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, reasons, members }) => ({ id, reasons, members }));
}

/** The plain heading of a group for the Human. */
export function chainTitle(ch: Pick<DupChain, 'reasons'>): string {
  const parts = ch.reasons.map((r) => (r.kind === 'card' ? `about card ${r.value}` : `filed under the label "${r.value}"`));
  return `Notes ${parts.join(', and ')}`;
}
