import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { activityStatus, runningToolText } from '@shared/activityView';
import type { StatusKind } from './PixelBadge';

/** How often a shown "using X for 7m" refreshes its duration. */
const ACTIVITY_TICK_MS = 15_000;

/**
 * CARD-IDLE-WHILE-WORKING (1.1.78): what a card, a roster row or a panel SHOWS for an agent: the
 * hook-driven `status` with busy-or-not taken from main's liveness classification, and the tool
 * in progress with its duration. Display only (delivery reads the agent's own status).
 */
export function useActivity(agentId: string | undefined, status: StatusKind): { status: StatusKind; toolText: string | null } {
  const rec = useStore((s) => (agentId ? s.liveness[agentId] : undefined));
  // The oldest tool still running (Jim N1: parallel tools).
  const tool = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.runningTools?.[0] : undefined));
  const [now, setNow] = useState(() => Date.now());
  const shown = activityStatus(status, rec) as StatusKind;
  const toolText = runningToolText(shown, tool, now);
  useEffect(() => {
    if (!tool) return;
    setNow(Date.now());
    const iv = window.setInterval(() => setNow(Date.now()), ACTIVITY_TICK_MS);
    return () => window.clearInterval(iv);
  }, [tool]);
  return { status: shown, toolText };
}
