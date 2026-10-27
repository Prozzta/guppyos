/**
 * CLAIMS-90 R2: the read verbs' wiring over a served hive, `memory get` (C90-GET) and `memory history`
 * (HISTORY-PTR). Main's claimsEndpoint (index.ts) and the CLAIMS-90 answer child both call these, so the
 * harness answers through the shipped path and cannot drift from it (god 8c87a7). Read-only: each call
 * reads the verified ledger prefixes, the registry, the reconcile queue, tasks and the mail index.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimStore } from './store';
import type { ClaimsEndpointDeps } from './endpoint';
import { verifiedPrefix } from './indexSync';
import { derive as deriveClaims } from './derive';
import { renderClaimHistory } from './views';
import { reconcileQueueForHive } from './reconcile';
import { DEFAULT_KEY_REGISTRY, loadRegistry, registryPath } from './registry';
import { formatGet, leadBrief, resolveGet, resolveGetMany, warmGetIndex, type CardLeadAsk, type CardLeadReply, type GetDeps } from './get';
import { targetIndex, targetsIn, type TargetIndex } from './searchTargets';
import type { LedgerRec, ReadResult } from '../../shared/claims';

export interface ClaimReadDeps {
  /** The served hive root. */
  root: string;
  /** readLedgerCached when present (main's ClaimStore): the last verified read while the ledger files are unchanged. */
  store: Pick<ClaimStore, 'readLedger'> & Partial<Pick<ClaimStore, 'readLedgerCached'>>;
  /** Every agent with a ledger in this hive (main's claimLedgerAgents). */
  agents: () => string[];
  /** tasks.json's tasks (main's hive.allTasks()). */
  tasks: () => Array<Record<string, unknown>>;
}

export type ClaimGetArgs = Parameters<NonNullable<ClaimsEndpointDeps['get']>>[1];

/** CLAIMS-90 HISTORY-PTR: `memory history <id>` over the served hive's verified ledgers: the caller's
 *  own first, then every other ledger agent's (a search hit can show another agent's pointer). */
export function claimHistoryOver(d: Pick<ClaimReadDeps, 'root' | 'store' | 'agents'>, agentId: string, id: string): { ok: true; text: string; owner: string } | { ok: false; error: string } {
  let reg; try { reg = loadRegistry(d.root); } catch { reg = DEFAULT_KEY_REGISTRY; }
  for (const owner of [agentId, ...d.agents().filter((a) => a !== agentId)]) {
    const prefix = verifiedPrefix(d.store.readLedger(owner));
    if (!prefix || !prefix.records.some((r) => r.t === 'claim' && r.id === id)) continue;
    const text = renderClaimHistory(prefix.records, deriveClaims(prefix.records, reg, { r4: false }), id);
    if (text) return { ok: true, text, owner };
  }
  return { ok: false, error: `no claim ${id} in this hive's verified ledgers` };
}

/** CLAIMS-90 R2 (C90-GET): read-only over every agent's VERIFIED ledger prefix (the same path as
 *  claimsLedgerView), the registry, the reconcile queue's alias pairs, tasks.json and the per-card
 *  mail index. The text is formatGet's on every path (CLI, MCP, hook-served). */
export function claimGetOver(d: ClaimReadDeps, args: ClaimGetArgs): { text: string; json: unknown } {
  const r = resolveGet(args.term, { agent: args.agent ?? null, mail: args.mail, before: args.before ?? null, noMail: args.noMail === true, history: args.history === true }, getDeps(d));
  return { text: formatGet(r, { agent: args.agent ?? null, history: args.history === true }), json: r };
}

/** Step 3 fix R2 (god bbcb4a): the card briefs a search's hits carry (`field: value` items per card id, the fields
 *  with a value and the decision count), over the same ledgers, registry, tasks and mail index as `memory get`. */
export function claimCardLeadOver(d: ClaimReadDeps, ask: CardLeadAsk | string[]): CardLeadReply {
  const a: CardLeadAsk = Array.isArray(ask) ? { cards: ask, texts: [] } : ask;
  const ok = (c: string): boolean => /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(c);
  const cards = a.cards.filter(ok).map((c) => c.toLowerCase());
  const texts = a.texts.filter((t) => typeof t === 'string');
  if (!cards.length && !texts.length) return { briefs: {}, named: [], pointed: [] };
  const deps = getDeps(d);
  // S3 / S4: the cards (by id, card.<id> key or owned branch) and releases (by version) the query or a hit names.
  // M1 (god 5dc648): field lines print ONLY for what the QUERY names (texts[0]); every card or release a hit names
  // (texts[1..]) or is keyed to (cards) is `pointed`: one label-free `memory get` line each, no brief resolved.
  const ix = targetsOf(deps);
  const term = (ts: string[]): string[] => [...new Set(targetsIn(ts, ix, LEADS_MAX).map((t) => t.term.toLowerCase()).filter(ok))];
  const named = texts.length ? term([texts[0]]) : [];
  const pointed = [...new Set([...term(texts.slice(1)), ...cards])].filter((id) => !named.includes(id)).slice(0, LEADS_MAX);
  const briefs: Record<string, string[]> = {};
  resolveGetMany(named, { mail: 0 }, deps).forEach((r, i) => { const b = leadBrief(r, texts[0] ?? ''); if (b.length) briefs[named[i]] = b; });
  return { briefs, named: named.filter((n) => briefs[n]), pointed };
}
/** At most this many named terms per search (the engine's CARD_LEADS_MAX). */
const LEADS_MAX = 12;

/** The read-only inputs of one `get` (or one batch of briefs): every agent's VERIFIED prefix, the registry, the
 *  reconcile queue's alias pairs, tasks.json and the per-card mail index. */
function getDeps(d: ClaimReadDeps): GetDeps {
  const root = d.root;
  const read = (a: string): ReadResult => (d.store.readLedgerCached ? d.store.readLedgerCached(a) : d.store.readLedger(a));
  const ledgers: Record<string, LedgerRec[]> = {};
  for (const a of d.agents()) { const prefix = verifiedPrefix(read(a)); if (prefix) ledgers[a] = prefix.records; }
  // The registry by its file text: parsed only when the text changed (a parse and re-serialise per ask was ~14 ms).
  let regText: string | null; try { regText = readFileSync(registryPath(root), 'utf8'); } catch { regText = null; }
  const queue = reconcileQueueForHive(root);
  const reconcileItems = Object.keys(ledgers).flatMap((a) => queue.allItems(a));
  const tasks = d.tasks();
  const sig = { root, ledgers: Object.entries(ledgers), registry: regText, reconcile: JSON.stringify(reconcileItems), tasks: JSON.stringify(tasks) };
  const k = kept;
  if (k && k.sig.root === root && k.sig.registry === sig.registry && k.sig.reconcile === sig.reconcile && k.sig.tasks === sig.tasks
    && k.sig.ledgers.length === sig.ledgers.length && k.sig.ledgers.every(([a, recs], i) => sig.ledgers[i][0] === a && sig.ledgers[i][1] === recs)) return k.deps;
  // The same registry object while its text is unchanged, so get's per-ledger derive is kept for unchanged agents.
  let reg: GetDeps['registry'];
  if (k && k.sig.root === root && k.sig.registry === sig.registry) reg = k.deps.registry;
  else { try { reg = loadRegistry(root); } catch { reg = DEFAULT_KEY_REGISTRY; } }
  const mailRows = (card: string): string[] | null => {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(card)) return null;
    try { return readFileSync(join(root, 'state', 'mail-cards', `${card}.jsonl`), 'utf8').split('\n'); } catch { return null; }
  };
  const deps: GetDeps = { ledgers, registry: reg, reconcileItems, tasks, mailRows, ruleConfig: { r4: false } };
  kept = { sig, deps, targets: null };
  return deps;
}

/**
 * CLAIMS-90 brief cost (god 986e89): the last read's inputs and the GetDeps built from them. While every input is
 * the same (each agent's verified records array, as the store's readLedgerCached returns it unchanged, and the
 * registry, reconcile items and tasks by value), getDeps returns the same GetDeps object, so get's index and the
 * search target index are built once, not per ask. One hive is served at a time (the last root read).
 */
let kept: { sig: { root: string; ledgers: Array<[string, LedgerRec[]]>; registry: string | null; reconcile: string; tasks: string }; deps: GetDeps; targets: TargetIndex | null } | null = null;

/**
 * CLAIMS-BRIEF-LATENCY (god 360a86): build the brief's inputs now (verified reads, get's index, the target index) so
 * the next search's brief finds them kept. Main calls it, debounced, after claim appends: on a live floor a claims
 * sync lands between most searches, and the rebuild after it (~100 ms on the step-3 hive) then ran on the search's
 * path, serially after the vector search. Only once a brief has been asked for this root (an app that never
 * searches builds nothing). True when it built.
 */
export function warmCardLeads(d: ClaimReadDeps): boolean {
  if (!kept || kept.sig.root !== d.root) return false;
  const deps = getDeps(d);
  warmGetIndex(deps);
  targetsOf(deps);
  return true;
}

/** The search target index (cards by id, card.<id> keys, owned branches, releases) of one GetDeps, kept with it. */
function targetsOf(deps: GetDeps): TargetIndex {
  if (kept?.deps === deps && kept.targets) return kept.targets;
  const keys = new Set<string>();
  for (const recs of Object.values(deps.ledgers)) for (const r of recs as Array<{ t?: string; key?: unknown }>) if (r.t === 'claim' && typeof r.key === 'string') keys.add(r.key);
  const ix = targetIndex((deps.tasks ?? []).map((t) => String(t.id ?? '')).filter(Boolean), keys);
  if (kept?.deps === deps) kept.targets = ix;
  return ix;
}
