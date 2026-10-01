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
import { randomBytes } from 'node:crypto';
import { atomicWriteJson, renameWithRetry } from './atomicJson';
import type { BoardFlag } from '../shared/boardStale';
import { firstOccurrenceById, type LedgerIssue } from '../shared/taskLedger';
import { ageText } from '../shared/agentBadges';

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

export interface FloorDigestInput {
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
export function decisionItems(flags: readonly BoardFlag[], ledgerIssues: readonly LedgerIssue[], now: number): DecisionItem[] {
  const items: DecisionItem[] = [];
  for (const f of flags) {
    if (!f.decision) continue;
    // STALE re-arms daily; ASK_ANSWERED_IDLE re-arms only on a NEW answer (its since = the
    // latest answer's time), so an old answer wakes god once, and "parked": true silences it.
    const id = f.kind === 'STALE' ? `stale:${f.cardId}:${day(now)}`
      : f.kind === 'ASK_ANSWERED_IDLE' ? `ask_answered_idle:${f.cardId}:${f.since}`
        : `${f.kind.toLowerCase()}:${f.cardId}`;
    const ask: Record<string, string> = {
      STALE: 'still doing?',
      ASSIGNEE_UNKNOWN: 'reassign?',
      ASSIGNEE_DOWN: 'restart the agent or reassign?',
      ASSIGNEE_STUCK: 'unstick the agent or reassign?',
      ASK_ANSWERED_IDLE: 'answered: act on it and unblock'
    };
    items.push({ id, cardId: f.cardId, line: `${f.cardId}: ${f.evidence} - ${ask[f.kind] ?? 'decide'}` });
  }
  for (const i of ledgerIssues) {
    if (i.level !== 'error') continue;
    items.push({ id: i.key, cardId: i.cardId, line: `tasks.json: ${i.message} - which is canonical? Fix it by hand.` });
  }
  return items;
}

type Card = Record<string, unknown> & { id: string };

export function buildFloorDigest(input: FloorDigestInput): { markdown: string; decisionItems: DecisionItem[] } {
  const { now } = input;
  const list = (() => {
    const t = input.tasks;
    const raw = Array.isArray(t) ? t : (t && typeof t === 'object' && Array.isArray((t as { tasks?: unknown }).tasks)) ? (t as { tasks: unknown[] }).tasks : [];
    return firstOccurrenceById(raw.filter((c): c is Card => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'), (c) => c.id);
  })();
  const items = decisionItems(input.flags, input.ledgerIssues, now);
  const flagsByCard = new Map<string, BoardFlag[]>();
  for (const f of input.flags) flagsByCard.set(f.cardId, [...(flagsByCard.get(f.cardId) ?? []), f]);
  const age = (c: Card): string => {
    const m = input.meta[c.id];
    if (!m) return '';
    return ` (${m.statusSinceExact === false ? '>= ' : ''}${ageText(now - m.statusSince)})`;
  };
  const who = (c: Card): string => (typeof c.assignee === 'string' && c.assignee && c.assignee !== 'unassigned' ? c.assignee : 'unassigned');
  const out: string[] = [`# Floor digest`, '', `_Written by the harness at ${new Date(now).toISOString()}. Zero model tokens; do not edit._`, ''];

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
  const blocked = list.filter((c) => c.status === 'blocked');
  if (blocked.length === 0) out.push('Nothing blocked.');
  for (const c of blocked) {
    const qa = Array.isArray(c.humanQA) ? c.humanQA as Array<Record<string, unknown>> : [];
    const open = qa.filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt).length;
    out.push(`- ${c.id} (${who(c)})${age(c)}${open ? `: ${open} question(s) for the Human` : ''}`);
  }
  out.push('');

  out.push('## Flags', '');
  if (input.flags.length === 0) out.push('None.');
  for (const f of input.flags) out.push(`- ${f.kind} ${f.cardId}: ${f.evidence}${f.decision ? ' (decision)' : ''}`);
  for (const i of input.ledgerIssues.filter((x) => x.level === 'warning')) out.push(`- LEDGER ${i.cardId ?? ''}: ${i.message}`);
  out.push('');

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
  send(msg: { to: string; act: 'request'; subject: string; body: string }, from: string): void;
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

  private agents(root: string): DigestAgent[] {
    try {
      const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { agents?: DigestAgent[] };
      return Array.isArray(snap.agents) ? snap.agents.filter((a) => a && typeof a.id === 'string') : [];
    } catch { return []; }
  }

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
      ledgerIssues: this.host.ledgerIssues(), agents: this.agents(root), now
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
      this.host.send({ to: 'god', act: 'request', subject: `Floor: ${wake.length} decision(s)`, body: wakeBody(wake, join(root, FLOOR_DIGEST_FILE)) }, DIGEST_SENDER);
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
