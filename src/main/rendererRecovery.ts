/**
 * WHITE-SCREEN-162 → RENDERER-RECOVERY-164: bring a window back after its renderer dies.
 *
 * 1.1.62 only LOGGED `render-process-gone`. The renderer crashed (exit -36861, Crashpad's
 * "not connected to a handler"), nothing replaced it, and the window stayed white for hours
 * while main, the PTYs and the agents kept working unseen. Main's state survives a renderer
 * crash untouched, so the view can simply be brought back:
 *
 *   1st crash                         -> reload the same webContents after RELOAD_DELAY_MS
 *   2nd crash within WINDOW_MS of the previous one -> recreate the BrowserWindow once
 *   3rd crash within WINDOW_MS of the previous one -> give up: stop recovering, say so in a
 *                                        dialog; the agents keep running
 * A quiet gap longer than WINDOW_MS starts the count again. `clean-exit` is not a crash.
 *
 * The policy is pure (time is passed in) so it is unit-tested without Electron; the wiring
 * takes its Electron pieces as dependencies so the hidden electron-harness can drive it with
 * a real BrowserWindow and a real `forcefullyCrashRenderer`.
 */

export const RELOAD_DELAY_MS = 500;
export const WINDOW_MS = 2 * 60 * 1000;

export type RecoveryAction = 'reload' | 'recreate' | 'give-up' | 'ignore';

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Crashes in the current streak (each within WINDOW_MS of the previous one). */
  streak: number;
}

/** One logical window's crash history; survives a recreate (the new window inherits it). */
export class RecoveryPolicy {
  private lastCrashAt: number | null = null;
  private streak = 0;
  private gaveUp = false;

  constructor(private readonly windowMs = WINDOW_MS) {}

  onGone(reason: string, now: number): RecoveryDecision {
    if (reason === 'clean-exit') return { action: 'ignore', streak: this.streak };
    if (this.gaveUp) return { action: 'ignore', streak: this.streak };
    this.streak = this.lastCrashAt !== null && now - this.lastCrashAt <= this.windowMs ? this.streak + 1 : 1;
    this.lastCrashAt = now;
    if (this.streak === 1) return { action: 'reload', streak: 1 };
    if (this.streak === 2) return { action: 'recreate', streak: 2 };
    this.gaveUp = true;
    return { action: 'give-up', streak: this.streak };
  }

  get givenUp(): boolean { return this.gaveUp; }
}

/** What the renderer shows once after it comes back ("the view crashed and was restored"). */
export interface RecoveryNotice {
  at: number;
  action: 'reload' | 'recreate';
  reason: string;
  streak: number;
}

/** The Electron-shaped surface the wiring needs (a BrowserWindow, narrowed). */
export interface RecoverableWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    reload(): void;
    getOSProcessId(): number;
    on(event: 'render-process-gone', listener: (e: unknown, details: { reason: string; exitCode: number }) => void): unknown;
    on(event: 'did-finish-load', listener: () => void): unknown;
  };
}

export interface RecoveryDeps<W extends RecoverableWindow> {
  policy: RecoveryPolicy;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** The log row (kind render-process-gone), with pid/uptime added. */
  log: (row: Record<string, unknown>) => void;
  /** Build the replacement window, move this window's terminals to it, destroy this one. */
  recreate: (win: W) => W | null;
  /** Called once when recovery stops. */
  giveUp: (win: W, decision: RecoveryDecision) => void;
  /** Hand the one-shot notice to the (new) window's renderer. */
  setNotice: (win: W, notice: RecoveryNotice) => void;
  /** While the app is quitting, a dying renderer is not recovered. */
  quitting: () => boolean;
  /** The last memory samples to attach to the crash row (RendererMemorySampler.recent). */
  recentMemory?: () => unknown[];
  /** The crash dump written for this crash, if one appears (crashDumps.waitForDump). Only the
   *  LOG ROW waits for it (bounded); the recovery itself never does. */
  findDump?: (crashedAt: number) => Promise<{ path: string; size: number } | null>;
  /** Re-arm on the replacement window (the same policy, so the streak carries over). */
  install: (win: W) => void;
}

/** Wire one window. Idempotent per window: the caller installs it exactly once. */
export function installRendererRecovery<W extends RecoverableWindow>(win: W, deps: RecoveryDeps<W>): void {
  const created = deps.now();
  let pid: number | null = null;
  const notePid = (): void => { try { pid = win.webContents.getOSProcessId() || pid; } catch { /* gone */ } };
  win.webContents.on('did-finish-load', notePid);
  notePid();
  win.webContents.on('render-process-gone', (_e, d) => {
    const at = deps.now();
    const decision = deps.quitting() ? { action: 'ignore' as const, streak: 0 } : deps.policy.onGone(d.reason, at);
    const row = { kind: 'render-process-gone', reason: d.reason, exitCode: d.exitCode, pid, windowUptimeMs: at - created, recovery: decision.action, streak: decision.streak, recentMemory: deps.recentMemory?.() ?? [] };
    if (deps.findDump) {
      const write = (dump: { path: string; size: number } | null): void => { deps.log({ ...row, crashedAt: at, dumpPath: dump?.path ?? null, dumpBytes: dump?.size ?? null }); };
      deps.findDump(at).then(write, () => write(null));
    } else deps.log(row);
    if (decision.action === 'reload') {
      deps.setTimer(() => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        deps.setNotice(win, { at, action: 'reload', reason: d.reason, streak: decision.streak });
        try { win.webContents.reload(); } catch { /* the window went away meanwhile */ }
      }, RELOAD_DELAY_MS);
    } else if (decision.action === 'recreate') {
      deps.setTimer(() => {
        if (win.isDestroyed()) return;
        const next = deps.recreate(win);
        if (next) {
          deps.install(next);
          deps.setNotice(next, { at, action: 'recreate', reason: d.reason, streak: decision.streak });
        }
      }, RELOAD_DELAY_MS);
    } else if (decision.action === 'give-up') {
      deps.giveUp(win, decision);
    }
  });
}

/**
 * RENDERER-RECOVERY-164 addendum (the Human: "logging, but the fast append way").
 *
 * Every SAMPLE_MS, main reads `app.getAppMetrics()` (no renderer involvement: no ping, no IPC)
 * and writes one `renderer-memory` row with each renderer ('Tab') and the GPU process: pid,
 * working set and private MB, process uptime. The row goes out through the caller's `log`,
 * which in the app is `hive.appendLog`, the kept-open fast appender (appendLog.ts). This
 * module does no file I/O of its own. The last KEEP samples stay in memory and are attached
 * to the next `render-process-gone` row, so the minutes before a crash are always on record.
 */
export const SAMPLE_MS = 60_000;
export const KEEP_SAMPLES = 10;
/** A renderer at or over this many MB raises one alert row (the Human: 1.5 GB). */
export const ALERT_MB = 1536;
/** ...or at this multiple of its first sample. */
export const ALERT_FACTOR = 2;

/** The part of Electron's ProcessMetric the sampler reads (memory sizes are in KB). */
export interface ProcessMetricLike {
  pid: number;
  type: string;
  creationTime?: number;
  memory?: { workingSetSize?: number; privateBytes?: number };
}

export interface MemorySample {
  at: number;
  procs: Array<{ pid: number; type: 'renderer' | 'gpu'; workingSetMb: number | null; privateMb: number | null; uptimeS: number | null }>;
}

const mb = (kb: number | undefined): number | null => (typeof kb === 'number' && Number.isFinite(kb) ? Math.round(kb / 102.4) / 10 : null);

export class RendererMemorySampler {
  private readonly ring: MemorySample[] = [];

  constructor(private readonly deps: {
    metrics: () => ProcessMetricLike[];
    /** Optional: without it the sampler is IN-MEMORY ONLY (no row is written). */
    log?: (row: Record<string, unknown>) => void;
    now: () => number;
    keep?: number;
    /** ONE row per renderer per condition when it crosses a threshold (the only disk write). */
    alert?: (row: Record<string, unknown>) => void;
    /** Renderer size (MB, private bytes, else working set) that raises an alert. */
    alertMb?: number;
    /** A renderer this many times its FIRST sample raises an alert. */
    alertFactor?: number;
  }) {}

  /** pid -> the renderer's first sampled size (MB), and the alerts already raised for it. */
  private readonly firstMb = new Map<number, number>();
  private readonly alerted = new Set<string>();

  /** Take one sample, remember it, and log it. Never throws. */
  sample(): MemorySample | null {
    let list: ProcessMetricLike[];
    try { list = this.deps.metrics(); } catch { return null; }
    const at = this.deps.now();
    const procs = list
      .filter((p) => p.type === 'Tab' || p.type === 'GPU')
      .map((p) => ({
        pid: p.pid,
        type: p.type === 'GPU' ? 'gpu' as const : 'renderer' as const,
        workingSetMb: mb(p.memory?.workingSetSize),
        privateMb: mb(p.memory?.privateBytes),
        uptimeS: typeof p.creationTime === 'number' ? Math.round((at - p.creationTime) / 1000) : null
      }));
    const s: MemorySample = { at, procs };
    this.checkThresholds(s);
    this.ring.push(s);
    while (this.ring.length > (this.deps.keep ?? KEEP_SAMPLES)) this.ring.shift();
    if (this.deps.log) { try { this.deps.log({ kind: 'renderer-memory', procs }); } catch { /* logging never breaks sampling */ } }
    return s;
  }

  private checkThresholds(s: MemorySample): void {
    if (!this.deps.alert) return;
    const limit = this.deps.alertMb ?? ALERT_MB;
    const factor = this.deps.alertFactor ?? ALERT_FACTOR;
    for (const p of s.procs) {
      if (p.type !== 'renderer') continue;
      const size = p.privateMb ?? p.workingSetMb;
      if (size === null) continue;
      if (!this.firstMb.has(p.pid)) this.firstMb.set(p.pid, size);
      const first = this.firstMb.get(p.pid) as number;
      const raise = (why: 'over-limit' | 'doubled'): void => {
        const key = `${p.pid}|${why}`;
        if (this.alerted.has(key)) return;
        this.alerted.add(key);
        try { this.deps.alert?.({ kind: 'renderer-memory-alert', why, pid: p.pid, mb: size, firstMb: first, limitMb: limit, factor, recent: this.recent() }); } catch { /* never breaks sampling */ }
      };
      if (size >= limit) raise('over-limit');
      if (first > 0 && size >= first * factor) raise('doubled');
    }
  }

  /** The last KEEP samples, oldest first (a copy). */
  recent(): MemorySample[] { return this.ring.map((s) => ({ at: s.at, procs: s.procs.map((p) => ({ ...p })) })); }
}

/**
 * The recreate itself, as injected steps so its ORDER is tested by behaviour (Jim RR-164):
 * create the replacement FIRST, hand every PTY the old window owned to it, repoint the
 * primary-window pointer if it named the old window (a focused floor included), and only then
 * destroy the old window. destroy() skips 'close' (no quit warning / floor confirm); its
 * 'closed' still runs, and a floor's killByOwner then finds nothing to kill.
 */
export interface RecreateSteps<W> {
  create: () => W;
  reassign: (from: W, to: W) => number;
  getMain: () => W | null;
  setMain: (w: W) => void;
  destroy: (w: W) => void;
  log?: (row: Record<string, unknown>) => void;
}
export function performRecreate<W>(old: W, steps: RecreateSteps<W>): W {
  const next = steps.create();
  const moved = steps.reassign(old, next);
  try { steps.log?.({ kind: 'render-recovery-recreate', ptysMoved: moved }); } catch { /* best-effort */ }
  if (steps.getMain() === old) steps.setMain(next);
  steps.destroy(old);
  return next;
}
