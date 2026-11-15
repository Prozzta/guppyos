/**
 * SCALE-MESSAGES-INDEX / SCALE-DONE-STAT: the hive:messages and hive:inbox mail reads written once as
 * step generators. A generator yields the file operation it needs and gets the result back; the same
 * code runs synchronously (drainMail, for in-process callers and tests) or off the caller's turn on
 * fs/promises in CATCHUP_SLICE_MS slices (runMailSliced, for the IPC handlers), the shape of Andy's
 * A1 mail-card catch-up driver. Every failed operation yields null (a moved or missing file).
 */
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export type MailStat = { mtimeMs: number; size: number; isFile: boolean; isDirectory: boolean };
export type MailOp =
  | { readdir: string }
  | { stat: string }
  | { read: string }
  | { batch: MailOp[] }
  | { tick: true };
/** What a generator yields: an op, or undefined for "end this slice now". */
export type MailStep = MailOp | undefined;
export type MailSteps<T> = Generator<MailStep, T, unknown>;

/** The main-thread budget per slice: a slice ends once this much time has passed. */
export const CATCHUP_SLICE_MS = 8;
/** Concurrent reads per batch (the async runner awaits them together). */
export const MAIL_BATCH = 64;

const toStat = (s: Stats): MailStat => ({ mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() });

export function runMailOpSync(op: MailOp): unknown {
  if ('batch' in op) return op.batch.map(runMailOpSync);
  if ('tick' in op) return undefined;
  try {
    if ('readdir' in op) return readdirSync(op.readdir);
    if ('stat' in op) return toStat(statSync(op.stat));
    return readFileSync(op.read, 'utf8');
  } catch { return null; }
}

export async function runMailOpAsync(op: MailOp): Promise<unknown> {
  if ('batch' in op) return Promise.all(op.batch.map(runMailOpAsync));
  if ('tick' in op) return undefined;
  try {
    if ('readdir' in op) return await readdir(op.readdir);
    if ('stat' in op) return toStat(await stat(op.stat));
    return await readFile(op.read, 'utf8');
  } catch { return null; }
}

export function* listOp(dir: string): MailSteps<string[] | null> { return (yield { readdir: dir }) as string[] | null; }
export function* statOp(path: string): MailSteps<MailStat | null> { return (yield { stat: path }) as MailStat | null; }
export function* readOp(path: string): MailSteps<string | null> { return (yield { read: path }) as string | null; }
/** Several ops at once: one await in the async runner, results in op order. */
export function* batchOp(ops: MailOp[]): MailSteps<unknown[]> {
  if (!ops.length) return [];
  return (yield { batch: ops }) as unknown[];
}
/** A cue to end the slice if its budget is spent (CPU-only loops yield this every few items). */
export function* tick(): MailSteps<void> { yield { tick: true }; }

/** Runs a generator to completion in the caller's turn (blocking fs). */
export function drainMail<T>(g: MailSteps<T>): T {
  let input: unknown;
  for (;;) {
    const r = g.next(input);
    input = undefined;
    if (r.done) return r.value;
    if (r.value) input = runMailOpSync(r.value);
  }
}

export interface MailSliceDeps {
  pause?: () => Promise<void>;
  runOp?: (op: MailOp) => Promise<unknown>;
  clock?: () => number;
  sliceMs?: number;
  /** Called once per slice with its main-thread length (ms), for the bench and tests. */
  onSlice?: (ms: number) => void;
}
const immediate = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Runs a generator off the caller's turn: it starts after a pause, file ops go to fs/promises, and
 * the main thread is handed back whenever CATCHUP_SLICE_MS has passed since the slice began (an
 * op's await also hands it back). Nothing runs in the caller's turn.
 */
export async function runMailSliced<T>(g: MailSteps<T>, deps: MailSliceDeps = {}): Promise<T> {
  const pause = deps.pause ?? immediate;
  const runOp = deps.runOp ?? runMailOpAsync;
  const clock = deps.clock ?? (() => performance.now());
  const budget = deps.sliceMs ?? CATCHUP_SLICE_MS;
  await pause();
  let slice = clock();
  let input: unknown;
  const end = () => { const ms = clock() - slice; deps.onSlice?.(ms); return ms; };
  for (;;) {
    const r = g.next(input);
    input = undefined;
    if (r.done) { end(); return r.value; }
    const op = r.value;
    if (op && !('tick' in op)) {
      end();
      input = await runOp(op);
      slice = clock();
    }
    if (!op || clock() - slice >= budget) {
      end();
      await pause();
      slice = clock();
    }
  }
}

/** Ticks every TICK_EVERY items of a CPU-only loop. */
export const TICK_EVERY = 512;

/** A stable bottom-up merge sort that yields a tick every TICK_EVERY element moves. */
export function* sortSteps<T>(items: readonly T[], cmp: (a: T, b: T) => number): MailSteps<T[]> {
  let a = items.slice();
  const n = a.length;
  if (n < 2) return a;
  let b: T[] = new Array<T>(n);
  let moved = 0;
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        b[k++] = cmp(a[j], a[i]) < 0 ? a[j++] : a[i++];
        if (++moved % TICK_EVERY === 0) yield* tick();
      }
      while (i < mid) b[k++] = a[i++];
      while (j < hi) b[k++] = a[j++];
    }
    [a, b] = [b, a];
    yield* tick();
  }
  return a;
}

/** Merges two lists already sorted by `cmp` (stable: `a` wins ties), ticking as sortSteps does. */
export function* mergeSteps<T>(a: readonly T[], b: readonly T[], cmp: (x: T, y: T) => number): MailSteps<T[]> {
  const out: T[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    out.push(cmp(b[j], a[i]) < 0 ? b[j++] : a[i++]);
    if (out.length % TICK_EVERY === 0) yield* tick();
  }
  while (i < a.length) { out.push(a[i++]); if (out.length % TICK_EVERY === 0) yield* tick(); }
  while (j < b.length) { out.push(b[j++]); if (out.length % TICK_EVERY === 0) yield* tick(); }
  return out;
}

/** The items of `list` that `keep` accepts, ticking. */
export function* filterSteps<T>(list: readonly T[], keep: (x: T) => boolean): MailSteps<T[]> {
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) {
    if (keep(list[i])) out.push(list[i]);
    if ((i + 1) % TICK_EVERY === 0) yield* tick();
  }
  return out;
}

/** Code-unit order (what Array.prototype.sort() does with strings). */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
