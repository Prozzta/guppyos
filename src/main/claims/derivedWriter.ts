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
 * The backfill reads the primary records of a hive (tasks.json and tasks-archive, the done mails main's
 * MailLedger recorded at delivery, the CHANGELOG and tags) and syncs every fact. The app runs it at
 * start; the CLAIMS-90 runner runs it over the frozen T_s copy (scripts/claims-derived-backfill.cjs).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DERIVED_AGENT_ID, type AppendOrigin, type AppendResult, type ClaimRec, type ClaimsState, type LedgerRec, type ReadResult, type RecordDraft } from '../../shared/claims';
import {
  cardFieldFacts, decisionFacts, doneMailFacts, parseChangelog, releaseFacts, shaMentions,
  type CardLike, type DerivedFact, type GitPort, type MailLike, type TagLike,
} from './derivedFacts';
import { mergeHotCold, readArchive } from '../taskArchive';
import { isValidMailId, mailBodyHash, type MailLedgerDoc } from '../mailLedger';

export interface DerivedStore {
  readLedger(agentId: string): ReadResult;
  appendRecord(agentId: string, draft: RecordDraft, origin: AppendOrigin): Promise<AppendResult>;
}

export interface DerivedWriterDeps {
  store: DerivedStore;
  derive: (records: LedgerRec[]) => ClaimsState;
  log?: (row: Record<string, unknown>) => void;
}

export interface SyncCounts { facts: number; appended: number; unchanged: number; superseded: number; failed: number }

/** A claim's slot: its key; for a done-mail sha (one claim per commit under one key) key#commit. */
export function slotOf(c: Pick<ClaimRec, 'key' | 'refs'>): string | null {
  if (!c.key) return null;
  if (c.key.endsWith('.donesha')) {
    const commit = c.refs?.find((r) => r.type === 'commit')?.value;
    return commit ? `${c.key}#${commit}` : null;
  }
  return c.key;
}

const refsId = (refs: ClaimRec['refs']): string => JSON.stringify((refs ?? []).map((r) => [r.type, r.value]).sort());

export async function syncDerived(deps: DerivedWriterDeps, facts: readonly DerivedFact[]): Promise<SyncCounts> {
  const counts: SyncCounts = { facts: facts.length, appended: 0, unchanged: 0, superseded: 0, failed: 0 };
  const read = deps.store.readLedger(DERIVED_AGENT_ID);
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
    const prior = live.get(f.slot) ?? [];
    if (prior.some((c) => c.key === f.key && c.text === f.text && refsId(c.refs) === refsId(f.refs))) { counts.unchanged++; continue; }
    const draft: RecordDraft = {
      t: 'claim', kind: f.kind, text: f.text, key: f.key,
      ...(f.refs.length ? { refs: f.refs } : {}),
      ...(f.at ? { at: f.at } : {}),
      ...(prior.length ? { supersedes: prior.map((c) => c.id), supersedesReason: { category: 'changed' as const } } : {}),
    };
    const res = await deps.store.appendRecord(DERIVED_AGENT_ID, draft, 'derived-internal');
    if (res.ok) {
      counts.appended++;
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
  return mergeHotCold(hot, archived).filter((c): c is CardLike => !!c && typeof c === 'object');
}

/**
 * The done mails main's MailLedger recorded at delivery (hive/state/mail/<agent>.json): id, from,
 * subject, card and delivery time come from the ledger entry, never from an agent-writable inbox
 * file (Jim's M5 audit MUST 1). The body (for its shas) is read from that agent's inbox or
 * inbox/.done copy only when it hashes to the entry's bodyHash; otherwise the subject alone counts.
 * An inbox file the ledger never recorded is ignored. `seen` (agent/id) skips entries read before.
 */
export function readDoneMails(hiveRoot: string, seen?: Set<string>): MailLike[] {
  const out: MailLike[] = [];
  const mailDir = join(hiveRoot, 'state', 'mail');
  let files: string[] = [];
  try { files = readdirSync(mailDir).filter((n) => n.endsWith('.json')).sort(); } catch { return out; }
  for (const f of files) {
    const agent = f.slice(0, -'.json'.length);
    if (agent === DERIVED_AGENT_ID || !isValidMailId(agent)) continue;
    let doc: MailLedgerDoc;
    try { doc = JSON.parse(readFileSync(join(mailDir, f), 'utf8')) as MailLedgerDoc; } catch { continue; }
    if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object') continue;
    for (const e of Object.values(doc.entries).sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))) {
      if (!e || e.act !== 'done' || !isValidMailId(e.id)) continue;
      const k = `${agent}/${e.id}`;
      if (seen?.has(k)) continue;
      seen?.add(k);
      out.push({
        id: e.id, from: e.from, act: 'done', subject: e.subject,
        ...(e.cardId ? { card: e.cardId } : {}),
        ...(Number.isFinite(e.deliveredAt) ? { created_at: new Date(e.deliveredAt).toISOString() } : {}),
        ...(typeof e.bodyHash === 'string' ? bodyOf(join(hiveRoot, 'agents', agent, 'inbox'), e.id, e.bodyHash) : {}),
      });
    }
  }
  return out;
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

export interface ReleaseSource { changelog: string | null; tags: TagLike[] }

export interface BackfillInput {
  hiveRoot: string;
  /** null: no repo (lastsha and done-mail shas need git to tell a commit from any hex word; tags too). */
  git: GitPort | null;
  releases: ReleaseSource;
  /** Optional prefetch of every sha the run will ask about (one git process instead of one per sha). */
  prefetch?: (shas: string[]) => Promise<void>;
}

export interface BackfillCounts { cards: number; doneMails: number; decisions: SyncCounts; cardFields: SyncCounts; releases: SyncCounts; doneShas: SyncCounts; doneSkipped: Record<string, number> }

export async function runDerivedBackfill(deps: DerivedWriterDeps, input: BackfillInput): Promise<BackfillCounts> {
  const cards = readCards(input.hiveRoot);
  const mails = input.git ? readDoneMails(input.hiveRoot) : [];
  if (input.git && input.prefetch) {
    const shas = new Set<string>();
    for (const c of cards) for (const t of [c.result, c.notes]) for (const m of shaMentions(t)) shas.add(m.sha);
    for (const m of mails) for (const t of [m.subject, m.body]) for (const x of shaMentions(t)) shas.add(x.sha);
    await input.prefetch([...shas]);
  }
  const decisions = await syncDerived(deps, decisionFacts(cards));
  const cardFields = await syncDerived(deps, await cardFieldFacts(cards, input.git));
  const releases = await syncDerived(deps, releaseFacts(parseChangelog(input.releases.changelog), input.releases.tags));
  const cardIds = cards.map((c) => c.id).filter((id): id is string => typeof id === 'string');
  const done = input.git ? await doneMailFacts(mails, cardIds, input.git) : { facts: [], skipped: { noGit: 1 } as Record<string, number> };
  const doneShas = await syncDerived(deps, done.facts);
  const counts = { cards: cards.length, doneMails: mails.length, decisions, cardFields, releases, doneShas, doneSkipped: done.skipped };
  deps.log?.({ kind: 'claims-derived-backfill', ...counts });
  return counts;
}
