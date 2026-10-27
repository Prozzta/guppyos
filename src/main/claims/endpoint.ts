/**
 * CLAIM-LEDGER W1: the claim verbs of `POST /memory/<token>` (and, through W6, the /ledger route's
 * memory part): note, retract, accept, dismiss, used, reconcile, and `export --complete` (W6's
 * planned-downgrade export of the agent's own memory.md; main supplies it as `exportComplete`), and
 * `history ID` (CLAIMS-90 HISTORY-PTR: the read behind a `[history: memory history <id>]` pointer;
 * main supplies it as `claimHistory`).
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
import { restatedIds } from './valueSupersede';
import { readSafeId } from './get';

export const CLAIM_VERBS: ReadonlySet<string> = new Set(['note', 'retract', 'accept', 'dismiss', 'used', 'reconcile', 'export', 'history', 'get']);

export interface ClaimReply { ok: boolean; exit: number; text?: string; json?: unknown; error?: string }

const EXIT = { ok: 0, usage: 2, unavailable: 3 } as const;
/** Field names an agent must never send: identity and provenance are main's (G1.3, god cac15f). */
const FORBIDDEN = new Set(['agent', 'agentId', 'wing', 'source', 'legacy', 'section', 'value', 'valueAgent', 'by', 'wt', 'prev', 'mac', 'origin']);
const MSG_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const CLAIM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ClaimsEndpointDeps {
  store: ClaimStore;
  /** The agent's effective level (claims.ts effectiveLevel over settings, manifest and the build). */
  level: (agentId: string) => LedgerLevel;
  /** Main-only notification after an acknowledged owner reconciliation answer. */
  onReconcile?: (agentId: string, a: string, b: string) => void;
  /** CLAIM-LEDGER W6: `memory export --complete` (exportWiring.ts); absent = not wired in this build. */
  exportComplete?: (agentId: string) => { ok: true; file: string; bytes: number; note: string } | { ok: false; error: string };
  /** CLAIMS-90 HISTORY-PTR: the history group holding claim `id` in the served hive (the caller's
   *  ledger first, then the other agents'); absent = not wired in this build. */
  claimHistory?: (agentId: string, id: string) => { ok: true; text: string; owner: string } | { ok: false; error: string };
  /** CL-M4-WP: fresh candidate scan on the note path; presentation never appends. `key` lists a
   *  same-key live claim first (CL-M4-FORWARD-PATH; an offer, never a supersede). */
  noteCandidates?: (agentId: string, text: string, o?: { key?: string }) => Promise<CandidateResult>;
  /** Re-read verified derived state immediately before append; only same-owner live ids pass. */
  validateSupersedes?: (agentId: string, ids: string[]) => boolean;
  /** S3: the agent's own LIVE claims with this key, newest first (verified state). */
  liveByKey?: (agentId: string, key: string) => string[];
  /** R2 (d): the same live claims with their text, for the restatement rule (valueSupersede.ts). */
  liveClaimsByKey?: (agentId: string, key: string) => Array<{ id: string; text: string }>;
  /** Choice-only diagnostics. Never pass note/reason text to this callback. */
  onNoteChoice?: (agentId: string, choice: NoteChoice, ids: string[], detail?: NoteChoiceDetail) => void;
  /** CLAIMS-90 R2 (C90-GET): `memory get <key|card>`, read-only over every verified ledger (claims/get.ts); absent = not wired in this build. */
  get?: (agentId: string, args: { term: string; agent?: string | null; mail?: number; before?: string | null; noMail?: boolean; history?: boolean }) => { text: string; json: unknown };
}

/** `unoffered`: a note written where no offer can be shown (the `ledger` command's memory part). */
export type NoteChoice = 'offered' | 'new' | 'replace' | 'separate' | 'cancel' | 'unoffered';
/**
 * CL-M4-FORWARD-PATH: counts and flags only (never text), so the claims-note-choice rows can measure
 * the replace share of new writes: how big the offer was, whether it held a same-key claim, whether
 * the chosen ids came from it, and whether a bare --separate was sent back to the offer.
 */
export interface NoteChoiceDetail {
  origin: Extract<AppendOrigin, 'endpoint' | 'ledger-route'>;
  /** Candidates in the offer this call computed (0 when none or not computed). */
  shown: number;
  sameKey: number;
  sameCard: number;
  /** The note carried --key. */
  keyed: boolean;
  /** replace / separate: how many of the named ids are in this call's offer. */
  inOffer?: number;
  /** replace: a named id is a same-key candidate. */
  sameKeyChosen?: boolean;
  /** offered: --separate named only ids outside this call's offer, so it was sent back to the offer (S2). */
  offOfferSeparate?: true;
  /** offered (ledger route): a card.* note met a live same-key claim and was refused until it chooses (S3). */
  cardKeyRefused?: true;
  /** offered: a bare --separate was sent back to the offer. */
  bareSeparate?: boolean;
  /** replace: R2 (d), the note said nothing and replaced the writer's own same-key claims it restates. */
  sameKeyAuto?: true;
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

/**
 * CL-M4-FORWARD-PATH S3 (god's call, option a): the `ledger` command's memory part cannot show an
 * offer, so a note keyed `card.*` is refused while a live own claim has that key, unless it says
 * what it does to it (supersedes, or separate ids). The text names the ids and the exact fields to
 * add. Null when the note may be written. Nothing is ever superseded here.
 * CLAIMS-90 R2 (d): a self note that says nothing and RESTATES a live same-key claim (sameKeyAuto)
 * is not refused: handleClaimVerb retires the restated claims; the others are still listed here.
 */
export function cardKeyRefusal(d: Pick<ClaimsEndpointDeps, 'liveByKey' | 'liveClaimsByKey'>, agentId: string, args: Record<string, unknown>): { text: string; ids: string[] } | null {
  const key = args.key;
  if (typeof key !== 'string' || !key.startsWith('card.')) return null;
  const restated = new Set(sameKeyAuto(d, agentId, args));
  const live = (d.liveByKey?.(agentId, key) ?? []).filter((id) => !restated.has(id));
  if (!live.length) return null;
  // A ledger route cannot show the candidate offer.  A non-bare separate therefore counts only
  // when it explicitly keeps at least one of this key's live claims apart.
  const apart = args.separate === undefined || args.separate === true ? null : ids(args.separate);
  if (args.separate !== undefined && args.separate !== true && (!apart || !apart.length)) return null;
  if (args.supersedes !== undefined || (apart && apart.some((id) => live.includes(id)))) return null;
  const list = live.slice(0, 5);
  return {
    ids: list,
    text: `your live claim${list.length > 1 ? 's' : ''} ${list.join(', ')} already ${list.length > 1 ? 'have' : 'has'} key ${key}. Say what this note does to ${list.length > 1 ? 'them' : 'it'}, then send the op again: add "supersedes": ["${list[0]}"], "reason": "changed" (or "corrected" / "moved") to the memory part when it replaces ${list.length > 1 ? 'one' : 'it'}; add "separate": ["${list.join('", "')}"] when both stay true. Nothing was written`,
  };
}

/**
 * CLAIMS-90 R2 (d), the write-time supersede rule (god 9f7922; valueSupersede.ts): a self note under
 * a key that says nothing about its same-key claims (no --supersedes, --separate or --cancel) retires
 * the writer's OWN live claims under that key that it RESTATES (same text but a value), reason
 * changed, note "restated". Other same-key claims and another agent's claims are never touched.
 */
export function sameKeyAuto(d: Pick<ClaimsEndpointDeps, 'liveClaimsByKey'>, agentId: string, args: Record<string, unknown>): string[] {
  if (typeof args.key !== 'string' || typeof args.text !== 'string') return [];
  if (args.supersedes !== undefined || args.separate !== undefined || args.cancel !== undefined || args.fromMail !== undefined) return [];
  return restatedIds(args.text, d.liveClaimsByKey?.(agentId, args.key) ?? []);
}

export async function handleClaimVerb(d: ClaimsEndpointDeps, agentId: string, body: unknown, origin: Extract<AppendOrigin, 'endpoint' | 'ledger-route'>): Promise<ClaimReply> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return usage('the body is not an object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'cmd' && k !== 'args') return usage(`refused: unknown field "${k}"`);
  const cmd = b.cmd;
  if (typeof cmd !== 'string' || !CLAIM_VERBS.has(cmd)) return usage(`unsupported command ${String(cmd)}`);
  const args = (b.args ?? {}) as Record<string, unknown>;
  if (typeof args !== 'object' || Array.isArray(args)) return usage('args is not an object');
  // `memory get --agent A` asks for A's value (a filter); every other verb's agent is the token's.
  for (const k of Object.keys(args)) if (FORBIDDEN.has(k) && !(cmd === 'get' && k === 'agent')) return usage(`refused: "${k}" is set by the app, never by a request (the wing is your token's)`);

  // CLAIMS-90 R2: `get` reads every agent's verified ledger and writes nothing, so it needs no level of its own.
  if (cmd === 'get') {
    if (typeof args.term !== 'string' || !args.term.trim()) return usage('get needs a KEY or CARD id (memory get card.<id> | memory get <key> [--agent A] [--mail N] [--before MAILID] [--no-mail] [--all])');
    for (const k of Object.keys(args)) if (!['term', 'agent', 'mail', 'before', 'noMail', 'history'].includes(k)) return usage(`get does not take "${k}"`);
    if (args.agent !== undefined && args.agent !== null && (typeof args.agent !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(args.agent))) return usage('bad --agent (an agent id)');
    if (args.mail !== undefined && (typeof args.mail !== 'number' || !Number.isInteger(args.mail) || args.mail < 0 || args.mail > 50)) return usage('--mail must be 0-50');
    if (args.before !== undefined && args.before !== null && (typeof args.before !== 'string' || !MSG_ID_RE.test(args.before))) return usage('bad --before (a mail id)');
    if (args.noMail !== undefined && args.noMail !== true) return usage('--no-mail takes no value');
    if (args.history !== undefined && args.history !== true) return usage('--all takes no value');
    if (!d.get) return { ok: false, exit: EXIT.unavailable, error: 'memory get is not available in this build' };
    const r = d.get(agentId, { term: args.term, agent: (args.agent as string | null | undefined) ?? null, mail: args.mail as number | undefined, before: (args.before as string | null | undefined) ?? null, noMail: args.noMail === true, history: args.history === true });
    return { ok: true, exit: EXIT.ok, text: r.text, json: r.json };
  }

  // CLAIMS-90 HISTORY-PTR: a read of the served hive, like search, so it answers at every level: a
  // pointer an agent was shown (a wake-up, or an older memory.md in a search hit) always resolves.
  if (cmd === 'history') {
    for (const k of Object.keys(args)) if (k !== 'id') return usage(`history takes only a claim id (not "${k}")`);
    if (typeof args.id !== 'string' || !CLAIM_ID_RE.test(args.id)) return usage('history needs one claim id, like: memory history c-0123456789ab');
    if (!d.claimHistory) return { ok: false, exit: EXIT.unavailable, error: 'history is not available in this build' };
    // An id as get prints it (c_<hex>, L5 sha-proof) is the ledger's c-<hex>: the same reading as get's terms.
    const id = readSafeId(args.id);
    const r = d.claimHistory(agentId, id);
    return r.ok
      ? { ok: true, exit: EXIT.ok, text: r.text, json: { id, owner: r.owner } }
      : { ok: false, exit: EXIT.usage, error: r.error };
  }

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
    let sup = args.supersedes === undefined ? undefined : ids(args.supersedes);
    if (sup === null) return usage('supersedes: claim ids');
    // CL-M4-FORWARD-PATH: --separate names the ids it keeps apart (c-a,c-b); a bare one is still
    // accepted, but with candidates present it returns the offer instead of writing.
    let apart: string[] | null = null;
    if (args.separate !== undefined && args.separate !== true) {
      const list = typeof args.separate === 'string' ? args.separate.split(',').map((x) => x.trim()).filter(Boolean)
        : Array.isArray(args.separate) && args.separate.every((x) => typeof x === 'string') ? (args.separate as string[]).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean)
          : null;
      if (!list || !list.length || list.length > 20 || new Set(list).size !== list.length || !list.every((x) => MSG_ID_RE.test(x))) {
        return usage('--separate names the claim ids it keeps apart: --separate ID[,ID]');
      }
      apart = list;
    }
    const separate = args.separate !== undefined;
    if (args.cancel !== undefined && args.cancel !== true) return usage('--cancel takes no value');
    if (separate && args.cancel === true) return usage('choose only one of --separate or --cancel');
    if (sup && separate || sup && args.cancel === true) return usage('choose replace, separate, or cancel');
    if (sup && args.reason === undefined) return usage('replacing claims needs --reason changed|corrected|moved');
    if (!sup && args.reason !== undefined) return usage('--reason requires --supersedes');
    if (args.reason !== undefined && !['changed', 'corrected', 'moved'].includes(String(args.reason))) return usage('--reason is changed, corrected, or moved');
    if (args.reasonText !== undefined && typeof args.reasonText !== 'string') return usage('--reason-text is text');
    if (args.reasonText !== undefined && args.reason === undefined) return usage('--reason-text requires --reason');
    if (args.key !== undefined && typeof args.key !== 'string') return usage('--key is text');
    const key = args.key as string | undefined;
    const auto = sameKeyAuto(d, agentId, args);
    if (auto.length) sup = auto;
    if (origin === 'ledger-route') {
      const refused = cardKeyRefusal(d, agentId, args);
      if (refused) {
        d.onNoteChoice?.(agentId, 'offered', refused.ids, { origin, shown: refused.ids.length, sameKey: refused.ids.length, sameCard: 0, keyed: true, cardKeyRefused: true });
        return usage(refused.text);
      }
    }
    if (args.cancel === true) {
      d.onNoteChoice?.(agentId, 'cancel', [], { origin, shown: 0, sameKey: 0, sameCard: 0, keyed: key !== undefined });
      return { ok: true, exit: EXIT.ok, text: 'cancelled; no claim was written\n', json: { choice: 'cancel' } };
    }
    const supersedesReason: SupersedesReason | undefined = auto.length ? { category: 'changed', note: 'restated' } : args.reason === undefined ? undefined : {
      category: args.reason as SupersedesReason['category'],
      ...(args.reasonText !== undefined ? { note: args.reasonText as string } : {}),
    };
    if (sup?.length && source !== 'self') return usage('a mail claim cannot supersede an existing claim');
    let choices: CandidateResult | null = null;
    if (origin === 'endpoint' && d.noteCandidates) {
      try { choices = await d.noteCandidates(agentId, args.text, key !== undefined ? { key } : {}); }
      catch { return { ok: false, exit: EXIT.unavailable, error: 'could not verify note candidates; no claim was written' }; }
      if (choices.excluded.some((x) => x.source === 'own' && x.reason === 'error')) {
        return { ok: false, exit: EXIT.unavailable, error: 'could not verify your live claims; no claim was written' };
      }
    }
    const candidates = choices?.candidates ?? [];
    const references = (choices as (CandidateResult & { references?: CandidateResult['candidates'] }) | null)?.references ?? [];
    const offerIds = new Set(candidates.map((c) => c.id));
    const detail = (extra: Partial<NoteChoiceDetail> = {}): NoteChoiceDetail => ({
      origin, shown: candidates.length, sameKey: candidates.filter((c) => c.why === 'same key').length,
      sameCard: candidates.filter((c) => c.why === 'same card').length, keyed: key !== undefined, ...extra,
    });
    // S2 (Jim): the ids kept apart are checked first (own and live, as a replace target would be);
    // then, if none of them is in this call's offer, the offer comes back instead of a write.
    if (apart && !d.validateSupersedes?.(agentId, apart)) return usage('--separate must name only your own currently live claims; refresh candidates and choose again');
    const offOffer = !!apart && !apart.some((x) => offerIds.has(x));
    if (!sup && choices && candidates.length && (!apart || offOffer)) {
      d.onNoteChoice?.(agentId, 'offered', candidates.map(c => c.id), detail(apart ? { offOfferSeparate: true } : separate ? { bareSeparate: true } : {}));
      const line = (c: CandidateResult['candidates'][number]): string => `  ${c.id}  ${c.date}  ${c.why ? `[${c.why}] ` : ''}${c.title} — ${c.excerpt}`;
      return {
        ok: true, exit: EXIT.ok,
        text: `${apart ? 'None of the ids after --separate is in this offer: choose from it (--separate ID[,ID] names listed claims that stay true).\n' : separate ? 'A bare --separate does not skip this offer: name the claims you keep apart, --separate ID[,ID].\n' : ''}Possible related claims (ranking: ${choices.ranking}). Update habit: when a fact changed, corrected, or moved, replace its prior claim with --supersedes ID --reason changed|corrected|moved; choose --separate ID[,ID] (the listed claims that stay true beside the new one) only when both claims remain true, or --cancel. A [same key] claim is listed first: it is usually the one to replace, but nothing is replaced unless you choose it. --supersedes may name any live claim in your own ledger, including one not listed here. For another agent's fact, link/reference the owner's claim; do not copy it.\n${candidates.map(line).join('\n')}${references.length ? `\nReference only (cannot replace):\n${references.map(line).join('\n')}` : ''}\n`,
        json: { choice: 'choose', candidates, references, ranking: choices.ranking }
      };
    }
    if (sup?.length) {
      if (!d.validateSupersedes?.(agentId, sup)) return usage('supersedes must name only your own currently live claims; refresh candidates and choose again');
      const sameKeyIds = new Set(candidates.filter((c) => c.why === 'same key').map((c) => c.id));
      d.onNoteChoice?.(agentId, 'replace', sup, detail({ inOffer: sup.filter((x) => offerIds.has(x)).length, sameKeyChosen: sup.some((x) => sameKeyIds.has(x)), ...(auto.length ? { sameKeyAuto: true } : {}) }));
    } else if (apart) {
      d.onNoteChoice?.(agentId, 'separate', apart, detail({ inOffer: apart.filter((x) => offerIds.has(x)).length }));
    } else if (choices && !candidates.length) d.onNoteChoice?.(agentId, 'new', [], detail());
    else if (!choices && origin === 'ledger-route') d.onNoteChoice?.(agentId, 'unoffered', [], detail());
    else if (separate) d.onNoteChoice?.(agentId, 'separate', [], detail());
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
    const choice = separate ? 'separate' : 'new';
    if (result.ok && auto.length) {
      return { ...done(result, 'noted'), text: `noted ${result.id}; it restates and replaces your claim${auto.length > 1 ? 's' : ''} ${auto.join(', ')} under key ${key} (same words, a new value). If both stay true, write it with --separate ${auto.join(',')} instead.\n`, json: { id: result.id, choice: 'replace', sameKeyAuto: auto } };
    }
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
