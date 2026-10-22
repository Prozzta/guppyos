import type { LiveRotationFacts } from './codexLiveRotation';

/** External state reduced to the policy's deliberately small, Electron-free input. */
export interface CodexLiveRotationFactInputs {
  bytes: number | null;
  lastTurnEndAt: number;
  openTurn: boolean;
  active: boolean;
  toolRunning: boolean;
  owed: boolean;
  wakePending: boolean;
  wakeInFlight: boolean;
  wakeHeld: boolean;
  heavy: boolean;
  floorHeld: boolean;
  inputPending: boolean;
  lastHumanInputAt: number;
  workspaceIsolated: boolean;
}

/** Keep the policy mapping explicit so each live fact has a focused unit test. */
export function mapCodexLiveRotationFacts(i: CodexLiveRotationFactInputs): LiveRotationFacts {
  return {
    bytes: i.bytes,
    stopSeen: i.lastTurnEndAt > 0,
    turnOpen: i.openTurn || i.active,
    toolRunning: i.toolRunning,
    owed: i.owed,
    wakePending: i.wakePending,
    wakeInFlight: i.wakeInFlight,
    wakeHeld: i.wakeHeld,
    heavy: i.heavy,
    floorHeld: i.floorHeld,
    inputPending: i.inputPending,
    humanTyping: i.lastHumanInputAt > i.lastTurnEndAt,
    workspaceIsolated: i.workspaceIsolated
  };
}

/** A rejected owner request must disarm immediately.  Every non-rejected outcome
 * may have typed `/exit`, so retain the exit arm only while that PTY still exists. */
export function shouldArmCodexLiveRotationExit(outcomeKind: string, ptyStillLive: boolean): boolean {
  return outcomeKind !== 'REFUSED' && ptyStillLive;
}

/** A graceful `/exit` is the sole permitted live-rotation restart.  A crash or
 * failed shutdown remains visible to the operator instead of being masked by a
 * fresh process. */
export function shouldRelaunchCodexLiveRotation(exitCode: number | null | undefined): boolean {
  return exitCode === 0;
}

/** The recheck must describe the same live Codex process before `/exit` is sent. */
export function sameCodexLiveRotationTarget(
  first: { ptyId: string | null | undefined; sessionId: string | null | undefined; action: string },
  second: { ptyId: string | null | undefined; sessionId: string | null | undefined; action: string }
): boolean {
  return second.action === 'rotate' && second.ptyId === first.ptyId && second.sessionId === first.sessionId;
}

/** Rotation is a Codex-only action and cannot be armed twice for the same PTY. */
export function mayConsiderCodexLiveRotation(provider: string | undefined, alreadyArmed: boolean): boolean {
  return provider === 'codex' && !alreadyArmed;
}

/** A rotated process intentionally starts a new conversation, never its old session. */
export function freshCodexLiveRotationSpawn<T extends { resume?: boolean; requireResume?: boolean; resumeSessionId?: string; startFresh?: boolean }>(opts: T): T & { resume: false; requireResume: false; resumeSessionId: undefined; startFresh: true } {
  return { ...opts, resume: false, requireResume: false, resumeSessionId: undefined, startFresh: true };
}

/** The beat is the missed-Stop fallback: every live agent must be reconsidered. */
export function sweepCodexLiveRotations(agentIds: readonly string[], consider: (agentId: string) => void): void {
  for (const agentId of agentIds) consider(agentId);
}

/** A delayed owner result belongs only to the incarnation that armed it. */
export function isCurrentCodexLiveRotationIncarnation(armed: number | undefined, current: number | undefined): boolean {
  return current === armed;
}
