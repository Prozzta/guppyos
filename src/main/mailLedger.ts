/**
 * ZT-I1-MAIL (1.1.75): the harness-owned, per-agent MAIL LEDGER.
 *
 * Before 1.1.75 "a file in inbox/" MEANT "unhandled", and only agents moved files to .done.
 * The ledger replaces that file-position contract with explicit states the harness owns
 * (INBOX-DESIGN.md §1, §11):
 *
 *   delivered  --claimSurfacing-->  surfacing  --confirmSurfaced-->  surfaced  --closeEpoch(normal)-->  acted
 *       ^                               |                               |
 *       +------- closeEpoch(abnormal) / unconfirmed at a normal close --+   (back-edge, "re-delivered")
 *
 * plus two tracking fields that never change the state: `repliedAt` (requires_reply, §4.3) and
 * the Human's option B (§11.13): every act:"request" stays "awaiting outcome" until the recipient
 * routes a message whose in_reply_to matches its id or its sender_id alias.
 *
 * Layout: the PURE layer (`applyX` / queries / `rebuildLedger` / `classifyIncoming`) takes a
 * document and a clock value and returns the next document plus its effects (log rows, events,
 * files to archive). It does no I/O. `MailLedger` is the I/O shell: lazy load, corrupt-file
 * rebuild, coalesced atomic writes (≤ 1 per 250 ms per agent), the harness `.done` rename with
 * retry, and subscriptions. Every timer and the clock are injectable (tests F4/F11 need a
 * simulated clock).
 *
 * Log budget (#44/#48): a message costs at most four `kind:"mail"` rows on its normal path:
 * `delivered`, `surfaced`, `acted`, `replied`. The tentative `surfacing` step writes no row. A
 * back-edge (`redelivered`) is an at-least-once anomaly and adds one row per occurrence.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { atomicWriteJson, renameWithRetry } from './atomicJson';

// ————————————————————————————————————————————————————————————————— ids (§4.1)

/** §4.1: the only ids the router writes to disk. */
export const MAIL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Windows device names are unopenable as files whatever their extension ("CON.json"). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Is `id` safe to use as `<inbox>/<id>.json`? The regex already excludes separators, a leading
 * dot (`.done`, `.undelivered`) and anything over 128 characters. On top of it: `..` anywhere,
 * temp-file shapes (`*.tmp`, the atomic writer's `*.tmp-xxxxxx`), a trailing dot (Windows strips
 * it) and Windows device names.
 */
export function isValidMailId(id: unknown): id is string {
  if (typeof id !== 'string' || !MAIL_ID_RE.test(id)) return false;
  if (id.includes('..') || id.endsWith('.')) return false;
  if (/\.tmp$/i.test(id) || /\.tmp-/i.test(id)) return false;
  if (WINDOWS_RESERVED_RE.test(id)) return false;
  return true;
}

/** A fresh `<ts>-<rand>` id (the router's own id shape). */
export function freshMailId(now: number = Date.now()): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

/** The body fingerprint (sha256 of the body). */
export function mailBodyHash(body: unknown): string {
  return createHash('sha256').update(typeof body === 'string' ? body : JSON.stringify(body ?? '')).digest('hex');
}

/**
 * The §4.1 duplicate key (god's ruling, INBOX-DESIGN §11.18 #3): `from` + hash(subject + body).
 * A resend with a different subject is a different message (fresh id, sender_id kept). The
 * subject is length-framed, so no subject/body split can collide with another.
 */
export function mailContentHash(subject: unknown, body: unknown): string {
  const sub = typeof subject === 'string' ? subject : String(subject ?? '');
  const b = typeof body === 'string' ? body : (JSON.stringify(body ?? '') ?? '');
  return createHash('sha256').update(`${sub.length}:${sub}\n${b}`).digest('hex');
}

/** The keep-the-sender's-value rule for `sender_id`: a string, bounded. */
function senderIdValue(raw: unknown): string {
  return (typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw)).slice(0, 200);
}

// ————————————————————————————————————————————————————————————————— model

export type MailState = 'delivered' | 'surfacing' | 'surfaced' | 'acted';
/** `inbox`: written by deliver(). `work-order`: a terminal work order (proxy/hookless, N2): no
 *  inbox file, acted on the confirmed PTY write, never in the backlog. */
export type MailVia = 'inbox' | 'work-order';
/** The `stage` of a `kind:"mail"` log row. */
export type MailStage = 'delivered' | 'surfaced' | 'acted' | 'replied' | 'redelivered';
/** How a surfacing was confirmed (§11.1, N1). */
export type MailConfirmMethod = 'evidence' | 'latency' | 'latency-fallback';

/** The message fields the ledger needs (a HiveMessage satisfies it). */
export interface MailMessageLike {
  id: string;
  from: string;
  act?: string;
  subject?: string;
  body?: unknown;
  conversation?: string;
  in_reply_to?: string | null;
  supersedes?: string[];
  requires_reply?: boolean;
  sender_id?: string;
}

export interface MailEntry {
  /** The ledger id: the inbox file stem. Never taken as a sort key (#18); `seq` orders. */
  id: string;
  /** §4.1: the sender's id when the harness reassigned it. Replies resolve against either. */
  senderId?: string;
  from: string;
  act: string;
  subject: string;
  conversation?: string;
  inReplyTo?: string | null;
  supersedes?: string[];
  /** sha256 of the body; null for a work order confirmed after a restart (Q14: body unknown). */
  bodyHash: string | null;
  /** The §4.1 duplicate key, hash(subject + body) (§11.18 #3). Null when the body is unknown. */
  contentHash?: string | null;
  /** Q14: a work order whose confirmation arrived after a restart (header fields only). */
  restored?: boolean;
  via: MailVia;
  state: MailState;
  /** Arrival order within this ledger. */
  seq: number;
  deliveredAt: number;
  /** The open surfacing epoch (turn id or harness turn counter) while surfacing/surfaced. */
  epoch?: string | null;
  hookKind?: string | null;
  surfacingAt?: number | null;
  /** Last CONFIRMED surfacing (kept after a back-edge: it is history, not state). */
  surfacedAt?: number | null;
  confirmMethod?: MailConfirmMethod | null;
  actedAt?: number | null;
  /** How often the body was put into a hook response. */
  surfaceCount: number;
  /** N1: consecutive surfacings that reached a normal close unconfirmed. Reset on confirm. */
  unconfirmedSurfacings: number;
  /** Set by a back-edge; the next surfacing carries the "re-delivered" marker. Cleared on confirm. */
  redelivered: boolean;
  /** §7.1: delivered before 1.1.75 (or with no ledger evidence); marker until first confirmed. */
  legacy: boolean;
  requiresReply: boolean;
  repliedAt?: number | null;
  replyId?: string | null;
  /** §11.18 #1: an open obligation explicitly closed without a reply (closeObligation). */
  closedAt?: number | null;
  closeReason?: string | null;
  updatedAt: number;
}

export interface MailLedgerDoc {
  version: 1;
  agentId: string;
  nextSeq: number;
  /** Reader #10: the last transition caused by agents or senders, never by harness bookkeeping
   *  (archive renames, back-edges, pruning, rebuilds, migration). */
  lastActivityAt: number | null;
  /** Reader #11: the last `acted` transition (agent turn completed with the mail seen). */
  lastActedAt: number | null;
  entries: Record<string, MailEntry>;
  /** §2.2/§11.9/§11.10: a per-agent override of the provider's default mail channel (slice 3
   *  degradation writes it; absent or null = the provider default). */
  channel?: MailChannelOverride | null;
}

/** A per-agent channel override. Only degradation to legacy-read exists today (§11.10). */
export interface MailChannelOverride {
  mode: 'legacy-read';
  reason: string;
  since: number;
}

export interface MailEvent {
  agentId: string;
  id: string;
  /** The transition. `surfacing` has no log row but is still an event. */
  stage: MailStage | 'surfacing' | 'closed';
  state: MailState;
  at: number;
  /** True for a harness-caused change (a back-edge); readers of "activity" ignore these. */
  harness: boolean;
  reason?: string;
  entry: MailEntry;
}

export interface MailStep {
  doc: MailLedgerDoc;
  /** Ids whose entry changed. Empty = the call was a no-op (idempotent duplicate). */
  changed: string[];
  logs: Record<string, unknown>[];
  events: MailEvent[];
  /** Ids that just became acted and whose inbox file the harness must move to .done. */
  archive: string[];
}

export const MAIL_LEDGER_VERSION = 1;
export const MAIL_WRITE_COALESCE_MS = 250;
/** §1.2: acted entries are pruned after 7 days; .done stays the history. An open obligation is
 *  never pruned until it is replied to or explicitly closed (§11.18 #1). */
export const MAIL_ACTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** N1: after this many consecutive unconfirmed surfacings, confirm on the latency rule alone. */
export const MAIL_UNCONFIRMED_FALLBACK_AFTER = 2;
/** §1.1/§11.4: the last-resort idle-gated back-edge for an epoch with no Stop. */
export const MAIL_STALE_EPOCH_MS = 30 * 60 * 1000;
const SUBJECT_MAX = 200;
const MESSAGE_FILE_MAX_BYTES = 1024 * 1024;

export function emptyLedger(agentId: string): MailLedgerDoc {
  return { version: MAIL_LEDGER_VERSION, agentId, nextSeq: 1, lastActivityAt: null, lastActedAt: null, entries: {} };
}

// ————————————————————————————————————————————————————————————————— pure transitions

class Draft {
  readonly doc: MailLedgerDoc;
  readonly changed: string[] = [];
  readonly logs: Record<string, unknown>[] = [];
  readonly events: MailEvent[] = [];
  readonly archive: string[] = [];
  constructor(prev: MailLedgerDoc, readonly now: number) {
    this.doc = { ...prev, entries: { ...prev.entries } };
  }
  put(entry: MailEntry): void {
    this.doc.entries[entry.id] = entry;
    if (!this.changed.includes(entry.id)) this.changed.push(entry.id);
  }
  event(entry: MailEntry, stage: MailEvent['stage'], harness: boolean, reason?: string): void {
    this.events.push({ agentId: this.doc.agentId, id: entry.id, stage, state: entry.state, at: this.now, harness, ...(reason ? { reason } : {}), entry });
    if (!harness) this.doc.lastActivityAt = this.now;
  }
  row(row: Record<string, unknown>): void {
    this.logs.push({ agentId: this.doc.agentId, ...row });
  }
  step(): MailStep {
    return { doc: this.doc, changed: this.changed, logs: this.logs, events: this.events, archive: this.archive };
  }
}

function unchanged(doc: MailLedgerDoc): MailStep {
  return { doc, changed: [], logs: [], events: [], archive: [] };
}

function entryFromMessage(msg: MailMessageLike, seq: number, now: number, via: MailVia, legacy: boolean): MailEntry {
  const act = typeof msg.act === 'string' ? msg.act : 'inform';
  return {
    id: msg.id,
    ...(msg.sender_id ? { senderId: senderIdValue(msg.sender_id) } : {}),
    from: String(msg.from ?? '?'),
    act,
    subject: String(msg.subject ?? '').slice(0, SUBJECT_MAX),
    ...(typeof msg.conversation === 'string' ? { conversation: msg.conversation } : {}),
    inReplyTo: typeof msg.in_reply_to === 'string' ? msg.in_reply_to : null,
    ...(Array.isArray(msg.supersedes) && msg.supersedes.length ? { supersedes: msg.supersedes.filter((s) => typeof s === 'string').slice(0, 10) } : {}),
    bodyHash: mailBodyHash(msg.body ?? ''),
    contentHash: mailContentHash(msg.subject ?? '', msg.body ?? ''),
    via,
    state: via === 'work-order' ? 'acted' : 'delivered',
    seq,
    deliveredAt: now,
    surfaceCount: 0,
    unconfirmedSurfacings: 0,
    redelivered: false,
    legacy,
    requiresReply: typeof msg.requires_reply === 'boolean' ? msg.requires_reply : ['request', 'query', 'propose'].includes(act),
    updatedAt: now
  };
}

/** Is this entry an obligation the reply tracker follows (§4.3 + option B)? */
function replyTracked(e: MailEntry): boolean {
  return e.requiresReply || e.act === 'request';
}

/** §11.18 #1: an obligation still open (tracked, not replied, not explicitly closed). */
export function isOpenObligation(e: MailEntry): boolean {
  return replyTracked(e) && !e.repliedAt && !e.closedAt;
}

/**
 * `delivered`: the router's durable inbox write succeeded. Idempotent: an id already in the
 * ledger is left alone (the caller's duplicate test runs before the write, see classifyIncoming).
 * `opts.harness` marks a recovery/migration import (no activity, no per-message row).
 */
export function applyDelivered(doc: MailLedgerDoc, msg: MailMessageLike, now: number, opts: { legacy?: boolean; harness?: boolean; reason?: string } = {}): MailStep {
  if (doc.entries[msg.id]) return unchanged(doc);
  const d = new Draft(doc, now);
  const entry = entryFromMessage(msg, doc.nextSeq, now, 'inbox', opts.legacy === true);
  d.doc.nextSeq = doc.nextSeq + 1;
  d.put(entry);
  if (!opts.harness || opts.reason) {
    d.row({
      kind: 'mail', stage: 'delivered', id: entry.id, from: entry.from, act: entry.act, requiresReply: entry.requiresReply,
      ...(entry.senderId ? { senderId: entry.senderId } : {}),
      ...(entry.legacy ? { legacy: true } : {}),
      ...(opts.reason ? { reason: opts.reason } : {})
    });
  }
  d.event(entry, 'delivered', opts.harness === true, opts.reason);
  return d.step();
}

/**
 * N2: a terminal work order (proxy/hookless) is acted on its confirmed PTY write: the whole body
 * is in the typed text. Recorded as acted `via:"work-order"`; never in the backlog; no file.
 */
export function applyWorkOrder(doc: MailLedgerDoc, msg: MailMessageLike, now: number, opts: { restored?: boolean } = {}): MailStep {
  if (doc.entries[msg.id]) return unchanged(doc);
  const d = new Draft(doc, now);
  const base = entryFromMessage(msg, doc.nextSeq, now, 'work-order', false);
  // Q14: confirmed after a restart, the body is unknown: no hash (it can never match a duplicate).
  const entry: MailEntry = {
    ...base, actedAt: now, surfaceCount: 1, surfacedAt: now, hookKind: 'work-order',
    ...(opts.restored ? { restored: true, bodyHash: null, contentHash: null } : {})
  };
  d.doc.nextSeq = doc.nextSeq + 1;
  d.put(entry);
  d.row({ kind: 'mail', stage: 'acted', ids: [entry.id], via: 'work-order', from: entry.from, act: entry.act, requiresReply: entry.requiresReply, ...(entry.senderId ? { senderId: entry.senderId } : {}), ...(opts.restored ? { restored: true } : {}) });
  d.event(entry, 'acted', false, 'work-order');
  return d.step();
}

/**
 * The harness returned a hook response whose mail block holds these ids: `delivered → surfacing`
 * (tentative, §11.1), bound to `epoch`. Returns the ids actually claimed in `changed`.
 *  - an id already surfacing/surfaced in the SAME epoch is a no-op (N3: dedup by id per epoch);
 *  - an id open in a DIFFERENT epoch is not claimable until that epoch closes;
 *  - acted or unknown ids are ignored.
 * No log row (the budget row is `surfaced`).
 */
export function applyClaimSurfacing(doc: MailLedgerDoc, ids: Iterable<string>, epoch: string, hookKind: string, now: number): MailStep {
  const d = new Draft(doc, now);
  for (const id of ids) {
    const e = d.doc.entries[id];
    if (!e || e.state !== 'delivered') continue;
    const next: MailEntry = { ...e, state: 'surfacing', epoch, hookKind, surfacingAt: now, surfaceCount: e.surfaceCount + 1, updatedAt: now };
    d.put(next);
    d.event(next, 'surfacing', false);
  }
  return d.step();
}

/** Deterministic evidence (or the latency rule) confirmed the body reached the model:
 *  `surfacing → surfaced`, only for the matching epoch. */
export function applyConfirmSurfaced(doc: MailLedgerDoc, ids: Iterable<string>, epoch: string, method: MailConfirmMethod, now: number): MailStep {
  const d = new Draft(doc, now);
  const done: string[] = [];
  for (const id of ids) {
    const e = d.doc.entries[id];
    if (!e || e.state !== 'surfacing' || e.epoch !== epoch) continue;
    const next: MailEntry = { ...e, state: 'surfaced', surfacedAt: now, confirmMethod: method, unconfirmedSurfacings: 0, redelivered: false, updatedAt: now };
    d.put(next);
    d.event(next, 'surfaced', false, method);
    done.push(id);
  }
  if (done.length) d.row({ kind: 'mail', stage: 'surfaced', ids: done, epoch, method, hookKind: d.doc.entries[done[0]].hookKind ?? null });
  return d.step();
}

/**
 * `surfaced → acted` for the ids whose epoch matches (the Stop that closes the surfacing epoch).
 * Anything else (another epoch, still tentative, already acted) is left alone.
 */
export function applyMarkActed(doc: MailLedgerDoc, ids: Iterable<string>, epoch: string, now: number): MailStep {
  const d = new Draft(doc, now);
  const done: string[] = [];
  for (const id of ids) {
    const e = d.doc.entries[id];
    if (!e || e.state !== 'surfaced' || e.epoch !== epoch) continue;
    const next: MailEntry = { ...e, state: 'acted', actedAt: now, updatedAt: now };
    d.put(next);
    d.event(next, 'acted', false);
    done.push(id);
    if (next.via === 'inbox') d.archive.push(id);
  }
  if (done.length) {
    d.doc.lastActedAt = now;
    d.row({ kind: 'mail', stage: 'acted', ids: done, epoch });
  }
  return d.step();
}

/**
 * §11.5 compaction re-inject: ids still open in `epoch` (surfaced, or still tentative) were put
 * into the context again (SessionStart `compact`): back to `surfacing` in the SAME epoch, with
 * `surfaceCount++`. The re-injection is itself a surfacing step, confirmed as in §11.1; a normal
 * close with no confirmation re-pends it like any other. No row (the `surfaced` row is the budget).
 */
export function applyReinject(doc: MailLedgerDoc, ids: Iterable<string>, epoch: string, hookKind: string, now: number): MailStep {
  const d = new Draft(doc, now);
  for (const id of ids) {
    const e = d.doc.entries[id];
    if (!e || e.epoch !== epoch || (e.state !== 'surfaced' && e.state !== 'surfacing')) continue;
    const next: MailEntry = { ...e, state: 'surfacing', hookKind, surfacingAt: now, surfaceCount: e.surfaceCount + 1, updatedAt: now };
    d.put(next);
    d.event(next, 'surfacing', false, 'reinject');
  }
  return d.step();
}

/** Open ids (surfacing / surfaced) back to `delivered` with the marker, one row (`reason`):
 *  e.g. a compaction re-inject that did not fit the budget, so the body drips in again. */
export function applyRedeliver(doc: MailLedgerDoc, ids: Iterable<string>, reason: string, now: number): MailStep {
  const want = new Set(ids);
  const open = Object.values(doc.entries).filter((e) => want.has(e.id) && (e.state === 'surfacing' || e.state === 'surfaced')).sort(bySeq);
  if (!open.length) return unchanged(doc);
  const d = new Draft(doc, now);
  backEdge(d, open, reason, false);
  return d.step();
}

/**
 * Acted WITHOUT a surfacing, for the channels where the harness does not put the body in context:
 *  - `legacy-read` (§2.2, §11.9, §11.10): hook-capable agents that read the files themselves; the
 *    ids the harness named to them (the wake's ids, the mid-turn notice) become acted at the Stop
 *    of that turn, and the harness archives the files;
 *  - `legacy-move` (§11.7, cursor): no Stop signal, 1.1.74 semantics: the AGENT moved the file,
 *    and for that agent only, file position means handled (`reason:"agent-moved"`). Never idle.
 * Only `delivered` inbox entries move. One row per call.
 */
export function applyLegacyActed(doc: MailLedgerDoc, ids: Iterable<string>, mode: 'legacy-read' | 'legacy-move', now: number, opts: { epoch?: string | null; reason?: string } = {}): MailStep {
  const d = new Draft(doc, now);
  const done: string[] = [];
  for (const id of ids) {
    const e = d.doc.entries[id];
    if (!e || e.state !== 'delivered' || e.via !== 'inbox' || done.includes(id)) continue;
    const next: MailEntry = { ...e, state: 'acted', actedAt: now, updatedAt: now, epoch: null, hookKind: null, surfacingAt: null };
    d.put(next);
    d.event(next, 'acted', false, opts.reason ?? mode);
    done.push(id);
    d.archive.push(id);
  }
  if (done.length) {
    d.doc.lastActedAt = now;
    d.row({ kind: 'mail', stage: 'acted', ids: done, mode, ...(opts.epoch ? { epoch: opts.epoch } : {}), ...(opts.reason ? { reason: opts.reason } : {}) });
  }
  return d.step();
}

function backEdge(d: Draft, entries: MailEntry[], reason: string, countUnconfirmed: boolean, kind = 'mail', epoch?: string | null, extra: Record<string, unknown> = {}): void {
  const ids: string[] = [];
  for (const e of entries) {
    const next: MailEntry = {
      ...e, state: 'delivered', epoch: null, hookKind: null, surfacingAt: null, redelivered: true,
      unconfirmedSurfacings: countUnconfirmed ? e.unconfirmedSurfacings + 1 : e.unconfirmedSurfacings,
      updatedAt: d.now
    };
    d.put(next);
    d.event(next, 'redelivered', true, reason);
    ids.push(e.id);
  }
  if (ids.length) d.row({ kind, stage: 'redelivered', reason, ids, ...(epoch !== undefined ? { epoch } : {}), ...extra });
}

/** Q8: how a late response left the harness (the `mail-surface-late` row names both). */
export interface MailLateDetail { transport: string | null; latencyMs: number | null }

export type EpochOutcome = 'normal' | 'abnormal';

/**
 * Close a surfacing epoch.
 *  - normal (its Stop): surfaced → acted (and archived); a still-tentative `surfacing` id goes
 *    back to delivered with the marker (§11.1), counted toward N1, logged as
 *    `mail-surface-unconfirmed`, or `mail-surface-late` for ids in `opts.late`.
 *  - abnormal (PTY exit/respawn, quit/restart, submit-unconfirmed, StopFailure, the next UPS
 *    after an interrupt, the 30-min stale backstop): surfacing and surfaced → delivered with the
 *    marker (`kind:"mail"`, `stage:"redelivered"`, `reason`).
 * Idempotent: a second close of the same epoch finds nothing open.
 */
export function applyCloseEpoch(doc: MailLedgerDoc, epoch: string, outcome: EpochOutcome, now: number, opts: { reason?: string; late?: Iterable<string>; lateDetail?: Record<string, MailLateDetail> } = {}): MailStep {
  const open = Object.values(doc.entries).filter((e) => e.epoch === epoch && (e.state === 'surfacing' || e.state === 'surfaced')).sort(bySeq);
  if (!open.length) return unchanged(doc);
  if (outcome === 'abnormal') {
    const d = new Draft(doc, now);
    backEdge(d, open, opts.reason ?? 'abnormal', false, 'mail', epoch);
    return d.step();
  }
  const acted = applyMarkActed(doc, open.filter((e) => e.state === 'surfaced').map((e) => e.id), epoch, now);
  const d = new Draft(acted.doc, now);
  d.changed.push(...acted.changed);
  d.logs.push(...acted.logs);
  d.events.push(...acted.events);
  d.archive.push(...acted.archive);
  const late = new Set(opts.late ?? []);
  const tentative = open.filter((e) => e.state === 'surfacing');
  backEdge(d, tentative.filter((e) => !late.has(e.id)).map((e) => d.doc.entries[e.id]), 'unconfirmed', true, 'mail-surface-unconfirmed', epoch);
  // Q8: one `mail-surface-late` row per distinct (transport, elapsed ms), so each row names both.
  const groups = new Map<string, { detail: MailLateDetail | null; entries: MailEntry[] }>();
  for (const e of tentative.filter((x) => late.has(x.id))) {
    const detail = opts.lateDetail?.[e.id] ?? null;
    const key = detail ? `${detail.transport}|${detail.latencyMs}` : '-';
    const g = groups.get(key) ?? { detail, entries: [] };
    g.entries.push(d.doc.entries[e.id]);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    backEdge(d, g.entries, 'late', true, 'mail-surface-late', epoch, g.detail ? { transport: g.detail.transport, latencyMs: g.detail.latencyMs } : {});
  }
  return d.step();
}

/**
 * Reply tracking (§4.3 + option B): `agentId` (the ledger owner) routed a message with
 * `in_reply_to = ref` to `replyTo`. `ref` resolves against the ledger id AND the sender_id alias
 * (§4.1), so it can name more than one entry. Exactly one open obligation is closed: among the
 * reply-tracked, not-yet-replied candidates (requires_reply, or act:"request"), the one whose
 * sender is the reply's recipient; else the exact id; else the oldest alias match. The state is
 * not changed. Idempotent.
 */
export function applyReplied(doc: MailLedgerDoc, ref: string, replyId: string, now: number, replyTo?: string | null): MailStep {
  const exact = doc.entries[ref];
  const candidates = [...(exact ? [exact] : []), ...Object.values(doc.entries).filter((e) => e.senderId === ref && e.id !== ref).sort(bySeq)]
    .filter((e) => isOpenObligation(e));
  const e = (replyTo ? candidates.find((c) => c.from === replyTo) : undefined) ?? candidates[0];
  if (!e) return unchanged(doc);
  const d = new Draft(doc, now);
  const next: MailEntry = { ...e, repliedAt: now, replyId, updatedAt: now };
  d.put(next);
  d.row({ kind: 'mail', stage: 'replied', id: e.id, replyId });
  d.event(next, 'replied', false);
  return d.step();
}

/**
 * §11.18 #1: close an open obligation WITHOUT a reply: the explicit close the prune exemption
 * names (the Human or god decides a request needs no answer). `ref` resolves like a reply (the
 * exact id, else sender_id aliases), and the oldest open match is closed. The state is not
 * changed; the entry becomes prunable. Idempotent. Not activity: no agent turn did it.
 */
export function applyCloseObligation(doc: MailLedgerDoc, ref: string, now: number, reason: string): MailStep {
  const e = resolveEntries(doc, ref).find((c) => isOpenObligation(c));
  if (!e) return unchanged(doc);
  const d = new Draft(doc, now);
  const why = String(reason || 'closed').slice(0, 200);
  const next: MailEntry = { ...e, closedAt: now, closeReason: why, updatedAt: now };
  d.put(next);
  d.row({ kind: 'mail-obligation-closed', id: e.id, reason: why });
  d.event(next, 'closed', true, why);
  return d.step();
}

/** §1.1 "app quit or restart with the epoch still open": every open epoch closes abnormally. */
export function applyRestartRecovery(doc: MailLedgerDoc, now: number): MailStep {
  const open = Object.values(doc.entries).filter((e) => e.state === 'surfacing' || e.state === 'surfaced').sort(bySeq);
  if (!open.length) return unchanged(doc);
  const d = new Draft(doc, now);
  backEdge(d, open, 'restart', false);
  return d.step();
}

/** §1.2: acted entries older than the retention are dropped (no row: .done is the history).
 *  §11.18 #1: an open obligation (act:request awaiting its outcome, or requires_reply not replied)
 *  is NEVER pruned, however old, until it is replied to or explicitly closed; the retention then
 *  runs from the reply or the close. */
export function applyPrune(doc: MailLedgerDoc, now: number, retentionMs = MAIL_ACTED_RETENTION_MS): MailStep {
  const stale = Object.values(doc.entries).filter((e) => e.state === 'acted' && !isOpenObligation(e)
    && Math.max(e.actedAt ?? e.updatedAt, e.repliedAt ?? 0, e.closedAt ?? 0) < now - retentionMs);
  if (!stale.length) return unchanged(doc);
  const d = new Draft(doc, now);
  for (const e of stale) delete d.doc.entries[e.id];
  d.changed.push(...stale.map((e) => e.id));
  return d.step();
}

/** Set (or clear, with null) the agent's channel override. Idempotent; no log row (the caller
 *  logs the reason, e.g. `mail-channel-degraded`). A harness change: not activity. */
export function applyChannelOverride(doc: MailLedgerDoc, override: MailChannelOverride | null): MailStep {
  const cur = doc.channel ?? null;
  if ((cur === null && override === null) || (cur && override && cur.mode === override.mode && cur.reason === override.reason)) return unchanged(doc);
  const next: MailLedgerDoc = { ...doc, channel: override };
  // `changed` names no entry; a sentinel keeps the shell's "anything changed?" test honest.
  return { doc: next, changed: ['#channel'], logs: [], events: [], archive: [] };
}

// ————————————————————————————————————————————————————————————————— pure queries

function bySeq(a: MailEntry, b: MailEntry): number {
  return a.seq - b.seq || a.deliveredAt - b.deliveredAt;
}

/** The entries a reference names: the exact id first, else every sender_id alias match. */
export function resolveEntries(doc: MailLedgerDoc, ref: string): MailEntry[] {
  const exact = doc.entries[ref];
  if (exact) return [exact];
  return Object.values(doc.entries).filter((e) => e.senderId === ref).sort(bySeq);
}

/** `ref` plus every id/sender_id it is an alias of in this ledger (§4.1 "resolve against either"). */
export function aliasesIn(doc: MailLedgerDoc, ref: string): string[] {
  const out = new Set<string>([ref]);
  for (const e of resolveEntries(doc, ref)) {
    out.add(e.id);
    if (e.senderId) out.add(e.senderId);
  }
  return [...out];
}

/** Coordinator pending: `delivered`, arrival order. */
export function pendingEntries(doc: MailLedgerDoc): MailEntry[] {
  return Object.values(doc.entries).filter((e) => e.state === 'delivered').sort(bySeq);
}

/** fleet `inboxBacklog` (§3 #6): not acted. Work orders are acted by definition (N2). */
export function backlogEntries(doc: MailLedgerDoc): MailEntry[] {
  return Object.values(doc.entries).filter((e) => e.state !== 'acted').sort(bySeq);
}

export interface MailObligation { entry: MailEntry; ageMs: number }

/** §4.3 `awaitingReply`: acted, requires_reply, not replied; age since delivery. */
export function awaitingReplyEntries(doc: MailLedgerDoc, now: number): MailObligation[] {
  return Object.values(doc.entries)
    .filter((e) => e.state === 'acted' && e.requiresReply && !e.repliedAt && !e.closedAt)
    .sort(bySeq)
    .map((entry) => ({ entry, ageMs: Math.max(0, now - entry.deliveredAt) }));
}

/** §11.13 option B: every act:"request" awaits its outcome until a matching reply is routed,
 *  whatever its delivery state. */
export function openRequestEntries(doc: MailLedgerDoc, now: number): MailObligation[] {
  return Object.values(doc.entries)
    .filter((e) => e.act === 'request' && !e.repliedAt && !e.closedAt)
    .sort(bySeq)
    .map((entry) => ({ entry, ageMs: Math.max(0, now - entry.deliveredAt) }));
}

export interface OpenEpoch { epoch: string; since: number; ids: string[] }

/** Every epoch with surfacing/surfaced ids, oldest first (`since` = its earliest surfacing). The
 *  caller applies the idle gate and MAIL_STALE_EPOCH_MS for the §1.1 backstop. */
export function openEpochsOf(doc: MailLedgerDoc): OpenEpoch[] {
  const by = new Map<string, OpenEpoch>();
  for (const e of Object.values(doc.entries).sort(bySeq)) {
    if ((e.state !== 'surfacing' && e.state !== 'surfaced') || !e.epoch) continue;
    const cur = by.get(e.epoch) ?? { epoch: e.epoch, since: e.surfacingAt ?? e.updatedAt, ids: [] };
    cur.since = Math.min(cur.since, e.surfacingAt ?? e.updatedAt);
    cur.ids.push(e.id);
    by.set(e.epoch, cur);
  }
  return [...by.values()].sort((a, b) => a.since - b.since);
}

// ————————————————————————————————————————————————————————————————— pure id admission (§4.1)

export type ExistingMessage = { from: unknown; subject?: unknown; body: unknown } | 'unreadable' | null;
export type IncomingClass = { kind: 'free' } | { kind: 'dup'; existingId: string } | { kind: 'conflict'; reason: string };

/**
 * Collision test of an incoming id against the recipient's ledger (id and sender_id alias),
 * then `inbox/` and `.done/` (via `readExisting`, which returns the stored message, null when
 * there is no such file, or 'unreadable'). The duplicate key is the same `from` + the same
 * hash(subject + body) (§11.18 #3): a resend with another subject is a different message. Any
 * other collision, including an unreadable file, is a conflict (the caller reassigns).
 */
export function classifyIncoming(doc: MailLedgerDoc, msg: MailMessageLike, readExisting: (id: string) => ExistingMessage): IncomingClass {
  const content = mailContentHash(msg.subject ?? '', msg.body ?? '');
  const inLedger = [doc.entries[msg.id], ...Object.values(doc.entries).filter((e) => e.senderId === msg.id && e.id !== msg.id)].filter(Boolean) as MailEntry[];
  for (const e of inLedger) {
    // No content key (a restored work order, whose body is unknown): never a duplicate.
    if (e.from === msg.from && typeof e.contentHash === 'string' && e.contentHash === content) return { kind: 'dup', existingId: e.id };
  }
  if (inLedger.length) return { kind: 'conflict', reason: 'ledger' };
  const found = readExisting(msg.id);
  if (found === null) return { kind: 'free' };
  if (found === 'unreadable') return { kind: 'conflict', reason: 'unreadable' };
  if (String(found.from) === msg.from && mailContentHash(found.subject ?? '', found.body ?? '') === content) return { kind: 'dup', existingId: msg.id };
  return { kind: 'conflict', reason: 'file' };
}

// ————————————————————————————————————————————————————————————————— pure rebuild / migration

/** One message file as found on disk (`msg` null when it did not parse). */
export interface DiskMessage { id: string; msg: Partial<MailMessageLike> | null; mtimeMs: number }

function diskEntryMessage(f: DiskMessage): MailMessageLike {
  const m = f.msg ?? {};
  return {
    id: f.id,
    from: typeof m.from === 'string' ? m.from : '?',
    act: typeof m.act === 'string' ? m.act : undefined,
    subject: typeof m.subject === 'string' ? m.subject : '',
    body: m.body ?? '',
    conversation: typeof m.conversation === 'string' ? m.conversation : undefined,
    in_reply_to: typeof m.in_reply_to === 'string' ? m.in_reply_to : null,
    supersedes: Array.isArray(m.supersedes) ? m.supersedes : undefined,
    requires_reply: typeof m.requires_reply === 'boolean' ? m.requires_reply : undefined,
    sender_id: typeof m.sender_id === 'string' ? m.sender_id : undefined
  };
}

/** §7.1 step 1: the first ledger of an agent is built from `inbox/*.json`, every file
 *  `delivered` with `legacy:true`. `.done` is history and is not imported. */
export function migrateFromInbox(agentId: string, inbox: DiskMessage[], now: number): MailLedgerDoc {
  let doc = emptyLedger(agentId);
  for (const f of [...inbox].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1))) {
    doc = applyDelivered(doc, diskEntryMessage(f), now, { legacy: true, harness: true }).doc;
    doc.entries[f.id] = { ...doc.entries[f.id], deliveredAt: Math.min(now, f.mtimeMs || now) };
  }
  return doc;
}

interface LogEvidence {
  surfaced: boolean;
  delivered?: Record<string, unknown>;
  workOrder?: Record<string, unknown> & { ts?: number };
  replied?: { at: number; replyId: string | null };
  lastTs: number;
}

/**
 * The §1.2 conservative rebuild of a corrupt ledger, from the mail log rows plus the filesystem.
 * Never empty when evidence exists:
 *  - every `inbox/*.json` → `delivered` (a message the log shows surfaced gets the re-delivered
 *    marker; one with no delivered row in the log gets the legacy marker: we cannot prove it
 *    was not handled);
 *  - every `.done/*.json` inside the retention → `acted` (actedAt = file mtime);
 *  - work-order `acted` rows inside the retention → acted via work-order;
 *  - `replied` rows restore reply tracking.
 */
export function rebuildLedger(agentId: string, input: { inbox: DiskMessage[]; done: DiskMessage[]; logRows: unknown[] }, now: number, retentionMs = MAIL_ACTED_RETENTION_MS): MailLedgerDoc {
  const ev = new Map<string, LogEvidence>();
  const get = (id: string): LogEvidence => {
    let e = ev.get(id);
    if (!e) { e = { surfaced: false, lastTs: 0 }; ev.set(id, e); }
    return e;
  };
  for (const raw of input.logRows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r.agentId !== agentId || typeof r.kind !== 'string' || !(r.kind === 'mail' || r.kind.startsWith('mail-'))) continue;
    const ids = Array.isArray(r.ids) ? r.ids.filter((x): x is string => typeof x === 'string') : typeof r.id === 'string' ? [r.id] : [];
    const ts = typeof r.ts === 'number' ? r.ts : 0;
    for (const id of ids) {
      const e = get(id);
      e.lastTs = Math.max(e.lastTs, ts);
      if (r.stage === 'delivered') e.delivered = r;
      else if (r.stage === 'surfaced' || r.stage === 'redelivered') e.surfaced = true;
      else if (r.stage === 'acted' && r.via === 'work-order') e.workOrder = { ...r, ts };
      else if (r.stage === 'replied') e.replied = { at: ts || now, replyId: typeof r.replyId === 'string' ? r.replyId : null };
    }
  }
  let doc = emptyLedger(agentId);
  const inboxIds = new Set(input.inbox.map((f) => f.id));
  const put = (entry: MailEntry): void => { doc.entries[entry.id] = entry; doc.nextSeq = Math.max(doc.nextSeq, entry.seq + 1); };
  for (const f of [...input.inbox].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1))) {
    const e = ev.get(f.id);
    const base = entryFromMessage(diskEntryMessage(f), doc.nextSeq, f.mtimeMs || now, 'inbox', !e?.delivered || e.delivered.legacy === true);
    put({ ...base, redelivered: e?.surfaced === true });
  }
  for (const f of [...input.done].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1))) {
    if (inboxIds.has(f.id)) continue;
    const base = entryFromMessage(diskEntryMessage(f), doc.nextSeq, f.mtimeMs, 'inbox', false);
    // §11.18 #1: an obligation with no replied row is still open, however old its file is.
    if (f.mtimeMs < now - retentionMs && !(replyTracked(base) && !ev.get(f.id)?.replied)) continue;
    put({ ...base, state: 'acted', actedAt: f.mtimeMs, updatedAt: f.mtimeMs });
  }
  for (const [id, e] of ev) {
    if (doc.entries[id] || !e.workOrder || (e.workOrder.ts ?? 0) < now - retentionMs) continue;
    const r = e.workOrder;
    const base = entryFromMessage({ id, from: typeof r.from === 'string' ? r.from : '?', act: typeof r.act === 'string' ? r.act : undefined, requires_reply: typeof r.requiresReply === 'boolean' ? r.requiresReply : undefined, sender_id: typeof r.senderId === 'string' ? r.senderId : undefined }, doc.nextSeq, r.ts ?? now, 'work-order', false);
    put({ ...base, actedAt: r.ts ?? now, updatedAt: r.ts ?? now });
  }
  for (const [id, e] of ev) {
    const entry = doc.entries[id];
    if (entry && e.replied) doc.entries[id] = { ...entry, repliedAt: e.replied.at, replyId: e.replied.replyId };
  }
  const lastTs = Math.max(0, ...[...ev.values()].map((e) => e.lastTs));
  doc = { ...doc, lastActivityAt: lastTs || null };
  return doc;
}

/** Structural check of a parsed ledger. A document that fails it is treated as corrupt. */
export function validLedgerDoc(x: unknown, agentId: string): x is MailLedgerDoc {
  if (!x || typeof x !== 'object') return false;
  const d = x as Partial<MailLedgerDoc>;
  if (d.version !== MAIL_LEDGER_VERSION || d.agentId !== agentId || typeof d.nextSeq !== 'number') return false;
  if (!d.entries || typeof d.entries !== 'object' || Array.isArray(d.entries)) return false;
  const states: MailState[] = ['delivered', 'surfacing', 'surfaced', 'acted'];
  for (const [k, e] of Object.entries(d.entries)) {
    if (!e || typeof e !== 'object' || e.id !== k || !states.includes(e.state) || typeof e.seq !== 'number' || typeof e.from !== 'string') return false;
  }
  return true;
}

// ————————————————————————————————————————————————————————————————— the I/O shell

/** Same shape as the hive's authority issues (`hive:integrity` → the repair banner). */
export interface MailIntegrityIssue {
  file: string;
  quarantine: string | null;
  error: string;
  /** The ledger was rebuilt (nothing is paused); the banner words it as a notice. */
  repaired?: true;
  /** A notice that is not a damaged file (N1 `mail-evidence-missing`): the banner shows this
   *  text; nothing is paused. */
  notice?: string;
}

export interface MailLedgerOptions {
  /** The hive root (`<home>/hive`), or null when the hive is off. */
  root: () => string | null;
  /** The hive's appendLog (the only log sink). */
  appendLog: (row: Record<string, unknown>) => void;
  /** Log rows (oldest first) for a corrupt-ledger rebuild; bounded by the caller. */
  readLogRows?: () => unknown[];
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  writeDelayMs?: number;
}

export type AdmitResult =
  | { duplicate: true; existingId: string }
  | { duplicate: false; msg: MailMessageLike; reassigned: boolean };

interface AgentLedger {
  agentId: string;
  file: string;
  doc: MailLedgerDoc;
  dirty: boolean;
  timer: unknown;
  lastWriteAt: number;
  /** Acted ids whose inbox file is moved to .done right after the ledger write that records them. */
  archive: Set<string>;
  archiveTimer: unknown;
  archiveAttempt: number;
  archiveFailLogged: Set<string>;
  writeFailLogged: boolean;
}

export class MailLedger {
  private readonly ledgers = new Map<string, AgentLedger>();
  private readonly listeners = new Set<(ev: MailEvent) => void>();
  private readonly issues = new Map<string, MailIntegrityIssue>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly writeDelayMs: number;

  constructor(private readonly opts: MailLedgerOptions) {
    this.now = opts.clock ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.writeDelayMs = opts.writeDelayMs ?? MAIL_WRITE_COALESCE_MS;
  }

  // — paths —
  private rootDir(): string | null { return this.opts.root(); }
  ledgerFile(agentId: string): string | null {
    const root = this.rootDir();
    return root ? join(root, 'state', 'mail', `${agentId}.json`) : null;
  }
  private inboxDir(agentId: string): string | null {
    const root = this.rootDir();
    return root ? join(root, 'agents', agentId, 'inbox') : null;
  }
  /** A ledger exists only for a real agent: a valid id whose agents/<id>/inbox exists. */
  hasAgent(agentId: string): boolean {
    if (!isValidMailId(agentId)) return false;
    const inbox = this.inboxDir(agentId);
    return !!inbox && existsSync(inbox);
  }

  // — events —
  /** Readers (voice completion watcher, fleet, UI) subscribe here. Returns the unsubscribe. */
  subscribe(listener: (ev: MailEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Integrity notices for the `hive:integrity` banner: one per rebuilt ledger this session. */
  integrityIssues(): MailIntegrityIssue[] {
    return [...this.issues.values(), ...this.notices.values()];
  }

  /** N1 notices, one per agent for the session (the evidence reader needs fixing). */
  private readonly notices = new Map<string, MailIntegrityIssue>();

  /**
   * N1 (§11.17): the surfacing evidence reader failed twice in a row for these ids, so they were
   * confirmed on the latency rule alone. Logs `mail-evidence-missing` and raises a UI notice
   * through the `hive:integrity` banner (once per agent per session; the row is per call).
   */
  noteEvidenceMissing(agentId: string, ids: string[], epoch: string, evidence: string): void {
    if (!ids.length) return;
    this.log({ kind: 'mail-evidence-missing', agentId, ids, epoch, evidence });
    if (this.notices.has(agentId)) return;
    this.notices.set(agentId, {
      file: `state/mail/${agentId}.json`, quarantine: null, error: 'mail-evidence-missing',
      notice: `Mail delivery evidence for ${agentId} could not be found in its ${evidence === 'codex-rollout' ? 'Codex rollout' : 'session transcript'}; messages were confirmed by hook timing instead. The transcript reader may need updating (see mail-evidence-missing in the log).`
    });
  }

  /** Q13 ruling: ids whose body is in neither inbox/ nor inbox/.done/ (or cannot be parsed). */
  private readonly bodyMissingLogged = new Set<string>();

  /**
   * Q13 (god's ruling): a delivered message whose body is in NEITHER inbox/ nor inbox/.done/ (or
   * cannot be parsed) is logged `mail-body-missing` (once per id per session) and raised LOUDLY
   * through the integrity banner (one notice per agent per session). It stays delivered: nothing
   * is ever marked handled because a file went missing.
   */
  noteBodyMissing(agentId: string, id: string, why: string): void {
    const key = `${agentId}|${id}`;
    if (this.bodyMissingLogged.has(key)) return;
    this.bodyMissingLogged.add(key);
    this.log({ kind: 'mail-body-missing', agentId, id, why });
    const noticeKey = `${agentId}|body-missing`;
    if (this.notices.has(noticeKey)) return;
    this.notices.set(noticeKey, {
      file: `agents/${agentId}/inbox/${id}.json`, quarantine: null, error: 'mail-body-missing',
      notice: `A hive message for ${agentId} (${id}) is in its mail record but its file is missing or unreadable in both inbox/ and inbox/.done/, so it cannot be shown to the agent (see mail-body-missing in the log).`
    });
  }

  /**
   * §11.10: switch an injection agent to legacy-read (the channel override), log
   * `mail-channel-degraded` and raise a UI alert through the integrity banner. Returns true when
   * the mode changed (a second call is a no-op).
   */
  degradeChannel(agentId: string, reason: string, detail: Record<string, unknown> = {}): boolean {
    if (!this.hasAgent(agentId)) return false;
    const changed = this.setChannelOverride(agentId, { mode: 'legacy-read', reason, since: this.now() });
    if (!changed) return false;
    this.log({ kind: 'mail-channel-degraded', agentId, reason, mode: 'legacy-read', ...detail });
    this.notices.set(`${agentId}|degraded`, {
      file: `state/mail/${agentId}.json`, quarantine: null, error: 'mail-channel-degraded',
      notice: `Mail for ${agentId} is no longer reaching it through its hooks (${reason === 'zero-hook-traffic' ? 'no hook traffic across 3 wakes' : '3 wakes started a turn with no mail block'}); it now reads its inbox files instead (legacy-read). Check the agent's hook setup (see mail-channel-degraded in the log).`
    });
    return true;
  }

  // — load —
  private readDir(dir: string): DiskMessage[] {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: DiskMessage[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const full = join(dir, n);
      let mtimeMs = 0;
      let msg: Partial<MailMessageLike> | null = null;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
        if (st.size <= MESSAGE_FILE_MAX_BYTES) {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
          if (parsed && typeof parsed === 'object') msg = parsed as Partial<MailMessageLike>;
        }
      } catch { /* unparseable: still a message file on disk */ }
      out.push({ id: n.slice(0, -'.json'.length), msg, mtimeMs });
    }
    return out;
  }

  private state(agentId: string): AgentLedger {
    if (!isValidMailId(agentId)) throw new Error(`mail ledger: invalid agent id ${JSON.stringify(agentId).slice(0, 80)}`);
    const file = this.ledgerFile(agentId);
    if (!file) throw new Error('mail ledger: hive is not enabled');
    const cached = this.ledgers.get(file);
    if (cached) return cached;
    // Never create a ledger for a name that is not an agent on this floor.
    if (!this.hasAgent(agentId)) throw new Error(`mail ledger: no agent ${agentId} on this floor`);
    const st: AgentLedger = {
      agentId, file, doc: emptyLedger(agentId), dirty: false, timer: null, lastWriteAt: 0,
      archive: new Set(), archiveTimer: null, archiveAttempt: 0, archiveFailLogged: new Set(), writeFailLogged: false
    };
    this.ledgers.set(file, st);
    this.load(st);
    return st;
  }

  private load(st: AgentLedger): void {
    const now = this.now();
    const inboxDir = this.inboxDir(st.agentId)!;
    let raw: string | null = null;
    let failure: string | null = null;
    try {
      raw = readFileSync(st.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (raw === null && failure === null) {
      // No ledger yet: the one-shot §7.1 import (idempotent: once written, never repeated).
      const inbox = this.readDir(inboxDir);
      st.doc = migrateFromInbox(st.agentId, inbox, now);
      if (inbox.length) this.log({ kind: 'mail-ledger-migrated', agentId: st.agentId, imported: inbox.length });
      this.markDirty(st);
    } else {
      let parsed: unknown = null;
      if (failure === null) {
        try { parsed = JSON.parse(raw!); } catch (error) { failure = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`; }
      }
      if (failure === null && !validLedgerDoc(parsed, st.agentId)) failure = 'invalid ledger structure';
      if (failure === null) st.doc = parsed as MailLedgerDoc;
      else this.rebuildCorrupt(st, failure, now);
    }
    // App restart with epochs open (§1.1, §2.4): they close abnormally.
    this.commit(st, applyRestartRecovery(st.doc, now));
    // Crash between an inbox write and the ledger write: the file is the evidence.
    const known = new Set(Object.keys(st.doc.entries));
    for (const f of this.readDir(inboxDir)) {
      if (known.has(f.id)) continue;
      this.commit(st, applyDelivered(st.doc, diskEntryMessage(f), now, { harness: true, reason: 'recovered' }));
    }
    // Crash between the ledger write and the .done rename: finish the rename (idempotent).
    for (const e of Object.values(st.doc.entries)) {
      if (e.state === 'acted' && e.via === 'inbox' && existsSync(join(inboxDir, `${e.id}.json`))) st.archive.add(e.id);
    }
    this.commit(st, applyPrune(st.doc, now));
    if (st.archive.size) this.markDirty(st);
  }

  private rebuildCorrupt(st: AgentLedger, error: string, now: number): void {
    // Never an empty ledger (G4): quarantine, rebuild from log + filesystem, tell the Human.
    let quarantine: string | null = `${st.file}.corrupt-${now}`;
    try {
      renameWithRetry(st.file, quarantine);
    } catch {
      try { copyFileSync(st.file, quarantine); } catch { quarantine = null; }
    }
    const inboxDir = this.inboxDir(st.agentId)!;
    let logRows: unknown[] = [];
    try { logRows = this.opts.readLogRows?.() ?? []; } catch { logRows = []; }
    st.doc = rebuildLedger(st.agentId, { inbox: this.readDir(inboxDir), done: this.readDir(join(inboxDir, '.done')), logRows }, now);
    const entries = Object.keys(st.doc.entries).length;
    this.log({ kind: 'mail-ledger-corrupt', agentId: st.agentId, error, quarantine: quarantine ? basename(quarantine) : null, rebuiltEntries: entries });
    this.issues.set(st.file, { file: `state/mail/${st.agentId}.json`, quarantine: quarantine ? basename(quarantine) : null, error, repaired: true });
    this.markDirty(st);
  }

  // — commit / write —
  private log(row: Record<string, unknown>): void {
    try { this.opts.appendLog(row); } catch { /* the log is best-effort; the ledger is the record */ }
  }

  private commit(st: AgentLedger, step: MailStep): MailStep {
    if (!step.changed.length) return step;
    st.doc = step.doc;
    for (const row of step.logs) this.log(row);
    for (const id of step.archive) st.archive.add(id);
    this.markDirty(st);
    for (const ev of step.events) {
      for (const l of this.listeners) {
        try { l(ev); } catch { /* a reader never breaks the ledger */ }
      }
    }
    return step;
  }

  private markDirty(st: AgentLedger): void {
    st.dirty = true;
    if (st.timer !== null) return;
    const wait = Math.max(0, st.lastWriteAt + this.writeDelayMs - this.now());
    st.timer = this.setTimer(() => { st.timer = null; this.flushState(st); }, wait);
  }

  private flushState(st: AgentLedger): void {
    if (st.timer !== null) { this.clearTimer(st.timer); st.timer = null; }
    if (st.dirty) {
      st.doc = applyPrune(st.doc, this.now()).doc;
      const root = this.rootDir();
      // A hive removed under us (tests, reset): never re-create it from a timer.
      if (!root || !existsSync(root) || !st.file.startsWith(root)) { st.dirty = false; return; }
      try {
        mkdirSync(join(root, 'state', 'mail'), { recursive: true });
        atomicWriteJson(st.file, st.doc);
        st.dirty = false;
        st.lastWriteAt = this.now();
        st.writeFailLogged = false;
      } catch (error) {
        if (!st.writeFailLogged) this.log({ kind: 'mail-ledger-write-failed', agentId: st.agentId, error: String(error) });
        st.writeFailLogged = true;
        st.lastWriteAt = this.now();
        this.markDirty(st);
        return; // the rename waits for a durable ledger
      }
    }
    this.runArchives(st);
  }

  /** The harness `.done` rename, after the ledger that records `acted` is on disk. Idempotent;
   *  a failure retries only the rename with backoff (`mail-archive-failed`, once per id), never
   *  re-surfaces: the ledger is authoritative. */
  private runArchives(st: AgentLedger): void {
    if (!st.archive.size) return;
    const inboxDir = this.inboxDir(st.agentId);
    if (!inboxDir) return;
    const failed: string[] = [];
    for (const id of [...st.archive]) {
      const src = join(inboxDir, `${id}.json`);
      try {
        if (existsSync(src)) {
          mkdirSync(join(inboxDir, '.done'), { recursive: true });
          renameSync(src, join(inboxDir, '.done', `${id}.json`));
        }
        st.archive.delete(id);
        st.archiveFailLogged.delete(id);
      } catch (error) {
        failed.push(id);
        if (!st.archiveFailLogged.has(id)) {
          st.archiveFailLogged.add(id);
          this.log({ kind: 'mail-archive-failed', agentId: st.agentId, id, error: String(error) });
        }
      }
    }
    if (st.archiveTimer !== null) { this.clearTimer(st.archiveTimer); st.archiveTimer = null; }
    if (!failed.length) { st.archiveAttempt = 0; return; }
    st.archiveAttempt++;
    const wait = Math.min(60_000, 1_000 * 2 ** Math.min(6, st.archiveAttempt - 1));
    st.archiveTimer = this.setTimer(() => { st.archiveTimer = null; this.runArchives(st); }, wait);
  }

  /** Write one agent's ledger now (and run its pending archives). */
  flush(agentId: string): void {
    const file = this.ledgerFile(agentId);
    const st = file ? this.ledgers.get(file) : undefined;
    if (st) this.flushState(st);
  }

  /** Write every dirty ledger now: app quit, home change, reset. */
  flushAll(): void {
    for (const st of this.ledgers.values()) this.flushState(st);
  }

  /** Flush, then drop timers and caches (a later call reloads from disk). */
  dispose(): void {
    this.flushAll();
    for (const st of this.ledgers.values()) {
      if (st.timer !== null) this.clearTimer(st.timer);
      if (st.archiveTimer !== null) this.clearTimer(st.archiveTimer);
    }
    this.ledgers.clear();
  }

  // — transitions —
  /** A read-only snapshot of an agent's ledger (loads it). */
  ledger(agentId: string): MailLedgerDoc {
    return this.docOrEmpty(agentId);
  }

  /**
   * §4.1 admission, BEFORE the inbox write. An invalid id, or an id colliding with different
   * content, gets a fresh `<ts>-<rand>` id with the sender's value kept as `sender_id`
   * (`mail-id-reassigned`). Same from + same hash(subject + body) = duplicate, dropped
   * (`mail-dedup`, §11.18 #3).
   */
  admit(agentId: string, msg: MailMessageLike): AdmitResult {
    const st = this.state(agentId);
    const inboxDir = this.inboxDir(agentId)!;
    let cur: MailMessageLike = msg;
    let reassigned = false;
    const reassign = (reason: string): void => {
      let id = freshMailId(this.now());
      for (let i = 0; i < 8 && (st.doc.entries[id] || existsSync(join(inboxDir, `${id}.json`)) || existsSync(join(inboxDir, '.done', `${id}.json`))); i++) id = freshMailId(this.now());
      const senderId = cur.sender_id ?? senderIdValue(cur.id);
      this.log({ kind: 'mail-id-reassigned', agentId, from: cur.from, senderId, id, reason });
      cur = { ...cur, id, sender_id: senderId };
      reassigned = true;
    };
    if (!isValidMailId(cur.id)) reassign('invalid');
    const read = (id: string): ExistingMessage => {
      for (const p of [join(inboxDir, `${id}.json`), join(inboxDir, '.done', `${id}.json`)]) {
        try {
          if (!existsSync(p)) continue;
          if (statSync(p).size > MESSAGE_FILE_MAX_BYTES) return 'unreadable';
          const m = JSON.parse(readFileSync(p, 'utf8')) as { from?: unknown; subject?: unknown; body?: unknown };
          return { from: m?.from, subject: m?.subject, body: m?.body };
        } catch { return 'unreadable'; }
      }
      return null;
    };
    const cls = classifyIncoming(st.doc, cur, read);
    if (cls.kind === 'dup') {
      this.log({ kind: 'mail-dedup', agentId, id: cur.id, from: cur.from, existingId: cls.existingId });
      return { duplicate: true, existingId: cls.existingId };
    }
    if (cls.kind === 'conflict') reassign(`collision-${cls.reason}`);
    return { duplicate: false, msg: cur, reassigned };
  }

  /** The router's durable inbox write succeeded. */
  markDelivered(agentId: string, msg: MailMessageLike): void {
    const st = this.state(agentId);
    this.commit(st, applyDelivered(st.doc, msg, this.now()));
  }

  /** N2: a confirmed terminal work-order write (proxy/hookless): acted via work-order.
   *  `restored` (Q14): confirmed after a restart, so only its header fields are known. */
  recordWorkOrder(agentId: string, msg: MailMessageLike, opts: { restored?: boolean } = {}): void {
    const st = this.state(agentId);
    this.commit(st, applyWorkOrder(st.doc, msg, this.now(), opts));
  }

  /** §11.18 #1: explicitly close an open obligation without a reply. Returns the ids closed. */
  closeObligation(agentId: string, ref: string, reason: string): string[] {
    if (!ref || !this.hasAgent(agentId)) return [];
    const st = this.state(agentId);
    return this.commit(st, applyCloseObligation(st.doc, ref, this.now(), reason)).changed;
  }

  /** The agent's channel override (§11.10 degradation), or null for the provider default. */
  channelOverride(agentId: string): MailChannelOverride | null {
    return this.docOrEmpty(agentId).channel ?? null;
  }

  /** Set or clear the channel override (slice 3's degradation trigger calls this). */
  setChannelOverride(agentId: string, override: MailChannelOverride | null): boolean {
    const st = this.state(agentId);
    return this.commit(st, applyChannelOverride(st.doc, override)).changed.length > 0;
  }

  /** A hook response carried these ids: delivered → surfacing. Returns the ids claimed. */
  claimSurfacing(agentId: string, ids: Iterable<string>, epoch: string, hookKind: string): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyClaimSurfacing(st.doc, ids, epoch, hookKind, this.now())).changed;
  }

  /** Evidence/latency confirmed: surfacing → surfaced (matching epoch). Returns the ids confirmed. */
  confirmSurfaced(agentId: string, ids: Iterable<string>, epoch: string, method: MailConfirmMethod = 'evidence'): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyConfirmSurfaced(st.doc, ids, epoch, method, this.now())).changed;
  }

  /** surfaced → acted for the matching epoch (+ the harness .done rename after the ledger write). */
  markActed(agentId: string, ids: Iterable<string>, epoch: string): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyMarkActed(st.doc, ids, epoch, this.now())).changed;
  }

  /** §11.5: compaction re-inject, surfaced/surfacing → surfacing in the same epoch. Returns the ids. */
  reinject(agentId: string, ids: Iterable<string>, epoch: string, hookKind: string): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyReinject(st.doc, ids, epoch, hookKind, this.now())).changed;
  }

  /** Open ids back to delivered with the marker (see applyRedeliver). Returns the ids. */
  redeliver(agentId: string, ids: Iterable<string>, reason: string): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyRedeliver(st.doc, ids, reason, this.now())).changed;
  }

  /** Acted without a surfacing, for legacy-read (at Stop) and legacy-move (agent moved). */
  legacyActed(agentId: string, ids: Iterable<string>, mode: 'legacy-read' | 'legacy-move', opts: { epoch?: string | null; reason?: string } = {}): string[] {
    const st = this.state(agentId);
    return this.commit(st, applyLegacyActed(st.doc, ids, mode, this.now(), opts)).changed;
  }

  /**
   * Jim audit #4: a cheap disk → ledger reconcile for the wake beat (the load-time one only runs
   * once per process). One readdir of inbox/; a `*.json` file the ledger does not know (written
   * while admit/markDelivered threw, or by a writer other than deliver()) is read and recorded
   * `delivered` with `reason:"recovered"` (logged). Bodies are read only for those unknown files,
   * at most `maxReads` per call. `moveIsHandled` (legacy-move, §11.7): a delivered id whose file
   * the agent moved to .done is acted (`agent-moved`).
   */
  reconcileInbox(agentId: string, opts: { moveIsHandled?: boolean; maxReads?: number } = {}): { recovered: string[]; moved: string[] } {
    const none = { recovered: [] as string[], moved: [] as string[] };
    if (!this.hasAgent(agentId)) return none;
    const st = this.state(agentId);
    const inboxDir = this.inboxDir(agentId)!;
    let names: string[];
    try { names = readdirSync(inboxDir); } catch { return none; }
    const onDisk = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
    const recovered: string[] = [];
    let reads = 0;
    const now = this.now();
    for (const id of onDisk) {
      if (st.doc.entries[id]) continue;
      if (reads++ >= (opts.maxReads ?? 50)) break;
      const full = join(inboxDir, `${id}.json`);
      let msg: Partial<MailMessageLike> | null = null;
      let mtimeMs = now;
      try {
        const s = statSync(full);
        if (!s.isFile()) continue;
        mtimeMs = s.mtimeMs;
        if (s.size <= MESSAGE_FILE_MAX_BYTES) {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as unknown;
          if (parsed && typeof parsed === 'object') msg = parsed as Partial<MailMessageLike>;
        }
      } catch { /* unparseable: still a message file on disk */ }
      const step = this.commit(st, applyDelivered(st.doc, diskEntryMessage({ id, msg, mtimeMs }), now, { harness: true, reason: 'recovered' }));
      if (step.changed.length) recovered.push(id);
    }
    const moved: string[] = [];
    if (opts.moveIsHandled) {
      const gone = pendingEntries(st.doc).filter((e) => e.via === 'inbox' && !onDisk.has(e.id) && existsSync(join(inboxDir, '.done', `${e.id}.json`))).map((e) => e.id);
      if (gone.length) moved.push(...this.commit(st, applyLegacyActed(st.doc, gone, 'legacy-move', now, { reason: 'agent-moved' })).changed);
    }
    return { recovered, moved };
  }

  /** Close a surfacing epoch (see applyCloseEpoch). */
  closeEpoch(agentId: string, epoch: string, outcome: EpochOutcome, opts: { reason?: string; late?: Iterable<string>; lateDetail?: Record<string, MailLateDetail> } = {}): { acted: string[]; redelivered: string[] } {
    const st = this.state(agentId);
    const step = this.commit(st, applyCloseEpoch(st.doc, epoch, outcome, this.now(), opts));
    return {
      acted: step.events.filter((e) => e.stage === 'acted').map((e) => e.id),
      redelivered: step.events.filter((e) => e.stage === 'redelivered').map((e) => e.id)
    };
  }

  /** `agentId` routed a message with in_reply_to = `ref` to `replyTo`. No-op for a non-agent sender. */
  markReplied(agentId: string, ref: string, replyId: string, replyTo?: string | null): string[] {
    if (!ref || !this.hasAgent(agentId)) return [];
    const st = this.state(agentId);
    return this.commit(st, applyReplied(st.doc, ref, replyId, this.now(), replyTo)).changed;
  }

  // — queries (load lazily; a non-agent has an empty ledger and none is created) —
  private docOrEmpty(agentId: string): MailLedgerDoc {
    return this.hasAgent(agentId) ? this.state(agentId).doc : emptyLedger(agentId);
  }
  pending(agentId: string): MailEntry[] { return pendingEntries(this.docOrEmpty(agentId)); }
  backlog(agentId: string): MailEntry[] { return backlogEntries(this.docOrEmpty(agentId)); }
  awaitingReply(agentId: string): MailObligation[] { return awaitingReplyEntries(this.docOrEmpty(agentId), this.now()); }
  openRequests(agentId: string): MailObligation[] { return openRequestEntries(this.docOrEmpty(agentId), this.now()); }
  openEpochs(agentId: string): OpenEpoch[] { return openEpochsOf(this.docOrEmpty(agentId)); }
  resolve(agentId: string, ref: string): MailEntry[] { return resolveEntries(this.docOrEmpty(agentId), ref); }
  aliases(agentId: string, ref: string): string[] { return aliasesIn(this.docOrEmpty(agentId), ref); }
  lastActivityAt(agentId: string): number | null { return this.docOrEmpty(agentId).lastActivityAt; }
  lastActedAt(agentId: string): number | null { return this.docOrEmpty(agentId).lastActedAt; }
}
