/**
 * v1.1.45 CAPUI-MONITOR — the first Monitor line for a Claude or Codex agent: a choice of
 * Budget (default) / 5H / Weekly, and, for 5H or Weekly, that window's USAGE.
 *
 * Main decides everything that is a fact: the figure (used = 100 - remaining, computed in
 * main), whether there is one at all (no reading / stale / not reported come back as
 * TEXT), and what the choice MEANS (5H / Weekly exempt the agent from the budget, applied
 * by the breaker). This file only offers the choice and draws main's answer, with the
 * strip's own meter so it cannot be confused with the 96x8 budget or context bars.
 *
 * AGY-MONITOR-1.4: an Antigravity agent chooses budget or one of four family windows
 * (3P · 5H, 3P · Weekly, Gemini · 5H, Gemini · Weekly). Main resolves the family's pool and
 * composes the text; an AGY row also carries that pool's opaque strip id, and clicking the
 * figure opens the existing provider-details panel on that one family.
 */
import { useEffect, useState } from 'react';
import { usageDisplaysFor, usageWindowOf, type AgentUsageDisplay, type AgentUsageView, type UsageWindowView } from '@shared/agentUsage';
import { CapacityMeter, STATE_COLOR } from './CapacityStrip';
import { openCapacityDetail } from '../capacity/detailSelection';

const DISPLAY_LABEL: Record<AgentUsageDisplay, string> = {
  budget: 'budget', fiveHour: '5H', weekly: 'Weekly',
  agy3pFiveHour: '3P · 5H', agy3pWeekly: '3P · Weekly', agyGeminiFiveHour: 'Gemini · 5H', agyGeminiWeekly: 'Gemini · Weekly'
};

/** A provider's choices (UI chrome, not capacity wording); the tooltip states the budget consequence. */
export function usageDisplayOptions(provider: string): { value: AgentUsageDisplay; label: string }[] {
  return usageDisplaysFor(provider).map((value) => ({ value, label: DISPLAY_LABEL[value] }));
}

/** The Claude / Codex choices. */
export const USAGE_DISPLAY_OPTIONS: { value: AgentUsageDisplay; label: string }[] = usageDisplayOptions('claude');

/**
 * What the selector shows for a persisted display: itself when this provider offers it,
 * otherwise budget. Never written back: a generic 5H on an Antigravity agent stays as it was
 * persisted (main still resolves it), the selector just cannot name an unambiguous family.
 */
export function shownUsageDisplay(provider: string, persisted: AgentUsageDisplay | undefined): AgentUsageDisplay {
  return persisted && usageDisplaysFor(provider).includes(persisted) ? persisted : 'budget';
}

export const USAGE_SELECT_TITLE =
  'What this line shows. budget: this agent\'s token budget, and the Settings budget limits apply. '
  + '5H / Weekly (for Antigravity, a 3P or Gemini window): that provider window\'s usage instead, and this agent is OUTSIDE the budget '
  + '(its token limit does not apply and it is not counted in the floor budget). '
  + 'Provider capacity limits still apply either way.';

export function AgentUsageSelect({ value, onChange, options = USAGE_DISPLAY_OPTIONS }: {
  value: AgentUsageDisplay;
  onChange: (v: AgentUsageDisplay) => void;
  options?: { value: AgentUsageDisplay; label: string }[];
}) {
  return (
    <select
      data-usage-select=""
      value={value}
      title={USAGE_SELECT_TITLE}
      onChange={(e) => onChange(e.target.value as AgentUsageDisplay)}
      style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)',
        background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: '0 2px', height: 16, flexShrink: 0
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** One window's usage as main answered it: a meter + figure, or text alone (no fill). */
export function UsageWindowFigure({ view }: { view: UsageWindowView | null }) {
  if (!view) {
    return <span data-usage-text="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-300)' }}>…</span>;
  }
  if (view.kind === 'TEXT') {
    return <span data-usage-text="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{view.text}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <CapacityMeter percent={view.usedPercent} valueText={view.text} color={STATE_COLOR[view.state]} dataRole="usage" />
      <span data-usage-figure="" style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)' }}>{view.text}</span>
    </span>
  );
}

/** One drawn usage line: the chosen window, and (AGY family rows only) the pool's opaque strip id. */
export interface UsageLine { window: UsageWindowView; poolId: string | null }

/**
 * Main's usage for one agent's chosen window while the line shows a provider window (and
 * nothing at all under Budget). v1.1.45 unit #13 (crit 15): NO renderer polling. One
 * invoke on mount for the initial state, then main's pushes on capacity:agentUsagePush.
 * The display only names WHICH window to draw; main already resolved the pool behind it.
 */
export function useAgentUsageLine(agentId: string, display: AgentUsageDisplay): UsageLine | null {
  const [line, setLine] = useState<UsageLine | null>(null);
  useEffect(() => {
    const which = usageWindowOf(display);
    if (!which) { setLine(null); return; }
    let alive = true;
    let pushed = false;
    const pick = (u: AgentUsageView | null): UsageLine | null => (u ? { window: u[which], poolId: u.poolId ?? null } : null);
    const off = window.cth.onAgentUsage((push) => {
      const row = push.rows.find((r) => r.agentId === agentId);
      if (!alive || !row) return;
      pushed = true;
      setLine(pick(row.view));
    });
    // Mount-time initial state. A push that already arrived is newer, so it wins.
    window.cth.capacityAgentUsage(agentId, display)
      .then((u) => { if (alive && !pushed) setLine(pick(u)); })
      .catch(() => { if (alive && !pushed) setLine(null); });
    return () => { alive = false; off(); };
  }, [agentId, display]);
  return line;
}

/** The chosen window only (the v1.1.45 form of the hook). */
export function useAgentUsageWindow(agentId: string, display: AgentUsageDisplay): UsageWindowView | null {
  return useAgentUsageLine(agentId, display)?.window ?? null;
}

/**
 * The figure, opening the provider-details panel on its pool when main sent one (an AGY
 * family row): the same canonical panel the strip opens, on that one family.
 */
export function UsageLineFigure({ line }: { line: UsageLine | null }) {
  const figure = <UsageWindowFigure view={line?.window ?? null} />;
  const poolId = line?.poolId;
  if (!poolId) return figure;
  return (
    <span
      role="button"
      tabIndex={0}
      title="Provider details"
      data-usage-detail={poolId}
      onClick={() => openCapacityDetail(poolId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCapacityDetail(poolId); } }}
      style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, cursor: 'pointer' }}
    >{figure}</span>
  );
}

/** The provider-window form of the line (the Budget form stays the panel's own markup). */
export function AgentUsageWindow({ agentId, display }: { agentId: string; display: AgentUsageDisplay }) {
  return <UsageLineFigure line={useAgentUsageLine(agentId, display)} />;
}
