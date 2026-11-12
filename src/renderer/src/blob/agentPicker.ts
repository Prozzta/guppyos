/**
 * BLOB-MESSAGE: the shared agent picker's pure logic. Record-a-message (UHera), screenshot (Dwight)
 * and meeting (Andy) all pick the agent through this, so one rule decides who can be sent to.
 * No store import here: the store-backed parts live in AgentPickerField.tsx, which keeps this testable.
 */
import type { Agent } from '@/store/store';

export interface AgentPickerOption {
  id: string;
  name: string;
  role: string;
  isOrchestrator: boolean;
  /** false when the agent has no terminal right now; it stays listed so the user sees why. */
  available: boolean;
  reason?: string;
}

type PickerAgent = Pick<Agent, 'id' | 'name' | 'description' | 'ptyId' | 'isGod' | 'archived'>;

/** Orchestrator first, then by name; archived agents left out; agents without a terminal are
 *  listed with available:false and a reason. `orchestratorId` wins over isGod when both are set. */
export function agentPickerOptions(agents: readonly PickerAgent[], orchestratorId: string | null): AgentPickerOption[] {
  const isOrch = (a: PickerAgent): boolean => (orchestratorId ? a.id === orchestratorId : !!a.isGod);
  const seen = new Set<string>();
  const out: AgentPickerOption[] = [];
  for (const a of agents) {
    if (!a || typeof a.id !== 'string' || !a.id || a.archived || seen.has(a.id)) continue;
    seen.add(a.id);
    const available = typeof a.ptyId === 'string' && a.ptyId.length > 0;
    out.push({
      id: a.id,
      name: a.name || a.id,
      role: a.description || '',
      isOrchestrator: isOrch(a),
      available,
      ...(available ? {} : { reason: 'not running' }),
    });
  }
  return out.sort((x, y) => (x.isOrchestrator === y.isOrchestrator ? x.name.localeCompare(y.name) : x.isOrchestrator ? -1 : 1));
}

/** The last-used agent if it is still available, else the orchestrator, else the first available. */
export function defaultPickerAgent(opts: readonly AgentPickerOption[], lastUsed: string | null): string | null {
  const ok = opts.filter((o) => o.available);
  if (lastUsed && ok.some((o) => o.id === lastUsed)) return lastUsed;
  return (ok.find((o) => o.isOrchestrator) ?? ok[0])?.id ?? null;
}

export type SendResult = { ok: true } | { ok: false; error: string };
export type Enqueue = (agentId: string, text: string, meta: { human: true }) => void;

/** Queue `text` for `agentId` on the Human's own message queue ({human:true}), so delivery rides
 *  every existing gate (capacity, holds, idle wait). Never types into a terminal directly. */
export function sendToAgentVia(enqueue: Enqueue, opts: readonly AgentPickerOption[], agentId: string | null, text: string): SendResult {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { ok: false, error: 'There is nothing to send.' };
  const o = opts.find((x) => x.id === agentId);
  if (!o) return { ok: false, error: 'Pick an agent to send to.' };
  if (!o.available) return { ok: false, error: `${o.name} is not running.` };
  enqueue(o.id, body, { human: true });
  return { ok: true };
}

export const PICKER_LAST_KEY = 'guppy.blob.picker.last';
