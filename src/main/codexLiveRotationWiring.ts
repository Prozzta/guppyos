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
