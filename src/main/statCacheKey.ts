/**
 * MAIN-SYNC-LOG-LEDGER: the stat key the in-memory file caches (config.json in config.ts,
 * registry.json and tasks.json in hive.ts) revalidate against, and the racy-git rule that guards it.
 *
 * The key is mtime:ctime:size:ino. ctime and ino matter: an atomic rename-replace gives a new ino,
 * and a writer that restores the old mtime (copy tools, utimes) still moves ctime.
 *
 * A key is only PROVEN once the file's last change is older than the timestamp granularity. Two
 * same-size in-place writes inside one clock tick keep an identical key (Jim, NTFS: 843 of 1999
 * consecutive writes), so a value read between them would be served until the file changed again.
 * As git does for racily clean index entries, a value read within STAT_RACY_MS of the file's last
 * change is cached under no key: it is served for the revalidate window like any other value, and
 * the next revalidate reads the disk once instead of trusting the stat.
 *
 * STAT_RACY_MS = 100: measured on NTFS here, a write that starts up to ~1.1 ms after the recorded
 * mtime can keep the key (the 1 ms timer tick); the default Windows tick is 15.6 ms. 100 ms covers
 * the coarse tick six times over plus scheduling skew, and costs nothing at idle: only a file
 * changed in the last 100 ms is read again, once.
 */
export const STAT_RACY_MS = 100;

type StatLike = { mtimeMs: number; ctimeMs: number; size: number; ino: number };

export function statKey(st: StatLike): string {
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
}

/** The key to cache a value under, or null (unproven: never matches, so the next revalidate reads
 *  the disk) when the file changed within STAT_RACY_MS of `wallNow`, the wall clock taken after
 *  the read. A change stamped far in the future (a clock that went back) cannot share a tick with
 *  a later write, so it is proven like an old one. */
export function provenStatKey(st: StatLike, wallNow: number): string | null {
  const changed = Math.max(st.mtimeMs, st.ctimeMs);
  return Math.abs(wallNow - changed) < STAT_RACY_MS ? null : statKey(st);
}
