/**
 * GOD-TERMINAL-CONTROL M1: a headless screen per PTY, kept in MAIN.
 *
 * Why: every reading the hive acted on came from the renderer's xterm, so a tab that was never
 * opened, a throttled window or a renderer reader quirk left god blind. This mirror is fed the
 * SAME chunks, in the SAME order, from PtyManager.deliverData (after its session-identity guard),
 * so main can read any agent's screen in any state.
 *
 * It NEVER answers the TUI. @xterm/headless replies to DA/CPR queries on its onData (measured
 * 16:21Z: `ESC[?1;2c`, `ESC[2;1R`); the renderer is the one responder, and a second answer would
 * reach the child as typed input. The reply is dropped here, structurally: nothing wires onData.
 *
 * Unicode 11 widths, as the renderer uses (measured: the addon loads and works in headless).
 */
import { performance } from 'node:perf_hooks';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { extractCodexScreen, type CodexScreenFacts } from '../shared/codexScreen';

export const MIRROR_SCROLLBACK = 1000;

/** One reading of the mirror. `lines` are the viewport rows, right-trimmed, top to bottom. */
export interface MirrorReading {
  lines: string[];
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  altScreen: boolean;
  /** DECSET 2004 as the stream set it. Evidence of mode only: through ConPTY a bracketed paste
   *  is NOT a guard (design section 11), so nothing frames on this bit. */
  bracketedPaste: boolean;
  /** DECCKM: arrow keys are SS3 (`ESC O A`) while it is set. */
  appCursor: boolean;
}

export interface TerminalMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** The viewport after every byte written so far is parsed. `rows` = the last N rows only. */
  read(rows?: number): Promise<MirrorReading>;
  /** The screen-gate facts (shared/codexScreen.ts) over the WHOLE buffer, scrollback included, read
   *  exactly as the renderer's readCodexScreen reads them: the shadow diff compares the two. */
  facts(): Promise<CodexScreenFacts>;
  /** Bytes handed to write() since the mirror was made (the cost sampler's input). */
  bytesWritten(): number;
  dispose(): void;
}

export interface HeadlessLike {
  cols: number;
  rows: number;
  buffer: { active: { type: string; cursorX: number; cursorY: number; viewportY: number; baseY: number; length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
  modes: { bracketedPasteMode: boolean; applicationCursorKeysMode: boolean };
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

/** MIRROR-STARTUP-196: the main-thread ms every real mirror has spent parsing, measured (not
 *  chars x a calibration), monotonic; and whether every real mirror made so far could be timed. */
let parsedMs = 0;
let untimed = false;
export function mirrorParseMs(): number | null {
  return untimed ? null : parsedMs;
}

/**
 * MIRROR-STARTUP-196: times the real parse. @xterm/headless queues write() and parses in
 * WriteBuffer._innerWrite slices (setTimeout, about 12 ms each), so the sync time of that one
 * method IS the mirror's main-thread cost. Only the outermost call is timed (it can call itself
 * directly when a handler resumes). An xterm without the method is reported, never guessed: the
 * guard then cannot blame the mirror for lag (test/mirror-startup-196 pins the method on the
 * installed xterm, so an upgrade that drops it fails there).
 */
export function timeParse(t: unknown, add: (ms: number) => void): boolean {
  const wb = (t as { _core?: { _writeBuffer?: Record<string, unknown> } })?._core?._writeBuffer;
  const inner = wb?._innerWrite;
  if (!wb || typeof inner !== 'function') return false;
  let depth = 0;
  wb._innerWrite = function timed(this: unknown, ...a: unknown[]): unknown {
    if (depth++ > 0) { try { return inner.apply(this, a); } finally { depth--; } }
    const t0 = performance.now();
    try { return inner.apply(this, a); } finally { depth--; add(performance.now() - t0); }
  };
  return true;
}

/** The real headless terminal. Throws if the module is missing (the caller then runs mirror-less).
 *  `Term` is the class (a test passes a stub without the slice method: the untimed path). */
export function createHeadless(cols: number, rows: number, Term: typeof Terminal = Terminal): HeadlessLike {
  const t = new Term({ cols, rows, scrollback: MIRROR_SCROLLBACK, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  if (!timeParse(t, (ms) => { parsedMs += ms; })) untimed = true;
  return t as unknown as HeadlessLike;
}

/** Wraps a headless terminal. Dimensions are clamped as node-pty's are (1..1000). */
export function createTerminalMirror(cols: number, rows: number, make: (c: number, r: number) => HeadlessLike = createHeadless): TerminalMirror {
  const clamp = (n: number, d: number): number => (Number.isInteger(n) && n >= 1 && n <= 1000 ? n : d);
  const t = make(clamp(cols, 100), clamp(rows, 30));
  let written = 0;
  let disposed = false;
  const drained = (): Promise<void> => new Promise((resolve) => { if (disposed) resolve(); else t.write('', resolve); });
  return {
    write(data) {
      if (disposed || !data) return;
      written += data.length;
      t.write(data);
    },
    resize(c, r) {
      if (disposed) return;
      try { t.resize(clamp(c, t.cols), clamp(r, t.rows)); } catch { /* a bad size keeps the old one */ }
    },
    async read(rowsWanted) {
      await drained();
      const b = t.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
      const n = Number.isInteger(rowsWanted) && (rowsWanted as number) > 0 ? Math.min(rowsWanted as number, lines.length) : lines.length;
      return {
        lines: lines.slice(lines.length - n),
        cursor: { x: b.cursorX, y: b.cursorY },
        cols: t.cols,
        rows: t.rows,
        altScreen: b.type === 'alternate',
        bracketedPaste: t.modes.bracketedPasteMode === true,
        appCursor: t.modes.applicationCursorKeysMode === true
      };
    },
    async facts() {
      await drained();
      const b = t.buffer.active;
      return extractCodexScreen((i) => b.getLine(i)?.translateToString(true), b.length, b.baseY + b.cursorY);
    },
    bytesWritten: () => written,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { t.dispose(); } catch { /* already gone */ }
    }
  };
}

/** The last `n` non-empty-trailing rows of a reading, for bounded log tails. */
export function screenTail(r: MirrorReading | null, n = 12): string[] {
  if (!r) return [];
  const lines = [...r.lines];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).map((l) => (l.length > 240 ? `${l.slice(0, 240)}…` : l));
}
