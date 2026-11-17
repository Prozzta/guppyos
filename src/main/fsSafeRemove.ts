/**
 * Electron 45's recursive rmSync follows Windows junctions.  Every caller
 * that removes a tree must remove entries bottom-up: links are unlinked as
 * links, files are unlinked, and directories are rmdir'd only after their
 * children. There remains an unavoidable lstat/readdir race: a concurrent
 * creator can make rmdir fail or change an entry after it was listed, but this
 * module never hands a directory to a recursive delete that could follow it.
 */
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
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

/** Bottom-up link-safe deletion. The optional hook is test-only race injection. */
export function safeRemoveTreeSync(path: string, beforeRootRmdir?: () => void): void {
  const walk = (p: string, root: boolean): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { if (root) throw new Error('refused: root is a reparse point'); removeReparsePointSync(p); return; }
    if (!st.isDirectory()) { if (root) throw new Error('refused: root is not a directory'); unlinkSync(p); return; }
    for (const name of readdirSync(p)) walk(join(p, name), false);
    if (root) beforeRootRmdir?.();
    // Re-check immediately before rmdir: if a link appeared in place of this
    // directory it is removed as a link, never traversed recursively.
    const current = lstatSync(p);
    if (current.isSymbolicLink()) { if (root) throw new Error('refused: root became a reparse point'); removeReparsePointSync(p); return; }
    if (!current.isDirectory()) throw new Error('refused: directory changed during removal');
    rmdirSync(p);
  };
  walk(path, true);
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

/** Async bottom-up variant; no recursive rm is used. The hook is test-only. */
export async function safeRemoveTree(path: string, beforeRootRmdir?: () => void | Promise<void>): Promise<void> {
  const walk = async (p: string, root: boolean): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) { if (root) throw new Error('refused: root is a reparse point'); await removeReparsePoint(p); return; }
    if (!st.isDirectory()) { if (root) throw new Error('refused: root is not a directory'); await unlink(p); return; }
    for (const name of await readdir(p)) await walk(join(p, name), false);
    if (root) await beforeRootRmdir?.();
    const current = await lstat(p);
    if (current.isSymbolicLink()) { if (root) throw new Error('refused: root became a reparse point'); await removeReparsePoint(p); return; }
    if (!current.isDirectory()) throw new Error('refused: directory changed during removal');
    await rmdir(p);
  };
  await walk(path, true);
}
