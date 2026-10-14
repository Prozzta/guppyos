import { useStore } from '@/store/store';
import { orchestratorDisplayName } from '@shared/orchestratorName';

/** The orchestrator's name for UI text on the current floor (TES-ORCH-LABELS): "Michael" in the
 *  Office, the orchestrator's display name on a theme-pack floor. */
export function useOrchestratorName(): string {
  const floor = useStore((s) => s.officeTheme);
  const godName = useStore((s) => s.agents.find((a) => a.isGod)?.name);
  return orchestratorDisplayName(floor, godName);
}
