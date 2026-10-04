/**
 * CLAIM-LEDGER: the frozen day-0 interface (_work/system1/CLAIM-LEDGER-BUILD-PLAN.md Â§2, v2, with
 * Jim's conditions C2 and C3 from CLAIM-LEDGER-PLAN-AUDIT.md). Every stream (W1-W8) codes against
 * these types. A change after day 0 needs an ack from every stream owner, sent by mail to god.
 *
 * ONE STREAM PER AGENT. Claims and events interleave in append order, in monthly segments
 * `agents/<id>/memory/claims/<YYYY-MM>.jsonl`. Closed months are immutable.
 *
 * WHO SETS WHAT. A caller sends a RecordDraft. Main fills `id`, `wt` (write time), the clamped
 * `at` (at = min(claimed ?? wt, wt), so a future `at` is impossible), `agent` (from the token,
 * never from the body), `prev` and `mac`.
 *
 * THE CHAIN. `prev` is the sha256 of the previous line, across segments (the first line of a month
 * chains to the last line of the month before). `mac` = HMAC-SHA256(key, prev + canonical(record
 * without mac)). The key is held by main only (Electron safeStorage in user-data), never in an
 * agent's env or a hive file. A bad prev or mac makes that agent's ledger read-only and raises a
 * `claims-chain-broken` alert; nothing is fixed automatically.
 *
 * C2, A LOST KEY. A missing key or a failed decrypt makes every ledger read-only and raises ONE
 * `claims-key-missing` alert to god and the Human. Recovery is an explicit Human action in Settings
 * that appends a `rekey` event, chained with the new key over the last verified record. Never
 * automatic. The key comes through an injectable MacKeyProvider, so tests and the Electron-as-Node
 * drills (no safeStorage before `app` is ready) use a sandbox key.
 *   - After a key loss no earlier MAC can be verified. A rekey therefore means the Human ACCEPTS
 *     the records up to its targets[0] on the sha256 `prev` chain alone; records after the rekey
 *     verify with the new key (G1.10).
 *   - "First use" (create() without a Human) means no claims segment exists under ANY agent. A
 *     key that is missing while any segment exists is a lost key, never a reason to make a fresh
 *     one: a dev build with another user-data folder gets key-missing.
 *
 * TEXT LIMITS (god, final rule). CLAIM_TEXT_MAX (400) for everything that arrives through an
 * external entry point: POST /memory/<token>, the /ledger route's memory part and the UI IPC.
 * Refused, never cut. CLAIM_TEXT_MAX_LEGACY (4000) only when main calls appendRecord with the
 * origin 'w6-internal', which only W6's importLegacy and parseNewBullets pass. Every external entry
 * point also refuses a draft that carries `source` or `legacy`. W6 splits a block over 4000 at line
 * boundaries into parts with the same legacy {file,line,sha256}; appendRecord still refuses over
 * 4000 as a backstop. Dedup keys on legacy.sha256 + part index, never on file:line.
 *
 * C3, ONE RETRACT FORM. A retraction is ONLY a ClaimRec with `retracts` (R3). There is no
 * `retract` event. A reconcile answer of 'retract' is recorded as the answer event, and main writes
 * the retraction as a ClaimRec with `retracts`; derive() retracts only from ClaimRec.retracts.
 *
 * READERS KEEP AND IGNORE a record whose `v` or `ev` they do not know; they never drop it (F8).
 */

export const LEDGER_RECORD_VERSION = 1;

export type ClaimKind = 'fact' | 'decision' | 'lesson' | 'preference' | 'procedure' | 'pointer' | 'todo';
export const CLAIM_KINDS: readonly ClaimKind[] = ['fact', 'decision', 'lesson', 'preference', 'procedure', 'pointer', 'todo'];

export type ClaimSource = 'self' | 'human' | 'god' | `mail:${string}` | 'legacy';
export type Ref = { type: 'file' | 'commit' | 'task' | 'msg' | 'url'; value: string };

/** The longest claim text, in characters, through any external entry point. Longer text is refused, never cut. */
export const CLAIM_TEXT_MAX = 400;
/** The longest claim text for origin 'w6-internal' only (W6 importLegacy and parseNewBullets). */
export const CLAIM_TEXT_MAX_LEGACY = 4000;

export interface RecBase {
  v: 1;
  id: string;
  /** Event time (ISO), CLAMPED by main: at = min(claimed ?? wt, wt) (F2). */
  at: string;
  /** Write time (ISO), set by main only. */
  wt: string;
  agent: string;
  /** sha256 (hex) of the previous line, across segments (F13). '' for an agent's first record. */
  prev: string;
  /** HMAC-SHA256(key, prev + canonical(record without mac)), hex (F3). */
  mac: string;
}

export interface ClaimRec extends RecBase {
  t: 'claim';
  kind: ClaimKind;
  key?: string;
  /** Verbatim, at most CLAIM_TEXT_MAX characters. */
  text: string;
  refs?: Ref[];
  source: ClaimSource;
  supersedes?: string[];
  /** C3: the ONLY way to retract (R3). */
  retracts?: string[];
  ttl?: string | null;
  pin?: true;
  redacted?: true;
  legacy?: { file: string; line: number; sha256: string };
  /**
   * G3.5 (god's GO, all stream owners acked, plan line 64): the Markdown heading the entry stood
   * under, set ONLY by W6 (the legacy import and the fallback parser), at most migrate.ts SECTION_MAX characters
   * (cut, never refused). Search context only: never part of R1's identity, never printed per bullet
   * in an export. MAC-covered like every field.
   */
  section?: string;
}

export type EventKind =
  | 'sighting' | 'inferred-supersede' | 'soft-supersede' | 'reconcile-answer' | 'revert'
  | 'accept' | 'dismiss' | 'key-alias' | 'pin' | 'unpin' | 'purge' | 'status-mark'
  | 'rekey';
export const EVENT_KINDS: readonly EventKind[] = [
  'sighting', 'inferred-supersede', 'soft-supersede', 'reconcile-answer', 'revert',
  'accept', 'dismiss', 'key-alias', 'pin', 'unpin', 'purge', 'status-mark',
  'rekey',
];

export interface EventRec extends RecBase {
  t: 'event';
  ev: EventKind;
  /**
   * For a supersede-type decision (`reconcile-answer`, `soft-supersede`, `inferred-supersede`):
   * targets = [loser, winner] (god 2f8991; W2 reads it so). For `rekey` (C2): [the id of the last
   * verified record].
   */
  targets: string[];
  /** e.g. 'R4@0.92'. */
  rule?: string;
  by: 'code' | 'self' | 'human';
  answer?: 'keep-both' | 'supersedes' | 'retract';
  reason?: string;
  /** `rekey` only (C2): the first 16 hex of sha256(new key), so a reader knows which key the chain uses from here. */
  keyId?: string;
}

export type LedgerRec = ClaimRec | EventRec;

/**
 * What a caller may send. Main fills id, wt, the at-clamp, agent (from the token), prev and mac.
 * source 'human' only from the UI IPC; 'legacy' only from W6 import; agents' tokens get 'self' or 'mail:<id>'.
 * C3: no 'retract' event; retract with a claim draft carrying `retracts`.
 * `rekey` is not a draft: only main's Human-confirmed Settings action writes it (C2).
 */
export type RecordDraft =
  | {
      t: 'claim'; kind: ClaimKind; text: string; key?: string; refs?: Ref[]; ttl?: string | null; pin?: true;
      supersedes?: string[]; retracts?: string[]; at?: string; source?: 'self' | 'human' | `mail:${string}` | 'legacy';
      legacy?: ClaimRec['legacy']; section?: string;
    }
  | {
      t: 'event'; ev: 'accept' | 'dismiss' | 'reconcile-answer' | 'revert' | 'pin' | 'unpin'; targets: string[];
      answer?: EventRec['answer'];
    };

export type AppendResult = { ok: true; id: string } | { ok: false; error: string; didYouMean?: string };

/**
 * Which code path calls appendRecord. Each caller passes its own constant; nothing in a request
 * body can choose it.
 *   'endpoint'     POST /memory/<token>; source 'self' (or 'mail:<id>' from the verb's own flag), <= 400
 *   'ledger-route' the /ledger route's memory part (W6); as 'endpoint'
 *   'ui-ipc'       the Human's UI (W7); source 'human', <= 400
 *   'w6-internal'  W6 importLegacy and parseNewBullets only; source 'legacy' or 'self', `legacy` allowed, <= 4000
 */
export type AppendOrigin = 'endpoint' | 'ledger-route' | 'ui-ipc' | 'w6-internal';

export interface TornInfo { segment: string; offset: number; bytes: number; quarantinedTo: string; at: string }

export type ChainBreak = { brokenAt: string /* record id or byte offset */; reason: 'prev' | 'mac' | 'parse' | 'key-missing' };
export interface ReadResult {
  records: LedgerRec[];
  torn: TornInfo | null;
  /** Anything but 'ok' makes the agent's ledger read-only (G1.6, G1.8, G1.10). */
  chain: 'ok' | ChainBreak;
}

/** The log/alert rows W1 raises. */
export const CLAIMS_ALERT_CHAIN_BROKEN = 'claims-chain-broken';
export const CLAIMS_ALERT_KEY_MISSING = 'claims-key-missing';
export const CLAIM_LEDGER_CLAMP_ROW = 'claim-ledger-clamp';

/** C2: the injectable key source. The app's provider wraps safeStorage; tests and drills inject a sandbox key. */
export type MacKeyLoad =
  | { ok: true; key: Uint8Array; keyId: string }
  | { ok: false; reason: 'missing' | 'decrypt-failed' | 'unavailable' };
export interface MacKeyProvider {
  /** Never creates a key. */
  load(): MacKeyLoad;
  /** Creates and stores a new key. Main calls it on first use (no ledger anywhere yet) and for a Human rekey only. */
  create(): MacKeyLoad;
}

/** hive/memory-keys.json */
export interface KeyRegistry {
  v: 1;
  namespaces: Array<{ pattern: string /* 'release.*', 'agent.<id>.*' */; cardinality: 'single' | 'multi' }>;
  keys: Record<string, { cardinality: 'single' | 'multi'; addedAt: string; addedBy: string; aliasOf?: string }>;
}

/** The `/memory/<token>` body. The wing is from the token only; a body naming an agent or wing is refused (G1.3). */
export type MemoryCmd = 'note' | 'retract' | 'accept' | 'dismiss' | 'used' | 'reconcile';

/** Ledger-closed status (W2). */
export type Status = 'live' | 'superseded' | 'superseded?' | 'retracted' | 'purged';
export interface ClaimState {
  id: string; status: Status; supersededBy?: string; sightings: number;
  firstAt: string; lastAt: string; pinned: boolean; reasons: string[] /* e.g. 'R2 by c123' */;
}
/** claims-state.json = canonical JSON of ClaimsState. It holds NO clock-, file-, task- or usage-derived field. */
export interface ClaimsState {
  v: 1; agent: string; registryHash: string; ledgerHead: string /* last mac */;
  /** Canonical: keys sorted. */
  claims: Record<string, ClaimState>;
  /** Feeds W5. */
  conflicts: Array<{ a: string; b: string; rule: 'R5' | 'R2-mail' }>;
}

export type WorldFlag = 'expired' | 'stale-ref' | 'changed-since';
export interface WorldView {
  flags: Record<string, WorldFlag[]>;
  counters: Record<string, { helped: number; hurt: number; lastSeen?: string }>;
}
export interface WorldInputs {
  now: string;
  taskStatus: (taskId: string) => string | null;
  fileExists: (p: string) => boolean;
  commitExists: (sha: string) => boolean;
  fileChangedSince: (p: string, sinceIso: string) => boolean;
  cardOutcomes: Record<string, 'helped' | 'hurt'>;
}

export interface UsageRec { at: string; claim: string; op: 'view' | 'hit' | 'helped' | 'hurt'; turn?: string; card?: string }

export interface ClaimChunk {
  claimId: string; wing: string; kind: ClaimKind; ckey: string | null; at: string;
  status: Status; content: string /* 'kind Â· key Â· date\n' + text */; contentSha256: string;
}

/** Appended to memory/receipts.jsonl. */
export interface Receipt {
  at: string; agent: string; budget: number; used: number;
  included: Array<{ id: string; tier: number; tokens: number }>;
  excluded: Array<{ id: string; reason: 'budget' | 'status' | 'expired' | 'tier-share' }>;
  warnings: string[];
}

export interface ReconcileItem {
  itemId: string; agent: string; kind: 'conflict' | 'key-alias'; rule?: 'R5' | 'R2-mail';
  a: string; b: string; text: string; leasedAt?: string; leaseTurn?: string; turnsUnanswered: number;
}

/** The API contracts (Â§2 table). Implementations live in their streams. */
export type AppendRecordFn = (agentId: string, draft: RecordDraft, origin: AppendOrigin) => Promise<AppendResult>;   // W1
export type ReadLedgerFn = (agentId: string) => ReadResult;                                     // W1
export type DeriveFn = (records: LedgerRec[], registry: KeyRegistry, ruleConfig: { r4: boolean }) => ClaimsState;   // W2, pure
export type WorldViewFn = (state: ClaimsState, records: LedgerRec[], usage: UsageRec[], world: WorldInputs) => WorldView;   // W2
export type ChunksForFn = (records: LedgerRec[], state: ClaimsState) => ClaimChunk[];           // W3
export type SearchMode = 'live' | 'history' | 'all';                                            // W3
export type BuildWorkingSetFn = (state: ClaimsState, view: WorldView, budget: number) => { text: string; receipt: Receipt };   // W4
export type RenderMemoryMdFn = (state: ClaimsState, view: WorldView, mode: 'view' | 'complete') => string;   // W4
export type RenderExportLineFn = (rec: LedgerRec, state: ClaimsState) => string;                // W4
export type ReconcileItemsFn = (agentId: string, n: number /* <= 3 */) => ReconcileItem[];       // W5, leased

/**
 * R5 candidates come from the embedder side, never from derive() (god 1f7b07). After main appends
 * and indexes a claim, it asks W3 for same-agent live neighbours with cosine >= tau2 and no typed-slot
 * match, and hands them to W5's queue, which merges them with derive's 'R2-mail' rows. Never for the
 * legacy import (only claims appended after it), and W5 logs each enqueued pair with its cosine and
 * tau2 so W8 can replay it (Jim, binding).
 */
export interface R5Candidate { a: string /* the new claim */; b: string; cosine: number; tau2: number }
export type R5CandidatesFn = (agentId: string, claimId: string) => Promise<R5Candidate[]>;      // W3
export type EnqueueCandidatesFn = (agentId: string, pairs: R5Candidate[]) => void;              // W5
export type ImportLegacyFn = (agentDir: string) => RecordDraft[];                               // W6
export type ParseNewBulletsFn = (memoryMd: string, knownIds: Set<string>) => RecordDraft[];     // W6

/** Settings and the per-agent manifest (F8). */
export type LedgerLevel = 'off' | 'shadow' | 'reader' | 'writer';
export const LEDGER_LEVELS: readonly LedgerLevel[] = ['off', 'shadow', 'reader', 'writer'];
export interface LedgerFlags { claimLedger: LedgerLevel; reconcile: boolean; r4: boolean }
/** memory-sources.json carries `{ ledger: Record<agentId, LedgerLevel> }`. */
export interface LedgerManifest { ledger: Record<string, LedgerLevel> }

/**
 * The highest level THIS build implements. Each slice raises it (S0 'shadow', S1 'reader', S2 'writer').
 * Day 0 implements nothing yet.
 */
export const IMPLEMENTED_LEVEL: LedgerLevel = 'off';

/** A name a NEWER build may use for a level: a non-empty lower-case word. */
const NEWER_LEVEL = /^[a-z][a-z0-9-]*$/;

/** The rank of a saved value: a known level, ABOVE for a newer build's level name, or null (garbled). */
function rank(level: unknown): number | null {
  const i = LEDGER_LEVELS.indexOf(level as LedgerLevel);
  if (i >= 0) return i;
  return typeof level === 'string' && NEWER_LEVEL.test(level) ? LEDGER_LEVELS.length : null;
}

/**
 * effective = min(global, agent, implemented) (F8). `clamped` is true when the saved request (global
 * and agent) is above what this build implements: the caller logs a CLAIM_LEDGER_CLAMP_ROW. A level
 * above the build is clamped DOWN to the implemented level, never to 'off'.
 * Only a non-empty lower-case word that is not a known level (a newer build's level) counts as above
 * every known level. Anything else (null, a number, '', 'Writer', garbage) is garbled: as the global it
 * means 'off', as an agent entry it means "follow the global"; so is a missing value (Jim, 54d96ddb).
 */
export function effectiveLevel(
  global: unknown, agent: unknown, implemented: LedgerLevel = IMPLEMENTED_LEVEL,
): { level: LedgerLevel; clamped: boolean } {
  const g = rank(global) ?? 0;
  const a = rank(agent) ?? g;
  const requested = Math.min(g, a);
  const impl = Math.max(0, LEDGER_LEVELS.indexOf(implemented));
  return requested > impl
    ? { level: LEDGER_LEVELS[impl], clamped: true }
    : { level: LEDGER_LEVELS[requested], clamped: false };
}
