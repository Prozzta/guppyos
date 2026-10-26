/**
 * NATIVE-MEMORY section 6: the `memory` command's text. `search` prints ranked hits;
 * `wake-up` follows the section-4 CONTENT contract in its frame (the "Wake-up text (~N
 * tokens):" header and the L0/L1 headings). PINNED-MEMORY adds an L0.5 block between them: the
 * agent's `## How I work (standing lessons)` section, verbatim, on its own budget.
 */
import type { SearchHit } from './store';
import { PINNED_SOFT_CAP_BYTES } from '../memoryRollover';
import { ordinal } from './sources';

/** Step 3 fix R2 (god bbcb4a): per card id (lower-cased), the `field: value` items of its current values (main's
 *  resolver, the same values `memory get <id>` leads with); a hit on the card prints them inline. */
export type CardLeads = Record<string, string[]>;

export interface SearchFlags {
  wing?: string | null;
  room?: string | null;
  since?: string | null;
  before?: string | null;
  /** CLAIMS-90 M1: `--full` prints the whole-chunk (verbose) text; the default is the compact text. */
  full?: boolean;
  /** CLAIMS-90 R2 (C90-GET): `--exact` (an exact-text scan, no ranking by meaning) and `--newest` (newest first, [1] the answer candidate). */
  exact?: boolean;
  newest?: boolean;
  /** Step 3 fix R2: the card briefs (`<id>` → `field: value` items) the hits carry; set by formatSearch from its `leads`. */
  cardLeads?: CardLeads;
  /** S3 (god 7a4eec): the terms (card ids, release keys) the QUERY named: their briefs print above the hits. */
  namedCards?: string[];
  /** M1 (god 5dc648): every other card or release the hits name or are keyed to: one `memory get` pointer line each, above the hits. */
  pointedCards?: string[];
}

/**
 * CLAIMS-90 M1: the compact `search` / `wake-up` text fits UNDER the tool-output condenser's
 * 1500-character default cap by construction (toolOutputCondense TOOL_OUTPUT_CAP_DEFAULT), so an
 * agent reads the whole answer, current values first, instead of a head/tail cut of the verbose
 * text. `--full` restores the verbose text (and `#full` on the command still skips the condenser).
 */
export const COMPACT_MAX_CHARS = 1400;
/** One compact line stays under the condenser's LINE_MAX (160) so no line is ever clipped. */
export const COMPACT_LINE_MAX = 158;
/** CLAIMS-90 R2 step 2 (Jim 595cc6): the one `get:` footer line, OUTSIDE the hit budget so the pointer costs no hit a
 *  character; COMPACT_MAX_CHARS + this stays under the condenser cap (1500). Includes its newline. */
export const COMPACT_GET_MAX = 96;
/** The native part of a compact wake-up; the rest of COMPACT_MAX_CHARS is the claims working set's. */
export const WAKE_COMPACT_MAX_CHARS = 700;
/** A hit or an entry never gets less than this; what no longer fits goes behind `--results` / `--full`. */
const COMPACT_MIN_HIT = 120;
const COMPACT_MIN_ENTRY = 96;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

/** The compact status word: a confirmed supersession is `prior`, an unconfirmed one `prior?` (never shown as fact). */
function statusWord(status: string): string {
  return status === 'live' ? 'current' : status === 'superseded' ? 'prior' : status === 'superseded?' ? 'prior?' : status;
}
/** Current values first: live claims, then plain chunks, then prior / prior? / retracted claims; rank order within each group. */
/** The status group of a hit: current claims (0), then markdown (1), then prior / prior? claims (2). */
const statusGroup = (h: { claim?: SearchHit['claim'] }): number => (!h.claim ? 1 : h.claim.status === 'live' ? 0 : 2);

export function currentFirst<T extends { claim?: SearchHit['claim'] }>(hits: T[]): T[] {
  return hits.map((h, i) => ({ h, i })).sort((a, b) => statusGroup(a.h) - statusGroup(b.h) || a.i - b.i).map((x) => x.h);
}

/**
 * M3 (CLAIMS-90): the compact order. Current first (currentFirst), and inside each status group a hit the
 * query NAMES comes before one it does not: a query term that is the hit's whole claim key, a card id that is
 * a segment of it (`claims-90` names `card.claims-90`), its claim id, or a sha / version / card id (a
 * level-3 term) found in its content. A plain word never lifts, so a query that names nothing keeps the
 * order; a group never crosses another, so a prior is never lifted above the current value of its key.
 */
export function rankHits<T extends Pick<SearchHit, 'content' | 'claim'>>(query: string, hits: T[]): T[] {
  const terms = queryTerms(query);
  const named = (h: T): boolean => terms.some((t) => {
    const sp = termSpecificity(t);
    if (h.claim) {
      const key = (h.claim.key ?? '').toLowerCase();
      // M3 SHOULD 2: a dotted card id (cut-1.1.100) names `card.cut-1.1.100.*` by prefix, not by one segment.
      if (key && (key === t || (sp === 3 && (key.split('.').includes(t) || key === `card.${t}` || key.startsWith(`card.${t}.`))))) return true;
      if (h.claim.id.toLowerCase() === t) return true;
    }
    return sp === 3 && h.content.toLowerCase().includes(t);
  });
  return hits.map((h, i) => ({ h, i, n: named(h) ? 0 : 1, g: statusGroup(h) })).sort((a, b) => a.g - b.g || a.n - b.n || a.i - b.i).map((x) => x.h);
}

const base = (p: string): string => p.split('/').pop() ?? p;

/** CLAIMS-90 R2 (C90-GET, HISTORY-PTR g): the ready `memory get` lookup for a key. */
export const getPointer = (key: string): string => `memory get ${key}`;
/** The compact footer: `get: memory get <key>` for each distinct key shown, in printed order, while it fits COMPACT_GET_MAX. */
export function getFooter(keys: string[]): string | null {
  let line = '';
  for (const k of [...new Set(keys)]) {
    const next = line ? `${line} · ${getPointer(k)}` : `get: ${getPointer(k)}`;
    if (next.length + 1 > COMPACT_GET_MAX) break;
    line = next;
  }
  return line || null;
}

/** A hit's time for the newest-first order: its claim's date, else the chunk's filing time, else 0 (unknown: sorts last). */
export function hitTimeMs(h: Pick<SearchHit, 'claim' | 'filedAt'>): number {
  const t = h.claim?.at ? Date.parse(h.claim.at) : NaN;
  if (Number.isFinite(t)) return t;
  return typeof h.filedAt === 'number' && Number.isFinite(h.filedAt) ? h.filedAt : 0;
}

/**
 * CLAIMS-90 R2 (god ae1569): a PASSING reference. `term` occurs in `content` only inside the shapes that name an
 * OLD value: `replaced <X>`, `was <X>`, `previously <X>`, `<X> ->`, `from <X> to`, `<X> (was) replaced by|with`. A text
 * that states the term anywhere else (`replaced X with Y` states Y) is not passing. A shape rule over all text,
 * never a value list.
 */
export function passingOnly(content: string, term: string): boolean {
  const low = content.toLowerCase();
  const t = term.toLowerCase();
  let i = low.indexOf(t);
  if (i < 0) return false;
  while (i >= 0) {
    const before = low.slice(Math.max(0, i - 16), i);
    const after = low.slice(i + t.length, i + t.length + 24);
    const passing = /(?:^|[^a-z])(?:replaced|was|previously)\s+["'`(]?$/.test(before)
      || /^["'`)]?\s*(?:->|→|=>)/.test(after)
      || (/(?:^|[^a-z])from\s+["'`(]?$/.test(before) && /^["'`)]?\s+to\s/.test(after))
      || /^["'`)]?\s+(?:was\s+|is\s+)?replaced\s+(?:by|with)\s/.test(after);
    if (!passing) return false;
    i = low.indexOf(t, i + 1);
  }
  return true;
}

/**
 * CLAIMS-90 R2 (god ae1569, the Human's "walk back from now, stop at the first fit"): the newest-first order for
 * an unkeyed question. Only a hit the compact gate lets through takes part (a query term in its text, or a lexical
 * match: the same test the compact window anchors on), so age alone never lifts a hit that matches nothing; the
 * rest follow in rank order. Current claims and markdown share one group (a note can be the newest statement),
 * prior / prior? claims stay last. In a group a hit whose every matched specific term is a PASSING reference
 * (passingOnly) comes after the hits that state a term; then newest first; ties keep rank order.
 */
export function newestOrder<T extends Pick<SearchHit, 'content' | 'claim' | 'filedAt' | 'bm25'>>(query: string, hits: T[]): T[] {
  const specific = queryTerms(query).filter((t) => termSpecificity(t) === 3);
  const gated = (h: T): boolean => hasTerm(h.content, query) || h.bm25 !== null;
  const demoted = (h: T): number => {
    const matched = specific.filter((t) => h.content.toLowerCase().includes(t));
    return matched.length && matched.every((t) => passingOnly(h.content, t)) ? 1 : 0;
  };
  const group = (h: T): number => (h.claim && h.claim.status !== 'live' ? 1 : 0);
  return hits.map((h, i) => ({ h, i, gate: gated(h) ? 0 : 1, g: group(h), d: demoted(h), t: hitTimeMs(h) }))
    .sort((a, b) => a.gate - b.gate || (a.gate ? a.i - b.i : a.g - b.g || a.d - b.d || b.t - a.t || a.i - b.i))
    .map((x) => x.h);
}

/**
 * CLAIMS-90 M3a (layout probe, Jim's re-audit): a CURRENT (live) claim hit opens with ONE line
 * `<key>: <current value>` and its body continues where that line stops (no copy). The value is the claim
 * text; the `kind · key · date` header and `##` headings are dropped from it (the meta line carries them).
 * An unkeyed claim opens with its first sentence. A prior, prior? or markdown hit has no lead (null): a
 * `key: value` line on an old value would read as the current one.
 */
export function leadSplit(h: Pick<SearchHit, 'content' | 'claim'>): { lead: string; rest: string } | null {
  if (!h.claim || h.claim.status !== 'live') return null;
  const body = oneLine(h.content.split('\n').slice(1).filter((l) => !l.trim().startsWith('## ')).join(' '));
  if (!body) return null;
  const full = h.claim.key ? `${h.claim.key}: ${body}` : body;
  let lead = wrap(full, BODY_WIDTH)[0] ?? '';
  if (!h.claim.key) { const m = /^.*?[.!?](?=\s|$)/.exec(full); if (m && m[0].length <= lead.length) lead = m[0]; }
  return { lead, rest: full.slice(lead.length).trimStart() };
}
/** The lead line alone (null when the hit has none). */
export const leadLine = (h: Pick<SearchHit, 'content' | 'claim'>): string | null => leadSplit(h)?.lead ?? null;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Python's str(float) for the scores the legacy CLI prints (`0.436`, `1.347`, `0.0`). */
function py(n: number): string {
  const r = round3(n);
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function formatSearch(query: string, flags0: SearchFlags, hits: SearchHit[], leads: CardLeads = {}, named: string[] = [], pointed: string[] = []): string {
  const shown = named.filter((n) => leads[n]?.length);
  const point = pointed.filter((p) => !shown.includes(p));
  const flags: SearchFlags = { ...flags0, ...(Object.keys(leads).length ? { cardLeads: leads } : {}), ...(shown.length ? { namedCards: shown } : {}), ...(point.length ? { pointedCards: point } : {}) };
  if (!hits.length && !shown.length) return `\n  No results found for: "${query}"\n`;
  return flags.full ? formatSearchFull(query, flags, hits) : formatSearchCompact(query, flags, hits);
}

/** S1 (god 7a4eec): a card brief is its id on a header line, then get's lead lines label first, one per line (each
 *  clipped to the line max; the lines are short structured values), indented four under the header. */
const briefLines = (cardId: string, items: string[], indent: string): string[] => [`${indent}${cardId}`, ...items.map((i) => clip(`${indent}    ${i}`, COMPACT_LINE_MAX))];
/** S2: a brief holds at most this many lines (the query's lines come first, so a cap never drops one it names). */
export const BRIEF_LINES_MAX = 12;
/** S3 / M1 (god 7a4eec, 5dc648): the block above the hits: the brief (BRIEF_LINES_MAX lines, whole) of EVERY card or
 *  release the QUERY names, in the named order, then one label-free `<id>: memory get <id>` pointer line for every
 *  other card or release a hit names or is keyed to. Field lines print nowhere else in a search, so a value beside
 *  the named one can never read as a field line (the frozen L6 rule). The hits give way to the block. */
function namedBlock(named: string[], pointed: string[], leads: CardLeads, indent: string): { lines: string[]; shown: Set<string> } {
  const lines: string[] = [];
  const shown = new Set<string>();
  for (const id of named) {
    const items = (leads[id] ?? []).slice(0, BRIEF_LINES_MAX);
    if (!items.length || shown.has(id)) continue;
    lines.push(...briefLines(id, items, indent)); shown.add(id);
  }
  for (const id of pointed) if (!shown.has(id)) { lines.push(clip(`${indent}${id}: memory get ${id}`, COMPACT_LINE_MAX)); shown.add(id); }
  return { lines, shown };
}

/** M3 (god 5dc648): every hit-body line prints under the indent and this prefix, so a note line that starts with a
 *  field label (`merge: …`, `done: …`, `tag: …`) can never read as a field line; field lines live in the brief alone. */
export const BODY_PREFIX = '| ';
const BODY_INDENT = 4;
/** What one compact body line costs beyond its text: the indent, the prefix and the newline. */
const BODY_OVERHEAD = BODY_INDENT + BODY_PREFIX.length + 1;
/** The width of a compact body line (the indent and the prefix before it). */
const BODY_WIDTH = COMPACT_LINE_MAX - BODY_INDENT - BODY_PREFIX.length;
/** A hit may take up to this many even shares of what is left (the current values come first, so they get whole chunks). */
const COMPACT_SHARES = 3;

/** The query's content words (3+ characters), for the window of a clipped chunk. */
function queryTerms(query: string): string[] {
  return [...new Set(oneLine(query).toLowerCase().split(/[^\p{L}\p{N}._\-/@#]+/u).filter((t) => t.length >= 3))];
}

/**
 * M3 (CLAIMS-90): how much a query term NAMES one thing. 3 = a sha (7+ hex), a version (1.1.102), a card id
 * (claims-90) or a claim id (c-…); 2 = a dotted key (release.tip); 1 = a word. The window anchors on the most
 * specific matched term and the compact order lifts a hit that a level-3 term or its key names.
 */
export function termSpecificity(t: string): 1 | 2 | 3 {
  // CLAIMS-90 M3 SHOULD 1 + 3 (Jim's audit): a sha has a digit (a 7+ letter word is not one); a card id is a hyphenated
  // token with a digit segment (claims-90, cl-m4-forward-path-2), not the one-hyphen shape. SHOULD 2: a dotted card id
  // (cut-1.1.100: a version as the last segment) is a card id too, so card.cut-1.1.100.* lifts by prefix.
  if ((/^[0-9a-f]{7,}$/.test(t) && /\d/.test(t)) || /^\d+\.\d+(\.\d+)+$/.test(t) || (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(t) && /(?:^|-)\d+(?:-|$)/.test(t)) || /^c-[0-9a-f]{8,}$/.test(t) || /^[a-z][a-z0-9]*(-[a-z0-9]+)*-\d+(\.\d+)+$/.test(t)) return 3;
  if (/^[a-z0-9_\-]+(\.[a-z0-9_\-]+)+$/.test(t)) return 2;
  return 1;
}

/** Whether any query term occurs in `s` (the same terms windowContent anchors on). */
export function hasTerm(s: string, query: string): boolean {
  const low = s.toLowerCase();
  return queryTerms(query).some((t) => low.includes(t));
}

/**
 * The content of one compact hit within `max` characters: the whole one-line content when it fits;
 * else NOT the head but a window that holds the first query term found (the matched text), with
 * `…` at each cut edge, so a value past the head is still read. A hit with no term in it keeps the head.
 */
export function windowContent(content: string, query: string, max: number, mode: 'auto' | 'window' = 'auto'): { text: string; clipped: boolean } {
  const s = oneLine(content);
  // `window` mode never keeps the head, even when the whole fits `max`: the caller saw the wrap cost pop the
  // matched term off it (S1 of Jim's re-audit), so a window anchored on the term is what survives that cost.
  if (mode === 'auto' && s.length <= max) return { text: s, clipped: false };
  if (max < 8) return { text: clip(s, max), clipped: true };
  const low = s.toLowerCase();
  let at = -1;
  // M3 (S2): the anchor is the MOST SPECIFIC matched term (a sha, version or id over a key over a word), the
  // earliest among equals: a topic word at the head must not pull the window off the value the query names.
  let best = 0;
  for (const t of queryTerms(query)) {
    const i = low.indexOf(t);
    if (i < 0) continue;
    const sp = termSpecificity(t);
    if (at < 0 || sp > best || (sp === best && i < at)) { at = i; best = sp; }
  }
  // The head holds the term (with some text after it), or no term is in this chunk: the head.
  if (at < 0 || (mode === 'auto' && at + 24 <= max - 1)) return { text: clip(s, max), clipped: true };
  // Else a window that starts a third before the term, on a word boundary, and runs to the budget.
  let start = Math.max(0, at - Math.floor(max / 3));
  const sp = s.indexOf(' ', start);
  if (sp >= 0 && sp < at) start = sp + 1;
  const body = max - 2;
  const toEnd = start + body >= s.length;
  return { text: `…${toEnd ? s.slice(start) : `${s.slice(start, start + body)}…`}`, clipped: true };
}

/** Word-wrap one line into lines of at most `width` characters (a word longer than the width is cut). */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < Math.floor(width / 2)) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** What a hit's lines cost: meta + newline, then per body line the indent + the prefix + text + newline. */
const costOf = (meta: string, lines: string[]): number => meta.length + 1 + lines.reduce((n, l) => n + l.length + BODY_OVERHEAD, 0);

/**
 * The compact text, <= COMPACT_MAX_CHARS by construction: a meta line and the content, wrapped on
 * lines under the line max, per hit, current values first. A hit gets its WHOLE content when that
 * fits its budget (up to COMPACT_SHARES even shares of what is left, never under the floor); else a
 * window around the matched text, marked `…`, and the footer counts the clipped hits. Hits that no
 * longer fit go behind a `more hits` pointer. `--full` prints every chunk whole.
 */
export function formatSearchCompact(query: string, flags: SearchFlags, hits: SearchHit[]): string {
  const leads = flags.cardLeads ?? {};
  const filters = [flags.wing && `wing=${flags.wing}`, flags.room && `room=${flags.room}`, flags.since && `since=${flags.since}`, flags.before && `before=${flags.before}`].filter(Boolean).join(' ');
  // `Results for: "q"` is kept verbatim: the drill gates strip that line to compare bodies.
  // CLAIMS-90 R2: `--newest` names its order and marks [1] as the answer candidate; `--exact` names the scan.
  const header = clip(`Results for: "${oneLine(query)}" — ${hits.length} hit${hits.length === 1 ? '' : 's'}, ${flags.newest ? 'newest first ([1] answer candidate)' : 'current first'}${flags.exact ? ', exact text' : ''}${filters ? ` [${filters}]` : ''} (--full: whole chunks)`, COMPACT_LINE_MAX);
  const ordered = flags.newest ? newestOrder(query, hits) : rankHits(query, hits);
  const out: string[] = [header];
  let used = header.length + 1;
  const footer = (n: number): string => `… ${n} more hit${n === 1 ? '' : 's'} not shown (fewer --results, or --full)`;
  const clipNote = (n: number): string => `… ${n} hit${n === 1 ? '' : 's'} clipped (--full shows whole chunks)`;
  // The clipped-hits note is reserved the first time a hit is clipped (so it always fits), never before.
  const clipReserve = clipNote(hits.length).length + 1;
  let clipped = 0;
  const keys: string[] = [];
  // S3 / M1: the named briefs and the pointers first, above every hit; no hit carries a brief of its own.
  const top = namedBlock(flags.namedCards ?? [], flags.pointedCards ?? [], leads, '');
  out.push(...top.lines);
  used += top.lines.reduce((n, l) => n + l.length + 1, 0);
  for (let i = 0; i < ordered.length; i++) {
    const h = ordered[i];
    const left = ordered.length - i;
    const reserve = (left > 1 ? footer(left - 1).length + 1 : 0) + (clipped ? clipReserve : 0);
    const remaining = COMPACT_MAX_CHARS - used - reserve;
    // Up to COMPACT_SHARES even shares of what is left, leaving every later hit at least the floor;
    // never under the floor itself; no fit ends the list.
    const share = Math.floor(remaining / left);
    let budget = share >= COMPACT_MIN_HIT ? Math.min(remaining - (left - 1) * COMPACT_MIN_HIT, COMPACT_SHARES * share) : Math.min(remaining, COMPACT_MIN_HIT);
    if (budget < COMPACT_MIN_HIT) { out.push(footer(left)); break; }
    // M3a: a current claim hit opens with `<key>: <value>` and its body continues after it (no copy); on a
    // tight share the meta line gives up room (down to 24 chars) so that line still shows.
    const split = leadSplit(h);
    const metaMax = Math.max(24, Math.min(COMPACT_LINE_MAX, budget - 16 - (split ? Math.min(split.lead.length + BODY_OVERHEAD, 64) : 0)));
    const meta = clip(h.claim
      ? `[${i + 1}] ${statusWord(h.claim.status)} · ${h.claim.kind} · ${h.claim.key ?? '-'} · ${h.claim.at.slice(0, 10)} · ${h.claim.id} · ${h.wing}/${h.room}`
      : `[${i + 1}] ${h.wing}/${h.room} · ${base(h.source)}`, metaMax);
    const whole = split ? (split.rest ? `${split.lead} ${split.rest}` : split.lead) : oneLine(h.content);
    // M1 (god 5dc648): no brief under a hit any more (step 3 fix R2 printed the card's field values here): a hit's
    // card is pointed in the top block, and only the query-named brief carries field lines.
    let lines = wrap(whole, BODY_WIDTH);
    let cut = false;
    if (costOf(meta, lines) > budget) {
      // Clipped: reserve the note now (once), then fit a window of the content into what is left.
      if (!clipped) {
        const after = Math.min(budget, remaining - clipReserve);
        if (after < meta.length + 14) { out.push(footer(left)); break; }
        budget = after;
      }
      cut = true;
      const avail = budget - meta.length - 1;
      const max = Math.max(1, avail - BODY_OVERHEAD * Math.ceil(avail / BODY_WIDTH));
      // Word wrapping can add lines: drop from the end until the hit fits its budget (marked `…`).
      const fit = (text: string, bud: number): string[] => {
        const av = bud - meta.length - 1;
        let ls = wrap(text, BODY_WIDTH);
        while (ls.length > 1 && costOf(meta, ls) > bud) { ls.pop(); ls[ls.length - 1] = clip(`${ls[ls.length - 1]}…`, BODY_WIDTH); }
        if (costOf(meta, ls) > bud) ls = [clip(ls[0] ?? '', Math.max(1, av - BODY_OVERHEAD))];
        return ls;
      };
      // The head was chosen before the wrap cost; if the popped lines took every matched term with them, the
      // window (a third before the term) is what survives the cost. Decided AFTER wrapping (S1).
      const window = (text: string, mx: number, bud: number): string[] => {
        const w = windowContent(text, query, mx);
        let ls = fit(w.text, bud);
        if (!w.text.startsWith('…') && hasTerm(text, query) && !hasTerm(ls.join(' '), query)) ls = fit(windowContent(text, query, mx, 'window').text, bud);
        return ls;
      };
      // M3a: the lead keeps its line when a window of the rest (>= 24 chars) fits beside it; with less room it stands
      // alone only when it holds a matched term itself (or no part of the hit does). Else the hit is windowed as
      // before, without the lead, so what is shown never falls below M1 + S1.
      const leadCost = split ? split.lead.length + BODY_OVERHEAD : 0;
      const restAvail = avail - leadCost;
      if (split && restAvail >= 24 + BODY_OVERHEAD) {
        const restMax = Math.max(1, restAvail - BODY_OVERHEAD * Math.ceil(restAvail / BODY_WIDTH));
        lines = split.rest ? [split.lead, ...window(split.rest, restMax, budget - leadCost)] : [split.lead];
      } else if (split && avail - BODY_OVERHEAD - 29 >= 24) {
        // M3a: a shorter lead (the key and the start of its value), then a window of what follows it.
        const lead = clip(split.lead, avail - BODY_OVERHEAD - 29);
        const lc = lead.length + BODY_OVERHEAD;
        const ra = avail - lc;
        const from = whole.slice(lead.length - 1).trimStart();
        // A term cut in two by the clip would be lost: then the whole hit is windowed as before, without the lead.
        lines = hasTerm(whole, query) && !hasTerm(lead, query) && !hasTerm(from, query)
          ? window(whole, max, budget)
          : [lead, ...window(from, Math.max(1, ra - BODY_OVERHEAD * Math.ceil(ra / BODY_WIDTH)), budget - lc)];
      } else {
        const alone = split ? clip(split.lead, Math.max(1, avail - BODY_OVERHEAD)) : null;
        lines = alone !== null && (!hasTerm(whole, query) || hasTerm(alone, query)) ? [alone] : window(whole, max, budget);
      }
    }
    if (cut) clipped++;
    // M3: the body under the fixed prefix, never a bare `label: …` line.
    out.push(meta, ...lines.map((l) => `    ${BODY_PREFIX}${l}`));
    used += costOf(meta, lines);
    if (h.claim?.key) keys.push(h.claim.key);
  }
  if (clipped) out.push(clipNote(clipped));
  // CLAIMS-90 R2 (C90-GET, HISTORY-PTR g; step 2): the ready `memory get` for the keys shown, once each, on one line after
  // the hits, so no hit pays for it (a pointer on every meta line cut rank 2-5 visibility).
  const get = getFooter(keys);
  if (get) out.push(get);
  return out.join('\n') + '\n';
}

/** The verbose (whole-chunk) text: `--full`. */
export function formatSearchFull(query: string, flags: SearchFlags, hits: SearchHit[]): string {
  const leads = flags.cardLeads ?? {};
  if (!hits.length) return `\n  No results found for: "${query}"\n`;
  const L: string[] = [];
  L.push('', '='.repeat(60), `  Results for: "${query}"`);
  if (flags.wing) L.push(`  Wing: ${flags.wing}`);
  if (flags.room) L.push(`  Room: ${flags.room}`);
  if (flags.since) L.push(`  Since: ${flags.since}`);
  if (flags.before) L.push(`  Before: ${flags.before}`);
  L.push('='.repeat(60), '');
  // S3 / M1: the named briefs and the pointers above the hits, as in the compact text.
  const top = namedBlock(flags.namedCards ?? [], flags.pointedCards ?? [], leads, '  ');
  if (top.lines.length) L.push(...top.lines, '');
  (flags.newest ? newestOrder(query, hits) : hits).forEach((h, i) => {
    L.push(`  [${i + 1}] ${h.wing} / ${h.room}`);
    L.push(`      Source: ${base(h.source)}`);
    // CLAIM-LEDGER (A5): each claim hit shows [status · kind · key · date · id].
    if (h.claim) {
      // A confirmed supersession is a dated `prior`; a derived, unconfirmed one (`superseded?`) is
      // `prior?` and says so (Jim, WP step-2 re-audit): a guess is never shown as fact.
      const prior = h.claim.status === 'superseded';
      const maybePrior = h.claim.status === 'superseded?';
      const date = h.claim.at.slice(0, 10);
      L.push(`      Claim:  [${prior ? 'prior' : maybePrior ? 'prior?' : h.claim.status} · ${h.claim.kind} · ${h.claim.key ?? '-'} · ${date} · ${h.claim.id}]`);
      // CLAIMS-90 R2 (C90-GET): the ready lookup for the key's current value.
      if (h.claim.key) L.push(`      Get:    memory get ${h.claim.key}`);
      if (prior) L.push(`      Version: prior (dated ${date}); search for the key to see its current value.`);
      if (maybePrior) L.push(`      Version: possibly replaced (unconfirmed, dated ${date}); search for the key to see its current value.`);
    }
    L.push(`      Match:  cosine_sim=${h.cosineSim === null ? '0.0' : py(h.cosineSim)}  bm25=${h.bm25 === null ? '0.0' : py(h.bm25)}`);
    const lead = leadLine(h);
    if (lead) L.push(`      ${BODY_PREFIX}${clip(lead, COMPACT_LINE_MAX)}`);
    L.push('');
    // M3: every body line under the fixed prefix.
    for (const line of h.content.trim().split('\n')) L.push(`      ${BODY_PREFIX}${line}`);
    L.push('');
    L.push(`  ${'-'.repeat(56)}`);
  });
  L.push('');
  return L.join('\n') + '\n';
}

export interface WakeEntry { wing: string; room: string; source: string; content: string }

/** ~800 tokens: the legacy L1 cap was 3200 characters. */
export const WAKE_MAX_CHARS = 3200;
const SNIPPET = 400;
/** The L0.5 block's own budget (the pinned section's 6 KB soft cap); never taken from L1's. */
export const WAKE_PINNED_MAX_BYTES = 6 * 1024;

/** The pinned section's lines (its heading dropped: the block has its own), verbatim, capped. */
function pinnedBlock(pinned: string): string {
  const body = pinned.replace(/\r\n/g, '\n').replace(/^[^\n]*\n?/, '').replace(/\s+$/, '');
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= WAKE_PINNED_MAX_BYTES) return body;
  // The first 6 KB, cut at a line break when there is one (never inside a UTF-8 sequence).
  let cut = buf.lastIndexOf(0x0a, WAKE_PINNED_MAX_BYTES);
  if (cut <= 0) {
    cut = WAKE_PINNED_MAX_BYTES;
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  }
  return `${buf.subarray(0, cut).toString('utf8')}\n… (over 6 KB: read the rest in memory.md)`;
}

export interface WakeOptions { full?: boolean }

export function formatWakeUp(identity: string | null, entries: WakeEntry[], pinned: string | null = null, opts: WakeOptions = {}): string {
  return opts.full ? formatWakeUpFull(identity, entries, pinned) : formatWakeUpCompact(identity, entries, pinned);
}

/** The pinned section's lesson count (its heading dropped) and byte size, for the compact pointer. */
function pinnedSummary(pinned: string): { lessons: number; bytes: number } {
  const body = pinned.replace(/\r\n/g, '\n').replace(/^[^\n]*\n?/, '');
  const lessons = body.split('\n').filter((l) => /^(\s*[-*]\s|\s*\d+[.)]\s|###\s)/.test(l)).length;
  return { lessons, bytes: Buffer.byteLength(body.replace(/\s+$/, ''), 'utf8') };
}

/** The compact wake-up: identity in one line, a pointer to the standing lessons, the newest entries one per line; <= WAKE_COMPACT_MAX_CHARS. */
export function formatWakeUpCompact(identity: string | null, entries: WakeEntry[], pinned: string | null = null): string {
  const out: string[] = ['Wake-up (compact; --full: the whole text):'];
  out.push(clip(`L0 identity: ${identity && identity.trim() ? oneLine(identity) : 'none (agents/<id>/identity.md)'}`, COMPACT_LINE_MAX));
  const p = pinned ? pinnedSummary(pinned) : null;
  if (p && p.bytes > 0) { // an empty section (heading only) prints no block, as in the full text
    out.push(clip(`L0.5 standing lessons: ${p.lessons} in memory.md "## How I work" (${p.bytes} B; read the section, or --full)`, COMPACT_LINE_MAX));
  }
  let used = out.join('\n').length + 1;
  if (!entries.length) {
    out.push('L1: no memories yet.');
  } else {
    const head = 'L1 newest first:';
    out.push(head); used += head.length + 1;
    const more = (n: number): string => `… ${n} more (--full)`;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const left = entries.length - i;
      const reserve = left > 1 ? more(left - 1).length + 1 : 0;
      const budget = Math.min(COMPACT_LINE_MAX, Math.max(COMPACT_MIN_ENTRY, Math.floor((WAKE_COMPACT_MAX_CHARS - used - reserve) / left)));
      if (used + budget + 1 + reserve > WAKE_COMPACT_MAX_CHARS) { out.push(more(left)); break; }
      const tail = `  (${base(e.source)})`;
      // An entry line is `- [room] ` + content + tail (+ its newline): never more than its budget.
      const line = `- [${e.room}] ${clip(oneLine(e.content), Math.max(8, budget - tail.length - e.room.length - 6))}${tail}`;
      out.push(line); used += line.length + 1;
    }
  }
  return out.join('\n') + '\n';
}

/** Fit a block of lines (the claims working set) into `max` characters, whole lines only, with a pointer when cut. */
export function fitLines(block: string, max: number): string {
  if (block.length <= max) return block;
  const more = (n: number): string => `… ${n} more line${n === 1 ? '' : 's'} (--full)`;
  const lines = block.replace(/\s+$/, '').split('\n');
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const left = lines.length - i;
    const l = clip(lines[i], COMPACT_LINE_MAX);
    if (used + l.length + 1 + more(left - 1).length + 1 > max) { if (used + more(left).length <= max) out.push(more(left)); break; }
    out.push(l); used += l.length + 1;
  }
  return out.join('\n');
}

/** The verbose wake-up text (`--full`): the section-4 frame with L0 / L0.5 / L1. */
export function formatWakeUpFull(identity: string | null, entries: WakeEntry[], pinned: string | null = null): string {
  const parts: string[] = [];
  parts.push(identity && identity.trim()
    ? `## L0 — IDENTITY\n${identity.trim().slice(0, 800)}`
    : '## L0 — IDENTITY\nNo identity file for this wing (agents/<id>/identity.md).');
  parts.push('');
  const lessons = pinned ? pinnedBlock(pinned) : '';
  if (lessons.trim()) parts.push(`## L0.5 — HOW I WORK (standing lessons)\n${lessons}`, '');
  if (!entries.length) {
    parts.push('## L1 — No memories yet.');
  } else {
    const L = ['## L1 — ESSENTIAL STORY'];
    const byRoom = new Map<string, WakeEntry[]>();
    for (const e of entries) { const l = byRoom.get(e.room) ?? []; l.push(e); byRoom.set(e.room, l); }
    // NATIVEMEM-SOURCES-LOCALE-SORT: ordinal, not localeCompare (the same order on every locale).
    const rooms = [...byRoom.keys()].sort((a, b) => (a === 'memory' ? -1 : b === 'memory' ? 1 : ordinal(a, b)));
    for (const room of rooms) {
      L.push('', `[${room}]`);
      for (const e of byRoom.get(room)!) {
        let s = e.content.trim().replace(/\n+/g, ' ');
        if (s.length > SNIPPET) s = `${s.slice(0, SNIPPET - 3)}...`;
        L.push(`  - ${s}  (${base(e.source)})`);
      }
    }
    parts.push(L.join('\n'));
  }
  const text = parts.join('\n');
  return `Wake-up text (~${Math.floor(text.length / 4)} tokens):\n${'='.repeat(50)}\n${text}\n`;
}

export function formatStatus(s: { sources: number; chunks: number; vectors: number; generation: number; dbBytes: number; perWing: Array<{ wing: string; chunks: number }>; memoryPinned?: Array<{ agent: string; present: boolean; bytes: number; lessons: number }> }): string {
  const L = [`Memory engine (native index): ${s.sources} sources, ${s.chunks} chunks, ${s.vectors} vectors, ${(s.dbBytes / 1048576).toFixed(1)} MB, generation ${s.generation}`];
  for (const w of s.perWing) L.push(`  WING: ${w.wing}  (${w.chunks} chunks)`);
  // PINNED-MEMORY migration check: each agent's "## How I work (standing lessons)" section.
  if (s.memoryPinned?.length) {
    L.push('memory-pinned (## How I work (standing lessons)):');
    for (const p of s.memoryPinned) {
      L.push(p.present
        ? `  ${p.agent}: ${p.lessons} lesson(s), ${p.bytes} B${p.bytes > PINNED_SOFT_CAP_BYTES ? '  (over 6 KB: merge and shorten)' : ''}${p.lessons === 0 ? '  (empty: move your method lessons here)' : ''}`
        : `  ${p.agent}: no section`);
    }
  }
  return L.join('\n') + '\n';
}
