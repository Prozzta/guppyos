/**
 * FS-IPC-ROOT-TRUST-192 (Jim SHOULD 1): the working folders main itself spawned agents in, kept
 * across restarts, so the files of a stopped non-hive agent (no PTY, not in the registry) still
 * open after the app restarts. Main-only: written by a successful spawn, never from the renderer.
 *
 * Bounded (the newest SPAWNED_CWDS_MAX folders; a re-spawn moves a folder to the newest end).
 * An unreadable or malformed file is an empty list: the other known sources still stand.
 * A failed write keeps this run's list in memory.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const SPAWNED_CWDS_MAX = 200;

export class SpawnedCwds {
  private cwds: string[] | null = null;

  constructor(private readonly file: () => string, private readonly max = SPAWNED_CWDS_MAX) {}

  list(): string[] {
    return [...this.load()];
  }

  add(cwd: string): void {
    if (typeof cwd !== 'string' || !cwd) return;
    const key = resolve(cwd);
    const same = (c: string): boolean => (process.platform === 'win32' ? c.toLowerCase() === key.toLowerCase() : c === key);
    const next = this.load().filter((c) => !same(c));
    next.push(key);
    this.cwds = next.slice(-this.max);
    try {
      const f = this.file();
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(`${f}.tmp`, JSON.stringify({ v: 1, cwds: this.cwds }));
      renameSync(`${f}.tmp`, f);
    } catch { /* this run's list stands */ }
  }

  private load(): string[] {
    if (this.cwds) return this.cwds;
    let cwds: string[] = [];
    try {
      const j = JSON.parse(readFileSync(this.file(), 'utf8')) as { v?: unknown; cwds?: unknown };
      if (j && j.v === 1 && Array.isArray(j.cwds)) cwds = j.cwds.filter((c): c is string => typeof c === 'string' && c.length > 0).slice(-this.max);
    } catch { /* none yet, or unreadable */ }
    this.cwds = cwds;
    return cwds;
  }
}
