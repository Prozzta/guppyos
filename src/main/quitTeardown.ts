/**
 * QUIT-HANG: the slow part of app teardown, run OFF the main thread's critical path.
 *
 * Quit used to run a synchronous `taskkill /T /F` per agent terminal plus a synchronous
 * memory-daemon stop on Electron's main thread. Together they passed the ~5 s after
 * which Windows ghosts the window and files an AppHang (WER AppHangB1, three times on
 * 2026-09-26), which read as "the floor crashed on quit". Each slow step is now async;
 * this runs them concurrently, times each one for the quit log row, and caps the whole
 * batch so a wedged child can never hold the quit open. Never rejects.
 */

export interface QuitStep {
  name: string;
  run: () => unknown;
}

export interface QuitReport {
  totalMs: number;
  /** True when the cap fired before every step settled. */
  capped: boolean;
  /** Per step: milliseconds to settle, 'pending' if the cap fired first, 'error' on a throw/reject. */
  steps: Record<string, number | 'pending' | 'error'>;
}

export function runQuitSteps(steps: readonly QuitStep[], capMs: number, now: () => number = Date.now): Promise<QuitReport> {
  const t0 = now();
  const report: QuitReport = { totalMs: 0, capped: false, steps: {} };
  const settled = steps.map((step) => {
    report.steps[step.name] = 'pending';
    let p: Promise<unknown>;
    try { p = Promise.resolve(step.run()); } catch { p = Promise.reject(new Error('sync throw')); }
    return p.then(
      () => { report.steps[step.name] = now() - t0; },
      () => { report.steps[step.name] = 'error'; }
    );
  });
  return new Promise<QuitReport>((resolve) => {
    let done = false;
    const finish = (capped: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ totalMs: now() - t0, capped, steps: { ...report.steps } });
    };
    const timer = setTimeout(() => finish(true), capMs);   // ref'd on purpose: the quit awaits this cap
    void Promise.all(settled).then(() => finish(false));
  });
}
