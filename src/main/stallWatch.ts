/**
 * STALL-WATCH-198: name the main-thread blocks (UI-CRAWL-HALFCORES-197 measured 54 ms - 1,252 ms
 * blocks of Guppy's main thread while main sat idle on CPU) and the renderer's slow input, from
 * rows in log.jsonl instead of a profiler on the Human's app. Instrument only: nothing here changes
 * what main or the renderer does.
 *
 *   kind 'main-stall'          the heartbeat (a 25 ms unref'd interval) came back late by >= 100 ms:
 *                              ms, at (epoch ms of the late window's start), eld (the beat's whole
 *                              gap), slices (the sync calls of >= 16 ms that overlap the window:
 *                              {k: 'ipc' | 'fs', name, ms}). No slice = native code, a GC or
 *                              an Electron-internal wait (only part 5 can name those)
 *   kind 'input-delay'         (renderer, Event Timing) a keydown/keypress/beforeinput/input/
 *                              pointerdown that took >= 100 ms: ev, inputMs, procMs, presMs, target
 *                              (a data-testid, an element id or a tag name; NEVER the text)
 *   kind 'renderer-longtask'   (renderer) a long task of >= 200 ms: ms, name, attr
 *   kind 'main-stall-profile'  (part 5, config `stallWatch: { profile: true }`, default OFF) the top
 *                              self-time frames of a 30 s sampling window that held a >= 500 ms stall
 *
 * SLICES: ipcMain.handle/on listeners (once goes through on) are wrapped as they register (the synchronous part of a
 * handler is timed, so an async handler's awaits are not counted), and the sync fs calls are wrapped
 * once on the module object. A call costs two performance.now() reads; only a call of >= 16 ms is
 * kept (a 200-entry ring), and only then is its name worked out: the channel, or the fs function plus
 * the path's basename. Never arguments or contents. (No child_process: main makes no sync child call.)
 *
 * RATE CAP: one row per kind per 5 s. A row inside the window is folded: the window's worst one is
 * written when the window ends, with `folded` = how many were folded into it.
 */

export const STALL_BEAT_MS = 25;
/** A beat this late (beyond STALL_BEAT_MS) is a stall. */
export const STALL_MIN_MS = 100;
/** A gap this long is a suspend or a debugger pause, not a stall: skipped. */
export const STALL_MAX_MS = 300_000;
export const SLICE_MIN_MS = 16;
export const SLICE_RING = 200;
/** The slices a main-stall row carries at most (the longest first). */
export const STALL_ROW_SLICES = 8;
export const ROW_CAP_MS = 5_000;
export const INPUT_DELAY_MIN_MS = 100;
export const RENDERER_LONGTASK_MIN_MS = 200;
export const PROFILE_WINDOW_MS = 30_000;
export const PROFILE_INTERVAL_US = 10_000;
/** A profile window is kept only when it held a stall at least this long. */
export const PROFILE_KEEP_MS = 500;
export const PROFILE_TOP = 12;

export const INPUT_EVENTS: ReadonlySet<string> = new Set(['keydown', 'keypress', 'beforeinput', 'input', 'pointerdown']);
export const SYNC_FS_FNS = ['readFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'readdirSync', 'statSync'] as const;

export type SliceKind = 'ipc' | 'fs';
export type StallRowKind = 'main-stall' | 'input-delay' | 'renderer-longtask';

/** Config `stallWatch`: unset = on; false = off; { profile: true } = on with part 5. Read at startup. */
export function stallWatchMode(v: unknown): { on: boolean; profile: boolean } {
  if (v === false) return { on: false, profile: false };
  const profile = !!v && typeof v === 'object' && (v as { profile?: unknown }).profile === true;
  return { on: true, profile };
}

/** The part of node:inspector's Session that part 5 uses. */
export interface ProfilerSession {
  post(method: string, params?: Record<string, unknown>, cb?: (err: Error | null, res?: unknown) => void): void;
  disconnect(): void;
}

export interface StallWatchDeps {
  /** Monotonic ms (performance.now). */
  now: () => number;
  /** Epoch ms of now() = 0 (performance.timeOrigin). */
  origin: number;
  log: (row: Record<string, unknown>) => void;
  /** Part 5: a connected inspector session, or null (off: the default). */
  profiler?: (() => ProfilerSession | null) | null;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/**
 * The objects whose functions are wrapped (main passes ipcMain and node:fs). No child_process: main
 * makes no synchronous child call at all (SYNC-CHILD CENSUS, sync-child-calls-173, allowlist empty),
 * and handing main the module as a value is the very shape that census refuses.
 */
export interface StallTargets {
  ipcMain?: { handle: Function; on: Function; removeListener: Function; off?: Function };
  fs?: Record<string, unknown>;
}

/** What the renderer sends (validated in fromRenderer). */
export interface RendererStallBatch {
  inputs?: Array<{ ev: string; at: number; inputMs: number; procMs: number; presMs: number; target?: string }>;
  longtasks?: Array<{ at: number; ms: number; name?: string; attr?: string }>;
}

type Slice = { k: SliceKind; name: string; start: number; end: number };
type Cap = { until: number; folded: number; worst: Record<string, unknown> | null; worstMs: number };

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TOKEN_RE = /^[a-z][a-z-]{0,23}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ms0 = (v: number): number => Math.round(v);

/** The last path segment, at most 64 chars; a non-string (a fd, a Buffer, a URL) is '#'. */
export function baseName(p: unknown): string {
  if (typeof p !== 'string') return '#';
  const parts = p.split(/[\\/]+/);
  return (parts[parts.length - 1] || parts[parts.length - 2] || '').slice(0, 64);
}

export class StallWatch {
  private on = false;
  private last = 0;
  private beatTimer: unknown = null;
  private ring: Array<Slice | undefined> = new Array(SLICE_RING);
  private ringAt = 0;
  private caps = new Map<StallRowKind, Cap>();
  private undo: Array<() => void> = [];
  private wrapped = new WeakMap<Function, Function>();
  private session: ProfilerSession | null = null;
  private profileTimer: unknown = null;
  private windowWorst = 0;

  constructor(private readonly d: StallWatchDeps) {}

  get running(): boolean { return this.on; }

  /** Arm the heartbeat and wrap the targets. Once; call it before the ipcMain handlers register. */
  start(targets: StallTargets = {}): void {
    if (this.on) return;
    this.on = true;
    this.last = this.d.now();
    const setI = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.beatTimer = setI(() => this.beat(), STALL_BEAT_MS);
    (this.beatTimer as { unref?: () => void })?.unref?.();
    if (targets.ipcMain) this.wrapIpc(targets.ipcMain);
    if (targets.fs) for (const fn of SYNC_FS_FNS) this.wrapFn(targets.fs, fn, 'fs', (a) => `${fn}:${baseName(a[0])}`);
    if (this.d.profiler) this.startProfile();
  }

  /** Stop and put every wrapped function back (handlers registered meanwhile keep their wrapper,
   *  which then records into a ring nobody reads). Writes any folded rows still pending. */
  stop(): void {
    if (!this.on) return;
    this.flushDue(Infinity);
    this.on = false;
    const clearI = this.d.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
    if (this.beatTimer !== null) { clearI(this.beatTimer); this.beatTimer = null; }
    if (this.profileTimer !== null) { clearI(this.profileTimer); this.profileTimer = null; }
    try { this.session?.post('Profiler.stop'); this.session?.disconnect(); } catch { /* gone */ }
    this.session = null;
    for (const u of this.undo.splice(0).reverse()) { try { u(); } catch { /* best-effort */ } }
  }

  /** A sync call ended: kept only at >= SLICE_MIN_MS, and only then named. */
  slice(k: SliceKind, name: () => string, start: number, end: number): void {
    if (end - start < SLICE_MIN_MS) return;
    let n = '#';
    try { n = name(); } catch { /* keep '#' */ }
    this.ring[this.ringAt] = { k, name: n, start, end };
    this.ringAt = (this.ringAt + 1) % SLICE_RING;
  }

  /** The slices that overlap [from, to], the longest first. */
  overlapping(from: number, to: number): Array<{ k: SliceKind; name: string; ms: number }> {
    const hits: Slice[] = [];
    for (const s of this.ring) if (s && s.end > from && s.start < to) hits.push(s);
    hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    return hits.slice(0, STALL_ROW_SLICES).map((s) => ({ k: s.k, name: s.name, ms: ms0(s.end - s.start) }));
  }

  /** The heartbeat (exposed for tests): a late beat closes a stall over [last beat, now]. */
  beat(): void {
    if (!this.on) return;
    const t = this.d.now();
    const gap = t - this.last;
    const from = this.last;
    this.last = t;
    const late = gap - STALL_BEAT_MS;
    if (late >= STALL_MIN_MS && gap < STALL_MAX_MS) {
      if (late > this.windowWorst) this.windowWorst = late;
      this.emit('main-stall', late, { at: ms0(this.d.origin + from), ms: ms0(late), eld: ms0(gap), slices: this.overlapping(from, t) }, t);
    }
    this.flushDue(t);
  }

  /** The renderer's batch (IPC), validated: allow-listed event names, safe ids, bounded numbers. */
  fromRenderer(batch: unknown): void {
    if (!this.on || !batch || typeof batch !== 'object') return;
    const b = batch as RendererStallBatch;
    const t = this.d.now();
    if (Array.isArray(b.inputs)) {
      for (const e of b.inputs.slice(0, 50)) {
        if (!e || !INPUT_EVENTS.has(e.ev) || !num(e.at) || !num(e.inputMs) || !num(e.procMs) || !num(e.presMs)) continue;
        if (e.inputMs < 0 || e.procMs < 0 || e.presMs < 0) continue;
        const ms = e.inputMs + e.procMs + e.presMs;
        if (ms < INPUT_DELAY_MIN_MS || ms > 600_000) continue;
        this.emit('input-delay', ms, {
          ev: e.ev, at: ms0(e.at), ms: ms0(ms), inputMs: ms0(e.inputMs), procMs: ms0(e.procMs), presMs: ms0(e.presMs),
          ...(typeof e.target === 'string' && ID_RE.test(e.target) ? { target: e.target } : {})
        }, t);
      }
    }
    if (Array.isArray(b.longtasks)) {
      for (const e of b.longtasks.slice(0, 50)) {
        if (!e || !num(e.at) || !num(e.ms) || e.ms < RENDERER_LONGTASK_MIN_MS || e.ms > 600_000) continue;
        this.emit('renderer-longtask', e.ms, {
          at: ms0(e.at), ms: ms0(e.ms),
          ...(typeof e.name === 'string' && TOKEN_RE.test(e.name) ? { name: e.name } : {}),
          ...(typeof e.attr === 'string' && TOKEN_RE.test(e.attr) ? { attr: e.attr } : {})
        }, t);
      }
    }
  }

  private logRow(kind: string, row: Record<string, unknown>, folded = 0): void {
    try { this.d.log({ kind, ...row, ...(folded ? { folded } : {}) }); } catch { /* best-effort */ }
  }

  /** The rate cap: the first row of a window is written, the rest fold into the window's worst. */
  private emit(kind: StallRowKind, ms: number, row: Record<string, unknown>, t: number): void {
    this.flushDue(t);
    const c = this.caps.get(kind);
    if (!c || t >= c.until) {
      this.logRow(kind, row);
      this.caps.set(kind, { until: t + ROW_CAP_MS, folded: 0, worst: null, worstMs: 0 });
      return;
    }
    c.folded++;
    if (!c.worst || ms > c.worstMs) { c.worst = row; c.worstMs = ms; }
  }

  /** Windows that ended by `t` write their folded worst (which opens a new window). */
  private flushDue(t: number): void {
    for (const [kind, c] of this.caps) {
      if (!c.worst || t < c.until) continue;
      this.logRow(kind, c.worst, c.folded);
      const at = Number.isFinite(t) ? t : c.until;
      this.caps.set(kind, { until: at + ROW_CAP_MS, folded: 0, worst: null, worstMs: 0 });
    }
  }

  private timed<F extends Function>(orig: F, k: SliceKind, name: (args: unknown[]) => string): F {
    const self = this;
    const now = this.d.now;
    const w = function (this: unknown, ...args: unknown[]): unknown {
      const t0 = now();
      try { return orig.apply(this, args); }
      finally { const t1 = now(); if (t1 - t0 >= SLICE_MIN_MS) self.slice(k, () => name(args), t0, t1); }
    };
    return w as unknown as F;
  }

  private wrapFn(obj: Record<string, unknown>, fn: string, k: SliceKind, name: (args: unknown[]) => string): void {
    const orig = obj[fn];
    if (typeof orig !== 'function') return;
    obj[fn] = this.timed(orig, k, name);
    this.undo.push(() => { obj[fn] = orig; });
  }

  private wrapIpc(ipc: NonNullable<StallTargets['ipcMain']>): void {
    const o = ipc as unknown as Record<string, Function>;
    const listener = (channel: unknown, fn: unknown): unknown => {
      if (typeof fn !== 'function') return fn;
      const w = this.timed(fn, 'ipc', () => String(channel).slice(0, 64));
      // a once-wrapper's original: EventEmitter.removeListener matches it there
      if ('listener' in fn) (w as unknown as { listener: unknown }).listener = (fn as unknown as { listener: unknown }).listener;
      this.wrapped.set(fn, w);
      return w;
    };
    // Not `once`: EventEmitter.once registers through this.on, which would wrap it twice.
    for (const m of ['handle', 'on'] as const) {
      const orig = o[m];
      if (typeof orig !== 'function') continue;
      o[m] = function (this: unknown, channel: unknown, fn: unknown, ...rest: unknown[]): unknown {
        return orig.call(this, channel, listener(channel, fn), ...rest);
      };
      this.undo.push(() => { o[m] = orig; });
    }
    // removeListener/off with the original function must find its wrapper.
    for (const m of ['removeListener', 'off'] as const) {
      const orig = o[m];
      if (typeof orig !== 'function') continue;
      const map = this.wrapped;
      o[m] = function (this: unknown, channel: unknown, fn: unknown, ...rest: unknown[]): unknown {
        return orig.call(this, channel, (typeof fn === 'function' && map.get(fn)) || fn, ...rest);
      };
      this.undo.push(() => { o[m] = orig; });
    }
  }

  // ─── Part 5: the sampling profiler (default OFF; god's OK per use) ───────────────────────────

  private startProfile(): void {
    try { this.session = this.d.profiler?.() ?? null; } catch { this.session = null; }
    const s = this.session;
    if (!s) return;
    try {
      s.post('Profiler.enable');
      s.post('Profiler.setSamplingInterval', { interval: PROFILE_INTERVAL_US });
      s.post('Profiler.start');
    } catch { this.session = null; return; }
    const setI = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.profileTimer = setI(() => this.cycleProfile(), PROFILE_WINDOW_MS);
    (this.profileTimer as { unref?: () => void })?.unref?.();
  }

  /** End a window: keep its top frames when it held a stall of >= PROFILE_KEEP_MS, then restart. */
  cycleProfile(): void {
    const s = this.session;
    if (!this.on || !s) return;
    const worst = this.windowWorst;
    this.windowWorst = 0;
    try {
      s.post('Profiler.stop', undefined, (err, res) => {
        if (!err && worst >= PROFILE_KEEP_MS) {
          const top = topFrames((res as { profile?: unknown } | undefined)?.profile);
          this.logRow('main-stall-profile', { worstMs: ms0(worst), windowMs: PROFILE_WINDOW_MS, top });
        }
        if (this.on && this.session === s) { try { s.post('Profiler.start'); } catch { /* gone */ } }
      });
    } catch { /* gone */ }
  }
}

/** A CPU profile's top self-time frames: function, file basename, line, ms. No source, no args. */
export function topFrames(profile: unknown): Array<{ fn: string; file: string; line: number; ms: number }> {
  const p = profile as { nodes?: Array<{ hitCount?: number; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }> } | undefined;
  if (!p || !Array.isArray(p.nodes)) return [];
  const byFrame = new Map<string, { fn: string; file: string; line: number; hits: number }>();
  for (const n of p.nodes) {
    const hits = num(n?.hitCount) ? n.hitCount : 0;
    if (hits <= 0) continue;
    const cf = n.callFrame ?? {};
    const fn = (typeof cf.functionName === 'string' && cf.functionName ? cf.functionName : '(anonymous)').slice(0, 64);
    const file = baseName(cf.url ?? '');
    const line = num(cf.lineNumber) ? cf.lineNumber + 1 : 0;
    const key = `${fn}\u0000${file}\u0000${line}`;
    const e = byFrame.get(key);
    if (e) e.hits += hits; else byFrame.set(key, { fn, file, line, hits });
  }
  return [...byFrame.values()].sort((a, b) => b.hits - a.hits).slice(0, PROFILE_TOP)
    .map((e) => ({ fn: e.fn, file: e.file, line: e.line, ms: ms0((e.hits * PROFILE_INTERVAL_US) / 1000) }));
}
