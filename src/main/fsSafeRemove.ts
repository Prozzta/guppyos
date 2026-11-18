/**
 * Link-safe removal (ELECTRON-RMSYNC-*-108, FS-REMOVE-READDIR-GAP-108).
 *
 * Electron 45's recursive rmSync follows Windows junctions, so nothing here hands a folder to a
 * recursive rm. A walk made of lstat, readdir, unlink and rmdir on paths is not enough either:
 * each call resolves the path again, and a link put where a folder was between two of them makes
 * the next call list or delete the link's target (it lost a victim's files once in 26,571
 * jittered runs). So the tree delete, safeRemoveTree / safeRemoveTreeSync, is done by the
 * fs-handle addon's removeTree (resources/fs-handle/guppy-fs-handle.c): every folder is opened
 * once without following a link and is listed and emptied through that handle.
 *
 * There is NO JS fallback. When the addon cannot be loaded the delete is refused: an Error with
 * code EREMOVER_UNAVAILABLE, one log line per refused tree, and a count in removerRefusals() for
 * the caller's summary. Keeping a folder is recoverable; deleting through a link is not.
 *
 * The helpers that only touch links (removeReparsePoint*, unlinkReparsePointsUnder*,
 * findReparsePoints*) are still path walks: they never delete a file or a folder, but a link
 * swapped in under them can make them list, or unlink links, inside its target.
 */
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';

/** The removeTree contract this file was written against. An addon that reports another is not used. */
export const REMOVE_TREE_API = 1;
const ADDON_NAME = 'guppy_fs_handle.node';

interface RemoveTreeAddon {
  removeTreeApi: number;
  /** Both return how many links they removed. keepRoot empties the folder and leaves it. */
  removeTree(path: string, keepRoot?: boolean): number;
  removeTreeAsync(path: string, keepRoot?: boolean): Promise<number>;
}

/**
 * Where a build of the addon can be, best first: the running app's resources, this source tree's
 * own build, then an installed Guppy (a worktree with no native build still gets a real remover).
 */
export function removerCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const out: string[] = [];
  if (resourcesPath) out.push(join(resourcesPath, 'fs-handle', ADDON_NAME));
  out.push(join(__dirname, '..', '..', 'resources', 'fs-handle', 'bin', ADDON_NAME));
  if (env.GUPPY_PACKAGED_EXE) out.push(join(dirname(env.GUPPY_PACKAGED_EXE), 'resources', 'fs-handle', ADDON_NAME));
  if (process.platform === 'win32' && env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'Guppy', 'resources', 'fs-handle', ADDON_NAME));
  if (process.platform === 'darwin') out.push(join('/Applications', 'Guppy.app', 'Contents', 'Resources', 'fs-handle', ADDON_NAME));
  return [...new Set(out)];
}

function openAddon(file: string): Partial<RemoveTreeAddon> {
  const mod = { exports: {} as Partial<RemoveTreeAddon> };
  process.dlopen(mod, file);
  return mod.exports;
}

/**
 * Load the first candidate that is there AND reports this file's removeTree contract. A build from
 * before removeTree, or with another contract, is passed over and named in the reason: an old
 * .node is refused, not trusted.
 */
export function loadRemover(candidates: string[] = removerCandidates(), open: (file: string) => Partial<RemoveTreeAddon> = openAddon): { addon: RemoveTreeAddon; from: string } | { addon: null; reason: string } {
  const why: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const a = open(file);
      if (a.removeTreeApi === REMOVE_TREE_API && typeof a.removeTree === 'function' && typeof a.removeTreeAsync === 'function') {
        return { addon: a as RemoveTreeAddon, from: file };
      }
      why.push(`${file}: removeTree contract ${String(a.removeTreeApi)}, need ${REMOVE_TREE_API}`);
    } catch (e) {
      why.push(`${file}: ${(e as Error).message}`);
    }
  }
  return { addon: null, reason: why.length ? why.join('; ') : `no ${ADDON_NAME} build found` };
}

let loaded: RemoveTreeAddon | null = null;
let refusals = 0;
let lastReason = '';

/** How many tree deletes this process refused because the addon was unavailable, and the last reason. */
export function removerRefusals(): { count: number; reason: string } {
  return { count: refusals, reason: lastReason };
}

/** The addon, or the refusal: logged once per tree, counted, thrown. Never a JS walk instead. */
function removerFor(path: string): RemoveTreeAddon {
  if (loaded) return loaded;
  const got = loadRemover(); // not cached while it fails: a build can appear later
  if (got.addon) { loaded = got.addon; return loaded; }
  refusals += 1;
  lastReason = got.reason;
  console.error(`[fsSafeRemove] REFUSED to remove ${path}: the link-safe remover (fs-handle addon) is unavailable: ${got.reason}`);
  throw Object.assign(new Error(`refused: link-safe remover unavailable (${got.reason})`), { code: 'EREMOVER_UNAVAILABLE', path });
}

/** The form the addon wants: absolute, and on Windows the long-path form. */
function nativePath(path: string): string {
  return toNamespacedPath(resolve(path));
}

/** After the hook ran, a root that is no longer a real folder is this refusal. */
function changed(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException).code !== 'EREFUSED') return error;
  const was = (error as Error).message;
  if (/reparse point/.test(was)) return Object.assign(new Error('refused: root became a reparse point'), { code: 'EREFUSED' });
  return Object.assign(new Error('refused: directory changed during removal'), { code: 'EREFUSED' });
}

/** Remove exactly one symlink/junction entry; never recurse into its target. */
export function removeReparsePointSync(path: string): void {
  if (!lstatSync(path).isSymbolicLink()) throw new Error('refused: expected a reparse point');
  if (process.platform === 'win32') {
    try { rmdirSync(path); return; } catch { unlinkSync(path); return; }
  }
  unlinkSync(path);
}

/** Unlink all nested reparse points. An unreadable path throws and fails closed. */
export function unlinkReparsePointsUnderSync(path: string): string[] {
  const removed: string[] = [];
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { removeReparsePointSync(p); removed.push(p); return; }
    if (!st.isDirectory()) return;
    for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(path);
  return removed;
}

/** Enumerate reparse points without following them. */
export function findReparsePointsSync(path: string): string[] {
  const found: string[] = [];
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { found.push(p); return; }
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
  };
  walk(path);
  return found;
}

/**
 * Delete the folder tree at `path`: a link in it is removed as a link, and no step can be made to
 * follow one that appears while this runs. The root must be a real folder (a link or a file is
 * refused; a missing one throws ENOENT). The optional hook is test-only race injection: the tree
 * is emptied, the hook runs, then what is there by then is removed with the root.
 */
export function safeRemoveTreeSync(path: string, beforeRootRmdir?: () => void): void {
  const addon = removerFor(path);
  const p = nativePath(path);
  if (!beforeRootRmdir) { addon.removeTree(p); return; }
  addon.removeTree(p, true);
  beforeRootRmdir();
  try { addon.removeTree(p); } catch (error) { throw changed(error); }
}

export async function removeReparsePoint(path: string): Promise<void> {
  if (!(await lstat(path)).isSymbolicLink()) throw new Error('refused: expected a reparse point');
  if (process.platform === 'win32') {
    try { await rmdir(path); return; } catch { await unlink(path); return; }
  }
  await unlink(path);
}

export async function unlinkReparsePointsUnder(path: string): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) { await removeReparsePoint(p); removed.push(p); return; }
    if (!st.isDirectory()) return;
    for (const name of await readdir(p)) await walk(join(p, name));
  };
  await walk(path); return removed;
}

export async function findReparsePoints(path: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) { found.push(p); return; }
    if (st.isDirectory()) for (const name of await readdir(p)) await walk(join(p, name));
  };
  await walk(path); return found;
}

/** The same delete on a worker thread: the main process never blocks on a large tree. The hook is test-only. */
export async function safeRemoveTree(path: string, beforeRootRmdir?: () => void | Promise<void>): Promise<void> {
  const addon = removerFor(path);
  const p = nativePath(path);
  if (!beforeRootRmdir) { await addon.removeTreeAsync(p); return; }
  await addon.removeTreeAsync(p, true);
  await beforeRootRmdir();
  try { await addon.removeTreeAsync(p); } catch (error) { throw changed(error); }
}
