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
 *
 * CODEX-MODEL-SWITCH-PROMPT P2 (1.1.79): a refused screen that is one of Codex's own MODAL
 * popups (a bottom-pane list that takes every key until it is answered) is named, so the Human
 * reads WHAT Codex is asking instead of "not the empty composer". It only relabels a refusal:
 * the allowlist above is unchanged, and P3 holds: the app never answers a popup (no key, no Esc).
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
/** P2: how many non-empty rows at the BOTTOM of the buffer are kept, at most. A popup hides the
 *  composer and Codex parks the cursor wherever its last draw left it, so a popup is read from
 *  the bottom of the screen, not from the cursor. The rate-limit picker is 8 such rows; the
 *  trust screen at 40 columns is 17 (long_repository_root_40x17.snap); 24 is a small terminal. */
export const CODEX_TAIL_ROWS = 24;
/** P2: the longest popup question a reason carries (a title, and its question line if any). */
export const CODEX_POPUP_TEXT_MAX = 160;
/**
 * P2: titles of Codex 0.157.1's modal popups, as their own snapshots draw them (rows trimmed).
 * A popup with another title is still recognised by its shape (codexPopup); this list only
 * picks the title row when the rows above the choices hold more than one line of text.
 */
export const CODEX_POPUP_TITLES = [
  'Approaching rate limits',                        // chatwidget/rate_limits.rs (rate_limit_switch_prompt_popup.snap)
  'Usage limit reached',                            // workspace_member_usage_limit_prompt.snap
  'Update available',                               // update_prompt.rs (update_prompt_modal.snap: "Update available · a → b")
  'Codex just got an upgrade',                      // model_migration.rs (model_migration_prompt.snap)
  'Folder access',                                  // onboarding/trust_directory.rs (trust/*.snap)
  'Would you like to run the following command?'    // approval overlay (approval_modal_exec.snap)
] as const;
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
  /** P2: the last non-empty rows of the buffer, oldest first, right-trimmed (the indent is kept:
   *  it tells a popup's header and choices apart), at most CODEX_TAIL_ROWS. */
  tail?: string[];
}

const cut = (s: string): string => (s.length > CODEX_ROW_MAX ? s.slice(0, CODEX_ROW_MAX) : s);

/** The header box's title row, `│ >_ OpenAI Codex (v…)`: anchored on the box edge, so an agent
 *  merely printing the words is not a header. */
function isHeaderTitle(row: string): boolean {
  return row.startsWith(`│ ${CODEX_HEADER_TITLE} (v`);
}

/**
 * Read the facts from a terminal buffer. `line(i)` returns buffer row `i` (0 = the oldest
 * scrollback row) as text, or undefined; `length` is the number of rows; `cursorRow` is the
 * absolute row of the cursor (`baseY + cursorY`).
 */
export function extractCodexScreen(line: (i: number) => string | undefined, length: number, cursorRow: number): CodexScreenFacts {
  let header: CodexHeaderState = 'NONE';
  let startingAfterHeader = false;
  // Jim B1: every marker is anchored at COLUMN 0 and read untrimmed. Codex draws its session
  // header box at column 0 (all 7 real fixtures); an agent quoting a header, or a lone
  // "Resuming session…", is indented in its transcript and is not a marker.
  for (let title = length - 1; title >= 0; title -= 1) {
    if (!isHeaderTitle(line(title) ?? '')) continue;
    let model: string | null = null;
    let boxEnd = -1;
    for (let i = title + 1; i < Math.min(length, title + HEADER_BOX_ROWS); i += 1) {
      const row = line(i) ?? '';
      if (row.startsWith('╰')) { boxEnd = i; break; }   // ╰ closes the box
      const m = /^│ model:\s+(\S+)/.exec(row);
      if (m) model = m[1];
    }
    // A titled box with no `│ model:` row (the /status card: `Model:`) is not a session header:
    // the scan goes on to the next older box.
    if (model === null) continue;
    header = model === 'loading' ? 'LOADING' : 'MODEL';
    // The startup draft prints its Resuming/Forking line on the row directly under its box.
    const next = boxEnd >= 0 ? (line(boxEnd + 1) ?? '').trimEnd() : '';
    startingAfterHeader = CODEX_SESSION_STARTING.some((s) => next === `  ${s}`);
    break;
  }
  const footer: string[] = [];
  for (let i = cursorRow + 1; i < length && footer.length < CODEX_FOOTER_ROWS; i += 1) {
    const row = (line(i) ?? '').trim();
    if (row) footer.push(cut(row));
  }
  const tail: string[] = [];
  for (let i = length - 1; i >= 0 && tail.length < CODEX_TAIL_ROWS; i -= 1) {
    const row = (line(i) ?? '').trimEnd();
    if (row.trim()) tail.unshift(cut(row));
  }
  return { header, startingAfterHeader, cursorRow: cut((line(cursorRow) ?? '').trimEnd()), footer, tail };
}

/** A well-formed facts object, or null. Main validates what crosses the IPC boundary. */
export function asCodexScreenFacts(v: unknown): CodexScreenFacts | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (r.header !== 'NONE' && r.header !== 'LOADING' && r.header !== 'MODEL' && r.header !== 'UNREADABLE') return null;
  if (typeof r.startingAfterHeader !== 'boolean' || typeof r.cursorRow !== 'string' || r.cursorRow.length > CODEX_ROW_MAX) return null;
  if (!Array.isArray(r.footer) || r.footer.length > CODEX_FOOTER_ROWS) return null;
  if (!r.footer.every((l) => typeof l === 'string' && l.length <= CODEX_ROW_MAX)) return null;
  const facts: CodexScreenFacts = { header: r.header, startingAfterHeader: r.startingAfterHeader, cursorRow: r.cursorRow, footer: [...r.footer] as string[] };
  if (r.tail !== undefined) {
    if (!Array.isArray(r.tail) || r.tail.length > CODEX_TAIL_ROWS) return null;
    if (!r.tail.every((l) => typeof l === 'string' && l.length <= CODEX_ROW_MAX)) return null;
    facts.tail = [...r.tail] as string[];
  }
  return facts;
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
export function isCodexStatusLine(row: string, spawnCwd: string | null | undefined, home?: string | null): boolean {
  if (!spawnCwd) return false;
  // Jim B2: the LAST ` · ` segment is the cwd; before it come the model, the effort and, on a
  // ChatGPT plan, a service tier (`<model> <effort> [<tier>] · <cwd>`).
  const t = row.trim();
  const at = t.lastIndexOf(' · ');
  // WSG-FOLLOWUPS (Jim nit): ONE or more words before it; the cwd anchor is what matters.
  if (at < 0 || !/^\S+( \S+)*$/.test(t.slice(0, at))) return false;
  let shown = t.slice(at + 3).trim();
  // Under HOME, codex shows the cwd as `~\rel` (or `~` itself).
  if (home && (shown === '~' || /^~[\\/]/.test(shown))) shown = home.replace(/[\\/]+$/, '') + shown.slice(1);
  if (!shown) return false;
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
export function codexPastStartup(f: CodexScreenFacts, spawnCwd: string | null | undefined, home?: string | null): CodexVerdict {
  if (f.header === 'LOADING') return { open: false, reason: 'header-loading' };
  if (f.header !== 'NONE' && f.startingAfterHeader) return { open: false, reason: 'session-starting' };
  if (f.header === 'MODEL') return { open: true, reason: 'header-model' };
  if (f.header === 'NONE' && f.footer.some((row) => isCodexStatusLine(row, spawnCwd, home))) return { open: true, reason: 'status-line' };
  return { open: false, reason: f.header === 'UNREADABLE' ? 'header-unreadable' : 'no-marker' };
}

/** P2: the key hint at the bottom of every Codex popup, both styles (bottom_pane picker_hint):
 *  `Press enter to confirm or esc to go back` and `enter select · esc back` (keys remappable:
 *  `f3`, `ctrl+c`, `enter/esc`). A key starts with a letter and has no `.`, `:` or `\`, so the
 *  status line `<model> <effort> · <cwd>` (a cwd with a space in it) is never a hint. */
const POPUP_KEY = '[A-Za-z][A-Za-z0-9+/-]*';
const POPUP_HINT = [
  new RegExp(`^Press ${POPUP_KEY} to [a-z][a-z ]* or ${POPUP_KEY} to [a-z][a-z ]*$`),
  new RegExp(`^${POPUP_KEY} [a-z][a-z ]* · ${POPUP_KEY} [a-z][a-z ]*$`)
];
/** The SELECTED choice row, drawn at column 0 (`› 1. Switch to …`), and any choice row. */
const POPUP_SELECTED = /^› \d+\. \S/;
const POPUP_CHOICE = /^(› | {2})\d+\. \S/;
/** A wrapped description of a choice is indented further than the header (4+ columns). */
const POPUP_DESCRIPTION = /^ {4,}\S/;

export interface CodexPopup {
  /** The popup's title row, trimmed. */
  title: string;
  /** Its question line (the row under a known title that ends in `?`), or null. */
  question: string | null;
  /** The title is one of CODEX_POPUP_TITLES. */
  known: boolean;
}

/**
 * P2: the Codex modal popup at the bottom of the screen, or null. All three, in the last rows of
 * the buffer: the popup key hint as one of the LAST TWO rows, a SELECTED choice row above it, and
 * a header row above the choices. A composer, its footer and the transcript never have all three.
 */
export function codexPopup(f: CodexScreenFacts): CodexPopup | null {
  const rows = f.tail ?? [];
  let hint = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 2); i -= 1) {
    if (POPUP_HINT.some((re) => re.test(rows[i].trim()))) { hint = i; break; }
  }
  if (hint < 0) return null;
  let selected = -1;
  for (let i = hint - 1; i >= 0; i -= 1) if (POPUP_SELECTED.test(rows[i])) { selected = i; break; }
  if (selected < 0) return null;
  // The choices block: walk up over choice rows and their wrapped descriptions.
  let top = selected;
  while (top > 0 && (POPUP_CHOICE.test(rows[top - 1]) || POPUP_DESCRIPTION.test(rows[top - 1]))) top -= 1;
  if (top === 0) return null;                                   // no header row left in the tail
  const header = rows.slice(0, top).map((r) => r.trim());
  for (let i = header.length - 1; i >= 0; i -= 1) {
    if (!CODEX_POPUP_TITLES.some((t) => header[i].startsWith(t))) continue;
    const next = header[i + 1];
    return { title: header[i], question: next !== undefined && next.endsWith('?') ? next : null, known: true };
  }
  // Jim N1: an unlisted title that is an agent's transcript bullet ("• Done.") is not a popup's
  // header: a draft quoting a hint, or a side conversation's "Side tab to switch" footer.
  const title = header[header.length - 1];
  if (title.startsWith('• ')) return null;
  return { title, question: null, known: false };
}

/** P2: the popup in one bounded line, `<title>` or `<title> — <question>`. */
export function codexPopupText(p: CodexPopup): string {
  const s = p.question ? `${p.title} — ${p.question}` : p.title;
  return s.length > CODEX_POPUP_TEXT_MAX ? `${s.slice(0, CODEX_POPUP_TEXT_MAX - 1)}…` : s;
}

/** P2: the reason prefix of a popup refusal, as the gate words it: `MODAL:codex-popup:<text>`. */
export const CODEX_POPUP_REASON = 'codex-popup:';

/** P2: the popup text inside a gate or hold reason (`MODAL:codex-popup:<text>`, or the bare
 *  `codex-popup:<text>`), or null. The notices word a popup from this. */
export function popupInReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const at = reason.indexOf(CODEX_POPUP_REASON);
  if (at < 0 || (at > 0 && !reason.slice(0, at).endsWith('MODAL:'))) return null;
  const text = reason.slice(at + CODEX_POPUP_REASON.length).trim();
  return text || null;
}

/** P2: a plain hint for a person answering a known popup, or null. Words only: the app itself
 *  never answers a popup (P3). */
export function codexPopupAdvice(text: string): string | null {
  if (text.startsWith('Approaching rate limits')) return 'To keep the current model, pick "Keep current model" (or press Esc).';
  return null;
}

export type CodexComposerClass = 'READY' | 'READY_OWN_DRAFT' | 'MODAL' | 'UNKNOWN';

/**
 * CONDITION 2: the one allowlisted screen. `ownTailMatches` is the renderer's proof that the
 * composer ends in the exact text the owner staged (asked for only after a stage write).
 * P2: a refused screen that is a Codex popup is MODAL (`codex-popup:<text>`). MODAL is never an
 * admission: every caller admits READY / READY_OWN_DRAFT only, and the two READY verdicts are
 * decided exactly as before, so a popup reading can relabel a refusal and nothing else.
 */
export function classifyCodexComposer(f: CodexScreenFacts, ownTailMatches?: boolean): { cls: CodexComposerClass; reason: string } {
  const transient = f.footer.some((row) => CODEX_TRANSIENT_FOOTER.some((t) => row.includes(t)));
  if (!transient && ownTailMatches === true) return { cls: 'READY_OWN_DRAFT', reason: 'own-draft' };
  if (!transient && f.cursorRow === CODEX_EMPTY_COMPOSER_ROW) return { cls: 'READY', reason: 'empty-composer' };
  const popup = codexPopup(f);
  if (popup) return { cls: 'MODAL', reason: `${CODEX_POPUP_REASON}${codexPopupText(popup)}` };
  if (transient) return { cls: 'UNKNOWN', reason: 'transient-footer' };
  return { cls: 'UNKNOWN', reason: 'not-the-empty-composer' };
}
