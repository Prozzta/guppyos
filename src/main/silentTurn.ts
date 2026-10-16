/**
 * FLEET-LIVENESS-BLIND (1.1.89 candidate): an agent the fleet shows WORKING whose turn has made no
 * hook or tool call for a long time. On 2026-10-16 a Codex agent sat "active" for 3h50m with no
 * hook after ~09:29Z, no child shell and 5 unread, and nothing told god: the liveness reducer
 * counts PTY output as progress, so a redrawing screen looked busy.
 *
 * DETECTION AND ALERT ONLY. This file is a pure function; main lists what it finds in the floor
 * digest as a decision for god. Nothing here kills, respawns, wakes, types or edits the board.
 *
 * The clock is HOOK traffic only (every hook a provider sends: Claude's command hooks, Codex's
 * command and MCP tool hooks), never PTY output. A tool call in progress is NOT silence: an agent
 * with an open PreToolUse (no PostToolUse yet) is waiting on that tool, however long it takes. Such
 * an agent is listed only past TOOL_OPEN_LONG_MS, so a lost PostToolUse cannot hide a hang forever.
 *
 * Why 15 minutes: between two tool calls the model is thinking or writing, and that gap is minutes
 * at most (the liveness reducer already calls 5 minutes without evidence SUSPECT, LIVENESS_RECENT_MS).
 * Three times that keeps a slow long answer off god's desk; a long Bash, a test suite or a build is
 * an open tool and never counts. The digest looks every 5 minutes and batches over 10, so god hears
 * of a hang about 15-30 minutes in, not 3h50m.
 */
import type { WakeLifecycle } from './workerWake';

/** No hook, no open tool call, turn still open: after this long it is a decision for god. */
export const SILENT_TURN_AFTER_MS = 15 * 60_000;
/** A tool call still open after this long is listed too (the heavy-job lease's hour; a Claude
 *  foreground Bash is capped at 10 minutes). */
export const TOOL_OPEN_LONG_MS = 60 * 60_000;

/** What main knows about one agent at the moment of the look. */
export interface SilentTurnFacts {
  agentId: string;
  name?: string;
  /** The wake coordinator's view: 'active' = a turn is open (the roster shows it working). */
  lifecycle: WakeLifecycle;
  activeSince: number;
  turnStartAt: number;
  /** The newest hook of any kind from this agent (0 = none since the app started). */
  lastHookAt: number;
  /** The oldest tool call in progress (PreToolUse seen, no PostToolUse yet). */
  runningTool: { name: string; since: number } | null;
  mailWaiting: number;
  hasPty: boolean;
  archived: boolean;
  onHold: boolean;
  halted: boolean;
}

export interface SilentTurn {
  agentId: string;
  name?: string;
  kind: 'silent' | 'tool-open-long';
  /** When the silence (or the open tool call) began: a new silence is a new decision. */
  since: number;
  tool?: string;
  mailWaiting: number;
}

export function findSilentTurns(rows: readonly SilentTurnFacts[], now: number,
  silentAfterMs = SILENT_TURN_AFTER_MS, toolOpenLongMs = TOOL_OPEN_LONG_MS): SilentTurn[] {
  const out: SilentTurn[] = [];
  for (const r of rows) {
    if (!r.hasPty || r.archived || r.onHold || r.halted || r.lifecycle !== 'active') continue;
    const base = { agentId: r.agentId, ...(r.name ? { name: r.name } : {}), mailWaiting: r.mailWaiting };
    if (r.runningTool) {
      if (now - r.runningTool.since >= toolOpenLongMs) out.push({ ...base, kind: 'tool-open-long', since: r.runningTool.since, tool: r.runningTool.name });
      continue;
    }
    const since = Math.max(r.lastHookAt, r.activeSince, r.turnStartAt);
    if (since > 0 && now - since >= silentAfterMs) out.push({ ...base, kind: 'silent', since });
  }
  return out;
}
