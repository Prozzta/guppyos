/**
 * TUI-COMPOSER-ALLOWLIST-191: the screen gate's allowlist for Claude Code and Antigravity, the
 * same shape as Codex's (codexScreen.ts): automatic typing is admitted only onto a recognised
 * composer, and every other screen (trust, login, bypass and API-key warnings, rate-limit menus,
 * onboarding pickers, settings errors, anything unrecognised) is refused. Creed's NUDGE-INTO-TUI
 * findings G1-G6: before this, Claude and agy had only blocklists (picker latch, draft, the Remote
 * Control dialog), so a screen nobody knew counted as ready.
 *
 * READ FROM THE BOTTOM, NOT THE CURSOR. Both TUIs draw the composer as a box at the bottom of the
 * screen: a full-width rule, the prompt row(s), a full-width rule, then at most a few footer rows.
 * Claude 2.1.302 parks its hidden cursor wherever Ink last drew (the header after boot, the last
 * column of the last row after a keystroke), so the cursor row proves nothing there; the facts'
 * `tail` (the last non-empty rows of the buffer) does. The real screens these rules were written
 * against are test/fixtures/tui-composer-allowlist/*.json:
 *   claude  `─…─` / `❯` (or `❯ Try "<example>"`, its placeholder) / `─…─` / `  ⏵⏵ … mode on …`
 *   agy     `─…─` / `>` / `─…─` / `? for shortcuts …`
 * Every dialog captured from either CLI lacks that box: their option rows are indented
 * (`  ❯ No, exit`, `> Exit and fix manually` under a title) and no rule closes them.
 *
 * Pure: no Electron, no clock.
 */
import type { CodexScreenFacts } from './codexScreen';

export type TuiGuardProvider = 'claude' | 'antigravity';
export type TuiComposerClass = 'READY' | 'READY_OWN_DRAFT' | 'DRAFT' | 'MODAL' | 'UNKNOWN';

/** The composer's prompt glyph, at column 0 of its first row. */
const PROMPT_GLYPH: Record<TuiGuardProvider, string> = { claude: '❯', antigravity: '>' };
/** A full-width box rule (both TUIs draw it across the whole terminal; 20 is a floor, not a width). */
const RULE = /^─{20,}$/;
/** Rows below the closing rule: Claude's mode line and its second row (`/rc`, effort), agy's
 *  shortcuts line, and one notice. More than this is a popup under the box (slash commands). */
export const TUI_FOOTER_MAX_ROWS = 3;
/** Rows between the two rules: a long or multi-line draft wraps; the tail keeps 24 rows, so a
 *  box whose top rule is still in the reading is always found. */
const COMPOSER_MAX_ROWS = 22;
/** Claude's empty-composer placeholder (claude.exe 2.1.302: `Try "${example}"`; claude 2.1.270's
 *  boot capture shows `❯ Try "fix lint errors"`). It is not text in the composer. */
const CLAUDE_PLACEHOLDER = /^Try "[^"]+"$/;
/** Claude collapses a large paste into one token (claude.exe: `[Pasted text #N …]`). */
const CLAUDE_PASTE_TOKEN = /^\[Pasted text #\d+[^\]]*\]$/;
/** Rows that only a select list or a confirm dialog draws (the claude and agy dialogs captured,
 *  the Remote Control dialog, the rate-limit menu). They only NAME a refusal: the allowlist above
 *  already refuses every screen without the composer box. */
const DIALOG_ROWS: readonly RegExp[] = [
  /Accessing workspace|Do you want to|Do you trust|Trust this folder|running in Bypass Permissions mode|Settings Error|Select login method|What do you want to do\?/,
  /Paste code here if prompted/,
  /^\s*(?:❯\s*|>\s*)?\d+\.\s+\S/,
  /Enter to confirm|Esc to cancel|enter Confirm|esc Exit|↑\/↓ Navigate/
];
/** The row that names a dialog, by DIALOG_ROWS order (its question before its key hint), or null. */
function dialogRow(rows: readonly string[]): string | null {
  for (const re of DIALOG_ROWS) {
    const hit = rows.find((row) => re.test(row));
    if (hit !== undefined) return hit;
  }
  return null;
}
/** How many bottom rows are searched for a dialog's rows when there is no composer. */
const DIALOG_SCAN_ROWS = 16;
const REASON_MAX = 120;

const clip = (s: string): string => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s);
const compact = (s: string): string => s.replace(/\s+/g, '');

/** The composer box at the bottom of `tail`: its rule rows and the rows between them, or null. */
export function tuiComposerBox(provider: TuiGuardProvider, tail: readonly string[]): { top: number; bottom: number; rows: string[] } | null {
  const bottom = bottomRule(tail);
  if (bottom < 2) return null;
  let top = -1;
  for (let i = bottom - 1; i >= Math.max(0, bottom - 1 - COMPOSER_MAX_ROWS); i -= 1) if (RULE.test(tail[i])) { top = i; break; }
  if (top < 0 || bottom - top < 2) return null;
  const rows = tail.slice(top + 1, bottom);
  const glyph = PROMPT_GLYPH[provider];
  // claude 2.1.270 draws a NO-BREAK SPACE after its glyph (`❯ Try …`); \s covers it.
  if (!rows[0].startsWith(glyph) || (rows[0].length > glyph.length && !/\s/.test(rows[0][glyph.length]))) return null;
  return { top, bottom, rows };
}

/** The closing rule of a composer box among the last rows of `tail`, or -1. */
function bottomRule(tail: readonly string[]): number {
  const last = tail.length - 1;
  for (let i = last; i >= Math.max(0, last - TUI_FOOTER_MAX_ROWS); i -= 1) if (RULE.test(tail[i])) return i;
  return -1;
}

/** Our own staged text may wrap taller than the tail shows (the wake nudge names every pending
 *  id): then the box's top rule and prompt glyph are above the reading. It still counts as ours
 *  when every row above the closing rule is box content (no rule, no dialog row) and together they
 *  are a long suffix of exactly what we typed. Only ever for COMMIT/REENTER (expected text);
 *  STAGE always needs the whole empty box. */
const OWN_TAIL_MIN_CHARS = 200;
function ownClippedDraft(tail: readonly string[], expectedText: string): boolean {
  const bottom = bottomRule(tail);
  if (bottom < 1) return false;
  const rows = tail.slice(0, bottom);
  if (rows.some((r) => RULE.test(r)) || dialogRow(rows) !== null) return false;
  if (tail.slice(bottom + 1).some((r) => dialogRow([r]) !== null)) return false;
  const seen = compact(rows.join(''));
  return seen.length >= OWN_TAIL_MIN_CHARS && compact(expectedText).endsWith(seen);
}

/**
 * Condition 2 for Claude and agy. STAGE wants READY (the empty composer, or Claude's placeholder);
 * COMMIT and REENTER want READY_OWN_DRAFT (the composer holds exactly `expectedText`, compared
 * without whitespace, since the box wraps it). A composer holding anything else is DRAFT.
 */
export function classifyTuiComposer(provider: TuiGuardProvider, f: CodexScreenFacts, expectedText?: string): { cls: TuiComposerClass; reason: string } {
  const tail = f.tail;
  if (!Array.isArray(tail) || tail.length === 0) return { cls: 'UNKNOWN', reason: 'no-tail' };
  const box = tuiComposerBox(provider, tail);
  if (!box && expectedText !== undefined && ownClippedDraft(tail, expectedText)) return { cls: 'READY_OWN_DRAFT', reason: 'own-draft-clipped' };
  if (!box) {
    const scan = tail.slice(-DIALOG_SCAN_ROWS);
    const hit = dialogRow(scan);
    return hit ? { cls: 'MODAL', reason: `${provider}-dialog:${clip(hit.trim())}` } : { cls: 'UNKNOWN', reason: 'no-composer' };
  }
  // A select list drawn under the box (slash-command or file completion) owns Enter.
  const footer = tail.slice(box.bottom + 1);
  const below = dialogRow(footer);
  if (below) return { cls: 'MODAL', reason: `${provider}-dialog:${clip(below.trim())}` };
  const glyph = PROMPT_GLYPH[provider];
  const text = [box.rows[0].slice(glyph.length), ...box.rows.slice(1)].join('\n').trim();
  if (text === '' || (provider === 'claude' && CLAUDE_PLACEHOLDER.test(text))) {
    return { cls: 'READY', reason: text === '' ? 'empty-composer' : 'placeholder' };
  }
  if (expectedText !== undefined && expectedText.trim() !== '') {
    if (compact(text) === compact(expectedText)) return { cls: 'READY_OWN_DRAFT', reason: 'own-draft' };
    if (provider === 'claude' && /\n/.test(expectedText.trim()) && CLAUDE_PASTE_TOKEN.test(text)) {
      return { cls: 'READY_OWN_DRAFT', reason: 'own-paste-token' };
    }
  }
  return { cls: 'DRAFT', reason: 'composer-holds-text' };
}

/** Condition 1 for Claude and agy: this reading shows the composer (empty or holding our text).
 *  The owner latches it per incarnation on a reading that covers real output, as for Codex. */
export function tuiPastStartup(cls: string): { open: boolean; reason: string } {
  return cls === 'READY' || cls === 'READY_OWN_DRAFT' || cls === 'DRAFT'
    ? { open: true, reason: 'composer-seen' }
    : { open: false, reason: 'no-composer' };
}
