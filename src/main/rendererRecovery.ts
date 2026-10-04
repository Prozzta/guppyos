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

/** MEMSPIKE-167: how long after a memory recovery the notice and the crash row say "memory". */
export const MEMORY_CAUSE_MS = 15_000;

/** A window the memory recovery can act on (a BrowserWindow, narrowed). */
export interface MemoryRecoverableWindow {
  isDestroyed(): boolean;
  webContents: { id: number; isDestroyed(): boolean; getOSProcessId(): number; forcefullyCrashRenderer(): void };
}

/**
 * MEMSPIKE-167: recover a runaway renderer WITHOUT its cooperation. A frozen renderer may never
 * run a reload, so main kills its process (forcefullyCrashRenderer); the ordinary
 * render-process-gone recovery then reloads, recreates once, or gives up (its 2-minute streak is
 * what stops a memory loop). A renderer whose window already gave up is left alone: killing it
 * then would only leave a dead window. Returns what happened, for the log row.
 */
export function recoverRendererForMemory<W extends MemoryRecoverableWindow>(
  pid: number,
  deps: { windows: () => W[]; givenUp: (w: W) => boolean; beforeKill: (w: W) => void }
): 'killed' | 'no-window' | 'given-up' | 'failed' {
  const win = deps.windows().find((w) => {
    try { return !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getOSProcessId() === pid; } catch { return false; }
  });
  if (!win) return 'no-window';
  if (deps.givenUp(win)) return 'given-up';
  try { deps.beforeKill(win); } catch { /* the kill matters more than the bookkeeping */ }
  try { win.webContents.forcefullyCrashRenderer(); return 'killed'; } catch { return 'failed'; }
}

/** RENDERER-PROFILE: the DevTools-protocol surface profileRenderer needs (Electron's Debugger). */
export interface ProfilerDebugger {
  attach(v?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(m: string, p?: object): Promise<unknown>;
  on(event: 'message', listener: (e: unknown, method: string, params: unknown) => void): unknown;
  removeListener(event: 'message', listener: (e: unknown, method: string, params: unknown) => void): unknown;
}

/** RENDERER-PROFILE budgets: the whole look is capped at PROFILE_TIMEOUT_MS. */
export const PROFILE_TIMEOUT_MS = 5_000;
export const PROFILE_SAMPLE_MS = 3_000;
export const PROFILE_PAUSE_WAIT_MS = 1_000;
export const PROFILE_MAX_BYTES = 8 * 1024 * 1024;
export const PROFILE_SAMPLING_US = 1_000;
/** RPROF Finding 2 (a): the loop's own functions ranked 10-17 on the real trigger; 25 keeps them. */
export const PROFILE_TOP_N = 25;
/** RPROF Finding 2 (c): paused stacks per capture (one is a single sample). */
export const PROFILE_STACKS = 3;

interface CpuProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number }; hitCount?: number; children?: number[] }

/** "fn file.js:12" for a DevTools call frame (lines are 0-based in the protocol). */
function frameName(f: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number; location?: { lineNumber?: number; columnNumber?: number } }): string {
  const fn = f.functionName || '(anonymous)';
  const file = (f.url || '').split(/[\\/]/).pop() || '';
  const line = typeof f.lineNumber === 'number' ? f.lineNumber : f.location?.lineNumber;
  const col = typeof f.columnNumber === 'number' ? f.columnNumber : f.location?.columnNumber;
  // RPROF Finding 2 (b): line:col everywhere, so a frame can be mapped through the sourcemap.
  return file ? `${fn} ${file}:${typeof line === 'number' ? line + 1 : '?'}${typeof col === 'number' ? `:${col + 1}` : ''}` : fn;
}

/**
 * RPROF Finding 2 (a): frames that are not the app's own code. The renderer bundle is one file
 * (React included), so the URL cannot tell them apart: a vendor path does, where there is one,
 * and otherwise React's scheduler/reconciler/commit entry points by name. It is a heuristic for
 * the `topApp` list only; the unfiltered lists are kept beside it.
 */
const PSEUDO_FRAME = /^\((program|idle|root|garbage collector|anonymous)\)/;
// A paused-stack frame string keeps only the file's basename (`fn react-dom.development.js:1:2`),
// so a vendor file is also recognised at the start of a word, not only after a path separator.
const VENDOR_URL = /node_modules|(?:^|[\\/\s])(react-dom|react|scheduler)[.\-]/;
const REACT_INTERNAL = /^(commit[A-Z]\w*|performSyncWorkOnRoot|performConcurrentWorkOnRoot|performWorkOnRoot\w*|performUnitOfWork|workLoop\w*|beginWork\w*|completeWork\w*|completeUnitOfWork|renderWithHooks|renderRoot\w*|reconcile\w*|updateFunctionComponent|updateMemoComponent|updateSimpleMemoComponent|mountIndeterminateComponent|flush\w*|invokePassive\w*|recursivelyTraverse\w*|scheduleUpdateOnFiber|dispatchSetState|dispatchReducerAction|batchedUpdates\w*|processRootSchedule\w*|ensureRootIsScheduled|performWorkUntilDeadline|runWithFiberInDEV|callCallback\w*|invokeGuardedCallback\w*|checkIfSnapshotChanged|subscribeToStore|updateStoreInstance|mountSyncExternalStore|updateSyncExternalStore|forceStoreRerender)\b/;
export function isAppFrame(name: string, url = ''): boolean {
  if (PSEUDO_FRAME.test(name)) return false;
  if (url && VENDOR_URL.test(url)) return false;
  return !REACT_INTERNAL.test(name);
}

/** Self and inclusive sample counts per function, top `n` of each, from a CPU profile. */
export function summarizeCpuProfile(profile: { nodes: CpuProfileNode[] }, n = PROFILE_TOP_N): { samples: number; self: Array<{ fn: string; pct: number }>; inclusive: Array<{ fn: string; pct: number }>; app: Array<{ fn: string; pct: number }> } {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const parent = new Map<number, number>();
  for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const self = new Map<string, number>();
  const incl = new Map<string, number>();
  const app = new Map<string, number>();
  let samples = 0;
  for (const x of profile.nodes) {
    const hits = x.hitCount ?? 0;
    if (!hits) continue;
    samples += hits;
    const name = frameName(x.callFrame);
    self.set(name, (self.get(name) ?? 0) + hits);
    const seen = new Set<string>();
    for (let id: number | undefined = x.id; id !== undefined; id = parent.get(id)) {
      const node = byId.get(id);
      if (!node) break;
      const fn = frameName(node.callFrame);
      if (seen.has(fn)) continue; // recursion counts once per sample
      seen.add(fn);
      incl.set(fn, (incl.get(fn) ?? 0) + hits);
      if (isAppFrame(node.callFrame.functionName || '(anonymous)', node.callFrame.url)) app.set(fn, (app.get(fn) ?? 0) + hits);
    }
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([fn, h]) => ({ fn, pct: samples ? Math.round((h / samples) * 1000) / 10 : 0 }));
  return { samples, self: top(self), inclusive: top(incl).filter((e) => e.fn !== '(root)'), app: top(app) };
}

/**
 * RENDERER-PROFILE (option A, god 2026-09-28): WHAT a renderer is doing when it just doubled.
 *
 * Measured on Electron 32 (test/renderer-profile-harness): a renderer busy in JavaScript answers
 * NOTHING on a DevTools session attached at that moment. Debugger.enable, Profiler.*,
 * Runtime.getHeapUsage and Memory.getDOMCounters all time out, which is why the 1.1.67 heap probe
 * timed out on all 3 overnight spikes. Chromium serves only a few methods from a V8 interrupt
 * (Debugger.pause, Performance.getMetrics, ...), and only on a session whose domains were
 * enabled BEFORE the renderer got stuck.
 *
 * So each window gets ONE long-lived session, ARMED while its page is healthy
 * (Debugger.enable + Performance.enable). On a doubled spike, capture():
 *   1. Performance.getMetrics: JS heap, DOM nodes, script vs layout time. Served even when busy.
 *   2. Debugger.pause: the JS stack. Then, while paused (the nested message loop):
 *      Runtime.getHeapUsage, Memory.getDOMCounters and Profiler.start. Then resume.
 *   3. After ~sampleMs: pause again, Profiler.stop, resume. The top functions go in the row; the
 *      full profile goes to `write` (a .cpuprofile).
 *
 * Safeguards:
 * - Every step is raced against ONE deadline.
 * - A pause we did not ask for (a `debugger;` statement, a late pause request that hit after its
 *   wait) is resumed at once, unless DevTools is open: that pause is the developer's.
 * - Every pause we take is resumed.
 * - Any failure or timeout detaches (a detach also resumes) and disarms. The next page load
 *   re-arms.
 * - Nothing here throws.
 */
export interface ProbeDebugger extends ProfilerDebugger {
  on(event: 'message', listener: (e: unknown, method: string, params: unknown) => void): unknown;
  on(event: 'detach', listener: (e: unknown, reason: string) => void): unknown;
}

const PERF_METRICS = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'JSEventListeners', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'];
/** How long arming may take on a healthy page. */
export const PROBE_ARM_TIMEOUT_MS = 3_000;

export class RendererProbe {
  private armed = false;
  private arming: Promise<boolean> | null = null;
  private attachedHere = false;
  private expectPause: ((params: unknown) => void) | null = null;
  private paused = false;
  /** Pauses we did not ask for and resumed (a `debugger;` statement, a late pause request). */
  foreignResumes = 0;

  constructor(private readonly dbg: ProbeDebugger, private readonly deps: { devToolsOpen?: () => boolean } = {}) {
    dbg.on('message', (_e, method, params) => {
      if (method === 'Debugger.scriptParsed') { this.noteScript(params); return; }
      if (method === 'Debugger.resumed') { this.paused = false; return; }
      if (method !== 'Debugger.paused') return;
      this.paused = true;
      if (this.expectPause) { const r = this.expectPause; this.expectPause = null; r(params); return; }
      if (this.deps.devToolsOpen?.()) return; // the developer's own pause
      this.foreignResumes += 1;
      this.dbg.sendCommand('Debugger.resume').catch(() => { /* detached */ });
    });
    dbg.on('detach', () => { this.armed = false; this.attachedHere = false; this.paused = false; });
  }

  isArmed(): boolean { return this.armed; }

  /** RPROF Finding 2 (b): scriptId -> url, from Debugger.scriptParsed (a paused frame often
   *  carries an empty url). Bounded; cleared if a page ever parses an absurd number of scripts. */
  private readonly scriptUrls = new Map<string, string>();
  private noteScript(params: unknown): void {
    const p = params as { scriptId?: unknown; url?: unknown } | null;
    if (!p || typeof p.scriptId !== 'string' || typeof p.url !== 'string' || !p.url) return;
    if (this.scriptUrls.size >= 20_000) this.scriptUrls.clear();
    this.scriptUrls.set(p.scriptId, p.url);
  }

  /** A paused event's frames as "fn file:line:col", the url resolved through the scriptId. */
  private stackOf(p: { callFrames?: Array<{ functionName?: string; url?: string; location?: { scriptId?: string; lineNumber?: number; columnNumber?: number } }> }): string[] {
    return (p.callFrames ?? []).slice(0, 15).map((f) => frameName({ ...f, url: f.url || (f.location?.scriptId ? this.scriptUrls.get(f.location.scriptId) : '') || '' }));
  }

  /** Attach and enable Debugger + Performance, on a HEALTHY page. Idempotent; false on failure. */
  arm(timeoutMs = PROBE_ARM_TIMEOUT_MS): Promise<boolean> {
    if (this.armed) return Promise.resolve(true);
    if (this.arming) return this.arming;
    this.arming = (async () => {
      try {
        if (!this.dbg.isAttached()) { this.dbg.attach('1.3'); this.attachedHere = true; }
        const ok = await raceMs(Promise.all([this.dbg.sendCommand('Debugger.enable'), this.dbg.sendCommand('Performance.enable')]), timeoutMs);
        if (ok === 'timeout') { this.giveUp(); return false; }
        this.armed = true;
        return true;
      } catch {
        this.giveUp();
        return false;
      } finally {
        this.arming = null;
      }
    })();
    return this.arming;
  }

  /** Detach (if we attached) and disarm. A detach also resumes a paused renderer. */
  giveUp(): void {
    this.armed = false;
    this.expectPause = null;
    if (this.attachedHere) { try { this.dbg.detach(); } catch { /* gone */ } }
    this.attachedHere = false;
    this.paused = false;
  }

  /** Pause and wait for OUR paused event (at most waitMs). null when no JS was running. */
  private async pauseNow(waitMs: number, deadline: number): Promise<{ callFrames?: Array<{ functionName?: string; url?: string; location?: { scriptId?: string; lineNumber?: number; columnNumber?: number } }> } | null> {
    const got = new Promise<unknown>((r) => { this.expectPause = r; });
    const sent = await raceUntil(this.dbg.sendCommand('Debugger.pause'), deadline);
    if (sent === 'timeout') { this.expectPause = null; throw new Error('pause-send'); }
    const p = await raceUntil(got, Math.min(deadline, Date.now() + waitMs));
    if (p === 'timeout') { this.expectPause = null; return null; } // a late hit is resumed as foreign
    return p as { callFrames?: Array<{ functionName?: string; url?: string; location?: { scriptId?: string; lineNumber?: number; columnNumber?: number } }> };
  }

  private async resume(deadline: number): Promise<void> {
    if (!this.paused) return;
    if (await raceUntil(this.dbg.sendCommand('Debugger.resume'), deadline) === 'timeout') throw new Error('resume');
  }

  /** The spike look. Resolves with the row fields; never throws, never leaves the page paused. */
  async capture(opts: { write: (json: string) => Promise<string | null>; timeoutMs?: number; sampleMs?: number; pauseWaitMs?: number; maxBytes?: number; stacks?: number }): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    const deadline = t0 + (opts.timeoutMs ?? PROFILE_TIMEOUT_MS);
    const pauseWait = opts.pauseWaitMs ?? PROFILE_PAUSE_WAIT_MS;
    const out: Record<string, unknown> = { armed: this.armed };
    let stage = 'arm';
    try {
      // Not armed (a page that never finished loading, or a re-arm pending): try now. Only a
      // renderer that is not stuck can be armed; a stuck one is reported, not waited on.
      if (!this.armed && !(await this.arm(Math.max(0, deadline - Date.now())))) return { ...out, profile: 'timeout', stage, ms: Date.now() - t0 };

      stage = 'metrics';
      const m = await raceUntil(this.dbg.sendCommand('Performance.getMetrics') as Promise<{ metrics: Array<{ name: string; value: number }> }>, deadline);
      if (m !== 'timeout') out.metrics = Object.fromEntries(m.metrics.filter((x) => PERF_METRICS.includes(x.name)).map((x) => [x.name, /Size$/.test(x.name) ? Math.round(x.value / 104857.6) / 10 : Math.round(x.value * 1000) / 1000]));

      stage = 'pause';
      const p = await this.pauseNow(pauseWait, deadline);
      out.stack = p ? this.stackOf(p) : null;
      // RPROF Finding 2 (c): one paused stack is ONE sample (on the real trigger it twice landed in
      // React's commit code). More are taken during the profile window, and the app frames across
      // all of them are counted.
      const stacks: string[][] = p ? [out.stack as string[]] : [];
      if (p) {
        const heap = await raceUntil(this.dbg.sendCommand('Runtime.getHeapUsage') as Promise<{ usedSize: number; totalSize: number }>, deadline);
        if (heap !== 'timeout') { out.jsHeapUsedMb = Math.round(heap.usedSize / 104857.6) / 10; out.jsHeapTotalMb = Math.round(heap.totalSize / 104857.6) / 10; }
        const dom = await raceUntil(this.dbg.sendCommand('Memory.getDOMCounters') as Promise<{ documents: number; nodes: number; jsEventListeners: number }>, deadline);
        if (dom !== 'timeout') { out.domNodes = dom.nodes; out.domDocuments = dom.documents; out.jsEventListeners = dom.jsEventListeners; }
      }

      stage = 'profile';
      const started = await raceUntil((async () => {
        await this.dbg.sendCommand('Profiler.enable');
        await this.dbg.sendCommand('Profiler.setSamplingInterval', { interval: PROFILE_SAMPLING_US });
        await this.dbg.sendCommand('Profiler.start');
      })(), deadline);
      if (started === 'timeout') throw new Error('profiler-start');
      await this.resume(deadline);
      // Leave room for the second pause and the stop reply inside the deadline.
      const sampleMs = Math.max(0, Math.min(opts.sampleMs ?? PROFILE_SAMPLE_MS, deadline - Date.now() - pauseWait - 750));
      const sampleEnd = Date.now() + sampleMs;
      // Extra paused stacks, spread over the window; only for a renderer that is running JS (the
      // first pause answered) - an idle one would spend a pause wait on each for nothing.
      const extra = p ? (opts.stacks ?? PROFILE_STACKS) - 1 : 0;
      for (let i = 1; i <= extra; i++) {
        const at = sampleEnd - sampleMs + Math.round((sampleMs * i) / (extra + 1));
        await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
        const pi = await this.pauseNow(Math.min(pauseWait, 300), deadline);
        if (pi) { stacks.push(this.stackOf(pi)); await this.resume(deadline); }
      }
      await new Promise((r) => setTimeout(r, Math.max(0, sampleEnd - Date.now())));

      stage = 'profile-stop';
      const p2 = await this.pauseNow(pauseWait, deadline); // busy: stop needs the nested loop; idle: it answers anyway
      if (p2) stacks.push(this.stackOf(p2));
      const stopped = await raceUntil(this.dbg.sendCommand('Profiler.stop') as Promise<{ profile: { nodes: CpuProfileNode[] } }>, deadline);
      if (p2) await this.resume(deadline);
      if (stopped === 'timeout') throw new Error('profiler-stop');
      void this.dbg.sendCommand('Profiler.disable').catch(() => {});
      const summary = summarizeCpuProfile(stopped.profile);
      const json = JSON.stringify(stopped.profile);
      const maxBytes = opts.maxBytes ?? PROFILE_MAX_BYTES;
      let file: string | null = null;
      if (json.length <= maxBytes) { try { file = await opts.write(json); } catch { file = null; } }
      const stackApp = stacks.length ? appFramesAcross(stacks) : [];
      const where = stuckInOf(stacks, summary.app);
      return { ...out, profile: 'ok', ms: Date.now() - t0, sampledMs: sampleMs, samples: summary.samples, topSelf: summary.self, topInclusive: summary.inclusive, topApp: summary.app,
        ...(stacks.length ? { stacks, stackApp } : {}), stuckIn: where.stuckIn, ...(where.profileDisagrees ? { profileDisagrees: true } : {}),
        file, bytes: json.length, ...(json.length > maxBytes ? { truncated: true } : {}) };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.giveUp(); // detach resumes; the next page load re-arms
      return { ...out, profile: /^(pause-send|resume|profiler-start|profiler-stop)$/.test(why) ? 'timeout' : 'failed', stage, error: why, ms: Date.now() - t0, gaveUp: true };
    }
  }
}

/** RPROF Finding 2 (c): app frames across several paused stacks, most frequent first (each
 *  function counted once per stack). "fn file:line:col" -> the number of stacks it appears in. */
export function appFramesAcross(stacks: string[][]): Array<{ fn: string; stacks: number }> {
  const n = new Map<string, number>();
  for (const st of stacks) {
    for (const fr of new Set(st)) {
      const name = fr.split(' ')[0];
      if (!isAppFrame(name, fr)) continue;
      n.set(fr, (n.get(fr) ?? 0) + 1);
    }
  }
  return [...n].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, c]) => ({ fn, stacks: c }));
}

/**
 * TEST-FLAKE-RENDERER-PROFILE: where a busy renderer is stuck. The paused stacks are exact (the
 * debugger reconstructs JIT-compiled frames); the CPU profile's sampler is not: under CPU load it
 * charges a JIT-compiled loop's ticks to its CALLER (measured: loop share ~60% quiet, ~20% beside 24
 * CPU hogs, 0% in a loaded full suite; ~99.7% with every JIT tier off). So the stacks name the stuck
 * function; the profile answers only when no stack was captured (an idle page). A profile whose top
 * app frame is a different function is flagged, so the skew shows in the logged row.
 */
export function stuckInOf(stacks: string[][], profileApp: Array<{ fn: string; pct: number }>): {
  stuckIn: { fn: string; source: 'stacks' | 'profile' } | null; profileDisagrees: boolean;
} {
  // A function is "fn file" without the position: a loop's current line moves between pauses, its
  // callers' lines do not, so counting exact frames would favour a caller over the loop.
  const fnOf = (frame: string) => { const [name, loc = ''] = frame.split(' '); return `${name} ${loc.replace(/:\d+(:\d+)?$/, '')}`; };
  const count = new Map<string, { n: number; frame: string; k: string }>();
  // How many pauses hold the function ANYWHERE: a tie on the innermost count (a loop calling two
  // helpers, paused once in each and once in itself) goes to the function every pause is inside.
  const within = new Map<string, number>();
  for (const st of stacks) {
    const app = st.filter((fr) => isAppFrame(fr.split(' ')[0], fr));
    for (const k of new Set(app.map(fnOf))) within.set(k, (within.get(k) ?? 0) + 1);
    const inner = app[0]; // the innermost app frame of this pause
    if (!inner) continue;
    const k = fnOf(inner); const c = count.get(k);
    if (c) c.n++; else count.set(k, { n: 1, frame: inner, k });
  }
  // Array.prototype.sort is stable: a full tie keeps pause order.
  const best = [...count.values()].sort((a, b) => b.n - a.n || (within.get(b.k) ?? 0) - (within.get(a.k) ?? 0))[0];
  // A profile with no app frame names nothing, so it does not disagree (topApp, logged too, is empty).
  if (best) return { stuckIn: { fn: best.frame, source: 'stacks' }, profileDisagrees: profileApp.length > 0 && fnOf(profileApp[0].fn) !== fnOf(best.frame) };
  if (profileApp.length) return { stuckIn: { fn: profileApp[0].fn, source: 'profile' }, profileDisagrees: false };
  return { stuckIn: null, profileDisagrees: false };
}

function raceMs<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return raceUntil(p, Date.now() + ms);
}

function raceUntil<T>(p: Promise<T>, deadline: number): Promise<T | 'timeout'> {
  const ms = deadline - Date.now();
  if (ms <= 0) { p.catch(() => {}); return Promise.resolve('timeout'); }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const t = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}

/** RENDERER-PROFILE: how many .cpuprofile files are kept (oldest removed first). */
export const PROFILE_KEEP_FILES = 10;

/** RENDERER-PROFILE: write one profile as `<dir>/<iso>-pid<pid>.cpuprofile` (opens in Chrome
 *  DevTools' Performance panel) and prune to the newest `keep`. Async fs only, so main never
 *  blocks on a multi-MB write. Returns the path, or null on any failure. */
export async function saveRendererProfile(dir: string, pid: number, json: string, keep = PROFILE_KEEP_FILES): Promise<string | null> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-pid${pid}.cpuprofile`);
    await fsp.writeFile(file, json);
    const all = (await fsp.readdir(dir)).filter((f) => f.endsWith('.cpuprofile')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - keep))) { try { await fsp.unlink(path.join(dir, old)); } catch { /* in use */ } }
    return file;
  } catch {
    return null;
  }
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
// MEMSPIKE-167: every 15 s (was 60 s), so a runaway renderer (+2 GB/min on 2026-09-27) is caught
// on two consecutive over-limit samples within ~30 s; the ring keeps the same 5 minutes.
export const SAMPLE_MS = 15_000;
export const KEEP_SAMPLES = 20;
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
  procs: Array<{ pid: number; type: 'renderer' | 'gpu' | 'main'; workingSetMb: number | null; privateMb: number | null; uptimeS: number | null }>;
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
    /** MEMSPIKE-167: a renderer over alertMb on TWO CONSECUTIVE samples (the confirming sample).
     *  Called once per renderer pid; main recovers it (the renderer's cooperation is not needed). */
    onOverLimit?: (pid: number, mb: number) => void;
    /** MEMSPIKE-167: the renderer just doubled (once per pid; diagnostics only). */
    onDoubled?: (pid: number, mb: number) => void;
  }) {}

  /** pid -> the previous sample was already over the limit; and the pids already handed over. */
  private readonly overOnce = new Set<number>();
  private readonly recovered = new Set<number>();

  /** pid -> the renderer's first sampled size (MB), and the alerts already raised for it. */
  private readonly firstMb = new Map<number, number>();
  private readonly alerted = new Set<string>();

  /** Take one sample, remember it, and log it. Never throws. */
  sample(): MemorySample | null {
    let list: ProcessMetricLike[];
    try { list = this.deps.metrics(); } catch { return null; }
    const at = this.deps.now();
    // MEMSPIKE-167: main ('Browser') too, so a backlog held in MAIN (an IPC queue) shows up.
    const procs = list
      .filter((p) => p.type === 'Tab' || p.type === 'GPU' || p.type === 'Browser')
      .map((p) => ({
        pid: p.pid,
        type: p.type === 'GPU' ? 'gpu' as const : p.type === 'Browser' ? 'main' as const : 'renderer' as const,
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
      if (first > 0 && size >= first * factor) {
        const fresh = !this.alerted.has(`${p.pid}|doubled`);
        raise('doubled');
        if (fresh) { try { this.deps.onDoubled?.(p.pid, size); } catch { /* diagnostics never break sampling */ } }
      }
      // The confirming sample: act only on the SECOND consecutive over-limit sample of one pid,
      // and only once per pid (a recovered renderer comes back with a new pid).
      if (size >= limit) {
        if (this.overOnce.has(p.pid) && !this.recovered.has(p.pid)) {
          this.recovered.add(p.pid);
          try { this.deps.onOverLimit?.(p.pid, size); } catch { /* never breaks sampling */ }
        }
        this.overOnce.add(p.pid);
      } else {
        this.overOnce.delete(p.pid);
      }
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
