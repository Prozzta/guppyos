/**
 * CLAIMS-90 step 3 search S3/S4 (god 33b32e), the data side: which cards and releases a search names. Whenever the
 * query or a hit names a card id, a branch a card owns, or a release version, that card's or release's brief leads
 * the results. Pure: the caller (main, which holds tasks.json and the ledgers) builds the index from the card ids
 * and claim keys it has, and passes the query first, then the hit texts.
 *
 * A token names a card when it is a card id (any case), `card.<id>[.<field>]`, a short name of exactly one card (a
 * run of two or more of its id's hyphen words, as agents shorten HEAVY-LOCK-CMD-QUOTED-CARET-198 to quoted-caret,
 * or the stem of a `<stem>-<n>` id), or a branch (`origin/` and `guppy/` dropped) whose name is one of those (a card owns
 * the branch named after it, as the merge rule says). Otherwise it names a release when it is `<v>`, `v<v>`,
 * `int-<v>`, `INT <v>`, `release-<v>`, `rc-<v>` or `release.<v>[.<field>]` and some `release.<v>[...]` key exists.
 * The term returned is what `memory get` resolves: the card id as the index holds it, or `release.<v>`.
 */

export interface TargetIndex {
  /** lower-cased card id → the id as written (tasks.json first, else the claim key). */
  cards: Map<string, string>;
  /** release versions with at least one release.<v>[.x] key. */
  releases: Set<string>;
}
type SearchTarget = { kind: 'card' | 'release'; term: string };

const VERSION = String.raw`\d+(?:\.\d+)+`;
const VERSION_RE = new RegExp(`^${VERSION}$`);
const RELEASE_KEY_RE = new RegExp(String.raw`^release\.(${VERSION})(?:\.[a-z0-9]+)*$`, 'i');
const RELEASE_PREFIX_RE = /^(?:v|int-|int\/release-|release-|rc-|rc\/)/i;
const CARD_FIELD_RE = /\.(?:status|assignee|lastsha|donesha|audit|fixversion|merge(?:\.rc)?|gitsha|branch)$/i;
const CARD_ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;

/** The card id a `card.<id>[.<field>|.decision.<x>]` key names, as written; null for any other key. */
function cardOfKey(key: string): string | null {
  if (!/^card\./i.test(key)) return null;
  const id = key.slice(5).replace(/\.decision\..*$/i, '').replace(CARD_FIELD_RE, '');
  return CARD_ID_RE.test(id) ? id : null;
}

/** The card ids (tasks.json first, then claim keys) and release versions a hive has. */
export function targetIndex(taskIds: Iterable<string>, claimKeys: Iterable<string>): TargetIndex {
  const cards = new Map<string, string>();
  const releases = new Set<string>();
  for (const id of taskIds) if (typeof id === 'string' && CARD_ID_RE.test(id) && !cards.has(id.toLowerCase())) cards.set(id.toLowerCase(), id);
  for (const k of claimKeys) {
    if (typeof k !== 'string') continue;
    const c = cardOfKey(k);
    if (c && !cards.has(c.toLowerCase())) cards.set(c.toLowerCase(), c);
    const r = RELEASE_KEY_RE.exec(k);
    if (r) releases.add(r[1]);
  }
  return { cards, releases };
}

/** A short name → its only card: each run of two or more of a card id's hyphen words, and the stem of a
 *  `<stem>-<n>` id; a short name two cards share maps to null. */
function shortNames(ix: TargetIndex): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [lower, id] of ix.cards) {
    const words = lower.split('-');
    const mine = new Set<string>();
    for (let i = 0; i < words.length; i++) for (let j = i + 2; j <= words.length; j++) mine.add(words.slice(i, j).join('-'));
    const stem = /^(.+)-\d+$/.exec(lower);
    if (stem) mine.add(stem[1]);
    for (const s of mine) out.set(s, out.has(s) ? null : id);
  }
  return out;
}

/** The card a token names (see the header), or null. */
function cardOfToken(token: string, ix: TargetIndex, short: Map<string, string | null>): string | null {
  const key = cardOfKey(token);
  if (key) return ix.cards.get(key.toLowerCase()) ?? null;
  const name = token.replace(/^origin\//i, '').replace(/^guppy\//i, '').toLowerCase();
  return ix.cards.get(name) ?? short.get(name) ?? null;
}

/** The release version a token names, or null. */
function releaseOfToken(token: string, ix: TargetIndex): string | null {
  const r = RELEASE_KEY_RE.exec(token);
  const v = r ? r[1] : token.replace(RELEASE_PREFIX_RE, '');
  return VERSION_RE.test(v) && ix.releases.has(v) ? v : null;
}

/** The cards and releases these texts name, in mention order (texts[0] is the query), deduplicated, at most `max`. */
export function targetsIn(texts: readonly string[], ix: TargetIndex, max = 12): SearchTarget[] {
  const short = shortNames(ix);
  const out: SearchTarget[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const raw of text.match(/[A-Za-z0-9][A-Za-z0-9._/-]*/g) ?? []) {
      if (out.length >= max) return out;
      const token = raw.replace(/[._/-]+$/, '');
      const card = cardOfToken(token, ix, short);
      const v = card ? null : releaseOfToken(token, ix);
      const t: SearchTarget | null = card ? { kind: 'card', term: card } : v ? { kind: 'release', term: `release.${v}` } : null;
      if (!t) continue;
      const k = `${t.kind}\0${t.term.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
  }
  return out;
}
