/**
 * CLAIMS-90 M5: the derived facts, read deterministically from primary records (no model, no
 * guess). Each fact names its SLOT (the one live value it fills) and becomes a claim with source
 * 'derived' in the derived ledger (derivedWriter.ts). Pure: git is reached through a port.
 *
 *   (a) card.<id>.decision.<q8>   each answered humanQA entry: the answer and its date. q8 is the
 *                                 question's hash, so a newer answer to the same question replaces it.
 *   (b) card.<id>.status | .assignee | .lastsha   from the card; lastsha is the latest in GIT ORDER
 *                                 among the commits named in the card's result and notes (guide A11).
 *   (c) release.<ver>, release.<ver>.e<n>   CHANGELOG sections and their entries; the release tag's commit.
 *   (d) card.<id>.donesha         one per commit named by a done mail; the card from the mail's card
 *                                 field, else its subject, else its body; the commit from the subject or
 *                                 body, ranges a..b included (guide A12).
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
      const day = at ? ` (answered ${at.slice(0, 10)})` : '';
      const head = `Human decision on ${c.id}: asked "`;
      const mid = '"; the Human answered "';
      const tail = `"${day}`;
      const room = TEXT_MAX - len(head) - len(mid) - len(tail);
      const a = fold(qa.a as string);
      const qRoom = Math.max(60, room - Math.min(len(a), room - 60));
      const q = clip(qa.q as string, qRoom);
      const text = `${head}${q}${mid}${clip(a, room - len(q))}${tail}`;
      const refs: Ref[] = [{ type: 'task', value: c.id as string }];
      if (typeof qa.msgId === 'string' && qa.msgId && qa.msgId.length <= 200) refs.push({ type: 'msg', value: qa.msgId });
      out.push({ slot: key, key, kind: 'decision', text, ...(at ? { at } : {}), refs });
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

export interface MailLike { id?: unknown; from?: unknown; act?: unknown; subject?: unknown; body?: unknown; card?: unknown; created_at?: unknown }

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

export interface DoneMailResult { facts: DerivedFact[]; skipped: { notDone: number; noCard: number; ambiguous: number; noCommit: number } }

/**
 * One fact per (card, commit) from the done mails. The card: the mail's card field when it is a
 * known card, else the one card its subject names, else the one card its body names (more than
 * one = ambiguous, skipped). Commits: the sha words of the subject and body that git resolves to a
 * commit. A mail copied to several inboxes counts once (by id).
 */
export async function doneMailFacts(mails: readonly MailLike[], cardIds: readonly string[], git: GitPort): Promise<DoneMailResult> {
  const match = cardMatcher(cardIds);
  const known = new Map(cardIds.map((c) => [c.toLowerCase(), c]));
  const skipped = { notDone: 0, noCard: 0, ambiguous: 0, noCommit: 0 };
  const facts = new Map<string, DerivedFact>();
  const seen = new Set<string>();
  for (const m of mails) {
    if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.act !== 'done') { skipped.notDone++; continue; }
    let card: string | undefined = typeof m.card === 'string' ? known.get(m.card.toLowerCase()) : undefined;
    if (!card) {
      const inSubject = match(m.subject);
      const inBody = inSubject.length ? [] : match(typeof m.body === 'string' ? m.body : '');
      const named = inSubject.length ? inSubject : inBody;
      if (named.length > 1) { skipped.ambiguous++; continue; }
      card = named[0];
    }
    if (!card) { skipped.noCard++; continue; }
    const mentions = [...shaMentions(m.subject), ...shaMentions(typeof m.body === 'string' ? m.body : '')];
    let any = false;
    const done = new Set<string>();
    for (const x of mentions) {
      const full = await git.commitOf(x.sha);
      if (!full || done.has(full)) continue;
      done.add(full);
      const key = cardKey(card, 'donesha');
      if (!key) continue;
      any = true;
      const slot = `${key}#${full}`;
      const prior = facts.get(slot);
      const at = iso(m.created_at);
      if (prior && (prior.at ?? '') <= (at ?? '')) continue;   // the first mail that named it
      const from = typeof m.from === 'string' ? clip(m.from, 60) : 'unknown';
      const range = x.range ? ` (the ${x.range.end === 'from' ? 'start' : 'end'} of the range ${x.range.from}..${x.range.to})` : '';
      facts.set(slot, {
        slot, key, kind: 'fact',
        text: `Card ${card}: the done mail ${clip(m.id, 80)} from ${from} names commit ${full.slice(0, 8)} (${full})${range}`,
        ...(at ? { at } : {}),
        refs: [{ type: 'task', value: card }, { type: 'msg', value: m.id.slice(0, 200) }, { type: 'commit', value: full }],
      });
    }
    if (!any) skipped.noCommit++;
  }
  return { facts: [...facts.values()], skipped };
}
