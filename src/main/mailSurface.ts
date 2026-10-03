/**
 * ZT-I1-MAIL (1.1.75) slice 2: how a message BODY reaches the agent (INBOX-DESIGN.md §2, §11.1,
 * §11.2, §11.6, §11.9, §11.17).
 *
 * Pure pieces the HookServer composes:
 *  - `buildMailBlock`: the `<hive-mail>` block for one hook response, inside a character budget
 *    that is JOINED with every other context in the same additionalContext (§11.2). An id is only
 *    reported as surfacing when its whole entry (or its deliberate truncation with the file path)
 *    lies inside the budget, so nothing ever sits past Claude's 10,000-character spill point.
 *  - `mailChannelMode` / `mailEvidenceKind`: the §11.9 provider defaults.
 *  - `mailEvidenceIn` + `readFileWindow`: the §11.1 deterministic confirmation (a Claude transcript
 *    `hook_additional_context` attachment, or a Codex rollout developer-role input, carrying the
 *    `hive-mail:<id>` marker). Keyed on the marker, never on record position (N1).
 *  - `mailLatencyLimitMs`: the §11.1 latency rule per hook transport.
 *
 * Every character a sender controls is escaped: `<`/`>` (so it cannot close the tag, as
 * `<inbox-update>` always did) and the `hive-mail:` marker prefix (so a body quoting another id
 * cannot forge that id's delivery evidence).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { AgentProvider } from '../shared/agentProvider';
import type { MailChannelOverride, MailEntry, MailObligation } from './mailLedger';

/** §11.2: mail budget = this − length(roster + goal + steer + any other joined context). */
export const MAIL_JOINED_BUDGET = 9_500;
/** §11.2: under this, the block carries headers only and nothing is marked surfacing. */
export const MAIL_HEADERS_ONLY_BELOW = 1_500;
/** §2.1: a single body over the budget is surfaced as (at most) its first this-many characters + the path. */
export const MAIL_TRUNCATE_CHARS = 7_000;
/** Jim audit #3: the truncation fits the budget that is LEFT (header + as much body as fits + the
 *  path), but never below this many body characters; below it the message waits for a roomier hook. */
export const MAIL_TRUNCATE_MIN_CHARS = 1_000;
/** The most messages considered for one hook (bounded work per hook; the rest drip). */
export const MAIL_BLOCK_MAX_ITEMS = 50;
/** The most piggyback reminder lines (option B) in one block. */
export const MAIL_REMINDER_MAX = 5;
/** The most deferred ids named in the "will follow" line. */
const DEFERRED_NAMED_MAX = 10;

// ————————————————————————————————————————————————————————————— READS-MAIL-CAP (1.1.83)

/** god's default per-message cap: a longer body is shown as its first ~this many characters plus
 *  the file paths (config `godMailCapChars`; 0 = off). Other agents are uncapped unless their
 *  registry entry sets `mailCapChars`. */
export const GOD_MAIL_CAP_DEFAULT = 1_500;
/** A body is capped only when that saves at least this many characters (the pointer line costs
 *  about 250, so a body just over the cap is cheaper whole). */
export const MAIL_CAP_MIN_SAVING = 500;
/** The cut backs off to a line break or a space inside this many characters before the cap. */
const MAIL_CAP_BACKOFF = 200;

/** The cap in force for one agent: its own registry `mailCapChars` wins (0 = off); else god gets
 *  the config's `godMailCapChars` (unset = GOD_MAIL_CAP_DEFAULT) and every other agent none (0). */
export function effectiveMailCap(own: unknown, configured: unknown, isGod: boolean): number {
  const norm = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const mine = norm(own);
  if (mine !== undefined) return mine;
  if (!isGod) return 0;
  return norm(configured) ?? GOD_MAIL_CAP_DEFAULT;
}

/** Mail from these senders is never capped: the Human's words and harness mail can carry an exact
 *  command at the end (an ephemeral worker's Slack reply line), which a cut would hide. */
export function mailCapExempt(from: string, exemptSenders: ReadonlySet<string>): boolean {
  return exemptSenders.has(from);
}

/** Where the cut falls in an (escaped) body under `cap`, or null when the body stays whole. */
export function mailCapCut(body: string, cap: number | undefined): number | null {
  if (!cap || cap <= 0 || body.length < cap + MAIL_CAP_MIN_SAVING) return null;
  let cut = cap;
  const nl = body.lastIndexOf('\n', cap);
  const sp = body.lastIndexOf(' ', cap);
  if (nl >= cap - MAIL_CAP_BACKOFF && nl > 0) cut = nl;
  else if (sp >= cap - MAIL_CAP_BACKOFF && sp > 0) cut = sp;
  // Never split an escape (&lt; &gt; &#58;) in two.
  const amp = body.lastIndexOf('&', cut);
  if (amp >= 0 && amp > cut - 5 && body.indexOf(';', amp) >= cut) cut = amp;
  return cut;
}

/** The message file once handled: the harness archives it into inbox/.done/ when the turn ends,
 *  so a shortened message names both places (no lost function: the rest stays readable). */
export function handledMailPath(p: string): string | null {
  const m = /^(.*[\\/])([^\\/]+)$/.exec(p);
  if (!m || /[\\/]\.done[\\/]$/.test(m[1])) return null;
  return `${m[1]}.done${m[1].slice(-1)}${m[2]}`;
}

function whereText(p: string): string {
  const done = handledMailPath(p);
  return done ? `${escapeMailText(p)} (after this turn: ${escapeMailText(done)})` : escapeMailText(p);
}

/** The HTTP hook timeout Claude applies (mirrors hive.ts HOOK_HTTP_TIMEOUT_S; §11.1). */
export const MAIL_HTTP_HOOK_TIMEOUT_MS = 30_000;
/** The command shims (HOOK_SHIM, AGY_HOOK_SHIM) give up after 5 s and print NOTHING, so on the
 *  pipe the provider-side budget is the shim's, not the provider's 30 s. */
export const MAIL_PIPE_HOOK_TIMEOUT_MS = 5_000;
/** §11.18 #9 (Q8 ruling): a response counts as delivered only when it is flushed before the
 *  transport timeout minus min(5 s, 50% of the timeout). */
export function mailLatencyLimitFor(timeoutMs: number): number {
  return timeoutMs - Math.min(5_000, timeoutMs * 0.5);
}
/** MAIL-PIPE-SHIM-CLOCK (1): a pipe shim's own running time at send, as the server adds it to its
 *  arrival-to-flush measure. Not a finite non-negative number (an older shim): 0, the old measure.
 *  Capped at the shim's own give-up: it cannot have run longer and still be sending. */
export function shimElapsedMs(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), MAIL_PIPE_HOOK_TIMEOUT_MS) : 0;
}
/** http / mcp: 30 s − 5 s = 25 s. */
export const MAIL_HTTP_LATENCY_LIMIT_MS = mailLatencyLimitFor(MAIL_HTTP_HOOK_TIMEOUT_MS);
/** The pipe: 5 s − 2.5 s = 2.5 s. */
export const MAIL_PIPE_LATENCY_LIMIT_MS = mailLatencyLimitFor(MAIL_PIPE_HOOK_TIMEOUT_MS);
/** §11.1 evidence scan: the most bytes read per scan (a bounded window from the claim offset). */
export const MAIL_EVIDENCE_SCAN_MAX_BYTES = 2 * 1024 * 1024;
/** Bytes re-read before the claim-time offset (a line in flight when the size was taken). */
export const MAIL_EVIDENCE_SCAN_BACK_BYTES = 64 * 1024;

// ————————————————————————————————————————————————————————————— provider modes (§11.9)

/**
 * - `inject`: bodies travel in hook context (Claude, Codex, AGY).
 * - `legacy-read`: hook-capable but unverified injection (gemini, grok, opencode, pi): the nudge
 *   carries ids + path, the agent reads the files; slice 3 marks them acted at its Stop.
 * - `legacy-move`: no Stop signal (cursor): 1.1.74 semantics, the agent moves the file (§11.7).
 * - `work-order`: proxy tier and hookless (qwen, crush, kimi, copilot, custom): the body is typed
 *   into the PTY; acted on the confirmed write (N2).
 */
export type MailChannelMode = 'inject' | 'legacy-read' | 'legacy-move' | 'work-order';

export function mailChannelMode(provider: AgentProvider | undefined, override?: MailChannelOverride | null): MailChannelMode {
  const p = provider ?? 'claude';
  let mode: MailChannelMode;
  switch (p) {
    case 'claude': case 'codex': case 'antigravity': mode = 'inject'; break;
    case 'gemini': case 'grok': case 'opencode': case 'pi': mode = 'legacy-read'; break;
    case 'cursor': mode = 'legacy-move'; break;
    default: mode = 'work-order';
  }
  // Degradation (§11.10) only ever moves an injection agent to legacy-read.
  if (mode === 'inject' && override?.mode === 'legacy-read') return 'legacy-read';
  return mode;
}

/**
 * §5 / §11.7: which mail instructions an agent's SPAWN PROMPT carries (P1).
 *  - `inject`: bodies arrive in context; the agent never reads, lists or moves inbox files.
 *  - `legacy-read`: the agent reads the files; the harness archives them at its Stop (no "move").
 *  - `legacy-move`: no Stop signal, 1.1.74 semantics: read AND move handled files to .done. That
 *    is cursor and an injection agent degraded for zero hook traffic (§11.10: its own move is what
 *    counts as handled, Creed's ruling).
 *  - `work-order` (Creed Q26): the terminal work-order agents: each message is typed into the
 *    terminal whole and is handled at the confirmed write (N2), so NO read or move instruction.
 */
export type MailPromptMode = 'inject' | 'legacy-read' | 'legacy-move' | 'work-order';

export function mailPromptMode(mode: MailChannelMode, override?: MailChannelOverride | null): MailPromptMode {
  if (mode === 'inject') return 'inject';
  if (mode === 'legacy-read') return override?.reason === 'zero-hook-traffic' ? 'legacy-move' : 'legacy-read';
  if (mode === 'work-order') return 'work-order';
  return 'legacy-move';
}

/**
 * Which text the wake NUDGE carries (P4; mirrors `NudgeMailMode` in shared/hiveNudge.ts). As the
 * prompt mode, except (Creed Q27) a DEGRADED injection agent, whose running session still holds the
 * injection P1 until it respawns: its nudge says the channel is degraded and what to do instead:
 * `degraded-move` (zero hook traffic: read the file and move it to .done yourself) or
 * `degraded-read` (no mail block, Stop still seen: read the file; the harness archives it).
 */
export type MailNudgeMode = MailPromptMode | 'degraded-move' | 'degraded-read';

export function mailNudgeMode(mode: MailChannelMode, override?: MailChannelOverride | null): MailNudgeMode {
  if (mode === 'legacy-read' && override?.mode === 'legacy-read') return override.reason === 'zero-hook-traffic' ? 'degraded-move' : 'degraded-read';
  return mailPromptMode(mode, override);
}

/** How a surfacing is confirmed (§11.1): a readable record, or the latency rule. */
export type MailEvidenceKind = 'claude-transcript' | 'codex-rollout' | 'latency';

export function mailEvidenceKind(provider: AgentProvider | undefined): MailEvidenceKind {
  const p = provider ?? 'claude';
  if (p === 'claude') return 'claude-transcript';
  if (p === 'codex') return 'codex-rollout';
  return 'latency';
}

/** The hook events that carry the block for an injection provider (AGY has no
 *  UserPromptSubmit; its PreInvocation fires before every model call). */
export function mailSurfaceEvents(provider: AgentProvider | undefined): ReadonlySet<string> {
  return (provider ?? 'claude') === 'antigravity' ? AGY_EVENTS : CLAUDE_CODEX_EVENTS;
}
const AGY_EVENTS: ReadonlySet<string> = new Set(['PreInvocation']);
const CLAUDE_CODEX_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'PostToolUse']);

/** §11.1: the latest a response may leave the harness and still count as delivered. */
export function mailLatencyLimitMs(transport: string | undefined): number {
  return transport === 'http' || transport === 'mcp' ? MAIL_HTTP_LATENCY_LIMIT_MS : MAIL_PIPE_LATENCY_LIMIT_MS;
}

/** §11.6: never surface into a slash-command prompt (`/compact`, any built-in command). */
export function isSlashPrompt(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith('/');
}

// ————————————————————————————————————————————————————————————— the block (§2.1, §11.2)

/** The evidence marker for one id (only ever written next to that id's body). */
export function mailMarker(id: string): string {
  return `hive-mail:${escapeMailText(id)}`;
}

/** Sender-controlled text: cannot close a tag and cannot forge a marker. */
export function escapeMailText(s: unknown): string {
  const str = typeof s === 'string' ? s : s === undefined || s === null ? '' : (JSON.stringify(s) ?? String(s));
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/hive-mail:/gi, (m) => `${m.slice(0, -1)}&#58;`);
}

/** §11.2: what is left for mail once the other contexts are joined ('\n\n' separators). */
export function mailBudgetFor(others: Array<string | null | undefined>): number {
  const parts = others.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (!parts.length) return MAIL_JOINED_BUDGET;
  // + 2: the separator between the others and the mail block.
  return MAIL_JOINED_BUDGET - (parts.join('\n\n').length + 2);
}

export interface MailBlockItem {
  entry: MailEntry;
  /** The message body as read from the inbox file. */
  body: string;
  /** The full inbox file path, named when the body is truncated. */
  path: string;
  /** READS-MAIL-CAP: show at most about this many body characters plus the paths (0/unset = whole). */
  cap?: number;
}

export interface MailBlockInput {
  items: MailBlockItem[];
  /** The mail budget for this hook (`mailBudgetFor`). */
  budget: number;
  /** turn-start (UserPromptSubmit, AGY's first PreInvocation), mid-turn (P6 wording), or compact
   *  (§11.5: the SessionStart `compact` re-injection of mail already surfaced in this turn). */
  phase: 'turn-start' | 'mid-turn' | 'compact';
  /** Option B piggyback: open obligations; only shown when the block carries mail anyway. */
  reminders?: MailObligation[];
  /** Pending mail whose body was not read because it cannot fit this hook anyway (bounded work
   *  per hook): always deferred, counted in the "will follow" line, listed in headers-only mode. */
  more?: MailEntry[];
  /** Q11 (god's ruling): ids that already held the block back at an earlier hook. If they still do
   *  not fit, they are passed over so that smaller later mail is not blocked for a second hook. */
  skippable?: ReadonlySet<string>;
}

export interface MailBlock {
  /** The block, or null when nothing fits (or nothing is pending). */
  text: string | null;
  /** Ids whose whole entry, or deliberate truncation, is in `text`: the ones to claim. */
  surfacing: string[];
  /** The subset of `surfacing` that was truncated (first MAIL_TRUNCATE_CHARS + path). */
  truncated: string[];
  /** Q22 (Creed): the subset of `truncated` shown as header + path only, because even this hook's
   *  whole budget leaves under MAIL_TRUNCATE_MIN_CHARS for the body. The caller logs `mail-truncated`. */
  pathOnly: string[];
  /** READS-MAIL-CAP: the subset of `surfacing` shortened by its cap (not by the budget). */
  capped: string[];
  /** Ids named by header only (no body, no marker): they stay delivered. */
  headersOnly: string[];
  /** Ids not in the block at all: they stay delivered and drip into a later hook. */
  deferred: string[];
  /** Q11: the group that did not fit and held back everything after it at THIS hook (the caller
   *  passes it back as `skippable` next time). Empty when nothing was held back. */
  blocked: string[];
}

const EMPTY: MailBlock = { text: null, surfacing: [], truncated: [], pathOnly: [], capped: [], headersOnly: [], deferred: [], blocked: [] };

function flagsOf(e: MailEntry): string[] {
  const out: string[] = [];
  if (e.requiresReply) out.push('(reply expected)');
  if (e.supersedes?.length) out.push(`(SUPERSEDES ${escapeMailText(e.supersedes.join(', '))})`);
  return out;
}

function renderItem(it: MailBlockItem, truncate: boolean, keep = MAIL_TRUNCATE_CHARS, pathOnly = false): string {
  const e = it.entry;
  const lines: string[] = [];
  lines.push(`[${mailMarker(e.id)}] from: ${escapeMailText(e.from)} | act: ${escapeMailText(e.act)} | subject: "${escapeMailText(e.subject)}"`);
  const meta: string[] = [];
  if (e.conversation) meta.push(`conversation: ${escapeMailText(e.conversation)}`);
  if (e.inReplyTo) meta.push(`in_reply_to: ${escapeMailText(e.inReplyTo)}`);
  meta.push(...flagsOf(e));
  if (meta.length) lines.push(meta.join(' | '));
  if (e.redelivered) lines.push('(re-delivered: this may already have been handled — check before acting)');
  if (e.legacy && e.surfacedAt == null) lines.push('(delivered before 1.1.75; may already have been handled)');
  const body = escapeMailText(it.body);
  if (pathOnly) {
    lines.push('', `[body not shown: ${body.length} characters do not fit this hook. The full message is in ${whereText(it.path)}; read it there]`);
  } else if (truncate) {
    const cut = mailCapCut(body, it.cap);
    const k = cut === null ? keep : Math.min(keep, cut);
    lines.push('', `${body.slice(0, Math.max(0, k))}`, `[... truncated: ${body.length} characters in total. The full message is in ${whereText(it.path)}]`);
  } else {
    const cut = mailCapCut(body, it.cap);
    if (cut === null) lines.push('', body);
    else lines.push('', body.slice(0, cut), `[... shortened: ${body.length} characters in total. Read the rest in ${whereText(it.path)} when you need it]`);
  }
  return lines.join('\n');
}

/** READS-MAIL-CAP: is this item shown shortened by its cap? */
function isCapped(it: MailBlockItem): boolean {
  return mailCapCut(escapeMailText(it.body), it.cap) !== null;
}

function headerLine(e: MailEntry): string {
  const flags = flagsOf(e);
  return `- [${escapeMailText(e.id)}] from ${escapeMailText(e.from)}: "${escapeMailText(e.subject.slice(0, 160))}"${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

function ageText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function reminderLines(reminders: MailObligation[], exclude: Set<string>): string[] {
  const seen = new Set<string>();
  const rows: MailObligation[] = [];
  for (const r of reminders) {
    const e = r.entry;
    // Only obligations the agent has already SEEN (surfacing / surfaced / acted); unseen mail is
    // the block itself or its "will follow" line.
    if (seen.has(e.id) || exclude.has(e.id) || e.state === 'delivered') continue;
    seen.add(e.id);
    rows.push(r);
  }
  if (!rows.length) return [];
  const shown = rows.slice(0, MAIL_REMINDER_MAX).map((r) => {
    const e = r.entry;
    const what = e.act === 'request' ? 'request' : 'reply expected';
    return `- [${escapeMailText(e.id)}] from ${escapeMailText(e.from)}: "${escapeMailText(e.subject.slice(0, 120))}" (${what}, ${ageText(r.ageMs)} ago)`;
  });
  if (rows.length > shown.length) shown.push(`- and ${rows.length - shown.length} more`);
  return ['Still open (no reply routed yet):', ...shown];
}

function assemble(phase: MailBlockInput['phase'], rendered: string[], deferred: MailEntry[], reminders: string[]): string {
  const n = rendered.length;
  const head = phase === 'mid-turn'
    ? `${n} new message(s) arrived during this turn. Consider these before you send or finish: one may change or cancel what you are doing.`
    : phase === 'compact'
      ? `Your context was compacted. ${n} message(s) you already received in this turn, again in full, oldest first:`
      : `Hive mail for you: ${n} message(s), oldest first. The full text of each is below.`;
  const parts: string[] = ['<hive-mail>', head, '', rendered.join('\n\n---\n\n')];
  if (deferred.length) {
    const named = deferred.slice(0, DEFERRED_NAMED_MAX).map((e) => `[${escapeMailText(e.id)}]`).join(', ');
    parts.push('', `${deferred.length} more message(s) will follow at a later hook: ${named}${deferred.length > DEFERRED_NAMED_MAX ? ', ...' : ''}`);
  }
  if (reminders.length) parts.push('', ...reminders);
  parts.push('</hive-mail>');
  return parts.join('\n');
}

/** Headers only (§11.2 small budget, or the Claude PreToolUse peek): no body, no marker. */
export function buildMailHeaders(entries: MailEntry[], budget: number, lead?: string): { text: string | null; ids: string[] } {
  if (!entries.length || budget <= 0) return { text: null, ids: [] };
  const intro = lead ?? `${entries.length} message(s) are waiting; their text follows at a later hook:`;
  const open = `<hive-mail>\n${intro}\n`;
  const close = '</hive-mail>';
  let text = open;
  const ids: string[] = [];
  for (const e of entries) {
    const line = `${headerLine(e)}\n`;
    const more = entries.length - ids.length - 1;
    const tail = more > 0 ? `- and ${more} more\n` : '';
    if ((text + line + tail + close).length > budget) {
      if (!ids.length) return { text: null, ids: [] };
      const rest = entries.length - ids.length;
      const restLine = `- and ${rest} more\n`;
      if ((text + restLine + close).length <= budget) text += restLine;
      break;
    }
    text += line;
    ids.push(e.id);
  }
  const out = text + close;
  return out.length <= budget ? { text: out, ids } : { text: null, ids: [] };
}

/** Oldest first; a superseding message joins the group of the pending message it supersedes. */
function groupItems(items: MailBlockItem[]): MailBlockItem[][] {
  const sorted = [...items].sort((a, b) => a.entry.seq - b.entry.seq);
  const groupOf = new Map<string, MailBlockItem[]>();
  const groups: MailBlockItem[][] = [];
  const byRef = new Map<string, MailBlockItem>();
  for (const it of sorted) {
    byRef.set(it.entry.id, it);
    if (it.entry.senderId && !byRef.has(it.entry.senderId)) byRef.set(it.entry.senderId, it);
  }
  for (const it of sorted) {
    let target: MailBlockItem[] | undefined;
    for (const ref of it.entry.supersedes ?? []) {
      const old = byRef.get(ref);
      if (old && old !== it && old.entry.seq < it.entry.seq) { target = groupOf.get(old.entry.id); if (target) break; }
    }
    if (target) { target.push(it); groupOf.set(it.entry.id, target); continue; }
    const g = [it];
    groups.push(g);
    groupOf.set(it.entry.id, g);
  }
  return groups;
}

/**
 * The `<hive-mail>` block for one hook. Oldest first (supersede pairs kept together), strictly
 * inside `budget`: the first group that does not fit stops the block (later mail does not overtake
 * earlier mail at that hook); what is left is deferred and drips into a later hook. Q11: a group
 * that already held the block back at an earlier hook (`skippable`) and still does not fit is passed
 * over instead, so a big message never blocks smaller later ones for more than one hook.
 * A message too large for the WHOLE budget is truncated to fit what is left (Jim audit #3): its
 * header, as much of its body as fits (at most MAIL_TRUNCATE_CHARS, at least
 * MAIL_TRUNCATE_MIN_CHARS) and the path of the full file. Q22: under that floor it waits for the
 * next hook's fresh budget; when even this hook's whole budget leaves under the floor, it surfaces
 * as its header + the path only (`pathOnly`, logged `mail-truncated`). Under MAIL_HEADERS_ONLY_BELOW, or when
 * nothing fits, the block names headers only and nothing is surfacing.
 */
export function buildMailBlock(input: MailBlockInput): MailBlock {
  const sorted = input.items.slice().sort((a, b) => a.entry.seq - b.entry.seq);
  const items = sorted.slice(0, MAIL_BLOCK_MAX_ITEMS);
  const inItems = new Set(items.map((i) => i.entry.id));
  const more = [...sorted.slice(MAIL_BLOCK_MAX_ITEMS).map((i) => i.entry), ...(input.more ?? []).filter((e) => !inItems.has(e.id))]
    .sort((a, b) => a.seq - b.seq);
  const everything = [...items.map((i) => i.entry), ...more];
  if (!everything.length || input.budget <= 0) return { ...EMPTY, deferred: everything.map((e) => e.id) };
  const budget = input.budget;
  type Chosen = { it: MailBlockItem; text: string; truncated: boolean; pathOnly?: boolean };
  const chosen: Chosen[] = [];
  const blocked: string[] = [];
  const headersOnly = (): MailBlock => {
    const h = buildMailHeaders(everything, budget);
    return { text: h.text, surfacing: [], truncated: [], pathOnly: [], capped: [], headersOnly: h.ids, deferred: everything.map((e) => e.id).filter((id) => !h.ids.includes(id)), blocked };
  };
  if (!items.length) return headersOnly();
  if (budget < MAIL_HEADERS_ONLY_BELOW) return headersOnly();

  /** Everything not in the block: the "will follow" line. */
  const remaining = (list: Chosen[]): MailEntry[] => {
    const inBlock = new Set(list.map((c) => c.it.entry.id));
    return [...items.map((x) => x.entry).filter((e) => !inBlock.has(e.id)), ...more];
  };
  const sizeOf = (list: Chosen[]): number => assemble(input.phase, list.map((c) => c.text), remaining(list), []).length;
  const fits = (list: Chosen[]): boolean => sizeOf(list) <= budget;
  /** One message placed after `list`: whole when it fits; truncated to what is left when it can
   *  never fit the whole budget; null when it must wait for a later hook. */
  const place = (it: MailBlockItem, list: Chosen[]): Chosen | null => {
    const full = renderItem(it, false);
    const whole: Chosen = { it, text: full, truncated: false };
    if (fits([...list, whole])) return whole;
    if (assemble(input.phase, [full], [], []).length <= budget) return null;   // fits a later hook whole
    const bodyLen = escapeMailText(it.body).length;
    const overhead = sizeOf([...list, { it, text: renderItem(it, true, 0), truncated: true }]);
    const keep = Math.min(MAIL_TRUNCATE_CHARS, bodyLen - 1, budget - overhead);
    if (keep < MAIL_TRUNCATE_MIN_CHARS) {
      // Q22 (Creed): under the floor after what is already placed. If this hook's whole budget
      // (the message first, nothing before it) would leave the floor, it waits for the next hook's
      // fresh budget. If even that leaves under the floor, it surfaces as header + path only.
      // "Fresh" = this hook's budget with the message placed first (the rest named as following).
      const aloneKeep = Math.min(MAIL_TRUNCATE_CHARS, bodyLen - 1, budget - sizeOf([{ it, text: renderItem(it, true, 0), truncated: true }]));
      if (aloneKeep >= MAIL_TRUNCATE_MIN_CHARS) return null;
      const bare: Chosen = { it, text: renderItem(it, true, 0, true), truncated: true, pathOnly: true };
      return fits([...list, bare]) ? bare : null;
    }
    const cut: Chosen = { it, text: renderItem(it, true, keep), truncated: true };
    return fits([...list, cut]) ? cut : null;
  };

  const groups = groupItems(items);
  const skippable = input.skippable ?? new Set<string>();
  for (const g of groups) {
    // The group as a whole (supersede pairs together) ...
    const trial: Chosen[] = [...chosen];
    let whole = true;
    for (const it of g) {
      const c = place(it, trial);
      if (!c) { whole = false; break; }
      trial.push(c);
    }
    if (whole) { chosen.splice(0, chosen.length, ...trial); continue; }
    // ... or, for a pair that can never fit together at this budget, member by member.
    const pairFitsSomeHook = g.length > 1 && assemble(input.phase, g.map((it) => renderItem(it, false)), [], []).length <= budget;
    let placed = 0;
    if (g.length > 1 && !pairFitsSomeHook) {
      for (const it of g) {
        const c = place(it, chosen);
        if (!c) break;
        chosen.push(c);
        placed++;
      }
      if (placed === g.length) continue;
    }
    const rest = g.slice(placed).map((it) => it.entry.id);
    // Q11: it held the block back at an earlier hook already: pass over it this time.
    if (rest.some((id) => skippable.has(id))) continue;
    blocked.push(...rest);
    break;
  }
  // Defensive: never exceed the budget (fits() already guarantees it for the chosen list).
  while (chosen.length && sizeOf(chosen) > budget) chosen.pop();
  if (!chosen.length) return headersOnly();
  const chosenIds = new Set(chosen.map((c) => c.it.entry.id));
  const deferred = [...items.map((i) => i.entry).filter((e) => !chosenIds.has(e.id)), ...more];
  const texts = chosen.map((c) => c.text);
  let text = assemble(input.phase, texts, deferred, []);
  const rem = reminderLines(input.reminders ?? [], new Set([...chosenIds, ...deferred.map((e) => e.id)]));
  if (rem.length) {
    // Reminders are the lowest priority: drop lines from the end until they fit, or drop them all.
    for (let k = rem.length; k > 1; k--) {
      const withRem = assemble(input.phase, texts, deferred, rem.slice(0, k));
      if (withRem.length <= budget) { text = withRem; break; }
    }
  }
  return {
    text,
    surfacing: chosen.map((c) => c.it.entry.id),
    truncated: chosen.filter((c) => c.truncated).map((c) => c.it.entry.id),
    pathOnly: chosen.filter((c) => c.pathOnly).map((c) => c.it.entry.id),
    capped: chosen.filter((c) => !c.truncated && isCapped(c.it)).map((c) => c.it.entry.id),
    headersOnly: [],
    deferred: deferred.map((e) => e.id),
    blocked
  };
}

// ————————————————————————————————————————————————————————————— evidence (§11.1)

/**
 * Ids whose marker appears in a DELIVERY record of `text` (JSONL):
 *  - Claude: a record whose `attachment.type` is `hook_additional_context`;
 *  - Codex: a `response_item` whose payload is a developer-role message.
 * Only lines holding a marker are parsed; a partial last line is ignored (retried next scan).
 */
export function mailEvidenceIn(text: string, ids: Iterable<string>, kind: MailEvidenceKind): Set<string> {
  const found = new Set<string>();
  if (kind === 'latency' || !text) return found;
  const want = new Map<string, string>();
  for (const id of ids) want.set(`[${mailMarker(id)}]`, id);
  if (!want.size) return found;
  for (const line of text.split('\n')) {
    if (!line.includes('hive-mail:')) continue;
    const hits = [...want.keys()].filter((m) => line.includes(m));
    if (!hits.length) continue;
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!isDeliveryRecord(rec, kind)) continue;
    for (const m of hits) { found.add(want.get(m)!); want.delete(m); }
    if (!want.size) break;
  }
  return found;
}

function isDeliveryRecord(rec: unknown, kind: MailEvidenceKind): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  if (kind === 'claude-transcript') {
    const a = r.attachment as Record<string, unknown> | undefined;
    return !!a && typeof a === 'object' && a.type === 'hook_additional_context';
  }
  const p = r.payload as Record<string, unknown> | undefined;
  return r.type === 'response_item' && !!p && typeof p === 'object' && p.role === 'developer';
}

/** Read up to `maxBytes` of `file` from `from` (bounded; null on any error). */
export function readFileWindow(file: string, from: number, maxBytes = MAIL_EVIDENCE_SCAN_MAX_BYTES): { text: string; size: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.min(from, size));
    const len = Math.max(0, Math.min(maxBytes, size - start));
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.subarray(0, off).toString('utf8'), size };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* noop */ } }
  }
}
