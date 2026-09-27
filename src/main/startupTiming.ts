/**
 * STARTUP-TIMING-162: the first 60 s of a run, measured instead of inferred (the Human's ~2 s
 * stall 10-15 s after start, STARTUP-STALL-159, could not be placed from the existing rows).
 *
 * Rows go to log.jsonl as `kind: 'startup-timing'`, then the recorder stops for the rest of
 * the run. Every `t` is ms since the main process started (performance.timeOrigin), in main and
 * in the renderer alike, so both sides line up on one axis.
 *
 *   ev 'loop'      main's event-loop delay, one sample per second (max and p99 ms), 10 samples a
 *                  row (6 rows a run; a crash loses at most the last 10 s)
 *   ev 'mark'      window-ready, agent-spawn (id), agent-first-output (id, main saw the PTY's
 *                  first bytes), first-agent-redraw (id, xterm parsed its first bytes in the
 *                  renderer), memory-worker-fork
 *   ev 'longtask'  a renderer long task (>= 50 ms): start, duration, attribution names only
 *   ev 'pty-bytes' (R1) per terminal, the output main forwarded each second (UTF-16 chars, a
 *                  count only), one row per terminal per ~10 s, so a long task can be matched
 *                  to the terminal whose replay flooded the renderer at that second
 *   ev 'end'       the worst second and the longest task, so one row answers "where was it"
 *
 * CHEAP, OFF THE HOT PATH: the delay histogram is Node's native one (no JS per tick); the 1 s
 * timer is unref'd; a mark is one Set lookup and one row; after the window every entry point is
 * a boolean check. NO CONTENT: ids, names from an allow-list and numbers only.
 */

export const STARTUP_TIMING_WINDOW_MS = 60_000;
export const STARTUP_LOOP_SAMPLE_MS = 1_000;
/** Loop samples per row. */
export const STARTUP_LOOP_ROW_SAMPLES = 10;
/** Only renderer tasks at least this long are kept (the Long Tasks API floor). */
export const STARTUP_LONGTASK_MIN_MS = 50;
/** A cap on renderer rows per run, so a pathological renderer cannot flood the log. */
export const STARTUP_MAX_RENDERER_ROWS = 300;

/** The marks main accepts; anything else is dropped. */
export const STARTUP_MARKS = ['window-ready', 'agent-spawn', 'agent-first-output', 'first-agent-redraw', 'terminal-open', 'memory-worker-fork', 'crash-reporter-start', 'crash-reporter-ready'] as const;
export type StartupMark = (typeof STARTUP_MARKS)[number];
/** The marks a renderer may report (main's own marks cannot be forged over IPC). */
const RENDERER_MARKS: ReadonlySet<string> = new Set<StartupMark>(['first-agent-redraw', 'terminal-open']);

/** The subset of Node's IntervalHistogram used here (values in ns). */
export interface DelayHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  readonly max: number;
  percentile(p: number): number;
}

export interface StartupTimingDeps {
  /** Epoch ms the process started: every `t` is relative to it. */
  origin: number;
  now: () => number;
  log: (row: Record<string, unknown>) => void;
  /** Node's monitorEventLoopDelay, or null (then no loop rows; marks still work). */
  histogram: () => DelayHistogram | null;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  windowMs?: number;
}

/** What the renderer sends (validated here; see sanitize). */
export interface RendererTimingBatch {
  longtasks?: Array<{ at: number; ms: number; name?: string; attr?: string }>;
  marks?: Array<{ name: string; at: number; id?: string }>;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TOKEN_RE = /^[a-z][a-z-]{0,23}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (ms: number): number => Math.round(ms * 10) / 10;

export class StartupTiming {
  private open = false;
  private started = false;
  private hist: DelayHistogram | null = null;
  private interval: unknown = null;
  private stopTimer: unknown = null;
  private rowStart = 0;
  private maxMs: number[] = [];
  private p99Ms: number[] = [];
  private seen = new Set<string>();
  private rendererRows = 0;
  private dropped = 0;
  private worst = { ms: 0, t: 0 };
  private longest = { ms: 0, t: 0 };
  private longtasks = 0;
  /** R1: per terminal, the chars forwarded per second since `fromSec` (flushed with the loop rows). */
  private ptyOut = new Map<string, { fromSec: number; chars: number[] }>();
  private readonly windowMs: number;

  constructor(private readonly d: StartupTimingDeps) {
    this.windowMs = d.windowMs ?? STARTUP_TIMING_WINDOW_MS;
  }

  /** Still recording? (every entry point checks this first) */
  get recording(): boolean { return this.open; }

  /** ms since the process started. */
  t(at: number = this.d.now()): number { return Math.round(at - this.d.origin); }

  /** R3: a time reported by the renderer, clamped to the window (never negative or far-future). */
  private clampT(at: number): number { return Math.min(this.windowMs, Math.max(0, this.t(at))); }

  private row(ev: string, extra: Record<string, unknown>): void {
    try { this.d.log({ kind: 'startup-timing', ev, ...extra }); } catch { /* best-effort */ }
  }

  /** Arm the recorder; it stops by itself when the window (from process start) closes. Once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const left = this.windowMs - (this.d.now() - this.d.origin);
    if (left <= 0) return;
    this.open = true;
    try { this.hist = this.d.histogram(); this.hist?.enable(); } catch { this.hist = null; }
    const setI = this.d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const setT = this.d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.rowStart = this.t();
    if (this.hist) {
      this.interval = setI(() => this.sample(), STARTUP_LOOP_SAMPLE_MS);
      (this.interval as { unref?: () => void })?.unref?.();
    }
    this.stopTimer = setT(() => this.stop(), left);
    (this.stopTimer as { unref?: () => void })?.unref?.();
  }

  private sample(): void {
    const h = this.hist;
    if (!this.open || !h) return;
    const max = h.max / 1e6;
    const p99 = h.percentile(99) / 1e6;
    h.reset();
    const at = this.t();
    const m = r1(Number.isFinite(max) ? max : 0);
    this.maxMs.push(m);
    this.p99Ms.push(r1(Number.isFinite(p99) ? p99 : 0));
    if (m > this.worst.ms) this.worst = { ms: m, t: at };
    if (this.maxMs.length >= STARTUP_LOOP_ROW_SAMPLES) this.flushLoop();
  }

  private flushLoop(): void {
    if (this.maxMs.length === 0) return;
    this.row('loop', { t: this.rowStart, stepMs: STARTUP_LOOP_SAMPLE_MS, maxMs: this.maxMs, p99Ms: this.p99Ms });
    this.maxMs = [];
    this.p99Ms = [];
    this.rowStart = this.t();
    this.flushPty();
  }

  /** R1: a terminal's output reached main (`chars` = the chunk's length). A count, never content. */
  ptyOutput(id: string, chars: number): void {
    if (!this.open || !num(chars) || chars <= 0) return;
    const sec = Math.max(0, Math.floor(this.t() / 1000));
    let seg = this.ptyOut.get(id);
    if (!seg) { seg = { fromSec: sec, chars: [] }; this.ptyOut.set(id, seg); }
    const i = sec - seg.fromSec;
    if (i < 0) return;
    while (seg.chars.length <= i) seg.chars.push(0);
    seg.chars[i] += chars;
  }

  private flushPty(): void {
    for (const [id, seg] of this.ptyOut) {
      if (ID_RE.test(id)) this.row('pty-bytes', { id, t: seg.fromSec * 1000, stepMs: 1000, chars: seg.chars });
    }
    this.ptyOut.clear();
  }

  /** A main-side marker. `id` (an agent id) makes it once per id; without one, once per run. */
  mark(name: StartupMark, id?: string, at?: number): void {
    if (!this.open) return;
    const key = id ? `${name}\u0000${id}` : name;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.row('mark', { name, t: at === undefined ? this.t() : this.clampT(at), ...(id ? { id } : {}) });
  }

  /** The renderer's batch (IPC), validated: allow-listed names, safe ids, numbers. */
  fromRenderer(batch: unknown): void {
    if (!this.open || !batch || typeof batch !== 'object') return;
    const b = batch as RendererTimingBatch;
    const room = (): boolean => {
      if (this.rendererRows < STARTUP_MAX_RENDERER_ROWS) { this.rendererRows++; return true; }
      this.dropped++;
      return false;
    };
    if (Array.isArray(b.marks)) {
      for (const m of b.marks.slice(0, 50)) {
        if (!m || !RENDERER_MARKS.has(m.name) || !num(m.at)) continue;
        const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : undefined;
        if (room()) this.mark(m.name as StartupMark, id, m.at);
      }
    }
    if (Array.isArray(b.longtasks)) {
      for (const e of b.longtasks.slice(0, 100)) {
        if (!e || !num(e.at) || !num(e.ms) || e.ms < STARTUP_LONGTASK_MIN_MS || e.ms > 600_000) continue;
        if (!room()) continue;
        const t = this.clampT(e.at);
        const ms = Math.round(e.ms);
        this.longtasks++;
        if (ms > this.longest.ms) this.longest = { ms, t };
        this.row('longtask', {
          t, ms,
          ...(typeof e.name === 'string' && TOKEN_RE.test(e.name) ? { name: e.name } : {}),
          ...(typeof e.attr === 'string' && TOKEN_RE.test(e.attr) ? { attr: e.attr } : {})
        });
      }
    }
  }

  /** Flush and close: one summary row, then nothing more this run. Idempotent. */
  stop(): void {
    if (!this.open) return;
    if (this.hist) this.sample();
    this.flushLoop();
    this.flushPty();
    this.open = false;
    try { this.hist?.disable(); } catch { /* gone */ }
    this.hist = null;
    const clearI = this.d.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));
    const clearT = this.d.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    if (this.interval !== null) { clearI(this.interval); this.interval = null; }
    if (this.stopTimer !== null) { clearT(this.stopTimer); this.stopTimer = null; }
    this.row('end', {
      t: this.t(),
      loopWorstMs: this.worst.ms, loopWorstT: this.worst.t,
      longtasks: this.longtasks, longtaskMaxMs: this.longest.ms, longtaskMaxT: this.longest.t,
      ...(this.dropped ? { dropped: this.dropped } : {})
    });
    this.seen.clear();
  }
}
