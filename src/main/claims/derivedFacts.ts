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
 *   (h) card.<id>.audit           L4: the newest dated result/note entry that states an audit verdict (PASS or FAIL)
 *                                 with its commit (@<sha>): the verdict and that commit.
 *   (g) card.<id>.decision.m<h8>  R2 (research T4): each god ruling mail on the card, whole, in parts (h8 =
 *                                 the mail id's hash). Only mails the mail-card index links by a trusted
 *                                 method (field, reply, conversation, mention-subject); see isRulingMail.
 *
 * Card ids are lower-cased in keys (the registry's KEY_RE); an id that cannot make a key is skipped.
 *
 * Valid time (god e551de): each fact's `at` is when its source fact held, never the run's time: the
 * answer's (or question's) time, the note entry's date, the card's status-since and record times
 * (cardAt), the commit's time, the tag's or CHANGELOG section's date, the mail's time. A fact with
 * no source time is not written (syncDerived counts it as noTime).
 *
 * Structured value (L1, god 69bc66): every FIELD fact (status, assignee, fixversion, lastsha, audit, gitsha,
 * merge, donesha, release.<v>.bump, release.<v>.tag) carries `value`, the one value the field names, beside
 * its prose, so a reader prints it without cutting a window from the text. Decisions and CHANGELOG entries are prose.
 * A merge has two points, so its value is `<tip> into int-<v>` (god 0b71e3).
 */
import { createHash } from 'node:crypto';
import type { ClaimKind, Ref } from '../../shared/claims';

export interface DerivedFact { slot: string; key: string; kind: ClaimKind; text: string; at?: string; refs: Ref[]; value?: string; valueAgent?: string }

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
  createdAt?: unknown; startedAt?: unknown; updatedAt?: unknown; doneAt?: unknown; fixVersion?: unknown;
  /** Set by the reader: the harness's status-since for the card's current status (state/task-meta.json),
   *  its last edit there, and the time of the card's archive row. ISO strings. */
  statusSince?: unknown; lastEditAt?: unknown; archivedAt?: unknown;
}

/** The newest time the card's record was written (its value held then), else undefined. */
export function cardAt(c: CardLike): string | undefined {
  for (const v of [c.lastEditAt, c.updatedAt, c.doneAt, c.archivedAt, c.startedAt, c.createdAt]) { const t = iso(v); if (t) return t; }
  return undefined;
}

/** When the card's current status began: the harness's status-since, else the status's own stamp,
 *  else the card's record time (a todo card: its creation). */
export function statusAt(c: CardLike): string | undefined {
  const s = typeof c.status === 'string' ? c.status : '';
  return iso(c.statusSince) ?? (s === 'done' ? iso(c.doneAt) : undefined) ?? (s === 'doing' ? iso(c.startedAt) : undefined)
    ?? (s === 'todo' ? iso(c.createdAt) : undefined) ?? cardAt(c);
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
      out.push(...inParts(key, 'decision', `Human decision on ${c.id}`, whole, at ?? iso(qa.askedAt) ?? cardAt(c), refs));
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
/** A bare YYYY-MM-DD as that day's start (UTC). */
const dayAt = (s: unknown): string | undefined => { const m = typeof s === 'string' ? /^\[?(\d{4}-\d\d-\d\d)(?![T\d])/.exec(s.trim()) : null; return m ? iso(`${m[1]}T00:00:00Z`) : undefined; };

/** (f) The card's result and each note entry under card.<id>.decision.*, whole (R2: Jim D2/D3). */
export function cardRecordFacts(cards: readonly CardLike[]): DerivedFact[] {
  const out: DerivedFact[] = [];
  for (const c of cards) {
    if (typeof c?.id !== 'string') continue;
    const refs: Ref[] = [{ type: 'task', value: c.id }];
    const rk = cardKey(c.id, 'decision', 'result');
    if (rk && typeof c.result === 'string' && c.result.trim()) out.push(...inParts(rk, 'fact', `Card ${c.id} result`, fold(c.result), iso(c.doneAt) ?? cardAt(c), refs));
    const seen = new Set<string>();
    for (const e of noteEntries(c.notes)) {
      const h = `n${questionHash(e)}`;
      const k = cardKey(c.id, 'decision', h);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(...inParts(k, 'fact', `Card ${c.id} note`, fold(e), entryAt(e) ?? dayAt(e) ?? cardAt(c), refs));
    }
  }
  return out;
}

/** A mail from the per-card mail index: the cards it is linked to by a trusted method only. */
export interface RulingMailLike { id: string; from: string; act: string; subject?: string; body?: string; cards: string[]; at?: string }

/**
 * (g) A ruling: god's mail (not a done report) that says RULING (upper case) in its subject or body,
 * or ruling/ruled in its subject. Human answers are humanQA entries, already rule (a).
 */
export function isRulingMail(m: Pick<RulingMailLike, 'from' | 'act' | 'subject' | 'body'>, godId: string): boolean {
  if (m.from !== godId || m.act === 'done') return false;
  return /\bRULING\b/.test(`${m.subject ?? ''}\n${m.body ?? ''}`) || /\b(?:ruling|ruled)\b/i.test(m.subject ?? '');
}

/** (g) One fact per (card, ruling mail): the subject and the body, whole, at the mail's time. */
export function rulingMailFacts(mails: readonly RulingMailLike[]): DerivedFact[] {
  const out: DerivedFact[] = [];
  for (const m of mails) {
    const whole = fold([m.subject, m.body].filter((s) => typeof s === 'string' && s.trim()).join(' — '));
    if (!whole) continue;
    const h = `m${createHash('sha256').update(m.id).digest('hex').slice(0, 8)}`;
    for (const card of [...new Set(m.cards)]) {
      const k = cardKey(card, 'decision', h);
      if (!k) continue;
      out.push(...inParts(k, 'fact', `Card ${card} ruling`, whole, iso(m.at), [{ type: 'task', value: card }, { type: 'msg', value: m.id }]));
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
  /** The commit's message (subject and body), or null; optional (R2: settles a done mail naming several
   *  cards). Only its SUBJECT (first line) confirms a card: CHANGELOG, cut and int merge commits list
   *  many cards in their bodies (CLAIMS-WEAKLINK-DONESHA round 2, Jim M-b). */
  message?(commit: string): Promise<string | null>;
  /** The commit's parents (full shas, first parent first), or null when git cannot say; optional
   *  (CLAIMS-WEAKLINK-DONESHA round 3, B): a commit with two or more parents is a merge and confirms
   *  nothing on its own sha. Without the method every commit counts as a plain one. */
  parents?(commit: string): Promise<string[] | null>;
  /** The paths the commit changes, or null when git cannot say; optional (round 3, A): a commit that
   *  changes only CHANGELOG/docs files confirms nothing. Without the method files are unknown. */
  changedFiles?(commit: string): Promise<string[] | null>;
  /** Round 7 (god 3af596, R7-2): whether every changed line of every non-doc file the commit touches
   *  pairs with its counterpart identically once N.N.N version tokens are masked (a version bump, in
   *  any file, tests included), or null when git cannot say; optional. Without it any non-doc file
   *  counts as a code change. */
  versionOnly?(commit: string): Promise<boolean | null>;
  /** Round 10 (god a22191, F5): the commits of the range from..to (git's `from..to`: reachable from `to`
   *  and not from `from`), full shas, oldest first, or null when git cannot say; optional. With it a
   *  done mail reporting A..B reports the card's own commits in the range (see doneMailFacts); without
   *  it both ends count as named commits. */
  rangeCommits?(from: string, to: string): Promise<string[] | null>;
  /** Round 10 (Jim's gate, must 6): the full sha the branch `name` (guppy/<id>) points at, origin's copy first,
   *  or null when no such ref exists. Without the method a pair written by a card's own name is taken as written. */
  refCommit?(name: string): Promise<string | null>;
  /** Round 10 re-gate (Jim 42dc40, must A): the guppy/<id> branch names (origin's copy first, as refCommit)
   *  whose tip reaches the commit, or null when git cannot say; optional. With it the pairing check asks git
   *  once per distinct sha; without it, one isAncestor per board card branch (small fake ports only). */
  branchesContaining?(commit: string): Promise<Set<string> | null>;
}

/** A changed path that is documentation: a CHANGELOG (no extension or a text one) anywhere, anything
 *  under docs/, any .md file. */
export const isDocFile = (p: string): boolean =>
  /(?:^|\/)changelog(?:[^/]*\.(?:md|markdown|txt|rst))?$|^docs\/|\.(?:md|markdown)$/i.test(p.trim().replace(/\\/g, '/'));

/** Round 6 (god 18e97a): an int card, its id starting INT-: only a merge into its own line is ever its
 *  done sha, by field, link or subject (R6-3). */
export const isIntCard = (id: string): boolean => /^int-/i.test(id);

/** Round 6 (god 18e97a): a cut/release card (RELEASE-N.N, CUT-N.N, or an id carrying a version N.N.N that is
 *  no int card): the only card a version/changelog/readme/docs-only commit confirms or is carried for.
 *  Gate R4 (Jim 2699a7): a version card, never a fix card whose name starts with RELEASE- and ends in a card number
 *  (RELEASE-WIDGET-301 is a fix card; RELEASE-9.4.2 and CUT-9.4.2 are release cards). Jim 805d71: the board names
 *  cuts by a bare build number too (CUT-301 = the 9.3.01 cut), so the prefix plus a number and nothing more is a
 *  release card; a word after the prefix (CUT-CMD-THING) makes a fix card. */
export const isReleaseCard = (id: string): boolean => !isIntCard(id) && (/^(?:release|cut)-\d+(?:\.\d+)*$/i.test(id) || /\d+\.\d+\.\d+/.test(id));

/** Round 6/7 (R6-2, R7-2): the changed files are all docs, or every changed line of every non-doc file is
 *  a version-masked twin of its counterpart (GitPort.versionOnly): the commit is release bookkeeping. */
async function releaseOnly(full: string, files: readonly string[], git: GitPort): Promise<boolean> {
  if (files.every(isDocFile)) return true;
  return !!git.versionOnly && (await git.versionOnly(full)) === true;
}

/** The branch a merge commit's subject says it merged ("Merge guppy/x-1 @abc into int", "Merge branch
 *  'guppy/x-1'", "Merge pull request #7 from org/guppy/x-1"), or '' for none / not a merge subject. */
export function mergedBranch(subject: string): string {
  const m = /^Merge\s+(?:pull\s+request\s+#\d+\s+from\s+|(?:remote-tracking\s+)?branch\s+)?'?([^\s']+)'?/i.exec(subject);
  return m ? m[1] : '';
}

/** The line a merge commit's subject says it merged INTO ("Merge guppy/x-1 @abc into guppy/int-9.1.2
 *  stage 2", "int-9.1.2 stage 2: merge guppy/x-1"), or '' for none. Round 5 (god bfcff1): the whole
 *  line name, to " stage", a "(" or the end ("into INT 9.9.9 stage 20" is the line "INT 9.9.9"), never
 *  one token; the caller's card recogniser reads it. */
export function mergedInto(subject: string): string {
  const m = /^Merge\s.*?\binto\s+'?(.+?)'?(?:\s+stage\b.*|\s*\(.*)?$/i.exec(subject);
  if (m) return m[1].trim();
  const l = /^'?([^':]+?)'?(?:\s+stage\s+\S+)?:\s+merge\s/i.exec(subject);
  return l ? l[1].trim() : '';
}

/** A commit a done mail reports, resolved to the work it stands for (round 3). */
export interface ReportedCommit {
  /** The commit a row would carry: the commit itself, or, through a merge, the merged parent. */
  commit: string;
  /** The text that may name a card: the commit's subject line and, through a merge, the branch the
   *  merge's subject says it merged. For a merge itself (`into`) this is its whole subject, kept for
   *  the record only: every judgment reads `into`, the line it merged into (round 7, Jim's P10). */
  text: string;
  /** The merge the mail wrote, when the commit was reached through one (a merge confirms nothing and
   *  is never the reported sha, except for the line it merged into: `into`). */
  merge?: string;
  /** Every merge the commit was reached through, innermost first (round 4b: a parent below a merge into
   *  the card's own line is not the card's value). */
  chain?: string[];
  /** The commit changes only CHANGELOG/docs files (or none), or (rounds 6/7, R6-2/R7-2) its every other
   *  changed line is a version-masked twin of its counterpart: it confirms, and is carried for, no card
   *  but a cut/release card (isReleaseCard), or (round 7, R7-1) an int card by its card field. */
  docsOnly: boolean;
  /** Round 4b (god aa8321): the commit is a merge and this is the line it merged into (its subject says
   *  so, or an earlier merge on its first-parent chain does). For the card that owns that line the
   *  merge IS the card's own work: the row carries the merge sha and its merged parents are not
   *  descended. For every other card the entry is dropped and the merged parents count as round 3. */
  into?: string;
}

const MERGE_DEPTH = 3;
/** F5: the most commits a written range is listed for; a longer one keeps the both-ends reading. */
const RANGE_MAX = 200;

/**
 * The commits a reported sha stands for (CLAIMS-WEAKLINK-DONESHA round 3, Jim's gate on 844a3ddf):
 * a plain commit is itself, with its subject and whether it changes only docs; a merge (2+ parents)
 * is never itself: it is each merged (non-first) parent, resolved the same way, with the merge's
 * branch name added to the text, so an int/rc merge of the card's branch resolves to the card's own
 * tip and a merge of something else resolves to a commit naming another card or none (dropped by
 * the caller). Nested merges resolve up to MERGE_DEPTH deep; deeper gives nothing.
 */
export async function resolveReported(full: string, git: GitPort, depth = 0): Promise<ReportedCommit[]> {
  const parents = git.parents ? await git.parents(full) : null;
  const message = git.message ? await git.message(full) : null;
  const subject = commitSubject(message);
  if (parents && parents.length >= 2) {
    if (depth >= MERGE_DEPTH) return [];
    const branch = mergedBranch(subject);
    // Round 4b: the merge itself, for the line it merged into (the caller keeps it only for that card).
    const into = await mergedIntoOf(subject, parents, git);
    const out: ReportedCommit[] = into ? [{ commit: full, text: subject, docsOnly: false, into }] : [];
    for (const p of parents.slice(1)) {
      for (const r of await resolveReported(p, git, depth + 1)) {
        if (out.some((x) => x.commit === r.commit)) continue;
        out.push(r.into !== undefined ? r : { ...r, text: branch ? `${r.text} ${branch}` : r.text, merge: full, chain: [...(r.chain ?? []), full] });
      }
    }
    return out;
  }
  const files = git.changedFiles ? await git.changedFiles(full) : null;
  // Round 10 (F5): a cherry-pick names what its source names ("(cherry picked from commit X)" in the
  // message): the source's subject joins the text, as a merge's branch name does.
  const source = cherryPickSource(message);
  const sourceSubject = source && git.message ? commitSubject(await git.message(source)) : '';
  const text = sourceSubject && sourceSubject !== subject ? `${subject} ${sourceSubject}` : subject;
  return [{ commit: full, text, docsOnly: files !== null && (await releaseOnly(full, files, git)) }];
}

/** The commit a message says it was cherry-picked from (git's "(cherry picked from commit <sha>)"), or ''. */
export function cherryPickSource(message: string | null | undefined): string {
  if (typeof message !== 'string') return '';
  const m = message.match(/\(cherry picked from commit ([0-9a-f]{7,40})\)/i);
  return m ? m[1].toLowerCase() : '';
}

/** The line a merge merged into: what its subject says, else what an earlier merge on its first-parent
 *  chain says (a stage chain on an INT line: "int-9.1.2 stage 3" merged on top of "... into int-9.1.2"),
 *  up to MERGE_DEPTH steps back; '' when nothing says. */
async function mergedIntoOf(subject: string, parents: readonly string[], git: GitPort): Promise<string> {
  const own = mergedInto(subject);
  if (own || !git.parents) return own;
  let p: string | undefined = parents[0];
  for (let i = 0; i < MERGE_DEPTH && p; i++) {
    const pp = await git.parents(p);
    if (!pp || pp.length < 2) return '';
    const t = mergedInto(commitSubject(git.message ? await git.message(p) : null));
    if (t) return t;
    p = pp[0];
  }
  return '';
}

const SHA_RE = /(?<![0-9A-Za-z])([0-9a-f]{7,40})(?:(\.\.\.?)([0-9a-f]{7,40}))?(?![0-9A-Za-z])/g;
/** A hex word that could be a sha: 7-40 hex with at least one digit and one letter (no words). A sha
 *  of digits only (58102304) counts when written as @<sha> or when it has 8 or more digits and is not a
 *  YYYYMMDD date; git still
 *  decides whether it is a commit, so a date or a count that is not one is dropped there. */
const DATE8 = /^(?:19|20)\d\d(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/;
const shaLike = (s: string, at = false): boolean => /[0-9]/.test(s) && (/[a-f]/.test(s) || at || (s.length >= 8 && !DATE8.test(s)));

/** `range.end`: which end of a written `a..b` the sha is; 'in' marks a commit of the range itself (F5). */
export interface ShaMention { sha: string; range?: { from: string; to: string; end: 'from' | 'to' | 'in' } }

/** The sha-like words in text, in order, each once; `a..b` (or `a...b`) gives both ends, marked. */
export function shaMentions(text: unknown): ShaMention[] {
  if (typeof text !== 'string' || !text) return [];
  const out: ShaMention[] = [];
  const seen = new Set<string>();
  const add = (m: ShaMention, at = false): void => { if (shaLike(m.sha, at) && !seen.has(m.sha)) { seen.add(m.sha); out.push(m); } };
  for (const m of text.matchAll(SHA_RE)) {
    const [, a, dots, b] = m;
    // Must 7: "@ sha" (a space after the @) is an @sha as well.
    const i = m.index ?? 0;
    const at = i > 0 && (text[i - 1] === '@' || (i > 1 && text[i - 1] === ' ' && text[i - 2] === '@'));
    if (dots && b && shaLike(a, at) && shaLike(b, at)) {
      add({ sha: a, range: { from: a, to: b, end: 'from' } });
      add({ sha: b, range: { from: a, to: b, end: 'to' } });
    } else if (!dots) add({ sha: a }, at);
  }
  return out;
}

/**
 * The shas a done mail reports in its subject as `@<sha>` (`CARD @<sha>`; must 7: `@ <sha>` too), lower-cased,
 * once each, with the word written just before each (lower-cased, edge punctuation trimmed):
 * `guppy/x-1 @abc1234` -> guppy/x-1.
 */
export function subjectAtShas(subject: unknown): Array<{ sha: string; name: string }> {
  if (typeof subject !== 'string') return [];
  const out: Array<{ sha: string; name: string }> = [];
  // F5: `@a..b` is a range, not a reported @sha.
  for (const m of subject.matchAll(/(?<![0-9A-Za-z])@ ?([0-9a-fA-F]{7,40})(?![0-9A-Za-z]|\.{2,3}[0-9a-fA-F])/g)) {
    const sha = m[1].toLowerCase();
    if (!/[0-9]/.test(sha) || out.some((x) => x.sha === sha)) continue;
    const before = subject.slice(0, m.index).trimEnd().split(/\s+/).pop() ?? '';
    out.push({ sha, name: before.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '').toLowerCase() });
  }
  return out;
}

/** A token that can pair with an @sha: upper-case segments, a version-like tail allowed (INT-1.2). */
const PAIR_TOKEN_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+(?:\.[0-9]+)*)*$/;

/** Round 10 (Jim's gate, must 6): whether `token` (upper-case) is `id`'s form for a pairing: an own form
 *  (isOwnForm) or the id's LEADING segments, the first with a letter (ABC and ABC-CRAWL for ABC-CRAWL-19). */
export function isPairForm(token: string, id: string): boolean {
  if (isOwnForm(token, id)) return true;
  const ts = token.split('-'), cs = id.toUpperCase().split('-');
  // A line word alone (INT, RC, STAGE: "on int @sha") names the line, not the int card whose id leads with it.
  if (ts.length === 1 && LINE_WORD_RE.test(ts[0])) return false;
  return ts.length < cs.length && /[A-Z]/.test(ts[0]) && token === cs.slice(0, ts.length).join('-');
}

/** Round 10 (Jim's gate, must 6): whether `name`, the word written straight before an @sha (lower-cased), is
 *  `card`'s own: its id, its branch (guppy/<id>, origin/guppy/<id>), or a pair form (isPairForm) of it and of
 *  no other card among `ids`. */
export function pairName(name: string, card: string, ids: readonly string[]): boolean {
  const id = card.toLowerCase();
  if (name === id || name === `guppy/${id}` || name === `origin/guppy/${id}`) return true;
  const t = name.replace(/^(?:origin\/)?guppy\//, '').toUpperCase();
  if (!PAIR_TOKEN_RE.test(t)) return false;
  const fits = ids.filter((c) => isPairForm(t, c));
  return fits.length === 1 && fits[0] === card;
}

/**
 * The subject @sha of a done mail on `card` (god ab86be, Jim b3803c, DV007), or null when it writes
 * none. One is the mail's sha. Of several: the descendant when they form an ancestry chain; else the
 * one written next to the card's id, its branch name (guppy/<id>) or (must 6) its pair form, unique among
 * `ids`; else 'ambiguous' (never guess).
 */
export async function subjectTip(shas: ReadonlyArray<{ sha: string; name: string; full?: string }>, card: string, git: GitPort, ids: readonly string[] = [card]): Promise<string | null | 'ambiguous'> {
  if (shas.length <= 1) return shas[0]?.sha ?? null;
  const full: string[] = [];
  for (const x of shas) {
    const f = x.full ?? await git.commitOf(x.sha);
    if (f) full.push(f);
  }
  if (full.length === shas.length) {
    for (let i = 0; i < full.length; i++) {
      let tip = true;
      for (let j = 0; j < full.length && tip; j++) if (full[j] !== full[i] && !(await git.isAncestor(full[j], full[i]))) tip = false;
      if (tip) return shas[i].sha;
    }
  }
  const next = shas.filter((x) => pairName(x.name, card, ids));
  return next.length === 1 ? next[0].sha : 'ambiguous';
}

/** A subject's segments: split on ';' and on ' - ' (round 9, P2: a reply that reports several items). */
const SEGMENT_RE = /;|\s[-–—]\s/;
/** A segment that reports an item: it names a card (known or card-shaped) or states a status. */
const STATUS_WORD_RE = /\b(?:pass|fail|done|landed|merged|released|cut|shipped|verdicts?)\b/i;
/** A segment about a line rather than a card: an int, rc or stage line (gate R2). */
const LINE_WORD_RE = /(?<![A-Za-z0-9])(?:int|rc|stage)(?![A-Za-z])/i;
/** A segment that says nothing but a verdict: status words, counts (0/0/0) and an @sha (gate R2, " - PASS 0/0/0"). */
const VERDICT_ONLY_RE = /^(?:[\s,.:()!-]*(?:pass|fail|done|landed|merged|released|cut|shipped|verdicts?|\d[\d/]*|@ ?[0-9a-f]{7,40}))+[\s,.:()!-]*$/i;

/**
 * Round 9 (P2): whether a done mail's LONE subject @sha counts for `card` on a link or subject row. It
 * does when (i) the word before it is the card's id or branch; (ii) the subject segment it sits in names
 * the card or its branch, or names no item; or (iii) the subject reports one item only. Otherwise the
 * sha may belong to another item the reply reports, and the row is ambiguous (never guess).
 */
export function loneAtCounts(subject: string, at: { sha: string; name: string }, card: string, names: (text: unknown) => CardNames, ids: readonly string[] = [card]): boolean {
  const id = card.toLowerCase();
  if (pairName(at.name, card, ids)) return true;
  const branchRe = new RegExp(`guppy/${escapeRe(id)}(?![A-Za-z0-9-])`, 'i');
  // Gate R2: a short form of the card's own id (an id suffix, WIDGET-101 for ALPHA-WIDGET-101) names the card
  // on its own row even when another card shares the suffix.
  const namesCard = (s: string): boolean => { const n = names(s); return n.cards.includes(card) || n.others.some((o) => { const t = o.toLowerCase(); return t === id || id.endsWith(`-${t}`); }) || branchRe.test(s); };
  const namesAny = (s: string): boolean => { const n = names(s); return n.cards.length > 0 || n.others.length > 0 || namesCard(s); };
  // Gate R2: a segment that says nothing but a verdict (" - PASS 0/0/0", "done @sha") is the verdict of the item
  // before it, not an item of its own; it folds into that segment. A segment with any other word ("B-2 FAIL")
  // is an item; a line word (int, rc, stage) makes a segment an item too. A sha-only segment names no item (ii).
  const segments = subjectSegments(subject);
  const isItem = (s: string): boolean => namesAny(s) || LINE_WORD_RE.test(s) || STATUS_WORD_RE.test(s);
  const atRe = new RegExp(`@ ?${at.sha}(?![0-9A-Za-z])`, 'i');
  const seg = segments.find((s) => atRe.test(s)) ?? subject;
  if (namesCard(seg) || !isItem(seg)) return true;
  return segments.filter(isItem).length <= 1;
}

/** A subject's segments (SEGMENT_RE) with each verdict-only segment folded into the one before it. */
function subjectSegments(subject: string): string[] {
  const segments: string[] = [];
  for (const s of subject.split(SEGMENT_RE)) {
    if (segments.length && STATUS_WORD_RE.test(s) && VERDICT_ONLY_RE.test(s)) segments[segments.length - 1] += ` ${s}`;
    else segments.push(s);
  }
  return segments;
}

/**
 * Round 10 (god a22191, F2): the subject @shas (as written, lower-cased) a done mail pairs with EACH of
 * the cards its subject names, by segment: an @sha written after a card's id or branch (guppy/<id>) is
 * that card's; a segment with one other @sha gives it to every card the segment names ("A + B: PASS
 * @sha"); as many other @shas as cards pair in order of appearance; any other count is 'ambiguous' for
 * those cards (never guess). A card named in no segment with an @sha gets none. Must 6: the name before
 * an @sha is a card's when it is its pair form, unique among `ids` (the board), like its id or branch.
 * Must 7: `body` pairs (name, sha) read from the mail's body lines pair with the card they name first; a
 * card paired so is not open for a segment's unnamed @sha.
 */
export function pairedAtShas(subject: string, cards: readonly string[], names: (text: unknown) => CardNames, ids: readonly string[] = cards, body: ReadonlyArray<{ sha: string; name: string }> = []): Map<string, string[] | 'ambiguous'> {
  const out = new Map<string, string[] | 'ambiguous'>(cards.map((c) => [c, []]));
  const give = (card: string, sha: string): void => { const v = out.get(card); if (Array.isArray(v) && !v.includes(sha)) v.push(sha); };
  const ownName = (card: string, name: string): boolean => pairName(name, card, ids);
  const bodyNamed = new Set<string>();
  for (const b of body) for (const c of cards) if (ownName(c, b.name)) { give(c, b.sha); bodyNamed.add(c); }
  for (const seg of subjectSegments(subject)) {
    const segCards = cards.filter((c) => names(seg).cards.includes(c));
    const ats = subjectAtShas(seg);
    if (!segCards.length || !ats.length) continue;
    const named = ats.filter((a) => cards.some((c) => ownName(c, a.name)));
    for (const a of named) for (const c of cards) if (ownName(c, a.name)) give(c, a.sha);
    const rest = ats.filter((a) => !named.includes(a));
    const open = segCards.filter((c) => !named.some((a) => ownName(c, a.name)) && !bodyNamed.has(c));
    if (!rest.length) continue;
    if (ats.length === 1) { for (const c of open) give(c, ats[0].sha); continue; }
    if (rest.length === 1) { for (const c of open) give(c, rest[0].sha); continue; }
    const at = (c: string): number => seg.search(new RegExp(`(?<![A-Za-z0-9.-])${escapeRe(c).replace(/-/g, '[- ]?')}(?![A-Za-z0-9])`, 'i'));
    const inOrder = open.map((c) => [c, at(c)] as const);
    if (rest.length === open.length && inOrder.every(([, i]) => i >= 0)) {
      inOrder.sort((a, b) => a[1] - b[1]).forEach(([c], i) => give(c, rest[i].sha));
      continue;
    }
    for (const c of open) out.set(c, 'ambiguous');
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
  return latestOfCommits(commits, git);
}

/** latestInGitOrder over commits already resolved to full shas (each once). */
export async function latestOfCommits(commits: readonly string[], git: GitPort): Promise<string | null> {
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
      value: best,
    });
  }
  return out;
}

/**
 * A merge into an INT line, in both subject forms git history uses (god 0b71e3):
 * `Merge [branch |remote-tracking branch |commit ][guppy ]<ref> [words] into <target> [words]` and
 * `<target>[ stage <n>]: merge <ref> [words]`. The target is `int-<v>`, `int/release-<v>`, `INT <v>` or a
 * bare version, after an optional `origin/` and `guppy/`; every form is normalised to int-<v>. A merge into
 * `rc/<v>` keeps its own target, rc-<v>, never int (god d77de8), under its own key (the INT key + `.rc`), so a
 * later rc merge never supersedes the INT merge (god 234b13). The tip is
 * the sha right after the ref (`@<sha>`, `@ <sha>`, `(<sha>`, `<sha>`; in the line form the first `@<sha>`),
 * else the merge's second parent. `single` says the ref stands alone (no free words before the tip), so
 * it can name a branch. Other targets (main, feature, release-, integration/, v0.x, prose and versionless lines)
 * are not INT lines.
 */
const MERGE_INT = String.raw`'?(?:origin\/)?(?:guppy\/)?(rc\/)?(?:int-|int\/release-|int\s+)?(\d+(?:\.\d+)+)(?![0-9A-Za-z]|\.\d)`;
const MERGE_RE = new RegExp(String.raw`^Merge\s+(?:(?:remote-tracking\s+)?branch\s+|commit\s+)?(?:guppy\s+)?'?([^\s']+)'?((?:\s+(?!into\s)\S+)*?)\s+into\s+${MERGE_INT}`, 'i');
const MERGE_LINE_RE = /^(rc\/)?(?:int-|int\s+)?(\d+(?:\.\d+)+)(?:\s+stage\s+\S+)?:\s+merge\s+'?([^\s']+)'?(.*)$/i;
const TIP_NEXT_RE = /^\s*(?:@\s?|\()?([0-9a-f]{7,40})(?![0-9A-Za-z])/i;
const TIP_AT_RE = /@\s?([0-9a-f]{7,40})(?![0-9A-Za-z])/i;

/** The ref, the tip sha when the subject names one, the target as int-<v> (or rc-<v>), and whether the ref stands alone; null when it is not a merge into an INT or rc line. */
export function mergeSubject(subject: string): { ref: string; sha?: string; int: string; single: boolean } | null {
  const m = MERGE_RE.exec(subject);
  const l = m ? null : MERGE_LINE_RE.exec(subject);
  if (!m && !l) return null;
  const [ref, rest, rc, v] = m ? [m[1], m[2], m[3], m[4]] : [l![3], l![4], l![1], l![2]];
  const next = TIP_NEXT_RE.exec(rest);
  const sha = (m ? next : TIP_AT_RE.exec(rest))?.[1];
  const sha1 = sha && /[0-9]/.test(sha) ? sha : undefined;
  return { ref, ...(sha1 ? { sha: sha1 } : {}), int: `${rc ? 'rc' : 'int'}-${v}`, single: !rest.trim() || (!!m && !!sha1) || /^\s*[@(]/.test(rest) };
}

/**
 * Merge class (god c33130): per merge commit into an INT, the merged tip and the INT, latest-wins per
 * owner: card.<id>.merge when a card owns the branch (its id equals the branch name, or the message
 * names the card itself), else branch.<name> (the name as in git, lower-cased).
 */
export async function mergeFacts(log: ReadonlyArray<{ commit: string; time: number; message: string; parents?: readonly string[] }>, cardIds: readonly string[], git: GitPort): Promise<DerivedFact[]> {
  const known = new Map(cardIds.map((c) => [c.toLowerCase(), c]));
  const newest = new Map<string, { commit: string; time: number; branch: string; tip: string; int: string; card: string | null }>();
  for (const c of log) {
    const m = mergeSubject(c.message.split('\n')[0].trim());
    const tip = m?.sha ?? c.parents?.[1];
    if (!m || !tip) continue;
    const branch = m.ref.replace(/^origin\//i, '').replace(/^guppy\//i, '');
    const card = known.get(branch.toLowerCase()) ?? null;
    // a free-worded ref ("build leftovers username") or a bare commit names no branch
    const named = m.single && !/^[0-9a-f]{7,40}$/i.test(branch);
    // an rc merge is its own fact (god 234b13): key + `.rc`, so it never supersedes the INT merge
    const rc = m.int.startsWith('rc-') ? ['rc'] : [];
    const bKey = ['branch', branch.toLowerCase(), ...rc].join('.');
    const key = card ? cardKey(card, 'merge', ...rc) : named && keyOk(bKey) ? bKey : null;
    if (!key) continue;
    const prior = newest.get(key);
    if (prior && (prior.time > c.time || (prior.time === c.time && prior.commit > c.commit))) continue;
    newest.set(key, { commit: c.commit, time: c.time, branch: m.ref, tip: tip.toLowerCase(), int: m.int.replace(/^int/, 'INT'), card });
  }
  const out: DerivedFact[] = [];
  for (const [key, x] of [...newest].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const tipFull = await git.commitOf(x.tip);
    const tip = tipFull ?? x.tip;
    const int = known.get(x.int.toLowerCase()) ?? x.int;
    const who = x.card ? `Card ${x.card}: branch ${x.branch}` : `Branch ${x.branch}`;
    out.push({
      slot: key, key, kind: 'fact',
      text: `${who} was last merged into ${int} at tip ${tip.slice(0, 8)} (${tip}${tipFull ? '' : ', not in the repository'}) by merge commit ${x.commit.slice(0, 8)} (${x.commit})`,
      ...(x.time > 0 ? { at: new Date(x.time * 1000).toISOString() } : {}),
      refs: [
        ...(x.card ? [{ type: 'task' as const, value: x.card }] : []),
        ...(known.has(int.toLowerCase()) ? [{ type: 'task' as const, value: int }] : []),
        ...(tipFull ? [{ type: 'commit' as const, value: tipFull }] : []),
        { type: 'commit' as const, value: x.commit },
      ],
      value: `${tip} into ${x.int.toLowerCase()}`,
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
      const at = statusAt(c);
      out.push({ slot: status, key: status, kind: 'fact', text: `Card ${id}${title} status: ${clip(c.status, 40)}`, ...(at ? { at } : {}), refs: [task], value: clip(c.status, 40) });
    }
    const assignee = cardKey(id, 'assignee');
    if (assignee) {
      const who = typeof c.assignee === 'string' && c.assignee.trim() ? clip(c.assignee, 80) : null;
      const at = cardAt(c);
      out.push({ slot: assignee, key: assignee, kind: 'fact', text: who ? `Card ${id}${title} is assigned to ${who}` : `Card ${id}${title} has no assignee`, ...(at ? { at } : {}), refs: [task], value: who ?? 'none' });
    }
    const fixversion = cardKey(id, 'fixversion');
    if (fixversion) {
      const v = typeof c.fixVersion === 'string' && c.fixVersion.trim() ? clip(c.fixVersion.trim(), 40) : null;
      const at = cardAt(c);
      out.push({ slot: fixversion, key: fixversion, kind: 'fact', text: v ? `Card ${id}${title} fix version: ${v}` : `Card ${id}${title} has no fix version`, ...(at ? { at } : {}), refs: [task], value: v ?? 'none' });
    }
    const lastsha = cardKey(id, 'lastsha');
    if (lastsha && git) {
      const shas = [...shaMentions(c.result), ...shaMentions(c.notes)].map((m) => m.sha);
      const best = shas.length ? await latestInGitOrder(shas, git) : null;
      if (best) {
        const t0 = await git.time(best);
        out.push({ slot: lastsha, key: lastsha, kind: 'fact', text: `Card ${id}${title} last commit (latest in git order of the commits its result and notes name): ${best.slice(0, 8)} (${best})`, ...(t0 > 0 ? { at: new Date(t0 * 1000).toISOString() } : {}), refs: [task, { type: 'commit', value: best }], value: best });
      }
    }
    const audit = cardKey(id, 'audit');
    const v = audit ? auditVerdict(c) : null;
    if (audit && v) {
      const full = git ? await git.commitOf(v.sha) : null;
      const sha = full ?? v.sha;
      out.push({ slot: audit, key: audit, kind: 'fact', text: `Card ${id}${title} latest audit verdict (the newest dated result or note entry that states one): ${v.verdict} at commit ${sha.slice(0, 8)} (${sha})`, at: v.at, refs: [task, ...(full ? [{ type: 'commit' as const, value: full }] : [])], value: `${v.verdict} ${sha}` });
    }
  }
  return out;
}

/** An audit word, then (within the entry) a verdict and its commit: `AUDIT ... PASS ... @<sha>`. */
const AUDIT_WORD_RE = /\b(?:re-?)?audit\w*|\bre-?check\w*|\bfinal\b|\bverdict\b/i;
const VERDICT_RE = /\b(PASS|FAIL)\b[^@\n]{0,60}?@([0-9a-fA-F]{7,40})(?![0-9A-Za-z])/g;
/** Round 9 (P4): an entry written sha-first: `@<sha>, Jim PASS` or `@<sha> ... PASS` within the clause. */
const SHA_FIRST_RE = /@([0-9a-fA-F]{7,40})(?![0-9A-Za-z])((?:(?!\.\s)[^@;\n]){0,60}?)(?:\s|\()((?:[A-Z][a-z]+|god)\s+)?(PASS|FAIL)\b/g;
/** Round 9 (P4, the caution): a clause about ANOTHER line's tip (LANDED in int-…, merged into, stage-N):
 *  its verdict is that line's, never the card's audit. */
const OTHER_LINE_RE = /\bLANDED\b|\bmerged\s+into\b|\bstage-?\s?\d|(?<![A-Za-z0-9])(?:int|rc)[-\s]\d/i;
/** A clause ends at ';', a line break or a sentence end ('. ' or a final '.'): gate R3, a later sentence of the
 *  entry ("Queued INT stage 20") is not the verdict's clause, and "@sha. Core PASS" is not sha-first. */
const CLAUSE_BREAK_RE = /;|\n|\.(?=\s|$)/g;
/** The [start, end) of the clause around position i. */
const clauseBounds = (e: string, i: number): [number, number] => {
  let start = 0; let end = e.length;
  for (const m of e.matchAll(CLAUSE_BREAK_RE)) {
    const j = m.index ?? 0;
    if (j < i) start = j + 1; else { end = j; break; }
  }
  return [start, end];
};
/** The clause around position i. */
const clauseAt = (e: string, i: number): string => e.slice(...clauseBounds(e, i));
/** Gate R3 twin (E1b): the verdict-first form `<Agent> FAIL 2/0/0 @<sha>` states a verdict by its agent word
 *  (the same proper-name shape as sha-first) when the word sits right before the verdict in the sha's clause. */
const AGENT_BEFORE_RE = /(?:^|[\s(])(?:[A-Z][a-z]+|god)\s+$/;

/**
 * L4 (god 69bc66): the card's latest audit verdict: of the dated entries of its result and notes that name an
 * audit and state PASS or FAIL with a commit (@<sha>), the newest by date (on a tie, the later one written);
 * within an entry, the last verdict it states. The sha as written, lower-cased.
 */
export function auditVerdict(c: CardLike): { verdict: 'PASS' | 'FAIL'; sha: string; at: string } | null {
  let best: { verdict: 'PASS' | 'FAIL'; sha: string; at: string } | null = null;
  for (const e of [...noteEntries(c.result), ...noteEntries(c.notes)]) {
    const at = entryAt(e) ?? dayAt(e);
    if (!at) continue;
    const auditWord = AUDIT_WORD_RE.test(e);
    const found: Array<{ i: number; verdict: 'PASS' | 'FAIL'; sha: string }> = [];
    for (const m of e.matchAll(VERDICT_RE)) {
      const v = m.index ?? 0; const i = v + m[0].indexOf('@');
      // Gate R3 twin (E1b): `<Agent> FAIL 2/0/0 @<sha>` states a verdict without an audit word, like the sha-first
      // form, when the agent word, the verdict and the sha share one clause.
      if (!auditWord && !(AGENT_BEFORE_RE.test(e.slice(0, v)) && clauseBounds(e, i)[0] <= v)) continue;
      if (/[0-9]/.test(m[2]) && !OTHER_LINE_RE.test(clauseAt(e, i))) found.push({ i, verdict: m[1] as 'PASS' | 'FAIL', sha: m[2] });
    }
    // Round 9 (P4): sha-first, within one clause; `<agent> PASS` states an audit verdict on its own, a bare
    // PASS needs the entry's audit word; a clause about another line's tip (the caution) never counts.
    for (const m of e.matchAll(SHA_FIRST_RE)) {
      const i = m.index ?? 0;
      if (!/[0-9]/.test(m[1]) || OTHER_LINE_RE.test(clauseAt(e, i))) continue;
      const agent = m[3]?.trim();
      if (!auditWord && !agent) continue;
      found.push({ i, verdict: m[4] as 'PASS' | 'FAIL', sha: m[1] });
    }
    if (!found.length) continue;
    const last = found.reduce((a, b) => (b.i >= a.i ? b : a));
    if (!best || at >= best.at) best = { verdict: last.verdict, sha: last.sha.toLowerCase(), at };
  }
  return best;
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

/** CHANGELOG markup a reader does not type: bold (**) and code (`) marks. */
const plain = (s: string): string => s.replace(/\*\*|`/g, '');

/** The first commit that sets package.json "version" to each version (git log -G order). */
export type BumpMap = ReadonlyMap<string, { commit: string; time: number }>;

/**
 * release.<ver>: the section's date, headline, tag commit and version bump commit; release.<ver>.e<n>:
 * each entry's lead; release.<ver>.bump: the bump commit. Text is stored without CHANGELOG markup.
 */
export function releaseFacts(sections: readonly ChangelogSection[], tags: readonly TagLike[], bumps?: BumpMap): DerivedFact[] {
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
    const b = bumps?.get(v);
    if (b) parts.push(`version bump commit ${b.commit}`);
    let text = parts.join(', ');
    if (s?.headline) text = `${text}. ${clip(plain(s.headline), TEXT_MAX - len(text) - 2)}`;
    const refs: Ref[] = t ? [{ type: 'commit', value: t.commit }] : [];
    if (b && b.commit !== t?.commit) refs.push({ type: 'commit', value: b.commit });
    const at = iso(t?.date) ?? dayAt(s?.date) ?? (b && b.time > 0 ? new Date(b.time * 1000).toISOString() : undefined);
    out.push({ slot: key, key, kind: 'fact', text: clip(text, TEXT_MAX), ...(at ? { at } : {}), refs });
    const bk = `${key}.bump`;
    if (b && keyOk(bk)) {
      const bt = b.time > 0 ? new Date(b.time * 1000).toISOString() : at;
      out.push({ slot: bk, key: bk, kind: 'fact', text: `Guppy ${v} version bump: the first commit that sets package.json version to ${v} is ${b.commit.slice(0, 8)} (${b.commit})`, ...(bt ? { at: bt } : {}), refs: [{ type: 'commit', value: b.commit }], value: b.commit });
    }
    // L4: release.<ver>.tag, the tag's commit as its own field (release.<ver> stays prose).
    const tk = `${key}.tag`;
    const tt = t ? iso(t.date) ?? at : undefined;
    if (t && keyOk(tk) && tt) out.push({ slot: tk, key: tk, kind: 'fact', text: `Guppy ${v} release tag ${t.name} is commit ${t.commit.slice(0, 8)} (${t.commit})`, at: tt, refs: [{ type: 'commit', value: t.commit }], value: t.commit });
    (s?.entries ?? []).forEach((e, i) => {
      const ek = `${key}.e${i + 1}`;
      if (!keyOk(ek)) return;
      const head = `Guppy ${v}${s?.date ? ` (${s.date})` : ''} CHANGELOG${e.heading ? ` ${e.heading}` : ''}: `;
      out.push({ slot: ek, key: ek, kind: 'fact', text: `${head}${clip(plain(e.text), TEXT_MAX - len(head))}`, ...(at ? { at } : {}), refs });
    });
  }
  return out;
}

// ———————————————————————————————————————————————————————————— (d) done mails

export interface MailLike { id?: unknown; from?: unknown; act?: unknown; subject?: unknown; body?: unknown; card?: unknown; cards?: unknown; created_at?: unknown; in_reply_to?: unknown }

/** Round 10 (F4): what doneMailFacts may ask about the mails around a done mail. */
export interface DoneMailContext {
  /** The subject of the mail `id` (the one a done mail replies to), or undefined when unknown. */
  subjectOf?(id: string): string | undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a piece of text names: the known cards, and card-SHAPED tokens that are no known card. */
export interface CardNames { cards: string[]; others: string[] }

/** A token shaped like a card id that tasks.json does not know (an UPPER-KEBAB id such as a new card):
 *  it names "some other card" (round 5, god bfcff1), never a known one. */
const CARD_SHAPE_RE = /(?<![A-Za-z0-9./-])([A-Z][A-Z0-9]*(?:-[A-Z0-9]+(?:\.[0-9]+)*)+)(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;

/** Round 6 (god 18e97a): a one-segment word plus a number (UTF-8, SHA-1, HTTP-2) is a label, not a card
 *  shape; no board card is shaped so. A new card shaped so stays unseen (a documented residual). */
const LABEL_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;

const NUM_RE = /^[0-9]+$/;
/** A word (2+ upper-case characters, segments allowed) written straight before an @sha (must 6). */
const PAIR_WORD_RE = /(?<![A-Za-z0-9./-])([A-Z][A-Z0-9]+(?:-[A-Z0-9]+(?:\.[0-9]+)*)*)(?=\s?@ ?[0-9a-fA-F]{7,40}(?![0-9A-Za-z]))/g;
/** Round 10 re-gate (Jim 42dc40, must B): whether a card-shaped token the board lacks names a card (so the
 *  thread link does not enter): it has a word segment of 2+ letters AND a final all-digit (or dotted version)
 *  segment that is not the end of a letter+digit range. NEW-THING-99 and CUT-1.1.80 do; list labels such as
 *  X1-X3, D1-D8, R6-R11, J1-J10, PLAN-V4 or PHASE-D1-8 do not. */
export const strangerNamesCard = (t: string): boolean => {
  const seg = t.split('-');
  if (seg.length < 2) return false;
  if (!/^[0-9]+(?:\.[0-9]+)*$/.test(seg[seg.length - 1])) return false;
  if (/^[A-Z]+[0-9]+$/i.test(seg[seg.length - 2])) return false;
  return seg.slice(0, -1).some((s) => /^[A-Z]{2,}$/i.test(s));
};
/** Round 10 (must 2b): a conventional commit's scope at the start of a subject, "test(abc-hull): ..." or
 *  "fix(abc-hull)!: ...": a kebab token of two or more segments (a one-word scope is a topic, not a card). */
const SCOPE_RE = /^\s*[A-Za-z]+\(([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\)!?:/;
/** Round 10 (F1 a): a role suffix is one or more word segments with no digit (INT, RC, AUDIT, INT-AUDIT). */
const ROLE_SUFFIX_RE = /^[A-Z]+(?:-[A-Z]+)*$/;

/** A card id or a card field in its canonical form: lower-case, dashes and spaces dropped (round 9, P1). */
const canonCard = (s: string): string => s.toLowerCase().replace(/[-\s]/g, '');

/**
 * Round 8 (god 6b94a5, Jim 165f37): whether a commit subject's FIRST token is the card id, written with
 * its dashes as a dash or a space ('INT 9.1.2 fixup 4', 'INT-9.1.2 stage 3 fixup', 'int 9.1.2: pin'),
 * followed by a space, a colon or the end: the commit is the line's own. The id named later, another
 * id first, or a longer version (9.1.20, 9.1.2.1) is not.
 */
export function leadsWithCard(subject: string, id: string): boolean {
  const body = id.split('-').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-\\s]');
  return new RegExp(`^${body}(?=[\\s:]|$)`, 'i').test(subject);
}

/**
 * Round 6 (god 18e97a, R6-1): `token` (an UPPER-KEBAB token that is no known id) is a short form of the
 * card `id`: (a) the id plus or minus a trailing -NNN (FEAT-ALPHA-WIDGET-DRAW-123; SYN-BETA-PIPE for
 * SYN-BETA-PIPE-123); (b) a contiguous run of the id's segments, two or more of them, at least one not
 * a bare number: a prefix or a suffix (FEAT-ALPHA, WIDGET-DRAW) and, since round 10 (Jim's gate, must
 * 5a, closing the R6-4 residual), an INNER run too (ALPHA-WIDGET; WRAP-GAP for PRE-WRAP-GAP-12); (c) the
 * initials of the id's segments, alone or plus -ID / -NNN (FAWD, FAWD-ID, FAWD-7). A one-segment overlap
 * (DRAW-STUFF), a run broken by a foreign segment (LIMIT-RE-REBASE), a lower-case or one-segment
 * abbreviation never match: no guessing beyond these forms. The recogniser takes the token as the card
 * when exactly one known card fits, as "other" when several fit.
 */
export function isOwnForm(token: string, id: string): boolean {
  const t = token, c = id.toUpperCase();
  if (t === c) return true;
  if (t.startsWith(`${c}-`) && NUM_RE.test(t.slice(c.length + 1))) return true;
  // Round 10 (god a22191, F1 a): the id plus a ROLE suffix of word segments (ABC-12-INT, ABC-12-AUDIT) is a
  // form of the card, unless the longer token is itself a known card (the recogniser matched it first).
  if (t.startsWith(`${c}-`) && ROLE_SUFFIX_RE.test(t.slice(c.length + 1))) return true;
  if (c.startsWith(`${t}-`) && NUM_RE.test(c.slice(t.length + 1))) return true;
  const ts = t.split('-'), cs = c.split('-');
  if (ts.length >= 2 && ts.length < cs.length && ts.some((s) => !NUM_RE.test(s))) {
    for (let i = 0; i + ts.length <= cs.length; i++) if (t === cs.slice(i, i + ts.length).join('-')) return true;
  }
  if (cs.length < 2) return false;
  const initials = cs.map((s) => s[0]).join('');
  return t === initials || t === `${initials}-ID` || (t.startsWith(`${initials}-`) && NUM_RE.test(t.slice(initials.length + 1)));
}

/**
 * Guide A12, round 5 (god bfcff1): THE card-name recogniser, the one every rule reads (a commit subject,
 * a merge's "into" line, a mail subject or body): a known card id, case-insensitive, its dashes written
 * as a dash, a space or nothing ('INT 9.9.9', 'int-9.9.9', 'INT-9.9.9 stage 20'); the longest id wins and
 * a partial id never matches. A card-shaped token that is no known id is an "other" card.
 */
export function cardNamer(cardIds: readonly string[]): (text: unknown) => CardNames {
  const ids = [...new Set(cardIds.filter((c) => typeof c === 'string' && c.length >= 2))].sort((a, b) => b.length - a.length);
  const alt = ids.map((id) => escapeRe(id).replace(/-/g, '[- ]?')).join('|');
  const re = ids.length ? new RegExp(`(?<![A-Za-z0-9.-])(${alt})(?![A-Za-z0-9]|[.-][A-Za-z0-9])`, 'gi') : null;
  const canon = new Map(ids.map((id) => [id.toLowerCase().replace(/[- ]/g, ''), id]));
  return (text) => {
    if (typeof text !== 'string' || !text) return { cards: [], others: [] };
    const cards: string[] = [];
    let rest = text;
    if (re) {
      for (const m of text.matchAll(re)) {
        const id = canon.get(m[1].toLowerCase().replace(/[- ]/g, ''));
        if (id && !cards.includes(id)) cards.push(id);
      }
      rest = text.replace(re, ' ');
    }
    const others: string[] = [];
    const place = (t: string, formOnly = false, pair = false): void => {
      if (canon.has(t.toLowerCase().replace(/[- ]/g, '')) || others.includes(t)) return;
      // Round 6 (god 18e97a, R6-1): a short form of exactly one known card names that card; of several,
      // some other card; a label (UTF-8, SHA-1) that is no card's form names nothing.
      const fits = ids.filter((id) => (pair ? isPairForm(t, id) : isOwnForm(t, id)));
      if (fits.length === 1) { if (!cards.includes(fits[0])) cards.push(fits[0]); return; }
      if (!fits.length && (formOnly || LABEL_RE.test(t))) return;
      others.push(t);
    };
    for (const m of rest.matchAll(CARD_SHAPE_RE)) place(m[1]);
    // Round 10 (Jim's gate, must 6): a word written straight before an @sha ("ABC @1a2b3c4") is read as a card's
    // pair form (isPairForm: its leading segments or any own form): unique, that card; shared, some other
    // card; no card's, nothing. Only that position is read so: no other bare word is a card.
    for (const m of rest.matchAll(PAIR_WORD_RE)) place(m[1], true, true);
    // Round 10 (Jim's gate, must 2b): a commit subject's conventional scope, "test(abc-hull): ...", is written
    // lower-case; read upper-case it is a card's own form like any other token (unique: that card; shared:
    // some other card; no card's form: a topic, nothing). Only the scope is read so: no other lower-case
    // word is a card.
    const scope = rest.match(SCOPE_RE);
    if (scope) place(scope[1].toUpperCase(), true);
    return { cards, others };
  };
}

/** The known cards a text names (cardNamer's `cards`). */
export function cardMatcher(cardIds: readonly string[]): (text: unknown) => string[] {
  const namer = cardNamer(cardIds);
  return (text) => namer(text).cards;
}

/** Why a done mail gave no done-sha fact (one row per mail; the counts sum them). */
export type DoneSkipReason = 'notDone' | 'noShaWord' | 'noCommit' | 'noCard' | 'ambiguous' | 'bodyOnly';
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
 * The card: the mail's card field when it is a known card. Without one, a card the delivery linked
 * (`cards`, the mail-cards index: a reply or conversation link) counts when it is the only one and
 * the subject names no other card. Every other candidate needs git (CLAIMS-WEAKLINK-DONESHA, round
 * 2 after Jim's gate): the cards the subject names, else the linked cards, else the cards the BODY
 * names, and one of them counts only when exactly one is named by the SUBJECT line of a commit the
 * mail reports (a card's own commits name it in their subject; a CHANGELOG, cut or int merge commit
 * lists many cards in its body and confirms nothing; a short id that is really a label in a mail's
 * subject, "U6 included", has no commit subject naming it). So a card's own done report that names
 * the card only in its body (a delta-audit reply, lower case, beside other cards) is found, while a
 * passing mention in a done mail about another card never is: that mail's own field or link names
 * the other card and wins, and an unconfirmed subject or body mention gives nothing (ambiguous /
 * bodyOnly).
 * Round 3 (Jim's gate on 844a3ddf): only the card's OWN commit confirms it. (B) A merge (2+ parents)
 * confirms nothing on its own sha and is never reported: it resolves to its merged parent
 * (resolveReported), which counts, and is the reported sha, when its subject or the merged branch
 * names the card, else the merge is dropped from the mail; so a later int/rc merge mail on the card
 * yields the same own-commit sha as the builder's mail, never a sha that displaces it. (A) A commit
 * that changes only CHANGELOG/docs files (changedFiles) confirms nothing, whatever its subject says.
 * (C) The single-link path also requires that the commit the row would carry (the subject's @sha,
 * else the done sha the mail's commits give) does not name a different card; the other shas a mail
 * lists (bases, history, alternatives) are not judged, and a commit naming no card still counts.
 * A refused link falls through to the git check with the link beside the subject's cards, so a
 * commit whose subject names the link card still confirms it (Jim's gate on 8028fa88).
 * Commits: the sha words of the subject and body that git resolves to a commit (ranges a..b give
 * both ends). R2 (c): a mail that gives no fact carries a reason; noShaWord, noCommit, ambiguous
 * and bodyOnly are each what git confirmed. A mail copied to several inboxes counts once (by id).
 */
export async function doneMailFacts(mails: readonly MailLike[], cardIds: readonly string[], git: GitPort, ctx: DoneMailContext = {}): Promise<DoneMailResult> {
  // Round 5 (god bfcff1): one recogniser for every text (a mail subject or body, a commit subject, a
  // merge's "into" line), variants included; a card-shaped unknown token names some other card.
  const namer = cardNamer(cardIds);
  const match = (text: unknown): string[] => namer(text).cards;
  const namesOf = (e: ReportedCommit): CardNames => namer(e.into !== undefined ? e.into : e.text);
  /** The cards other than `card` a commit names (known ids and card-shaped unknown tokens). */
  const foreign = (e: ReportedCommit, card: string): string[] => { const n = namesOf(e); return [...n.cards.filter((c) => c !== card), ...n.others]; };
  // Round 10 (Jim's gate, must 4): the card-shaped ids a text writes that are no board card's form at all
  // (a shared form of several board cards is "other" to the namer but not a stranger: round 9 R2 ties it
  // to the linked card).
  const strangersOf = (text: unknown): string[] => namer(text).others.filter((t) => !cardIds.some((id) => isOwnForm(t, id)));
  const known = new Map(cardIds.flatMap((c) => [[c.toLowerCase(), c], [canonCard(c), c]] as Array<[string, string]>));
  // Round 9 (P1): the card field, read like every other card name (case, dash or space), but whole: a
  // field that names no known card names some other card (guide A12) and the mail counts for nothing.
  const fieldCardOf = (field: unknown): string | null | undefined => {
    if (typeof field !== 'string' || !field.trim()) return undefined;
    const t = field.trim();
    return known.get(t.toLowerCase()) ?? known.get(canonCard(t)) ?? null;
  };
  const skipped: Record<DoneSkipReason, number> = { notDone: 0, noShaWord: 0, noCommit: 0, noCard: 0, ambiguous: 0, bodyOnly: 0 };
  const skips: DoneSkip[] = [];
  const skip = (mail: string, reason: DoneSkipReason, cards?: string[]): void => {
    skipped[reason]++;
    skips.push({ mail, reason, ...(cards?.length ? { cards } : {}) });
  };
  const newest = new Map<string, { m: MailLike & { id: string }; card: string; from: string; commit: string; named: number; range?: ShaMention['range']; subject: boolean; body: boolean; inRepo: boolean; via?: string; own: boolean }>();
  let withCommit = 0;
  const seen = new Set<string>();
  const ordered = [...mails].filter((m): m is MailLike & { id: string } => !!m && typeof m.id === 'string')
    .sort((a, b) => (mailAt(a) < mailAt(b) ? -1 : mailAt(a) > mailAt(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const m of ordered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.act !== 'done') { skip(m.id, 'notDone'); continue; }
    const mentions = [...shaMentions(m.subject), ...shaMentions(typeof m.body === 'string' ? m.body : '')];
    // Round 10 (god a22191, F4): an @sha the subject shares with the subject of the mail it replies to is
    // QUOTED (the request's sha), not reported: it loses the subject-@sha priority and the mail's sha is the
    // existing rule over the commits it names (the latest in git order of the card's line), so an audit
    // reply naming only the quoted sha keeps it, one naming a newer tip too gives the tip, and one naming an
    // older base too keeps the quoted sha. An @sha the request did not write keeps its priority.
    // Jim's gate (must 3): a quoted @sha loses that priority ONLY when the subject also writes another sha
    // (the "covered by the T verdict" shape); a plain audit reply that names the request's sha and nothing
    // else reports that very sha, whatever the body lists.
    const parent = typeof m.in_reply_to === 'string' && m.in_reply_to && ctx.subjectOf ? ctx.subjectOf(m.in_reply_to) : undefined;
    const quoted = subjectAtShas(parent).map((x) => x.sha);
    const isQuoted = (sha: string): boolean => quoted.some((q) => q.startsWith(sha) || sha.startsWith(q));
    const written = subjectAtShas(m.subject);
    const otherSha = shaMentions(m.subject).some((x) => !isQuoted(x.sha));
    const atShas = otherSha ? written.filter((x) => !isQuoted(x.sha)) : written;
    if (!mentions.length && !atShas.length) { skip(m.id, 'noShaWord'); continue; }
    // Round 10 (Jim's gate, must 7; god 21df93): the per-card "merge guppy/<branch> @<sha>" lines of an int-merge
    // report sit in the BODY. A body line pairing a card's own name (id, branch or pair form) with an @sha is
    // read like a subject pair for that card; quoted lines and the quoted parent's shas are left out, and a
    // sha the subject writes keeps the subject's word.
    const bodyPairs: Array<{ sha: string; name: string }> = [];
    for (const line of typeof m.body === 'string' ? m.body.split(/\r?\n/) : []) {
      if (/^\s*>/.test(line)) continue;
      for (const x of subjectAtShas(line)) {
        if (isQuoted(x.sha) || written.some((w) => w.sha === x.sha) || bodyPairs.some((b) => b.sha === x.sha)) continue;
        if (cardIds.some((c) => pairName(x.name, c, cardIds))) bodyPairs.push(x);
      }
    }
    // The commits the mail reports, each resolved to the work it stands for (round 3: a merge is its
    // merged parent or nothing).
    const entries: ReportedCommit[] = [];
    const rangeOf = new Map<string, ShaMention['range']>();
    const resolved = new Map<string, ReportedCommit[]>();
    // Round 10 (god a22191, F5): a written range A..B, when git can list it, reports the commits IN the
    // range (A itself is outside it), each resolved like a named commit and marked with the range; the
    // card's row keeps the ones naming the card, and B only when every commit of the range names it
    // (keepFor). A range git cannot list, or one longer than RANGE_MAX, keeps the older reading: both
    // ends as named commits.
    const ranges = new Map<string, { to: string; shas: string[]; members: ReportedCommit[] }>();
    const rangeKey = (r: NonNullable<ShaMention['range']>): string => `${r.from}..${r.to}`;
    if (git.rangeCommits) {
      for (const x of mentions) {
        if (!x.range || x.range.end !== 'to' || ranges.has(rangeKey(x.range))) continue;
        const [from, to] = await Promise.all([git.commitOf(x.range.from), git.commitOf(x.range.to)]);
        if (!from || !to) continue;
        const shas = await git.rangeCommits(from, to);
        if (!shas || shas.length > RANGE_MAX) continue;
        ranges.set(rangeKey(x.range), { to, shas, members: [] });
      }
    }
    for (const x of mentions) {
      const range = x.range && ranges.has(rangeKey(x.range)) ? ranges.get(rangeKey(x.range)) : undefined;
      if (range && x.range?.end === 'from') continue;
      if (range && x.range) {
        const { to } = range;
        for (const member of range.shas) {
          const rs = resolved.get(member) ?? await resolveReported(member, git);
          resolved.set(member, rs);
          for (const r of rs) {
            if (!range.members.some((e) => e.commit === r.commit)) range.members.push(r);
            if (entries.some((e) => e.commit === r.commit)) continue;
            entries.push(r);
            rangeOf.set(r.commit, { ...x.range, end: member === to ? 'to' : 'in' });
          }
        }
        continue;
      }
      const full = await git.commitOf(x.sha);
      if (!full || resolved.has(full)) continue;
      const rs = await resolveReported(full, git);
      resolved.set(full, rs);
      for (const r of rs) {
        if (entries.some((e) => e.commit === r.commit)) continue;
        entries.push(r);
        if (x.range && !r.merge) rangeOf.set(r.commit, x.range);
      }
    }
    // The subject's @shas, resolved the same way; one the repository lacks stays as written (F2).
    const ats: Array<{ sha: string; name: string; full?: string; entry?: ReportedCommit; written: string; body: boolean }> = [];
    for (const x of [...atShas.map((a) => ({ ...a, body: false })), ...bodyPairs.map((a) => ({ ...a, body: true }))]) {
      const full = await git.commitOf(x.sha);
      if (!full) { ats.push({ sha: x.sha, name: x.name, written: x.sha, body: x.body }); continue; }
      for (const r of resolved.get(full) ?? await resolveReported(full, git)) ats.push({ sha: r.commit, name: x.name, full: r.commit, entry: r, written: x.sha, body: x.body });
    }
    const atCommits = new Set(ats.flatMap((a) => (a.full ? [a.full] : [])));
    /** Round 10 (Jim's gate, must 6): whether an @sha paired with `card` by its own name holds: it does when
     *  the repository lacks the commit, when the card's branch (guppy/<id>, origin first) reaches it, or when
     *  no other card's branch does (taken as written); a commit on another card's branch alone contradicts it. */
    const branchTip = async (c: string): Promise<string | null> => (git.refCommit ? await git.refCommit(`guppy/${c.toLowerCase()}`) : null);
    const pairOk = async (card: string, a: { full?: string }): Promise<boolean> => {
      if (!a.full) return true;
      // Re-gate must A: one containment answer per sha, then set membership over the board (no git spawn
      // inside the loop over cards: ~150 card branches times every paired sha killed the full pass).
      const on = git.branchesContaining ? await git.branchesContaining(a.full) : null;
      if (on) {
        const branchOf = (c: string): string => `guppy/${c.toLowerCase()}`;
        if (on.has(branchOf(card))) return true;
        return !cardIds.some((other) => other !== card && !isIntCard(other) && !isReleaseCard(other) && on.has(branchOf(other)));
      }
      const own = await branchTip(card);
      if (own && await git.isAncestor(a.full, own)) return true;
      for (const other of cardIds) {
        if (other === card || isIntCard(other) || isReleaseCard(other)) continue;
        const tip = await branchTip(other);
        if (tip && await git.isAncestor(a.full, tip)) return false;
      }
      return true;
    };
    /** Must 6: the cards whose own name (id, branch or pair form) the mail writes straight before an @sha, in
     *  the subject or (must 7) on a body line. */
    const pairedCards = cardIds.filter((card) => ats.some((a) => pairName(a.name, card, cardIds)));
    /** F5: whether a commit of a written range counts for `card`: one in the range only when it names the
     *  card; the range's end only when every commit of the range names the card. Jim's gate (must 2a): a
     *  mail that reports a listed range reports its members: a commit outside every listed range (a base,
     *  a cherry-pick source quoted in the body) is never the value unless the subject writes it as @sha;
     *  a cherry-pick's source confirms the member (resolveReported), it is never the value itself. Without
     *  a listed range every commit passes here. */
    const inRangeFor = (card: string): ((e: ReportedCommit) => boolean) => {
      const names = (e: ReportedCommit): boolean => namesOf(e).cards.includes(card);
      return (e) => {
        const r = rangeOf.get(e.commit);
        const range = r && r.end !== 'from' ? ranges.get(rangeKey(r)) : undefined;
        if (!r) return ranges.size === 0 || atCommits.has(e.commit);
        if (!range) return true;
        if (!names(e)) return false;
        return r.end === 'to' ? range.members.every(names) : true;
      };
    };
    if (!entries.length && !ats.length) { skip(m.id, 'noCommit'); continue; }
    // (B) A commit reached through a merge counts for the card only when its subject or branch names it.
    // Round 4b: a merge into the card's own line is the card's work: it counts as itself and the parents
    // it merged are not descended; for every other card such a merge entry is dropped.
    const fieldCard = fieldCardOf(m.card);
    const fieldRow = typeof fieldCard === 'string';
    const keepFor = (card: string): ((e: ReportedCommit | undefined) => boolean) => {
      const base = keepBase(card);
      const ranged = inRangeFor(card);
      return (e) => base(e) && (!e || ranged(e));
    };
    const keepBase = (card: string): ((e: ReportedCommit | undefined) => boolean) => {
      const own = new Set(entries.filter((e) => e.into !== undefined && match(e.into).includes(card)).map((e) => e.commit));
      const plain = (e: ReportedCommit): boolean => !e.merge || (!(e.chain ?? []).some((c) => own.has(c)) && match(e.text).includes(card));
      // Round 6 (god 18e97a, R6-3): on a link or subject row an int card's done sha is only a merge into its
      // own line; round 7 (god 3af596, R7-1): a FIELD row for an int card is judged as in round 5 (its own
      // plain line commit, a fixup or a pin, is a real done sha; the field is authoritative).
      // Round 8 (god 6b94a5, R8): on those rows a PLAIN commit whose own subject leads with the int card's id is
      // the line's own commit as well; a commit reached through a merge is not.
      // Round 9 (P3): on an int card's FIELD row a plain commit that names only OTHER cards (another card's
      // own work the int done mail lists) is not carried; the line's own commits (fixups, pins, the release
      // commit, a subject leading with the id) still are.
      // The line's release commit (version-only files, or naming only a cut card) is the line's own. Gate R1:
      // an unknown card-shaped token with no number (OMEGA-PINS) is a topic, not another card; a known card
      // is another card whatever its shape.
      const otherCard = (x: string): boolean => !isReleaseCard(x) && (known.has(x.toLowerCase()) || /[0-9]/.test(x));
      const foreignOnly = (e: ReportedCommit): boolean => !e.docsOnly && foreign(e, card).some(otherCard) && !namesOf(e).cards.includes(card);
      if (isIntCard(card)) return fieldRow ? (e) => !e || (e.into !== undefined ? own.has(e.commit) : plain(e) && !foreignOnly(e)) : (e) => !e || (e.into !== undefined ? own.has(e.commit) : !e.merge && leadsWithCard(e.text, card));
      // R6-2: a docs / release-only commit is carried only for a cut/release card.
      return (e) => !e || (e.into !== undefined ? own.has(e.commit) : (!e.docsOnly || isReleaseCard(card)) && plain(e));
    };
    // (C) The commits a row on `card` would carry: the subject's @shas, else the latest in git order.
    // Round 5 (god bfcff1): a mail whose subject names @shas carries only those; when (B) drops them all
    // (a merge into another line, a dropped self entry) the mail carries nothing, never a body sha.
    // Jim's gate (must 3): on a row the mail itself names (a card field, or the card in the subject) the
    // fallback never takes a commit whose subject names a different card and not this one: the latest is
    // taken among the card's own and no-card commits when any remain. On a pure link row the commits are
    // the only evidence, so round 5 holds unchanged: such a commit as the latest makes the row ambiguous.
    const namedRow = (card: string): boolean => fieldRow || match(m.subject).includes(card);
    const ownOrNone = (card: string) => (e: ReportedCommit): boolean => !foreign(e, card).length || namesOf(e).cards.includes(card);
    const fallbackOf = async (card: string, kept: readonly ReportedCommit[]): Promise<ReportedCommit[]> => {
      const clean = namedRow(card) ? kept.filter(ownOrNone(card)) : [];
      const pool = clean.length ? clean : kept;
      const latest = await latestOfCommits(pool.map((e) => e.commit), git);
      return pool.filter((e) => e.commit === latest);
    };
    const carriedFor = async (card: string): Promise<ReportedCommit[]> => {
      const keep = keepFor(card);
      const atEntries = ats.filter((a) => a.entry && keep(a.entry)).map((a) => a.entry as ReportedCommit);
      if (atEntries.length || ats.length) return atEntries;
      return fallbackOf(card, entries.filter(keep));
    };
    const rowFor = async (card: string, ats: ReadonlyArray<{ sha: string; name: string; full?: string; entry?: ReportedCommit; body?: boolean }>, entries: readonly ReportedCommit[], paired: boolean): Promise<void> => {
      const key = cardKey(card, 'donesha');
      if (!key) { skip(m.id, 'noCard', [card]); return; }
      const keep = keepFor(card);
      const kept = entries.filter(keep);
      const atsKept = ats.filter((a) => keep(a.entry));
      if (ats.length ? !atsKept.length : !kept.length) {
        // Round 6 (R6-3): a plain commit carried for an int card makes the row ambiguous. Subject @shas that
        // (B) drops stay noCommit whatever the body lists (round 5; Jim's P5).
        skip(m.id, !ats.length && entries.length && isIntCard(card) && !fieldRow ? 'ambiguous' : 'noCommit', [card]);
        return;
      }
      // Round 9 (P2): on a link or subject row a lone subject @sha counts only when the subject ties it to
      // the card (the word before it, its segment) or reports one item; else it may be another item's sha.
      // Round 10 (F2): a paired row's @shas are tied to the card already.
      if (!fieldRow && !paired && atShas.length === 1 && typeof m.subject === 'string' && !loneAtCounts(m.subject, atShas[0], card, namer, cardIds)) { skip(m.id, 'ambiguous', [card]); return; }
      // Several subject @shas that git cannot order and no card name settles: no claim from this mail.
      const reported = await subjectTip(atsKept, card, git, cardIds);
      if (reported === 'ambiguous') { skip(m.id, 'ambiguous', [card]); return; }
      // F2: a sha the subject reports as @<sha> is the mail's sha, even when the repository lacks it.
      const at = reported ? atsKept.find((a) => a.sha === reported) : undefined;
      const reportedFull = at ? (at.full ?? await git.commitOf(at.sha)) : null;
      const fallback = reported ? [] : await fallbackOf(card, kept);
      const commit = reported ? (reportedFull ?? reported) : (fallback[0] ?? kept[0]).commit;
      const entry = at ? at.entry : kept.find((e) => e.commit === commit);
      // Must 6: an @sha paired by the card's own name needs no commit subject, but a commit of the repository that
      // names no card and sits on another card's branch alone contradicts the pair (pairOk): no claim. A card
      // field is the sender's word on the card (round 5): the branch check never enters there.
      if (at && at.entry && !fieldRow && !namesOf(at.entry).cards.includes(card) && pairName(at.name, card, cardIds) && !(await pairOk(card, at))) { skip(m.id, 'ambiguous', [card]); return; }
      // Round 5 (god bfcff1): the carried commit counts or the row is skipped. Without a card field, a
      // carried commit that names only other cards (a refused link that another listed commit confirmed,
      // a subject card confirmed by a different commit) is never the value: no fallback to it.
      if (entry && !fieldRow) {
        const f = foreign(entry, card);
        if (f.length && !namesOf(entry).cards.includes(card)) { skip(m.id, 'ambiguous', [card, ...f].slice(0, 8)); return; }
      }
      const via = entry?.merge;
      const from = typeof m.from === 'string' && m.from ? clip(m.from, 60) : 'unknown';
      withCommit++;
      newest.set(`${key}#${from}`, { m, card, from, commit, named: kept.length, range: rangeOf.get(commit), subject: !!reported, body: !!at?.body, inRepo: !reported || !!reportedFull, via, own: entry?.into !== undefined });
    };
    const card = await cardOfDoneMail(m, fieldCard, known, match, strangersOf, pairedCards, foreign, entries, carriedFor, ranges.size > 0);
    if (typeof card !== 'string' && !Array.isArray(card)) { skip(m.id, card.reason, card.cards); continue; }
    // Round 10 (god a22191, F2): a subject naming several cards is a row on EACH, carrying the @shas the
    // subject pairs with that card (pairedAtShas); without one, the card's own commits among those the
    // mail names. A card the pairing cannot settle is skipped as ambiguous (never guess).
    const multi = Array.isArray(card);
    const pairs = multi && typeof m.subject === 'string' ? pairedAtShas(m.subject, card, namer, cardIds, bodyPairs) : null;
    for (const c of multi ? card : [card]) {
      const paired = pairs?.get(c);
      if (paired === 'ambiguous') { skip(m.id, 'ambiguous', [c]); continue; }
      // On a multi-card row the carried commit is one that names the card (its own commit, or a merge into its
      // own line): the other card's commit the same mail reports never becomes this card's sha.
      const confirms = (e: ReportedCommit | undefined): boolean => !!e && namesOf(e).cards.includes(c);
      // Must 6: an @sha written straight after the card's own name is the card's without a commit subject
      // (rowFor holds it to the card's branch).
      const rowAts = paired ? ats.filter((a) => paired.includes(a.written) && (confirms(a.entry) || pairName(a.name, c, cardIds))) : ats;
      if (paired && paired.length && !rowAts.length) { skip(m.id, 'ambiguous', [c]); continue; }
      const rowEntries = multi ? entries.filter(confirms) : entries;
      await rowFor(c, rowAts, rowEntries, multi);
    }
  }
  const facts: DerivedFact[] = [];
  for (const [slot, { m, card, from, commit, named, range, subject, body, inRepo, via, own }] of newest) {
    const key = slot.slice(0, slot.lastIndexOf('#'));
    const at = iso(m.created_at);
    const of = range ? ` (${range.end === 'in' ? 'a commit in' : range.end === 'from' ? 'the start of' : 'the end of'} the range ${range.from}..${range.to})` : '';
    const merged = via ? ` (the merged parent of ${via.slice(0, 8)}, the merge the mail wrote)` : own ? " (the merge into the card's own line)" : '';
    const others = subject ? ` as ${body ? 'the @sha its body pairs with the card' : "its subject's @sha"}${inRepo ? '' : ' (not in the repository)'}${merged}` : named > 1 ? `; it is the latest in git order of the ${named} commits the mail names${merged}` : merged;
    facts.push({
      slot, key, kind: 'fact',
      text: `Card ${card}: the newest done mail from ${from} (${clip(m.id, 80)}) names commit ${commit.slice(0, 8)} (${commit})${subject ? '' : of}${others}`,
      ...(at ? { at } : {}),
      refs: [{ type: 'task', value: card }, { type: 'msg', value: m.id.slice(0, 200) }, ...(inRepo ? [{ type: 'commit' as const, value: commit }] : [])],
      value: commit, valueAgent: from,
    });
  }
  return { facts, skipped, skips, older: withCommit - facts.length };
}

/** The done mail's card (see doneMailFacts), or why there is none. */
async function cardOfDoneMail(
  m: MailLike, fieldCard: string | null | undefined, known: Map<string, string>, match: (text: unknown) => string[], strangersOf: (text: unknown) => string[],
  pairedCards: readonly string[], foreign: (e: ReportedCommit, card: string) => string[], entries: readonly ReportedCommit[], carriedFor: (card: string) => Promise<readonly ReportedCommit[]>, ranged = false,
): Promise<string | string[] | { reason: 'noCard' | 'ambiguous' | 'bodyOnly'; cards?: string[] }> {
  if (fieldCard) return fieldCard;
  // Round 9 (P1): a card field naming a card the board does not know is a done mail about some OTHER
  // card: it never falls through to the thread's link or the subject (guide A12).
  if (fieldCard === null) return { reason: 'noCard', cards: [clip(String(m.card).trim(), 60)] };
  const linked = Array.isArray(m.cards)
    ? [...new Set(m.cards.map((c) => (typeof c === 'string' ? known.get(c.toLowerCase()) : undefined)).filter((c): c is string => !!c))]
    : [];
  // `match` is the one recogniser (round 5, god bfcff1: variants included, replacing the exact-only
  // link of god c33130/c19239). A single inherited link (reply/conversation) that the subject does not
  // contradict is the card. Anything else, a card the subject names included, is weak (spec F; Jim's
  // gate M-a: "U6 included" in a subject made card.u6): a candidate only, and only git confirms it
  // (CLAIMS-WEAKLINK-DONESHA).
  const exact = match(m.subject);
  // Round 10 (Jim's gate, must 4): a subject that names no known card but writes a card-shaped id with a
  // number that is no board card's form (a card the board never made, or one it lacks) names THAT card:
  // the thread's link does not enter and the mail has no card here. A form shared by several board cards
  // is not such an id (round 9 R2: the linked card owns it). The round-9 rule refusing commits of such
  // ids is unchanged. Re-gate must B: only a stranger shaped as a card id counts (strangerNamesCard); an
  // item-range label (X1-X3, D1-D8, PLAN-V4) is a list label and lets the link in.
  const unknown = exact.length ? [] : strangersOf(m.subject).filter(strangerNamesCard);
  if (unknown.length) return { reason: 'noCard', cards: unknown.slice(0, 8) };
  // The cards a reported commit confirms (Jim's gate M-b: by its SUBJECT line only; see byGit below).
  const hitsOf = (e: ReportedCommit, named: readonly string[]): string[] =>
    match(e.into !== undefined ? e.into : e.text).filter((x) => named.includes(x) && (!e.docsOnly || isReleaseCard(x)) && (!isIntCard(x) || e.into !== undefined || (!e.merge && leadsWithCard(e.text, x))));
  // Round 10 (god a22191, F2): a subject naming two or more cards (ids or their forms) and reporting an
  // @sha is a row on EACH card a commit the mail names confirms (a commit naming both confirms both), the
  // caller pairing each with its @sha; (F3) the thread's link does not enter. One confirmed card, or a
  // subject with no @sha, keeps the rule below: the one card git confirms, else ambiguous.
  // F5: a subject naming several cards over a commit range is a row on each as well (each card keeps
  // its own commits of the range).
  // Round 10 (Jim's gate, must 6): a card written straight before its own @sha, in the subject or (must 7) on a
  // body line, is paired with it and needs no confirmation from a commit subject (the caller holds the pair
  // to the card's branch): the paired cards and the confirmed ones are the rows.
  const paired = [...new Set([...exact, ...pairedCards])].filter((c) => pairedCards.includes(c));
  const named2 = [...new Set([...exact, ...paired])];
  if (named2.length >= 2 && (subjectAtShas(m.subject).length || ranged || paired.length)) {
    const confirmed = named2.filter((c) => paired.includes(c) || entries.some((e) => hitsOf(e, named2).includes(c)));
    if (confirmed.length >= 2 || paired.length) return confirmed;
  }
  // Round 3 (C): the link counts only when the commit the row would carry names no different card (a
  // commit naming no card still counts; a merge of another card's branch names that card; round 5: a
  // card-shaped token that is no known card is a different card). The other shas the mail lists are
  // not judged. A refused link is weak: it joins the subject's cards below, and the caller skips the
  // row when the carried commit does not count for the card git confirms.
  let refused: string[] | undefined;
  // Round 10 (god a22191, F3): the mail's own card outranks its thread: the card field first (above), then
  // a card its own subject names; the reply / conversation link applies only when the subject names no
  // card, or names the linked card itself (among others it only breaks the tie, and a carried commit of
  // another card refuses it). A subject naming only another card is judged on that card alone.
  if (linked.length === 1 && (!exact.length || exact.includes(linked[0]))) {
    const others = [...new Set((await carriedFor(linked[0])).flatMap((e) => foreign(e, linked[0])))];
    if (!others.length) return linked[0];
    refused = [linked[0], ...others];
  }
  const strong = refused ? [...new Set([linked[0], ...exact])] : exact.length ? exact : linked;
  const named = strong.length ? strong : match(m.body);
  if (!named.length) return { reason: 'noCard' };
  const byGit = new Set<string>();
  for (const e of entries) {
    // Jim's gate M-b: the commit's SUBJECT line only (a CHANGELOG, cut or int merge commit lists many
    // cards in its body; a card's own commit names it in the subject). Round 3: a merge resolved to
    // its merged parent (B); a commit changing only docs confirms nothing (A).
    // Round 6 (god 18e97a): a docs / release-only commit confirms only a cut/release card (R6-2); an int
    // card is confirmed only by a merge into its own line (R6-3) or (round 8, R8) a plain commit whose subject
    // leads with its id.
    const hits = hitsOf(e, named);
    if (hits.length === 1) byGit.add(hits[0]);
  }
  if (byGit.size === 1) return [...byGit][0];
  // Must 6: the one named card paired with its @sha by its own name is the card without git's word.
  if (paired.length === 1 && named.includes(paired[0])) return paired[0];
  return { reason: strong.length ? 'ambiguous' : 'bodyOnly', cards: (refused ?? named).slice(0, 8) };
}

/** The subject line of a commit message (git's %s: the text before the first blank line, folded to
 *  one line), or '' for none. */
export function commitSubject(message: string | null | undefined): string {
  if (typeof message !== 'string') return '';
  const head = message.replace(/\r\n?/g, '\n').trimStart().split(/\n[ \t]*\n/, 1)[0];
  return head.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
}
