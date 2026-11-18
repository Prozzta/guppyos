/**
 * LAG-MAIN-SYNC-REMAINDER-108: the answer to `hive:cardBadges` (AgentStrip polls it every 5 s),
 * built from the fleet snapshot main already keeps in memory.
 *
 * The handler used to recompute each agent's mail fields on every poll, and each agent cost three
 * synchronous `existsSync` probes of its inbox on the main thread (1251 ms inside one stall on
 * 1.1.107). The 8 s fleet beat already computes the same fields for every agent that is not
 * archived (`...fleetMail(id)` and `silentTurn` in index.ts writeFleetSnapshot) and keeps the
 * result, so the badges read that: no file is touched. A badge is therefore at most one fleet beat
 * (8 s) old, and there are no mail or silent badges before the first beat of a launch.
 */
import type { BoardFlag } from '../shared/boardStale';

export interface CardBadges<S = unknown> {
  flags: BoardFlag[];
  inboxBacklog: Record<string, number>;
  inboxHeld: Record<string, number>;
  heldUntil: Record<string, number>;
  silentTurns: Record<string, S>;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `snapshot` is whatever HiveManager.fleetSnapshotView() holds: null before the first beat. */
export function cardBadgesFromFleet<S = unknown>(snapshot: unknown, flags: BoardFlag[]): CardBadges<S> {
  const out: CardBadges<S> = { flags, inboxBacklog: {}, inboxHeld: {}, heldUntil: {}, silentTurns: {} };
  const rows = snapshot && typeof snapshot === 'object' ? (snapshot as { agents?: unknown }).agents : null;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const a = row as { id?: unknown; inboxBacklog?: unknown; inboxHeld?: unknown; heldUntil?: unknown; silentTurn?: unknown };
    if (typeof a.id !== 'string' || !a.id) continue;
    const backlog = count(a.inboxBacklog);
    if (backlog !== null) out.inboxBacklog[a.id] = backlog;
    // A held count is shown only with the time it is held until (as the handler always did).
    const held = count(a.inboxHeld);
    const until = count(a.heldUntil);
    if (held && until) { out.inboxHeld[a.id] = held; out.heldUntil[a.id] = until; }
    if (a.silentTurn && typeof a.silentTurn === 'object') out.silentTurns[a.id] = a.silentTurn as S;
  }
  return out;
}
