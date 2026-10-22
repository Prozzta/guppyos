/**
 * Atomic JSON publish (temp file + rename), shared by the hive's authorities and the
 * per-agent mail ledger (ZT-I1-MAIL). This is the v1.1.74 LEDGER-WIPE writer, moved out of
 * `HiveManager` unchanged so a second authority can use it without a second copy.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Rename `tmp` onto `target`, retrying the transient Windows EPERM/EBUSY (antivirus, indexer). */
export function renameWithRetry(tmp: string, target: string): void {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { renameSync(tmp, target); return; } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 4) break;
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
