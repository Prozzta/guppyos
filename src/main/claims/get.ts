/**
 * CLAIMS-90 R2 (C90-GET): `memory get <key|card>` moves the "which value is current" step out of the
 * agent's reading into code. One pure resolver over (a) every agent's VERIFIED ledger records and W2's
 * derive (so agent, supersedes, retracts and reconcile answers are all known: the index carries none of
 * them), (b) the key registry's aliasOf chains, (c) the reconcile queue's key-alias pairs, (d) tasks.json
 * (a card's fields) and (e) Creed's per-card mail index (C90-MAILCARD, hive/state/mail-cards/<card>.jsonl).
 *
 * RESOLUTION (agreed with Creed, C90-FACTS 5f3e80): the exact key, else `card.<term lower-cased>`, else the
 * alias set; a claim id resolves to its key. Every merged key is returned. A `card.*` key covers its derived
 * sub-keys (`card.<id>.status|.assignee|.lastsha|.donesha|.decision.*`).
 *
 * CURRENT (Jim ff7793 + df789a): the newest live claim under the key set; with --agent A the newest live
 * claim BY A, else a derived claim naming A's done mail ("from A "), else the global newest. Decisions are
 * their own list (every live `card.<id>.decision.*` claim, newest first), never folded into competing or
 * cut to the newest. Superseded rows carry an excerpt and the ids that replaced them: supersededBy is the
 * INVERSE of `supersedes`, plus `retracts`, plus the loser of a reconcile answer "supersedes" (Creed: no
 * stored supersededBy). MAIL RULE (Jim 784b65 s4 d): current = the newer of the claim pick and the newest
 * card-linked mail that names a known value (one found in a live or superseded claim under the keys; for
 * donesha / lastsha and a bare card also a commit sha in that agent's done mail, Jim ac6f85); the output
 * names its source (claim id or mail id). Times compare as epoch ms, never as strings.
 *
 * READ-ONLY: nothing here writes a store, a ledger or a file. Main serves it through the claim-verb
 * endpoint; test/tools/claims90-get.cjs runs the same functions over a hive folder for the auditor.
 */
import type { ClaimRec, ClaimsState, EventRec, KeyRegistry, LedgerRec, ReconcileItem } from '../../shared/claims';
import { derive } from './derive';
import { hideStale } from './stale';

export interface GetDeps {
  /** Verified records per agent id, append order (main: verifiedPrefix(readLedger); the tool: the raw lines). */
  ledgers: Record<string, LedgerRec[]>;
  registry: KeyRegistry;
  /** Every agent's reconcile items (only kind key-alias* is read). */
  reconcileItems?: ReconcileItem[];
  /** tasks.json rows (`id` plus the card's fields). */
  tasks?: Array<Record<string, unknown>>;
  /** The per-card mail index lines for a card id (lower-cased), oldest first; null when there is no file. */
  mailRows?: (cardLower: string) => string[] | null;
  ruleConfig?: { r4: boolean };
}

export interface GetOptions {
  agent?: string | null;
  /** Mail rows shown (default MAIL_DEFAULT); 0 = none. */
  mail?: number;
  /** Page: only mail rows before this mail id's first row. */
  before?: string | null;
  /** Claims-only current pick (the regression control for the mail rule). */
  noMail?: boolean;
  /** T2 (god fe1140): `--all` lists the competing and superseded bodies; the default (while hideStale()) prints their counts. */
  history?: boolean;
}

export interface GetClaimRow { claimId: string; agent: string; at: string; text: string; key: string; kind: string; refs?: ClaimRec['refs'] }
export interface GetSupersededRow { claimId: string; agent: string; at: string; key: string; status: string; excerpt: string; supersededBy: string[]; reason?: string }
export interface GetMailRow { id: string; from: string; to: string[]; act: string; subject: string; at: string; cardFrom: string; trust: string; weak: boolean; excerpt: string }
export interface GetCurrent {
  source: 'claim' | 'mail';
  claimId?: string; mailId?: string;
  agent: string; at: string; text: string; key: string;
  refs?: ClaimRec['refs'];
}
export interface GetResult {
  term: string;
  keys: string[];
  /** The keys the resolution tried when nothing was found (the "no claim under" line). */
  tried: string[];
  card: string | null;
  current: GetCurrent | null;
  competing: GetClaimRow[];
  superseded: GetSupersededRow[];
  decisions: GetClaimRow[];
  fields: Record<string, unknown> | null;
  mails: GetMailRow[];
  nextBefore: string | null;
  mailIndex: 'present' | 'absent' | 'off';
  /** Step 3 fix R1 (god bbcb4a): the per-field current values a bare card (or its branch / a release key) LEADS with;
   *  null for a field sub-key the agent typed, or a plain key. */
  lead: GetFieldLine[] | null;
}

/** R1: the card fields the lead block answers, in print order (then the decision count). */
export const CARD_FIELDS = ['donesha', 'lastsha', 'status', 'assignee', 'fixVersion', 'merge'] as const;
export interface GetFieldLine {
  field: string;
  /** The current value's text (one line), null when nothing answers it. */
  value: string | null;
  /** Where it came from: the field's claim, the mail rule, tasks.json, or nothing. */
  source: 'claim' | 'mail' | 'tasks' | 'none';
  id?: string; agent?: string; at?: string;
}
/** R1: the compact `get` text stays under the tool-output condenser cap (1500) by construction: these equal
 *  format.ts COMPACT_MAX_CHARS / COMPACT_LINE_MAX (pinned by test/claims90-step3-lead.test.cjs). */
export const GET_MAX_CHARS = 1400;
export const GET_LINE_MAX = 158;
/** A lead value on its `field: value` line; the search brief (R2) shows less. */
const LEAD_VALUE_MAX = 80;
const BRIEF_VALUE_MAX = 48;

export const MAIL_DEFAULT = 5;
export const MAIL_MAX = 50;
const EXCERPT_MAX = 120;
const MAIL_TEXT_MAX = 400;
/** god db7d4a: the card-link methods whose mail can become current, with a strength (T5). A body-only mention (and an
 *  unsplit legacy `mention`) is weak: listed in mails[] tagged weak, never current, never counted toward coverage. */
const TRUSTED_LINKS: Record<string, number> = { field: 8, reply: 4, conversation: 2, 'mention-subject': 1 };
const linkParts = (cardFrom: string): string[] => String(cardFrom ?? '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
/** T5 (god fe1140): at equal time a mail linked by more trusted methods (subject+conversation) outranks one linked by fewer (subject-only). */
export const linkRank = (cardFrom: string): number => linkParts(cardFrom).reduce((n, p) => n + (TRUSTED_LINKS[p] ?? 0), 0);
export const trustedLink = (cardFrom: string): boolean => linkRank(cardFrom) > 0;
const CARD_PREFIX = 'card.';
const RELEASE_PREFIX = 'release.';
const BRANCH_PREFIX = 'branch.';
/**
 * Ruling 3 (god 690425), Creed bc11fc rule (b): a branch name (as in git, any case) minus a leading `guppy/` or
 * `origin/guppy/`; when the rest is a card id the branch is the card's (its merge claim is card.<id>.merge), else the
 * key is branch.<name lower-cased> (only when that is a valid key: no `/`). Null: not a branch name at all.
 */
export function branchName(term: string): string | null {
  const m = /^(?:origin\/)?(?:guppy\/)?([a-z0-9][a-z0-9._-]*)$/i.exec(term.trim());
  return m && /\//.test(term) ? m[1].toLowerCase() : null;
}
export const branchKeyOf = (name: string): string => `${BRANCH_PREFIX}${name.toLowerCase()}`;
const FIELD_SUFFIX = /\.(status|assignee|lastsha|donesha|fixversion|merge|decision\.[a-z0-9]{8})$/;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const VERSION_RE = /\b\d+\.\d+(?:\.\d+)+\b/g;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Epoch ms of an ISO time, or of a dashed mail-id time (`2026-10-25T07-14-05-563Z-…`); NaN when neither. */
export function epochMs(s: string | undefined | null): number {
  if (!s) return NaN;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/.exec(s);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] ?? '000'}Z`) : NaN;
}

/** The registry's aliasOf chain, loop-safe (the same walk as derive.ts). */
export function canonicalKey(key: string, registry: KeyRegistry): string {
  let current = key;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const alias = registry.keys[current]?.aliasOf;
    if (!alias) break;
    current = alias;
  }
  return current;
}

/** A term as typed by an agent: trimmed, lower-cased, quotes and a leading `memory get` / `card.` stripped. */
export function normaliseTerm(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase();
  t = t.replace(/^memory\s+get\s+/, '').trim();
  return t;
}

const sha7 = (s: string): string[] => (s.toLowerCase().match(SHA_RE) ?? []).filter((x) => /\d/.test(x)).map((x) => x.slice(0, 7));
const versions = (s: string): string[] => s.match(VERSION_RE) ?? [];

interface Indexed {
  claims: Map<string, ClaimRec>;
  status: Map<string, string>;
  supersededBy: Map<string, Set<string>>;
  reason: Map<string, string>;
  /** Canonical key -> claim ids. */
  byKey: Map<string, string[]>;
  /** Union-find parent over canonical keys. */
  parent: Map<string, string>;
}

function index(d: GetDeps): Indexed {
  const reg = d.registry;
  const rule = d.ruleConfig ?? { r4: false };
  const claims = new Map<string, ClaimRec>();
  const status = new Map<string, string>();
  const supersededBy = new Map<string, Set<string>>();
  const reason = new Map<string, string>();
  const byKey = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const root = (k: string): string => { let p = parent.get(k) ?? k; while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p; parent.set(k, p); return p; };
  const union = (a: string, b: string): void => { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra, rb); };
  const link = (loser: string, winner: string, why?: string): void => {
    const set = supersededBy.get(loser) ?? new Set<string>();
    set.add(winner); supersededBy.set(loser, set);
    if (why && !reason.has(loser)) reason.set(loser, why);
  };
  const events: EventRec[] = [];
  for (const agent of Object.keys(d.ledgers).sort(cmp)) {
    const records = d.ledgers[agent] ?? [];
    let state: ClaimsState | null = null;
    try { state = derive(records, reg, rule); } catch { state = null; }
    for (const r of records) {
      if (r.t === 'event') { events.push(r); continue; }
      if (r.t !== 'claim') continue;
      claims.set(r.id, r);
      const st = state?.claims[r.id]?.status ?? 'live';
      status.set(r.id, st);
      const by = state?.claims[r.id]?.supersededBy;
      if (by) link(r.id, by);
      if (r.key) {
        const k = canonicalKey(r.key, reg);
        const list = byKey.get(k) ?? [];
        list.push(r.id); byKey.set(k, list);
        root(k);
        if (k !== r.key) union(r.key, k);
      }
    }
  }
  // supersededBy is the inverse of supersedes (Creed 5f3e80 (2)); retracts and reconcile answers also kill.
  for (const c of claims.values()) {
    for (const id of c.supersedes ?? []) link(id, c.id, c.supersedesReason?.category);
    for (const id of c.retracts ?? []) link(id, c.id, 'retracted');
  }
  for (const e of events) {
    if (e.ev === 'reconcile-answer' && e.answer === 'supersedes' && e.targets.length >= 2) link(e.targets[0], e.targets[1], 'reconcile');
    if ((e.ev === 'soft-supersede' || e.ev === 'inferred-supersede') && e.targets.length >= 2 && status.get(e.targets[0]) !== 'live') link(e.targets[0], e.targets[1], e.ev);
    if (e.ev === 'key-alias' && e.targets.length >= 2) {
      const ka = claims.get(e.targets[0])?.key, kb = claims.get(e.targets[1])?.key;
      if (ka && kb) union(canonicalKey(ka, reg), canonicalKey(kb, reg));
    }
  }
  for (const [k, v] of Object.entries(reg.keys)) if (v.aliasOf) union(k, canonicalKey(k, reg));
  for (const item of d.reconcileItems ?? []) {
    if (!String(item.kind).startsWith('key-alias')) continue;
    const ka = claims.get(item.a)?.key, kb = claims.get(item.b)?.key;
    if (ka && kb) union(canonicalKey(ka, reg), canonicalKey(kb, reg));
  }
  return { claims, status, supersededBy, reason, byKey, parent };
}

function aliasSet(ix: Indexed, key: string): string[] {
  const root = (k: string): string => { let p = ix.parent.get(k) ?? k; while (p !== (ix.parent.get(p) ?? p)) p = ix.parent.get(p) ?? p; return p; };
  const r = root(key);
  const out = new Set<string>([key]);
  for (const k of ix.parent.keys()) if (root(k) === r) out.add(k);
  for (const k of ix.byKey.keys()) if (root(k) === r) out.add(k);
  return [...out].sort(cmp);
}

const atMs = (c: ClaimRec): number => { const t = epochMs(c.at); return Number.isNaN(t) ? epochMs(c.wt) : t; };
const newestFirst = (a: ClaimRec, b: ClaimRec): number => atMs(b) - atMs(a) || cmp(b.wt, a.wt) || cmp(b.id, a.id);
const excerpt = (s: string, n = EXCERPT_MAX): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length <= n ? one : `${one.slice(0, n - 1)}…`; };
const row = (c: ClaimRec): GetClaimRow => ({ claimId: c.id, agent: c.agent, at: c.at, text: c.text, key: c.key ?? '', kind: c.kind, ...(c.refs?.length ? { refs: c.refs } : {}) });

/** The card id a `card.*` key names (lower-cased): a tasks.json id when one matches, else the key without a known field suffix. */
export function cardOf(key: string, taskIds: Set<string>): string | null {
  if (!key.startsWith(CARD_PREFIX)) return null;
  const rest = key.slice(CARD_PREFIX.length);
  if (taskIds.has(rest)) return rest;
  const stripped = rest.replace(FIELD_SUFFIX, '');
  if (taskIds.has(stripped)) return stripped;
  // Unknown to tasks.json (a pruned card): the longest form without a field suffix.
  return stripped;
}

export interface ParsedMail { id: string; from: string; to: string; act: string; subject: string; created_at: string; cardFrom: string; trust: string; body?: string; line: number }

/** The mail-cards rows (oldest first), bad lines skipped. */
export function parseMailRows(lines: string[]): ParsedMail[] {
  const out: ParsedMail[] = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      if (typeof j.id !== 'string') return;
      out.push({ id: j.id, from: String(j.from ?? ''), to: String(j.to ?? ''), act: String(j.act ?? ''), subject: String(j.subject ?? ''), created_at: String(j.created_at ?? ''), cardFrom: String(j.cardFrom ?? ''), trust: String(j.trust ?? ''), ...(typeof j.body === 'string' ? { body: j.body } : {}), line: i });
    } catch { /* a torn line is skipped, never fatal */ }
  });
  return out;
}

/** Newest-first page of distinct mails (one row per recipient in the file: recipients joined). */
export function pageMails(rows: ParsedMail[], n: number, before: string | null): { page: Array<ParsedMail & { tos: string[] }>; nextBefore: string | null } {
  let upto = rows.length;
  if (before) { const i = rows.findIndex((r) => r.id === before); if (i >= 0) upto = i; }
  const seen = new Map<string, ParsedMail & { tos: string[] }>();
  for (let i = 0; i < upto; i++) {
    const r = rows[i];
    const prev = seen.get(r.id);
    if (prev) { if (r.to && !prev.tos.includes(r.to)) prev.tos.push(r.to); continue; }
    seen.set(r.id, { ...r, tos: r.to ? [r.to] : [] });
  }
  const all = [...seen.values()].sort((a, b) => (epochMs(b.created_at) || epochMs(b.id) || 0) - (epochMs(a.created_at) || epochMs(a.id) || 0) || b.line - a.line);
  const page = all.slice(0, Math.max(0, n));
  return { page, nextBefore: all.length > page.length && page.length ? page[page.length - 1].id : null };
}

const mailRow = (m: ParsedMail & { tos: string[] }): GetMailRow => ({ id: m.id, from: m.from, to: m.tos, act: m.act, subject: m.subject, at: m.created_at, cardFrom: m.cardFrom, trust: m.trust, weak: !trustedLink(m.cardFrom), excerpt: m.body === undefined ? '' : excerpt(m.body) });

export function resolveGet(rawTerm: string, opts: GetOptions, d: GetDeps): GetResult {
  return resolveIn(index(d), normaliseTerm(rawTerm), opts, d, true);
}

/** R2: several terms over ONE index of the ledgers (the search path asks for every card its hits name). */
export function resolveGetMany(rawTerms: string[], opts: GetOptions, d: GetDeps): GetResult[] {
  const ix = index(d);
  return rawTerms.map((t) => resolveIn(ix, normaliseTerm(t), opts, d, true));
}

/** R2: the card a `card.*` claim key names, minus a known field suffix (the search path has no tasks.json at hand). */
export function cardIdOfKey(key: string): string | null {
  const k = key.toLowerCase();
  if (!k.startsWith(CARD_PREFIX)) return null;
  return k.slice(CARD_PREFIX.length).replace(FIELD_SUFFIX, '') || null;
}

function resolveIn(ix: Indexed, term: string, opts: GetOptions, d: GetDeps, withLead: boolean): GetResult {
  const taskIds = new Set((d.tasks ?? []).map((t) => String(t.id ?? '').toLowerCase()).filter(Boolean));
  const tried: string[] = [];
  let base: string | null = null;
  const claimOf = ix.claims.get(term);
  if (claimOf?.key) base = canonicalKey(claimOf.key, d.registry);
  else {
    for (const cand of [term, term.startsWith(CARD_PREFIX) ? null : `${CARD_PREFIX}${term}`]) {
      if (!cand) continue;
      tried.push(cand);
      const canon = canonicalKey(cand, d.registry);
      if (ix.byKey.has(canon) || ix.parent.has(canon) || [...ix.byKey.keys()].some((k) => k.startsWith(`${canon}.`))) { base = canon; break; }
      if (cand.startsWith(CARD_PREFIX) && taskIds.has(cand.slice(CARD_PREFIX.length))) { base = cand; break; }
      // A derived sub-key (card.<id>.donesha, ...) of a card that exists (a task, or any claim under the card) resolves
      // even when nothing was ever claimed under it: the mail rule can still answer from the card's mail (F5).
      const sub = cand.startsWith(CARD_PREFIX) ? FIELD_SUFFIX.exec(cand) : null;
      if (sub) {
        const ck = cand.slice(0, -sub[0].length);
        if (taskIds.has(ck.slice(CARD_PREFIX.length)) || ix.byKey.has(ck) || [...ix.byKey.keys()].some((k) => k.startsWith(`${ck}.`))) { base = canon; break; }
      }
    }
  }
  // Ruling 3 (god 690425): `memory get guppy/<b>` resolves to the owning card (rule (b): <b> is a card id, from
  // tasks.json or any claim under card.<b>): its merge sub-key when claimed, else the card; a branch no card owns
  // resolves to branch.<b> when claims exist under it (Creed's merge claims).
  const name = base ? null : branchName(term);
  if (name) {
    const hasKey = (k: string): boolean => ix.byKey.has(k) || [...ix.byKey.keys()].some((o) => o.startsWith(`${k}.`));
    const cardK = `${CARD_PREFIX}${name}`;
    const mergeK = `${cardK}.merge`;
    const bK = branchKeyOf(name);
    tried.push(mergeK, bK);
    if (taskIds.has(name) || hasKey(cardK)) base = ix.byKey.has(mergeK) ? mergeK : cardK;
    else if (hasKey(bK)) base = bK;
  }
  const empty: GetResult = { term, keys: [], tried, card: null, current: null, competing: [], superseded: [], decisions: [], fields: null, mails: [], nextBefore: null, mailIndex: 'off', lead: null };
  if (!base) return empty;
  // The alias set, then (card keys) every derived sub-key under any of them.
  const keySet = new Set(aliasSet(ix, base));
  const isCardKey = (k: string): boolean => k.startsWith(CARD_PREFIX);
  for (const k of [...keySet]) if (isCardKey(k)) for (const other of ix.byKey.keys()) if (other.startsWith(`${k}.`)) keySet.add(other);
  const keys = [...keySet].sort(cmp);
  const cardKey = isCardKey(base) ? base : (keys.find(isCardKey) ?? null);
  const card = cardKey ? cardOf(cardKey, taskIds) : null;
  const isDecision = (k: string): boolean => /\.decision\.[^.]+$/.test(k);
  const all: ClaimRec[] = [];
  for (const k of keys) for (const id of ix.byKey.get(k) ?? []) { const c = ix.claims.get(id); if (c) all.push(c); }
  const live = all.filter((c) => ix.status.get(c.id) === 'live');
  // MUST 1 (god 5b990a A, Jim ad1da8): a bare card key's current, competing and superseded come only from claims keyed
  // card.<id> itself or its aliases; sub-key field claims live in fields{} / decisions[] and never compete for it
  // (a derived field claim stamped at the backfill's --now outranked every real note on 10 gated rows).
  const ownKeys = new Set(aliasSet(ix, base));
  const bareCard = isCardKey(base) && !FIELD_SUFFIX.test(base);
  const owns = (c: ClaimRec): boolean => !bareCard || ownKeys.has(canonicalKey(c.key ?? '', d.registry));
  const decisions = live.filter((c) => isDecision(canonicalKey(c.key ?? '', d.registry))).sort(newestFirst).map(row);
  const values = live.filter((c) => owns(c) && !isDecision(canonicalKey(c.key ?? '', d.registry))).sort(newestFirst);
  const agent = opts.agent?.trim() || null;
  let pick: ClaimRec | undefined;
  if (agent) {
    pick = values.find((c) => c.agent === agent)
      ?? values.find((c) => c.agent === 'derived' && c.text.includes(`from ${agent} `))
      ?? values[0];
  } else pick = values[0];
  // G2 (god 6f7b2c, Jim 3a543d): for release.<v> git is the authority: the derived git-sourced claim is current
  // and agent claims (often mis-keyed to a neighbouring version) compete behind it, whatever their age.
  if (!agent && base.startsWith(RELEASE_PREFIX)) pick = values.find((c) => c.agent === 'derived') ?? pick;
  const competing = values.filter((c) => c !== pick).map(row);
  const superseded: GetSupersededRow[] = all.filter((c) => owns(c) && ix.status.get(c.id) !== 'live').sort(newestFirst).map((c) => ({
    claimId: c.id, agent: c.agent, at: c.at, key: c.key ?? '', status: ix.status.get(c.id) ?? 'unknown', excerpt: excerpt(c.text),
    supersededBy: [...(ix.supersededBy.get(c.id) ?? [])].sort(cmp), ...(ix.reason.get(c.id) ? { reason: ix.reason.get(c.id) } : {}),
  }));
  let current: GetCurrent | null = pick ? { source: 'claim', claimId: pick.id, agent: pick.agent, at: pick.at, text: pick.text, key: pick.key ?? '', ...(pick.refs?.length ? { refs: pick.refs } : {}) } : null;

  // The card's tasks.json row (primitive fields only).
  let fields: Record<string, unknown> | null = null;
  if (card) {
    const t = (d.tasks ?? []).find((x) => String(x.id ?? '').toLowerCase() === card);
    if (t) { fields = {}; for (const [k, v] of Object.entries(t)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) fields[k] = v; }
  }

  // Mail history (C90-MAILCARD) and the mail rule.
  let mails: GetMailRow[] = [];
  let nextBefore: string | null = null;
  let mailIndex: GetResult['mailIndex'] = 'off';
  if (card && d.mailRows) {
    const lines = d.mailRows(card);
    mailIndex = lines ? 'present' : 'absent';
    if (lines) {
      const rows = parseMailRows(lines);
      const n = Math.min(MAIL_MAX, Math.max(0, opts.mail ?? MAIL_DEFAULT));
      const paged = pageMails(rows, n, opts.before ?? null);
      mails = paged.page.map(mailRow);
      nextBefore = paged.nextBefore;
      if (!opts.noMail) {
        // G1 (god 6f7b2c, Jim 3a543d): only the bare card and donesha take a mail current; lastsha, status, assignee,
        // fixVersion and decisions are the card record's, so no mail outranks their claim. For donesha the question is
        // the done mail, so only act=done mails qualify; the ac6f85 done-sha fallback is for these two keys only.
        const field = base.startsWith(CARD_PREFIX) ? (FIELD_SUFFIX.exec(base)?.[1] ?? null) : null;
        const mailKey = field === null || field === 'donesha';
        const doneOnly = field === 'donesha';
        const shaField = mailKey;
        const known = new Set<string>();
        for (const c of all) { for (const s of sha7(c.text)) known.add(s); for (const v of versions(c.text)) known.add(v); for (const r of c.refs ?? []) if (r.type === 'commit') for (const s of sha7(r.value)) known.add(s); }
        const pickMs = pick ? atMs(pick) : -Infinity;
        const candidates = pageMails(rows, rows.length, null).page
          .filter((m) => mailKey && (!doneOnly || m.act === 'done') && (!agent || m.from === agent) && m.body !== undefined && trustedLink(m.cardFrom))
          .map((m) => ({ m, ms: epochMs(m.created_at) || epochMs(m.id) }))
          .filter((x) => Number.isFinite(x.ms) && x.ms > pickMs)
          .sort((a, b) => b.ms - a.ms || linkRank(b.m.cardFrom) - linkRank(a.m.cardFrom));
        for (const { m } of candidates) {
          const text = `${m.subject} ${m.body ?? ''}`;
          const hay = text.toLowerCase();
          let named = [...known].filter((v) => hay.includes(v));
          // Jim ac6f85: for a done-sha field (or the bare card) a commit sha in that agent's done mail is a known value.
          if (!named.length && shaField && m.act === 'done' && (!agent || m.from === agent)) named = sha7(text);
          if (!named.length) continue;
          const first = named.map((v) => hay.indexOf(v)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
          const body = m.body ?? '';
          let shown = `${m.subject} — ${excerpt(body, MAIL_TEXT_MAX)}`;
          if (!named.some((v) => shown.toLowerCase().includes(v))) {
            const startIn = Math.max(0, first - m.subject.length - 1 - 60);
            shown = `${m.subject} — …${excerpt(body.slice(startIn), MAIL_TEXT_MAX - m.subject.length - 4)}`;
          }
          current = { source: 'mail', mailId: m.id, agent: m.from, at: m.created_at, text: shown, key: base };
          break;
        }
      }
    }
  }
  // Step 3 fix R1 (god bbcb4a): a bare card, or a branch that resolves to its card (card.<b>.merge / card.<b>), LEADS
  // with every field's current value, each resolved exactly as `memory get card.<id>.<field>` would (the field's
  // claim, else the mail rule, else tasks.json), so the agent reads the answer without typing the field term (Jim
  // f0d494: 6 of 332 rows typed it). A release.<v> key leads with its live sub-keys (release.<v>.pause, ...).
  // Never for a field sub-key the agent typed: that reply IS the field.
  let lead: GetFieldLine[] | null = null;
  // The lead's decision count is the card's whatever key the term reached it by (a branch name resolves to the
  // merge sub-key, whose own rows hold no decision).
  let shownDecisions = decisions;
  if (withLead && card && (bareCard || name !== null)) {
    lead = [];
    if (!bareCard) {
      const rows: ClaimRec[] = [];
      for (const [k, ids] of ix.byKey) if (k.startsWith(`${CARD_PREFIX}${card}.`) && isDecision(k)) for (const id of ids) { const c = ix.claims.get(id); if (c && ix.status.get(c.id) === 'live') rows.push(c); }
      shownDecisions = rows.sort(newestFirst).map(row);
    }
    const sub: GetOptions = { agent: opts.agent ?? null, noMail: opts.noMail === true, mail: 0 };
    for (const f of CARD_FIELDS) {
      const c = resolveIn(ix, `${CARD_PREFIX}${card}.${f.toLowerCase()}`, sub, d, false).current;
      const tv = fields?.[f];
      if (c) lead.push({ field: f, value: c.text, source: c.source, id: c.source === 'mail' ? c.mailId : c.claimId, agent: c.agent, at: c.at });
      else if (tv !== undefined && tv !== null && tv !== '') lead.push({ field: f, value: String(tv), source: 'tasks' });
      else lead.push({ field: f, value: null, source: 'none' });
    }
  } else if (withLead && !card && base.startsWith(RELEASE_PREFIX)) {
    lead = [];
    for (const k of [...ix.byKey.keys()].filter((o) => o.startsWith(`${base}.`)).sort(cmp)) {
      const c = resolveIn(ix, k, { agent: opts.agent ?? null, noMail: true, mail: 0 }, d, false).current;
      const field = k.slice(base.length + 1);
      lead.push(c ? { field, value: c.text, source: c.source, id: c.claimId, agent: c.agent, at: c.at } : { field, value: null, source: 'none' });
    }
  }
  return { term, keys, tried, card, current, competing, superseded, decisions: shownDecisions, fields, mails, nextBefore, mailIndex, lead };
}

/**
 * R1: a lead value on one line: the whole text when it fits, else its head, or a window on the first sha / version
 * in it when that lies past the head (a mail current is `subject — body…`: the value the field names must be what
 * the agent reads, not the subject). A shape rule over all text, never a value list.
 */
export function leadValue(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const m = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|\b\d+\.\d+(?:\.\d+)+\b/i.exec(one);
  if (!m || m.index + m[0].length <= max - 1) return `${one.slice(0, max - 1)}…`;
  let start = Math.max(0, m.index - Math.floor(max / 3));
  const sp = one.indexOf(' ', start);
  if (sp >= 0 && sp < m.index) start = sp + 1;
  const body = one.slice(start, start + max - 2);
  return `…${body}${start + max - 2 < one.length ? '…' : ''}`;
}

/** R2: the brief a search hit carries for its card: the fields with a value, then the decision count. */
export function leadBrief(r: GetResult): string[] {
  if (!r.lead) return [];
  const out = r.lead.filter((l) => l.value !== null).map((l) => `${l.field}: ${leadValue(l.value ?? '', BRIEF_VALUE_MAX)}`);
  if (r.decisions.length) out.push(`decisions: ${r.decisions.length}`);
  return out;
}

const day = (iso: string): string => (iso || '').slice(0, 10);
const kv = (key: string, text: string): string => (key ? `${key}: ${text.replace(/\s+/g, ' ').trim()}` : text.replace(/\s+/g, ' ').trim());

const clipLine = (s: string): string => (s.length <= GET_LINE_MAX ? s : `${s.slice(0, GET_LINE_MAX - 1)}…`);
const leadLine = (l: GetFieldLine): string => {
  if (l.value === null) return `${l.field}: none`;
  const src = l.source === 'tasks' ? 'tasks.json' : `${l.source} · ${l.agent ?? '-'} · ${day(l.at ?? '')} · ${l.id ?? '-'}`;
  return `${l.field}: ${leadValue(l.value, LEAD_VALUE_MAX)} [${src}]`;
};

/** R1: the compact text's cap by construction: every line clipped to GET_LINE_MAX, the tail behind one pointer line
 *  once the whole would pass GET_MAX_CHARS (the lead block is first, so it is what always survives). */
function fitGet(lines: string[]): string {
  const ls = lines.map(clipLine);
  const cost = (xs: string[]): number => xs.reduce((n, l) => n + l.length + 1, 0);
  if (cost(ls) <= GET_MAX_CHARS) return ls.join('\n') + '\n';
  const more = (n: number): string => `… ${n} more line${n === 1 ? '' : 's'} (--all prints everything)`;
  let keep = ls.length;
  while (keep > 1 && cost(ls.slice(0, keep)) + more(ls.length - keep).length + 1 > GET_MAX_CHARS) keep--;
  return [...ls.slice(0, keep), more(ls.length - keep)].join('\n') + '\n';
}

/** The text every path prints (CLI, MCP, hook-served): identical by construction. Step 3 fix R1 (god bbcb4a): the
 *  default view is COMPACT: the lead block (`field: value [source]` lines and the decision count), the current value,
 *  the competing / superseded counts, fields and the newest mails, every line under GET_LINE_MAX and the whole under
 *  GET_MAX_CHARS by construction; `--all` / `--history` prints the decision list and the hidden bodies, uncapped. */
export function formatGet(r: GetResult, opts: GetOptions = {}): string {
  const L: string[] = [];
  if (!r.keys.length) {
    L.push(`no claim under ${r.tried.join(', ')}`);
    return L.join('\n') + '\n';
  }
  const all = opts.history === true;
  // The header: the key list gives way on a long line (its tail behind `… +N more`), never the card tag after it.
  const prefix = `get ${r.term} → keys: `;
  const suffix = `${r.card ? ` (card ${r.card})` : ''}${opts.agent ? ` [--agent ${opts.agent}]` : ''}`;
  let ks = r.keys.join(', ');
  if (!all && prefix.length + ks.length + suffix.length > GET_LINE_MAX) {
    const more = (n: number): string => `, … +${n} more`;
    let n = r.keys.length;
    while (n > 1 && prefix.length + r.keys.slice(0, n).join(', ').length + more(r.keys.length - n).length + suffix.length > GET_LINE_MAX) n--;
    ks = r.keys.slice(0, n).join(', ') + more(r.keys.length - n);
  }
  L.push(prefix + ks + suffix);
  if (r.lead) {
    for (const l of r.lead) L.push(leadLine(l));
    if (r.card && !all) L.push(`decisions: ${r.decisions.length}${r.decisions.length ? ' (--all lists them)' : ''}`);
  }
  if (r.current) {
    const c = r.current;
    L.push(`current: ${kv(c.key, c.text)}`);
    L.push(`  [${c.source} · ${c.agent} · ${day(c.at)} · ${c.source === 'mail' ? c.mailId : c.claimId}]`);
  } else L.push(`current: none (no live claim under ${r.keys.join(', ')})`);
  // T2 (god fe1140): bodies of the other rows only on --all (or with C90_HIDE_STALE=0); the counts always.
  const bodies = opts.history === true || !hideStale();
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (r.competing.length) {
    if (!bodies) L.push(`competing: ${plural(r.competing.length, 'other live value')} hidden (--all lists them)`);
    else {
      L.push(`competing (${r.competing.length}):`);
      for (const c of r.competing) L.push(`  ${kv(c.key, c.text)} [${c.agent} · ${day(c.at)} · ${c.claimId}]`);
    }
  }
  if (r.superseded.length && !bodies) L.push(`superseded: ${plural(r.superseded.length, 'replaced value')} hidden (--all lists them)`);
  else if (r.superseded.length) {
    L.push(`superseded (${r.superseded.length}):`);
    for (const s of r.superseded) L.push(`  ${kv(s.key, s.excerpt)} [${s.status} · ${s.agent} · ${day(s.at)} · ${s.claimId}${s.supersededBy.length ? ` → replaced by ${s.supersededBy.join(', ')}` : ''}${s.reason ? ` · ${s.reason}` : ''}]`);
  }
  if (r.card) {
    // A bare card key always shows its decision list (even empty); a sub-key shows it only when it has rows. Compact:
    // the count (already in the lead block when there is one), the list behind --all.
    const listed = r.decisions.length || r.keys.includes(`${CARD_PREFIX}${r.card}`);
    if (listed && !all && !r.lead) L.push(`decisions: ${r.decisions.length} (--all lists them)`);
    else if (listed && all) L.push(`decisions (${r.decisions.length}):`);
    if (all) for (const dRow of r.decisions) L.push(`  ${kv(dRow.key, dRow.text)} [${day(dRow.at)} · ${dRow.claimId}]`);
    if (r.fields) L.push(`fields: ${Object.entries(r.fields).filter(([k]) => k !== 'id').map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
    if (r.mailIndex === 'absent') L.push('mails: no mail index for this card yet (hive/state/mail-cards)');
    else if (r.mailIndex === 'present') {
      L.push(`mails (${r.mails.length} newest first${r.nextBefore ? `; older: --before ${r.nextBefore}` : ''}):`);
      for (const m of r.mails) L.push(`  ${m.id} ${m.from} → ${m.to.join(',') || '-'} ${m.act}: ${excerpt(m.subject, 100)} [${m.cardFrom}${m.weak ? ' · weak' : ''} · ${m.trust}]`);
    }
  }
  return all ? L.join('\n') + '\n' : fitGet(L);
}
