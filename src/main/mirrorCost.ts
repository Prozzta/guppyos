/**
 * GOD-TERMINAL-CONTROL M1 (Jim SHOULD 9): the numeric bar for the headless mirrors' main-thread cost,
 * and the automatic flag-off past it.
 *
 * THE COST is measured: each real mirror times its own parse slices (terminalMirror.ts timeParse).
 * Only when that timing is unavailable does the share fall back to chars fed x a parse cost per
 * char calibrated at startup (a cold parse, so it over-estimates: the safe side). Measured 16:27Z:
 * the floor's peak minute (6.84 MB) parses in about 150 ms, roughly 0.3% of one core.
 *
 * THE BAR, judged only over a FULL window of WINDOW one-second samples:
 * - share: the mirrors' share of one core, averaged over the window, passes SHARE_MAX; or
 * - event-loop-delay: in at least ELD_TICKS_MIN of the window's samples, the loop's mean delay
 *   passes ELD_MAX_MS AND the mirrors' measured parse is at least ELD_EXPLAINS of the loop's
 *   active time in that second. Lag the mirror does not explain never turns it off, and with no
 *   measured parse time the mirror is never blamed for lag.
 *
 * MIRROR-STARTUP-196 (1.1.95 live: the 6.0 s auto-off): no sample is judged during the startup
 * window (STARTUP_GRACE_MS from arming) or within SPAWN_GRACE_MS of any PTY spawn (a resume
 * repaints its whole history at once while the app is busy starting). Those seconds are not
 * added to the window at all.
 *
 * OFF IS NOT FOREVER: an auto-off re-arms after REARM_BASE_MS, doubling with each further off up
 * to REARM_MAX_MS; an hour back on forgets the earlier offs. Every off and every re-arm is a row.
 */
export const MIRROR_COST_WINDOW = 10;
export const MIRROR_SHARE_MAX = 0.02;
export const MIRROR_ELD_MAX_MS = 50;
export const MIRROR_ELD_TICKS_MIN = 6;
export const MIRROR_ELD_EXPLAINS = 0.5;
export const MIRROR_STARTUP_GRACE_MS = 30_000;
export const MIRROR_SPAWN_GRACE_MS = 20_000;
export const MIRROR_REARM_BASE_MS = 60_000;
export const MIRROR_REARM_MAX_MS = 30 * 60_000;
export const MIRROR_OFFS_RESET_MS = 60 * 60_000;
export const MIRROR_COST_SUMMARY_MS = 10 * 60_000;

export interface MirrorCostDeps {
  /** Monotonic chars fed to every mirror since start. */
  bytes(): number;
  /** Monotonic MEASURED parse ms of every mirror since start, or null when it cannot be timed. */
  parseMs(): number | null;
  /** Calibrated parse cost, ms per char (the share's fallback only). */
  msPerChar: number;
  /** The event loop's mean delay over the last tick in ms (and the reading is reset), or null. */
  eldMs(): number | null;
  /** The event loop's ACTIVE ms since the last call, or null. */
  eluActiveMs(): number | null;
  /** When the newest live PTY was spawned (0 = none). */
  lastSpawnAt(): number;
  turnOff(reason: string): void;
  turnOn(): void;
  log(row: Record<string, unknown>): void;
  now(): number;
}

/** While auto-off: why, since when, which off this is, and when it re-arms. */
export interface MirrorOffStatus { reason: string; since: number; offs: number; rearmAt: number }

interface Sample { share: number; eld: number | null; explained: boolean }

export class MirrorCostGuard {
  private lastBytes: number;
  private lastParse: number | null;
  private lastAt: number;
  private readonly armedAt: number;
  private samples: Sample[] = [];
  private peak = 0;
  private summaryAt: number;
  private offStatus: MirrorOffStatus | null = null;
  private offs = 0;
  private onSince: number;

  constructor(private readonly deps: MirrorCostDeps) {
    this.lastBytes = deps.bytes();
    this.lastParse = deps.parseMs();
    this.lastAt = deps.now();
    this.armedAt = this.lastAt;
    this.onSince = this.lastAt;
    this.summaryAt = this.lastAt;
    deps.eluActiveMs();   // the first reading starts from here
  }

  isOff(): boolean { return this.offStatus !== null; }
  status(): MirrorOffStatus | null { return this.offStatus ? { ...this.offStatus } : null; }

  /** One sample (main calls it every second). Returns the reason when this tick turned it off. */
  tick(): string | null {
    const now = this.deps.now();
    const bytes = this.deps.bytes();
    const parse = this.deps.parseMs();
    const eld = this.deps.eldMs();
    const active = this.deps.eluActiveMs();
    const elapsed = now - this.lastAt;
    const dBytes = Math.max(0, bytes - this.lastBytes);
    const dParse = parse !== null && this.lastParse !== null ? Math.max(0, parse - this.lastParse) : null;
    this.lastBytes = bytes;
    this.lastParse = parse;
    this.lastAt = now;
    if (this.offStatus) {
      if (now >= this.offStatus.rearmAt) this.rearm(now);
      return null;
    }
    if (elapsed <= 0) return null;
    if (this.offs > 0 && now - this.onSince >= MIRROR_OFFS_RESET_MS) this.offs = 0;
    if (now - this.armedAt < MIRROR_STARTUP_GRACE_MS || now - this.deps.lastSpawnAt() < MIRROR_SPAWN_GRACE_MS) return null;
    const share = (dParse ?? dBytes * this.deps.msPerChar) / elapsed;
    const explained = dParse !== null && active !== null && active > 0 && dParse >= MIRROR_ELD_EXPLAINS * active;
    this.samples.push({ share, eld, explained });
    if (this.samples.length > MIRROR_COST_WINDOW) this.samples.shift();
    const avg = this.samples.reduce((a, s) => a + s.share, 0) / this.samples.length;
    this.peak = Math.max(this.peak, avg);
    const lagged = this.samples.filter((s) => s.eld !== null && s.eld > MIRROR_ELD_MAX_MS && s.explained).length;
    let reason: string | null = null;
    if (this.samples.length >= MIRROR_COST_WINDOW) {
      if (avg > MIRROR_SHARE_MAX) reason = 'share';
      else if (lagged >= MIRROR_ELD_TICKS_MIN) reason = 'event-loop-delay';
    }
    if (reason) {
      this.offs += 1;
      const backoff = Math.min(MIRROR_REARM_BASE_MS * 2 ** (this.offs - 1), MIRROR_REARM_MAX_MS);
      this.offStatus = { reason, since: now, offs: this.offs, rearmAt: now + backoff };
      this.deps.log({ kind: 'mirror-auto-off', reason, share: round(avg), eldMs: eld === null ? null : round(eld), laggedTicks: lagged, measured: dParse !== null, msPerChar: this.deps.msPerChar, window: this.samples.length, offs: this.offs, rearmInMs: backoff });
      this.samples = [];
      this.deps.turnOff(reason);
      return reason;
    }
    if (now - this.summaryAt >= MIRROR_COST_SUMMARY_MS) {
      this.deps.log({ kind: 'mirror-cost', peakShare: round(this.peak), share: round(avg), eldMs: eld === null ? null : round(eld), chars: bytes, measured: dParse !== null });
      this.summaryAt = now;
      this.peak = 0;
    }
    return null;
  }

  private rearm(now: number): void {
    const was = this.offStatus;
    this.offStatus = null;
    this.onSince = now;
    this.deps.log({ kind: 'mirror-rearm', reason: was?.reason, offMs: was ? now - was.since : null, offs: this.offs });
    this.deps.turnOn();
  }
}

const round = (n: number): number => Math.round(n * 1e5) / 1e5;

/** MIRROR-STARTUP-196: the auto-off in words (term read's refusal, the banner's notice). */
export function mirrorOffWords(s: MirrorOffStatus, now: number): string {
  const secs = Math.max(0, Math.ceil((s.rearmAt - now) / 1000));
  return `the mirrors were auto-turned-off at ${new Date(s.since).toISOString().slice(11, 19)}Z (${s.reason}, off #${s.offs}); they re-arm in ${secs} s`;
}

/** MIRROR-STARTUP-196: the floor's notice (the hive:integrity banner) while the mirrors are off. */
export function mirrorOffNotice(s: MirrorOffStatus, now: number): { file: string; quarantine: null; error: string; title: string; notice: string; details: string; raisedAt: number } {
  return {
    file: 'terminal-mirror', quarantine: null, error: 'mirror-auto-off',
    title: 'Terminal screens are paused',
    notice: `The background screen copies were turned off because they were slowing the app down, so god cannot read agents' screens. They come back on by themselves; ${mirrorOffWords(s, now)}.`,
    details: `mirror-auto-off reason ${s.reason}, off #${s.offs}`,
    raisedAt: s.since
  };
}

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
