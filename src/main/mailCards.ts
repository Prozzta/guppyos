/**
 * C90-MAILCARD: every delivered message is linked to a card, and the card's mail is kept for good.
 *
 * Main writes a permanent, append-only per-card mail index under <hive>/state/mail-cards/:
 *  - `<card id lower-cased>.jsonl`: one row per delivered copy (one per recipient, same id), in
 *    delivery order, never pruned or rewritten. The MailLedger prunes acted entries after 7 days
 *    and inbox copies go with them; this index does not.
 *  - `_links.jsonl`: one link record per message id (cards, method, trust). A message id already
 *    recorded appends nothing, so a re-run is idempotent.
 * Only main writes here: rows come from routing (trust `delivery`) or from the backfill, which
 * takes a message only from main's MailLedger (`mail-ledger`) or from an inbox copy that the
 * sender's own outbox/.sent copy matches (`two-party`: two different agents' folders). An inbox
 * file nobody sent never enters.
 *
 * Link rules, the same for every message (no per-item logic): the card field when it names a
 * registry card; else the reply chain (the nearest ancestor with exactly one card); else the
 * conversation when its carded messages name exactly one card; else every registry card id the
 * subject names (mention-subject); else every one the body names (mention-body). A mention-body
 * link is WEAK (god d65b59, Jim's sample: 10 of 53 body-only links wrong): it is indexed and listed,
 * but it never sets a delivered message's card and it does not count as coverage. A conversation
 * with several cards and no other rule is `ambiguous`, never a guess. An explicit card `none`
 * marks floor-wide mail.
 * The Human's mail is linked by id only: its subject and body are never copied.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HUMAN_RELAY_RE } from '../shared/mailWakeClass';
import { cardIdValue, isValidMailId, mailBodyHash, type MailLedgerDoc } from './mailLedger';
import { mergeHotCold, readArchive } from './taskArchive';

export const MAIL_CARDS_DIR = join('state', 'mail-cards');
export const MAIL_LINKS_FILE = '_links.jsonl';
/** The explicit card of floor-wide mail. */
export const NO_CARD = 'none';
/** The most in_reply_to hops the reply rule walks. */
export const MAIL_CARD_REPLY_HOPS = 20;

export type MailLinkMethod = 'field' | 'reply' | 'conversation' | 'mention-subject' | 'mention-body' | 'ambiguous' | 'none';
/** Methods that link a message for coverage and for delivery (mention-body is listed only). */
export const TRUSTED_METHODS: ReadonlySet<MailLinkMethod> = new Set(['field', 'reply', 'conversation', 'mention-subject']);
export type MailLinkTrust = 'delivery' | 'mail-ledger' | 'two-party';

export interface MailLinkRecord {
  v: 1;
  mailId: string;
  cards: string[];
  method: MailLinkMethod;
  at: string;
  trust: MailLinkTrust;
  from?: string;
  conversation?: string;
  in_reply_to?: string;
}

export interface MailCardRow {
  v: 1;
  id: string;
  card: string;
  cards: string[];
  cardFrom: Exclude<MailLinkMethod, 'ambiguous' | 'none'>;
  from: string;
  to: string;
  act: string;
  subject?: string;
  conversation?: string;
  in_reply_to?: string;
  created_at?: string;
  deliveredAt?: number;
  bodyHash: string;
  body?: string;
  trust: MailLinkTrust;
}

export interface MailLink { cards: string[]; method: MailLinkMethod }

/** What a message offers the link rules. */
export interface LinkableMail {
  id: string;
  card?: unknown;
  in_reply_to?: unknown;
  conversation?: unknown;
  subject?: unknown;
  body?: unknown;
}

export interface LinkContext {
  /** The registry's spelling of a card id (case-insensitive), or null when no card has it. */
  cardOf(id: string): string | null;
  /** A recorded message's link, by id, or null when unknown. */
  linkOf(id: string): { cards: string[]; method: MailLinkMethod; in_reply_to?: string | null } | null;
  /** The cards the carded (field) messages of a conversation name. */
  conversationCards(conversation: string): string[];
  /** Every registry card id the text names. */
  mentions(text: string): string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** True when the message's own card field is the explicit floor-wide `none`. */
export function isNoCard(card: unknown): boolean {
  return typeof card === 'string' && card.trim().toLowerCase() === NO_CARD;
}

const INHERITED: ReadonlySet<MailLinkMethod> = new Set(['field', 'reply', 'conversation']);

/** The link rules (see the header), in order: field, reply chain, conversation, mention-subject, mention-body. */
export function linkMail(m: LinkableMail, ctx: LinkContext): MailLink {
  const own = cardIdValue(m.card);
  if (own && isNoCard(own)) return { cards: [], method: 'none' };
  const field = own ? ctx.cardOf(own) : null;
  if (field) return { cards: [field], method: 'field' };
  const seen = new Set<string>([m.id]);
  let cur = typeof m.in_reply_to === 'string' ? m.in_reply_to : null;
  for (let i = 0; cur && i < MAIL_CARD_REPLY_HOPS && !seen.has(cur); i++) {
    seen.add(cur);
    const parent = ctx.linkOf(cur);
    if (!parent) break;
    // Only a carded ancestor passes its card on (field, or itself inherited); a mention does not.
    if (INHERITED.has(parent.method) && parent.cards.length === 1) return { cards: [...parent.cards], method: 'reply' };
    if (parent.cards.length > 1) break;   // a several-card ancestor: the chain cannot choose
    cur = typeof parent.in_reply_to === 'string' ? parent.in_reply_to : null;
  }
  const conv = typeof m.conversation === 'string' && m.conversation ? [...new Set(ctx.conversationCards(m.conversation))] : [];
  if (conv.length === 1) return { cards: conv, method: 'conversation' };
  const inSubject = ctx.mentions(str(m.subject));
  if (inSubject.length) return { cards: inSubject, method: 'mention-subject' };
  const inBody = ctx.mentions(str(m.body));
  if (inBody.length) return { cards: inBody, method: 'mention-body' };
  if (conv.length > 1) return { cards: conv, method: 'ambiguous' };
  return { cards: [], method: 'none' };
}

/**
 * MAILCARD-CATCHUP-RACE: true when the message's reply chain, walked as linkMail walks it, reaches
 * an ancestor the context does not know before any ancestor settles it (one carded ancestor, or a
 * several-card one). Such a reply's link depends on mail not yet indexed.
 */
export function replyChainGap(m: LinkableMail, ctx: Pick<LinkContext, 'linkOf'>): boolean {
  const seen = new Set<string>([m.id]);
  let cur = typeof m.in_reply_to === 'string' ? m.in_reply_to : null;
  for (let i = 0; cur && i < MAIL_CARD_REPLY_HOPS && !seen.has(cur); i++) {
    seen.add(cur);
    const parent = ctx.linkOf(cur);
    if (!parent) return true;
    if (INHERITED.has(parent.method) && parent.cards.length === 1) return false;
    if (parent.cards.length > 1) return false;
    cur = typeof parent.in_reply_to === 'string' ? parent.in_reply_to : null;
  }
  return false;
}

/**
 * Registry card ids named in a text: every word (letters, digits, `.`, `_`, `-`; edge punctuation
 * trimmed) that equals a registry card id, case-insensitive. Only registry ids count; no word is
 * taken for a card by its shape. A registry id with no `-` or `.` in it (F1, M1, T1, TE0) is not
 * matched: such words are milestone and step names in prose far more often than card references
 * (at T_s, F1 alone would link 335 messages).
 */
export function registryMentions(cardIds: Iterable<string>): (text: string) => string[] {
  const canon = new Map<string, string>();
  for (const id of cardIds) if (typeof id === 'string' && /[-.]/.test(id)) canon.set(id.toLowerCase(), id);
  return (text) => {
    const out: string[] = [];
    if (!text || canon.size === 0) return out;
    for (const raw of text.split(/[^A-Za-z0-9._-]+/)) {
      const w = raw.replace(/^[._-]+|[._-]+$/g, '').toLowerCase();
      const id = w ? canon.get(w) : undefined;
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
}

/** Every card id ever made (tasks.json, then the archive), registry spelling. */
export function registryCardIds(hiveRoot: string): string[] {
  let hot: unknown[] = [];
  try {
    const j = JSON.parse(readFileSync(join(hiveRoot, 'tasks.json'), 'utf8')) as { tasks?: unknown };
    if (Array.isArray(j?.tasks)) hot = j.tasks;
  } catch { /* no tasks.json */ }
  let archived: ReturnType<typeof readArchive> = new Map();
  try { archived = readArchive(hiveRoot); } catch { /* no archive */ }
  const ids: string[] = [];
  for (const c of mergeHotCold(hot, archived)) {
    const id = (c as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && cardIdValue(id) === id && !isNoCard(id)) ids.push(id);
  }
  return ids;
}

/** The Human's mail: linked by id only (no subject, no body in the index). */
export function isHumanMail(m: { from?: unknown; subject?: unknown }): boolean {
  return m.from === 'human' || HUMAN_RELAY_RE.test(str(m.subject));
}

/** The index file of one card: its id lower-cased, or null for an id that is not a safe card id. */
export function cardFileName(card: string): string | null {
  const id = cardIdValue(card);
  if (!id || id !== card || isNoCard(id)) return null;
  return `${id.toLowerCase()}.jsonl`;
}

/**
 * The per-card mail index of one hive (main's writer). Reads `_links.jsonl` once (lazily) for the
 * recorded ids, their links and the conversations' field cards, then keeps them current as it
 * appends. A torn line is skipped.
 */
/** STARTUP-FREEZE-104 A1: the index load offers a pause every this many `_links.jsonl` lines. */
const PRIME_LINES = 500;

export class MailCardIndex {
  private links: Map<string, MailLinkRecord> | null = null;
  private convCards = new Map<string, Set<string>>();
  /** MAILCARD-CATCHUP-RACE (god 0a79ca): open startup catch-ups over this index. */
  private catchUps = 0;
  /** Live records held while a catch-up runs, in arrival order (see defer). */
  private deferred: Array<{ id: string; entries: () => { link: MailLinkRecord; rows: MailCardRow[] } | null }> = [];
  private deferredIds = new Set<string>();

  constructor(readonly hiveRoot: string) {}

  get dir(): string { return join(this.hiveRoot, MAIL_CARDS_DIR); }

  private load(): Map<string, MailLinkRecord> {
    if (this.links) return this.links;
    const links = new Map<string, MailLinkRecord>();
    const conv = new Map<string, Set<string>>();
    let text = '';
    try { text = readFileSync(join(this.dir, MAIL_LINKS_FILE), 'utf8'); } catch { /* none yet */ }
    for (const line of text.split(/\r?\n/)) MailCardIndex.parseLine(line, links, conv);
    this.links = links;
    this.convCards = conv;
    return links;
  }

  /** One `_links.jsonl` line into the maps (the first record of an id wins; a torn line is skipped). */
  private static parseLine(line: string, links: Map<string, MailLinkRecord>, conv: Map<string, Set<string>>): void {
    if (!line) return;
    try {
      const r = JSON.parse(line) as MailLinkRecord;
      if (r && typeof r.mailId === 'string' && Array.isArray(r.cards) && !links.has(r.mailId)) { links.set(r.mailId, r); MailCardIndex.noteConvInto(r, conv); }
    } catch { /* torn */ }
  }

  /**
   * STARTUP-FREEZE-104 A1: load the index as steps (the read is a yielded op, the parse offers a pause
   * every PRIME_LINES lines), for the startup catch-up. A no-op once loaded; when the router loaded it
   * meanwhile (a live delivery), its load stands and this one is dropped.
   */
  *primeSteps(): Generator<MailScanOp | undefined, void, unknown> {
    if (this.links) return;
    const text = yield { read: join(this.dir, MAIL_LINKS_FILE) };
    const links = new Map<string, MailLinkRecord>();
    const conv = new Map<string, Set<string>>();
    const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
    for (let i = 0; i < lines.length; i++) {
      MailCardIndex.parseLine(lines[i], links, conv);
      if (i % PRIME_LINES === PRIME_LINES - 1) { yield { tick: true }; if (this.links) return; }
    }
    if (this.links) return;
    this.links = links;
    this.convCards = conv;
  }

  private noteConv(r: MailLinkRecord): void { MailCardIndex.noteConvInto(r, this.convCards); }

  private static noteConvInto(r: MailLinkRecord, conv: Map<string, Set<string>>): void {
    if (r.method !== 'field' || !r.conversation || r.cards.length !== 1) return;
    const s = conv.get(r.conversation) ?? new Set<string>();
    s.add(r.cards[0]);
    conv.set(r.conversation, s);
  }

  has(mailId: string): boolean { return this.load().has(mailId); }
  linkOf(mailId: string): MailLinkRecord | null { return this.load().get(mailId) ?? null; }
  conversationCards(conversation: string): string[] { this.load(); return [...(this.convCards.get(conversation) ?? [])]; }
  get size(): number { return this.load().size; }

  /** True while a startup catch-up writes through this index. */
  get catchingUp(): boolean { return this.catchUps > 0; }
  /** True when a live record of this id waits for the catch-up to settle (the catch-up skips it). */
  isDeferred(mailId: string): boolean { return this.deferredIds.has(mailId); }
  beginCatchUp(): void { this.catchUps++; }

  /**
   * MAILCARD-CATCHUP-RACE: a live record that arrives while a catch-up runs waits, in arrival order,
   * and is recorded once the catch-up settled. So its link is decided against the whole caught-up
   * index (a reply finds a parent the catch-up has not reached yet), and the rows keep their order:
   * the older mail the catch-up records first, then the live mail as it arrived. `entries` builds the
   * record at settle time (null records nothing). An id already waiting is not queued twice.
   */
  defer(mailId: string, entries: () => { link: MailLinkRecord; rows: MailCardRow[] } | null): void {
    if (this.deferredIds.has(mailId)) return;
    this.deferredIds.add(mailId);
    this.deferred.push({ id: mailId, entries });
  }

  /**
   * Close one catch-up; when it was the last one open, record every waiting live record in arrival
   * order, append-only (an id already recorded appends nothing; one that fails is counted and the
   * rest still go). Returns what it applied.
   */
  endCatchUp(): { queued: number; recorded: number; failed: number } {
    if (this.catchUps > 0) this.catchUps--;
    const out = { queued: 0, recorded: 0, failed: 0 };
    if (this.catchUps > 0) return out;
    const queue = this.deferred;
    this.deferred = [];
    for (const d of queue) {
      out.queued++;
      try {
        const e = d.entries();
        if (e && this.record(e.link, e.rows)) out.recorded++;
      } catch { out.failed++; }
      this.deferredIds.delete(d.id);
    }
    return out;
  }

  /**
   * Record one message: its rows (one per delivered copy, into each linked card's file), then its
   * link record. A message id already recorded appends nothing (false). Rows are written before the
   * link record, so a crash in between re-writes rows on the next try (readers dedupe by id), never
   * leaves a link without its rows.
   */
  record(link: MailLinkRecord, rows: readonly MailCardRow[]): boolean {
    const links = this.load();
    if (!isValidMailId(link.mailId) || links.has(link.mailId)) return false;
    mkdirSync(this.dir, { recursive: true });
    const byFile = new Map<string, string[]>();
    for (const row of rows) {
      const f = cardFileName(row.card);
      if (!f) continue;
      const list = byFile.get(f) ?? [];
      list.push(`${JSON.stringify(row)}\n`);
      byFile.set(f, list);
    }
    for (const [f, lines] of byFile) appendFileSync(join(this.dir, f), lines.join(''));
    appendFileSync(join(this.dir, MAIL_LINKS_FILE), `${JSON.stringify(link)}\n`);
    links.set(link.mailId, link);
    this.noteConv(link);
    return true;
  }
}

/** A message as main knows it when it records it. */
export interface IndexableMail {
  id: string;
  from: string;
  act: string;
  subject?: string;
  body?: unknown;
  conversation?: string | null;
  in_reply_to?: string | null;
  created_at?: string;
  /** The recorded body hash (MailLedger) when the body itself is not proven. */
  bodyHash?: string;
}

/** The link record and rows for one message delivered to `copies` (recipient, delivery time). */
export function indexEntries(m: IndexableMail, link: MailLink, trust: MailLinkTrust, copies: ReadonlyArray<{ to: string; deliveredAt?: number }>, at: string): { link: MailLinkRecord; rows: MailCardRow[] } {
  const human = isHumanMail(m);
  const rec: MailLinkRecord = {
    v: 1, mailId: m.id, cards: [...link.cards], method: link.method, at, trust,
    ...(m.from ? { from: m.from } : {}),
    ...(m.conversation ? { conversation: m.conversation } : {}),
    ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
  };
  const rows: MailCardRow[] = [];
  if (link.method === 'ambiguous' || link.method === 'none') return { link: rec, rows };
  const bodyHash = m.body === undefined && typeof m.bodyHash === 'string' ? m.bodyHash : mailBodyHash(m.body ?? '');
  for (const card of link.cards) {
    for (const c of copies) {
      rows.push({
        v: 1, id: m.id, card, cards: [...link.cards], cardFrom: link.method, from: m.from, to: c.to, act: m.act,
        ...(!human && typeof m.subject === 'string' ? { subject: m.subject } : {}),
        ...(m.conversation ? { conversation: m.conversation } : {}),
        ...(m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
        ...(m.created_at ? { created_at: m.created_at } : {}),
        ...(Number.isFinite(c.deliveredAt) ? { deliveredAt: c.deliveredAt } : {}),
        bodyHash,
        ...(!human && typeof m.body === 'string' ? { body: m.body } : {}),
        trust,
      });
    }
  }
  return { link: rec, rows };
}

/** The link context over an index and a registry (the router's and the backfill's). */
export function indexLinkContext(index: { linkOf(id: string): MailLinkRecord | null; conversationCards(c: string): string[] }, cardIds: readonly string[]): LinkContext {
  const canon = new Map(cardIds.map((c) => [c.toLowerCase(), c]));
  return {
    cardOf: (id) => canon.get(id.toLowerCase()) ?? null,
    linkOf: (id) => index.linkOf(id),
    conversationCards: (c) => index.conversationCards(c),
    mentions: registryMentions(cardIds),
  };
}

// ———————————————————————————————————————————————————————————— backfill

export interface BackfillMail extends IndexableMail {
  card?: unknown;
  trust: MailLinkTrust;
  copies: Array<{ to: string; deliveredAt?: number }>;
}

export interface MailCardBackfillCounts {
  mails: number;
  recorded: number;
  already: number;
  byMethod: Record<string, number>;
  byAct: Record<string, Record<string, number>>;
  byFrom: Record<string, Record<string, number>>;
  byTrust: Record<string, number>;
  excluded: Record<string, number>;
  unlinked: string[];
  /** Mails linked only by a body mention (weak: indexed, not coverage). */
  weak: number;
  /** Mails with a trusted link (TRUSTED_METHODS), the coverage numerator. */
  covered: number;
  /** Live mails the router holds for this catch-up's settle (MAILCARD-CATCHUP-RACE): skipped here. */
  deferred: number;
}

type SentKey = string;
const norm = (v: unknown): string => str(v).replace(/\r\n/g, '\n').trim();
const sentKey = (from: string, to: string, subject: unknown, body: unknown): SentKey => JSON.stringify([from, to, norm(subject), norm(body)]);
/** STARTUP-FREEZE-104 A1: a sent copy's key as the scan manifest keeps it (128 bits of its sha256). */
const keyHash = (k: SentKey): string => createHash('sha256').update(k).digest('hex').slice(0, 32);

// ———————————————————————————————————————————————————————————— file steps
//
// STARTUP-FREEZE-104 A1: the proven-mail read and the backfill never touch the disk themselves. They
// YIELD each file operation and are resumed with its result, so one code path serves two drivers:
// `drain` (the backfill script, readProvenMail, the tests) runs every op synchronously, and the startup
// catch-up runs every op through node:fs/promises (off the main thread) and pauses whenever main has
// worked for CATCHUP_SLICE_MS. On the Human's floor the old per-folder sync reads blocked main for
// 5-25 s per folder (about 29k mail files, cold cache).

/** One file operation a step generator asks its driver for; `tick` only offers a pause. */
export type MailScanOp = { readdir: string } | { read: string } | { write: string; text: string } | { tick: true };
/** A step: a file op, or undefined (a pause point the startup catch-up always honours). */
type Step = MailScanOp | undefined;
type Steps<T> = Generator<Step, T, unknown>;
const TICK: MailScanOp = { tick: true };

function* listJsonStep(dir: string): Steps<string[]> {
  const r = yield { readdir: dir };
  return Array.isArray(r) ? (r as string[]).filter((n) => typeof n === 'string' && n.endsWith('.json')).sort() : [];
}
function* readJsonStep(file: string): Steps<unknown> {
  const t = yield { read: file };
  if (typeof t !== 'string') return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** The op, synchronously (drain). A failed readdir is [], a failed read undefined; a write is atomic. */
function runOpSync(op: Step): unknown {
  if (!op || 'tick' in op) return undefined;
  if ('readdir' in op) { try { return readdirSync(op.readdir); } catch { return []; } }
  if ('read' in op) { try { return readFileSync(op.read, 'utf8'); } catch { return undefined; } }
  mkdirSync(dirname(op.write), { recursive: true });
  const tmp = `${op.write}.tmp-${process.pid}`;
  writeFileSync(tmp, op.text);
  renameSync(tmp, op.write);
  return undefined;
}

/** The op through node:fs/promises (the startup catch-up): the read itself never runs on main. */
async function runOpAsync(op: MailScanOp): Promise<unknown> {
  if ('tick' in op) return undefined;
  if ('readdir' in op) { try { return await fsp.readdir(op.readdir); } catch { return []; } }
  if ('read' in op) { try { return await fsp.readFile(op.read, 'utf8'); } catch { return undefined; } }
  await fsp.mkdir(dirname(op.write), { recursive: true });
  const tmp = `${op.write}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, op.text);
  await fsp.rename(tmp, op.write);
  return undefined;
}

/** Runs a step generator to its end without pausing, every op synchronously (the script's and the tests' readers). */
function drain<T>(g: Steps<T>): T {
  let input: unknown;
  for (;;) { const r = g.next(input); if (r.done) return r.value; input = runOpSync(r.value); }
}

// ———————————————————————————————————————————————————————————— scan manifest
//
// STARTUP-FREEZE-104 A1: state/mail-cards/_scan/<agent>.json keeps, per handled-mail file name, the
// facts the proof needs: a sent copy's key hashes, an inbox copy's id, sender, act and the two key
// hashes that would prove it. It is a cache of file contents (mail files are written once and never
// edited), never a record of what was indexed: whether a mail is indexed is always the index's own
// answer. So a start reads only files it has not seen, plus the proven files whose id the index lacks.
// A missing, unreadable or other-version manifest is a full read of that agent, as before.

export const MAIL_SCAN_DIR = '_scan';
const MAIL_SCAN_VERSION = 1;
/** One inbox copy the scan read: proven two-party when one of `k` is a sent key. */
interface InboxScan { id: string; from: string; act: string; k: [string, string] }
/** One inbox copy whose sender is its own agent (never proven). */
interface SelfScan { x: 'self-mail' }
interface AgentScan { v: typeof MAIL_SCAN_VERSION; sent: Record<string, string[]>; inbox: Record<string, InboxScan | SelfScan>; done: Record<string, InboxScan | SelfScan> }

const emptyScan = (): AgentScan => ({ v: MAIL_SCAN_VERSION, sent: {}, inbox: {}, done: {} });
const scanFile = (hiveRoot: string, agent: string): string => join(hiveRoot, MAIL_CARDS_DIR, MAIL_SCAN_DIR, `${agent}.json`);

function validScan(v: unknown): AgentScan | null {
  const s = v as AgentScan | null;
  if (!s || typeof s !== 'object' || s.v !== MAIL_SCAN_VERSION) return null;
  for (const k of ['sent', 'inbox', 'done'] as const) if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) return null;
  return s;
}
function validInbox(e: unknown): InboxScan | SelfScan | null {
  const r = e as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.x === 'self-mail') return { x: 'self-mail' };
  if (typeof r.id !== 'string' || !isValidMailId(r.id) || typeof r.from !== 'string' || typeof r.act !== 'string') return null;
  if (!Array.isArray(r.k) || r.k.length !== 2 || !r.k.every((x) => typeof x === 'string')) return null;
  return { id: r.id, from: r.from, act: r.act, k: [r.k[0] as string, r.k[1] as string] };
}

/** What the proven-mail steps also hand back: the scan manifest as the files are now, per agent. */
interface ProvenMail {
  mails: BackfillMail[];
  excluded: Record<string, number>;
  /** Per agent, the manifest of its handled-mail files as read now (written by the backfill). */
  scans: Map<string, { now: AgentScan; text: string | null }>;
}

export interface ProvenMailOptions {
  /**
   * STARTUP-FREEZE-104 A1 (the startup catch-up): the ids the index already holds. With it, the scan
   * manifest stands in for the files it has seen, and a proven copy whose id the index holds is taken
   * from the manifest (id, sender, act), not read: the index records nothing for such an id anyway.
   */
  known?: (id: string) => boolean;
}

/**
 * The messages a hive's primary records prove were delivered (see the header): main's MailLedger
 * entries (the body only when an inbox copy hashes to the entry's bodyHash), and inbox / inbox/.done
 * copies the sender's outbox/.sent copy matches (same recipient or broadcast, subject and body;
 * sender and recipient different agents). Every other copy is counted in `excluded` by reason.
 */
export function readProvenMail(hiveRoot: string): { mails: BackfillMail[]; excluded: Record<string, number> } {
  const { mails, excluded } = drain(provenMailSteps(hiveRoot));
  return { mails, excluded };
}

/**
 * readProvenMail as steps: every file op is yielded (see "file steps"), and every bare `yield` is a
 * point the startup catch-up pauses at (after each agent's sent copies, each MailLedger file and each
 * inbox folder), so the main loop keeps turning. With `o.known` (the startup catch-up), only files the
 * scan manifest lacks are read, plus proven copies whose id the index lacks.
 */
function* provenMailSteps(hiveRoot: string, o: ProvenMailOptions = {}): Steps<ProvenMail> {
  const excluded: Record<string, number> = {};
  const skip = (why: string): void => { excluded[why] = (excluded[why] ?? 0) + 1; };
  const agentsDir = join(hiveRoot, 'agents');
  const agents = ((yield { readdir: agentsDir }) as string[] | undefined ?? []).filter((a) => isValidMailId(a));
  const godId = ((r) => (typeof (r as { godId?: unknown } | undefined)?.godId === 'string' ? (r as { godId: string }).godId : 'god'))(yield* readJsonStep(join(hiveRoot, 'registry.json')));
  const recipientOf = (to: unknown): string => (to === 'god' || to === 'human' ? godId : str(to));
  const incremental = typeof o.known === 'function';
  // the scan manifests of the last start (the startup catch-up only)
  const prior = new Map<string, AgentScan>();
  const scans = new Map<string, { now: AgentScan; text: string | null }>();
  for (const a of agents) {
    let text: string | null = null;
    if (incremental) {
      const t = yield { read: scanFile(hiveRoot, a) };
      if (typeof t === 'string') {
        text = t;
        let s: AgentScan | null = null;
        try { s = validScan(JSON.parse(t)); } catch { s = null; }
        if (s) prior.set(a, s);
      }
      yield TICK;
    }
    scans.set(a, { now: emptyScan(), text });
  }
  // the senders' own copies
  const sent = new Set<string>();
  for (const a of agents) {
    const was = prior.get(a)?.sent ?? {};
    const now = scans.get(a)!.now.sent;
    for (const f of yield* listJsonStep(join(agentsDir, a, 'outbox', '.sent'))) {
      let keys = Array.isArray(was[f]) && was[f].every((k) => typeof k === 'string') ? was[f] : null;
      if (!keys) {
        const m = (yield* readJsonStep(join(agentsDir, a, 'outbox', '.sent', f))) as Record<string, unknown> | undefined;
        if (!m || typeof m !== 'object') continue;
        keys = ([] as unknown[]).concat(m.to ?? []).map((to) => keyHash(sentKey(a, to === 'broadcast' ? 'broadcast' : recipientOf(to), m.subject, m.body)));
      }
      now[f] = keys;
      for (const k of keys) sent.add(k);
      yield TICK;
    }
    yield;
  }
  const byId = new Map<string, BackfillMail>();
  const put = (m: BackfillMail): void => {
    const prior = byId.get(m.id);
    if (!prior) { byId.set(m.id, m); return; }
    for (const c of m.copies) if (!prior.copies.some((p) => p.to === c.to)) prior.copies.push(c);
    if (prior.trust !== 'mail-ledger' && m.trust === 'mail-ledger') prior.trust = 'mail-ledger';
    if (prior.body === undefined && m.body !== undefined) prior.body = m.body;
  };
  // main's MailLedger
  const ledgered = new Set<string>();
  for (const f of yield* listJsonStep(join(hiveRoot, 'state', 'mail'))) {
    const agent = f.slice(0, -'.json'.length);
    if (!isValidMailId(agent)) continue;
    const doc = (yield* readJsonStep(join(hiveRoot, 'state', 'mail', f))) as MailLedgerDoc | undefined;
    if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object') continue;
    for (const e of Object.values(doc.entries)) {
      if (!e || !isValidMailId(e.id)) continue;
      ledgered.add(`${agent}/${e.id}`);
      let body: unknown;
      // The body is looked up only for a mail the index does not hold (it records nothing for one it does).
      if (typeof e.bodyHash === 'string' && !(incremental && o.known!(e.id))) {
        for (const file of [join(agentsDir, agent, 'inbox', `${e.id}.json`), join(agentsDir, agent, 'inbox', '.done', `${e.id}.json`)]) {
          const m = (yield* readJsonStep(file)) as { body?: unknown } | undefined;
          if (m && typeof m === 'object' && mailBodyHash(m.body ?? '') === e.bodyHash) { body = m.body; break; }
        }
      }
      put({
        id: e.id, from: str(e.from), act: str(e.act), subject: str(e.subject),
        ...(body !== undefined ? { body } : typeof e.bodyHash === 'string' ? { bodyHash: e.bodyHash } : {}),
        ...(e.cardId ? { card: e.cardId } : {}),
        ...(e.conversation ? { conversation: e.conversation } : {}),
        ...(e.inReplyTo ? { in_reply_to: e.inReplyTo } : {}),
        ...(Number.isFinite(e.deliveredAt) ? { created_at: new Date(e.deliveredAt).toISOString() } : {}),
        trust: 'mail-ledger',
        copies: [{ to: agent, ...(Number.isFinite(e.deliveredAt) ? { deliveredAt: e.deliveredAt } : {}) }],
      });
      yield TICK;
    }
    yield;
  }
  // inbox copies, two-party only
  for (const a of agents) {
    const was = prior.get(a);
    const scan = scans.get(a)!.now;
    for (const [dir, slot] of [[join(agentsDir, a, 'inbox'), 'inbox'], [join(agentsDir, a, 'inbox', '.done'), 'done']] as const) {
      for (const f of yield* listJsonStep(dir)) {
        // A copy moved from inbox to inbox/.done keeps its name: the manifest of either folder serves.
        let e = validInbox(was?.[slot][f]) ?? validInbox(was?.[slot === 'done' ? 'inbox' : 'done'][f]);
        let m: Record<string, unknown> | undefined;
        if (!e) {
          m = (yield* readJsonStep(join(dir, f))) as Record<string, unknown> | undefined;
          if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !isValidMailId(m.id)) { skip('unreadable'); continue; }
          const from = str(m.from);
          e = !from || from === a
            ? { x: 'self-mail' }
            : { id: m.id, from, act: str(m.act), k: [keyHash(sentKey(from, a, m.subject, m.body)), keyHash(sentKey(from, 'broadcast', m.subject, m.body))] };
        }
        scan[slot][f] = e;
        yield TICK;
        if ('x' in e) { skip('self-mail'); continue; }
        if (ledgered.has(`${a}/${e.id}`)) continue;
        if (!sent.has(e.k[0]) && !sent.has(e.k[1])) { skip(agents.includes(e.from) ? 'no-sender-copy' : 'sender-not-an-agent'); continue; }
        if (!m && incremental && o.known!(e.id)) {
          // Proven and already indexed: what the counts need comes from the manifest; nothing is recorded.
          put({ id: e.id, from: e.from, act: e.act, subject: '', trust: 'two-party', copies: [{ to: a }] });
          continue;
        }
        if (!m) {
          m = (yield* readJsonStep(join(dir, f))) as Record<string, unknown> | undefined;
          if (!m || typeof m !== 'object' || m.id !== e.id) { skip('unreadable'); delete scan[slot][f]; continue; }
        }
        const at = typeof m.created_at === 'string' && !Number.isNaN(Date.parse(m.created_at)) ? new Date(Date.parse(m.created_at)).toISOString() : undefined;
        put({
          id: e.id, from: e.from, act: str(m.act), subject: str(m.subject), body: m.body,
          ...(m.card !== undefined ? { card: m.card } : {}),
          ...(typeof m.conversation === 'string' ? { conversation: m.conversation } : {}),
          ...(typeof m.in_reply_to === 'string' ? { in_reply_to: m.in_reply_to } : {}),
          ...(at ? { created_at: at } : {}),
          trust: 'two-party',
          copies: [{ to: a }],
        });
      }
      yield;
    }
  }
  return { mails: [...byId.values()], excluded, scans };
}

/**
 * Link and record every proven message, oldest first (so a reply finds its parent's link), into
 * the hive's index. Field cards of every proven message are known up front, so the conversation
 * rule sees the whole conversation. Idempotent: recorded ids append nothing.
 */
export function backfillMailCards(hiveRoot: string, now: string): MailCardBackfillCounts {
  return drain(backfillMailCardSteps(hiveRoot, now));
}

/** The startup catch-up pauses after this many linked messages. */
export const CATCHUP_SLICE = 200;
/** STARTUP-FREEZE-104 A1: the startup catch-up pauses once main has worked this long since its last pause. */
export const CATCHUP_SLICE_MS = 8;

/**
 * backfillMailCards as steps (the same code, so the startup catch-up and the script give one index):
 * the proven-mail steps, then a `yield` every CATCHUP_SLICE messages. `index` is the writer to record
 * through (main passes the router's own instance, so both see one set of recorded ids). With
 * `incremental` (the startup catch-up), the scan manifest stands in for files already seen (see
 * ProvenMailOptions). Either way the manifest is written last, for the agents whose files changed.
 */
export function* backfillMailCardSteps(hiveRoot: string, now: string, index: MailCardIndex = new MailCardIndex(hiveRoot), incremental = false): Generator<Step, MailCardBackfillCounts, unknown> {
  if (incremental) yield* index.primeSteps();
  const { mails, excluded, scans } = yield* provenMailSteps(hiveRoot, incremental ? { known: (id) => index.has(id) } : {});
  const cardIds = registryCardIds(hiveRoot);
  const canon = new Map(cardIds.map((c) => [c.toLowerCase(), c]));
  const conv = new Map<string, Set<string>>();
  for (const m of mails) {
    const own = cardIdValue(m.card);
    const c = own ? canon.get(own.toLowerCase()) : undefined;
    if (c && m.conversation) { const s = conv.get(m.conversation) ?? new Set<string>(); s.add(c); conv.set(m.conversation, s); }
  }
  const linked = new Map<string, MailLinkRecord>();
  const ctx = indexLinkContext({
    linkOf: (id) => linked.get(id) ?? index.linkOf(id),
    // Incremental: the indexed mails' field cards come from the index (a field link records its conversation).
    conversationCards: (c) => [...new Set([...(conv.get(c) ?? []), ...(incremental ? index.conversationCards(c) : [])])],
  }, cardIds);
  const counts: MailCardBackfillCounts = { mails: mails.length, recorded: 0, already: 0, byMethod: {}, byAct: {}, byFrom: {}, byTrust: {}, excluded, unlinked: [], weak: 0, covered: 0, deferred: 0 };
  const bump = (o: Record<string, Record<string, number>>, k: string, method: string): void => { const r = (o[k] = o[k] ?? {}); r[method] = (r[method] ?? 0) + 1; };
  const order = [...mails].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  let n = 0;
  for (const m of order) {
    if (n++ % CATCHUP_SLICE === CATCHUP_SLICE - 1) yield;
    else yield TICK;
    // A live mail delivered during this catch-up is the router's: it is recorded once, at settle.
    if (index.isDeferred(m.id)) { counts.deferred++; continue; }
    const prior = index.linkOf(m.id);
    const link: MailLink = prior ? { cards: prior.cards, method: prior.method } : linkMail(m, ctx);
    const fresh = prior ? null : indexEntries(m, link, m.trust, m.copies, now);
    linked.set(m.id, prior ?? fresh!.link);
    if (prior) counts.already++;
    else if (index.record(fresh!.link, fresh!.rows)) counts.recorded++;
    counts.byMethod[link.method] = (counts.byMethod[link.method] ?? 0) + 1;
    counts.byTrust[m.trust] = (counts.byTrust[m.trust] ?? 0) + 1;
    bump(counts.byAct, m.act || '?', link.method);
    bump(counts.byFrom, m.from || '?', link.method);
    if (link.method === 'none' || link.method === 'ambiguous') counts.unlinked.push(m.id);
    if (link.method === 'mention-body') counts.weak++;
    if (TRUSTED_METHODS.has(link.method)) counts.covered++;
  }
  // the scan manifest, last, only where it changed (sorted, so one floor gives one file)
  for (const [a, s] of scans) {
    const text = JSON.stringify(sortedScan(s.now));
    if (text !== s.text) yield { write: scanFile(hiveRoot, a), text };
  }
  return counts;
}

const sortedObj = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const sortedScan = (s: AgentScan): AgentScan => ({ v: s.v, sent: sortedObj(s.sent), inbox: sortedObj(s.inbox), done: sortedObj(s.done) });

// ———————————————————————————————————————————————————————————— startup catch-up

/** The log row of one startup catch-up (counts), and of one that failed. */
export const MAILCARDS_BACKFILL_ROW = 'mailcards-backfill';
export const MAILCARDS_BACKFILL_FAILED_ROW = 'mailcards-backfill-failed';
/** The log row of the live records a catch-up held and then recorded (MAILCARD-CATCHUP-RACE). */
export const MAILCARDS_DEFERRED_ROW = 'mailcards-deferred';

export interface MailCardCatchUpDeps {
  log: (row: Record<string, unknown>) => void;
  /** The router's index of this root (one set of recorded ids with routing); a fresh one without. */
  index?: MailCardIndex | null;
  /** The link records' `at` (the runner passes T_s for a byte-equal `_links.jsonl`); now otherwise. */
  now?: () => string;
  /** What a step pause awaits (a macrotask turn: the window and the router keep going). */
  pause?: () => Promise<void>;
  /** STARTUP-FREEZE-104 A1: runs one file op off main (node:fs/promises by default; tests count ops). */
  runOp?: (op: MailScanOp) => Promise<unknown>;
  /** The clock of the main-work budget (ms); performance.now by default. */
  clock?: () => number;
}

/**
 * MAILCARD catch-up at every app start (god 38f4b0): indexes every proven message not yet in
 * state/mail-cards (mail delivered while the app was closed included) with the backfill's own link
 * rules and trust levels, through the router's index. Writes only state/mail-cards, never mail or
 * ledgers. Idempotent: a second start records nothing. Logs one `mailcards-backfill` row with the
 * counts; a failure logs `mailcards-backfill-failed` and resolves null (never throws). The derived
 * writer starts only once this settled (Jim 414b4c).
 * STARTUP-FREEZE-104 A1: nothing runs in the caller's turn (the first step waits a pause), every file
 * op runs off main, main pauses once it has worked CATCHUP_SLICE_MS, and the scan manifest means a
 * start reads only the mail files it has not seen.
 */
export async function startupMailCardCatchUp(hiveRoot: string, d: MailCardCatchUpDeps): Promise<MailCardBackfillCounts | null> {
  const pause = d.pause ?? (() => new Promise<void>((r) => setImmediate(r)));
  const runOp = d.runOp ?? runOpAsync;
  const clock = d.clock ?? (() => performance.now());
  const t0 = Date.now();
  let steps = 0;
  const index = d.index ?? new MailCardIndex(hiveRoot);
  // MAILCARD-CATCHUP-RACE: the router holds its live records until this settles (success or failure).
  index.beginCatchUp();
  try {
    // Never in the caller's turn (claimsEndpoint can be reached from an IPC handler).
    await pause();
    const g = backfillMailCardSteps(hiveRoot, (d.now ?? (() => new Date().toISOString()))(), index, true);
    let input: unknown;
    let slice = clock();
    for (;;) {
      const r = g.next(input);
      input = undefined;
      if (r.done) {
        const c = r.value;
        d.log({ kind: MAILCARDS_BACKFILL_ROW, mails: c.mails, recorded: c.recorded, already: c.already, covered: c.covered, weak: c.weak, unlinked: c.unlinked.length, byMethod: c.byMethod, byTrust: c.byTrust, excluded: c.excluded, steps, ms: Date.now() - t0 });
        return c;
      }
      const op = r.value;
      if (op && !('tick' in op)) input = await runOp(op);
      if (!op || clock() - slice >= CATCHUP_SLICE_MS) {
        steps++;
        await pause();
        slice = clock();
      }
    }
  } catch (e) {
    d.log({ kind: MAILCARDS_BACKFILL_FAILED_ROW, error: String(e).slice(0, 200), steps, ms: Date.now() - t0 });
    return null;
  } finally {
    // Never throws: the held live records are recorded, then their count is logged.
    try {
      const s = index.endCatchUp();
      if (s.queued) d.log({ kind: MAILCARDS_DEFERRED_ROW, ...s });
    } catch { /* the settle never fails the catch-up */ }
  }
}

/**
 * The derived writer starts only once the catch-up settled, success or failure (it reads the index's
 * done mails: started beside a running catch-up its ledger would depend on timing). Nothing else waits.
 */
export function startAfterMailCardCatchUp(catchUp: Promise<unknown>, startDerived: () => void): Promise<void> {
  return catchUp.then(() => undefined, () => undefined).then(() => { startDerived(); });
}
