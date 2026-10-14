// TES-ORCH-LABELS (1.1.86): the orchestrator's name in UI text. The Office (and the built-in
// TV themes) keep the words they always had, "Michael" verbatim; on a theme-pack floor the text
// names the orchestrator the floor shows: its display name, or before it exists (booting) the
// pack's orchestrator seed name. Ids, the god role and agent prompts are not affected.
import { DEFAULT_GOD_NAME } from './godIdentity';
import { isPackProjectTheme, projectTheme } from './projectTheme';

export function orchestratorDisplayName(floorTheme: unknown, godName?: string | null): string {
  if (!isPackProjectTheme(floorTheme)) return DEFAULT_GOD_NAME;
  return godName?.trim() || projectTheme(floorTheme).projectDefaults?.orchestrator?.name?.trim() || DEFAULT_GOD_NAME;
}
