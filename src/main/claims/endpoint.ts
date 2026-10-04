/**
 * CLAIM-LEDGER W1: the claim verbs of `POST /memory/<token>` (and, through W6, the /ledger route's
 * memory part): note, retract, accept, dismiss, used, reconcile, and `export --complete` (W6's
 * planned-downgrade export of the agent's own memory.md; main supplies it as `exportComplete`).
 *
 * IDENTITY (G1.3). The agent is the token's agent, resolved before this runs. A body that names an
 * agent or a wing - or sets `source` or `legacy` (god cac15f) - is refused, at the top level or in
 * its args. The only provenance an agent can give is `fromMail`, which LOWERS a claim's trust to
 * `mail:<id>`.
 *
 * LEVEL. The verbs write only when the agent's effective level is `writer` (claims.ts
 * effectiveLevel); below it they answer exit 3 and tell the agent to keep appending to memory.md.
 */
import { LEDGER_LEVELS, type AppendOrigin, type ClaimKind, type LedgerLevel, type RecordDraft, type Ref, type SupersedesReason } from '../../shared/claims';
import type { ClaimStore } from './store';
import type { CandidateResult } from './candidates';

export const CLAIM_VERBS: ReadonlySet<string> = new Set(['note', 'retract', 'accept', 'dismiss', 'used', 'reconcile', 'export']);

export interface ClaimReply { ok: boolean; exit: number; text?: string; json?: unknown; error?: string }

const EXIT = { ok: 0, usage: 2, unavailable: 3 } as const;
/** Field names an agent must never send: identity and provenance are main's (G1.3, god cac15f). */
const FORBIDDEN = new Set(['agent', 'agentId', 'wing', 'source', 'legacy', 'section', 'by', 'wt', 'prev', 'mac', 'origin']);
const MSG_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

export interface ClaimsEndpointDeps {
  store: ClaimStore;
  /** The agent's effective level (claims.ts effectiveLevel over settings, manifest and the build). */
  level: (agentId: string) => LedgerLevel;
  /** Main-only notification after an acknowledged owner reconciliation answer. */
  onReconcile?: (agentId: string, a: string, b: string) => void;
  /** CLAIM-LEDGER W6: `memory export --complete` (exportWiring.ts); absent = not wired in this build. */
  exportComplete?: (agentId: string) => { ok: true; file: string; bytes: number; note: string } | { ok: false; error: string };
  /** CL-M4-WP: fresh candidate scan on the note path; presentation never appends. */
  noteCandidates?: (agentId: string, text: string) => Promise<CandidateResult>;
  /** Re-read verified derived state immediately before append; only same-owner live ids pass. */
  validateSupersedes?: (agentId: string, ids: string[]) => boolean;
  /** Choice-only diagnostics. Never pass note/reason text to this callback. */
  onNoteChoice?: (agentId: string, choice: 'offered' | 'new' | 'replace' | 'separate' | 'cancel', ids: string[]) => void;
}

function usage(error: string): ClaimReply { return { ok: false, exit: EXIT.usage, error }; }

function ids(v: unknown): string[] | null {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return null;
}

/** `--ref file:src/a.ts` or {type, value}. */
function parseRefs(v: unknown): Ref[] | string {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: Ref[] = [];
  for (const r of list) {
    if (typeof r === 'string') {
      const i = r.indexOf(':');
      if (i < 1) return `bad ref "${r.slice(0, 40)}": type:value, like file:src/a.ts or commit:abc123`;
      out.push({ type: r.slice(0, i) as Ref['type'], value: r.slice(i + 1) });
    } else if (r && typeof r === 'object') out.push(r as Ref);
    else return 'bad ref';
  }
  return out;
}

export async function handleClaimVerb(d: ClaimsEndpointDeps, agentId: string, body: unknown, origin: Extract<AppendOrigin, 'endpoint' | 'ledger-route'>): Promise<ClaimReply> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return usage('the body is not an object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'cmd' && k !== 'args') return usage(`refused: unknown field "${k}"`);
  const cmd = b.cmd;
  if (typeof cmd !== 'string' || !CLAIM_VERBS.has(cmd)) return usage(`unsupported command ${String(cmd)}`);
  const args = (b.args ?? {}) as Record<string, unknown>;
  if (typeof args !== 'object' || Array.isArray(args)) return usage('args is not an object');
  for (const k of Object.keys(args)) if (FORBIDDEN.has(k)) return usage(`refused: "${k}" is set by the app, never by a request (the wing is your token's)`);

  const level = d.level(agentId);
  if (level !== 'writer') {
    return { ok: false, exit: EXIT.unavailable, error: `the claim ledger is not on for you (level ${LEDGER_LEVELS.includes(level) ? level : 'off'}); keep appending to memory.md` };
  }

  const store = d.store;
  const done = (r: { ok: true; id: string } | { ok: false; error: string; didYouMean?: string }, verb: string): ClaimReply =>
    r.ok
      ? { ok: true, exit: EXIT.ok, text: `${verb} ${r.id}\n`, json: { id: r.id } }
      : { ok: false, exit: EXIT.usage, error: r.error, ...(r.didYouMean ? { json: { didYouMean: r.didYouMean } } : {}) };

  if (cmd === 'export') {
    if (args.complete !== true) return usage('export needs --complete (a complete memory.md, before the ledger is turned down)');
    for (const k of Object.keys(args)) if (k !== 'complete') return usage(`export takes only --complete (not "${k}")`);
    if (!d.exportComplete) return { ok: false, exit: EXIT.unavailable, error: 'export --complete is not available in this build' };
    const r = d.exportComplete(agentId);
    return r.ok
      ? { ok: true, exit: EXIT.ok, text: `exported a complete memory.md (${r.bytes} bytes)\n${r.note}\n`, json: { file: r.file, bytes: r.bytes, note: r.note } }
      : { ok: false, exit: EXIT.unavailable, error: r.error };
  }

  if (cmd === 'note') {
    if (typeof args.text !== 'string' || !args.text.trim()) return usage('note needs text');
    const refs = parseRefs(args.refs);
    if (typeof refs === 'string') return usage(refs);
    let source: 'self' | `mail:${string}` = 'self';
    if (args.fromMail !== undefined) {
      if (typeof args.fromMail !== 'string' || !MSG_ID_RE.test(args.fromMail)) return usage('bad --from-mail (a message id)');
      source = `mail:${args.fromMail}`;
    }
    const sup = args.supersedes === undefined ? undefined : ids(args.supersedes);
    if (sup === null) return usage('supersedes: claim ids');
    if (args.separate !== undefined && args.separate !== true) return usage('--separate takes no value');
    if (args.cancel !== undefined && args.cancel !== true) return usage('--cancel takes no value');
    if (args.separate === true && args.cancel === true) return usage('choose only one of --separate or --cancel');
    if (sup && args.separate === true || sup && args.cancel === true) return usage('choose replace, separate, or cancel');
    if (sup && args.reason === undefined) return usage('replacing claims needs --reason changed|corrected|moved');
    if (!sup && args.reason !== undefined) return usage('--reason requires --supersedes');
    if (args.reason !== undefined && !['changed', 'corrected', 'moved'].includes(String(args.reason))) return usage('--reason is changed, corrected, or moved');
    if (args.reasonText !== undefined && typeof args.reasonText !== 'string') return usage('--reason-text is text');
    if (args.reasonText !== undefined && args.reason === undefined) return usage('--reason-text requires --reason');
    const supersedesReason: SupersedesReason | undefined = args.reason === undefined ? undefined : {
      category: args.reason as SupersedesReason['category'],
      ...(args.reasonText !== undefined ? { note: args.reasonText as string } : {}),
    };
    if (sup?.length && source !== 'self') return usage('a mail claim cannot supersede an existing claim');
    let choices: CandidateResult | null = null;
    if (origin === 'endpoint' && d.noteCandidates) {
      try { choices = await d.noteCandidates(agentId, args.text); }
      catch { return { ok: false, exit: EXIT.unavailable, error: 'could not verify note candidates; no claim was written' }; }
      if (choices.excluded.some((x) => x.source === 'own' && x.reason === 'error')) {
        return { ok: false, exit: EXIT.unavailable, error: 'could not verify your live claims; no claim was written' };
      }
    }
    const candidates = choices?.candidates ?? [];
    const references = (choices as (CandidateResult & { references?: CandidateResult['candidates'] }) | null)?.references ?? [];
    if (!sup && choices && candidates.length) {
      if (args.cancel === true) { d.onNoteChoice?.(agentId, 'cancel', candidates.map(c => c.id)); return { ok: true, exit: EXIT.ok, text: 'cancelled; no claim was written\n', json: { choice: 'cancel', candidates, references } }; }
      if (args.separate !== true) {
        d.onNoteChoice?.(agentId, 'offered', candidates.map(c => c.id));
        return {
        ok: true, exit: EXIT.ok,
        text: `Possible related claims (ranking: ${choices.ranking}). Update habit: when a fact changed, replace its prior claim with --supersedes ID --reason changed|corrected|moved; choose --separate only when both claims remain true, or --cancel. --supersedes may name any live claim in your own ledger, including one not listed here. For another agent's fact, link/reference the owner's claim; do not copy it.\n${candidates.map((c) => `  ${c.id}  ${c.date}  ${c.title} — ${c.excerpt}`).join('\n')}${references.length ? `\nReference only (cannot replace):\n${references.map((c) => `  ${c.id}  ${c.date}  ${c.title} — ${c.excerpt}`).join('\n')}` : ''}\n`,
        json: { choice: 'choose', candidates, references, ranking: choices.ranking }
        };
      }
    }
    if (sup?.length) {
      if (!d.validateSupersedes?.(agentId, sup)) return usage('supersedes must name only your own currently live claims; refresh candidates and choose again');
      d.onNoteChoice?.(agentId, 'replace', sup);
    } else if (choices && !candidates.length) d.onNoteChoice?.(agentId, 'new', []);
    else if (args.separate === true) d.onNoteChoice?.(agentId, 'separate', candidates.map(c => c.id));
    else if (args.cancel === true) { d.onNoteChoice?.(agentId, 'cancel', []); return { ok: true, exit: EXIT.ok, text: 'cancelled; no claim was written\n', json: { choice: 'cancel' } }; }
    const draft: RecordDraft = {
      t: 'claim', kind: (args.kind ?? 'fact') as ClaimKind, text: args.text,
      ...(args.key !== undefined ? { key: args.key as string } : {}),
      ...(refs.length ? { refs } : {}),
      ...(args.ttl !== undefined ? { ttl: args.ttl as string } : {}),
      ...(args.pin === true ? { pin: true as const } : {}),
      ...(sup ? { supersedes: sup } : {}),
      ...(supersedesReason ? { supersedesReason } : {}),
      ...(args.at !== undefined ? { at: args.at as string } : {}),
      ...(source !== 'self' ? { source } : {}),
    };
    const result = await store.appendRecord(agentId, draft, origin);
    const choice = args.separate === true ? 'separate' : 'new';
    return result.ok && !sup ? { ...done(result, 'noted'), text: `noted ${result.id} (${choice})\n`, json: { id: result.id, choice } } : done(result, 'noted');
  }

  if (cmd === 'retract') {
    // C3: a retraction is a claim with `retracts`; its text says why.
    const targets = ids(args.ids);
    if (!targets || !targets.length) return usage('retract needs the claim ids');
    if (typeof args.text !== 'string' || !args.text.trim()) return usage('retract needs --why TEXT (the reason, kept as the claim)');
    const first = store.lookup(agentId, targets[0]);
    const draft: RecordDraft = { t: 'claim', kind: first?.kind ?? 'fact', text: args.text, retracts: targets };
    return done(await store.appendRecord(agentId, draft, origin), 'retracted by');
  }

  if (cmd === 'accept' || cmd === 'dismiss') {
    const targets = ids(args.ids);
    if (!targets || !targets.length) return usage(`${cmd} needs the claim ids`);
    return done(await store.appendRecord(agentId, { t: 'event', ev: cmd, targets }, origin), cmd === 'accept' ? 'accepted' : 'dismissed');
  }

  if (cmd === 'reconcile') {
    const a = args.a, bb = args.b, answer = args.answer;
    if (typeof a !== 'string' || typeof bb !== 'string') return usage('reconcile needs the two claim ids A B');
    if (answer !== 'keep-both' && answer !== 'supersedes' && answer !== 'retract') return usage('--answer is keep-both, supersedes (A supersedes B) or retract (retract B)');
    if (answer === 'retract') {
      // C3: the retraction itself is a claim with `retracts`; the answer event records the decision.
      if (typeof args.text !== 'string' || !args.text.trim()) return usage('a retract answer needs --why TEXT');
      const kind = store.lookup(agentId, bb)?.kind ?? 'fact';
      const r = await store.appendRecord(agentId, { t: 'claim', kind, text: args.text, retracts: [bb] }, origin);
      if (!r.ok) return done(r, '');
    }
    // targets = [loser, winner] (W2's contract, god 2f8991): `A B --answer supersedes` means A wins.
    const result = await store.appendRecord(agentId, { t: 'event', ev: 'reconcile-answer', targets: [bb, a], answer }, origin);
    if (result.ok) d.onReconcile?.(agentId, a, bb);
    return done(result, 'answered');
  }

  // used
  const claim = args.id;
  const op = args.op ?? 'helped';
  if (typeof claim !== 'string') return usage('used needs the claim id');
  const r = store.noteUsage(agentId, { claim, op: op as 'view' | 'hit' | 'helped' | 'hurt', ...(typeof args.card === 'string' ? { card: args.card } : {}) });
  return r.ok ? { ok: true, exit: EXIT.ok, text: `used ${claim} (${String(op)})\n` } : usage(r.error);
}
