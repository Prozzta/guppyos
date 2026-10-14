// The theme packs main registers: the same rule as the renderer catalogue (scene/themes/packs.ts catalogue()), so main
// never accepts a pack id the renderer rejects. Folders in name order; a manifest must pass validateManifest (the
// renderer's own validator, pure and DOM-free) and the first pack of an id wins. The orchestrator seed is the validated
// manifest's. Pure, so tests can run it; main/packThemes.ts feeds it the bundled manifests.
import { validateManifest } from '../renderer/src/scene/themes/manifest';
import type { PackThemeEntry } from '../shared/projectTheme';

/** The pack entries among parsed theme.json manifests keyed by path (".../themes/<dir>/theme.json"). */
export function validatedPackThemeEntries(manifests: Record<string, unknown>): PackThemeEntry[] {
  const out: PackThemeEntry[] = [];
  const byDir = Object.entries(manifests).map(([file, raw]) => ({ dir: file.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '', raw }));
  for (const { dir, raw } of byDir.sort((a, b) => a.dir.localeCompare(b.dir))) {
    const m = validateManifest(raw, dir).manifest;
    if (!m || out.some((e) => e.id === m.id)) continue;
    out.push({ id: m.id, label: m.label, orchestrator: m.projectDefaults?.orchestrator });
  }
  return out;
}
