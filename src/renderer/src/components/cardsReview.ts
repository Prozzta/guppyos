/**
 * CARDS-TAB-190: the pure model behind the CARDS review tab. The Human reads cards here; it is
 * not a second kanban, so nothing in this file writes anything.
 *
 * One ReviewCard per tasks.json card (parseTasks owns the membership, the dedup and the typed
 * core fields; the raw record supplies what the kanban does not type: notes, result, parked,
 * waitingFor, fixVersion, doneAt, ...). The god and the ledger command append to `notes` and
 * `result` as `[<iso>] text` lines: those become one dated timeline, newest first. Text before
 * the first stamp (a hand-written result, an old note) is kept as an undated entry, never lost.
 */
import { normalizeHumanQA, type HumanQAFields } from './humanQuestion';
import type { HiveTask } from './TasksKanban';

export type CardStatus = HiveTask['status'];

export interface TimelineEntry {
  /** The `[iso]` stamp as written, or null for text that carried none. */
  at: string | null;
  /** Epoch ms of `at`, or null (undated or unparseable). */
  ms: number | null;
  text: string;
  source: 'note' | 'result';
}

/** The status-age sidecar entry (state/task-meta.json `cards[id]`), as the kanban reads it. */
export interface CardMeta { statusSince?: number; statusSinceExact?: boolean; lastEditAt?: number }

export interface ReviewCard {
  id: string;
  title: string;
  status: CardStatus;
  assignee?: string;
  /** As written: a number (P0 = most urgent) or a word ("high"); null when the card has none. */
  priority: string | null;
  description?: string;
  /** The latest result entry's text (the release link, the hash ...), or null. */
  result: string | null;
  /** Notes and results, newest first; undated entries after the dated ones, in written order. */
  timeline: TimelineEntry[];
  /** The full humanQA history, oldest first, each validated as ASK ME validates it. */
  humanQA: (HumanQAFields & { dismissedAt?: string })[];
  parked?: boolean;
  waitingFor?: string;
  fixVersion?: string;
  createdAt: string;
  doneAt?: string;
  meta?: CardMeta;
  /** Newest activity anywhere on the card (epoch ms), the sort key. */
  lastActivity: number;
}

const STAMP = /^\s*\[(\d{4}-\d{2}-\d{2}T[^\]\s]*)\]\s?(.*)$/;

/** `[iso] text` lines -> entries. A line without a stamp continues the entry above it (or opens
 *  an undated one at the top). Empty entries are dropped. */
export function parseTimeline(text: unknown, source: TimelineEntry['source']): TimelineEntry[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out: TimelineEntry[] = [];
  let cur: TimelineEntry | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = STAMP.exec(line);
    if (m) {
      const ms = Date.parse(m[1]);
      cur = { at: m[1], ms: Number.isFinite(ms) ? ms : null, text: m[2], source };
      out.push(cur);
    } else if (cur) {
      cur.text += `\n${line}`;
    } else if (line.trim()) {
      cur = { at: null, ms: null, text: line, source };
      out.push(cur);
    }
  }
  return out.map((e) => ({ ...e, text: e.text.trim() })).filter((e) => e.text);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const ms = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** Newest first; undated entries keep their written order after the dated ones. */
function newestFirst(entries: TimelineEntry[]): TimelineEntry[] {
  const dated = entries.filter((e) => e.ms !== null).sort((a, b) => b.ms! - a.ms!);
  return [...dated, ...entries.filter((e) => e.ms === null)];
}

/** One review card from the typed task, its raw record and its status-age entry. */
export function reviewCardOf(task: HiveTask, raw: Record<string, unknown> | undefined, meta: CardMeta | undefined): ReviewCard {
  const r = raw ?? {};
  const results = parseTimeline(r.result, 'result');
  const timeline = newestFirst([...parseTimeline(r.notes, 'note'), ...parseTimeline(r.note, 'note'), ...results]);
  // The latest result: the newest dated one, else the last one written.
  const datedResults = results.filter((e) => e.ms !== null).sort((a, b) => b.ms! - a.ms!);
  const result = (datedResults[0] ?? results[results.length - 1])?.text ?? null;
  const humanQA = (Array.isArray(r.humanQA) ? r.humanQA : []).flatMap((e) => {
    const n = normalizeHumanQA(e);
    if (!n) return [];
    const d = e && typeof e === 'object' ? str((e as { dismissedAt?: unknown }).dismissedAt) : undefined;
    return [d ? { ...n, dismissedAt: d } : n];
  });
  const p = r.priority ?? r.prio;
  const stamps = [
    ms(task.createdAt), ms(r.doneAt), ms(r.updatedAt), ms(r.startedAt),
    meta?.statusSince ?? null, meta?.lastEditAt ?? null,
    ...timeline.map((e) => e.ms),
    ...humanQA.flatMap((q) => [ms(q.askedAt), ms(q.answeredAt), ms((q as { dismissedAt?: string }).dismissedAt)])
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    priority: typeof p === 'number' && Number.isFinite(p) ? `P${p}` : str(p) ?? null,
    description: task.description,
    result,
    timeline,
    humanQA,
    ...(r.parked === true ? { parked: true } : {}),
    ...(str(r.waitingFor) ? { waitingFor: str(r.waitingFor) } : {}),
    ...(str(r.fixVersion) ? { fixVersion: str(r.fixVersion) } : {}),
    createdAt: task.createdAt,
    ...(str(r.doneAt) ? { doneAt: str(r.doneAt) } : {}),
    ...(meta ? { meta } : {}),
    lastActivity: stamps.length ? Math.max(...stamps) : 0
  };
}

/** Every card of the ledger, newest activity first (ties by id, so the order is stable). */
export function reviewCards(tasks: HiveTask[], rawById: Map<string, Record<string, unknown>>, meta: Record<string, CardMeta>): ReviewCard[] {
  return tasks
    .map((t) => reviewCardOf(t, rawById.get(t.id), meta[t.id]))
    .sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
}

/** The raw records by id: the FIRST record of an id, the same rule parseTasks applies. */
export function rawById(raw: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks) ? (raw as { tasks: unknown[] }).tasks : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const id = (t as { id?: unknown }).id;
    if (typeof id === 'string' && id && !out.has(id)) out.set(id, t as Record<string, unknown>);
  }
  return out;
}

export interface CardFilter {
  /** 'all' or one status. Choosing 'done' shows done cards whatever `showDone` says. */
  status: 'all' | CardStatus;
  /** 'all', an agent id, or '' for unassigned cards. */
  assignee: string;
  /** Case-insensitive; matched against the id, title, assignee (id and name), notes, result,
   *  description and the humanQA text. */
  text: string;
  showDone: boolean;
}

export const DEFAULT_FILTER: CardFilter = { status: 'all', assignee: 'all', text: '', showDone: false };

export function filterCards(cards: ReviewCard[], f: CardFilter, nameFor: (id?: string) => string | undefined = () => undefined): ReviewCard[] {
  const q = f.text.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.status !== 'all' && c.status !== f.status) return false;
    if (f.status === 'all' && !f.showDone && c.status === 'done') return false;
    if (f.assignee !== 'all' && (c.assignee ?? '') !== f.assignee) return false;
    if (!q) return true;
    const hay = [
      c.id, c.title, c.assignee, nameFor(c.assignee), c.description, c.result, c.waitingFor, c.fixVersion,
      ...c.timeline.map((e) => e.text), ...c.humanQA.flatMap((e) => [e.q, e.a])
    ].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  });
}

/** Text longer than this is collapsed behind "show more". */
export const COLLAPSE_CHARS = 480;
/** Timeline entries shown before "show N more". */
export const TIMELINE_SHOWN = 3;

/** The collapsed form of a long text: cut at a line or word boundary near the limit. */
export function collapsed(text: string, limit = COLLAPSE_CHARS): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const head = text.slice(0, limit);
  const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
  return { text: `${(at > limit * 0.6 ? head.slice(0, at) : head).trimEnd()}…`, cut: true };
}
