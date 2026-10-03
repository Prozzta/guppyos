/**
 * CLAIM-LEDGER: the one TTL grammar (god 2f8991, Jim F3).
 *
 * STORED forms, the only ones a ledger record carries (W2's R6 reads them):
 *   task:<id>     the claim expires when that card is done
 *   until:<iso>   the claim expires at that instant (a full ISO time, UTC)
 * INPUT forms W1 accepts and turns into a stored form at write time:
 *   Nd | Nh | Nw  -> until:<wt + N days/hours/weeks>
 *   an ISO date or time, or until:<iso> -> until:<that instant>
 *   task:<id>     -> stored as it is
 * Anything else is refused. null means no TTL.
 */
const TASK_RE = /^task:([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/;
const REL_RE = /^(\d{1,4})([dhw])$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

export type StoredTtl = { kind: 'task'; task: string } | { kind: 'until'; at: string };

/** An input TTL as its stored form, or an error. `wtIso` is the record's write time. */
export function normalizeTtl(input: unknown, wtIso: string): { ttl: string | null } | { error: string } {
  if (input === null || input === undefined) return { ttl: null };
  const bad = { error: 'bad ttl: Nd, Nh or Nw (like 30d), an ISO date, until:<iso> or task:<card id>' };
  if (typeof input !== 'string') return bad;
  if (TASK_RE.test(input)) return { ttl: input };
  const rel = REL_RE.exec(input);
  if (rel) {
    const n = Number(rel[1]);
    if (n < 1) return bad;
    return { ttl: `until:${new Date(Date.parse(wtIso) + n * UNIT_MS[rel[2]]).toISOString()}` };
  }
  const iso = input.startsWith('until:') ? input.slice(6) : input;
  if (ISO_RE.test(iso) && !Number.isNaN(Date.parse(iso))) return { ttl: `until:${new Date(Date.parse(iso)).toISOString()}` };
  return bad;
}

/** A stored TTL, parsed; null for none or for anything not in the stored grammar. */
export function parseStoredTtl(stored: unknown): StoredTtl | null {
  if (typeof stored !== 'string') return null;
  const t = TASK_RE.exec(stored);
  if (t) return { kind: 'task', task: t[1] };
  if (stored.startsWith('until:')) {
    const at = stored.slice(6);
    if (ISO_RE.test(at) && !Number.isNaN(Date.parse(at)) && new Date(Date.parse(at)).toISOString() === at) return { kind: 'until', at };
  }
  return null;
}
