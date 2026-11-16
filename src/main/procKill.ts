/**
 * Process-tree termination helpers (PID-release hardening).
 *
 * Every explicit kill path used to be a bare node-pty `proc.kill()` — SIGHUP to
 * the DIRECT child only. Two leaks follow: (1) a child that ignores/queues
 * SIGHUP never dies, so its PID lingers for the machine's uptime; (2) even when
 * the child dies, its own children (MCP servers, helper daemons the session
 * started) are orphaned to PID 1 and never released. With the breaker/heartbeat
 * spawning and killing sessions all day, PIDs accumulate steadily.
 *
 * The fix: the pty child is a session leader (forkpty does setsid), so its
 * process GROUP covers its descendants — after a graceful kill, verify and then
 * SIGKILL the whole group (POSIX) or `taskkill /T /F` the tree (Windows).
 *
 * Deliberate scope: callers apply this on EXPLICIT kills (breaker stop, archive,
 * respawn, app quit, hidden check sessions) — never on a natural exit, where a
 * daemon the agent intentionally left running (a dev server started via a Bash
 * tool) must survive its parent session.
 */
import { spawn } from 'node:child_process';
import type { PidVerdict } from './procIdentity';

/** Grace between the polite signal and the SIGKILL escalation. */
export const KILL_GRACE_MS = 4_000;

/** Is the process still alive? Signal 0 probes without touching it. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// SYNC-CHILD-CALLS: hardKillTree (a spawnSync `taskkill /T /F`, 10 s cap per pid) is removed.
// Its last caller, PtyManager.killAll (reset/changeHome), is gone too; every tree kill is
// killTreesAsync below, so no path in main can block on a synchronous kill.

/** Cap for one batched async tree kill (see killTreesAsync). */
export const KILL_TREES_ASYNC_MS = 5_000;

/**
 * QUIT-HANG: kill several process trees WITHOUT blocking the calling (main) thread.
 *
 * The old hardKillTree's `spawnSync('taskkill')` froze Electron's main thread for the whole
 * sweep: one synchronous taskkill per agent terminal (each a big tree) at quit ran past
 * the ~5 s after which Windows ghosts the window and files an AppHang. Here Windows gets
 * ONE asynchronous `taskkill /T /F /PID a /PID b ...` (taskkill carries on past a pid
 * that is already gone), resolved when it exits or after `capMs`, whichever is first;
 * a taskkill still running at the cap is left to finish on its own. POSIX group
 * SIGKILLs are syscalls, never a blocking child, so they run inline. Never rejects.
 */
export function killTreesAsync(pids: readonly number[], capMs = KILL_TREES_ASYNC_MS): Promise<void> {
  const valid = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (valid.length === 0) return Promise.resolve();
  if (process.platform !== 'win32') {
    for (const pid of valid) {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    return Promise.resolve();
  }
  const args = ['/T', '/F'];
  for (const pid of valid) args.push('/PID', String(pid));
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, capMs);   // ref'd on purpose: the quit awaits this cap
    try {
      const proc = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      proc.once('close', finish);
      proc.once('error', finish);
    } catch { finish(); }
  });
}

/** SIGKILL the process GROUP led by `pid` and nothing else: no fallback to the pid itself, which
 *  is what killTreesAsync does when the group is gone. POSIX only (Windows has no groups to name). */
export function killGroupOnly(pid: number): void {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* no such group */ }
}

/** After a graceful kill (node-pty's SIGHUP), make sure the PIDs actually get
 *  released: wait a short grace, then sweep the process tree. Runs even when
 *  the leader died promptly — the sweep is what reaps grandchildren the polite
 *  signal never reached. The timer is unref'd so it can never keep the app
 *  alive during quit.
 *
 *  PTY-KILL-PID-IDENTITY: the grace is seconds in which the leader can die and its pid go to a
 *  stranger, so the caller passes `verdict` (procIdentity.ts pidIdentity) and it is asked when
 *  the grace is over, immediately before the kill:
 *    'other'  the pid is somebody else's now: nothing is killed;
 *    'gone'   no process under the pid: the GROUP only (the leader's leftovers), never the pid;
 *    'same' / 'unknown' / no verdict given: the sweep as before. */
export function ensureKilled(pid: number | undefined, graceMs = KILL_GRACE_MS, verdict?: () => Promise<PidVerdict>): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  // QUIT-HANG follow-up: the async sweep, not the old hardKillTree's sync taskkill, which
  // stalled the UI 0.3-1.5 s on every archive/restart/respawn on Windows.
  const t = setTimeout(() => {
    const asked: Promise<PidVerdict> = verdict ? verdict().catch((): PidVerdict => 'unknown') : Promise.resolve('unknown');
    void asked.then((v) => {
      if (v === 'other') return undefined;
      if (v === 'gone') { killGroupOnly(pid); return undefined; }
      return killTreesAsync([pid]);
    });
  }, graceMs);
  t.unref?.();
}
