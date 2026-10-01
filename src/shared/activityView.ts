/**
 * CARD-IDLE-WHILE-WORKING (1.1.78): what every working/idle DISPLAY says about an agent - the
 * player card, the roster strip, the agent panel, the office floor and the LIVE ROSTER line god
 * reads.
 *
 * The renderer's own `status` is driven by hook events, and during a long tool call no hook fires
 * (and the PTY may go quiet, which its quiescence fallback reads as turn-done). So the card read
 * "idle" while the agent worked, though the zero-token liveness classification correctly said
 * BUSY_PROGRESSING. The busy/idle question is the liveness classification's to answer: a LIVE
 * BUSY_PROGRESSING record shows working, a LIVE IDLE record shows idle. Every richer status
 * (needs you, waiting, compacting, the breaker's looping pin, the person's own draft, gone) is a
 * different fact and is kept as it is.
 *
 * Display only: delivery gating keeps reading the agent's own `status` (main owns submission).
 * Pure; no clock of its own.
 */
import { formatLivenessAge } from './livenessView';
import type { LivenessV1 } from './livenessV1';

/** Statuses that only say "busy or not". The liveness classification decides these. */
const BUSY_OR_NOT: ReadonlySet<string> = new Set(['idle', 'working', 'thinking', 'success']);

/** The status to SHOW, given the hook-driven status and the agent's liveness record. */
export function activityStatus<S extends string>(status: S, rec: LivenessV1 | null | undefined): S | 'working' | 'idle' {
  if (!rec || rec.lifecycle !== 'LIVE' || !BUSY_OR_NOT.has(status)) return status;
  if (rec.classification === 'BUSY_PROGRESSING') return status === 'thinking' ? status : 'working';
  if (rec.classification === 'IDLE') return 'idle';
  return status;
}

/** A tool call in progress: its name and when it started (epoch ms). */
export interface RunningTool { name: string; since: number }

/** "using Bash for 7m" while the shown status is busy and a tool is running; null otherwise. */
export function runningToolText(shown: string, tool: RunningTool | null | undefined, now: number): string | null {
  if (!tool || !tool.name || (shown !== 'working' && shown !== 'thinking')) return null;
  return `using ${tool.name} for ${formatLivenessAge(now - tool.since)}`;
}

/** The one-word state the LIVE ROSTER line gives each agent, from its liveness record. */
export function rosterActivity(rec: LivenessV1 | null | undefined, now: number, tool?: { name: string; forSec: number } | null): string | null {
  if (!rec || rec.lifecycle !== 'LIVE') return null;
  const age = formatLivenessAge(now - rec.classifiedSince);
  switch (rec.classification) {
    case 'BUSY_PROGRESSING':
      return tool && tool.name ? `WORKING ${age} (running ${tool.name} ${formatLivenessAge(tool.forSec * 1000)})` : `WORKING ${age}`;
    case 'IDLE': return `idle ${age}`;
    case 'SUSPECT': return `suspect ${age}`;
    case 'STUCK_WAKE': return `stuck ${age}`;
    case 'CRASHED': return `crashed ${age}`;
    case 'EXITED': return `exited ${age}`;
    default: return null;
  }
}
