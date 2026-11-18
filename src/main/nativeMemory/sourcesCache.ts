/**
 * LAG-MAIN-SYNC-REMAINDER-108: memory-sources.json, kept in memory for main.
 *
 * Main asked readSourcesConfig() for every claim-level check, every derived-repo lookup and every
 * import pass: an existsSync and a readFileSync of the same small file about 17 to 20 times a minute
 * on the main thread, each one able to wait behind a busy disk (2966 ms inside one stall, 1.1.107).
 *
 * The cache reads the file synchronously once per hive root (the first get, and the first get
 * after drop()), then answers from memory. The file is re-read OFF the main thread on a timer, so
 * an edit made outside main (god, the Human, the hive CLI) is seen within one `revalidateMs`
 * (2 s). Main's own writers (the floor seed, a ledger promotion) call drop(), so main never
 * reads back its own write late.
 *
 * It answers exactly as readSourcesConfig does (the same parser): no file or a file that is not
 * JSON is the empty config. The one difference: a re-read that fails for any reason other than the
 * file not being there (a writer holds it mid-rename) keeps the value in hand and tries again at
 * the next check, rather than dropping every agent's level for 2 s.
 */
import { join } from 'node:path';
import { readFileTracked } from '../atomicJson';
import { parseSourcesConfig, readSourcesConfig, SOURCES_CONFIG_FILE, type SourcesConfig } from './sources';

export const SOURCES_REVALIDATE_MS = 2000;

export interface SourcesConfigCacheOptions {
  revalidateMs?: number;
  /** Called after each timer check (tests wait on it). */
  onCheck?: () => void;
}

export class SourcesConfigCache {
  private readonly kept = new Map<string, SourcesConfig>();
  /** Raised by drop() and by a synchronous read: a check started before it does not store. */
  private gen = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private disposed = false;

  constructor(private readonly opts: SourcesConfigCacheOptions = {}) {}

  get(root: string): SourcesConfig {
    const have = this.kept.get(root);
    if (have) return have;
    const read = readSourcesConfig(root);
    this.gen++;
    this.kept.set(root, read);
    this.arm();
    return read;
  }

  /** Re-read `root`'s file off the main thread and keep the result. */
  async refresh(root: string): Promise<void> {
    const gen = this.gen;
    let next: SourcesConfig;
    try { next = parseSourcesConfig(await readFileTracked(join(root, SOURCES_CONFIG_FILE), 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return;
      next = parseSourcesConfig(null);
    }
    if (gen === this.gen && !this.disposed) this.kept.set(root, next);
  }

  /** Main wrote the file: forget every kept config, so the next get reads the disk. */
  drop(): void {
    this.gen++;
    this.kept.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.drop();
  }

  private arm(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => { void this.check(); }, this.opts.revalidateMs ?? SOURCES_REVALIDATE_MS);
    this.timer.unref?.();
  }

  /** One timer check: every kept root, one at a time; a check still running is not doubled. */
  private async check(): Promise<void> {
    if (this.checking || this.disposed) return;
    this.checking = true;
    try { for (const root of [...this.kept.keys()]) await this.refresh(root); }
    finally { this.checking = false; }
    if (!this.disposed) { try { this.opts.onCheck?.(); } catch { /* a test hook */ } }
  }
}
