/**
 * GTC M2: the two screen readings the submit owner judges, as pure functions over a buffer.
 * The renderer's xterm and main's headless mirror both call these, so the two hosts cannot read
 * the same text differently (the shadow diff compares them, termShadow.ts).
 *
 * Null = the screen is not evidence (no needle, no prompt row, or the buffer threw). The caller
 * owns the other nulls: no terminal, exited, never opened (renderer) or seeded (mirror).
 */
import { composerRegionEndsWith, needleMatcher, type ComposerBuffer } from './composerAttestation';
import { extractCodexScreen, type CodexScreenFacts } from './codexScreen';

/** The members of xterm's IBuffer both hosts have. `rows` comes from the terminal, not the buffer. */
export interface ScreenBuffer extends ComposerBuffer {
  baseY: number;
  cursorY: number;
  length: number;
}

export interface NeedleReading { onPromptRow: boolean; screenCount: number; promptTailMatches?: boolean }
export interface CodexReading extends NeedleReading { codex: CodexScreenFacts }

/** The longest expected tail the composer check is asked about; a longer one is not checked. */
export const MAX_ATTESTED_TAIL = 8192;

function tailFact(buf: ScreenBuffer, cursorRow: number, expectedTail: string | undefined): { promptTailMatches?: boolean } {
  return typeof expectedTail === 'string' && expectedTail.length > 0 && expectedTail.length <= MAX_ATTESTED_TAIL
    ? { promptTailMatches: composerRegionEndsWith(buf, cursorRow, expectedTail) }
    : {};
}

/**
 * THE ERASE ORACLE (design section 5.1): is `needle` on the prompt row (baseY + cursorY), and on
 * how many of the `rows` visible rows is it.
 */
export function needleReading(buf: ScreenBuffer, rows: number, needle: string, expectedTail?: string): NeedleReading | null {
  if (!needle) return null;
  try {
    const promptLine = buf.getLine(buf.baseY + buf.cursorY);
    if (!promptLine) return null;
    const has = needleMatcher(needle);   // CODEX-WAKE-162: tolerant of TUI-dropped characters
    let screenCount = 0;
    for (let y = 0; y < rows; y += 1) {
      const line = buf.getLine(buf.baseY + y);
      if (line && has(line.translateToString(true))) screenCount += 1;
    }
    return { onPromptRow: has(promptLine.translateToString(true)), screenCount, ...tailFact(buf, buf.baseY + buf.cursorY, expectedTail) };
  } catch {
    return null;
  }
}

/**
 * WAKE-SCREEN-GUARD: the Codex screen facts (shared/codexScreen.ts) over the WHOLE buffer,
 * scrollback included, so both hosts must keep the same scrollback (TERMINAL_SCROLLBACK_LINES).
 */
export function codexReading(buf: ScreenBuffer, expectedTail?: string): CodexReading | null {
  try {
    const cursor = buf.baseY + buf.cursorY;
    const codex = extractCodexScreen((i) => buf.getLine(i)?.translateToString(true), buf.length, cursor);
    return { onPromptRow: false, screenCount: 0, ...tailFact(buf, cursor, expectedTail), codex };
  } catch {
    return null;
  }
}
