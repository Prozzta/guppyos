/**
 * WAKE-SCREEN-GUARD (1.1.76): what a Codex 0.157.1 terminal shows, read so that automatic
 * delivery never types into a screen that is not the chat composer.
 *
 * ZT-175 (the folder-trust Quit): a wake typed `[hive] check inbox` + Enter into Codex's
 * directory-trust screen, where `n` means Quit. Codex draws a composer-like STARTUP DRAFT
 * before trust, login and the update prompt, so "a composer is on screen" proves nothing.
 * Design of record: andy-scratch/ZT175-TRUST-QUIT.md, round 3 + FINAL (Jim V1, god 131cd3).
 *
 * Two halves, both pure, so the renderer and main share ONE reading of the screen:
 *   - `extractCodexScreen` runs in the renderer over the whole xterm buffer (scrollback
 *     included) and returns small FACTS. It decides nothing.
 *   - `codexPastStartup` and `classifyCodexComposer` run in main over those facts.
 *
 * CONDITION 1 (the post-handoff proof, V1). The startup draft hardcodes the header model as
 * `loading` (codex startup_draft.rs:444-460) and prints `  Resuming session…` / `  Forking
 * session…` under it (:470-474); the handed-off chat widget shows the configured model. So,
 * over the NEWEST `>_ OpenAI Codex` header box in the whole buffer:
 *   REFUSE  the newest header shows `loading`, or a Resuming/Forking line follows it;
 *   OPEN    the newest header shows any other model (M1);
 *   OPEN    no header is left in the buffer at all AND the footer holds the status line
 *           `<model> <effort> · <spawn cwd>` (M3, a fallback only: the status line is
 *           configurable, so it is never required);
 *   REFUSE  anything else (an unreadable header, no marker at all).
 * The context footer (M2) never appeared on real 0.157.1 and is not used (K1).
 *
 * CONDITION 2 (every request, fresh). The cursor row is exactly Codex's empty-composer
 * placeholder row, and nothing transient sits in the footer; or the composer ends in the
 * owner's own staged text (the renderer's `promptTailMatches`). Allowlist only: every other
 * screen (trust, update, login, pickers, overlays, pager, anything unrecognised) is UNKNOWN.
 */

/** The empty composer row: prompt glyph + the fixed placeholder (codex chatwidget.rs:2104). */
export const CODEX_EMPTY_COMPOSER_ROW = '› Ask Codex to do anything';
/** The session header box's title (history_cell SessionHeaderHistoryCell). */
export const CODEX_HEADER_TITLE = '>_ OpenAI Codex';
/** Printed under the startup draft's header for a resume / fork (startup_draft.rs:470-474). */
export const CODEX_SESSION_STARTING = ['Resuming session…', 'Forking session…'] as const;
/** Footer modes that are transient and owned by a keystroke (footer.rs:933, :941, :947, and
 *  the shortcut overlay's closer). A composer under one of them is not the plain composer. */
export const CODEX_TRANSIENT_FOOTER = ['again to quit', 'to edit previous message', 'esc close'] as const;

/** How many rows below the cursor are the footer, at most. */
export const CODEX_FOOTER_ROWS = 6;
/** No row of ours is longer than this; a longer one is cut (the facts stay small). */
export const CODEX_ROW_MAX = 400;
/** How far below a header title its `model:` line may sit. */
const HEADER_BOX_ROWS = 8;

export type CodexHeaderState = 'NONE' | 'LOADING' | 'MODEL' | 'UNREADABLE';

/** What the renderer reports. Small, and no more screen text than the classifier needs. */
export interface CodexScreenFacts {
  /** The NEWEST header box in the whole buffer, scrollback included. */
  header: CodexHeaderState;
  /** A `Resuming session…` / `Forking session…` line below the newest header. */
  startingAfterHeader: boolean;
  /** The cursor's row, right-trimmed. */
  cursorRow: string;
  /** The non-empty rows below the cursor, trimmed (the footer), at most CODEX_FOOTER_ROWS. */
  footer: string[];
}

const cut = (s: string): string => (s.length > CODEX_ROW_MAX ? s.slice(0, CODEX_ROW_MAX) : s);

/** The header box's title row, `│ >_ OpenAI Codex (v…)`: anchored on the box edge, so an agent
 *  merely printing the words is not a header. */
function isHeaderTitle(row: string): boolean {
  const t = row.trim();
  return t.startsWith('│') && t.slice(1).trimStart().startsWith(`${CODEX_HEADER_TITLE} (v`);
}

/**
 * Read the facts from a terminal buffer. `line(i)` returns buffer row `i` (0 = the oldest
 * scrollback row) as text, or undefined; `length` is the number of rows; `cursorRow` is the
 * absolute row of the cursor (`baseY + cursorY`).
 */
export function extractCodexScreen(line: (i: number) => string | undefined, length: number, cursorRow: number): CodexScreenFacts {
  let header: CodexHeaderState = 'NONE';
  let startingAfterHeader = false;
  let title = -1;
  for (let i = length - 1; i >= 0; i -= 1) {
    if (isHeaderTitle(line(i) ?? '')) { title = i; break; }
  }
  if (title >= 0) {
    header = 'UNREADABLE';
    let boxEnd = title;
    for (let i = title + 1; i < Math.min(length, title + HEADER_BOX_ROWS); i += 1) {
      const row = (line(i) ?? '').trim();
      boxEnd = i;
      if (row.startsWith('╰')) break;   // ╰ closes the box
      const m = /^│\s*model:\s+(\S+)/.exec(row);
      if (m) header = m[1] === 'loading' ? 'LOADING' : 'MODEL';
    }
    for (let i = boxEnd + 1; i < length; i += 1) {
      const row = (line(i) ?? '').trim();
      if ((CODEX_SESSION_STARTING as readonly string[]).includes(row)) { startingAfterHeader = true; break; }
    }
  }
  const footer: string[] = [];
  for (let i = cursorRow + 1; i < length && footer.length < CODEX_FOOTER_ROWS; i += 1) {
    const row = (line(i) ?? '').trim();
    if (row) footer.push(cut(row));
  }
  return { header, startingAfterHeader, cursorRow: cut((line(cursorRow) ?? '').trimEnd()), footer };
}

/** A well-formed facts object, or null. Main validates what crosses the IPC boundary. */
export function asCodexScreenFacts(v: unknown): CodexScreenFacts | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.header !== 'NONE' && r.header !== 'LOADING' && r.header !== 'MODEL' && r.header !== 'UNREADABLE') return null;
  if (typeof r.startingAfterHeader !== 'boolean' || typeof r.cursorRow !== 'string' || r.cursorRow.length > CODEX_ROW_MAX) return null;
  if (!Array.isArray(r.footer) || r.footer.length > CODEX_FOOTER_ROWS) return null;
  if (!r.footer.every((l) => typeof l === 'string' && l.length <= CODEX_ROW_MAX)) return null;
  return { header: r.header, startingAfterHeader: r.startingAfterHeader, cursorRow: r.cursorRow, footer: [...r.footer] as string[] };
}

/** Windows paths compare case-insensitively and with either separator. */
function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.trim().replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  return n(a) === n(b);
}

/**
 * M3: the passive status line `<model> <effort> · <cwd>`, and its cwd is the agent's SPAWN
 * cwd. A narrow footer may elide the middle of the path with `…`; then the kept head and tail
 * must both match it.
 */
export function isCodexStatusLine(row: string, spawnCwd: string | null | undefined): boolean {
  if (!spawnCwd) return false;
  const m = /^(\S+) (\S+) · (.+)$/.exec(row.trim());
  if (!m) return false;
  const shown = m[3].trim();
  if (samePath(shown, spawnCwd)) return true;
  const gap = shown.indexOf('…');
  if (gap < 0 || shown.indexOf('…', gap + 1) >= 0) return false;
  const head = shown.slice(0, gap).toLowerCase().replace(/\//g, '\\');
  const tail = shown.slice(gap + 1).toLowerCase().replace(/\//g, '\\');
  const cwd = spawnCwd.trim().toLowerCase().replace(/\//g, '\\');
  return head.length + tail.length >= 4 && cwd.length > head.length + tail.length && cwd.startsWith(head) && cwd.endsWith(tail);
}

export interface CodexVerdict { open: boolean; reason: string }

/** CONDITION 1 (V1): is this Codex process past its startup phase? */
export function codexPastStartup(f: CodexScreenFacts, spawnCwd: string | null | undefined): CodexVerdict {
  if (f.header === 'LOADING') return { open: false, reason: 'header-loading' };
  if (f.header !== 'NONE' && f.startingAfterHeader) return { open: false, reason: 'session-starting' };
  if (f.header === 'MODEL') return { open: true, reason: 'header-model' };
  if (f.header === 'NONE' && f.footer.some((row) => isCodexStatusLine(row, spawnCwd))) return { open: true, reason: 'status-line' };
  return { open: false, reason: f.header === 'UNREADABLE' ? 'header-unreadable' : 'no-marker' };
}

export type CodexComposerClass = 'READY' | 'READY_OWN_DRAFT' | 'UNKNOWN';

/**
 * CONDITION 2: the one allowlisted screen. `ownTailMatches` is the renderer's proof that the
 * composer ends in the exact text the owner staged (asked for only after a stage write).
 */
export function classifyCodexComposer(f: CodexScreenFacts, ownTailMatches?: boolean): { cls: CodexComposerClass; reason: string } {
  const transient = f.footer.some((row) => CODEX_TRANSIENT_FOOTER.some((t) => row.includes(t)));
  if (transient) return { cls: 'UNKNOWN', reason: 'transient-footer' };
  if (ownTailMatches === true) return { cls: 'READY_OWN_DRAFT', reason: 'own-draft' };
  if (f.cursorRow === CODEX_EMPTY_COMPOSER_ROW) return { cls: 'READY', reason: 'empty-composer' };
  return { cls: 'UNKNOWN', reason: 'not-the-empty-composer' };
}
