/**
 * Managed floor scratch.  `_work` is deliberately treated as a collection of
 * independently owned, disposable roots: this module never follows a link
 * while measuring or deleting, and never removes a root without proving it is
 * clean, pushed, inactive and either finished or idle.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cp, lstat, readdir, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWriteJson } from './atomicJson';
import { findReparsePointsSync, removeReparsePoint, removeReparsePointSync, safeRemoveTree, unlinkReparsePointsUnderSync } from './fsSafeRemove';

export { findReparsePointsSync, removeReparsePointSync, unlinkReparsePointsUnderSync } from './fsSafeRemove';

export const SCRATCH_IDLE_MS = 48 * 60 * 60_000;
export const SCRATCH_STATE_FILE = 'scratch-disk.json';
export const SCRATCH_CACHE_DIR = '.scratch-node-modules';
export const SCRATCH_FIXTURE_DIR = 'fixtures';
export const SCRATCH_FIXTURE_STAMP = '.guppy-fixture.json';

export interface ScratchRecord {
  path: string;
  owner: string;
  card: string;
  /** Worktrees have a `.git` file; jails deliberately do not. Fixtures are protected cache trees. */
  kind: 'worktree' | 'jail' | 'fixture';
  createdAt: number;
  touchedAt: number;
  /** The immutable dependency cache key, when node_modules is managed. */
  cacheKey?: string;
}
export interface ScratchState { v: 1; records: ScratchRecord[] }
export interface ScratchFacts {
  path: string;
  dirty: boolean;
  onOrigin: boolean;
  live: boolean;
  inboundLinks: string[];
  cardDone: boolean;
  idle: boolean;
  ignoredFiles?: number;
}
export interface ScratchPlan extends ScratchFacts { action: 'keep' | 'reap'; reason: string }

export interface ScratchProcess { commandLine?: string | null; cwd?: string | null }
export interface ScratchSweepResult { reaped: string[]; kept: Array<{ path: string; owner: string; reason: string }> }

/** True only for a direct child of `_work`; cache/state directories never qualify. */
export function managedScratchPath(workRoot: string, candidate: string): boolean {
  const root = resolve(workRoot);
  const p = resolve(candidate);
  const name = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  return dirname(p) === root && name !== '' && !name.startsWith('.') && !name.endsWith('.reaping');
}

/** True only for a direct, stamped child of `<hive>/cache/fixtures`. Fixtures are never reap candidates. */
export function managedFixturePath(hiveRoot: string, candidate: string): boolean {
  const root = resolve(hiveRoot, 'cache', SCRATCH_FIXTURE_DIR);
  const p = resolve(candidate);
  const name = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  if (dirname(p) !== root || name === '' || name.startsWith('.')) return false;
  try {
    const folder = lstatSync(p); const stamp = lstatSync(join(p, SCRATCH_FIXTURE_STAMP));
    return folder.isDirectory() && !folder.isSymbolicLink() && stamp.isFile() && !stamp.isSymbolicLink();
  } catch { return false; }
}

/** The reaper's pure, fail-closed policy.  The order is part of the safety contract. */
export function planScratchReap(f: ScratchFacts): ScratchPlan {
  if (f.dirty) return { ...f, action: 'keep', reason: 'dirty' };
  if (!f.onOrigin) return { ...f, action: 'keep', reason: 'unpushed-or-not-on-origin' };
  if (f.live) return { ...f, action: 'keep', reason: 'live-process' };
  if (f.inboundLinks.length) return { ...f, action: 'keep', reason: 'inbound-node-modules-link' };
  if (f.cardDone) return { ...f, action: 'reap', reason: 'card-done-clean-origin' };
  if (f.idle) return { ...f, action: 'reap', reason: 'idle-48h-clean-origin' };
  return { ...f, action: 'keep', reason: 'card-active' };
}

export function stateFile(hiveRoot: string): string { return join(hiveRoot, 'state', SCRATCH_STATE_FILE); }
export function readScratchState(hiveRoot: string): ScratchState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(hiveRoot), 'utf8')) as Partial<ScratchState>;
    if (raw?.v !== 1 || !Array.isArray(raw.records)) return { v: 1, records: [] };
    return { v: 1, records: raw.records.filter((r): r is ScratchRecord => !!r && typeof r.path === 'string' && typeof r.owner === 'string'
      && typeof r.card === 'string' && (r.kind === 'worktree' || r.kind === 'jail' || r.kind === 'fixture')
      && typeof r.createdAt === 'number' && typeof r.touchedAt === 'number') };
  } catch { return { v: 1, records: [] }; }
}
export function writeScratchState(hiveRoot: string, state: ScratchState): void {
  mkdirSync(join(hiveRoot, 'state'), { recursive: true });
  atomicWriteJson(stateFile(hiveRoot), state);
}

/**
 * Content address an install with every project input that can mutate it.  The
 * entire tools directory is included intentionally: postinstall's patch list
 * has changed without a dependency-lock change in the past.
 */
export function managedInstallKey(project: string, node = process.versions.node, platform = process.platform, arch = process.arch): string {
  const h = createHash('sha256');
  const add = (file: string): void => { h.update(file.replace(/\\/g, '/')).update('\0'); h.update(readFileSync(file)); h.update('\0'); };
  for (const n of ['package-lock.json', 'package.json']) add(join(project, n));
  const tools = join(project, 'tools');
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n); const st = lstatSync(p);
      if (st.isSymbolicLink()) { h.update(`link:${relative(project, p)}\0${realpathSync(p)}\0`); continue; }
      if (st.isDirectory()) walk(p); else if (st.isFile()) add(p);
    }
  };
  if (existsSync(tools)) walk(tools);
  h.update(`node=${node}\0platform=${platform}\0arch=${arch}\0`);
  return h.digest('hex');
}

export function scratchCacheRoot(hiveRoot: string): string { return join(hiveRoot, 'cache', SCRATCH_CACHE_DIR); }
export function scratchCacheEntry(hiveRoot: string, key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid scratch cache key');
  return join(scratchCacheRoot(hiveRoot), key);
}
export function scratchCacheMarker(hiveRoot: string, key: string): string { return join(scratchCacheEntry(hiveRoot, key), '.guppy-managed-cache.json'); }
export function publishedScratchCache(hiveRoot: string, key: string): boolean {
  try { const marker = JSON.parse(readFileSync(scratchCacheMarker(hiveRoot, key), 'utf8')) as { v?: unknown; key?: unknown };
    return marker.v === 1 && marker.key === key; } catch { return false; }
}

/**
 * A junction is installed only after a complete cache entry has been atomically
 * published. Existing untracked links are intentionally left alone: they may be
 * an old hand-made sharing arrangement and are reported, never overwritten.
 */
export async function attachManagedNodeModules(hiveRoot: string, project: string, key: string): Promise<void> {
  const entry = scratchCacheEntry(hiveRoot, key); const nm = join(project, 'node_modules');
  if (!existsSync(entry)) throw new Error('managed cache entry is not published');
  if (existsSync(nm) || isLink(nm)) throw new Error('refused: node_modules already exists or is a handmade link');
  await symlink(entry, nm, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Copy a cache junction to a private writable node_modules without touching the cache. */
export async function detachPrivateNodeModules(hiveRoot: string, project: string, key: string): Promise<void> {
  const entry = scratchCacheEntry(hiveRoot, key); const nm = join(project, 'node_modules');
  if (!isLink(nm)) throw new Error('refused: node_modules is not a managed junction');
  let target: string;
  try { target = realpathSync(nm); } catch { throw new Error('refused: node_modules junction is broken'); }
  if (resolve(target) !== resolve(entry)) throw new Error('refused: node_modules points at a different cache entry');
  // Electron's rmSync follows a junction recursively.  Remove the link entry
  // itself before copying, never its cache target.
  await removeReparsePoint(nm);
  await cp(entry, nm, { recursive: true, dereference: false, errorOnExist: true });
}

/** Replace only a previously recorded managed junction; handmade links remain inviolate. */
export async function refreshManagedNodeModules(hiveRoot: string, project: string, oldKey: string | undefined, nextKey: string): Promise<void> {
  const nm = join(project, 'node_modules');
  if (oldKey) {
    const old = scratchCacheEntry(hiveRoot, oldKey);
    if (!isLink(nm) || resolve(realpathSync(nm)) !== resolve(old)) throw new Error('refused: prior managed cache junction changed');
    await removeReparsePoint(nm);
  }
  await attachManagedNodeModules(hiveRoot, project, nextKey);
}

/** Entries with any `_work` junction into them are in use and cannot be garbage-collected. */
export function cacheEntryInUse(workRoot: string, entry: string): boolean {
  return inboundNodeModulesLinks(workRoot, entry).length > 0;
}

function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function under(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * Find every link into `target` from the floor root, not just node_modules.
 * Git's `.git` gitdir files are treated as incoming references too. Any
 * unreadable location is reported as an unsafe reference so deletion fails
 * closed rather than assuming the scan saw everything.
 */
export function inboundNodeModulesLinks(workRoot: string, target: string): string[] {
  const out: string[] = []; const wanted = resolve(target); const floor = dirname(resolve(workRoot));
  const visit = (p: string): void => {
    let st; try { st = lstatSync(p); } catch { out.push(`unreadable:${p}`); return; }
    if (st.isSymbolicLink()) {
      try { if (under(realpathSync(p), wanted)) out.push(p); } catch { out.push(`broken-link:${p}`); }
      return;
    }
    if (st.isFile()) {
      if (basename(p) !== '.git') return;
      try {
        const m = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(p, 'utf8'));
        if (m && under(resolve(dirname(p), m[1]), wanted)) out.push(`gitdir:${p}`);
      } catch { out.push(`unreadable:${p}`); }
      return;
    }
    if (!st.isDirectory()) return;
    let names: string[]; try { names = readdirSync(p); } catch { out.push(`unreadable:${p}`); return; }
    for (const name of names) visit(join(p, name));
  };
  visit(floor);
  return out.sort();
}

function gitAsync(path: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: false, timeout: 15_000 }, (error, stdout) => resolve(error ? null : String(stdout).trim())));
}

/** A worktree is acceptable only when its exact HEAD equals its origin tracking ref. */
export async function gitScratchFacts(path: string): Promise<Pick<ScratchFacts, 'dirty' | 'onOrigin' | 'ignoredFiles'>> {
  // A stale local tracking ref is not evidence that deletion is safe.
  if (await gitAsync(path, ['fetch', '--quiet', 'origin']) === null) return { dirty: true, onOrigin: false, ignoredFiles: 0 };
  const [status, ignored, head, upstream] = await Promise.all([
    gitAsync(path, ['status', '--porcelain=v1', '--untracked-files=all']), gitAsync(path, ['status', '--porcelain=v1', '--ignored']),
    gitAsync(path, ['rev-parse', 'HEAD']), gitAsync(path, ['rev-parse', '@{upstream}'])
  ]);
  return { dirty: status === null || status !== '', onOrigin: !!head && !!upstream && head === upstream, ignoredFiles: ignored?.split(/\r?\n/).filter((line) => line.startsWith('!! ')).length ?? 0 };
}

/** A `.git` directory is a shared repository and is never a disposable worktree. */
function looksLikeGitDir(path: string): boolean {
  try { return lstatSync(join(path, 'HEAD')).isFile() && lstatSync(join(path, 'objects')).isDirectory() && lstatSync(join(path, 'refs')).isDirectory(); }
  catch { return false; }
}

/** A common repo, bare repo, or a `.git` directory is never a disposable jail. */
export function scratchKind(path: string): 'worktree' | 'jail' | null {
  try {
    const dotGit = lstatSync(join(path, '.git'));
    return dotGit.isFile() ? 'worktree' : null;
  } catch {
    try { return lstatSync(path).isDirectory() && !looksLikeGitDir(path) ? 'jail' : null; } catch { return null; }
  }
}

/** Refuse a candidate that is the common gitdir referenced by any `_work` worktree. */
export function worktreeGitdirPointsInto(workRoot: string, candidate: string): boolean {
  let names: string[]; try { names = readdirSync(workRoot); } catch { return false; }
  return names.some((name) => {
    const dotGit = join(workRoot, name, '.git');
    try {
      if (!lstatSync(dotGit).isFile()) return false;
      const m = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(dotGit, 'utf8'));
      return !!m && under(resolve(dirname(dotGit), m[1]), candidate);
    } catch { return false; }
  });
}

/** A scratch root must visibly belong to the authenticated agent that registers it. */
export function scratchPathOwnedBy(owner: string, path: string): boolean {
  const prefix = owner.split('-', 1)[0].toLowerCase();
  return !!prefix && basename(path).toLowerCase().startsWith(`${prefix}-`);
}

function processUses(path: string, rows: readonly ScratchProcess[] | null): boolean {
  // A failed probe is deliberately equivalent to a live process. This catches
  // normal node/electron commands and refuses to turn an observability outage
  // into a destructive operation.
  if (!rows) return true;
  const needle = resolve(path).replace(/\\/g, '/').toLowerCase();
  return rows.some((p) => [p.commandLine, p.cwd].some((v) => String(v ?? '').replace(/\\/g, '/').toLowerCase().includes(needle)));
}

/** Remove links as links, re-scan, then the verified link-free root.  Caller planned/rechecked first. */
export async function removeScratchRoot(workRoot: string, path: string): Promise<void> {
  if (!managedScratchPath(workRoot, path)) throw new Error('refused: path is not a managed _work child');
  await safeRemoveTree(path);
}

/**
 * The only mutable facade over scratch state.  The authenticated route supplies
 * the owner; callers cannot register or reap another agent's root.  Reaping
 * rechecks every destructive predicate immediately before removal.
 */
export class ScratchDiskManager {
  private notified = new Set<string>();
  private disk: { bytes: number; measuredAt: number } | null = null;
  private measuring: Promise<void> | null = null;
  private sweepTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly hiveRoot: () => string | null,
    private readonly cardDone: (card: string) => boolean,
    private readonly processes: () => Promise<readonly ScratchProcess[] | null>,
    private readonly notify: (owner: string, card: string, path: string, reason: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  private workRoot(): string | null {
    const root = this.hiveRoot();
    return root ? join(dirname(root), '_work') : null;
  }

  diskUsage(): { bytes: number; measuredAt: number } | null { return this.disk; }
  refreshDiskUsage(): Promise<void> {
    if (this.measuring) return this.measuring;
    const work = this.workRoot();
    if (!work) return Promise.resolve();
    this.measuring = scratchBytesAsync(work).then((bytes) => { this.disk = { bytes, measuredAt: this.now() }; }).catch(() => undefined).finally(() => { this.measuring = null; });
    return this.measuring;
  }

  private recordFor(owner: string, path: string): ScratchRecord | null {
    const root = this.hiveRoot();
    if (!root) return null;
    return readScratchState(root).records.find((r) => r.owner === owner && resolve(r.path) === resolve(path)) ?? null;
  }

  register(owner: string, candidate: unknown, card: unknown): { ok: boolean; line: string; record?: ScratchRecord } {
    const root = this.hiveRoot(); const work = this.workRoot();
    if (!root || !work) return { ok: false, line: 'refused: hive scratch is unavailable' };
    if (typeof candidate !== 'string' || typeof card !== 'string' || !/^[A-Z][A-Z0-9-]{2,120}$/.test(card)) return { ok: false, line: 'refused: register needs a _work path and CARD-ID' };
    const path = resolve(candidate);
    if (!managedScratchPath(work, path)) return { ok: false, line: 'refused: scratch must be a direct _work child' };
    const kind = scratchKind(path);
    if (!kind) return { ok: false, line: 'refused: path is missing or is a common repository (.git directory)' };
    if (kind === 'jail' && worktreeGitdirPointsInto(work, path)) return { ok: false, line: 'refused: jail is referenced by a worktree gitdir file' };
    const state = readScratchState(root);
    const existing = state.records.find((r) => resolve(r.path) === path);
    if (existing && existing.owner !== owner) return { ok: false, line: 'refused: scratch is owned by another agent' };
    if (!scratchPathOwnedBy(owner, path)) return { ok: false, line: 'refused: scratch path does not have your owner prefix' };
    const at = this.now();
    const record: ScratchRecord = existing ? { ...existing, card, kind, touchedAt: at } : { path, owner, card, kind, createdAt: at, touchedAt: at };
    writeScratchState(root, { v: 1, records: [...state.records.filter((r) => resolve(r.path) !== path), record] });
    return { ok: true, line: `registered ${path} (${kind}, ${card})`, record };
  }

  /** Register an already-built, stamped fixture. It is kept forever by sweep. */
  registerFixture(owner: string, candidate: unknown, card: unknown): { ok: boolean; line: string; record?: ScratchRecord } {
    const root = this.hiveRoot();
    if (!root) return { ok: false, line: 'refused: hive scratch is unavailable' };
    if (typeof candidate !== 'string' || typeof card !== 'string' || !/^[A-Z][A-Z0-9-]{2,120}$/.test(card)) return { ok: false, line: 'refused: register-fixture needs a stamped cache/fixtures path and CARD-ID' };
    const path = resolve(candidate);
    if (!managedFixturePath(root, path)) return { ok: false, line: `refused: fixture must be a stamped direct child of cache/${SCRATCH_FIXTURE_DIR}` };
    const state = readScratchState(root);
    const existing = state.records.find((r) => resolve(r.path) === path);
    if (existing && existing.owner !== owner) return { ok: false, line: 'refused: fixture is owned by another agent' };
    const at = this.now();
    const record: ScratchRecord = existing ? { ...existing, card, kind: 'fixture', touchedAt: at } : { path, owner, card, kind: 'fixture', createdAt: at, touchedAt: at };
    writeScratchState(root, { v: 1, records: [...state.records.filter((r) => resolve(r.path) !== path), record] });
    return { ok: true, line: `registered protected fixture ${path} (${card})`, record };
  }

  touch(owner: string, candidate: unknown): { ok: boolean; line: string } {
    if (typeof candidate !== 'string') return { ok: false, line: 'refused: touch needs a path' };
    const root = this.hiveRoot(); if (!root) return { ok: false, line: 'refused: hive scratch is unavailable' };
    const state = readScratchState(root); const path = resolve(candidate);
    const record = state.records.find((r) => r.owner === owner && resolve(r.path) === path);
    if (!record) return { ok: false, line: 'refused: scratch is not registered to you' };
    record.touchedAt = this.now(); writeScratchState(root, state);
    return { ok: true, line: `touched ${record.path}` };
  }

  async detachPrivate(owner: string, candidate: unknown): Promise<{ ok: boolean; line: string }> {
    if (typeof candidate !== 'string') return { ok: false, line: 'refused: detach needs a path' };
    const root = this.hiveRoot(); const work = this.workRoot();
    if (!root || !work) return { ok: false, line: 'refused: hive scratch is unavailable' };
    const path = resolve(candidate); const record = this.recordFor(owner, path);
    if (!record || !record.cacheKey || !managedScratchPath(work, path)) return { ok: false, line: 'refused: scratch has no managed cache to detach' };
    try { await detachPrivateNodeModules(root, path, record.cacheKey); }
    catch (e) { return { ok: false, line: String(e instanceof Error ? e.message : e) }; }
    const state = readScratchState(root);
    const saved = state.records.find((r) => r.owner === owner && resolve(r.path) === path);
    if (saved) { delete saved.cacheKey; saved.touchedAt = this.now(); writeScratchState(root, state); }
    return { ok: true, line: `detached private node_modules for ${path}` };
  }

  prepareCache(owner: string, candidate: unknown): { ok: boolean; line: string; key?: string; published?: boolean } {
    if (typeof candidate !== 'string') return { ok: false, line: 'refused: cache needs a path' };
    const root = this.hiveRoot(); const work = this.workRoot(); const path = resolve(candidate);
    const record = this.recordFor(owner, path);
    if (!root || !work || !record || !managedScratchPath(work, path)) return { ok: false, line: 'refused: scratch is not registered to you' };
    let key: string; try { key = managedInstallKey(path); } catch { return { ok: false, line: 'refused: cannot read package inputs for cache key' }; }
    return { ok: true, line: publishedScratchCache(root, key) ? `cache ${key} is ready` : `build cache ${key}`, key, published: publishedScratchCache(root, key) };
  }

  async attachCache(owner: string, candidate: unknown, key: unknown): Promise<{ ok: boolean; line: string }> {
    if (typeof candidate !== 'string' || typeof key !== 'string') return { ok: false, line: 'refused: attach needs a path and cache key' };
    const root = this.hiveRoot(); const work = this.workRoot(); const path = resolve(candidate); const record = this.recordFor(owner, path);
    if (!root || !work || !record || !managedScratchPath(work, path)) return { ok: false, line: 'refused: scratch is not registered to you' };
    if (!publishedScratchCache(root, key)) return { ok: false, line: 'refused: cache entry is incomplete or not published' };
    let expected: string; try { expected = managedInstallKey(path); } catch { return { ok: false, line: 'refused: cannot read package inputs for cache key' }; }
    if (key !== expected) return { ok: false, line: 'refused: cache key is stale; rebuild for current package inputs' };
    try { await refreshManagedNodeModules(root, path, record.cacheKey, key); }
    catch (e) { return { ok: false, line: String(e instanceof Error ? e.message : e) }; }
    const state = readScratchState(root); const saved = state.records.find((r) => r.owner === owner && resolve(r.path) === path);
    if (saved) { saved.cacheKey = key; saved.touchedAt = this.now(); writeScratchState(root, state); }
    return { ok: true, line: `attached managed cache ${key.slice(0, 12)} to ${path}` };
  }

  async sweep(owner?: string): Promise<ScratchSweepResult> {
    let release!: () => void;
    const previous = this.sweepTail;
    this.sweepTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await this.sweepNow(owner); } finally { release(); }
  }

  private async sweepNow(owner?: string): Promise<ScratchSweepResult> {
    const root = this.hiveRoot(); const work = this.workRoot();
    if (!root || !work) return { reaped: [], kept: [] };
    const state = readScratchState(root); const rows = await this.processes(); const result: ScratchSweepResult = { reaped: [], kept: [] };
    const keptRecords: ScratchRecord[] = [];
    for (const record of state.records) {
      if (owner && record.owner !== owner) { keptRecords.push(record); continue; }
      if (record.kind === 'fixture') {
        result.kept.push({ path: record.path, owner: record.owner, reason: managedFixturePath(root, record.path) ? 'fixture-protected' : 'fixture-path-changed-or-missing' });
        keptRecords.push(record);
        continue;
      }
      const kind = scratchKind(record.path);
      if (!managedScratchPath(work, record.path) || kind !== record.kind) { result.kept.push({ path: record.path, owner: record.owner, reason: 'path-changed-or-missing' }); keptRecords.push(record); continue; }
      const gitFacts = record.kind === 'worktree' ? await gitScratchFacts(record.path) : { dirty: false, onOrigin: true, ignoredFiles: 0 };
      const facts: ScratchFacts = {
        path: record.path, ...gitFacts, live: processUses(record.path, rows),
        inboundLinks: inboundNodeModulesLinks(work, record.path), cardDone: this.cardDone(record.card), idle: this.now() - record.touchedAt >= SCRATCH_IDLE_MS
      };
      const plan = planScratchReap(facts);
      if (plan.action !== 'reap') {
        result.kept.push({ path: record.path, owner: record.owner, reason: plan.reason }); keptRecords.push(record);
        if (plan.reason === 'dirty' || plan.reason === 'unpushed-or-not-on-origin') {
          const key = `${record.path}\0${plan.reason}`;
          if (!this.notified.has(key)) { this.notified.add(key); this.notify(record.owner, record.card, record.path, plan.reason); }
        }
        continue;
      }
      // Last-moment recheck: another install could have made a link after the plan.
      const finalFacts = { ...facts, inboundLinks: inboundNodeModulesLinks(work, record.path), live: processUses(record.path, await this.processes()) };
      const finalPlan = planScratchReap(finalFacts);
      if (finalPlan.action !== 'reap') { result.kept.push({ path: record.path, owner: record.owner, reason: finalPlan.reason }); keptRecords.push(record); continue; }
      if (facts.ignoredFiles) this.notify(record.owner, record.card, record.path, `ignored-files-will-be-lost:${facts.ignoredFiles}`);
      try { await removeScratchRoot(work, record.path); result.reaped.push(record.path); }
      catch { result.kept.push({ path: record.path, owner: record.owner, reason: 'remove-failed' }); keptRecords.push(record); }
    }
    writeScratchState(root, { v: 1, records: keptRecords });
    return result;
  }

  async command(owner: string, body: unknown): Promise<{ status: number; body: unknown }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { ok: false, line: 'refused: scratch input must be an object' } };
    const b = body as { op?: unknown; path?: unknown; card?: unknown; key?: unknown };
    if (b.op === 'register') { const r = this.register(owner, b.path, b.card); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'register-fixture') { const r = this.registerFixture(owner, b.path, b.card); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'touch') { const r = this.touch(owner, b.path); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'detach-private') { const r = await this.detachPrivate(owner, b.path); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'prepare-cache') { const r = this.prepareCache(owner, b.path); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'attach-cache') { const r = await this.attachCache(owner, b.path, b.key); return { status: r.ok ? 200 : 400, body: r }; }
    if (b.op === 'reap') { const r = await this.sweep(owner); return { status: 200, body: { ok: true, line: `reaped ${r.reaped.length}; kept ${r.kept.length}`, ...r } }; }
    if (b.op === 'status') {
      const root = this.hiveRoot(); const records = root ? readScratchState(root).records.filter((r) => r.owner === owner) : [];
      return { status: 200, body: { ok: true, line: `${records.length} registered scratch root(s)`, records } };
    }
    return { status: 400, body: { ok: false, line: 'refused: scratch op is unknown' } };
  }
}

/** Non-following disk count for digest/budget decisions. */
export function scratchBytes(root: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st; try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) { total += st.size; return; }
    if (!st.isDirectory()) return;
    let names: string[] = []; try { names = readdirSync(p); } catch { return; }
    for (const n of names) walk(join(p, n));
  };
  walk(root); return total;
}

/** Async, non-following scan for the digest: it never runs synchronous filesystem work on main. */
export async function scratchBytesAsync(root: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    let st; try { st = await lstat(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) { total += st.size; return; }
    if (!st.isDirectory()) return;
    let names: string[]; try { names = await readdir(p); } catch { return; }
    for (let i = 0; i < names.length; i += 64) await Promise.all(names.slice(i, i + 64).map((n) => walk(join(p, n))));
  };
  await walk(root); return total;
}

/** `lstat` needs a current type check in callers, but stat is useful to tests/importers. */
export const scratchStat = (p: string) => statSync(p);
