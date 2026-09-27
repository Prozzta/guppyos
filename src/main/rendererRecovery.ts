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
    deps.log({ kind: 'render-process-gone', reason: d.reason, exitCode: d.exitCode, pid, windowUptimeMs: at - created, recovery: decision.action, streak: decision.streak });
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
