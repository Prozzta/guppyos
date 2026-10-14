/**
 * The small, renderer-safe project-theme catalogue: the built-in themes, plus
 * the theme packs registered at start-up (registerPackThemes). Keeping this
 * declarative means creating a project never needs a theme-name switch.
 */
export type BuiltinProjectThemeId = 'office' | 'friends' | 'brooklyn99' | 'siliconvalley' | 'got' | 'hogwarts';
/** A built-in id, or the id of a registered theme pack (see registerPackThemes). */
export type ProjectThemeId = string;

export interface ProjectThemeSeed {
  name: string;
  appearance: {
    bodyId: string;
    colors?: { skin?: string; shirt?: string; hair?: string };
    presetId?: string;
  };
}

export interface ProjectTheme {
  id: ProjectThemeId;
  label: string;
  blurb: string;
  swatch: string;
  /** The scene id: a built-in scene, or for a theme pack its own id. */
  sceneTheme: string;
  projectDefaults?: { orchestrator?: ProjectThemeSeed };
}

export const PROJECT_THEMES: readonly ProjectTheme[] = [
  { id: 'office', label: 'The Office', blurb: 'Dunder Mifflin — the original floor', swatch: '#6b5a4a', sceneTheme: 'office' },
  { id: 'friends', label: 'Friends', blurb: 'Central Perk coffee house', swatch: '#9a5a32', sceneTheme: 'friends' },
  { id: 'brooklyn99', label: 'Brooklyn Nine-Nine', blurb: 'The 99th precinct bullpen', swatch: '#3a5a7a', sceneTheme: 'brooklyn99' },
  { id: 'siliconvalley', label: 'Silicon Valley', blurb: 'The Hacker Hostel', swatch: '#4a6a4a', sceneTheme: 'siliconvalley' },
  { id: 'got', label: 'Game of Thrones', blurb: 'The Red Keep throne room', swatch: '#6a2630', sceneTheme: 'got' },
  { id: 'hogwarts', label: 'Harry Potter', blurb: 'Hogwarts great hall', swatch: '#39305a', sceneTheme: 'hogwarts' },
];

// Theme packs (themes/<dir>/theme.json) join the catalogue at start-up: main registers the bundled manifests that pass
// the renderer's validateManifest (main/packThemeEntries.ts), the renderer its validated pack catalogue. A pack's projectDefaults.orchestrator is its creation seed.
const PACK_THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const packThemes = new Map<string, ProjectTheme>();

export interface PackThemeEntry { id: string; label: string; orchestrator?: unknown }

/** Add theme packs to the catalogue. Ids must be pack-shaped and not a built-in; a seed must be a valid seed. */
export function registerPackThemes(entries: ReadonlyArray<PackThemeEntry>): void {
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || !PACK_THEME_ID.test(e.id) || PROJECT_THEMES.some((t) => t.id === e.id)) continue;
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 40) : e.id;
    packThemes.set(e.id, {
      id: e.id, label, blurb: label, swatch: '#6b5a4a', sceneTheme: e.id,
      ...(isProjectThemeSeed(e.orchestrator) ? { projectDefaults: { orchestrator: e.orchestrator } } : {}),
    });
  }
}

/** True for a registered theme pack's id. */
export function isPackProjectTheme(value: unknown): boolean {
  return typeof value === 'string' && packThemes.has(value);
}

/** The floor a project shows. The tvShowOffices flag gates the built-in TV-show
 * maps only; a theme pack the project was created with is its own floor. */
export function floorSceneTheme(id: ProjectThemeId, tvShowOffices: boolean | undefined): string {
  return tvShowOffices || isPackProjectTheme(id) ? projectTheme(id).sceneTheme : 'office';
}

/** Every project theme: the built-ins, then the registered packs. */
export function projectThemes(): ProjectTheme[] {
  return [...PROJECT_THEMES, ...packThemes.values()];
}

/** The themes a project can switch to right now (the Settings picker's list, and voice's): the
 *  Office and every pack always; the built-in TV-show themes only while tvShowOffices is on. */
export function offeredProjectThemes(tvShowOffices: boolean | undefined): ProjectTheme[] {
  return projectThemes().filter((theme) => tvShowOffices || theme.id === 'office' || isPackProjectTheme(theme.id));
}

export function isProjectThemeId(value: unknown): value is ProjectThemeId {
  return typeof value === 'string' && (PROJECT_THEMES.some((theme) => theme.id === value) || packThemes.has(value));
}

/** True for an id a stored project-theme entry may keep: a built-in, or any pack-shaped id even if no pack of that id is
 * registered in this build. A pack that is renamed or dropped must not wipe projects' theme entries on the next config
 * read; resolveProjectTheme falls back at render, and the entry comes back to life if the pack returns. */
export function isStoredProjectThemeId(value: unknown): value is ProjectThemeId {
  return typeof value === 'string' && (PROJECT_THEMES.some((theme) => theme.id === value) || PACK_THEME_ID.test(value));
}

export function projectTheme(themeId: unknown): ProjectTheme {
  return PROJECT_THEMES.find((theme) => theme.id === themeId) ?? (typeof themeId === 'string' ? packThemes.get(themeId) : undefined) ?? PROJECT_THEMES[0];
}

export function resolveProjectTheme(
  config: { officeTheme?: ProjectThemeId; officeThemeByHive?: Record<string, ProjectThemeId> },
  harnessHome?: string | null,
): ProjectThemeId {
  const selected = harnessHome ? projectThemeForHome(config.officeThemeByHive, harnessHome) : undefined;
  return isProjectThemeId(selected) ? selected : isProjectThemeId(config.officeTheme) ? config.officeTheme : 'office';
}

/** Map keys arrive from both renderer and main. Windows drive paths are
 * case-insensitive; POSIX paths deliberately retain case so two Linux/macOS
 * homes are never merged merely because their spelling differs by case. */
export function projectThemeHomeKey(home: string): string {
  const normalized = home.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function projectThemeForHome(map: Record<string, ProjectThemeId> | undefined, home: string): ProjectThemeId | undefined {
  if (!map) return undefined;
  const key = projectThemeHomeKey(home);
  return Object.entries(map).find(([stored]) => projectThemeHomeKey(stored) === key)?.[1];
}

/** A seed is written only when a blank project is created. A later theme switch
 * changes presentation only, so it can never rename an established hive. */
export function isProjectThemeSeed(value: unknown): value is ProjectThemeSeed {
  if (!value || typeof value !== 'object') return false;
  const seed = value as ProjectThemeSeed;
  return typeof seed.name === 'string' && seed.name.trim().length > 0
    && !!seed.appearance && typeof seed.appearance.bodyId === 'string' && seed.appearance.bodyId.trim().length > 0;
}

export interface ProjectThemeMapState {
  officeThemeByHive?: Record<string, ProjectThemeId>;
  projectThemeSeedByHive?: Record<string, ProjectThemeSeed>;
}

export interface ProjectHomeChange {
  mode: 'move' | 'fresh';
  oldHome?: string | null;
  newHome: string;
  /** A creation seed is legal only if the target was empty before mkdir. */
  blankProject: boolean;
  theme?: unknown;
  /** null explicitly means a manifest declared no orchestrator seed. */
  seed?: ProjectThemeSeed | null;
}

/** Pure map transaction used by main's home switch. It makes the creation-only
 * boundary executable: non-blank fresh homes do not acquire a theme or seed;
 * moves migrate both records; and a fresh manifest without a seed clears any
 * stale seed left by a prior project at the same path. */
export function applyProjectHomeChange(state: ProjectThemeMapState, change: ProjectHomeChange): Required<ProjectThemeMapState> {
  const officeThemeByHive = { ...(state.officeThemeByHive ?? {}) };
  const projectThemeSeedByHive = { ...(state.projectThemeSeedByHive ?? {}) };
  const oldKey = change.oldHome ? projectThemeHomeKey(change.oldHome) : undefined;
  const newKey = projectThemeHomeKey(change.newHome);

  if (change.mode === 'move') {
    if (oldKey && oldKey !== newKey) {
      const oldTheme = officeThemeByHive[oldKey];
      const oldSeed = projectThemeSeedByHive[oldKey];
      if (oldTheme) officeThemeByHive[newKey] = oldTheme;
      else delete officeThemeByHive[newKey];
      if (oldSeed) projectThemeSeedByHive[newKey] = oldSeed;
      else delete projectThemeSeedByHive[newKey];
      delete officeThemeByHive[oldKey];
      delete projectThemeSeedByHive[oldKey];
    }
    return { officeThemeByHive, projectThemeSeedByHive };
  }

  if (!change.blankProject) return { officeThemeByHive, projectThemeSeedByHive };
  // A blank fresh project with no theme (e.g. Settings' plain "new hive"): a reused
  // folder must not inherit a stale theme or god seed from an earlier project there.
  if (!isProjectThemeId(change.theme)) {
    delete officeThemeByHive[newKey];
    delete projectThemeSeedByHive[newKey];
    return { officeThemeByHive, projectThemeSeedByHive };
  }
  officeThemeByHive[newKey] = change.theme;
  const seed = change.seed === undefined ? projectTheme(change.theme).projectDefaults?.orchestrator : change.seed;
  if (seed && isProjectThemeSeed(seed)) projectThemeSeedByHive[newKey] = seed;
  else delete projectThemeSeedByHive[newKey];
  return { officeThemeByHive, projectThemeSeedByHive };
}
