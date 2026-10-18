/**
 * GOD-TERMINAL-CONTROL M1 (Jim SHOULD 9): the numeric bar for the headless mirrors' main-thread cost,
 * and the automatic flag-off past it.
 *
 * @xterm/headless parses asynchronously, so timing write() measures nothing. The estimate is
 * chars fed per second x a parse cost per char, calibrated at startup on a synthetic TUI-like sample
 * (a cold parse, so it over-estimates: the safe side). Measured 16:27Z: the floor's peak minute
 * (6.84 MB) parses in about 150 ms, roughly 0.3% of one core.
 *
 * THE BAR: the mirror is turned off when its estimated share of one core, averaged over the last
 * WINDOW seconds, passes SHARE_MAX; or when the event loop's mean delay passes ELD_MAX_MS while the
 * mirrors' share is at least ELD_SHARE_MIN (lag from some other cause never turns them off).
 */
export const MIRROR_COST_WINDOW = 10;
export const MIRROR_SHARE_MAX = 0.02;
export const MIRROR_ELD_MAX_MS = 50;
export const MIRROR_ELD_SHARE_MIN = 0.005;
export const MIRROR_COST_SUMMARY_MS = 10 * 60_000;

export interface MirrorCostDeps {
  /** Monotonic chars fed to every mirror since start. */
  bytes(): number;
  /** Calibrated parse cost, ms per char. */
  msPerChar: number;
  /** The event loop's mean delay over the last tick in ms (and the reading is reset), or null. */
  eldMs(): number | null;
  turnOff(reason: string): void;
  log(row: Record<string, unknown>): void;
  now(): number;
}

export class MirrorCostGuard {
  private lastBytes: number;
  private lastAt: number;
  private shares: number[] = [];
  private peak = 0;
  private summaryAt: number;
  private off = false;

  constructor(private readonly deps: MirrorCostDeps) {
    this.lastBytes = deps.bytes();
    this.lastAt = deps.now();
    this.summaryAt = this.lastAt;
  }

  isOff(): boolean { return this.off; }

  /** One sample (main calls it every second). Returns the reason when this tick turned it off. */
  tick(): string | null {
    if (this.off) return null;
    const now = this.deps.now();
    const bytes = this.deps.bytes();
    const elapsed = now - this.lastAt;
    const eld = this.deps.eldMs();
    if (elapsed <= 0) return null;
    const share = Math.max(0, bytes - this.lastBytes) * this.deps.msPerChar / elapsed;
    this.lastBytes = bytes;
    this.lastAt = now;
    this.shares.push(share);
    if (this.shares.length > MIRROR_COST_WINDOW) this.shares.shift();
    const avg = this.shares.reduce((a, b) => a + b, 0) / this.shares.length;
    this.peak = Math.max(this.peak, avg);
    let reason: string | null = null;
    if (this.shares.length >= MIRROR_COST_WINDOW && avg > MIRROR_SHARE_MAX) reason = 'share';
    else if (eld !== null && eld > MIRROR_ELD_MAX_MS && avg >= MIRROR_ELD_SHARE_MIN) reason = 'event-loop-delay';
    if (reason) {
      this.off = true;
      this.deps.log({ kind: 'mirror-auto-off', reason, share: round(avg), eldMs: eld === null ? null : round(eld), msPerChar: this.deps.msPerChar, window: this.shares.length });
      this.deps.turnOff(reason);
      return reason;
    }
    if (now - this.summaryAt >= MIRROR_COST_SUMMARY_MS) {
      this.deps.log({ kind: 'mirror-cost', peakShare: round(this.peak), share: round(avg), eldMs: eld === null ? null : round(eld), chars: bytes });
      this.summaryAt = now;
      this.peak = 0;
    }
    return null;
  }
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;

/** A synthetic TUI-like sample: SGR colour runs, cursor moves, box drawing, wide glyphs, CRLF rows. */
export function calibrationSample(chars = 256 * 1024): string {
  const rows = [
    '\x1b[38;5;245m│\x1b[0m \x1b[1mmodel:\x1b[22m  claude-opus  \x1b[2m(ctx 41%)\x1b[22m\r\n',
    '\x1b[2K\x1b[1G❯ \x1b[7m \x1b[27m\x1b[3A\x1b[12C⏺ Reading src/main/pty.ts (ctrl+r to expand)\r\n',
    '╭──────────────────────────────────────────────╮\r\n│ ✻ Thinking…  中文 宽字符 \x1b[33m●\x1b[39m          │\r\n',
    '\x1b[?25l\x1b[H\x1b[0J\x1b[48;2;30;30;30m  esc to interrupt  · 3.2k tokens \x1b[49m\x1b[?25h\r\n'
  ];
  let s = '';
  for (let i = 0; s.length < chars; i++) s += rows[i % rows.length];
  return s.slice(0, chars);
}
