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
import { DEFAULT_KEY_REGISTRY, loadRegistry } from './registry';
import { formatGet, resolveGet } from './get';
import type { LedgerRec } from '../../shared/claims';

export interface ClaimReadDeps {
  /** The served hive root. */
  root: string;
  store: Pick<ClaimStore, 'readLedger'>;
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
  const root = d.root;
  const ledgers: Record<string, LedgerRec[]> = {};
  for (const a of d.agents()) { const prefix = verifiedPrefix(d.store.readLedger(a)); if (prefix) ledgers[a] = prefix.records; }
  let reg; try { reg = loadRegistry(root); } catch { reg = DEFAULT_KEY_REGISTRY; }
  const queue = reconcileQueueForHive(root);
  const reconcileItems = Object.keys(ledgers).flatMap((a) => queue.allItems(a));
  const tasks = d.tasks();
  const mailRows = (card: string): string[] | null => {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(card)) return null;
    try { return readFileSync(join(root, 'state', 'mail-cards', `${card}.jsonl`), 'utf8').split('\n'); } catch { return null; }
  };
  const r = resolveGet(args.term, { agent: args.agent ?? null, mail: args.mail, before: args.before ?? null, noMail: args.noMail === true, history: args.history === true }, { ledgers, registry: reg, reconcileItems, tasks, mailRows, ruleConfig: { r4: false } });
  return { text: formatGet(r, { agent: args.agent ?? null, history: args.history === true }), json: r };
}
