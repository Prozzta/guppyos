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

/** The longest claim text, in characters. Longer text is refused, never cut. */
export const CLAIM_TEXT_MAX = 400;

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
  /** For `rekey` (C2): [the id of the last verified record]. */
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
      legacy?: ClaimRec['legacy'];
    }
  | {
      t: 'event'; ev: 'accept' | 'dismiss' | 'reconcile-answer' | 'revert' | 'pin' | 'unpin'; targets: string[];
      answer?: EventRec['answer'];
    };

export type AppendResult = { ok: true; id: string } | { ok: false; error: string; didYouMean?: string };

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
  itemId: string; agent: string; kind: 'conflict' | 'key-alias';
  a: string; b: string; text: string; leasedAt?: string; leaseTurn?: string; turnsUnanswered: number;
}

/** The API contracts (Â§2 table). Implementations live in their streams. */
export type AppendRecordFn = (agentId: string, draft: RecordDraft) => Promise<AppendResult>;   // W1
export type ReadLedgerFn = (agentId: string) => ReadResult;                                     // W1
export type DeriveFn = (records: LedgerRec[], registry: KeyRegistry, ruleConfig: { r4: boolean }) => ClaimsState;   // W2, pure
export type WorldViewFn = (state: ClaimsState, records: LedgerRec[], usage: UsageRec[], world: WorldInputs) => WorldView;   // W2
export type ChunksForFn = (records: LedgerRec[], state: ClaimsState) => ClaimChunk[];           // W3
export type SearchMode = 'live' | 'history' | 'all';                                            // W3
export type BuildWorkingSetFn = (state: ClaimsState, view: WorldView, budget: number) => { text: string; receipt: Receipt };   // W4
export type RenderMemoryMdFn = (state: ClaimsState, view: WorldView, mode: 'view' | 'complete') => string;   // W4
export type RenderExportLineFn = (rec: LedgerRec, state: ClaimsState) => string;                // W4
export type ReconcileItemsFn = (agentId: string, n: number /* <= 3 */) => ReconcileItem[];       // W5, leased
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

function rank(level: unknown): number {
  const i = LEDGER_LEVELS.indexOf(level as LedgerLevel);
  return i < 0 ? -1 : i;
}

/**
 * effective = min(global, agent, implemented) (F8). `clamped` is true when the saved request (global
 * and agent) is above what this build implements: the caller logs a CLAIM_LEDGER_CLAMP_ROW. A level
 * above the build is clamped DOWN to the implemented level, never to 'off'. An unknown saved value
 * (a newer build's level) counts as above every known level; a missing agent entry follows the global.
 */
export function effectiveLevel(
  global: unknown, agent: unknown, implemented: LedgerLevel = IMPLEMENTED_LEVEL,
): { level: LedgerLevel; clamped: boolean } {
  const g = global === undefined ? 0 : rank(global) < 0 ? LEDGER_LEVELS.length : rank(global);
  const a = agent === undefined ? g : rank(agent) < 0 ? LEDGER_LEVELS.length : rank(agent);
  const requested = Math.min(g, a);
  const impl = rank(implemented);
  return requested > impl
    ? { level: LEDGER_LEVELS[impl], clamped: true }
    : { level: LEDGER_LEVELS[requested], clamped: false };
}
