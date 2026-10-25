/**
 * CLAIMS-90 M5: the derived facts, read deterministically from primary records (no model, no
 * guess). Each fact names its SLOT (the one live value it fills) and becomes a claim with source
 * 'derived' in the derived ledger (derivedWriter.ts). Pure: git is reached through a port.
 *
 *   (a) card.<id>.decision.<q8>   each answered humanQA entry: the answer, its date and the question,
 *                                 never clipped (R2): a long one goes on in .decision.<q8>.p2, .p3, ...
 *                                 q8 is the question's hash, so a newer answer to the same question replaces it.
 *   (b) card.<id>.status | .assignee | .lastsha   from the card; lastsha is the latest in GIT ORDER
 *                                 among the commits named in the card's result and notes (guide A11).
 *   (c) release.<ver>, release.<ver>.e<n>   CHANGELOG sections and their entries; the release tag's commit.
 *   (d) card.<id>.donesha         R2: one per card and sender: the sender's newest done mail for the card
 *                                 and the latest in git order of the commits it names (doneMailFacts).
 *   (e) card.<id>.gitsha          R2: the latest in git order of the commits whose message names the card.
 *   (f) card.<id>.decision.result, card.<id>.decision.n<h8>   R2: the card's own record, whole, in parts:
 *                                 its result, and each note entry (h8 = the entry's hash, so entries
 *                                 keep their keys as notes grow). A ruling that lives only there is found.
 *
 * Card ids are lower-cased in keys (the registry's KEY_RE); an id that cannot make a key is skipped.
 */
import { createHash } from 'node:crypto';
import type { ClaimKind, Ref } from '../../shared/claims';

export interface DerivedFact { slot: string; key: string; kind: ClaimKind; text: string; at?: string; refs: Ref[] }

/** The registry's key grammar (registry.ts KEY_RE, KEY_MAX). */
const KEY_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,7}$/;
const KEY_MAX = 120;
const TEXT_MAX = 400;

export function keyOk(key: string): boolean { return key.length <= KEY_MAX && KEY_RE.test(key); }

/** `card.<id lower-cased>.<suffix...>`, or null when the id cannot make a key. */
export function cardKey(cardId: string, ...suffix: string[]): string | null {
  if (typeof cardId !== 'string' || !cardId) return null;
  const key = ['card', cardId.toLowerCase(), ...suffix].join('.');
  return keyOk(key) ? key : null;
}

const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Whitespace folded and cut to n characters with an ellipsis (these are the writer's own texts). */
export function clip(s: string, n: number): string {
  const f = fold(s);
  const chars = [...f];
  return chars.length <= n ? f : `${chars.slice(0, Math.max(0, n - 1)).join('')}…`;
}
const len = (s: string): number => [...s].length;
/** Folded text cut into pieces of at most n characters, at spaces where it can. */
export function splitWords(s: string, n: number): string[] {
  const chars = [...fold(s)];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let j = Math.min(chars.length, i + n);
    if (j < chars.length) { const sp = chars.lastIndexOf(' ', j); if (sp > i + n / 2) j = sp; }
    out.push(chars.slice(i, j).join('').trim());
    i = j;
    while (chars[i] === ' ') i++;
  }
  return out.length ? out : [''];
}
const isoOk = (s: unknown): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /(Z|[+-]\d\d:?\d\d)$/.test(s);
const iso = (s: unknown): string | undefined => (isoOk(s) ? new Date(Date.parse(s)).toISOString() : undefined);

// ———————————————————————————————————————————————————————————— (a) Human decisions

export interface QaLike { q?: unknown; a?: unknown; askedAt?: unknown; answeredAt?: unknown; msgId?: unknown }
export interface CardLike {
  id?: unknown; title?: unknown; status?: unknown; assignee?: unknown; result?: unknown; notes?: unknown; humanQA?: unknown;
}

export function questionHash(q: string): string {
  return createHash('sha256').update(fold(q).toLowerCase()).digest('hex').slice(0, 8);
}

/** One fact per (card, question) for the answered entries; a later answer to the same question wins. */
export function decisionFacts(cards: readonly CardLike[]): DerivedFact[] {
  const out: DerivedFact[] = [];
  for (const c of cards) {
    if (typeof c?.id !== 'string' || !Array.isArray(c.humanQA)) continue;
    const bySlot = new Map<string, { qa: QaLike; at: string | undefined; i: number }>();
    (c.humanQA as QaLike[]).forEach((qa, i) => {
      if (!qa || typeof qa.q !== 'string' || !qa.q.trim() || typeof qa.a !== 'string' || !qa.a.trim()) return;
      const key = cardKey(c.id as string, 'decision', questionHash(qa.q));
      if (!key) return;
      const at = iso(qa.answeredAt);
      const prior = bySlot.get(key);
      // The later answer by answeredAt; with no date (or the same), the later entry on the card.
      if (!prior || (at ?? '') > (prior.at ?? '') || ((at ?? '') === (prior.at ?? '') && i > prior.i)) bySlot.set(key, { qa, at, i });
    });
    for (const [key, { qa, at }] of bySlot) {
      const day = at ? ` on ${at.slice(0, 10)}` : '';
      const whole = `the Human answered "${fold(qa.a as string)}"${day} to the question "${fold(qa.q as string)}"`;
      const refs: Ref[] = [{ type: 'task', value: c.id as string }];
      if (typeof qa.msgId === 'string' && qa.msgId && qa.msgId.length <= 200) refs.push({ type: 'msg', value: qa.msgId });
      out.push(...inParts(key, 'decision', `Human decision on ${c.id}`, whole, at, refs));
    }
  }
  return out;
}

/**
 * The whole text as one claim under `key` when it fits, else parts under key, key.p2, ... (at most 9,
 * and only with room in the key grammar; without it, one clipped claim). Each text starts with the
 * label, plus " (part k of n)" when cut.
 */
function inParts(key: string, kind: ClaimKind, label: string, whole: string, at: string | undefined, refs: Ref[]): DerivedFact[] {
  const head = (k: number, n: number): string => `${label}${n > 1 ? ` (part ${k} of ${n})` : ''}: `;
  let parts = len(whole) <= TEXT_MAX - len(head(1, 1)) ? [whole] : splitWords(whole, TEXT_MAX - len(head(9, 9)));
  if (parts.length > 1 && (parts.length > 9 || !keyOk(`${key}.p${parts.length}`))) parts = [clip(whole, TEXT_MAX - len(head(1, 1)))];
  return parts.map((p, i) => {
    const k = i === 0 ? key : `${key}.p${i + 1}`;
    return { slot: k, key: k, kind, text: `${head(i + 1, parts.length)}${p}`, ...(at ? { at } : {}), refs };
  });
}

/** A note field cut into entries: each line that starts with a date (optionally in brackets) opens one. */
export function noteEntries(notes: unknown): string[] {
  const list = Array.isArray(notes) ? notes : [notes];
  const out: string[] = [];
  for (const n of list) {
    const s = typeof n === 'string' ? n : n && typeof n === 'object' ? JSON.stringify(n) : '';
    for (const e of s.split(/\n(?=\s*\[?\d{4}-\d\d-\d\d)/)) if (e.trim()) out.push(e.trim());
  }
  return out;
}
const entryAt = (e: string): string | undefined => iso(/^\[?(\d{4}-\d\d-\d\d[T ][0-9:.]+(?:Z|[+-]\d\d:?\d\d))/.exec(e)?.[1]?.replace(' ', 'T'));

/** (f) The card's result and each note entry under card.<id>.decision.*, whole (R2: Jim D2/D3). */
export function cardRecordFacts(cards: readonly CardLike[]): DerivedFact[] {
  const out: DerivedFact[] = [];
  for (const c of cards) {
    if (typeof c?.id !== 'string') continue;
    const refs: Ref[] = [{ type: 'task', value: c.id }];
    const rk = cardKey(c.id, 'decision', 'result');
    if (rk && typeof c.result === 'string' && c.result.trim()) out.push(...inParts(rk, 'fact', `Card ${c.id} result`, fold(c.result), undefined, refs));
    const seen = new Set<string>();
    for (const e of noteEntries(c.notes)) {
      const h = `n${questionHash(e)}`;
      const k = cardKey(c.id, 'decision', h);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(...inParts(k, 'fact', `Card ${c.id} note`, fold(e), entryAt(e), refs));
    }
  }
  return out;
}

// ———————————————————————————————————————————————————————————— shas and git order

/** What the writer needs from git. `commitOf` gives the full sha of a COMMIT (a tag object or a
 *  missing object gives null); `time` is the committer time in seconds. */
export interface GitPort {
  commitOf(sha: string): Promise<string | null>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  time(commit: string): Promise<number>;
  /** The commit's message (subject and body), or null; optional (R2: settles a done mail naming several cards). */
  message?(commit: string): Promise<string | null>;
}

const SHA_RE = /(?<![0-9A-Za-z])([0-9a-f]{7,40})(?:(\.\.\.?)([0-9a-f]{7,40}))?(?![0-9A-Za-z])/g;
/** A hex word that could be a sha: 7-40 hex with at least one digit and one letter (no dates, no words). */
const shaLike = (s: string): boolean => /[0-9]/.test(s) && /[a-f]/.test(s);

export interface ShaMention { sha: string; range?: { from: string; to: string; end: 'from' | 'to' } }

/** The sha-like words in text, in order, each once; `a..b` (or `a...b`) gives both ends, marked. */
export function shaMentions(text: unknown): ShaMention[] {
  if (typeof text !== 'string' || !text) return [];
  const out: ShaMention[] = [];
  const seen = new Set<string>();
  const add = (m: ShaMention): void => { if (shaLike(m.sha) && !seen.has(m.sha)) { seen.add(m.sha); out.push(m); } };
  for (const m of text.matchAll(SHA_RE)) {
    const [, a, dots, b] = m;
    if (dots && b && shaLike(a) && shaLike(b)) {
      add({ sha: a, range: { from: a, to: b, end: 'from' } });
      add({ sha: b, range: { from: a, to: b, end: 'to' } });
    } else if (!dots) add({ sha: a });
  }
  return out;
}

/**
 * Guide A11: the latest commit in git order among the candidates. A descendant beats its ancestor;
 * on unrelated lines the later committer time wins (then the larger sha, so the result never
 * depends on the order the shas were written). Only commits count (a tag object is not one).
 */
export async function latestInGitOrder(candidates: readonly string[], git: GitPort): Promise<string | null> {
  const commits: string[] = [];
  for (const c of candidates) {
    const full = await git.commitOf(c);
    if (full && !commits.includes(full)) commits.push(full);
  }
  if (commits.length === 0) return null;
  // The commits no other candidate descends from; of those, the latest by time.
  const heads: string[] = [];
  for (const c of commits) {
    let beaten = false;
    for (const d of commits) if (d !== c && await git.isAncestor(c, d)) { beaten = true; break; }
    if (!beaten) heads.push(c);
  }
  let best = heads[0];
  let bestT = await git.time(best);
  for (const h of heads.slice(1)) {
    const t = await git.time(h);
    if (t > bestT || (t === bestT && h > best)) { best = h; bestT = t; }
  }
  return best;
}

/** A git port that can also list every commit with its message (R2 git-history facts). */
export interface GitLogPort extends GitPort {
  log?(): Promise<Array<{ commit: string; time: number; message: string }>>;
}

/**
 * R2 (b): card.<id>.gitsha per card that some commit message names (registry ids, guide A12): the
 * latest in git order of those commits, so a done commit stays findable after its mail is gone. Of
 * many, the eight newest by time are compared in git order.
 */
export async function gitHistoryFacts(log: ReadonlyArray<{ commit: string; time: number; message: string }>, cardIds: readonly string[], git: GitPort): Promise<DerivedFact[]> {
  const match = cardMatcher(cardIds);
  const byCard = new Map<string, Array<{ commit: string; time: number }>>();
  for (const c of log) for (const card of match(c.message)) {
    const list = byCard.get(card) ?? [];
    list.push({ commit: c.commit, time: c.time });
    byCard.set(card, list);
  }
  const out: DerivedFact[] = [];
  for (const [card, list] of [...byCard].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const key = cardKey(card, 'gitsha');
    if (!key) continue;
    const newest = [...list].sort((a, b) => b.time - a.time || (a.commit < b.commit ? 1 : -1)).slice(0, 8).map((x) => x.commit);
    const best = await latestInGitOrder(newest, git);
    if (!best) continue;
    const t0 = list.find((x) => x.commit === best)?.time;
    out.push({
      slot: key, key, kind: 'fact',
      text: `Card ${card}: the latest commit in git order whose message names the card is ${best.slice(0, 8)} (${best}); ${list.length} commit${list.length > 1 ? 's name' : ' names'} it`,
      ...(t0 ? { at: new Date(t0 * 1000).toISOString() } : {}),
      refs: [{ type: 'task', value: card }, { type: 'commit', value: best }],
    });
  }
  return out;
}

// ———————————————————————————————————————————————————————————— (b) card fields

export async function cardFieldFacts(cards: readonly CardLike[], git: GitPort | null): Promise<DerivedFact[]> {
  const out: DerivedFact[] = [];
  for (const c of cards) {
    if (typeof c?.id !== 'string') continue;
    const id = c.id;
    const title = typeof c.title === 'string' && c.title.trim() ? ` ("${clip(c.title, 120)}")` : '';
    const task: Ref = { type: 'task', value: id };
    const status = cardKey(id, 'status');
    if (status && typeof c.status === 'string' && c.status) {
      out.push({ slot: status, key: status, kind: 'fact', text: `Card ${id}${title} status: ${clip(c.status, 40)}`, refs: [task] });
    }
    const assignee = cardKey(id, 'assignee');
    if (assignee) {
      const who = typeof c.assignee === 'string' && c.assignee.trim() ? clip(c.assignee, 80) : null;
      out.push({ slot: assignee, key: assignee, kind: 'fact', text: who ? `Card ${id}${title} is assigned to ${who}` : `Card ${id}${title} has no assignee`, refs: [task] });
    }
    const lastsha = cardKey(id, 'lastsha');
    if (lastsha && git) {
      const shas = [...shaMentions(c.result), ...shaMentions(c.notes)].map((m) => m.sha);
      const best = shas.length ? await latestInGitOrder(shas, git) : null;
      if (best) {
        out.push({ slot: lastsha, key: lastsha, kind: 'fact', text: `Card ${id}${title} last commit (latest in git order of the commits its result and notes name): ${best.slice(0, 8)} (${best})`, refs: [task, { type: 'commit', value: best }] });
      }
    }
  }
  return out;
}

// ———————————————————————————————————————————————————————————— (c) releases

export interface TagLike { name: string; commit: string; date?: string }
export interface ChangelogSection { version: string; date?: string; headline?: string; entries: Array<{ heading: string; text: string }> }

const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

/** `## [1.1.102] — 2026-10-24` sections (Unreleased skipped): the bold headline and each bullet's lead. */
export function parseChangelog(md: unknown): ChangelogSection[] {
  if (typeof md !== 'string') return [];
  const out: ChangelogSection[] = [];
  let cur: ChangelogSection | null = null;
  let heading = '';
  let bullet: string[] | null = null;
  const flush = (): void => { if (cur && bullet) cur.entries.push({ heading, text: fold(bullet.join(' ')) }); bullet = null; };
  for (const raw of md.split(/\r?\n/)) {
    const sec = /^##\s+\[([^\]]+)\](?:\s*[—–-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(raw);
    if (sec) {
      flush();
      cur = VERSION_RE.test(sec[1]) ? { version: sec[1], ...(sec[2] ? { date: sec[2] } : {}), entries: [] } : null;
      if (cur) out.push(cur);
      heading = '';
      continue;
    }
    if (!cur) continue;
    const h = /^###\s+(.+)$/.exec(raw);
    if (h) { flush(); heading = fold(h[1]); continue; }
    if (/^[-*]\s+/.test(raw)) { flush(); bullet = [raw.replace(/^[-*]\s+/, '')]; continue; }
    if (bullet && /^\s+\S/.test(raw)) { bullet.push(raw.trim()); continue; }
    if (bullet && !raw.trim()) { flush(); continue; }
    if (!heading && !cur.headline && raw.trim() && cur.entries.length === 0) cur.headline = fold(raw);
  }
  flush();
  return out;
}

const tagVersion = (name: string): string | null => {
  const m = /^v?(\d+(?:\.\d+){1,3})$/.exec(name);
  return m ? m[1] : null;
};

/** release.<ver>: the section's date, headline and tag commit; release.<ver>.e<n>: each entry's lead. */
export function releaseFacts(sections: readonly ChangelogSection[], tags: readonly TagLike[]): DerivedFact[] {
  const out: DerivedFact[] = [];
  const tagOf = new Map<string, TagLike>();
  for (const t of tags) { const v = tagVersion(t.name); if (v && /^[0-9a-f]{40}$/.test(t.commit)) tagOf.set(v, t); }
  const versions = new Set<string>([...sections.map((s) => s.version), ...tagOf.keys()]);
  const secOf = new Map(sections.map((s) => [s.version, s]));
  for (const v of versions) {
    const key = `release.${v}`;
    if (!keyOk(key)) continue;
    const s = secOf.get(v);
    const t = tagOf.get(v);
    const parts = [`Guppy ${v}`];
    if (s?.date) parts.push(`released ${s.date} (CHANGELOG)`);
    if (t) parts.push(`tag ${t.name} is commit ${t.commit}${iso(t.date) ? ` (tagged ${iso(t.date)!.slice(0, 10)})` : ''}`);
    let text = parts.join(', ');
    if (s?.headline) text = `${text}. ${clip(s.headline, TEXT_MAX - len(text) - 2)}`;
    const refs: Ref[] = t ? [{ type: 'commit', value: t.commit }] : [];
    out.push({ slot: key, key, kind: 'fact', text: clip(text, TEXT_MAX), ...(iso(t?.date) ? { at: iso(t?.date) } : {}), refs });
    (s?.entries ?? []).forEach((e, i) => {
      const ek = `${key}.e${i + 1}`;
      if (!keyOk(ek)) return;
      const head = `Guppy ${v}${s?.date ? ` (${s.date})` : ''} CHANGELOG${e.heading ? ` ${e.heading}` : ''}: `;
      out.push({ slot: ek, key: ek, kind: 'fact', text: `${head}${clip(e.text, TEXT_MAX - len(head))}`, refs });
    });
  }
  return out;
}

// ———————————————————————————————————————————————————————————— (d) done mails

export interface MailLike { id?: unknown; from?: unknown; act?: unknown; subject?: unknown; body?: unknown; card?: unknown; cards?: unknown; created_at?: unknown }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Guide A12: a card id in text, case-insensitive, its dashes written as a dash, a space or nothing. */
export function cardMatcher(cardIds: readonly string[]): (text: unknown) => string[] {
  const ids = [...new Set(cardIds.filter((c) => typeof c === 'string' && c.length >= 2))].sort((a, b) => b.length - a.length);
  if (ids.length === 0) return () => [];
  const alt = ids.map((id) => escapeRe(id).replace(/-/g, '[- ]?')).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9.-])(${alt})(?![A-Za-z0-9]|[.-][A-Za-z0-9])`, 'gi');
  const canon = new Map(ids.map((id) => [id.toLowerCase().replace(/[- ]/g, ''), id]));
  return (text) => {
    if (typeof text !== 'string' || !text) return [];
    const found: string[] = [];
    for (const m of text.matchAll(re)) {
      const id = canon.get(m[1].toLowerCase().replace(/[- ]/g, ''));
      if (id && !found.includes(id)) found.push(id);
    }
    return found;
  };
}

/** Why a done mail gave no done-sha fact (one row per mail; the counts sum them). */
export type DoneSkipReason = 'notDone' | 'noShaWord' | 'noCommit' | 'noCard' | 'ambiguous';
export interface DoneSkip { mail: string; reason: DoneSkipReason; cards?: string[] }
export interface DoneMailResult {
  facts: DerivedFact[];
  skipped: Record<DoneSkipReason, number>;
  /** Every skipped mail with its reason. */
  skips: DoneSkip[];
  /** Done mails that gave a commit but are older than their sender's newest one for the card. */
  older: number;
}

const mailAt = (m: MailLike): string => iso(m.created_at) ?? '';

/**
 * R2 (a): ONE fact per (card, sender): the sender's NEWEST done mail for the card that names a
 * commit, and the one commit it stands for, the latest in git order of those it names (guide A11),
 * so no claim holds two values. Older mails of that sender for that card give no fact; their
 * claims are superseded by the writer (same slot, card.<id>.donesha#<sender>).
 *
 * The card: the mail's card field when it is a known card, else the cards its delivery linked
 * (`cards`, the mail-cards index), else the cards its subject names, else its body. With more than
 * one, git decides: the card named by the messages of the commits the mail names, when exactly one
 * candidate is named there; otherwise the mail is ambiguous. Commits: the sha words of the subject
 * and body that git resolves to a commit (ranges a..b give both ends). R2 (c): a mail that gives no
 * fact carries a reason; noShaWord, noCommit and ambiguous are each what git confirmed.
 * A mail copied to several inboxes counts once (by id).
 */
export async function doneMailFacts(mails: readonly MailLike[], cardIds: readonly string[], git: GitPort): Promise<DoneMailResult> {
  const match = cardMatcher(cardIds);
  const known = new Map(cardIds.map((c) => [c.toLowerCase(), c]));
  const skipped: Record<DoneSkipReason, number> = { notDone: 0, noShaWord: 0, noCommit: 0, noCard: 0, ambiguous: 0 };
  const skips: DoneSkip[] = [];
  const skip = (mail: string, reason: DoneSkipReason, cards?: string[]): void => {
    skipped[reason]++;
    skips.push({ mail, reason, ...(cards?.length ? { cards } : {}) });
  };
  const newest = new Map<string, { m: MailLike & { id: string }; card: string; from: string; commit: string; named: number; range?: ShaMention['range'] }>();
  let withCommit = 0;
  const seen = new Set<string>();
  const ordered = [...mails].filter((m): m is MailLike & { id: string } => !!m && typeof m.id === 'string')
    .sort((a, b) => (mailAt(a) < mailAt(b) ? -1 : mailAt(a) > mailAt(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of ordered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.act !== 'done') { skip(m.id, 'notDone'); continue; }
    const mentions = [...shaMentions(m.subject), ...shaMentions(typeof m.body === 'string' ? m.body : '')];
    if (!mentions.length) { skip(m.id, 'noShaWord'); continue; }
    const commits: string[] = [];
    const words: string[] = [];   // the sha words as written, for latestInGitOrder (it resolves them itself)
    const rangeOf = new Map<string, ShaMention['range']>();
    for (const x of mentions) {
      const full = await git.commitOf(x.sha);
      if (!full || commits.includes(full)) continue;
      commits.push(full);
      words.push(x.sha);
      if (x.range) rangeOf.set(full, x.range);
    }
    if (!commits.length) { skip(m.id, 'noCommit'); continue; }
    const card = await cardOfDoneMail(m, known, match, commits, git);
    if (typeof card !== 'string') { skip(m.id, card.reason, card.cards); continue; }
    const key = cardKey(card, 'donesha');
    if (!key) { skip(m.id, 'noCard', [card]); continue; }
    const commit = (await latestInGitOrder(words, git)) ?? commits[0];
    const from = typeof m.from === 'string' && m.from ? clip(m.from, 60) : 'unknown';
    withCommit++;
    newest.set(`${key}#${from}`, { m, card, from, commit, named: commits.length, range: rangeOf.get(commit) });
  }
  const facts: DerivedFact[] = [];
  for (const [slot, { m, card, from, commit, named, range }] of newest) {
    const key = slot.slice(0, slot.lastIndexOf('#'));
    const at = iso(m.created_at);
    const of = range ? ` (the ${range.end === 'from' ? 'start' : 'end'} of the range ${range.from}..${range.to})` : '';
    const others = named > 1 ? `; it is the latest in git order of the ${named} commits the mail names` : '';
    facts.push({
      slot, key, kind: 'fact',
      text: `Card ${card}: the newest done mail from ${from} (${clip(m.id, 80)}) names commit ${commit.slice(0, 8)} (${commit})${of}${others}`,
      ...(at ? { at } : {}),
      refs: [{ type: 'task', value: card }, { type: 'msg', value: m.id.slice(0, 200) }, { type: 'commit', value: commit }],
    });
  }
  return { facts, skipped, skips, older: withCommit - facts.length };
}

/** The done mail's card (see doneMailFacts), or why there is none. */
async function cardOfDoneMail(
  m: MailLike, known: Map<string, string>, match: (text: unknown) => string[], commits: readonly string[], git: GitPort,
): Promise<string | { reason: 'noCard' | 'ambiguous'; cards?: string[] }> {
  const field = typeof m.card === 'string' ? known.get(m.card.toLowerCase()) : undefined;
  if (field) return field;
  const linked = Array.isArray(m.cards)
    ? [...new Set(m.cards.map((c) => (typeof c === 'string' ? known.get(c.toLowerCase()) : undefined)).filter((c): c is string => !!c))]
    : [];
  const inSubject = linked.length ? [] : match(m.subject);
  const named = linked.length ? linked : inSubject.length ? inSubject : match(typeof m.body === 'string' ? m.body : '');
  if (named.length === 1) return named[0];
  if (!named.length) return { reason: 'noCard' };
  if (git.message) {
    const byGit = new Set<string>();
    for (const c of commits) {
      const hits = match(await git.message(c)).filter((x) => named.includes(x));
      if (hits.length === 1) byGit.add(hits[0]);
    }
    if (byGit.size === 1) return [...byGit][0];
  }
  return { reason: 'ambiguous', cards: named.slice(0, 8) };
}
