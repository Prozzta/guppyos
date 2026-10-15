// src/shared/bootAction.ts — the boot note an agent is restored or spawned with.
//
// TES-BUBBLES-188: a restore writes a note such as 'starting up' into `action`, and every floor
// reads `action` as what the agent is doing right now. Only a hook (a tool call, a Stop, a
// compaction) replaced it, so an agent with nothing to do kept saying 'starting up' for minutes,
// and a Codex agent with no hook in its first turn kept it for good. The restore shape now says
// which text is its boot note, and the agent's first settled liveness reading after the boot
// retires the note, so the boot never reads as live activity once the CLI is up.
import type { LivenessV1 } from './livenessV1';

/** The note a restore or spawn put into `action`, and when. */
export interface BootAction {
  text: string;
  at: number;
}

/** The restore/spawn shape: the note goes into `action` (cards show it while the CLI starts)
 *  and is remembered as the boot note, so it can be told apart from a real action later. */
export function bootShape(text: string, at: number = Date.now()): { action: string; bootAction: BootAction } {
  return { action: text, bootAction: { text, at } };
}

interface BootAgent {
  id: string;
  action: string;
  bootAction?: BootAction;
}

/** The patch that retires an agent's boot note on its first settled liveness reading after the
 *  boot, or null. A reading from before the boot (an older incarnation's), an unsettled one
 *  (UNKNOWN, a dead or archived process) and an action that a real event already replaced are
 *  all left alone. IDLE reads 'idle', as a Stop does; working reads '' (the floor's "…"). */
export function settleBootAction(agent: BootAgent, rec: LivenessV1): { action: string; bootAction: undefined } | null {
  const boot = agent.bootAction;
  if (!boot || rec.agentId !== agent.id || agent.action !== boot.text) return null;
  if (rec.lifecycle !== 'LIVE' || rec.classifiedSince < boot.at) return null;
  if (rec.classification === 'IDLE') return { action: 'idle', bootAction: undefined };
  if (rec.classification === 'BUSY_PROGRESSING') return { action: '', bootAction: undefined };
  return null;
}

/** The roster with the record's agent's boot note retired, or the same array when nothing changes. */
export function settleBootActions<A extends BootAgent>(agents: A[], rec: LivenessV1): A[] {
  let out: A[] | null = null;
  agents.forEach((agent, i) => {
    const patch = settleBootAction(agent, rec);
    if (!patch) return;
    out = out ?? agents.slice();
    out[i] = { ...agent, ...patch };
  });
  return out ?? agents;
}
