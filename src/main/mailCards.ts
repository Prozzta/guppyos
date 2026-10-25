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
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
export class MailCardIndex {
  private links: Map<string, MailLinkRecord> | null = null;
  private convCards = new Map<string, Set<string>>();

  constructor(readonly hiveRoot: string) {}

  get dir(): string { return join(this.hiveRoot, MAIL_CARDS_DIR); }

  private load(): Map<string, MailLinkRecord> {
    if (this.links) return this.links;
    const links = new Map<string, MailLinkRecord>();
    let text = '';
    try { text = readFileSync(join(this.dir, MAIL_LINKS_FILE), 'utf8'); } catch { /* none yet */ }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as MailLinkRecord;
        if (r && typeof r.mailId === 'string' && Array.isArray(r.cards) && !links.has(r.mailId)) { links.set(r.mailId, r); this.noteConv(r); }
      } catch { /* torn */ }
    }
    this.links = links;
    return links;
  }

  private noteConv(r: MailLinkRecord): void {
    if (r.method !== 'field' || !r.conversation || r.cards.length !== 1) return;
    const s = this.convCards.get(r.conversation) ?? new Set<string>();
    s.add(r.cards[0]);
    this.convCards.set(r.conversation, s);
  }

  has(mailId: string): boolean { return this.load().has(mailId); }
  linkOf(mailId: string): MailLinkRecord | null { return this.load().get(mailId) ?? null; }
  conversationCards(conversation: string): string[] { this.load(); return [...(this.convCards.get(conversation) ?? [])]; }
  get size(): number { return this.load().size; }

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
}

type SentKey = string;
const norm = (v: unknown): string => str(v).replace(/\r\n/g, '\n').trim();
const sentKey = (from: string, to: string, subject: unknown, body: unknown): SentKey => JSON.stringify([from, to, norm(subject), norm(body)]);

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}
const listJson = (dir: string): string[] => { try { return readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; } };

/**
 * The messages a hive's primary records prove were delivered (see the header): main's MailLedger
 * entries (the body only when an inbox copy hashes to the entry's bodyHash), and inbox / inbox/.done
 * copies the sender's outbox/.sent copy matches (same recipient or broadcast, subject and body;
 * sender and recipient different agents). Every other copy is counted in `excluded` by reason.
 */
export function readProvenMail(hiveRoot: string): { mails: BackfillMail[]; excluded: Record<string, number> } {
  const excluded: Record<string, number> = {};
  const skip = (why: string): void => { excluded[why] = (excluded[why] ?? 0) + 1; };
  const agentsDir = join(hiveRoot, 'agents');
  let agents: string[] = [];
  try { agents = readdirSync(agentsDir).filter((a) => isValidMailId(a)); } catch { /* none */ }
  const godId = ((): string => { const r = readJson(join(hiveRoot, 'registry.json')) as { godId?: unknown } | undefined; return typeof r?.godId === 'string' ? r.godId : 'god'; })();
  const recipientOf = (to: unknown): string => (to === 'god' || to === 'human' ? godId : str(to));
  // the senders' own copies
  const sent = new Set<SentKey>();
  for (const a of agents) {
    for (const f of listJson(join(agentsDir, a, 'outbox', '.sent'))) {
      const m = readJson(join(agentsDir, a, 'outbox', '.sent', f)) as Record<string, unknown> | undefined;
      if (!m || typeof m !== 'object') continue;
      for (const to of ([] as unknown[]).concat(m.to ?? [])) sent.add(sentKey(a, to === 'broadcast' ? 'broadcast' : recipientOf(to), m.subject, m.body));
    }
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
  for (const f of listJson(join(hiveRoot, 'state', 'mail'))) {
    const agent = f.slice(0, -'.json'.length);
    if (!isValidMailId(agent)) continue;
    const doc = readJson(join(hiveRoot, 'state', 'mail', f)) as MailLedgerDoc | undefined;
    if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object') continue;
    for (const e of Object.values(doc.entries)) {
      if (!e || !isValidMailId(e.id)) continue;
      ledgered.add(`${agent}/${e.id}`);
      let body: unknown;
      if (typeof e.bodyHash === 'string') {
        for (const file of [join(agentsDir, agent, 'inbox', `${e.id}.json`), join(agentsDir, agent, 'inbox', '.done', `${e.id}.json`)]) {
          const m = readJson(file) as { body?: unknown } | undefined;
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
    }
  }
  // inbox copies, two-party only
  for (const a of agents) {
    for (const dir of [join(agentsDir, a, 'inbox'), join(agentsDir, a, 'inbox', '.done')]) {
      for (const f of listJson(dir)) {
        const m = readJson(join(dir, f)) as Record<string, unknown> | undefined;
        if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !isValidMailId(m.id)) { skip('unreadable'); continue; }
        if (ledgered.has(`${a}/${m.id}`)) continue;
        const from = str(m.from);
        if (!from || from === a) { skip('self-mail'); continue; }
        if (!sent.has(sentKey(from, a, m.subject, m.body)) && !sent.has(sentKey(from, 'broadcast', m.subject, m.body))) { skip(agents.includes(from) ? 'no-sender-copy' : 'sender-not-an-agent'); continue; }
        const at = typeof m.created_at === 'string' && !Number.isNaN(Date.parse(m.created_at)) ? new Date(Date.parse(m.created_at)).toISOString() : undefined;
        put({
          id: m.id, from, act: str(m.act), subject: str(m.subject), body: m.body,
          ...(m.card !== undefined ? { card: m.card } : {}),
          ...(typeof m.conversation === 'string' ? { conversation: m.conversation } : {}),
          ...(typeof m.in_reply_to === 'string' ? { in_reply_to: m.in_reply_to } : {}),
          ...(at ? { created_at: at } : {}),
          trust: 'two-party',
          copies: [{ to: a }],
        });
      }
    }
  }
  return { mails: [...byId.values()], excluded };
}

/**
 * Link and record every proven message, oldest first (so a reply finds its parent's link), into
 * the hive's index. Field cards of every proven message are known up front, so the conversation
 * rule sees the whole conversation. Idempotent: recorded ids append nothing.
 */
export function backfillMailCards(hiveRoot: string, now: string): MailCardBackfillCounts {
  const { mails, excluded } = readProvenMail(hiveRoot);
  const cardIds = registryCardIds(hiveRoot);
  const index = new MailCardIndex(hiveRoot);
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
    conversationCards: (c) => [...(conv.get(c) ?? [])],
  }, cardIds);
  const counts: MailCardBackfillCounts = { mails: mails.length, recorded: 0, already: 0, byMethod: {}, byAct: {}, byFrom: {}, byTrust: {}, excluded, unlinked: [], weak: 0, covered: 0 };
  const bump = (o: Record<string, Record<string, number>>, k: string, method: string): void => { const r = (o[k] = o[k] ?? {}); r[method] = (r[method] ?? 0) + 1; };
  const order = [...mails].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id));
  for (const m of order) {
    const prior = index.linkOf(m.id);
    const link: MailLink = prior ? { cards: prior.cards, method: prior.method } : linkMail(m, ctx);
    const { link: rec, rows } = indexEntries(m, link, m.trust, m.copies, now);
    linked.set(m.id, prior ?? rec);
    if (prior) counts.already++;
    else if (index.record(rec, rows)) counts.recorded++;
    counts.byMethod[link.method] = (counts.byMethod[link.method] ?? 0) + 1;
    counts.byTrust[m.trust] = (counts.byTrust[m.trust] ?? 0) + 1;
    bump(counts.byAct, m.act || '?', link.method);
    bump(counts.byFrom, m.from || '?', link.method);
    if (link.method === 'none' || link.method === 'ambiguous') counts.unlinked.push(m.id);
    if (link.method === 'mention-body') counts.weak++;
    if (TRUSTED_METHODS.has(link.method)) counts.covered++;
  }
  return counts;
}
