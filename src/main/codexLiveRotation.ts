/** Safe live rotation policy for long-running Codex PTYs.  This module deliberately
 * has no Electron or filesystem dependency: callers collect one coherent snapshot,
 * then re-collect it immediately before asking Codex to exit. */
export const CODEX_LIVE_ROTATE_BYTES = 20 * 1024 * 1024;
export const CODEX_LIVE_ROTATE_HARD_BYTES = 64 * 1024 * 1024;

export type LiveRotationReason =
  | 'under-cap' | 'no-stop' | 'turn-open' | 'tool-running' | 'owed-obligation'
  | 'wake-pending' | 'wake-in-flight' | 'wake-held' | 'heavy-held' | 'floor-held'
  | 'input-pending' | 'human-typing' | 'workspace-isolated' | 'exit-not-observed' | 'rotate';

export interface LiveRotationFacts {
  bytes: number | null;
  stopSeen: boolean;
  turnOpen: boolean;
  toolRunning: boolean;
  owed: boolean;
  wakePending: boolean;
  wakeInFlight: boolean;
  wakeHeld: boolean;
  heavy: boolean;
  floorHeld: boolean;
  inputPending: boolean;
  humanTyping: boolean;
  workspaceIsolated: boolean;
}
export interface LiveRotationDecision {
  action: 'keep' | 'defer' | 'rotate';
  reason: LiveRotationReason;
  escalate: boolean;
  bytes: number | null;
}

/** First unsafe fact wins so logs tell an operator exactly why the session stayed live. */
export function decideCodexLiveRotation(f: LiveRotationFacts, cap = CODEX_LIVE_ROTATE_BYTES, hard = CODEX_LIVE_ROTATE_HARD_BYTES): LiveRotationDecision {
  if (f.bytes === null || f.bytes <= cap) return { action: 'keep', reason: 'under-cap', escalate: false, bytes: f.bytes };
  const reason: LiveRotationReason | null = !f.stopSeen ? 'no-stop'
    : f.turnOpen ? 'turn-open'
      : f.toolRunning ? 'tool-running'
        : f.owed ? 'owed-obligation'
          : f.wakePending ? 'wake-pending'
            : f.wakeInFlight ? 'wake-in-flight'
              : f.wakeHeld ? 'wake-held'
                : f.heavy ? 'heavy-held'
                  : f.floorHeld ? 'floor-held'
                    : f.inputPending ? 'input-pending'
                      : f.humanTyping ? 'human-typing'
                        : f.workspaceIsolated ? 'workspace-isolated' : null;
  if (!reason) return { action: 'rotate', reason: 'rotate', escalate: false, bytes: f.bytes };
  return { action: 'defer', reason, escalate: f.bytes >= hard, bytes: f.bytes };
}

/** Stable key for one digest decision, intentionally changes when the blocking reason changes. */
export function liveRotationEscalationId(agentId: string, sessionId: string, reason: LiveRotationReason): string {
  return `codex-live-rotation:${agentId}:${sessionId}:${reason}`;
}
