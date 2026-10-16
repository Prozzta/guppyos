/**
 * CLAIM-LEDGER W7: the main side of the Human's ledger UI (plan §3 W7; gates G7.1, G7.2).
 *
 * Every function here is reached ONLY from the renderer's Settings IPC (index.ts `claims-ui:*`),
 * never from an HTTP route, the hook server, the memory endpoint or an agent token. Writes:
 *   - a Human preference: a `preference` claim through the 'ui-ipc' origin (the store makes it
 *     source 'human'; 400 characters at most, refused when longer, never cut);
 *   - a revert: a `revert` event (by human) naming one revertible event; derive then ignores it;
 *   - the purge: store.purge, the ONLY write that is not an append (G7.1). It runs only after the
 *     renderer's typed confirmation AND main's own confirm dialog (G7.2), then scrubs the continuous
 *     export of the purged text;
 *   - the Settings level: saved, then `claimLedgerChanged()` (a running worker follows at once).
 *     Lowering it below 'writer' first runs the complete export for every writer agent (the planned
 *     downgrade path: the caller turns the flag down only after that is ok), and refuses otherwise.
 * Revert, purge and a level drop from writer each need main's confirm; a cancel writes nothing.
 */
import {
  LEDGER_LEVELS, effectiveLevel,
  type ClaimRec, type ClaimsState, type EventRec, type KeyRegistry, type LedgerLevel, type LedgerRec, type ReadResult, type Status,
} from '../../shared/claims';
import { REVERTIBLE_EVENTS, UI_STATUSES, type LedgerUiAgentView, type LedgerUiResult, type LedgerUiSummary } from '../../shared/claimsUi';
import type { PurgeResult } from './store';
import type { AppendResult, AppendOrigin, RecordDraft } from '../../shared/claims';

/** The confirm main shows (a native dialog in the app; a stub in tests). True only on the Human's OK. */
export type ConfirmFn = (q: { title: string; message: string; detail: string; ok: string; danger?: boolean }) => Promise<boolean>;

export interface LedgerUiDeps {
  /** The store, or null with no hive or no claims. */
  store: () => {
    readLedger(agentId: string): ReadResult;
    appendRecord(agentId: string, draft: RecordDraft, origin: AppendOrigin): Promise<AppendResult>;
    purge(agentId: string, ids: string[], confirmedByHuman: true): Promise<PurgeResult>;
  } | null;
  agents: () => string[];
  /** The agent's effective level (main's claimLevel). */
  level: (agentId: string) => LedgerLevel;
  savedLevel: () => unknown;
  saveLevel: (level: LedgerLevel) => void;
  /** mainWiring.claimLedgerChanged(): resolves once a running worker follows the new level. */
  levelChanged: () => Promise<void> | null;
  registry: () => KeyRegistry;
  derive: (records: LedgerRec[], registry: KeyRegistry, rules: { r4: boolean }) => ClaimsState;
  /** W3's verifiedPrefix. */
  verifiedPrefix: (r: ReadResult) => { records: LedgerRec[]; truncatedAt?: string } | null;
  /** W6 complete export (`memory export --complete`). */
  exportComplete: (agentId: string) => { ok: true; file: string; bytes: number; note: string } | { ok: false; error: string };
  /** Replace the purged claims' lines in the continuous export; the number of lines replaced. */
  scrubExport: (agentId: string, ids: string[]) => number;
  confirm: ConfirmFn;
  log: (row: Record<string, unknown>) => void;
}

/** The word the Human types in the purge dialog. */
export const PURGE_WORD = 'purge';
/** What a purge does NOT remove (Andy's W7 audit, SHOULD 4): named in the dialog, whatever the scope. */
export const PURGE_KEEPS = 'Not removed by a purge: the text may remain in memory.md (written by the agent while the ledger is below writer), the memory archives, the torn-tail file (claims.torn.jsonl), the search and usage logs, mail, and the index database until it is rebuilt or compacted (not automatic yet).';
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ID_RE = /^[ce]-[0-9a-f]{12,32}$/;

export function createLedgerUi(d: LedgerUiDeps) {
  const fail = (error: string): LedgerUiResult => ({ ok: false, error });
  const cancelled = (): LedgerUiResult => ({ ok: false, error: 'cancelled: nothing was written', cancelled: true });

  function view(agentId: string): LedgerUiAgentView | { error: string } {
    const store = d.store();
    if (!store) return { error: 'the claim ledger is not available (no hive)' };
    if (!AGENT_RE.test(agentId)) return { error: 'bad agent id' };
    const read = store.readLedger(agentId);
    const prefix = d.verifiedPrefix(read);
    const records = prefix?.records ?? [];
    const state = d.derive(records, d.registry(), { r4: false });
    const reverted = new Set(records.filter((r): r is EventRec => r.t === 'event' && r.ev === 'revert').flatMap((r) => r.targets));
    const counts = Object.fromEntries(UI_STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const claims = records.filter((r): r is ClaimRec => r.t === 'claim').map((c) => {
      const st = state.claims[c.id];
      const status: Status = st?.status ?? 'live';
      counts[status]++;
      return {
        id: c.id, kind: c.kind, text: c.text, source: c.source, at: c.at, wt: c.wt, status,
        sightings: st?.sightings ?? 0, pinned: st?.pinned ?? false, reasons: st?.reasons ?? [],
        ...(c.key !== undefined ? { key: c.key } : {}), ...(c.refs ? { refs: c.refs } : {}), ...(c.ttl !== undefined ? { ttl: c.ttl } : {}),
        ...(st?.supersededBy ? { supersededBy: st.supersededBy } : {}), ...(c.supersedes ? { supersedes: c.supersedes } : {}),
        ...(c.retracts ? { retracts: c.retracts } : {}), ...(c.supersedesReason ? { supersedesReason: c.supersedesReason } : {}),
      };
    });
    const events = records.filter((r): r is EventRec => r.t === 'event').map((e) => ({
      id: e.id, ev: e.ev, targets: e.targets, by: e.by, at: e.at,
      ...(e.rule ? { rule: e.rule } : {}), ...(e.answer ? { answer: e.answer } : {}), ...(e.reason ? { reason: e.reason } : {}),
      reverted: reverted.has(e.id), revertible: REVERTIBLE_EVENTS.has(e.ev) && !reverted.has(e.id),
    }));
    const chain = read.chain;
    return {
      agentId, level: d.level(agentId), counts, claims, events,
      readOnly: chain === 'ok' ? null : `${chain.reason} at ${chain.brokenAt}`,
      ...(prefix?.truncatedAt ? { truncatedAt: prefix.truncatedAt } : {}),
    };
  }

  return {
    summary(): LedgerUiSummary {
      const saved = d.savedLevel();
      const store = d.store();
      const agents = store ? d.agents().filter((a) => AGENT_RE.test(a)).sort().map((agentId) => {
        const r = store.readLedger(agentId);
        return { agentId, level: d.level(agentId), claims: r.records.filter((x) => x.t === 'claim').length, readOnly: r.chain !== 'ok' };
      }) : [];
      return { saved: typeof saved === 'string' ? saved : null, effective: effectiveLevel(saved, saved).level, agents };
    },

    view,

    /** A Human preference for one agent: an append through the UI origin (source human). */
    async addPreference(agentId: string, text: unknown, key?: unknown): Promise<LedgerUiResult> {
      const store = d.store();
      if (!store) return fail('the claim ledger is not available');
      if (!AGENT_RE.test(agentId)) return fail('bad agent id');
      if (typeof text !== 'string' || !text.trim()) return fail('write the preference first');
      if (key !== undefined && key !== '' && typeof key !== 'string') return fail('bad key');
      const draft: RecordDraft = { t: 'claim', kind: 'preference', text, ...(typeof key === 'string' && key ? { key } : {}) };
      const r = await store.appendRecord(agentId, draft, 'ui-ipc');
      d.log({ kind: 'claims-ui-preference', agentId, ok: r.ok, ...(r.ok ? { id: r.id } : { error: r.error.slice(0, 120) }) });
      return r.ok ? { ok: true, id: r.id } : fail(r.error);
    },

    /** Revert one event (an append), after main's confirm. */
    async revert(agentId: string, eventId: unknown): Promise<LedgerUiResult> {
      const store = d.store();
      if (!store) return fail('the claim ledger is not available');
      if (typeof eventId !== 'string' || !ID_RE.test(eventId)) return fail('bad event id');
      const v = view(agentId);
      if ('error' in v) return fail(v.error);
      if (v.readOnly) return fail(`the ledger is read-only (${v.readOnly}); nothing can be reverted`);
      const ev = v.events.find((e) => e.id === eventId);
      if (!ev) return fail(`${eventId} is not an event of ${agentId}`);
      if (!ev.revertible) return fail(ev.reverted ? `${eventId} is already reverted` : `a ${ev.ev} cannot be reverted`);
      const ok = await d.confirm({
        title: 'Revert this step?', ok: 'Revert',
        message: `Revert ${ev.ev} ${eventId} in ${agentId}'s claim ledger?`,
        detail: 'A revert is appended to the ledger; the step stays in the history, marked reverted, and the claims go back to how they were before it.',
      });
      if (!ok) return cancelled();
      const r = await store.appendRecord(agentId, { t: 'event', ev: 'revert', targets: [eventId] }, 'ui-ipc');
      d.log({ kind: 'claims-ui-revert', agentId, target: eventId, ok: r.ok, ...(r.ok ? { id: r.id } : { error: r.error.slice(0, 120) }) });
      return r.ok ? { ok: true, id: r.id } : fail(r.error);
    },

    /**
     * The purge (R8, G7.2): the renderer's typed word, then main's own danger confirm, then the store.
     * Then the continuous export is scrubbed. Never reachable from an agent.
     */
    async purge(agentId: string, ids: unknown, typed: unknown): Promise<LedgerUiResult> {
      const store = d.store();
      if (!store) return fail('the claim ledger is not available');
      if (!AGENT_RE.test(agentId)) return fail('bad agent id');
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string' || !ID_RE.test(x))) return fail('bad claim ids');
      if (typed !== PURGE_WORD) return fail(`type "${PURGE_WORD}" to confirm`);
      const v = view(agentId);
      if ('error' in v) return fail(v.error);
      if (v.readOnly) return fail(`the ledger is read-only (${v.readOnly}); nothing can be purged`);
      let again = true;
      for (const id of ids as string[]) {
        const c = v.claims.find((x) => x.id === id);
        if (!c) return fail(`${id} is not a claim of ${agentId}`);
        if (c.status !== 'purged') again = false;
      }
      const what = ids.length === 1 ? (ids as string[])[0] : `${ids.length} claims`;
      // CL-W7 S3: claims purged already: their backups, restore asides and export are scrubbed again
      // (a copy a failed step left behind); the ledger is not touched and no event is written.
      const ok = await d.confirm(again ? {
        title: 'Scrub the copies again?', ok: 'Scrub', danger: true,
        message: `Rewrite the backups, restore copies and export of ${what} in ${agentId}'s claim ledger?`,
        detail: `The ledger already holds only the tombstone. ${PURGE_KEEPS}`,
      } : {
        title: 'Purge for good?', ok: 'Purge', danger: true,
        message: `Erase the text of ${what} from ${agentId}'s claim ledger?`,
        detail: `This cannot be undone. The text is removed from the ledger, its backups, its restore copies and its export; the claim stays as a purged tombstone and a purge event is recorded. ${PURGE_KEEPS}`,
      });
      if (!ok) return cancelled();
      const r = await store.purge(agentId, ids as string[], true);
      if (!r.ok) { d.log({ kind: 'claims-ui-purge', agentId, targets: ids, ok: false, error: r.error.slice(0, 120) }); return fail(r.error); }
      let scrubbed = 0;
      try { scrubbed = d.scrubExport(agentId, ids as string[]); } catch (e) { d.log({ kind: 'claims-ui-purge-scrub-failed', agentId, error: String(e).slice(0, 160) }); }
      d.log({ kind: 'claims-ui-purge', agentId, targets: ids, ok: true, id: r.id, copies: r.copies, failedCopies: r.failedCopies, exportLines: scrubbed });
      const failed = r.failedCopies.length
        ? ` NOT rewritten (the text may still be there): ${r.failedCopies.join(', ')}. Purge this claim again to retry them.`
        : '';
      return { ok: true, ...(r.id ? { id: r.id } : {}), note: `${r.copies} backup file(s) and ${scrubbed} export line(s) rewritten.${failed}` };
    },

    /** The Settings level; a drop below writer exports every writer agent completely first. */
    async setLevel(level: unknown): Promise<LedgerUiResult> {
      if (!LEDGER_LEVELS.includes(level as LedgerLevel)) return fail('bad level');
      const next = level as LedgerLevel;
      const rank = (l: LedgerLevel): number => LEDGER_LEVELS.indexOf(l);
      const writers = d.store() ? d.agents().filter((a) => d.level(a) === 'writer') : [];
      if (rank(next) < rank('writer') && writers.length) {
        const ok = await d.confirm({
          title: `Turn the claim ledger down to ${next}?`, ok: 'Export and turn down',
          message: `${writers.join(', ')} ${writers.length === 1 ? 'is' : 'are'} at writer level.`,
          detail: 'Each memory.md is replaced by a complete export of its ledger first (the planned downgrade). If any export fails, the level is not changed.',
        });
        if (!ok) return cancelled();
        for (const a of writers) {
          const r = d.exportComplete(a);
          if (!r.ok) { d.log({ kind: 'claims-ui-level', level: next, ok: false, agentId: a, error: r.error.slice(0, 120) }); return fail(`${a}: ${r.error}; the level was not changed`); }
        }
      }
      d.saveLevel(next);
      try { await d.levelChanged(); } catch (e) { d.log({ kind: 'claims-ui-level-push-failed', error: String(e).slice(0, 160) }); }
      d.log({ kind: 'claims-ui-level', level: next, ok: true, exported: rank(next) < rank('writer') ? writers : [] });
      return { ok: true, note: rank(next) < rank('writer') && writers.length ? `Exported ${writers.length} memory.md file(s) first.` : undefined };
    },

    /** The export button: the complete export of one agent (memory.md replaced by its ledger's rendering). */
    async exportNow(agentId: string): Promise<LedgerUiResult> {
      if (!AGENT_RE.test(agentId)) return fail('bad agent id');
      // Below writer, memory.md is still the agent's own file (the ledger only shadows or reads it):
      // replacing it could drop bullets the ledger has not taken in yet.
      const level = d.level(agentId);
      if (level !== 'writer') return fail(`${agentId} is at ${level}: its memory.md is still its own file, so there is nothing to export`);
      const ok = await d.confirm({
        title: 'Export memory.md?', ok: 'Export',
        message: `Replace ${agentId}'s memory.md with a complete export of its claim ledger?`,
        detail: 'Use this before turning the ledger down, or to hand an older app version a complete memory.md. The ledger itself is not changed.',
      });
      if (!ok) return cancelled();
      const r = d.exportComplete(agentId);
      d.log({ kind: 'claims-ui-export', agentId, ok: r.ok, ...(r.ok ? { bytes: r.bytes } : { error: r.error.slice(0, 120) }) });
      return r.ok ? { ok: true, note: `${r.bytes} bytes written. ${r.note}` } : fail(r.error);
    },
  };
}
export type LedgerUi = ReturnType<typeof createLedgerUi>;
