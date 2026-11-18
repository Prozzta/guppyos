/**
 * ELECTRON-RMSYNC-LINK-SAFE-108: remove a path that may be, or may hold, a junction or symlink.
 *
 * Electron 45's recursive rmSync deletes THROUGH a Windows junction: the files the link points
 * at go too. This is the one call for a caller that has a path and does not know what it is:
 *   missing                nothing to do
 *   a junction or symlink  the link entry is removed, its target is left alone
 *   a real directory       deleted by the fs-handle addon's removeTree; a link in it is removed
 *                          as a link, never followed
 *   a file                 unlinked (never rm: unlink cannot recurse, whatever is there by then)
 * The link handling is fsSafeRemove's; nothing here walks a tree itself.
 *
 * removePathLinkSafe is the one for the main process (it never blocks the loop on a large
 * tree). removePathLinkSafeSync is for a caller that is synchronous itself: the release script.
 *
 * Do not shorten either one to a bare recursive rm. Measured on Electron 45.3.0 and pinned in
 * test/electron-rmsync-link-safe.test.cjs (RUNTIME PIN): rmSync on a junction empties its target;
 * fs.promises.rm on a junction removed the link only. That second result is one runtime version
 * and one shape, not a contract, so the async path uses the same remover.
 *
 * A link planted WHILE a folder is being removed is not followed either, and neither is a folder
 * swapped for a link between two steps (FS-REMOVE-READDIR-GAP-108): removeTree opens each folder
 * once, without following a link, and lists and deletes through that handle only, so no step
 * resolves a name a second time. A walk on paths (lstat, readdir, unlink) cannot give that, so
 * there is none: without the addon a tree is refused and kept, loudly (fsSafeRemove.ts).
 * Pinned by test/fs-remove-gap.test.cjs and test/electron-rmsync-jitter.test.cjs.
 *
 * A Windows volume mount point (a junction to \??\Volume{...}) is a link to the addon and is
 * removed as one. The check of WHAT the path is, made here with lstat before choosing, is still a
 * path check: if the path changes after it, the remover it is handed to refuses a root that is
 * not a real folder, and unlink removes whatever single entry is there.
 */
import { lstatSync, unlinkSync, type Stats } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { removeReparsePoint, removeReparsePointSync, safeRemoveTree, safeRemoveTreeSync } from './fsSafeRemove';

/** A path that went away between the lstat and the remove is already removed. */
function ignoreMissing(e: unknown): void {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}

export async function removePathLinkSafe(path: string): Promise<void> {
  let st: Stats;
  try { st = await lstat(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) await removeReparsePoint(path);
  else if (st.isDirectory()) await safeRemoveTree(path);
  else await unlink(path).catch(ignoreMissing);
}

export function removePathLinkSafeSync(path: string): void {
  let st: Stats;
  try { st = lstatSync(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) removeReparsePointSync(path);
  else if (st.isDirectory()) safeRemoveTreeSync(path);
  else { try { unlinkSync(path); } catch (e) { ignoreMissing(e); } }
}
