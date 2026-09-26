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
import { spawn, spawnSync } from 'node:child_process';

/** Grace between the polite signal and the SIGKILL escalation. */
export const KILL_GRACE_MS = 4_000;

/** Is the process still alive? Signal 0 probes without touching it. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Forcefully kill pid and its descendants NOW. Group-SIGKILL on POSIX (falls
 *  back to the single pid when the group id is gone); `taskkill /T /F` on
 *  Windows. Killing the group of an already-dead leader is exactly the
 *  orphan-reaping case: any surviving members still hold the group id. */
export function hardKillTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Cap for one batched async tree kill (see killTreesAsync). */
export const KILL_TREES_ASYNC_MS = 5_000;

/**
 * QUIT-HANG: kill several process trees WITHOUT blocking the calling (main) thread.
 *
 * hardKillTree's `spawnSync('taskkill')` froze Electron's main thread for the whole
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

/** After a graceful kill (node-pty's SIGHUP), make sure the PIDs actually get
 *  released: wait a short grace, then sweep the process tree. Runs even when
 *  the leader died promptly — the sweep is what reaps grandchildren the polite
 *  signal never reached. The timer is unref'd so it can never keep the app
 *  alive during quit. */
export function ensureKilled(pid: number | undefined, graceMs = KILL_GRACE_MS): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  // QUIT-HANG follow-up: the async sweep, not hardKillTree's spawnSync taskkill, which
  // stalled the UI 0.3-1.5 s on every archive/restart/respawn on Windows.
  const t = setTimeout(() => { void killTreesAsync([pid]); }, graceMs);
  t.unref?.();
}
