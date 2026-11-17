/**
 * ELECTRON-RMSYNC-LINK-SAFE-108: remove a path that may be, or may hold, a junction or symlink.
 *
 * Electron 45's recursive rmSync deletes THROUGH a Windows junction: the files the link points
 * at go too. This is the one call for a caller that has a path and does not know what it is:
 *   missing                nothing to do
 *   a junction or symlink  the link entry is removed, its target is left alone
 *   a real directory       walked bottom-up; a link in it is removed as a link, never followed
 *   a file                 unlinked (never rm: unlink cannot recurse, whatever is there by then)
 * The link handling is fsSafeRemove's; nothing here walks a tree itself.
 *
 * removePathLinkSafe is the one for the main process (it never blocks the loop on a large
 * tree). removePathLinkSafeSync is for a caller that is synchronous itself: the release script.
 *
 * Do not shorten either one to a bare recursive rm. Measured on Electron 45.3.0 and pinned in
 * test/electron-rmsync-link-safe.test.cjs (RUNTIME PIN): rmSync on a junction empties its target;
 * fs.promises.rm on a junction removed the link only. That second result is one runtime version
 * and one shape, not a contract, so the async path takes the same walk.
 *
 * A link planted WHILE a folder is being removed is not followed either: fsSafeRemove removes
 * each entry by itself, bottom-up, and never hands a folder to a recursive rm (which under
 * Electron follows a junction that appears while it runs; test/electron-rmsync-jitter.test.cjs).
 *
 * What remains open: between the lstat and the readdir of one folder, a process that can write
 * the parent can rename that real folder away and put a junction of the same name in its place;
 * the entries then listed are the target's. Only handle-based opens (FILE_FLAG_OPEN_REPARSE_POINT
 * on the folder, then listing by that handle) close it, and Node's fs has no such call.
 *
 * Not covered: a Windows volume mount point (a junction to \??\Volume{...}) is reported by
 * lstat as a directory, not a link, so it is walked like a real folder.
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
