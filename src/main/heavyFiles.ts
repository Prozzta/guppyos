// LAG-NAMED-STALLS-RESIDUAL-108: the files the heavy-lock classifier asks about, read off the main
// thread.
//
// The classifier (heavyJob.ts) is synchronous: it asks a reader "is this path a file, a folder, or
// not there, and what is its text" for every command word that may be a script, and a lister for
// the test files of a runner's repo. On the main thread those answers were statSync, readFileSync
// and readdirSync at every PreToolUse of every agent; a word that is no file at all (`(`) is asked
// about like any other, and one slow answer stalled the app (statSync:( 2260 ms, 1.1.107).
//
// Read-ahead keeps the classifier as it is and takes the disk out of it: the classifier is run
// against this cache, which notes each path it does not hold and answers "not there"; the noted
// paths are read with fs.promises; and the classifier is run again, until a run asks for nothing
// new. The run that counts then finds every answer here. Which paths a command leads to is still
// decided by the classifier alone, so nothing here knows what a command means.
import { promises as fsp, type Dirent } from 'node:fs';
import { join } from 'node:path';

/** What the reader says about one path: a file (its text when it is within the size limit and
 *  read), or a folder. `null` in the cache: not there, or neither. */
export interface HeavyFile { size: number; dir: boolean; text: string | null }

/** A runner's test files under one `test` folder, as HookServer.listTestFiles lists them: every
 *  `*.test.cjs`, three folders deep, names relative to the folder; null when it is no folder. */
export async function listTestFilesAsync(root: string): Promise<string[] | null> {
  try { if (!(await fsp.stat(root)).isDirectory()) return null; } catch { return null; }
  const out: string[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    // One entry after the other: the names come out in the order the synchronous walk gives.
    for (const e of entries) {
      if (e.isDirectory()) { if (depth < 3 && e.name !== 'node_modules') await walk(join(dir, e.name), `${rel}${e.name}/`, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.test.cjs')) out.push(`${rel}${e.name}`);
    }
  };
  await walk(root, '', 0);
  return out;
}

export class HeavyFileCache {
  private readonly files = new Map<string, HeavyFile | null>();
  private readonly lists = new Map<string, string[] | null>();
  private readonly wantFiles = new Set<string>();
  private readonly wantLists = new Set<string>();
  /** True while the classifier is run only to learn what it asks for. */
  noting = false;

  /** `maxText`: the largest file whose text is read (the classifier reads none above it). */
  constructor(private readonly maxText: number) {}

  /** The answer for `path`. Not held: while noting, the path is noted and the answer is null (not
   *  there); otherwise undefined, and the caller reads the disk itself. */
  file(path: string): HeavyFile | null | undefined {
    if (this.files.has(path)) return this.files.get(path) ?? null;
    if (!this.noting) return undefined;
    this.wantFiles.add(path);
    return null;
  }

  /** The test files under `root`, as `file` answers. */
  list(root: string): string[] | null | undefined {
    if (this.lists.has(root)) return this.lists.get(root) ?? null;
    if (!this.noting) return undefined;
    this.wantLists.add(root);
    return null;
  }

  /** Read what was noted. False when nothing was: the last run had every answer. */
  async fill(): Promise<boolean> {
    if (!this.wantFiles.size && !this.wantLists.size) return false;
    const files = [...this.wantFiles];
    const lists = [...this.wantLists];
    this.wantFiles.clear();
    this.wantLists.clear();
    await Promise.all([
      ...files.map(async (path) => { this.files.set(path, await this.read(path)); }),
      ...lists.map(async (root) => { this.lists.set(root, await listTestFilesAsync(root)); }),
    ]);
    return true;
  }

  private async read(path: string): Promise<HeavyFile | null> {
    try {
      const st = await fsp.stat(path);
      if (st.isDirectory()) return { size: 0, dir: true, text: null };
      if (!st.isFile()) return null;
      let text: string | null = null;
      // A read that fails after the stat (deleted, locked) leaves a file with no text: unreadable.
      if (st.size <= this.maxText) { try { text = await fsp.readFile(path, 'utf8'); } catch { text = null; } }
      return { size: st.size, dir: false, text };
    } catch { return null; }
  }
}
