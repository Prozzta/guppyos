/**
 * RENDERER-RECOVERY-164 (the Human's final scope): LOCAL crash dumps.
 *
 * WHITE-SCREEN-162 could not say WHY the renderer died: the app never started Electron's
 * crash reporter, so Chromium's Crashpad had no handler, terminated the renderer with the
 * generic 0xFFFF7003 ("not connected to a handler") and wrote no dump. Starting the reporter
 * with uploadToServer:false makes the next crash leave a minidump with the real exception
 * code and stack, in the app's own crashDumps folder. NOTHING leaves the machine: there is no
 * submit URL and uploads are off.
 *
 * Dumps are pruned to the newest KEEP_DUMPS at startup (async, off the startup path), and
 * after a renderer crash `waitForDump` looks (async, bounded) for the dump written for it so
 * its path can go into the render-process-gone row.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

export const KEEP_DUMPS = 3;

export interface CrashReporterLike {
  start(options: { uploadToServer: boolean; compress?: boolean; submitURL?: string }): void;
}

export interface CrashReporterStart { startedAt: number; readyAt: number; ok: boolean; error?: string }

/** Start the reporter, local only. Never throws; the timing goes to startup-timing. */
export function startLocalCrashReporter(reporter: CrashReporterLike, now: () => number = Date.now): CrashReporterStart {
  const startedAt = now();
  try {
    reporter.start({ uploadToServer: false, compress: true });
    return { startedAt, readyAt: now(), ok: true };
  } catch (e) {
    return { startedAt, readyAt: now(), ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The fs calls used (async only), injectable for tests. */
export interface DumpFs {
  readdir(dir: string, opts: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  unlink(path: string): Promise<void>;
}

const realFs: DumpFs = fsp as unknown as DumpFs;

export interface DumpFile { path: string; mtimeMs: number; size: number }

/** Every *.dmp under `dir` (Crashpad keeps them in reports/ and pending/), newest first. */
export async function listDumps(dir: string, fs: DumpFs = realFs, depth = 3): Promise<DumpFile[]> {
  const out: DumpFile[] = [];
  const walk = async (d: string, left: number): Promise<void> => {
    let entries: Awaited<ReturnType<DumpFs['readdir']>>;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && left > 0) await walk(p, left - 1);
      else if (e.isFile() && /\.dmp$/i.test(e.name)) {
        try { const st = await fs.stat(p); out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* vanished */ }
      }
    }
  };
  await walk(dir, depth);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

/** Keep the newest `keep` dumps, delete the rest. Returns the deleted paths. Never throws. */
export async function pruneDumps(dir: string, keep = KEEP_DUMPS, fs: DumpFs = realFs): Promise<string[]> {
  const deleted: string[] = [];
  for (const d of (await listDumps(dir, fs)).slice(keep)) {
    try { await fs.unlink(d.path); deleted.push(d.path); } catch { /* in use or gone */ }
  }
  return deleted;
}

/** The newest dump written at or after `sinceMs`, polling up to `tries` x `intervalMs`, or null. */
export async function waitForDump(
  dir: string,
  sinceMs: number,
  opts: { tries?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  fs: DumpFs = realFs
): Promise<DumpFile | null> {
  const tries = opts.tries ?? 12;
  const intervalMs = opts.intervalMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A dump's mtime can trail the crash event slightly either way; allow a small skew.
  const floor = sinceMs - 2_000;
  for (let i = 0; i < tries; i += 1) {
    const hit = (await listDumps(dir, fs)).find((d) => d.mtimeMs >= floor);
    if (hit) return hit;
    await sleep(intervalMs);
  }
  return null;
}
