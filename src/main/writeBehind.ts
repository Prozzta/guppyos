/**
 * LAG-SYNC-WRITES-107: write-behind for three files Electron main used to write synchronously
 * (memory-keys.json, state/mail/<agent>.json, state/mail-cards/*.jsonl). Under disk load one such
 * write held main for 700-900 ms (Jim's jailed stall rows).
 *
 * OPT-IN: the app turns it on once at start (enableWriteBehind). A bare class keeps its synchronous
 * write, so a caller that reads the file right after a timer still finds it.
 *
 * WHOLE FILES (writeFileBehind): tmp + rename off the main thread, one flight per path. A synchronous
 * writer of the same path reports its text (noteSyncWrite). The flight then withdraws; if its rename
 * was already on its way and landed over the synchronous write, that text is written again before the
 * flight ends, and until then a reader takes it from overtakenText instead of the disk. So the last
 * word on disk is always the newest write.
 *
 * APPENDS (appendBehind): one serial lane, each part one appendFile, parts in the order given, jobs in
 * the order queued. A reader adds what is still queued to the disk text (withPendingAppends), so a
 * row is readable from the moment it is queued.
 *
 * QUIT: closeWrites waits (bounded) for what is in flight, then closes whole-file write-behind: no new
 * flight starts, none still writing its tmp may rename, and a rename already under way is waited for.
 * Then the owners write synchronously (flushAppendsSync here; the registry and ledger flushes in their
 * own classes), and no older rename can land over that write after the app has exited.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { atomicWriteTextAsync, renameWithRetry } from './atomicJson';

let enabled = false;
/** Set by closeWrites (quit): whole files are written synchronously from then on. */
let closed = false;
/** Turn write-behind on (the app, once at start) or off (tests). Opens it again after closeWrites. */
export function enableWriteBehind(on = true): void { enabled = on; closed = false; }
export function writeBehindOn(): boolean { return enabled; }
/** May a whole file be written behind? Not after closeWrites: the owner's timer then saves synchronously. */
export function fileWriteBehindOn(): boolean { return enabled && !closed; }

const keyOf = (p: string): string => { const r = resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };

// ---- whole files ----

interface Flight { redo: string | null; done: Promise<void>; /** the guard said yes: the rename is under way */ renaming: boolean }
const flights = new Map<string, Flight>();

export type WriteBehindResult = 'published' | 'withdrawn' | 'overtaken';

/** Is an asynchronous write of `p` under way? */
export function writeInFlight(p: string): boolean { return flights.has(keyOf(p)); }

/** A synchronous writer has just written `text` to `p`. An asynchronous write of `p` in flight gives way to it. */
export function noteSyncWrite(p: string, text: string | (() => string)): void {
  const f = flights.get(keyOf(p));
  if (f) f.redo = typeof text === 'string' ? text : text();
}

/** The text a synchronous writer wrote while an asynchronous write of `p` is still in flight (the disk may
 *  briefly hold the older text), else null: read the disk. */
export function overtakenText(p: string): string | null { return flights.get(keyOf(p))?.redo ?? null; }

function writeTextSync(p: string, text: string): void {
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  try { writeFileSync(tmp, text, 'utf8'); renameWithRetry(tmp, p); }
  catch (error) { try { rmSync(tmp, { force: true }); } catch { /* keep the write error */ } throw error; }
}

/**
 * Write `text` to `p` (tmp + rename) off the main thread. `guard` is asked just before the rename; false
 * withdraws. One flight per path: the caller starts the next write only when this one has ended.
 *   published: `text` is the file.
 *   withdrawn: the guard said no; nothing was written.
 *   overtaken: a synchronous writer wrote meanwhile, and its text is the file.
 * Rejects when the write failed and no synchronous writer took over.
 */
export function writeFileBehind(p: string, text: string, guard?: () => boolean): Promise<WriteBehindResult> {
  const k = keyOf(p);
  if (flights.has(k)) return Promise.reject(new Error(`write-behind: ${basename(p)} is already being written`));
  const f: Flight = { redo: null, done: Promise.resolve(), renaming: false };
  flights.set(k, f);
  const run = (async (): Promise<WriteBehindResult> => {
    let landed = false;
    let failure: { error: unknown } | null = null;
    const commit = (): boolean => { f.renaming = !closed && f.redo === null && (!guard || guard()); return f.renaming; };
    try { landed = await atomicWriteTextAsync(p, text, commit); }
    catch (error) { failure = { error }; }
    f.renaming = false;
    try {
      if (f.redo !== null) {
        // The rename was already on its way when the synchronous writer came: put its text back.
        if (landed) writeTextSync(p, f.redo);
        return 'overtaken';
      }
      if (failure) throw failure.error;
      return landed ? 'published' : 'withdrawn';
    } finally { flights.delete(k); }
  })();
  f.done = run.then(() => undefined, () => undefined);
  return run;
}

// ---- appends ----

export interface AppendPart { file: string; text: string }
interface QueuedPart extends AppendPart { k: string }
interface AppendJob { parts: QueuedPart[]; onFail?: (error: unknown) => void }

const jobs: AppendJob[] = [];
const byKey = new Map<string, QueuedPart[]>();
let flying: QueuedPart | null = null;
let drain: Promise<void> | null = null;

function forget(part: QueuedPart): void {
  const list = byKey.get(part.k);
  if (!list) return;
  const i = list.indexOf(part);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) byKey.delete(part.k);
}

async function appendOne(part: QueuedPart, wanted: () => boolean): Promise<void> {
  try { await appendFile(part.file, part.text); }
  catch (error) {
    // No directory yet: make it, unless a synchronous flush took the part meanwhile (the hive may be gone).
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || !wanted()) throw error;
    await mkdir(dirname(part.file), { recursive: true });
    await appendFile(part.file, part.text);
  }
}

async function runLane(): Promise<void> {
  while (jobs.length) {
    const job = jobs[0];
    while (job.parts.length) {
      const part = job.parts[0];
      flying = part;
      let failure: { error: unknown } | null = null;
      try { await appendOne(part, () => job.parts[0] === part); } catch (error) { failure = { error }; }
      flying = null;
      if (job.parts[0] !== part) break;   // a synchronous flush wrote the whole job meanwhile
      if (failure) {
        // The rest of the job is dropped (a link record never lands without its rows).
        for (const p of job.parts) forget(p);
        job.parts.length = 0;
        try { job.onFail?.(failure.error); } catch { /* the lane goes on */ }
        break;
      }
      forget(part);
      job.parts.shift();
    }
    if (jobs[0] === job) jobs.shift();
  }
  drain = null;
}

/** Queue one job: its parts are appended in order, after every job queued before it. A part that fails
 *  drops the rest of its job and calls `onFail`. */
export function appendBehind(parts: readonly AppendPart[], onFail?: (error: unknown) => void): void {
  if (!parts.length) return;
  const queued = parts.map((p) => ({ file: p.file, text: p.text, k: keyOf(p.file) }));
  for (const p of queued) { const list = byKey.get(p.k); if (list) list.push(p); else byKey.set(p.k, [p]); }
  jobs.push({ parts: queued, onFail });
  if (!drain) drain = runLane();
}

/** `disk` (the file's text, null when it is missing) plus what is still queued for `file`. The part in
 *  flight is added unless the disk text already ends with it. */
export function withPendingAppends(file: string, disk: string | null): string | null {
  const list = byKey.get(keyOf(file));
  if (!list) return disk;
  let rest = '';
  for (const p of list) {
    if (p === flying && (disk ?? '').endsWith(p.text)) continue;
    rest += p.text;
  }
  return rest ? (disk ?? '') + rest : disk;
}

/** Base names of the files in `dir` that have queued appends (a file may not exist on disk yet). */
export function pendingAppendNames(dir: string): string[] {
  const d = keyOf(dir);
  const out: string[] = [];
  for (const [k, list] of byKey) if (dirname(k) === d && list.length) out.push(basename(list[0].file));
  return out;
}

/** Appends queued and not yet on disk. */
export function pendingAppendCount(): number { let n = 0; for (const l of byKey.values()) n += l.length; return n; }

/**
 * Append everything still queued, synchronously and in order (quit, before a hive is copied or left).
 * Call it after settleWrites. A part still in flight then (the wait ran out) is written here as well:
 * it may land twice, never zero times, and the index's readers keep the first copy of an id.
 */
export function flushAppendsSync(): void {
  const all = jobs.splice(0);
  for (const job of all) {
    const parts = job.parts.splice(0);
    let failed: { error: unknown } | null = null;
    for (const part of parts) {
      forget(part);
      if (failed) continue;   // the rest of a failed job is dropped, as on the lane
      try {
        try { appendFileSync(part.file, part.text); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          mkdirSync(dirname(part.file), { recursive: true });
          appendFileSync(part.file, part.text);
        }
      } catch (error) { failed = { error }; }
    }
    if (failed) { try { job.onFail?.(failed.error); } catch { /* go on */ } }
  }
}

const joiners: Array<() => Promise<unknown>> = [];
/**
 * A store with its own async write queue (the roster, the spawned-folder list) names it here, so the
 * one bounded wait on quit, reset and a home change covers it too. Not gated by the write-behind flag.
 */
export function joinOnSettle(pending: () => Promise<unknown>): () => void {
  joiners.push(pending);
  return () => { const i = joiners.indexOf(pending); if (i >= 0) joiners.splice(i, 1); };
}

/** Wait, at most `capMs`, for every write in flight, the append lane and every joined store. */
export async function settleWrites(capMs: number): Promise<void> {
  const waits: Promise<unknown>[] = [...flights.values()].map((f) => f.done);
  for (const pending of joiners) { try { waits.push(pending().catch(() => undefined)); } catch { /* go on */ } }
  if (drain) waits.push(drain.catch(() => undefined));
  if (!waits.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(waits), new Promise<void>((r) => { timer = setTimeout(r, capMs); })]);
  if (timer) clearTimeout(timer);
}

/**
 * QUIT: wait as settleWrites, then close whole-file write-behind for good. A flight still writing its tmp
 * at the cap withdraws (its owner stays dirty and flushes synchronously). A rename already under way
 * cannot be called back, so it is waited for without a cap: the synchronous write that follows goes to
 * the same disk and would wait there anyway, and written before the rename lands it would be passed by
 * the older text once the app has exited. After this resolves no asynchronous rename is in flight and
 * none can start.
 */
export async function closeWrites(capMs: number): Promise<void> {
  await settleWrites(capMs);
  closed = true;
  for (;;) {
    const renaming = [...flights.values()].filter((f) => f.renaming);
    if (!renaming.length) return;
    await Promise.all(renaming.map((f) => f.done));
  }
}
