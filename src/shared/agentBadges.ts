/**
 * CARD-BADGE-AMBIGUOUS: what the two badges on a player card say. The Human read the bare
 * "2" on the old "doing" sticky note as unread mail, because it was the only number on the
 * card. Now:
 *   - the TASK chip always shows a clipboard glyph AND the count (also for 1), names the
 *     word "task" in its title, and turns amber with "!" when one of the agent's doing
 *     cards is flagged (stale, down, stuck, unknown assignee);
 *   - a separate, differently shaped MAIL badge shows messages waiting (not yet acted on,
 *     `inboxBacklog` since ZT-I1-MAIL), only when there are any. "Unread" would be wrong:
 *     the count is mail not yet acted on (Jim C6).
 * Pure, so main, the renderer and the tests agree on the words.
 */
import { firstOccurrenceById } from './taskLedger';

export interface BadgeFlag { cardId: string; kind: string; agentId: string; evidence: string }

export interface AgentBadge {
  /** The agent's doing card ids (first copy of a duplicate id only). */
  doing: string[];
  /** One short line per flag on those cards, e.g. "stale: ZT-I1-MAIL". */
  flagged: string[];
}

export const TASK_GLYPH = '📋';
export const MAIL_GLYPH = '✉';

const FLAG_WORDS: Record<string, string> = {
  STALE: 'stale', ASSIGNEE_DOWN: 'agent down', ASSIGNEE_STUCK: 'agent stuck',
  ASSIGNEE_UNKNOWN: 'unknown assignee', DOING_MANY: 'too many doing', ASSIGNEE_ARCHIVED: 'agent archived'
};

/** Per-agent doing cards and their flags. A card whose assignee was archived is not counted
 *  (the board monitor moves it back to todo). */
export function agentBadges(tasks: unknown, flags: readonly BadgeFlag[]): Record<string, AgentBadge> {
  const raw = Array.isArray(tasks) ? tasks
    : (tasks && typeof tasks === 'object' && Array.isArray((tasks as { tasks?: unknown }).tasks)) ? (tasks as { tasks: unknown[] }).tasks : [];
  const cards = firstOccurrenceById(
    raw.filter((t): t is { id: string; status?: unknown; assignee?: unknown } => !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string' && !!(t as { id: string }).id),
    (t) => t.id);
  const archived = new Set(flags.filter((f) => f.kind === 'ASSIGNEE_ARCHIVED').map((f) => f.cardId));
  const out: Record<string, AgentBadge> = {};
  for (const t of cards) {
    if (t.status !== 'doing' || typeof t.assignee !== 'string' || !t.assignee || t.assignee === 'unassigned') continue;
    if (archived.has(t.id)) continue;
    const b = (out[t.assignee] = out[t.assignee] ?? { doing: [], flagged: [] });
    b.doing.push(t.id);
    for (const f of flags) {
      if (f.cardId === t.id && f.kind !== 'ASSIGNEE_ARCHIVED') b.flagged.push(`${FLAG_WORDS[f.kind] ?? f.kind.toLowerCase()}: ${t.id}`);
    }
  }
  return out;
}

/** A status age for people: minutes, hours, then days. */
export function ageText(ms: number): string {
  if (ms < 60 * 60_000) return `${Math.max(0, Math.round(ms / 60_000))} min`;
  if (ms < 48 * 60 * 60_000) return `${Math.round(ms / 360_000) / 10} h`;
  return `${Math.round(ms / 8_640_000) / 10} d`;
}

/** The Kanban's "doing for" text: ">=" when the guard could only bound the age (install). */
export function statusAgeText(meta: { statusSince?: unknown; statusSinceExact?: unknown } | undefined, now: number): string {
  if (!meta || typeof meta.statusSince !== 'number') return '';
  return `${meta.statusSinceExact === false ? '>= ' : ''}${ageText(now - meta.statusSince)}`;
}

export function taskChipText(count: number): string {
  return `${TASK_GLYPH}${count}`;
}

export function taskChipTitle(count: number, flagged: readonly string[]): string {
  const base = `${count} task${count === 1 ? '' : 's'} in progress (doing): click to open`;
  return flagged.length ? `${base}\n! ${flagged.join('; ')}` : base;
}

export function mailBadgeTitle(count: number): string {
  return `${count} message${count === 1 ? '' : 's'} waiting`;
}
