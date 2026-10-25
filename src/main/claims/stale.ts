/**
 * CLAIMS-90 R2 (god fe1140, T2 + T3): stale rows are hidden by default so a reader never has an older value beside
 * the current one (the NeurIPS-2026 PALM finding: one obsolete competing statement in the evidence dropped a 7B reader
 * from 100% to 44.6% even with the newest statement present).
 *   T2: `memory get` prints the current value plus COUNTS of competing / superseded rows; `--all` lists their bodies
 *       (the JSON always carries every row).
 *   T3: a live-mode `memory search` drops confirmed-superseded claim hits (the `prior` rows); `--history` keeps them.
 * One switch turns both variants off for the gate's OFF arm: the environment variable C90_HIDE_STALE=0.
 */
export const HIDE_STALE_ENV = 'C90_HIDE_STALE';

/** True (the default) hides stale rows; `C90_HIDE_STALE=0` shows them. Read per call so a test or the gate can flip it. */
export function hideStale(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HIDE_STALE_ENV] !== '0';
}
