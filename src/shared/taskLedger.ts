/**
 * Non-destructive edits to the task ledger (`hive/tasks.json`).
 *
 * The ledger is a HAND-WRITTEN file: the god appends whatever fields a card
 * needs — `result` (the verbatim Slack reply posted back to the user), `repo`,
 * `scope`, `origin`, `deliverable`, `commit`, `blockedOn`, `notes` — none of
 * which the renderer's display model knows about. Several UI surfaces write the
 * ledger back after a small edit (answer a question, move a card, dismiss one),
 * and `hive:writeTasks` replaces the file wholesale. So any writer holding a
 * partial model of a card silently DELETED every field it didn't know about,
 * on EVERY card on the board, the moment the user touched one of them.
 *
 * Two rules fix that, and both live here so main and the renderer share them:
 *
 *   - `mergeTaskLedger` — the persistence-side backstop. A card the writer
 *     didn't fully describe keeps the fields it already had on disk.
 *   - `patchTaskInLedger` — the caller-side rule. Edit the RAW ledger entry
 *     rather than re-serializing a display model, so a normalizing parser can't
 *     overwrite a field it coerced (a string `priority` re-emitted as a number).
 *
 * Deletion deliberately still works: a card absent from the incoming list is
 * gone. Merging protects fields, never card membership.
 *
 * ZT-I3 adds the ledger's validity rules (`validateLedger`) and the one
 * duplicate-id rule every reader shares: the first occurrence wins.
 */

/** One raw ledger entry as it sits on disk — an object of unknown fields. */
type RawTask = Record<string, unknown>;

function isRawTask(value: unknown): value is RawTask {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (!isRawTask(value)) return null;
  return typeof value.id === 'string' && value.id ? value.id : null;
}

/**
 * Fold `incoming` over `existing`, matching cards by `id`.
 *
 * The result is `incoming` — its order, and its membership, so removing a card
 * from the list still deletes it. What survives the fold are the fields on the
 * matching on-disk card that `incoming` does not mention.
 *
 * A field the caller DOES send wins, including an explicit `null` — that's the
 * way to clear one. A shallow merge cannot express "delete this key", and it
 * shouldn't: writers here are partial models, so a missing key means "I don't
 * know about this", never "remove it".
 *
 * Entries without a string `id` (a malformed card the god hand-wrote) pass
 * through untouched — there is no key to merge them on, and dropping them would
 * lose data the same way this function exists to prevent.
 */
export function mergeTaskLedger(existing: unknown, incoming: unknown): unknown[] {
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const existingList = Array.isArray(existing) ? existing : [];
  const byId = new Map<string, RawTask>();
  for (const entry of existingList) {
    const id = idOf(entry);
    if (id && !byId.has(id)) byId.set(id, entry as RawTask);
  }
  return incomingList.map((entry) => {
    const id = idOf(entry);
    if (!id) return entry;
    const prior = byId.get(id);
    return prior ? { ...prior, ...(entry as RawTask) } : entry;
  });
}

/**
 * Apply `patch` to one card in a RAW ledger array, leaving every other card —
 * and every other field of the patched card — byte-identical.
 *
 * This is what a UI edit should write. Re-serializing the display model instead
 * feeds the ledger a normalized card: `parseTasks` coerces a hand-written
 * `priority: "high"` to the number `3` and re-emits `dependsOn: []` for a card
 * that spells the key `deps`, and those coercions are real values, so they beat
 * `mergeTaskLedger` and land on disk. Patching the raw entry never produces
 * them in the first place.
 */
export function patchTaskInLedger(
  rawTasks: unknown,
  id: string,
  patch: Record<string, unknown>
): unknown[] {
  const list = Array.isArray(rawTasks) ? rawTasks : [];
  return list.map((entry) => (idOf(entry) === id ? { ...(entry as RawTask), ...patch } : entry));
}

/**
 * ZT-I3 / TASKS-DUP-ID-LOOP: the ONE duplicate-id rule, shared by main and the renderer.
 * The FIRST card with an id is canonical; a later card with the same id is a duplicate,
 * reported (`validateLedger`), never silently preferred. The office floor keyed its
 * previous poll by the LAST copy, so a done card and its todo twin replayed todo -> done
 * on every poll. Keying every reader by the first copy makes each poll see one card.
 */
export function firstOccurrenceById<T>(list: readonly T[], idOfItem: (item: T) => string | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const id = idOfItem(item);
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

/** One card as the office floor animates it. */
export interface LedgerCardState { id: string; status: string; assignee?: string }

/**
 * The cards whose status or assignee changed between two polls, each with its previous
 * state (undefined for a new card). Both polls are keyed by the FIRST occurrence of an
 * id, so a duplicate id can never make a card look changed on every poll
 * (TASKS-DUP-ID-LOOP: the floor replayed "filing it as done" forever).
 */
export function ledgerChanges<T extends LedgerCardState>(prev: readonly T[], next: readonly T[]): Array<{ card: T; old: T | undefined }> {
  const before = new Map<string, T>();
  for (const card of firstOccurrenceById(prev, (c) => c.id)) before.set(card.id, card);
  const out: Array<{ card: T; old: T | undefined }> = [];
  for (const card of firstOccurrenceById(next, (c) => c.id)) {
    const old = before.get(card.id);
    if (old && old.status === card.status && old.assignee === card.assignee) continue;
    out.push({ card, old });
  }
  return out;
}

/** The card ids `incoming` repeats, with every index each one sits at (first included). */
export function duplicateIds(list: unknown): Map<string, number[]> {
  const at = new Map<string, number[]>();
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    const id = idOf(entry);
    if (!id) return;
    const where = at.get(id);
    if (where) where.push(index); else at.set(id, [index]);
  });
  for (const [id, where] of [...at]) if (where.length < 2) at.delete(id);
  return at;
}

export type LedgerIssueLevel = 'error' | 'warning';

/** One finding. `key` is stable across unrelated edits (no indexes in it), so a writer can
 *  tell an issue it would INTRODUCE from one already in the file (Jim C1). */
export interface LedgerIssue {
  key: string;
  level: LedgerIssueLevel;
  cardId: string | null;
  message: string;
}

export const LEDGER_STATUSES: readonly string[] = ['todo', 'doing', 'blocked', 'done'];
/** The string priorities god writes (the mapping the renderer already uses). */
export const LEDGER_PRIORITY_WORDS: readonly string[] = ['critical', 'high', 'medium', 'low'];
/** A copied description only counts when it is long enough to be a real copy. */
export const DUPLICATE_DESCRIPTION_MIN = 80;

function listOf(ledger: unknown): unknown[] {
  if (Array.isArray(ledger)) return ledger;
  if (isRawTask(ledger) && Array.isArray(ledger.tasks)) return ledger.tasks;
  return [];
}

/**
 * Validate the whole ledger (ZT-I3 §3.1). The rules are fitted to the ledger god actually
 * writes: string priorities, `deps` as well as `dependsOn`, an optional `createdAt`, and
 * `"unassigned"` meaning no assignee. Only a missing/duplicate id and an unknown status are
 * errors; everything else is a warning, which never blocks a write.
 *
 * `agentIds` is the registry's agent ids; when it is omitted the assignee check is skipped.
 */
export function validateLedger(ledger: unknown, agentIds?: ReadonlySet<string>): LedgerIssue[] {
  const list = listOf(ledger);
  const issues: LedgerIssue[] = [];
  const ids = new Set<string>();
  for (const entry of list) { const id = idOf(entry); if (id) ids.add(id); }

  for (const [id, where] of duplicateIds(list)) {
    issues.push({ key: `dup:${id}`, level: 'error', cardId: id,
      message: `duplicate id ${id} at cards ${where.map((i) => `#${i}`).join(', ')} (the first is canonical)` });
  }
  const byDescription = new Map<string, string[]>();
  let missing = 0;
  list.forEach((entry, index) => {
    const id = idOf(entry);
    if (!id) {
      // Keyed by occurrence count, not index, so an unrelated insert above it keeps the key.
      missing++;
      issues.push({ key: `noid:${missing}`, level: 'error', cardId: null, message: `card #${index} has no id` });
      return;
    }
    const card = entry as RawTask;
    if (typeof card.status !== 'string' || !LEDGER_STATUSES.includes(card.status)) {
      issues.push({ key: `status:${id}`, level: 'error', cardId: id,
        message: `card ${id} has status ${JSON.stringify(card.status ?? null)}; expected todo, doing, blocked or done` });
    }
    const assignee = card.assignee;
    if (agentIds && typeof assignee === 'string' && assignee && assignee !== 'unassigned' && !agentIds.has(assignee)) {
      issues.push({ key: `assignee:${id}`, level: 'warning', cardId: id, message: `card ${id} is assigned to ${assignee}, who is not a registered agent` });
    }
    const deps = card.dependsOn ?? card.deps;
    if (Array.isArray(deps)) {
      for (const dep of deps) {
        if (typeof dep === 'string' && dep && !ids.has(dep)) {
          issues.push({ key: `dep:${id}:${dep}`, level: 'warning', cardId: id, message: `card ${id} depends on ${dep}, which is not on the board` });
        }
      }
    }
    const priority = card.priority;
    if (priority !== undefined && priority !== null && typeof priority !== 'number'
      && !(typeof priority === 'string' && LEDGER_PRIORITY_WORDS.includes(priority))) {
      issues.push({ key: `priority:${id}`, level: 'warning', cardId: id, message: `card ${id} has priority ${JSON.stringify(priority)}` });
    }
    const created = card.createdAt;
    if (created !== undefined && created !== null && (typeof created !== 'string' || Number.isNaN(Date.parse(created)))) {
      issues.push({ key: `createdAt:${id}`, level: 'warning', cardId: id, message: `card ${id} has an unparseable createdAt ${JSON.stringify(created)}` });
    }
    if (typeof card.description === 'string' && card.description.length >= DUPLICATE_DESCRIPTION_MIN) {
      const group = byDescription.get(card.description);
      if (group) { if (!group.includes(id)) group.push(id); } else byDescription.set(card.description, [id]);
    }
  });
  for (const group of byDescription.values()) {
    if (group.length < 2) continue;
    issues.push({ key: `desc:${[...group].sort().join('+')}`, level: 'warning', cardId: group[0],
      message: `cards ${group.join(', ')} have the same description (copied?)` });
  }
  return issues;
}

/** The ERROR issues in `after` whose key `before` lacks: what a write would introduce (Jim C1). */
export function introducedErrors(before: readonly LedgerIssue[], after: readonly LedgerIssue[]): LedgerIssue[] {
  const had = new Set(before.filter((i) => i.level === 'error').map((i) => i.key));
  return after.filter((i) => i.level === 'error' && !had.has(i.key));
}
