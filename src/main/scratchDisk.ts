/**
 * Managed floor scratch.  `_work` is deliberately treated as a collection of
 * independently owned, disposable roots: this module never follows a link
 * while measuring or deleting, and never removes a root without proving it is
 * clean, pushed, inactive and either finished or idle.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWriteJson } from './atomicJson';

export const SCRATCH_IDLE_MS = 48 * 60 * 60_000;
export const SCRATCH_STATE_FILE = 'scratch-disk.json';
export const SCRATCH_CACHE_DIR = '.scratch-node-modules';

export interface ScratchRecord {
  path: string;
  owner: string;
  card: string;
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
}
export interface ScratchPlan extends ScratchFacts { action: 'keep' | 'reap'; reason: string }

/** True only for a direct child of `_work`; cache/state directories never qualify. */
export function managedScratchPath(workRoot: string, candidate: string): boolean {
  const root = resolve(workRoot);
  const p = resolve(candidate);
  const name = p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  return dirname(p) === root && name !== '' && !name.startsWith('.') && !name.endsWith('.reaping');
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
      && typeof r.card === 'string' && typeof r.createdAt === 'number' && typeof r.touchedAt === 'number') };
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

function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function under(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Find junctions/symlinks in all worktree node_modules (including @scope entries) targeting `target`. */
export function inboundNodeModulesLinks(workRoot: string, target: string): string[] {
  const out: string[] = []; const root = resolve(workRoot); const wanted = resolve(target);
  let roots: string[] = [];
  try { roots = readdirSync(root).map((n) => join(root, n)); } catch { return out; }
  for (const tree of roots) {
    if (!managedScratchPath(root, tree)) continue;
    const nm = join(tree, 'node_modules');
    if (!existsSync(nm)) continue;
    const inspect = (p: string): void => {
      if (!isLink(p)) return;
      try { if (under(realpathSync(p), wanted)) out.push(p); } catch { /* dead links are reported by status, never made safe */ }
    };
    inspect(nm);
    if (isLink(nm)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(nm); } catch { continue; }
    for (const entry of entries) {
      const p = join(nm, entry); inspect(p);
      if (!entry.startsWith('@') || isLink(p)) continue;
      try { for (const child of readdirSync(p)) inspect(join(p, child)); } catch { /* unreadable means no destructive action elsewhere */ }
    }
  }
  return out.sort();
}

function git(path: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim(); }
  catch { return null; }
}

/** A worktree is acceptable only when its exact HEAD equals its origin tracking ref. */
export function gitScratchFacts(path: string): Pick<ScratchFacts, 'dirty' | 'onOrigin'> {
  const status = git(path, ['status', '--porcelain=v1', '--untracked-files=all']);
  const head = git(path, ['rev-parse', 'HEAD']);
  const upstream = git(path, ['rev-parse', '@{upstream}']);
  return { dirty: status === null || status !== '', onOrigin: !!head && !!upstream && head === upstream };
}

/** Remove links as links, then the verified root.  Caller must have planned/rechecked first. */
export function removeScratchRoot(workRoot: string, path: string): void {
  if (!managedScratchPath(workRoot, path)) throw new Error('refused: path is not a managed _work child');
  // rmSync does not traverse a directory junction; its lstat semantics are the desired boundary.
  rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
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

/** `lstat` needs a current type check in callers, but stat is useful to tests/importers. */
export const scratchStat = (p: string) => statSync(p);
