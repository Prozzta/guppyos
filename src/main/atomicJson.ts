/**
 * Atomic JSON publish (temp file + rename), shared by the hive's authorities and the
 * per-agent mail ledger (ZT-I1-MAIL). This is the v1.1.74 LEDGER-WIPE writer, moved out of
 * `HiveManager` unchanged so a second authority can use it without a second copy.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * REGISTRY-RENAME-EPERM-107: this process's own in-flight async reads, by file. Node's async
 * readFile holds the file open across several main-thread turns (open, read, close), and a plain
 * Windows rename over an open file fails with EPERM until the reader closes it. That close needs the
 * main thread, so a sync writer on it must never wait for one of these readers.
 */
const inflightReads = new Map<string, number>();
const readKey = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** fs.promises.readFile that records itself as an in-flight read of `p` until it settles. */
export async function readFileTracked(p: string, encoding: BufferEncoding): Promise<string> {
  const key = readKey(p);
  inflightReads.set(key, (inflightReads.get(key) ?? 0) + 1);
  try { return await readFile(p, encoding); } finally {
    const n = (inflightReads.get(key) ?? 1) - 1;
    if (n > 0) inflightReads.set(key, n); else inflightReads.delete(key);
  }
}

/** True while one of this process's readFileTracked reads of `p` is open. */
export function hasInflightRead(p: string): boolean { return inflightReads.has(readKey(p)); }

type RenameAddon = { posixRename(src: string, dst: string): void };
let renameAddon: RenameAddon | null | undefined;
/** The fs-handle addon's posixRename (Windows), or null when it cannot load. Never throws. */
function loadRenameAddon(): RenameAddon | null {
  if (renameAddon !== undefined) return renameAddon;
  renameAddon = null;
  if (process.platform !== 'win32') return null;
  // Same places src/main/fs.ts looks: packaged <resources>/fs-handle, else the repo's
  // resources/fs-handle/bin two levels up from out/main (bundled) or src/main (tests).
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'fs-handle', 'guppy_fs_handle.node')] : []),
    join(__dirname, '..', '..', 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node')
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) return null;
  try {
    const mod = { exports: {} as { posixRename?: unknown } };
    process.dlopen(mod, found);
    if (typeof mod.exports.posixRename === 'function') renameAddon = mod.exports as RenameAddon;
  } catch (e) {
    console.error(`[atomicJson] POSIX rename unavailable, using plain rename: ${e instanceof Error ? e.message : String(e)}`);
  }
  return renameAddon;
}

/** Test hook: replace (or with null, disable) the POSIX rename; undefined restores the addon. */
export function __setRenameAddonForTest(addon: RenameAddon | null | undefined): void { renameAddon = addon; }

/**
 * Rename `tmp` onto `target`. On Windows the primary path is the fs-handle addon's POSIX rename
 * (FileRenameInfoEx, REPLACE_IF_EXISTS|POSIX_SEMANTICS), which replaces the target even while a
 * reader has it open; that reader keeps the old, whole file. If that fails (an old Windows, a file
 * system without it, no addon), the plain rename runs, retrying the transient EPERM/EBUSY of an
 * antivirus or indexer. It fails fast when the holder is this process's own in-flight read: the sleep
 * would block the very thread that read needs to close, so no retry could ever succeed.
 */
export function renameWithRetry(tmp: string, target: string): void {
  const addon = loadRenameAddon();
  if (addon) {
    try { addon.posixRename(resolve(tmp), resolve(target)); return; } catch { /* fall back to the plain rename */ }
  }
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { renameSync(tmp, target); return; } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 4) break;
      if (hasInflightRead(target)) {
        throw new Error(`Could not atomically publish ${basename(target)}: this process's own async read holds it open, and a sync retry would wait on it forever: ${error instanceof Error ? error.message : String(error)}`);
      }
      sleepSync(20 * (attempt + 1));
    }
  }
  throw new Error(`Could not atomically publish ${basename(target)} after Windows rename retries: ${last instanceof Error ? last.message : String(last)}`);
}

/** Write `data` as pretty JSON to a sibling temp file, then rename it over `p`. A reader sees
 *  the old file or the new one, never a torn write. The temp file is removed on failure. */
export function atomicWriteJson(p: string, data: unknown): void {
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameWithRetry(tmp, p);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* preserve the publish error */ }
    throw error;
  }
}

/** Async sibling for timer/IPC persistence paths; preserves atomic temp+rename semantics.
 *  `commit` (UI-CRAWL fix, the capacity quit race) is asked just before the rename: false withdraws
 *  the write (the temp file is removed, nothing is published, the result is false) because a newer
 *  write, such as the sync one at will-quit, has already been published and must stay the last word. */
export async function atomicWriteTextAsync(p: string, text: string, commit?: () => boolean): Promise<boolean> {
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  let last: unknown;
  try {
    await writeFile(tmp, text, 'utf8');
    for (let attempt = 0; attempt < 5; attempt++) {
      if (commit && !commit()) { await rm(tmp, { force: true }); return false; }
      try { await rename(tmp, p); return true; } catch (error) {
        last = error;
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 4) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    throw new Error(`Could not atomically publish ${basename(p)} after Windows rename retries: ${last instanceof Error ? last.message : String(last)}`);
  } catch (error) { try { await rm(tmp, { force: true }); } catch { /* preserve publish error */ } throw error; }
}

export function atomicWriteJsonAsync(p: string, data: unknown): Promise<boolean> { return atomicWriteTextAsync(p, JSON.stringify(data, null, 2)); }
