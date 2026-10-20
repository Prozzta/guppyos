/**
 * HIVE-DWIGHT-BG-REINVOKE (Jim 0dbf11 MUST 2, god 911143): the floor hold. A Human pause went out as
 * mail only (god 1577cb, 2026-10-20 12:26Z to 19:30Z): no control state was set, so nothing in main
 * could see it. God sets the hold with `term hold on [reason]` and lifts it with `term hold off`
 * (termControl.ts, god-only). It is kept in config (it survives a restart), logged on each edge
 * (kind 'floor-hold'), shown in fleet.json and the floor digest, and while it is on the owed-work
 * continuation sends nothing (suppressor 'floor-paused').
 */
import { ageText } from '../shared/agentBadges';

export interface FloorHold { by: string; reason: string; since: number }

export const FLOOR_HOLD_REASON_MAX = 200;

/** The persisted hold, or null for anything that is not a whole one (a hand-edited config). */
export function parseFloorHold(raw: unknown): FloorHold | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.by !== 'string' || !h.by || typeof h.since !== 'number' || !Number.isFinite(h.since)) return null;
  return { by: h.by, reason: typeof h.reason === 'string' ? h.reason.slice(0, FLOOR_HOLD_REASON_MAX) : '', since: h.since };
}

/** The hold in words (fleet readers, the digest and the term reply). */
export function floorHoldWords(h: FloorHold, now: number): string {
  return `FLOOR HOLD on since ${new Date(h.since).toISOString()} (${ageText(now - h.since)}) by ${h.by}${h.reason ? `: ${h.reason}` : ''}. No owed-work continuations are sent while it holds; god lifts it with \`term hold off\`.`;
}
