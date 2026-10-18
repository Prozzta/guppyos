/**
 * v1.1.45 CAPUI-MONITOR — one agent's 5h and weekly USAGE, for its Monitor line.
 *
 * Pure: the caller hands in the agent's own pool (the one its readings landed in, from
 * the runtime's mapping) and the time. The figure is USED, computed here, once, as
 * 100 - remaining (the tracker keeps remaining). Anything that is not a fresh, valid
 * reading of that window is TEXT with no figure, so the renderer never draws a fill it
 * cannot vouch for: no reading yet, restored-unconfirmed, stale, not reported, invalid.
 *
 * This is a SEPARATE projection on its own channel (`capacity:agentUsage`). It is not
 * control:snapshot (which must carry no pool data) and not the strip object (whose
 * weekly is absent when hidden): a person chose to watch this agent's window here.
 *
 * AGY-MONITOR-1.4: an Antigravity agent's four family choices resolve, in main, to the
 * requested family's pool (the runtime's poolKeyForAgyFamily), never the active one. The
 * text names the family (`3P · 5h · 20% used`), and the row carries the strip's opaque
 * poolId so the line can open that one family's detail. The renderer never picks a pool.
 */
import { applicabilityOf, type PoolCapacitySnapshot, type WindowKind } from '../shared/providerCapacity';
import { agyFamilyOf, isAgentUsageDisplay, isBudgetExempt, validateAgentUsagePush, type AgentUsageDisplay, type AgentUsagePush, type AgentUsageView, type UsageWindowView } from '../shared/agentUsage';
import { formatLocalTime } from './capacityStrip';

const LABEL: Record<'FIVE_HOUR' | 'SEVEN_DAY', string> = { FIVE_HOUR: '5h', SEVEN_DAY: 'Weekly' };
/** The family names, as the strip labels them (`Antigravity · 3P` / `Antigravity · Gemini`). */
const FAMILY_LABEL: Record<'3p' | 'gemini', string> = { '3p': '3P', gemini: 'Gemini' };

function windowView(
  pool: PoolCapacitySnapshot | null,
  kind: 'FIVE_HOUR' | 'SEVEN_DAY',
  now: number,
  formatTime: (t: number, now: number) => string,
  family: '3p' | 'gemini' | null
): UsageWindowView {
  const label = family ? `${FAMILY_LABEL[family]} · ${LABEL[kind]}` : LABEL[kind];
  if (!pool) return { kind: 'TEXT', text: `${label} · no reading yet` };
  if (pool.stateReason === 'RESTORED_UNCONFIRMED') return { kind: 'TEXT', text: `${label} · no live reading since restart` };
  if (pool.freshness !== 'FRESH') {
    return { kind: 'TEXT', text: `${label} · usage unknown · last update ${formatTime(pool.observedAt, now)}` };
  }
  const w = pool.windows.find((x) => x.kind === (kind as WindowKind) && applicabilityOf(x) === 'APPLICABLE');
  if (!w) return { kind: 'TEXT', text: `${label} · not reported` };
  const r = w.remainingPercent;
  // No repair: anything but a finite 0..100 is unknown, never clamped into a figure.
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100) return { kind: 'TEXT', text: `${label} · usage unknown` };
  const displayPercent = 100 - Math.floor(r);
  return { kind: 'USAGE', usedPercent: 100 - r, displayPercent, text: `${label} · ${displayPercent}% used`, state: pool.state };
}

export function agentUsageView(
  pool: PoolCapacitySnapshot | null,
  now: number,
  formatTime: (t: number, now: number) => string = formatLocalTime,
  family: '3p' | 'gemini' | null = null
): AgentUsageView {
  return {
    fiveHour: windowView(pool, 'FIVE_HOUR', now, formatTime, family),
    weekly: windowView(pool, 'SEVEN_DAY', now, formatTime, family)
  };
}

/** What main resolves a usage line against: the runtime's two lookups, the tracker, the strip's opaque id. */
export interface UsagePoolSource {
  /** The agent's own (active) pool: Claude, Codex, and a generic 5H / Weekly. */
  poolKeyOf(agentId: string): string | null;
  /** One family of the agent's Antigravity account, whichever is active (capacityRuntime). */
  poolKeyForAgyFamily(agentId: string, family: '3p' | 'gemini'): string | null;
  pool(poolKey: string): PoolCapacitySnapshot | null;
  poolIdOf(poolKey: string): string;
}

/**
 * The pool a display reads: an AGY family display reads THAT family's pool, every other
 * display the agent's own. Main-only; the renderer never sees a key or compares families.
 */
export function usagePoolKeyOf(src: UsagePoolSource, agentId: string, display: unknown): string | null {
  const family = agyFamilyOf(display);
  return family ? src.poolKeyForAgyFamily(agentId, family) : src.poolKeyOf(agentId);
}

/**
 * One agent's usage view for its display (the mount-time invoke and every push row). An AGY
 * family row with a resolved pool carries that pool's opaque strip id; no other row does.
 */
export function agentUsageViewFor(
  src: UsagePoolSource,
  agentId: string,
  display: unknown,
  now: number,
  formatTime: (t: number, now: number) => string = formatLocalTime
): AgentUsageView {
  const family = agyFamilyOf(display);
  const poolKey = usagePoolKeyOf(src, agentId, display);
  const pool = poolKey ? src.pool(poolKey) : null;
  const view = agentUsageView(pool, now, formatTime, family);
  return family && poolKey && pool ? { ...view, poolId: src.poolIdOf(poolKey) } : view;
}

// ─── v1.1.45 unit #13: main PUSHES the usage rows (crit 15: no renderer polling) ─────────

/**
 * The rows to push: one per agent whose PERSISTED display is a provider window (5H,
 * Weekly, or an AGY family window), in agent-id order, each the same view the mount-time
 * invoke answers. A Budget agent has no row, so nothing is read or sent for it. Keyed by
 * agent id only; no pool key or account identity is included (an AGY family row's view
 * carries the strip's OPAQUE poolId, see agentUsageViewFor).
 *
 * `source` is main's UsagePoolSource, or (the v1.1.45 form, still used by tests) a plain
 * agent-to-pool function for the agent's own pool.
 */
export function agentUsagePushOf(
  displays: Record<string, unknown> | undefined,
  source: UsagePoolSource | ((agentId: string) => PoolCapacitySnapshot | null),
  now: number
): AgentUsagePush {
  const ids = Object.keys(displays ?? {}).filter((id) => isBudgetExempt(displays?.[id])).sort();
  const viewOf = (agentId: string): AgentUsageView => (typeof source === 'function'
    ? agentUsageView(source(agentId), now)
    : agentUsageViewFor(source, agentId, displays?.[agentId], now));
  return { rows: ids.map((agentId) => ({ agentId, view: viewOf(agentId) })) };
}

/** The display a mount-time invoke asks about: the one the renderer names, if valid, else the persisted one. */
export function requestedUsageDisplay(asked: unknown, persisted: unknown): AgentUsageDisplay {
  if (isAgentUsageDisplay(asked)) return asked;
  return isAgentUsageDisplay(persisted) ? persisted : 'budget';
}

/**
 * Sends a push only when the ROWS changed. The key is the rows themselves, NOT the strip's
 * collectionRevision: the strip and the usage line are two integer-rounded projections that
 * move independently, so a shared revision would drop real usage updates (and send
 * duplicates when only the strip moved).
 */
export class AgentUsagePushGate {
  private last: string | null = null;
  /** The push to send, or null when it is unchanged or fails its own schema. */
  next(push: AgentUsagePush): AgentUsagePush | null {
    const errors = validateAgentUsagePush(push);
    if (errors.length) { console.warn('[capacity-usage] push refused:', errors.slice(0, 3).join('; ')); return null; }
    const key = JSON.stringify(push.rows);
    if (key === this.last) return null;
    this.last = key;
    return push;
  }
}
