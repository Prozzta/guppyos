import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { activityStatus, heavyActivity, heavyText, runningToolText } from '@shared/activityView';
import type { StatusKind } from './PixelBadge';

/** How often a shown "using X for 7m" refreshes its duration. */
const ACTIVITY_TICK_MS = 15_000;

/**
 * CARD-IDLE-WHILE-WORKING (1.1.78): what a card, a roster row or a panel SHOWS for an agent: the
 * hook-driven `status` with busy-or-not taken from main's liveness classification, and the tool
 * in progress with its duration. Display only (delivery reads the agent's own status).
 *
 * IDLE-MEANS-IDLE (1.1.87): an idle agent with a heavy job in the background shows working, and one
 * queued for (or holding a reservation on) the heavy lock shows waiting, with the lock's line as its
 * tool text. `turnStatus` is the status WITHOUT that overlay: the composer's send-now reads it, so a
 * background or queued agent (its turn closed) still takes a message at once.
 */
export function useActivity(agentId: string | undefined, status: StatusKind): { status: StatusKind; toolText: string | null; turnStatus: StatusKind } {
  const rec = useStore((s) => (agentId ? s.liveness[agentId] : undefined));
  // The oldest tool still running (Jim N1: parallel tools).
  const tool = useStore((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.runningTools?.[0] : undefined));
  const lock = useStore((s) => s.heavyLock);
  const heavy = heavyActivity(agentId, lock);
  const [now, setNow] = useState(() => Date.now());
  const turnStatus = activityStatus(status, rec) as StatusKind;
  const shown = activityStatus(status, rec, heavy) as StatusKind;
  const toolText = runningToolText(shown, tool, now) ?? (shown !== turnStatus ? heavyText(heavy, now) : null);
  const ticking = !!tool || !!heavy;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const iv = window.setInterval(() => setNow(Date.now()), ACTIVITY_TICK_MS);
    return () => window.clearInterval(iv);
  }, [tool, ticking]);
  return { status: shown, toolText, turnStatus };
}
