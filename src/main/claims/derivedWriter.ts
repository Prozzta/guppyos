/**
 * CLAIMS-90 M5: the derived writer. It turns derived facts (derivedFacts.ts) into claims with source
 * 'derived' in the reserved DERIVED_AGENT_ID ledger, through the store's own append path (origin
 * 'derived-internal', the only one that may write that ledger), so the chain, MAC, index and anchors
 * are the store's.
 *
 * Per SLOT one live claim. IDEMPOTENT: a fact whose slot already holds a live claim with the same
 * key, text and refs appends nothing (so no R1 sighting either); a changed fact supersedes the
 * writer's own previous claim(s) for that slot (reason `changed`). A slot no fact names any more is
 * left as it is (nothing is retracted).
 *
 * L1 (god 69bc66): a fact's structured value (and value agent) is part of "the same": a live claim with the same
 * key, text and refs but another value (an older claim written before values existed) is superseded by the
 * same fact with its value (reason `corrected`, note "structured value"), so one sync backfills every field claim.
 *
 * The backfill reads the primary records of a hive (tasks.json and tasks-archive, the done mails main's
 * MailLedger recorded at delivery, the CHANGELOG and tags) and syncs every fact. The app runs it at
 * start; the CLAIMS-90 runner runs it over the frozen T_s copy (scripts/claims-derived-backfill.cjs).
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { sliceTicker } from './migrate';
import { join } from 'node:path';
import { DERIVED_AGENT_ID, type AppendOrigin, type AppendResult, type ClaimRec, type ClaimsState, type DeriveFn, type KeyRegistry, type LedgerRec, type ReadResult, type RecordDraft } from '../../shared/claims';
import {
  cardFieldFacts, cardRecordFacts, decisionFacts, isRulingMail, rulingMailFacts, type RulingMailLike, type BumpMap, doneMailFacts, gitHistoryFacts, mergeFacts, parseChangelog, releaseFacts, shaMentions,
  type CardLike, type DerivedFact, type GitLogPort, type MailLike, type TagLike,
} from './derivedFacts';
import { mergeHotCold, readArchive } from '../taskArchive';
import { doneMailStatuses, writeDoneMailStatus } from './derivedDoneStatus';
import { isValidMailId, mailBodyHash, type MailLedgerDoc } from '../mailLedger';
import { TRUSTED_METHODS, readProvenMail, type MailLinkMethod } from '../mailCards';

export interface DerivedStore {
  readLedger(agentId: string): ReadResult;
  /** STARTUP-FREEZE-104 A3: the kept verified read (a stat and a tail read when nothing changed). */
  readLedgerCached?(agentId: string): ReadResult;
  appendRecord(agentId: string, draft: RecordDraft, origin: AppendOrigin): Promise<AppendResult>;
}

export interface DerivedWriterDeps {
  store: DerivedStore;
  derive: (records: LedgerRec[]) => ClaimsState;
  log?: (row: Record<string, unknown>) => void;
}

export interface SyncCounts { facts: number; appended: number; unchanged: number; superseded: number; failed: number; older?: number; noTime?: number; redated?: number; valued?: number }

/** The sender a done-sha claim's text names (the writer's own template; M5's per-commit claims too). */
const DONE_FROM_RE = /\bdone mail (?:\S+ )?from (\S+) /;

/**
 * A claim's slot: its key; for a done-mail sha (R2: one claim per card and SENDER under one key)
 * key#<sender>, so the sender's newer done mail supersedes its older claims, M5's per-commit ones included.
 */
export function slotOf(c: Pick<ClaimRec, 'key' | 'refs' | 'text'>): string | null {
  if (!c.key) return null;
  if (c.key.endsWith('.donesha')) {
    const from = DONE_FROM_RE.exec(typeof c.text === 'string' ? c.text : '')?.[1];
    return from ? `${c.key}#${from}` : null;
  }
  return c.key;
}

const refsId = (refs: ClaimRec['refs']): string => JSON.stringify((refs ?? []).map((r) => [r.type, r.value]).sort());

export async function syncDerived(deps: DerivedWriterDeps, facts: readonly DerivedFact[]): Promise<SyncCounts> {
  const counts: SyncCounts = { facts: facts.length, appended: 0, unchanged: 0, superseded: 0, failed: 0 };
  const read = deps.store.readLedgerCached ? deps.store.readLedgerCached(DERIVED_AGENT_ID) : deps.store.readLedger(DERIVED_AGENT_ID);
  const state = deps.derive(read.records);
  const live = new Map<string, ClaimRec[]>();
  for (const r of read.records) {
    if (r.t !== 'claim' || r.source !== 'derived' || state.claims[r.id]?.status !== 'live') continue;
    const slot = slotOf(r);
    if (!slot) continue;
    const list = live.get(slot) ?? [];
    list.push(r);
    live.set(slot, list);
  }
  const done = new Set<string>();
  for (const f of facts) {
    if (done.has(f.slot)) continue;   // one value per slot per sync: the first fact wins
    done.add(f.slot);
    // Valid time (god e551de): a fact with no source time is never written (the store would stamp the run's time).
    if (!f.at) { counts.noTime = (counts.noTime ?? 0) + 1; continue; }
    const prior = live.get(f.slot) ?? [];
    const same = prior.find((c) => c.key === f.key && c.text === f.text && refsId(c.refs) === refsId(f.refs));
    const sameValue = !!same && same.value === f.value && same.valueAgent === f.valueAgent;
    // The store clamps at to its write time (F2), so a stored claim holds min(fact time, its wt).
    if (same && sameValue && same.at === (typeof same.wt === 'string' && same.wt < f.at ? same.wt : f.at)) { counts.unchanged++; continue; }
    // A fact dated before the slot's live claim never replaces it (a pass that no longer sees a newer record),
    // unless it is the same value: then only its time was wrong (a claim stamped with a run's time), re-dated.
    if (!same && prior.some((c) => typeof c.at === 'string' && c.at > f.at!)) { counts.older = (counts.older ?? 0) + 1; continue; }
    const draft: RecordDraft = {
      t: 'claim', kind: f.kind, text: f.text, key: f.key,
      ...(f.refs.length ? { refs: f.refs } : {}),
      at: f.at,
      ...(f.value !== undefined ? { value: f.value } : {}),
      ...(f.valueAgent !== undefined ? { valueAgent: f.valueAgent } : {}),
      ...(prior.length ? { supersedes: prior.map((c) => c.id), supersedesReason: same ? { category: 'corrected' as const, note: sameValue ? 'valid time' : 'structured value' } : { category: 'changed' as const } } : {}),
    };
    const res = await deps.store.appendRecord(DERIVED_AGENT_ID, draft, 'derived-internal');
    if (res.ok) {
      counts.appended++;
      if (same && sameValue) counts.redated = (counts.redated ?? 0) + 1;
      if (same && !sameValue) counts.valued = (counts.valued ?? 0) + 1;
      if (prior.length) counts.superseded += prior.length;
    } else {
      counts.failed++;
      deps.log?.({ kind: 'claims-derived-append-failed', slot: f.slot.slice(0, 120), error: res.error.slice(0, 160) });
    }
  }
  return counts;
}

// ———————————————————————————————————————————————————————————— primary records

/** tasks.json's cards, then the archived cards it lacks (taskArchive: the hot copy wins). */
export function readCards(hiveRoot: string): CardLike[] {
  let hot: unknown[] = [];
  try {
    const j = JSON.parse(readFileSync(join(hiveRoot, 'tasks.json'), 'utf8')) as { tasks?: unknown };
    if (Array.isArray(j?.tasks)) hot = j.tasks;
  } catch { /* no tasks.json */ }
  let archived: ReturnType<typeof readArchive> = new Map();
  try { archived = readArchive(hiveRoot); } catch { /* no archive */ }
  const meta = readTaskMeta(hiveRoot);
  const archivedAt = readArchiveTimes(hiveRoot);
  return mergeHotCold(hot, archived).filter((c): c is CardLike => !!c && typeof c === 'object').map((c) => {
    const id = typeof c.id === 'string' ? c.id : '';
    const m = meta.get(id);
    const extra: Partial<CardLike> = {};
    if (m && m.status === c.status && Number.isFinite(m.statusSince)) extra.statusSince = new Date(m.statusSince as number).toISOString();
    if (m && Number.isFinite(m.lastEditAt)) extra.lastEditAt = new Date(m.lastEditAt as number).toISOString();
    if (archivedAt.has(id)) extra.archivedAt = archivedAt.get(id);
    return Object.keys(extra).length ? { ...c, ...extra } : c;
  });
}

/** The harness's per-card status record (state/task-meta.json): status, statusSince and lastEditAt (ms). */
function readTaskMeta(hiveRoot: string): Map<string, { status?: unknown; statusSince?: unknown; lastEditAt?: unknown }> {
  try {
    const j = JSON.parse(readFileSync(join(hiveRoot, 'state', 'task-meta.json'), 'utf8')) as { cards?: Record<string, unknown> };
    return new Map(Object.entries(j?.cards ?? {}).filter(([, v]) => !!v && typeof v === 'object') as Array<[string, { status?: unknown; statusSince?: unknown; lastEditAt?: unknown }]>);
  } catch { return new Map(); }
}

/** Each archived card's newest archive row time (tasks-archive/YYYY-MM.jsonl rows {at, card}). */
function readArchiveTimes(hiveRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(hiveRoot, 'tasks-archive');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { at?: unknown; card?: { id?: unknown } };
        const id = r?.card?.id;
        const at = typeof r?.at === 'string' && Number.isFinite(Date.parse(r.at)) ? new Date(Date.parse(r.at)).toISOString() : null;
        if (typeof id === 'string' && at) out.set(id, at);
      } catch { /* a torn line */ }
    }
  }
  return out;
}

/**
 * The done mails main's MailLedger recorded at delivery (hive/state/mail/<agent>.json): id, from,
 * subject, card and delivery time come from the ledger entry, never from an agent-writable inbox
 * file (Jim's M5 audit MUST 1). The body (for its shas) is read from that agent's inbox or
 * inbox/.done copy only when it hashes to the entry's bodyHash; otherwise the subject alone counts.
 * An inbox file the ledger never recorded is ignored, except on the full pass (`proven`, round 10 must
 * 5b): a done mail that neither the index nor a ledger holds still counts when the hive's records prove
 * its delivery (readProvenMail: the sender's outbox/.sent copy matches the recipient's inbox copy),
 * so a done mail the index never linked (its subject writes a card's own form, not its id) reaches
 * the subject rule. `seen` (agent/id) skips entries read before.
 */
export function readDoneMails(hiveRoot: string, seen?: Set<string>, subjects?: Map<string, string>, opts: { proven?: boolean } = {}): MailLike[] {
  return addLedgerDoneMails(hiveRoot, readIndexDoneMails(hiveRoot, seen, subjects), seen, subjects, opts);
}

/** STARTUP-FREEZE-104 A12: readDoneMails with the index (its bulk: 1.4 s at 10x) read in slices. */
export async function readDoneMailsAsync(hiveRoot: string, seen?: Set<string>, subjects?: Map<string, string>, opts: { proven?: boolean } = {}, tick: () => Promise<void> = sliceTicker()): Promise<MailLike[]> {
  return addLedgerDoneMails(hiveRoot, await readIndexDoneMailsAsync(hiveRoot, seen, subjects, tick), seen, subjects, opts);
}

/** readDoneMails after the index: the MailLedger entries the index lacks, then (proven) the proven mail. */
function addLedgerDoneMails(hiveRoot: string, out: MailLike[], seen: Set<string> | undefined, subjects: Map<string, string> | undefined, opts: { proven?: boolean }): MailLike[] {
  const byId = new Map(out.map((m) => [m.id as string, m]));
  const have = new Set(byId.keys());
  const mailDir = join(hiveRoot, 'state', 'mail');
  let files: string[] = [];
  try { files = readdirSync(mailDir).filter((n) => n.endsWith('.json')).sort(); } catch { files = []; }
  for (const f of files) {
    const agent = f.slice(0, -'.json'.length);
    if (agent === DERIVED_AGENT_ID || !isValidMailId(agent)) continue;
    let doc: MailLedgerDoc;
    try { doc = JSON.parse(readFileSync(join(mailDir, f), 'utf8')) as MailLedgerDoc; } catch { continue; }
    if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object') continue;
    for (const e of Object.values(doc.entries).sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))) {
      if (!e || !isValidMailId(e.id)) continue;
      // Round 10 (F4): every recorded mail's subject, whatever its act, so a done reply can tell a quoted @sha.
      if (subjects && typeof e.subject === 'string' && !subjects.has(e.id)) subjects.set(e.id, e.subject);
      if (e.act !== 'done') continue;
      const k = `${agent}/${e.id}`;
      if (seen?.has(k)) continue;
      seen?.add(k);
      if (byId.has(e.id)) continue;   // the index row has the body and the link method
      have.add(e.id);
      out.push({
        id: e.id, from: e.from, act: 'done', subject: e.subject,
        ...(e.cardId ? { card: e.cardId } : {}),
        ...(typeof e.inReplyTo === 'string' && e.inReplyTo ? { in_reply_to: e.inReplyTo } : {}),
        ...(Number.isFinite(e.deliveredAt) ? { created_at: new Date(e.deliveredAt).toISOString() } : {}),
        ...(typeof e.bodyHash === 'string' ? bodyOf(join(hiveRoot, 'agents', agent, 'inbox'), e.id, e.bodyHash) : {}),
      });
    }
  }
  if (opts.proven) {
    for (const m of readProvenMail(hiveRoot).mails) {
      if (subjects && typeof m.subject === 'string' && !subjects.has(m.id)) subjects.set(m.id, m.subject);
      if (m.act !== 'done' || have.has(m.id)) continue;
      const k = `proven/${m.id}`;
      if (seen?.has(k)) continue;
      seen?.add(k);
      have.add(m.id);
      out.push({
        id: m.id, from: m.from, act: 'done', subject: m.subject,
        ...(typeof m.card === 'string' && m.card ? { card: m.card } : {}),
        ...(typeof m.in_reply_to === 'string' && m.in_reply_to ? { in_reply_to: m.in_reply_to } : {}),
        ...(typeof m.created_at === 'string' ? { created_at: m.created_at } : {}),
        ...(m.body !== undefined ? { body: m.body } : {}),
      });
    }
  }
  return out;
}

/**
 * R2 (b): the done mails of main's permanent per-card mail index (hive/state/mail-cards/<card>.jsonl,
 * written at delivery or by the trusted backfill; never pruned), one per id, with the cards the mail
 * was linked to. The body counts only when it hashes to the row's bodyHash. `seen` holds idx/<id>.
 */
export function readIndexDoneMails(hiveRoot: string, seen?: Set<string>, subjects?: Map<string, string>): MailLike[] {
  const acc = doneIndexRows(seen, subjects);
  eachIndexRow(hiveRoot, acc.row);
  return acc.out;
}

/** STARTUP-FREEZE-104 A12: readIndexDoneMails, the files read with fs/promises and the rows taken in slices. */
export async function readIndexDoneMailsAsync(hiveRoot: string, seen?: Set<string>, subjects?: Map<string, string>, tick: () => Promise<void> = sliceTicker()): Promise<MailLike[]> {
  const acc = doneIndexRows(seen, subjects);
  await eachIndexRowAsync(hiveRoot, acc.row, tick);
  return acc.out;
}

const indexDir = (hiveRoot: string): string => join(hiveRoot, 'state', 'mail-cards');
function indexFiles(dir: string): string[] | null {
  try { return readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('_')).sort(); } catch { return null; }
}
function eachLine(text: string, onRow: (r: Record<string, unknown>) => void): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    onRow(r);
  }
}
/** A12: every parsed row of main's mail index, file by file in name order (an unreadable file is skipped). */
function eachIndexRow(hiveRoot: string, onRow: (r: Record<string, unknown>) => void): void {
  const dir = indexDir(hiveRoot);
  for (const f of indexFiles(dir) ?? []) {
    let text: string;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    eachLine(text, onRow);
  }
}
/** A12: eachIndexRow with fs/promises reads and a tick before each file and each row (the ticker yields per slice). */
async function eachIndexRowAsync(hiveRoot: string, onRow: (r: Record<string, unknown>) => void, tick: () => Promise<void>): Promise<void> {
  const dir = indexDir(hiveRoot);
  for (const f of indexFiles(dir) ?? []) {
    await tick();
    let text: string;
    try { text = await fsp.readFile(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      await tick();
      eachLine(line, onRow);
    }
  }
}

function doneIndexRows(seen?: Set<string>, subjects?: Map<string, string>): { out: MailLike[]; row: (r: Record<string, unknown>) => void } {
  const out: MailLike[] = [];
  const got = new Set<string>();
  return { out, row: (r) => {
      if (!r || typeof r.id !== 'string' || !isValidMailId(r.id)) return;
      if (subjects && typeof r.subject === 'string' && !subjects.has(r.id)) subjects.set(r.id, r.subject);
      if (r.act !== 'done' || got.has(r.id)) return;
      // F1 (spec F): a mention-body (or unknown) link never gives a done mail its card. CLAIMS-WEAKLINK-DONESHA:
      // a mention-body row still carries the mail (subject, body, sender, time) with NO card and NO linked
      // cards, so doneMailFacts can read the cards its body names and let the commits it reports settle
      // the card (cardOfDoneMail); the weak link itself never becomes the card.
      const weak = r.cardFrom === 'mention-body';
      if (!weak && !TRUSTED_METHODS.has(r.cardFrom as MailLinkMethod)) return;
      got.add(r.id);
      if (seen?.has(`idx/${r.id}`)) return;
      seen?.add(`idx/${r.id}`);
      const body = typeof r.bodyHash === 'string' && r.body !== undefined && mailBodyHash(r.body) === r.bodyHash ? { body: r.body } : {};
      out.push({
        id: r.id, from: r.from, act: 'done', subject: r.subject,
        ...(typeof r.card === 'string' && r.cardFrom === 'field' ? { card: r.card } : {}),
        ...(typeof r.in_reply_to === 'string' && r.in_reply_to ? { in_reply_to: r.in_reply_to } : {}),
        ...(weak ? {} : Array.isArray(r.cards) ? { cards: r.cards } : typeof r.card === 'string' ? { cards: [r.card] } : {}),
        ...(typeof r.created_at === 'string' ? { created_at: r.created_at } : Number.isFinite(r.deliveredAt) ? { created_at: new Date(r.deliveredAt as number).toISOString() } : {}),
        ...body,
      });
  } };
}

/**
 * R2 (g): god's ruling mails in the per-card mail index (isRulingMail), each with the cards whose
 * file holds it under a trusted link method; a mention-body link never counts. The body counts only
 * when it hashes to the row's bodyHash. god is the registry's godId (default 'god').
 */
export function readIndexRulingMails(hiveRoot: string): RulingMailLike[] {
  const acc = rulingIndexRows(hiveRoot);
  eachIndexRow(hiveRoot, acc.row);
  return [...acc.byId.values()];
}

/** STARTUP-FREEZE-104 A12: readIndexRulingMails, the files read with fs/promises and the rows taken in slices. */
export async function readIndexRulingMailsAsync(hiveRoot: string, tick: () => Promise<void> = sliceTicker()): Promise<RulingMailLike[]> {
  const acc = rulingIndexRows(hiveRoot);
  await eachIndexRowAsync(hiveRoot, acc.row, tick);
  return [...acc.byId.values()];
}

function rulingIndexRows(hiveRoot: string): { byId: Map<string, RulingMailLike>; row: (r: Record<string, unknown>) => void } {
  let godId = 'god';
  try {
    const g = (JSON.parse(readFileSync(join(hiveRoot, 'registry.json'), 'utf8')) as { godId?: unknown }).godId;
    if (typeof g === 'string' && g) godId = g;
  } catch { /* no registry: god */ }
  const byId = new Map<string, RulingMailLike>();
  return { byId, row: (r) => {
      if (!r || typeof r.id !== 'string' || !isValidMailId(r.id) || typeof r.card !== 'string') return;
      if (!TRUSTED_METHODS.has(r.cardFrom as MailLinkMethod)) return;
      const body = typeof r.bodyHash === 'string' && typeof r.body === 'string' && mailBodyHash(r.body) === r.bodyHash ? r.body : undefined;
      const m: RulingMailLike = byId.get(r.id) ?? {
        id: r.id, from: String(r.from ?? ''), act: String(r.act ?? ''),
        ...(typeof r.subject === 'string' ? { subject: r.subject } : {}),
        ...(body !== undefined ? { body } : {}),
        cards: [],
        ...(typeof r.created_at === 'string' ? { at: r.created_at } : Number.isFinite(r.deliveredAt) ? { at: new Date(r.deliveredAt as number).toISOString() } : {}),
      };
      if (!isRulingMail(m, godId)) return;
      if (!m.cards.includes(r.card)) m.cards.push(r.card);
      byId.set(r.id, m);
  } };
}

/** The body of an inbox copy of message `id`, only when it hashes to the ledger's bodyHash. */
function bodyOf(inbox: string, id: string, bodyHash: string): { body?: unknown } {
  for (const file of [join(inbox, `${id}.json`), join(inbox, '.done', `${id}.json`)]) {
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as { body?: unknown };
      if (m && typeof m === 'object' && mailBodyHash(m.body ?? '') === bodyHash) return { body: m.body };
    } catch { /* absent, torn or gone */ }
  }
  return {};
}

export interface ReleaseSource { changelog: string | null; tags: TagLike[]; bumps?: BumpMap; heads?: import('./derivedFacts').ReleaseHead[] }

export interface BackfillInput {
  hiveRoot: string;
  /** null: no repo (lastsha and done-mail shas need git to tell a commit from any hex word; tags too). */
  git: GitLogPort | null;
  releases: ReleaseSource;
  /** Optional prefetch of every sha the run will ask about (one git process instead of one per sha). */
  prefetch?: (shas: string[]) => Promise<void>;
}

export interface BackfillCounts {
  cards: number; doneMails: number; decisions: SyncCounts; records: SyncCounts; rulings: SyncCounts; cardFields: SyncCounts; releases: SyncCounts; doneShas: SyncCounts;
  doneSkipped: Record<string, number>; doneOlder: number; gitShas: SyncCounts;
}

/**
 * STARTUP-FREEZE-104 A12 (Jim's 10x profile of c1db867a): main's derived writer derived its whole ledger once per
 * syncDerived, up to ten times per backfill, mostly with nothing appended in between. readLedgerCached hands back the
 * same records array while the ledger is unchanged (a new array after any append), and loadRegistryShared one frozen
 * registry per file, so the last result is reused for the same derive, records and frozen registry.
 */
let lastDerive: { derive: DeriveFn; records: LedgerRec[]; registry: KeyRegistry; state: ClaimsState } | null = null;
export function deriveOnce(derive: DeriveFn, records: LedgerRec[], registry: KeyRegistry): ClaimsState {
  const last = lastDerive;
  if (last && last.derive === derive && last.records === records && last.registry === registry) return last.state;
  const state = derive(records, registry, { r4: false });
  lastDerive = Object.isFrozen(registry) ? { derive, records, registry, state } : null;
  return state;
}

/** A12: the rest of the backfill waits for the next turn of the event loop (timers, IPC and input run between). */
const nextTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export async function runDerivedBackfill(deps: DerivedWriterDeps, input: BackfillInput): Promise<BackfillCounts> {
  // A17 (Jim cdf8fec8): the import's start and end in log.jsonl (its claims-key-added rows give the keys per 10 s).
  const t0 = Date.now();
  deps.log?.({ kind: 'claims-derived-backfill-start' });
  const cards = readCards(input.hiveRoot);
  const subjects = new Map<string, string>();
  // Round 10 (must 5b): the full pass also reads proven done mails the index and the ledgers lack.
  // A12 (Jim's 10x profile of c1db867a: one 6.1 s block): the index is read in slices and each step below is its own
  // turn of the event loop. The steps, their order and their inputs are as before.
  const mails = input.git ? await readDoneMailsAsync(input.hiveRoot, undefined, subjects, { proven: true }) : [];
  if (input.git && input.prefetch) {
    const shas = new Set<string>();
    for (const c of cards) for (const t of [c.result, c.notes]) for (const m of shaMentions(t)) shas.add(m.sha);
    for (const m of mails) for (const t of [m.subject, m.body]) for (const x of shaMentions(t)) shas.add(x.sha);
    await input.prefetch([...shas]);
  }
  await nextTurn();
  const decisions = await syncDerived(deps, decisionFacts(cards));
  await nextTurn();
  const records = await syncDerived(deps, cardRecordFacts(cards));
  const rulingMails = await readIndexRulingMailsAsync(input.hiveRoot);
  await nextTurn();
  const rulings = await syncDerived(deps, rulingMailFacts(rulingMails));
  await nextTurn();
  const cardFields = await syncDerived(deps, await cardFieldFacts(cards, input.git));
  await nextTurn();
  const releases = await syncDerived(deps, releaseFacts(parseChangelog(input.releases.changelog), input.releases.tags, input.releases.bumps, input.releases.heads, { cards, mails }));
  const cardIds = cards.map((c) => c.id).filter((id): id is string => typeof id === 'string');
  // Round 10 re-gate (Jim cf751a): the history is read BEFORE the done mails, so its messages and parents are
  // cached for them (one walk) instead of one show and one rev-list per reported commit.
  const log = input.git?.log ? await input.git.log() : null;
  const done = input.git ? await doneMailFacts(mails, cardIds, input.git, { subjectOf: (id) => subjects.get(id) }) : { facts: [], skipped: { noGit: 1 } as Record<string, number>, skips: [], older: 0 };
  // R2 (c): every skipped done mail is logged with its reason (ids and card ids only).
  for (const s of done.skips) deps.log?.({ kind: 'claims-derived-done-skip', mail: s.mail.slice(0, 120), reason: s.reason, ...(s.cards ? { cards: s.cards } : {}) });
  // Round 4b: every processed done mail's verdict, so `memory get`'s mail rule bridges only the derived lag.
  writeDoneMailStatus(input.hiveRoot, doneMailStatuses(mails, done));
  await nextTurn();
  const doneShas = await syncDerived(deps, done.facts);
  await nextTurn();
  const none = { facts: 0, appended: 0, unchanged: 0, superseded: 0, failed: 0 };
  const gitShas = log && input.git ? await syncDerived(deps, await gitHistoryFacts(log, cardIds, input.git)) : none;
  await nextTurn();
  const merges = log && input.git ? await syncDerived(deps, await mergeFacts(log, cardIds, input.git)) : none;
  const counts = { cards: cards.length, doneMails: mails.length, decisions, records, rulings, cardFields, releases, doneShas, doneSkipped: done.skipped, doneOlder: done.older, gitShas, merges };
  deps.log?.({ kind: 'claims-derived-backfill', ...counts, ms: Date.now() - t0 });
  return counts;
}
