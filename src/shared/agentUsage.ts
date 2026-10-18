/**
 * v1.1.45 CAPUI-MONITOR — what an agent's first Monitor line shows, and what that choice
 * means for the budget.
 *
 * The human's rules (confirmed 2026-09-21): for a Claude or Codex agent the line is a
 * choice of Budget (the default), 5H or Weekly. Choosing 5H or Weekly shows that
 * provider window's USAGE instead of the token budget, and EXEMPTS the agent from the
 * Settings budget limits. It adds no new cap: the L0 capacity gating is unchanged.
 * Choosing Budget puts the agent back under the limits. The choice persists per agent.
 *
 * Exempt means FULLY outside the budget subsystem (god's floor-blame ruling): the
 * breaker's three budget arms skip the agent, and the floor totals they compare against
 * are summed over non-exempt agents only. The behaviour-safety arms (looping, error
 * storm, velocity, no-progress) still apply to every agent.
 *
 * AGY-MONITOR-1.4 (AGY design 1.4): an Antigravity account has TWO pools, 3P and Gemini, so
 * a generic 5H / Weekly would be ambiguous. An Antigravity agent chooses Budget or one of
 * four family windows instead. They exempt by the same rule as 5H / Weekly (they show a
 * provider window), and main resolves each to the requested family's pool.
 */

export const AGY_USAGE_DISPLAYS = ['agy3pFiveHour', 'agy3pWeekly', 'agyGeminiFiveHour', 'agyGeminiWeekly'] as const;
export const AGENT_USAGE_DISPLAYS = ['budget', 'fiveHour', 'weekly', ...AGY_USAGE_DISPLAYS] as const;
export type AgentUsageDisplay = (typeof AGENT_USAGE_DISPLAYS)[number];

/** Providers that report 5h / weekly windows. Every other provider keeps the plain budget line. */
export const USAGE_WINDOW_PROVIDERS = ['claude', 'codex'] as const;
/** The provider whose windows are chosen per family (the four AGY displays). */
export const AGY_USAGE_PROVIDER = 'antigravity';

export const isAgentUsageDisplay = (v: unknown): v is AgentUsageDisplay =>
  typeof v === 'string' && (AGENT_USAGE_DISPLAYS as readonly string[]).includes(v);

const WINDOW_OF: Record<string, 'fiveHour' | 'weekly'> = {
  fiveHour: 'fiveHour', weekly: 'weekly',
  agy3pFiveHour: 'fiveHour', agy3pWeekly: 'weekly', agyGeminiFiveHour: 'fiveHour', agyGeminiWeekly: 'weekly'
};
const FAMILY_OF: Record<string, '3p' | 'gemini'> = {
  agy3pFiveHour: '3p', agy3pWeekly: '3p', agyGeminiFiveHour: 'gemini', agyGeminiWeekly: 'gemini'
};

/** The provider window a display shows, or null (Budget, absent, anything unrecognised). */
export function usageWindowOf(display: unknown): 'fiveHour' | 'weekly' | null {
  return typeof display === 'string' && Object.hasOwn(WINDOW_OF, display) ? WINDOW_OF[display] : null;
}

/** The Antigravity family an AGY display names, or null for every other display. */
export function agyFamilyOf(display: unknown): '3p' | 'gemini' | null {
  return typeof display === 'string' && Object.hasOwn(FAMILY_OF, display) ? FAMILY_OF[display] : null;
}

/** The choices a provider's Monitor line offers: Budget first, then its windows (none: Budget only). */
export function usageDisplaysFor(provider: string): readonly AgentUsageDisplay[] {
  if (provider === AGY_USAGE_PROVIDER) return ['budget', ...AGY_USAGE_DISPLAYS];
  if ((USAGE_WINDOW_PROVIDERS as readonly string[]).includes(provider)) return ['budget', 'fiveHour', 'weekly'];
  return ['budget'];
}

/**
 * Is this agent outside the budget limits? Only an explicit choice of a provider window
 * (5H, Weekly, or one of the four AGY family windows) exempts; absent, 'budget' and
 * anything unrecognised all mean "under the budget". A malformed config value must never
 * silently switch a limit off.
 */
export function isBudgetExempt(display: unknown): boolean {
  return usageWindowOf(display) !== null;
}

// ─── The usage projection main returns on `capacity:agentUsage` ─────────────────────────

/** Invoke channel: one agent's 5h + weekly usage. Its OWN channel, never control:snapshot. */
export const CAPACITY_AGENT_USAGE = 'capacity:agentUsage';

/** A drawn usage figure: USED, computed in main as 100 - remaining. */
export interface UsageFigure {
  kind: 'USAGE';
  /** Full precision, 0..100. */
  usedPercent: number;
  /** Rounded UP, so usage is never understated (and it pairs with the strip's rounded-down remaining). */
  displayPercent: number;
  /** Main-owned, e.g. `5h · 20% used`. */
  text: string;
  /** The pool's tracker state, for the bar colour (the strip's own colour for that state). */
  state: 'UNKNOWN' | 'AVAILABLE' | 'APPROACHING' | 'RESERVE_ONLY' | 'LIMITED' | 'RECOVERING';
}

/** No figure to draw: text only, no fill (no reading yet, stale, not reported). */
export interface UsageText {
  kind: 'TEXT';
  text: string;
}

export type UsageWindowView = UsageFigure | UsageText;

export interface AgentUsageView {
  fiveHour: UsageWindowView;
  weekly: UsageWindowView;
  /** AGY-MONITOR-1.4: an AGY family row only - the strip's OPAQUE pool id of that family, so
   *  the line can open the existing detail panel on that one family. Not account identity. */
  poolId?: string;
}

/** The strip's opaque pool id form (capacityStrip.poolIdOf): `pool-` + 16 hex. */
export const OPAQUE_POOL_ID = /^pool-[0-9a-f]{16}$/;

// ─── Runtime schema (additionalProperties:false), run by main before it answers ─────────

const USAGE_STATES = ['UNKNOWN', 'AVAILABLE', 'APPROACHING', 'RESERVE_ONLY', 'LIMITED', 'RECOVERING'];

function windowErrors(v: unknown, at: string): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${at}: not an object`];
  const o = v as Record<string, unknown>;
  const allowed = o.kind === 'USAGE' ? ['kind', 'usedPercent', 'displayPercent', 'text', 'state'] : ['kind', 'text'];
  const errors = Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${k}: property not allowed`);
  if (o.kind !== 'USAGE' && o.kind !== 'TEXT') errors.push(`${at}.kind: not USAGE|TEXT`);
  if (typeof o.text !== 'string' || !o.text || o.text.length > 120) errors.push(`${at}.text: not display text`);
  if (o.kind === 'USAGE') {
    const u = o.usedPercent;
    const d = o.displayPercent;
    if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u > 100) errors.push(`${at}.usedPercent: not 0..100`);
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 100 || (typeof u === 'number' && d < u)) {
      errors.push(`${at}.displayPercent: must be the used figure rounded UP`);
    }
    if (typeof o.state !== 'string' || !USAGE_STATES.includes(o.state)) errors.push(`${at}.state: not a capacity state`);
  }
  return errors;
}

/** Validate a usage view. Empty = valid. Anything else is refused whole. */
export function validateAgentUsageView(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['$: not an object'];
  const o = v as Record<string, unknown>;
  const errors = Object.keys(o).filter((k) => k !== 'fiveHour' && k !== 'weekly' && k !== 'poolId').map((k) => `$.${k}: property not allowed`);
  if ('poolId' in o && (typeof o.poolId !== 'string' || !OPAQUE_POOL_ID.test(o.poolId))) errors.push('$.poolId: not an opaque pool id');
  return [...errors, ...windowErrors(o.fiveHour, '$.fiveHour'), ...windowErrors(o.weekly, '$.weekly')];
}

// ─── v1.1.45 unit #13: the usage line is PUSHED by main (crit 15: no renderer polling) ───

/** Push channel: every 5H / Weekly agent's usage, on its OWN channel (never control:snapshot). */
export const CAPACITY_AGENT_USAGE_PUSH = 'capacity:agentUsagePush';

/** One agent's row. The agent id is the only key; no pool KEY or account identity crosses the
 *  bridge. An AGY family row's view carries the strip's opaque poolId (AGY-MONITOR-1.4). */
export interface AgentUsageRow { agentId: string; view: AgentUsageView }

/** The complete set of rows for every agent whose persisted display is a provider window. */
export interface AgentUsagePush { rows: AgentUsageRow[] }

/** Validate a push. Empty = valid. Anything else is refused whole. */
export function validateAgentUsagePush(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['$: not an object'];
  const o = v as Record<string, unknown>;
  const errors = Object.keys(o).filter((k) => k !== 'rows').map((k) => `$.${k}: property not allowed`);
  if (!Array.isArray(o.rows)) return [...errors, '$.rows: not an array'];
  const seen = new Set<string>();
  o.rows.forEach((r, i) => {
    const at = `$.rows[${i}]`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) { errors.push(`${at}: not an object`); return; }
    const row = r as Record<string, unknown>;
    for (const k of Object.keys(row)) if (k !== 'agentId' && k !== 'view') errors.push(`${at}.${k}: property not allowed`);
    if (typeof row.agentId !== 'string' || row.agentId.length === 0) errors.push(`${at}.agentId: not a non-empty string`);
    else if (seen.has(row.agentId)) errors.push(`${at}.agentId: duplicate`);
    else seen.add(row.agentId);
    errors.push(...validateAgentUsageView(row.view).map((e) => e.replace(/^\$/, `${at}.view`)));
  });
  return errors;
}
