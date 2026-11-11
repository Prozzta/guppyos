/** BLOB-MESSAGE: the shared agent picker (record a message, screenshot, meeting). */
import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { agentPickerOptions, defaultPickerAgent, sendToAgentVia, PICKER_LAST_KEY, type AgentPickerOption, type SendResult } from './agentPicker';

export function readLastPick(): string | null {
  try { return window.localStorage.getItem(PICKER_LAST_KEY); } catch { return null; }
}
function writeLastPick(id: string): void {
  try { window.localStorage.setItem(PICKER_LAST_KEY, id); } catch { /* storage unavailable: just don't remember */ }
}

/** The current picker options from the store (orchestrator = the isGod agent). */
export function usePickerOptions(): AgentPickerOption[] {
  const agents = useStore((s) => s.agents);
  return useMemo(() => agentPickerOptions(agents, null), [agents]);
}

/** The default pick for these options: last used if available, else the orchestrator. */
export function defaultPick(opts: readonly AgentPickerOption[]): string | null {
  return defaultPickerAgent(opts, readLastPick());
}

/** Send through the Human's message queue and remember the pick on success. */
export function sendToAgent(agentId: string | null, text: string): SendResult {
  const s = useStore.getState();
  const r = sendToAgentVia(s.enqueueMessage, agentPickerOptions(s.agents, null), agentId, text);
  if (r.ok && agentId) writeLastPick(agentId);
  return r;
}

export function AgentPicker(props: { value: string | null; onChange(agentId: string): void; disabled?: boolean; label?: string }): JSX.Element {
  const opts = usePickerOptions();
  const label = props.label ?? 'Send to';
  return (
    <label className="flex items-center gap-2 text-sm">
      <span>{label}</span>
      <select
        className="bg-black/30 border border-white/20 rounded px-2 py-1"
        aria-label={label}
        value={props.value ?? ''}
        disabled={props.disabled || opts.length === 0}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.value == null && <option value="" disabled>{opts.length ? 'Pick an agent' : 'No agents'}</option>}
        {opts.map((o) => (
          <option key={o.id} value={o.id} disabled={!o.available}>
            {o.name}{o.isOrchestrator ? ' (orchestrator)' : ''}{o.available ? '' : ` (${o.reason})`}
          </option>
        ))}
      </select>
    </label>
  );
}
