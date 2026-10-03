/**
 * REBRAND-GUPPY (1.1.82): the app's data folder moves from `<appData>/munder-difflin` to
 * `<appData>/Guppy` (the Human's decision, 2026-10-03).
 *
 * Electron derives the default userData from package.json "name" (`munder-difflin`), which stays
 * as it is; index.ts points userData at the Guppy folder instead, before anything opens the data
 * and before the single-instance lock (which Electron keys on userData).
 *
 * On the first start of a build that has this, the old folder is COPIED once, never moved,
 * edited or deleted, so reinstalling 1.1.81 still finds everything it had:
 *   1. the copy goes to `<appData>/Guppy.migrating` (a leftover one from a failed start is ours and
 *      is cleared first, so a failed copy simply starts again on the next launch);
 *   2. config.json in the copy has every path that pointed inside the old folder re-pointed;
 *   3. a marker is written INTO the staged copy, and the staged folder is renamed to `Guppy` in one
 *      step. So a `Guppy` folder either has the marker (a finished copy, or a new user's folder,
 *      which gets a `fresh` marker) or was not made by us.
 * Chromium's own lock files belong to the process that made them and are not copied, nor are the
 * caches it rebuilds by itself.
 *
 * The copy runs under an exclusive lock file (MIGRATION_LOCK): a second start in the same moment
 * waits for the first one's result and never clears its staging folder; a lock left by a start
 * that died is taken over after LOCK_STALE_MS.
 *
 * If the copy fails, this run keeps using the old folder (so the user is not dropped into
 * onboarding) and the next start tries again. An existing `Guppy` folder without the marker is
 * never overwritten.
 *
 * Deliberately free of any `electron` import, so it is unit-testable on temp folders
 * (test/rebrand-a-182.test.cjs).
 */
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/** The data folder's name under appData from 1.1.82 on. */
export const USERDATA_DIR = 'Guppy';
/** The folder Electron derives from package.json "name": where 1.1.81 and older keep their data. */
export const LEGACY_USERDATA_DIR = 'munder-difflin';
/** Written into the copy before it becomes `Guppy`; its presence means the copy is complete. */
export const MIGRATION_MARKER = '.migrated-from-munder-difflin.json';
export const STAGING_DIR = USERDATA_DIR + '.migrating';
/** Held (exclusive create) for the whole copy, so two starts in the same moment (the installer's
 *  auto-start plus a double-click) never copy at once, and the second never clears a live staging
 *  folder: it waits for the first to finish and uses its result (Jim n2). */
export const MIGRATION_LOCK = USERDATA_DIR + '.migrating.lock';
/** A lock older than this is left by a start that died mid-copy (the copy is ~1 s for 85 MB). */
export const LOCK_STALE_MS = 120_000;
/** How long a second start waits for the first one's copy before it falls back to the old folder. */
export const LOCK_WAIT_MS = 30_000;

/** Chromium's single-instance / profile locks: they belong to the running process that made them. */
const LOCK_FILES = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);
/** Top-level caches Chromium rebuilds by itself. */
const CACHE_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache'
]);

export type MigrationStatus = 'already' | 'fresh' | 'in-use' | 'migrated' | 'waited' | 'busy' | 'failed';

export interface MigrationResult {
  status: MigrationStatus;
  /** The folder this run must use as userData. */
  userData: string;
  from: string;
  to: string;
  files?: number;
  bytes?: number;
  /** config.json keys (dotted paths) whose value pointed inside the old folder. */
  rewrote?: string[];
  error?: string;
}

export interface MigrationOptions {
  platform?: NodeJS.Platform;
  /** Test seam: the recursive copy (defaults to fs.cpSync). */
  copy?: (from: string, to: string, filter: (src: string) => boolean) => void;
  now?: () => Date;
  version?: string;
  /** Test seams for the start-race lock. */
  lockWaitMs?: number;
  lockStaleMs?: number;
  sleep?: (ms: number) => void;
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const fold = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.toLowerCase() : p);

/** `value` re-pointed from `from` to `to` when it is `from` or lies inside it; else null. */
export function repointPath(value: string, from: string, to: string, platform: NodeJS.Platform = process.platform): string | null {
  const v = fold(value.replace(/[\\/]+$/, ''), platform);
  const f = fold(from.replace(/[\\/]+$/, ''), platform);
  if (v === f) return to;
  const s = platform === 'win32' ? /[\\/]/ : /\//;
  if (v.startsWith(f) && s.test(v.charAt(f.length))) return to + value.replace(/[\\/]+$/, '').slice(from.replace(/[\\/]+$/, '').length);
  return null;
}

/** Re-point every string in a parsed config.json that names a path inside `from`. */
export function repointConfig(cfg: unknown, from: string, to: string, platform: NodeJS.Platform = process.platform): string[] {
  const changed: string[] = [];
  const walk = (node: unknown, at: string): unknown => {
    if (typeof node === 'string') {
      const next = repointPath(node, from, to, platform);
      if (next !== null && next !== node) { changed.push(at || '(root)'); return next; }
      return node;
    }
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = walk(node[i], `${at}[${i}]`); return node; }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = walk(o[k], at ? `${at}.${k}` : k);
      return o;
    }
    return node;
  };
  walk(cfg, '');
  return changed;
}

/**
 * Decide this run's userData, copying the old folder once if needed. Never throws; never writes
 * to `<appData>/munder-difflin`.
 */
export function migrateUserData(appData: string, opts: MigrationOptions = {}): MigrationResult {
  const platform = opts.platform ?? process.platform;
  const from = join(appData, LEGACY_USERDATA_DIR);
  const to = join(appData, USERDATA_DIR);
  const staging = join(appData, STAGING_DIR);
  const base = { from, to };
  try {
    if (existsSync(to)) {
      return { ...base, status: existsSync(join(to, MIGRATION_MARKER)) ? 'already' : 'in-use', userData: to };
    }
    if (!existsSync(from) || !statSync(from).isDirectory()) {
      // Nothing to copy (a new user). Mark the new folder as ours, so a later start reads 'already'.
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, MIGRATION_MARKER), JSON.stringify({ fresh: true, at: (opts.now ? opts.now() : new Date()).toISOString(), version: opts.version ?? null }, null, 2));
      return { ...base, status: 'fresh', userData: to };
    }

    // Only one start copies. A live lock means another start is copying right now: wait for its
    // result and never touch its staging folder. A stale one was left by a start that died.
    const lockPath = join(appData, MIGRATION_LOCK);
    const takeLock = (): boolean => {
      try {
        const fd = openSync(lockPath, 'wx');
        try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        return false;
      }
    };
    if (!takeLock()) {
      let age = Infinity;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { /* gone meanwhile */ }
      if (age > (opts.lockStaleMs ?? LOCK_STALE_MS)) { try { unlinkSync(lockPath); } catch { /* raced */ } }
      if (!takeLock()) {
        const sleep = opts.sleep ?? sleepSync;
        const until = Date.now() + (opts.lockWaitMs ?? LOCK_WAIT_MS);
        while (Date.now() < until) {
          sleep(100);
          if (existsSync(join(to, MIGRATION_MARKER))) return { ...base, status: 'waited', userData: to };
          if (!existsSync(lockPath)) break;   // the other start gave up: its result decides below
        }
        if (existsSync(join(to, MIGRATION_MARKER))) return { ...base, status: 'waited', userData: to };
        return { ...base, status: 'busy', userData: from, error: 'another start is copying the data folder' };
      }
    }
    try {
      // The other start may have finished between our first look and the lock.
      if (existsSync(to)) return { ...base, status: existsSync(join(to, MIGRATION_MARKER)) ? 'already' : 'in-use', userData: to };
      return copyOnce(from, to, staging, platform, opts);
    } finally {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  } catch (e) {
    // This run keeps the old folder; the staging copy (if any) is cleared at the next attempt.
    return { ...base, status: 'failed', userData: from, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The copy itself; runs only under the lock. Throws on failure (the caller falls back). */
function copyOnce(from: string, to: string, staging: string, platform: NodeJS.Platform, opts: MigrationOptions): MigrationResult {
  const base = { from, to };
  // A staging folder left by a failed start is ours (only this function makes it, under the lock): start over.
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });

  let files = 0;
  let bytes = 0;
  const filter = (src: string): boolean => {
    // Node's cpSync hands the filter long-path forms on Windows (\\?\C:\...): compare without it.
    const rel = relative(from, src.replace(/^\\\\\?\\/, ''));
    if (!rel) return true;
    const name = basename(src);
    if (LOCK_FILES.has(name)) return false;
    if (!rel.includes(sep) && !rel.includes('/') && CACHE_DIRS.has(name)) return false;
    try { const st = statSync(src); if (st.isFile()) { files++; bytes += st.size; } } catch { /* the copy reports it */ }
    return true;
  };
  const copy = opts.copy ?? ((a: string, b: string, f: (s: string) => boolean) =>
    cpSync(a, b, { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true, filter: f }));
  copy(from, staging, filter);

  let rewrote: string[] = [];
  const cfgPath = join(staging, 'config.json');
  if (existsSync(cfgPath)) {
    const raw = readFileSync(cfgPath, 'utf8');
    let cfg: unknown = null;
    try { cfg = JSON.parse(raw); } catch { /* an unreadable config is copied as it is */ }
    if (cfg && typeof cfg === 'object') {
      rewrote = repointConfig(cfg, from, to, platform);
      if (rewrote.length) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    }
  }

  writeFileSync(join(staging, MIGRATION_MARKER), JSON.stringify({
    from, to, at: (opts.now ? opts.now() : new Date()).toISOString(),
    version: opts.version ?? null, files, bytes, rewrote
  }, null, 2));
  renameSync(staging, to);
  return { ...base, status: 'migrated', userData: to, files, bytes, rewrote };
}
