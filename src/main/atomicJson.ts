/**
 * Atomic JSON publish (temp file + rename), shared by the hive's authorities and the
 * per-agent mail ledger (ZT-I1-MAIL). This is the v1.1.74 LEDGER-WIPE writer, moved out of
 * `HiveManager` unchanged so a second authority can use it without a second copy.
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs';
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
