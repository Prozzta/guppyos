/** God's identity before anyone has customized it — the app's own default,
 *  not a magic string sprinkled at every spawn call site. */
export const DEFAULT_GOD_NAME = 'Michael';

/**
 * Resolve god's display name for a (re)spawn.
 *
 * `renameAgent()` (`store.ts`) persists a rename straight into `registry.json`
 * via `hive.ts`'s `renameAgent()` — but the god-spawn effect used to rebuild
 * god's agent object from scratch with `name: DEFAULT_GOD_NAME` hardcoded in
 * three places, so a custom name reverted to "Michael" on every app restart
 * even though the registry still had it right. Reading the persisted name
 * back here (instead of hardcoding the default) is what keeps a rename from
 * reverting. Falls back to the default only when nothing has been persisted
 * yet — a fresh hive, or a registry not yet written this run.
 */
export function resolveGodName(persistedName: string | undefined | null): string {
  const trimmed = persistedName?.trim();
  return trimmed ? trimmed : DEFAULT_GOD_NAME;
}

export interface GodAppearance {
  bodyId: string;
  colors?: { skin?: string; shirt?: string; hair?: string };
  presetId?: string;
}

export interface GodIdentitySource {
  name?: string | null;
  appearance?: GodAppearance;
}

export interface GodRegistrySource {
  godId?: string | null;
  agents?: Record<string, GodIdentitySource | undefined>;
}

/** Resolve the current orchestrator from a registry snapshot. This is the
 * name-reading seam for callers that do not have a live Agent object. */
export function resolveGodNameFromRegistry(registry: GodRegistrySource | undefined | null): string {
  const godId = registry?.godId ?? 'god';
  return resolveGodName(registry?.agents?.[godId]?.name);
}

/** Keep the Office prompt intact except for the orchestrator's display name. */
export function personaFor(persona: string, godName: string): string {
  return persona.replace('You are Michael', `You are ${godName}`);
}

/** Registry customizations always win. The creation seed is merely the
 * one-time identity for a newly-created blank project. */
export function resolveGodIdentity(
  persisted: GodIdentitySource | undefined | null,
  creationSeed: GodIdentitySource | undefined | null,
): { name: string; appearance?: GodAppearance } {
  return {
    name: resolveGodName(persisted?.name ?? creationSeed?.name),
    appearance: persisted?.appearance ?? creationSeed?.appearance,
  };
}
