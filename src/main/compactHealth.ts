/**
 * READS-ROTATE-AT-SIZE pilot (1.1.81): one `compact-health` log row per compaction, so
 * READS-COMPACT-HEALTH and reads-measure can judge the pilot. A SessionStart(compact) marks the
 * agent; at its next Stop the transcript tail is read once, and EVERY compaction not logged yet
 * (Claude's own compact_boundary: trigger, context before and after, duration; one turn can hold
 * several) is logged with the first request after it (its context and what it cost). Logged once
 * per boundary; a tail whose last boundary has no request after it yet is retried at the next
 * Stop, at most COMPACT_HEALTH_TRIES times.
 *
 * Probed on Claude Code 2.1.288 (CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000, Haiku): PreCompact(auto),
 * SessionStart(compact), PostCompact(auto) per compaction, three inside one turn, each at ~75k
 * (Claude keeps a margin below the window), trigger "auto" (t12/probe181/probe-compact.cjs).
 *
 * READS-COMPACT-HEALTH (1.1.83), the safety net for the rollout. The SessionStart(compact) hook
 * carries the agent's cards in progress and open obligations back in (`compactCarryText`), and
 * re-injects this turn's open mail (hooks.ts reinjectMail). `noteCarry` records what was carried;
 * the row then CHECKS it at the Stop:
 *  - mail: every open id is back (acted, or surfaced again since the compaction), or `pending`
 *    (delivered: it drips in at the next hook), else `mailMissing`;
 *  - cards: the cards in progress, and which of them the summary itself lost (`cardsNotInSummary`;
 *    the carry line brings them back either way);
 *  - cost: the summary's size at 2.5 characters per token, the idle before the compaction and
 *    whether that idle outlived the 1-hour cache (then the compaction re-writes the context);
 *  - `n`: compactions of this agent since the app started.
 * After each compaction a `compact-rereads` row counts what the agent read again in the next
 * COMPACT_REREAD_TURNS turns: files it had already read before the compaction (Read tool), and
 * inbox files (the rest of a shortened message).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { CACHE_TTL_MS, SUMMARY_CHARS_PER_TOKEN, compactHealthsFromTail } from '../shared/autoCompactWindow';

export const COMPACT_TAIL_BYTES = 1024 * 1024;
export const COMPACT_HEALTH_TRIES = 3;
/** Clock skew allowed between the app and a boundary's timestamp (n2). */
export const COMPACT_SKEW_MS = 5_000;
/** The turns (Stops) after a compaction whose reads are counted in its `compact-rereads` row. */
export const COMPACT_REREAD_TURNS = 3;
/** The most read paths remembered per agent (oldest dropped first). */
export const COMPACT_READ_MEMORY = 2_000;
/** The carry note's most characters (it shares the hook's joined budget with the mail). */
export const COMPACT_CARRY_MAX = 1_500;

/** The last `bytes` of a file as text, or null. */
export function readTail(file: string, bytes = COMPACT_TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** A card in progress, as the carry note names it. */
export interface CarryCard { id: string; title: string }
/** An open obligation (a request to answer, a reply owed), as the carry note names it. */
export interface CarryObligation { id: string; from: string; subject: string; what: string }

/**
 * The `<after-compaction>` note for a SessionStart(compact): the agent's cards in progress and the
 * mail it still owes an answer to, headers only, inside COMPACT_CARRY_MAX. Null when there is none.
 */
export function compactCarryText(cards: CarryCard[], obligations: CarryObligation[], max = COMPACT_CARRY_MAX): { text: string | null; cards: string[]; obligations: string[] } {
  if (!cards.length && !obligations.length) return { text: null, cards: [], obligations: [] };
  const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/hive-mail:/gi, (m) => `${m.slice(0, -1)}&#58;`);
  const head = ['<after-compaction>', 'Your context was just compacted. Still yours (from the board and the mail ledger, not from the summary):'];
  const tail = '</after-compaction>';
  const lines = [...head];
  const shownCards: string[] = [];
  const shownObl: string[] = [];
  const fits = (extra: string[]): boolean => [...lines, ...extra, tail].join('\n').length <= max;
  const cardLines = cards.map((c) => ({ id: c.id, line: `- card ${esc(c.id)}: "${esc(c.title.slice(0, 120))}" (in progress)` }));
  const oblLines = obligations.map((o) => ({ id: o.id, line: `- [${esc(o.id)}] from ${esc(o.from)}: "${esc(o.subject.slice(0, 120))}" (${esc(o.what)})` }));
  for (const [list, shown, label] of [[cardLines, shownCards, 'Cards in progress:'], [oblLines, shownObl, 'Mail you still owe an answer:']] as const) {
    if (!list.length) continue;
    let first = true;
    for (const x of list) {
      const add = first ? [label, x.line] : [x.line];
      if (!fits(add)) break;
      lines.push(...add);
      shown.push(x.id);
      first = false;
    }
    const left = list.length - shown.length;
    if (left > 0 && fits([`- and ${left} more`])) lines.push(`- and ${left} more`);
  }
  if (!shownCards.length && !shownObl.length) return { text: null, cards: [], obligations: [] };
  lines.push(tail);
  return { text: lines.join('\n'), cards: shownCards, obligations: shownObl };
}

/** What a SessionStart(compact) carried back in (hooks.ts), checked at the Stop. */
export interface CompactCarry {
  /** The agent's cards in progress, and those named in the carry note. */
  cardsDoing: string[];
  cardsCarried: string[];
  /** Open obligations, and those named in the carry note. */
  obligationsOpen: number;
  obligationsCarried: number;
  /** This turn's open mail (surfacing/surfaced) when it compacted, and the ids re-injected. */
  mailOpen: string[];
  mailReinjected: string[];
}

/** A mail id's ledger state, for the check. */
export interface MailStateLite { state: string; surfacingAt?: number | null; surfacedAt?: number | null; actedAt?: number | null }

interface Rereads { at: string | null; since: number; turns: number; reads: number; rereads: number; inboxReads: number; before: Set<string> }

export class CompactHealthWatch {
  private readonly pending = new Map<string, { path: string; tries: number; since: number }>();
  private readonly logged = new Map<string, Set<string>>();
  private readonly carries = new Map<string, Array<CompactCarry & { at: number }>>();
  private readonly counts = new Map<string, number>();
  private readonly reads = new Map<string, Set<string>>();
  private readonly rereads = new Map<string, Rereads>();

  constructor(private readonly d: {
    log: (row: Record<string, unknown>) => void;
    readTail?: (file: string) => string | null;
    now?: () => number;
    /** The agent's configured window (tokens), when the pilot set one. */
    windowOf?: (agentId: string) => number | null;
    /** READS-COMPACT-HEALTH: a mail id's ledger state now (null when unknown). */
    mailStateOf?: (agentId: string, id: string) => MailStateLite | null;
  }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** SessionStart with source "compact". Several in one turn keep the FIRST one's time, so every
   *  boundary of this turn counts as new. */
  noteCompact(agentId: string, transcriptPath: string | null | undefined): void {
    this.startRereads(agentId, null);
    if (!transcriptPath) return;
    const since = this.pending.get(agentId)?.since ?? (this.d.now ?? Date.now)();
    this.pending.set(agentId, { path: transcriptPath, tries: 0, since });
  }

  /** READS-COMPACT-HEALTH: what that SessionStart(compact) carried back in. */
  noteCarry(agentId: string, carry: CompactCarry): void {
    const list = this.carries.get(agentId) ?? [];
    list.push({ ...carry, at: this.now() });
    while (list.length > 10) list.shift();
    this.carries.set(agentId, list);
  }

  /** A file the agent read (the Read tool's path, or an inbox file a command read). */
  noteRead(agentId: string, file: string, inbox = false): void {
    const key = normPath(file);
    if (!key) return;
    const w = this.rereads.get(agentId);
    if (w) {
      w.reads += 1;
      if (w.before.has(key)) w.rereads += 1;
      if (inbox || /[\\/]inbox[\\/]/i.test(file)) w.inboxReads += 1;
    }
    const seen = this.reads.get(agentId) ?? new Set<string>();
    seen.delete(key);
    seen.add(key);
    while (seen.size > COMPACT_READ_MEMORY) seen.delete(seen.values().next().value as string);
    this.reads.set(agentId, seen);
  }

  /** A new compaction closes the previous re-read window (logged) and opens one. */
  private startRereads(agentId: string, at: string | null): void {
    this.flushRereads(agentId);
    this.rereads.set(agentId, { at, since: this.now(), turns: 0, reads: 0, rereads: 0, inboxReads: 0, before: new Set(this.reads.get(agentId) ?? []) });
  }

  private flushRereads(agentId: string): void {
    const w = this.rereads.get(agentId);
    if (!w) return;
    this.rereads.delete(agentId);
    if (!w.reads) return;   // nothing read in the window: nothing to report
    try {
      this.d.log({ kind: 'compact-rereads', agentId, compactAt: w.at, turns: w.turns, reads: w.reads, rereads: w.rereads, inboxReads: w.inboxReads });
    } catch { /* best effort */ }
  }

  /** A Stop of the agent: log every compaction not logged yet (one turn can hold several), once
   *  the request after the LAST of them is in the transcript (or after COMPACT_HEALTH_TRIES). */
  onStop(agentId: string): void {
    this.healthAtStop(agentId);
    // The compaction's own turn is the first of its re-read window.
    const w = this.rereads.get(agentId);
    if (w) {
      w.turns += 1;
      if (w.turns >= COMPACT_REREAD_TURNS) this.flushRereads(agentId);
    }
  }

  private healthAtStop(agentId: string): void {
    const p = this.pending.get(agentId);
    if (!p) return;
    p.tries += 1;
    const tail = (this.d.readTail ?? readTail)(p.path);
    const all = tail ? compactHealthsFromTail(tail) : [];
    const last = all[all.length - 1];
    if (!last || (!last.first && p.tries < COMPACT_HEALTH_TRIES)) {
      if (p.tries >= COMPACT_HEALTH_TRIES) { this.pending.delete(agentId); this.carries.delete(agentId); }
      return;
    }
    this.pending.delete(agentId);
    const seen = this.logged.get(agentId) ?? new Set<string>();
    let window: number | null = null;
    try { window = this.d.windowOf?.(agentId) ?? null; } catch { window = null; }
    const fresh: typeof all = [];
    for (const h of all) {
      if (seen.has(h.uuid)) continue;
      // n2 (Creed): the logged set lives in memory, so after an app restart an OLDER boundary still
      // in the tail would be logged again and inflate the pilot's numbers. Only boundaries written
      // since the SessionStart(compact) that armed this read count. Claude stamps a boundary ~250 ms
      // after that SessionStart (probe); one without a time counts only if it is the last.
      const t = h.at ? Date.parse(h.at) : NaN;
      if (Number.isFinite(t) ? t < p.since - COMPACT_SKEW_MS : h !== last) continue;
      seen.add(h.uuid);
      fresh.push(h);
    }
    // The carries pair with the boundaries from the end (one SessionStart(compact) per boundary).
    const carries = this.carries.get(agentId) ?? [];
    this.carries.delete(agentId);
    const off = carries.length - fresh.length;
    fresh.forEach((h, k) => {
      const n = (this.counts.get(agentId) ?? 0) + 1;
      this.counts.set(agentId, n);
      const carry = carries[off + k];
      const summaryChars = typeof h.summary === 'string' ? h.summary.length : null;
      const idle = h.idleBeforeMs ?? null;
      const cacheRewrite = idle !== null ? idle > CACHE_TTL_MS : null;
      try {
        this.d.log({
          kind: 'compact-health', agentId, trigger: h.trigger, window, at: h.at,
          preTokens: h.preTokens, postTokens: h.postTokens, durationMs: h.durationMs,
          firstRequest: h.first,
          n,
          summaryChars,
          summaryTokensEst: summaryChars === null ? null : Math.round(summaryChars / SUMMARY_CHARS_PER_TOKEN),
          // ESTIMATES (Creed n2/n3): idle runs from the last main-chain assistant record, so a long
          // tool run before an auto-compaction also counts; the re-write cost assumes the whole
          // pre-compaction context was cached (an upper bound).
          idleBeforeMs: idle,
          cacheRewrite,
          compactCostEst: h.preTokens === null || cacheRewrite === null ? null : Math.round(h.preTokens * (cacheRewrite ? 2 : 0.1)),
          ...this.check(agentId, carry, h.summary ?? null)
        });
      } catch { /* best effort */ }
      if (k === fresh.length - 1) { const r = this.rereads.get(agentId); if (r && r.at === null) r.at = h.at; }
    });
    // Bounded: only recent boundaries can reappear in a tail.
    while (seen.size > 50) seen.delete(seen.values().next().value as string);
    this.logged.set(agentId, seen);
  }

  /** The came-back check for one compaction (null fields when no carry was recorded). */
  private check(agentId: string, carry: (CompactCarry & { at: number }) | undefined, summary: string | null): Record<string, unknown> {
    if (!carry) return { carry: false, ok: null };
    const back: string[] = [];
    const pendingIds: string[] = [];
    const missing: string[] = [];
    for (const id of carry.mailOpen) {
      let s: MailStateLite | null = null;
      try { s = this.d.mailStateOf?.(agentId, id) ?? null; } catch { s = null; }
      const since = carry.at - COMPACT_SKEW_MS;
      if (s && (s.state === 'acted' || (s.surfacingAt ?? 0) >= since || (s.surfacedAt ?? 0) >= since)) back.push(id);
      else if (s && s.state === 'delivered') pendingIds.push(id);
      else missing.push(id);
    }
    const cardsNotInSummary = summary === null ? null : carry.cardsDoing.filter((id) => !summary.includes(id));
    const cardsLost = carry.cardsDoing.filter((id) => !carry.cardsCarried.includes(id) && (cardsNotInSummary === null || cardsNotInSummary.includes(id)));
    return {
      carry: true,
      mailOpen: carry.mailOpen.length, mailReinjected: carry.mailReinjected.length, mailBack: back.length,
      mailPending: pendingIds, mailMissing: missing,
      cardsDoing: carry.cardsDoing, cardsCarried: carry.cardsCarried.length, cardsNotInSummary, cardsLost,
      obligationsOpen: carry.obligationsOpen, obligationsCarried: carry.obligationsCarried,
      // Creed n1: owed mail past the note's cap is named as "and N more" and stays in the ledger and
      // the reminders, so it is never lost: counted here, not held against ok.
      carryTruncated: Math.max(0, carry.obligationsOpen - carry.obligationsCarried),
      ok: missing.length === 0 && cardsLost.length === 0
    };
  }
}

/** The file a finished tool call read, for the re-read count: the Read tool's `file_path`, or an
 *  inbox message file named in a shell command (reading the rest of a shortened message). */
export function readPathOf(toolName: unknown, toolInput: unknown): { path: string; inbox: boolean } | null {
  const inp = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  if (toolName === 'Read') {
    const f = inp.file_path;
    return typeof f === 'string' && f ? { path: f, inbox: /[\\/]inbox[\\/]/i.test(f) } : null;
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = typeof inp.command === 'string' ? inp.command : '';
    const m = /[^\s"'`]*[\\/]inbox[\\/](?:\.done[\\/])?[^\s"'`\\/]+\.json/i.exec(cmd);
    return m ? { path: m[0], inbox: true } : null;
  }
  return null;
}

/** A path as a set key: forward slashes, lower case (Windows paths are case-insensitive). */
function normPath(p: string): string {
  return typeof p === 'string' ? p.trim().replace(/\\/g, '/').toLowerCase() : '';
}
