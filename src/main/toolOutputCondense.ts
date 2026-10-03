/**
 * READS-181 B: condense a large Bash/PowerShell result before it enters an agent's context.
 *
 * Every later request re-reads a tool result until the next compaction, so a 20 KB output read
 * once is paid for dozens of times (10-02: Bash outputs were an estimated 53M of Jim's 294M
 * re-reads). A PostToolUse hook may REPLACE a successful command's output (`updatedToolOutput`,
 * verified on Claude Code 2.1.288). Over the cap, the model gets what keeps the agent able to act:
 * the outcome line, every error/warning line (deduplicated), the first and last lines (where the
 * summaries are), and the path of the FULL output, which is always kept on disk.
 *
 * Not condensed: a failed command (it fires PostToolUseFailure, which cannot replace output; it
 * keeps Claude Code's native cap), a command ending in `#full`, and output within the cap.
 *
 * Pure: no IO here (the hook server reads and writes the files).
 */

/** The default per-result cap, in characters (the Human's "super aggressive" ruling, 2026-10-03). */
export const TOOL_OUTPUT_CAP_DEFAULT = 1500;
/** N1 (god's ruling, 2026-10-03): a READ-type command's output is what the agent asked for, and a
 *  re-fetch costs a whole request at the full context, so it gets this larger cap. Build, test and
 *  install logs (the real waste) keep the default. */
export const TOOL_OUTPUT_CAP_READ = 6000;
/** The first word of the last pipeline segment that makes a command read-type (grep, sed, cat …,
 *  and the PowerShell equivalents of cat/grep). `git` counts with diff/show/log. */
const READ_COMMANDS: ReadonlySet<string> = new Set(['grep', 'rg', 'sed', 'cat', 'head', 'tail', 'jq', 'get-content', 'gc', 'select-string', 'sls', 'type']);
const GIT_READ: ReadonlySet<string> = new Set(['diff', 'show', 'log']);

/** The command's last segment (after |, ||, &&, ; or a newline outside quotes), as words. */
function lastSegmentWords(command: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '|' || ch === ';' || ch === '\n' || (ch === '&' && command[i + 1] === '&')) {
      segs.push(cur); cur = '';
      if ((ch === '|' && command[i + 1] === '|') || ch === '&') i += 1;
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  const last = segs.map((x) => x.trim()).filter(Boolean).pop() ?? '';
  const words = last.split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // VAR=x cmd
  return words;
}

/** Is this a read-type command (its whole output is the point)? */
export function isReadCommand(command: string): boolean {
  const words = lastSegmentWords(command.replace(FULL_MARKER_RE, ''));
  if (!words.length) return false;
  const first = (words[0].split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (READ_COMMANDS.has(first)) return true;
  if (first !== 'git') return false;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '-C' || w === '-c') { i += 1; continue; }
    if (w.startsWith('-')) continue;
    return GIT_READ.has(w);
  }
  return false;
}

/** The cap for one command: 0 stays off; a read-type command gets at least TOOL_OUTPUT_CAP_READ. */
export function capForCommand(command: string, cap: number): number {
  if (!cap) return 0;
  return isReadCommand(command) ? Math.max(cap, TOOL_OUTPUT_CAP_READ) : cap;
}

/** The smallest cap that still fits the outcome line, the path and a few lines. */
export const TOOL_OUTPUT_CAP_MIN = 600;
/** The tools whose output is condensed. */
export const CONDENSED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
/** A command that ends in `#full` (a shell comment, so it runs unchanged) is never condensed. */
export const FULL_MARKER_RE = /#full\s*$/;

const ERROR_RE = /\b(?:error|errors|err!|fail|failed|failure|failing|fails|warn|warning|warnings|denied|exception|traceback|fatal|panic|not found|cannot|unable to|enoent|eacces|eperm|ebusy|refused|timed out|timeout)\b|[✖✗×]|^\s*not ok\b/i;
const HEAD_LINES = 5;
const TAIL_LINES = 12;
const ERROR_LINES = 12;
const LINE_MAX = 160;

/** The cap for a raw setting: 0 (or below) = off; otherwise at least TOOL_OUTPUT_CAP_MIN. */
export function effectiveCap(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return TOOL_OUTPUT_CAP_DEFAULT;
  if (raw <= 0) return 0;
  return Math.max(TOOL_OUTPUT_CAP_MIN, Math.floor(raw));
}

export interface BashLikeResponse {
  stdout?: unknown;
  stderr?: unknown;
  interrupted?: unknown;
  returnCodeInterpretation?: unknown;
  persistedOutputPath?: unknown;
  persistedOutputSize?: unknown;
  isImage?: unknown;
}

/** The command a Bash/PowerShell call ran, or ''. */
export function commandOf(toolInput: unknown): string {
  const c = toolInput && typeof toolInput === 'object' ? (toolInput as { command?: unknown }).command : undefined;
  return typeof c === 'string' ? c : '';
}

/** The output the tool produced, as the model would read it: stdout, then stderr. */
export function outputText(r: BashLikeResponse): string {
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  const err = typeof r.stderr === 'string' ? r.stderr : '';
  return err ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}${err}` : out;
}

/** Should this result be condensed at all (before any file is read)? */
export function shouldCondense(tool: string | undefined, toolInput: unknown, r: BashLikeResponse | null, cap: number): boolean {
  if (!cap || !tool || !CONDENSED_TOOLS.has(tool) || !r || typeof r !== 'object') return false;
  if (r.isImage === true) return false;
  if (FULL_MARKER_RE.test(commandOf(toolInput))) return false;
  const persisted = typeof r.persistedOutputPath === 'string' && r.persistedOutputPath !== '';
  return persisted || outputText(r).length > cap;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface CondenseArgs {
  /** The full output (or as much of it as could be read). */
  text: string;
  cap: number;
  /** Where the full output is on disk. */
  path: string;
  /** The full output's size in characters, when known to be larger than `text`. */
  totalChars?: number;
  interrupted?: boolean;
  /** Claude Code's reading of a special exit code (e.g. grep's 1 = "No matches found"). */
  interpretation?: string;
  /** True when `text` is only part of the output (a huge file read in head and tail parts). */
  partial?: boolean;
}

/**
 * The condensed result: within `cap` characters, always the outcome line first and the path last.
 * Space goes, in order, to the tail, the error lines, then the head; each shrinks until it fits.
 */
export function condenseOutput(a: CondenseArgs): string {
  const lines = a.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const chars = a.totalChars ?? a.text.length;
  const outcome = `[condensed by Guppy: the command succeeded${a.interpretation ? ` (${clip(a.interpretation, 80)})` : ''}`
    + `${a.interrupted ? ', interrupted' : ''}; ${chars.toLocaleString('en-US')} chars, ${lines.length.toLocaleString('en-US')} lines${a.partial ? ' (read in part)' : ''}]`;
  const footer = `[full output: ${a.path} (Read it with offset/limit, or grep it). End a command with #full to see its output uncondensed.]`;

  // Error lines outside the head and tail, deduplicated (×N), in order of first appearance.
  const pickErrors = (head: number, tail: number, max: number, width: number): string[] => {
    const seen = new Map<string, number>();
    const order: string[] = [];
    for (let i = head; i < lines.length - tail; i += 1) {
      const l = lines[i].trim();
      if (!l || !ERROR_RE.test(l)) continue;
      const k = clip(l, width);
      if (!seen.has(k)) { seen.set(k, 0); order.push(k); }
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const out = order.slice(0, max).map((k) => (seen.get(k)! > 1 ? `${k} ×${seen.get(k)}` : k));
    if (order.length > max) out.push(`… ${order.length - max} more distinct error/warning lines in the full output`);
    return out;
  };
  const build = (head: number, tail: number, errs: number, width: number): string => {
    const h = Math.min(head, lines.length);
    const t = Math.min(tail, Math.max(0, lines.length - h));
    const parts = [outcome];
    if (h) parts.push(...lines.slice(0, h).map((l) => clip(l, width)));
    const e = errs ? pickErrors(h, t, errs, width) : [];
    const skipped = lines.length - h - t;
    if (skipped > 0) parts.push(e.length ? `… ${skipped} lines omitted; error and warning lines among them:` : `… ${skipped} lines omitted`);
    if (e.length) parts.push(...e.map((l) => `  ${l}`));
    if (t) parts.push(...lines.slice(lines.length - t).map((l) => clip(l, width)));
    parts.push(footer);
    return parts.join('\n');
  };
  // Shrink in steps until it fits: fewer head lines, then errors, then tail, then narrower lines.
  // N1: a cap above the default (the read cap) spends its room on MORE head and tail lines (a
  // grep or a diff shows as much as fits), shrinking step by step before the fixed plans.
  const scaled: Array<[number, number, number, number]> = [];
  if (a.cap > TOOL_OUTPUT_CAP_DEFAULT) {
    const n0 = Math.floor(a.cap / 120);
    for (const k of [1, 0.8, 0.6, 0.45, 0.33, 0.25]) {
      const n = Math.round(n0 * k);
      if (n > TAIL_LINES) scaled.push([n, n, ERROR_LINES, LINE_MAX]);
    }
  }
  const plans: Array<[number, number, number, number]> = [
    ...scaled,
    [HEAD_LINES, TAIL_LINES, ERROR_LINES, LINE_MAX], [3, TAIL_LINES, 8, LINE_MAX], [2, 8, 6, 140],
    [2, 6, 4, 120], [1, 4, 3, 100], [1, 3, 2, 80], [0, 2, 1, 80], [0, 1, 0, 60], [0, 0, 0, 60]
  ];
  for (const [h, t, e, w] of plans) {
    const s = build(h, t, e, w);
    if (s.length <= a.cap) return s;
  }
  // Last resort: the outcome and the path are what must survive.
  const bare = `${outcome}\n${footer}`;
  return bare.length <= a.cap ? bare : clip(bare, a.cap);
}
