/**
 * PTY-KILL-PID-IDENTITY: bind a terminal's root pid to the root itself.
 *
 * Every tree kill names the root by pid (`taskkill /T /F /PID`, `kill(-pid)`), and a pid is only a
 * number: once the root is dead the OS hands it to somebody else. PTY-CLOSETREE-PIDREUSE made the
 * Windows sweep ask node-pty whether the root's exit had been reported (pty.ts rootState), which
 * left a window: node-pty closes its process handle first and reports the exit to JS afterwards, a
 * main-loop turn later at best. In that window the pid is free and the report says "running".
 *
 * Windows: holdRoot opens OUR OWN handle to the root (the in-repo addon, resources/fs-handle) in
 * the same synchronous turn as the spawn. While that handle is open Windows cannot reuse the pid,
 * so a kill that names it reaches the root or nobody, and "is the root alive" is asked of the
 * handle. The hold is released only after the last kill of that terminal.
 *
 * PTY-HOLD-NODEPTY-HANDOFF: opening by pid still came after node-pty's CreateProcess, and node-pty
 * closes its own handle as soon as the root exits, so a root that died at once could have lost its
 * pid before procOpen ran. The patched node-pty (tools/patch-node-pty-root-handle.cjs) now hands
 * over a duplicate of the handle CreateProcess returned (rootHandoff), and holdRoot adopts THAT
 * (procAdopt): there is no moment at which the pid was unreserved. Opening by pid remains only as
 * the fallback for a node-pty or an addon without the handoff, and says so once.
 *
 * POSIX: nothing can reserve a pid from JS (node-pty reaps the root itself), so the root is
 * recognised by its start time instead, read at spawn and again just before the group kill
 * (pidIdentity). That is a check followed by a kill, not a hold. What it leaves open is said at
 * PidVerdict.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Our own open handle to a terminal's root process (Windows). */
export interface RootHold {
  /** True while the root itself is running. False once it exited, and after release(). */
  alive(): boolean;
  /** Close the handle. Idempotent. Only after the last kill that names the pid. */
  release(): void;
}

type HoldAddon = {
  procOpen(pid: number): unknown;
  procAlive(hold: unknown): boolean;
  procClose(hold: unknown): void;
  /** PTY-HOLD-NODEPTY-HANDOFF. Absent from an addon built before it. */
  procAdopt?(rootHandle: unknown, pid: number): unknown;
};

const HOLD_ADDON = 'guppy_fs_handle.node';
let holdAddon: HoldAddon | null | undefined;

function loadHoldAddon(): HoldAddon | null {
  if (holdAddon !== undefined) return holdAddon;
  // The same file and the same two places as src/main/fs.ts loadHandleAddon.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'fs-handle', HOLD_ADDON)] : []),
    join(__dirname, '..', '..', 'resources', 'fs-handle', 'bin', HOLD_ADDON)
  ];
  try {
    const found = candidates.find((p) => existsSync(p));
    if (!found) throw new Error(`not found at ${candidates.join(' or ')}`);
    const mod = { exports: {} as Partial<HoldAddon> };
    process.dlopen(mod, found);
    const { procOpen, procAlive, procClose } = mod.exports;
    if (typeof procOpen !== 'function' || typeof procAlive !== 'function' || typeof procClose !== 'function') {
      throw new Error(`${found} lacks procOpen (built before PTY-KILL-PID-IDENTITY: run tools/build-fs-handle.cjs)`);
    }
    holdAddon = mod.exports as HoldAddon;
  } catch (e) {
    holdAddon = null;
    console.error(`[pty] root process holds unavailable; kills fall back to node-pty's exit report (${e instanceof Error ? e.message : String(e)})`);
  }
  return holdAddon;
}

/**
 * The root handle the patched node-pty kept for us at spawn (Windows): `_rootHandle` on its
 * WindowsPtyAgent, an opaque external. Undefined on any other node-pty, platform or shape.
 */
export function rootHandoff(proc: unknown): unknown {
  try {
    const agent = (proc as { _agent?: { _rootHandle?: unknown } } | null | undefined)?._agent;
    const handle = agent?._rootHandle;
    return handle === null ? undefined : handle;
  } catch { return undefined; }
}

let handoffFallbackSaid = false;
function sayHandoffFallback(why: string): void {
  if (handoffFallbackSaid) return;
  handoffFallbackSaid = true;
  console.error(`[pty] node-pty's root handle was not adopted; roots are opened by pid, after the spawn (${why})`);
}

/**
 * Hold a just-spawned root by handle. Call it in the SAME synchronous turn as the spawn, with
 * rootHandoff(proc): the hold is then a duplicate of node-pty's own handle to the root, valid even
 * if the root has already exited. Without a handoff (or when it is refused) the root is opened by
 * pid instead. Null when there is nothing to hold with (not Windows, addon missing) or, opening by
 * pid, the pid is not a live child of this process: the caller then falls back to node-pty's exit
 * report (pty.ts rootState).
 */
export function holdRoot(pid: number | undefined, platform: NodeJS.Platform = process.platform, handoff?: unknown): RootHold | null {
  if (platform !== 'win32' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const addon = loadHoldAddon();
  if (!addon) return null;
  let handle: unknown;
  let adopted = false;
  if (handoff === undefined) sayHandoffFallback('node-pty returned none: built without tools/patch-node-pty-root-handle.cjs');
  else if (typeof addon.procAdopt !== 'function') sayHandoffFallback('the addon lacks procAdopt: run tools/build-fs-handle.cjs');
  else {
    try { handle = addon.procAdopt(handoff, pid); adopted = true; } catch (e) {
      sayHandoffFallback(e instanceof Error ? e.message : String(e));
    }
  }
  if (!adopted) {
    try { handle = addon.procOpen(pid); } catch { return null; }
  }
  let open = true;
  return {
    alive: () => {
      if (!open) return false;
      try { return addon.procAlive(handle) === true; } catch { return false; }
    },
    release: () => {
      if (!open) return;
      open = false;
      try { addon.procClose(handle); } catch { /* the finalizer closes it */ }
    }
  };
}

/**
 * What the pid is NOW, against the root it was at spawn (POSIX):
 *   'same'     a process with the root's start time: the root, alive or not yet reaped;
 *   'gone'     no process under the pid. A process group under that number can only be the root's
 *              own leftovers, or one a later owner of the pid created and then left (see below);
 *   'other'    a process with a different start time: the pid was reused. Never kill;
 *   'unknown'  the start time could not be read at spawn or now.
 * Left open, and not closable without reserving the pid: a stranger that takes the pid between
 * this check and the kill, and a stranger that took the pid, made a process group of it and exited
 * while members remain. Both need the pid counter to wrap inside the kill grace.
 */
export type PidVerdict = 'same' | 'gone' | 'other' | 'unknown';

export interface PidIdentity {
  verdict(): Promise<PidVerdict>;
}

/** A process's start stamp: a string, null when there is no such process, undefined when unreadable. */
export type StampReader = (pid: number) => Promise<string | null | undefined>;

/** Linux: field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat. Read synchronously, so
 *  the stamp taken at spawn is taken before anything else can run. */
export function linuxStamp(pid: number, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null | undefined {
  let text: string;
  try { text = read(`/proc/${pid}/stat`); } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ESRCH' ? null : undefined;
  }
  // "pid (comm) state ppid ...": comm may hold spaces and brackets, so count from the LAST ')'.
  const rest = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
  const start = rest[19];
  return typeof start === 'string' && /^\d+$/.test(start) ? start : undefined;
}

/** macOS: `ps -o lstart= -p <pid>` (no /proc there). ps exits 1 and prints nothing for no process. */
export function darwinStamp(pid: number, run: typeof execFile = execFile): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    try {
      run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000, windowsHide: true }, (err, stdout) => {
        const out = String(stdout ?? '').trim();
        if (out) { resolve(out); return; }
        resolve(err && (err as { code?: unknown }).code === 1 ? null : undefined);
      });
    } catch { resolve(undefined); }
  });
}

export function stampReader(platform: NodeJS.Platform = process.platform): StampReader | null {
  if (platform === 'linux') return (pid) => Promise.resolve(linuxStamp(pid));
  if (platform === 'darwin') return (pid) => darwinStamp(pid);
  return null;
}

/** Remember the root's start stamp now (call it in the spawn's own turn); verdict() compares later. */
export function pidIdentity(pid: number | undefined, read: StampReader | null = stampReader()): PidIdentity {
  const usable = read !== null && typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  const first: Promise<string | null | undefined> = usable
    ? (() => { try { return read(pid).catch(() => undefined); } catch { return Promise.resolve(undefined); } })()
    : Promise.resolve(undefined);
  return {
    verdict: async () => {
      const was = await first;
      if (!usable || typeof was !== 'string') return 'unknown';
      let now: string | null | undefined;
      try { now = await read(pid); } catch { return 'unknown'; }
      if (now === undefined) return 'unknown';
      if (now === null) return 'gone';
      return now === was ? 'same' : 'other';
    }
  };
}
