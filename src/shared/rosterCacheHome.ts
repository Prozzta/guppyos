/**
 * NEW-FLOOR-CLEAN-SLATE: which roster the renderer starts from.
 *
 * The roster has two copies: `<harnessHome>/roster.json` (one per home) and the renderer's
 * localStorage cache (`cth.agents`, `cth.archivedAgents`, ...). localStorage belongs to the
 * Electron userData origin, so ONE cache serves every home. It used to be read whenever the
 * home's file was empty, and a new floor's file is always empty: the new floor started with the
 * last floor's agents, restored them and registered them with their original cwds.
 *
 * So the cache is stamped with the home it was written for, and it stands in for an empty file
 * only in that same home (the "opened the build once and my floor went blank" guard it exists
 * for). An unstamped cache, a missing home, or an accessor that throws reads as no cache.
 */

/** localStorage key holding the harness home the roster cache was written for. */
export const ROSTER_CACHE_HOME_KEY = 'cth.rosterHome';

/** The localStorage keys that hold the roster cache, the stamp included. */
export const ROSTER_CACHE_KEYS = [
  'cth.agents',
  'cth.archivedAgents',
  'cth.restorableAgents',
  'cth.selectedId',
  'cth.messageQueues',
  ROSTER_CACHE_HOME_KEY
] as const;

/** One home folder named two ways (slash direction, case on Windows, a trailing slash). */
export function sameHome(a: string | null | undefined, b: string | null | undefined, win32 = isWin32()): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) return false;
  const norm = (p: string): string => {
    const s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return win32 ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

export type RosterSource = 'file' | 'cache' | 'none';

/** file: this home's roster.json holds entries. cache: the file is empty or missing and the
 *  cache was written for this home. none: start empty (a new floor gets only its own god). */
export function rosterSource(o: { fileEntries: number; home: string | null; cacheHome: string | null }): RosterSource {
  if (o.fileEntries > 0) return 'file';
  return sameHome(o.home, o.cacheHome) ? 'cache' : 'none';
}

/** Remove the roster cache (and its stamp). Leaves every other `cth.` key alone. */
export function clearRosterCache(storage: Pick<Storage, 'removeItem'> | null | undefined): void {
  if (!storage) return;
  for (const k of ROSTER_CACHE_KEYS) {
    try { storage.removeItem(k); } catch { /* a throwing accessor holds nothing we can read back */ }
  }
}

function isWin32(): boolean {
  try {
    const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
    if (nav) return /^win/i.test(nav.platform ?? '') || /windows/i.test(nav.userAgent ?? '');
    return (globalThis as { process?: { platform?: string } }).process?.platform === 'win32';
  } catch {
    return false;
  }
}
