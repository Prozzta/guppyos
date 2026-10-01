/**
 * ZT-I3 §3.5: `hive/board-status.md`, rendered by the harness. It replaces the CURRENT STATE
 * block god kept by hand in board.md (which once said "Installed: 1.1.67" while 1.1.72 ran):
 * what is installed and running, work in flight, blocked and ask-me cards, flags, what was
 * done in the last 24 h, and the roster. board.md stays god's narrative and decision log.
 *
 * `renderBoardStatus` is pure. The version comes from the newest `app-start` row in
 * log.jsonl (what is actually running), never from a hand-written string.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardFlag } from '../shared/boardStale';
import { firstOccurrenceById } from '../shared/taskLedger';
import { ageText, writeTextAtomic, type DigestAgent } from './floorDigest';

export const BOARD_STATUS_FILE = 'board-status.md';
export const BOARD_STATUS_MIN_INTERVAL_MS = 10_000;

export interface AppStart { ts: number; version: string; packaged?: boolean }

export interface BoardStatusInput {
  tasks: unknown;
  meta: Record<string, { statusSince: number; statusSinceExact?: boolean; history?: Array<{ at: number; to: string }> } | undefined>;
  flags: BoardFlag[];
  agents: DigestAgent[];
  appStart: AppStart | null;
  now: number;
}

type Card = Record<string, unknown> & { id: string };

/** The newest `app-start` row in a log.jsonl text (the build that is running now). */
export function latestAppStart(logText: string): AppStart | null {
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"app-start"')) continue;
    try {
      const row = JSON.parse(line) as { kind?: string; ts?: number; version?: string; packaged?: boolean };
      if (row.kind === 'app-start' && typeof row.ts === 'number' && typeof row.version === 'string') {
        return { ts: row.ts, version: row.version, packaged: row.packaged };
      }
    } catch { /* a torn line */ }
  }
  return null;
}

/** Read the newest app-start from the hive log (the current file; it is written at launch). */
export function readAppStart(root: string): AppStart | null {
  const p = join(root, 'log.jsonl');
  if (!existsSync(p)) return null;
  try { return latestAppStart(readFileSync(p, 'utf8')); } catch { return null; }
}

export function renderBoardStatus(input: BoardStatusInput): string {
  const { now } = input;
  const raw = (() => {
    const t = input.tasks;
    return Array.isArray(t) ? t : (t && typeof t === 'object' && Array.isArray((t as { tasks?: unknown }).tasks)) ? (t as { tasks: unknown[] }).tasks : [];
  })();
  const list = firstOccurrenceById(raw.filter((c): c is Card => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string'), (c) => c.id);
  const who = (c: Card): string => (typeof c.assignee === 'string' && c.assignee && c.assignee !== 'unassigned' ? c.assignee : 'unassigned');
  const age = (c: Card): string => {
    const m = input.meta[c.id];
    return m ? `${m.statusSinceExact === false ? '>= ' : ''}${ageText(now - m.statusSince)}` : '?';
  };
  const title = (c: Card): string => (typeof c.title === 'string' ? c.title : '');
  const flagsFor = (id: string): string => input.flags.filter((f) => f.cardId === id).map((f) => f.kind).join(', ');

  const out: string[] = ['# Board status', '', `_Rendered by the harness at ${new Date(now).toISOString()} from tasks.json, its flags and fleet.json. Do not edit; board.md is the narrative._`, ''];
  out.push('## Installed / running', '');
  out.push(input.appStart
    ? `Munder Difflin ${input.appStart.version}${input.appStart.packaged === false ? ' (dev build)' : ''}, started ${new Date(input.appStart.ts).toISOString()}.`
    : 'Unknown (no app-start row in log.jsonl yet).');
  out.push('');

  out.push('## In flight', '');
  const doing = list.filter((c) => c.status === 'doing');
  if (doing.length === 0) out.push('Nothing in progress.');
  else {
    out.push('| Card | Assignee | Doing for | Flags |', '|---|---|---|---|');
    for (const c of doing) out.push(`| ${c.id}: ${title(c)} | ${who(c)} | ${age(c)} | ${flagsFor(c.id)} |`);
  }
  out.push('');

  out.push('## Blocked / ask-me', '');
  const blocked = list.filter((c) => c.status === 'blocked');
  if (blocked.length === 0) out.push('Nothing blocked.');
  for (const c of blocked) {
    const qa = Array.isArray(c.humanQA) ? c.humanQA as Array<Record<string, unknown>> : [];
    const open = qa.filter((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt).length;
    out.push(`- ${c.id} (${who(c)}, ${age(c)})${open ? `: ${open} question(s) for the Human` : ''}${flagsFor(c.id) ? ` [${flagsFor(c.id)}]` : ''}`);
  }
  out.push('');

  out.push('## Flags', '');
  if (input.flags.length === 0) out.push('None.');
  for (const f of input.flags) out.push(`- ${f.kind} ${f.cardId}: ${f.evidence}`);
  out.push('');

  out.push('## Done in the last 24 h', '');
  const recent = list.filter((c) => {
    if (c.status !== 'done') return false;
    const h = input.meta[c.id]?.history ?? [];
    return h.some((e) => e.to === 'done' && now - e.at <= 24 * 60 * 60_000);
  });
  if (recent.length === 0) out.push('None recorded.');
  for (const c of recent) out.push(`- ${c.id} (${who(c)}): ${title(c)}`);
  out.push('');

  out.push('## Roster', '');
  if (input.agents.length === 0) out.push('No agents.');
  for (const a of input.agents) {
    const state = a.onHold ? 'on hold' : a.liveness?.classification ? a.liveness.classification.toLowerCase() : 'unknown';
    const doingCount = doing.filter((c) => who(c) === a.id).length;
    out.push(`- ${a.name ?? a.id} (${a.id}): ${state}; ${doingCount} doing; ${a.inboxBacklog ?? 0} message(s) waiting`);
  }
  out.push('');
  return out.join('\n');
}

/** What the writer needs from the app (narrow, so tests drive it without Electron). */
export interface BoardStatusHost {
  root(): string | null;
  tasks(): unknown;
  taskMeta(): BoardStatusInput['meta'];
  flags(): BoardFlag[];
}

/** Writes board-status.md on each ledger or flag change, at most once per
 *  BOARD_STATUS_MIN_INTERVAL_MS (a burst of changes folds into one trailing write). */
export class BoardStatusWriter {
  private lastWriteAt = -Infinity;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: BoardStatusHost, private readonly now: () => number = Date.now) {}

  /** Render and write now. Returns the markdown (or null with no hive). */
  write(): string | null {
    const root = this.host.root();
    if (!root) return null;
    let agents: DigestAgent[] = [];
    try {
      const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { agents?: DigestAgent[] };
      agents = Array.isArray(snap.agents) ? snap.agents.filter((a) => a && typeof a.id === 'string') : [];
    } catch { /* no fleet snapshot yet */ }
    const now = this.now();
    const md = renderBoardStatus({ tasks: this.host.tasks(), meta: this.host.taskMeta(), flags: this.host.flags(), agents, appStart: readAppStart(root), now });
    writeTextAtomic(join(root, BOARD_STATUS_FILE), md);
    this.lastWriteAt = now;
    return md;
  }

  /** A change happened: write now, or once the minimum interval has passed. */
  request(): void {
    if (this.pending) return;
    const wait = BOARD_STATUS_MIN_INTERVAL_MS - (this.now() - this.lastWriteAt);
    if (wait <= 0) { try { this.write(); } catch { /* the next change retries */ } return; }
    this.pending = setTimeout(() => { this.pending = null; try { this.write(); } catch { /* the next change retries */ } }, wait);
    this.pending.unref?.();
  }

  stop(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
  }
}
