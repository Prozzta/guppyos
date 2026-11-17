/**
 * Electron 45's recursive rmSync follows Windows junctions.  Every caller
 * that removes a tree must first remove reparse points as link entries, then
 * prove the tree link-free before recursive removal is allowed.
 */
import { lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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

/** Link-safe recursive deletion. The root itself must be a real directory. */
export function safeRemoveTreeSync(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error('refused: root is a reparse point');
  unlinkReparsePointsUnderSync(path);
  if (findReparsePointsSync(path).length) throw new Error('refused: reparse point remained after unlink pass');
  rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
}
