/**
 * READS-181 A: the `ledger` command's work, done in main. One call updates a task card, writes
 * one outbox message and appends to the caller's memory.md.
 *
 * Why: god and the agents spent 2-4 tool calls on that bookkeeping, and each call re-reads the
 * whole context (10-02: 111 of god's 328 requests, 20M of its 66M reads). Why in main: tasks.json
 * has no lock (writeTasks re-reads, merges and swaps, so an outside writer can race it), and the
 * memory.md rollover at an agent's Stop runs in main through the same per-agent queue as these ops
 * (index.ts ledgerQueue), so an in-process append cannot fall inside it.
 *
 * Contract:
 * - The input is ONE JSON object, sent by the CLI from a file or stdin (never shell arguments, so
 *   no body text is ever parsed by a shell: MSG-COMPOSE-SHELL-INJECTION).
 * - Everything is checked before anything is written; one error refuses the whole operation.
 * - Idempotent by `op`: a part already done for this op is skipped on a retry, so a crash
 *   between parts is repaired by running the same op again. The op's CONTENT is hashed: the
 *   same op name with different content is refused, never half-applied (Jim B1).
 * - The caller is the agent the URL token names; `from` is never taken from the input.
 * - CLAIM-LEDGER W6 (G6.6): at the claim ledger's effective level 'writer', memory.md is a generated
 *   view, so the memory part becomes ONE claim (the endpoint's `note` verb, origin 'ledger-route':
 *   at most 400 characters, never cut, no source or legacy) instead of a memory.md append. The
 *   length is checked with everything else, before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { HiveTask } from './hive';
import { CLAIM_TEXT_MAX, type LedgerLevel } from '../shared/claims';

export const LEDGER_BODY_MAX = 256 * 1024;
export const LEDGER_MEMORY_MAX = 32 * 1024;
export const LEDGER_TEXT_MAX = 200 * 1024;
const OP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'] as const;
const TOP_KEYS = new Set(['op', 'card', 'message', 'close', 'memory']);
const CARD_KEYS = new Set(['id', 'create', 'patch', 'appendResult', 'appendNote']);
const CREATE_KEYS = new Set(['title', 'description', 'assignee', 'status', 'priority', 'dependsOn']);
const PATCH_KEYS = new Set(['title', 'description', 'assignee', 'status', 'priority', 'dependsOn', 'parked', 'waitingFor', 'fixVersion']);
const FIX_VERSION_RE = /^\d+\.\d+\.\d+$/;
const MESSAGE_KEYS = new Set(['to', 'act', 'subject', 'body', 'conversation', 'in_reply_to', 'supersedes', 'card', 'needs_human']);
const CLOSE_KEYS = new Set(['id', 'reason']);
/** REQUESTS-BADGE-84 D/E: at most this many asks closed by one op. */
export const LEDGER_CLOSE_MAX = 50;
/** A card id as tasks.json spells them ("READS-181", "T5b"; the shape mailLedger.cardIdValue keeps). */
const CARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
// CL-M4-FORWARD-PATH S3: key / supersedes / separate / reason reach the claim (level writer only;
// memory.md has no keys, so below writer they are ignored).
const MEMORY_KEYS = new Set(['append', 'lesson', 'key', 'supersedes', 'separate', 'reason']);
const MEMORY_CLAIM_ID_RE = /^c-[0-9a-f]{12,32}$/;
const MEMORY_REASONS = new Set(['changed', 'corrected', 'moved']);
/** Where `lesson: true` text goes: the pinned section every agent's memory.md starts with. */
const LESSONS_HEADING = '## How I work (standing lessons)';
const OPS_KEPT = 200;

export interface LedgerCard {
  id: string;
  create?: { title: string; description?: string; assignee?: string; status?: HiveTask['status']; priority?: number; dependsOn?: string[] };
  patch?: Partial<Pick<HiveTask, 'title' | 'description' | 'assignee' | 'status' | 'priority' | 'dependsOn'>> & { parked?: boolean; waitingFor?: 'install' | null; fixVersion?: string | null };
  appendResult?: string;
  appendNote?: string;
}
export interface LedgerMessage { to: string; act: string; subject: string; body: string; conversation?: string; in_reply_to?: string | null; supersedes?: string[]; card?: string; needs_human?: boolean }
/** REQUESTS-BADGE-84 D/E: close an open ask by hand, with the reason it records. */
export interface LedgerClose { id: string; reason: string }
export interface LedgerMemory { append: string; lesson?: boolean; key?: string; supersedes?: string[]; separate?: string[]; reason?: 'changed' | 'corrected' | 'moved' }
export interface LedgerOp { op: string; card?: LedgerCard; message?: LedgerMessage; close?: LedgerClose[]; memory?: LedgerMemory }
/** The note verb's args for a memory part (the claim route). */
export type MemoryNoteArgs = { kind: 'fact' | 'lesson'; text: string; pin?: true; key?: string; supersedes?: string[]; separate?: string[]; reason?: string };
export function memoryNoteArgs(m: LedgerMemory): MemoryNoteArgs {
  return {
    kind: m.lesson ? 'lesson' : 'fact', text: m.append.trim(), ...(m.lesson ? { pin: true as const } : {}),
    ...(m.key !== undefined ? { key: m.key } : {}), ...(m.supersedes ? { supersedes: m.supersedes } : {}),
    ...(m.separate ? { separate: m.separate } : {}), ...(m.reason ? { reason: m.reason } : {}),
  };
}

export interface LedgerDeps {
  /** The caller (from the authenticated URL). */
  agentId: string;
  /** The caller's folder: <hive>/agents/<id>. */
  agentDir: string;
  /** A valid `to`: a registered agent id, 'god' or 'broadcast'. */
  isRecipient(to: string): boolean;
  /** The current cards (fresh from disk). */
  readTasks(): HiveTask[];
  addTask(task: HiveTask): boolean;
  patchTask(id: string, patch: Partial<HiveTask>): boolean;
  now(): Date;
  /**
   * CLAIM-LEDGER W6 (G6.6): the caller's claim ledger, when it is wired. At level 'writer' the memory
   * part is noted as a claim through `note` (main wires it to the endpoint's note verb with origin
   * 'ledger-route'); below 'writer', or when absent, the memory part goes to memory.md as before.
   */
  memoryClaim?: {
    level: LedgerLevel;
    note(args: MemoryNoteArgs): Promise<{ ok: boolean; id?: string; error?: string }>;
    /** S3: the endpoint's card-key refusal, checked with everything else before anything is written; null = ok. */
    precheck?(args: MemoryNoteArgs): string | null;
  } | null;
  /**
   * REQUESTS-BADGE-84 D/E: who the caller is for the open ask `id`: 'owner' (the caller owes it:
   * it is in the caller's own ledger), 'requester' (the caller sent it: it is in another agent's
   * ledger with the caller as sender), 'closed' (one of those, closed already: nothing to do), or
   * null (no ask of the caller's). Absent = no close part.
   */
  askCloser?(id: string): 'owner' | 'requester' | 'closed' | null;
  /** Close it with this exact reason (`owner:…` or `withdrawn:…`); true when it is closed. */
  closeAsk?(id: string, by: 'owner' | 'requester', reason: string): boolean;
}

/** Characters as the claim store counts them (code points). */
const charLen = (t: string): number => { let n = 0; for (const _ of t) { void _; n++; } return n; };

export interface LedgerReply { status: number; body: { ok: boolean; line: string } }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unknownKeys = (o: Record<string, unknown>, allowed: Set<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The op, or the reason it is refused. Pure: checks shape only (not the ledger's state). */
export function parseLedgerOp(raw: unknown): { ok: true; op: LedgerOp } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: 'the input must be one JSON object' };
  const extra = unknownKeys(raw, TOP_KEYS);
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')} (allowed: op, card, message, close, memory)` };
  if (typeof raw.op !== 'string' || !OP_RE.test(raw.op)) return { ok: false, error: 'op: required, 1-80 of A-Z a-z 0-9 . _ - (a unique name for this operation, e.g. "creed-181-3")' };
  if (raw.card === undefined && raw.message === undefined && raw.close === undefined && raw.memory === undefined) return { ok: false, error: 'nothing to do: give card, message, close and/or memory' };
  const op: LedgerOp = { op: raw.op };
  if (raw.card !== undefined) {
    const c = raw.card;
    if (!isObj(c)) return { ok: false, error: 'card: must be an object' };
    const x = unknownKeys(c, CARD_KEYS);
    if (x.length) return { ok: false, error: `card: unknown field(s): ${x.join(', ')}` };
    if (!str(c.id, 120)) return { ok: false, error: 'card.id: required (the card id, e.g. "READS-181")' };
    if (c.create !== undefined && c.patch !== undefined) return { ok: false, error: 'card: give create OR patch, not both' };
    const card: LedgerCard = { id: c.id };
    if (c.create !== undefined) {
      if (!isObj(c.create)) return { ok: false, error: 'card.create: must be an object' };
      const cx = unknownKeys(c.create, CREATE_KEYS);
      if (cx.length) return { ok: false, error: `card.create: unknown field(s): ${cx.join(', ')}` };
      if (!str(c.create.title, 300)) return { ok: false, error: 'card.create.title: required' };
      const e = checkCardFields(c.create, 'card.create');
      if (e) return { ok: false, error: e };
      card.create = c.create as LedgerCard['create'];
    }
    if (c.patch !== undefined) {
      if (!isObj(c.patch) || Object.keys(c.patch).length === 0) return { ok: false, error: 'card.patch: must be a non-empty object' };
      const px = unknownKeys(c.patch, PATCH_KEYS);
      if (px.length) return { ok: false, error: `card.patch: unknown field(s): ${px.join(', ')} (use appendResult / appendNote to add text)` };
      const e = checkCardFields(c.patch, 'card.patch');
      if (e) return { ok: false, error: e };
      card.patch = c.patch as LedgerCard['patch'];
    }
    for (const k of ['appendResult', 'appendNote'] as const) {
      if (c[k] === undefined) continue;
      if (!str(c[k], LEDGER_TEXT_MAX)) return { ok: false, error: `card.${k}: a non-empty string` };
      card[k] = c[k] as string;
    }
    if (!card.create && !card.patch && !card.appendResult && !card.appendNote) return { ok: false, error: 'card: give create, patch, appendResult or appendNote' };
    op.card = card;
  }
  if (raw.message !== undefined) {
    const m = raw.message;
    if (!isObj(m)) return { ok: false, error: 'message: must be an object' };
    const x = unknownKeys(m, MESSAGE_KEYS);
    if (x.length) return { ok: false, error: `message: unknown field(s): ${x.join(', ')}` };
    if (!str(m.to, 120)) return { ok: false, error: 'message.to: required (an agent id, "god" or "broadcast")' };
    if (typeof m.act !== 'string' || !(ACTS as readonly string[]).includes(m.act)) return { ok: false, error: `message.act: one of ${ACTS.join(', ')}` };
    // MAIL-EMPTY-SUBJECT-BODY-195: a whitespace subject is no subject (it let a blank message through).
    if (!str(m.subject, 1000) || !m.subject.trim()) return { ok: false, error: 'message.subject: required' };
    if (typeof m.body !== 'string' || m.body.length > LEDGER_TEXT_MAX) return { ok: false, error: `message.body: a string of at most ${LEDGER_TEXT_MAX} chars` };
    if (m.conversation !== undefined && !str(m.conversation, 120)) return { ok: false, error: 'message.conversation: a short string' };
    if (m.in_reply_to !== undefined && m.in_reply_to !== null && !str(m.in_reply_to, 200)) return { ok: false, error: 'message.in_reply_to: a message id or null' };
    if (m.supersedes !== undefined && (!Array.isArray(m.supersedes) || m.supersedes.length > 10 || !m.supersedes.every((s) => str(s, 200)))) {
      return { ok: false, error: 'message.supersedes: up to 10 message ids' };
    }
    if (m.card !== undefined && (typeof m.card !== 'string' || !CARD_ID_RE.test(m.card))) return { ok: false, error: 'message.card: a card id, e.g. "READS-181"' };
    if (m.needs_human !== undefined && typeof m.needs_human !== 'boolean') return { ok: false, error: 'message.needs_human: true or false' };
    // REQUESTS-BADGE-84 A: the op's card is the message's card unless the message names one.
    const card = (m.card as string | undefined) ?? op.card?.id;
    // A request is tied to its card at send time, so closing the card closes the ask. Information
    // that needs no answer goes as inform (or done), which never counts as an open ask.
    if (m.act === 'request' && !card) return { ok: false, error: 'message: a request must name its card (give card, or message.card). Information that needs no answer goes as act "inform"' };
    op.message = { ...(m as unknown as LedgerMessage), ...(card ? { card } : {}) };
  }
  if (raw.close !== undefined) {
    const list = raw.close;
    if (!Array.isArray(list) || list.length === 0 || list.length > LEDGER_CLOSE_MAX) return { ok: false, error: `close: a list of 1-${LEDGER_CLOSE_MAX} { "id", "reason" } items` };
    const seen = new Set<string>();
    const items: LedgerClose[] = [];
    for (const [i, c] of list.entries()) {
      if (!isObj(c)) return { ok: false, error: `close[${i}]: must be an object` };
      const x = unknownKeys(c, CLOSE_KEYS);
      if (x.length) return { ok: false, error: `close[${i}]: unknown field(s): ${x.join(', ')}` };
      if (!str(c.id, 200)) return { ok: false, error: `close[${i}].id: the message id of the ask` };
      if (typeof c.reason !== 'string' || !c.reason.trim() || c.reason.length > 180) return { ok: false, error: `close[${i}].reason: required, why it is no longer open (at most 180 chars)` };
      if (seen.has(c.id)) return { ok: false, error: `close[${i}].id: ${c.id} is listed twice` };
      seen.add(c.id);
      items.push({ id: c.id, reason: c.reason.trim() });
    }
    op.close = items;
  }
  if (raw.memory !== undefined) {
    const m = raw.memory;
    if (!isObj(m)) return { ok: false, error: 'memory: must be an object' };
    const x = unknownKeys(m, MEMORY_KEYS);
    if (x.length) return { ok: false, error: `memory: unknown field(s): ${x.join(', ')}` };
    if (typeof m.append !== 'string' || !m.append.trim() || m.append.length > LEDGER_MEMORY_MAX) return { ok: false, error: `memory.append: non-empty text of at most ${LEDGER_MEMORY_MAX} chars` };
    if (m.lesson !== undefined && typeof m.lesson !== 'boolean') return { ok: false, error: 'memory.lesson: true or false' };
    if (m.lesson === true && /^##\s/m.test(m.append)) return { ok: false, error: 'memory.append: a lesson may not contain a "## " heading (it would end the standing-lessons section); use ### or bullets' };
    if (m.key !== undefined && (typeof m.key !== 'string' || !m.key || m.key.length > 200)) return { ok: false, error: 'memory.key: a key of at most 200 chars' };
    const claimIds = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((s) => typeof s === 'string' && MEMORY_CLAIM_ID_RE.test(s)) && new Set(v).size === v.length;
    if (m.supersedes !== undefined && !claimIds(m.supersedes)) return { ok: false, error: 'memory.supersedes: 1 to 10 of your claim ids (c-...)' };
    if (m.separate !== undefined && !claimIds(m.separate)) return { ok: false, error: 'memory.separate: 1 to 10 of your claim ids (c-...)' };
    if (m.supersedes !== undefined && m.separate !== undefined) return { ok: false, error: 'memory: choose supersedes or separate, not both' };
    if (m.supersedes !== undefined && (typeof m.reason !== 'string' || !MEMORY_REASONS.has(m.reason))) return { ok: false, error: 'memory.supersedes needs "reason": "changed", "corrected" or "moved"' };
    if (m.supersedes === undefined && m.reason !== undefined) return { ok: false, error: 'memory.reason goes with memory.supersedes' };
    op.memory = {
      append: m.append, ...(m.lesson === true ? { lesson: true } : {}), ...(m.key !== undefined ? { key: m.key as string } : {}),
      ...(m.supersedes !== undefined ? { supersedes: m.supersedes as string[] } : {}), ...(m.separate !== undefined ? { separate: m.separate as string[] } : {}),
      ...(m.reason !== undefined ? { reason: m.reason as LedgerMemory['reason'] } : {}),
    };
  }
  return { ok: true, op };
}

function checkCardFields(o: Record<string, unknown>, where: string): string | null {
  if (o.title !== undefined && !str(o.title, 300)) return `${where}.title: a non-empty string`;
  if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > LEDGER_TEXT_MAX)) return `${where}.description: a string`;
  if (o.assignee !== undefined && !str(o.assignee, 120)) return `${where}.assignee: an agent id`;
  if (o.status !== undefined && !(STATUSES as readonly unknown[]).includes(o.status)) return `${where}.status: one of ${STATUSES.join(', ')}`;
  if (o.priority !== undefined && (typeof o.priority !== 'number' || !Number.isFinite(o.priority))) return `${where}.priority: a number`;
  if (o.dependsOn !== undefined && (!Array.isArray(o.dependsOn) || !o.dependsOn.every((d) => str(d, 120)))) return `${where}.dependsOn: a list of card ids`;
  if (o.parked !== undefined && typeof o.parked !== 'boolean') return `${where}.parked: true or false`;
  if (o.waitingFor !== undefined && o.waitingFor !== null && o.waitingFor !== 'install') return `${where}.waitingFor: "install" or null`;
  if (o.fixVersion !== undefined && o.fixVersion !== null && (typeof o.fixVersion !== 'string' || !FIX_VERSION_RE.test(o.fixVersion))) return `${where}.fixVersion: x.y.z or null`;
  return null;
}

/** Text for a free-text field: the old value, then `[iso] text` on its own line (god's form). */
const appended = (old: unknown, text: string, at: Date): string => `${typeof old === 'string' ? old : ''}\n[${at.toISOString()}] ${text}`;

interface OpRecord { op: string; at: string; hash?: string; card?: boolean; message?: string; closed?: string[]; memory?: number; claim?: string; line?: string }

/** Canonical JSON: object keys sorted, so the same content always hashes the same. */
const canonical = (v: unknown): string => Array.isArray(v)
  ? `[${v.map(canonical).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null';

/** Jim B1: sha256 of the parsed op without its name (what the op DOES, not what it is called). */
export function opContentHash(op: LedgerOp): string {
  const { op: _name, ...content } = op;
  void _name;
  return createHash('sha256').update(canonical(content)).digest('hex');
}

function readOps(file: string): OpRecord[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { ops?: unknown };
    return Array.isArray(j.ops) ? j.ops.filter((o): o is OpRecord => isObj(o) && typeof o.op === 'string') : [];
  } catch { return []; }
}
function writeOps(file: string, ops: OpRecord[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ops: ops.slice(-OPS_KEPT) }, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * W6-D1 (Jim R1): one ledger op at a time per agent. At level 'writer' the memory part awaits a claim
 * append; a retry of the same op (the CLI says to retry after its 15 s timeout) must wait for the op
 * in flight, then find its memory part done instead of noting it again. Main's ledger handler runs
 * every op through one of these, keyed by the caller.
 */
export function perAgentQueue(): <T>(agentId: string, run: () => T | Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(agentId: string, run: () => T | Promise<T>): Promise<T> => {
    const prev = tails.get(agentId) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    tails.set(agentId, tail);
    void tail.then(() => { if (tails.get(agentId) === tail) tails.delete(agentId); });
    return next;
  };
}

/** Insert lesson text at the end of the standing-lessons section (before the next `## `). */
export function insertLesson(memory: string, text: string): string | null {
  const at = memory.indexOf(LESSONS_HEADING);
  if (at < 0) return null;
  const bodyStart = memory.indexOf('\n', at);
  if (bodyStart < 0) return `${memory}\n${text.trimEnd()}\n`;
  const rest = memory.slice(bodyStart + 1);
  const next = rest.search(/^## /m);
  const end = next < 0 ? memory.length : bodyStart + 1 + next;
  const before = memory.slice(0, end).replace(/\n*$/, '\n');
  return `${before}${text.trimEnd()}\n${next < 0 ? '' : '\n'}${memory.slice(end)}`;
}

/**
 * Apply one op for `deps.agentId`. Validates everything first; then card, message, memory, each
 * recorded as done for the op once written, so a retry of the same op finishes only what is left.
 */
export function applyLedgerOp(raw: unknown, deps: LedgerDeps): LedgerReply | Promise<LedgerReply> {
  const parsed = parseLedgerOp(raw);
  if (!parsed.ok) return { status: 400, body: { ok: false, line: `refused: ${parsed.error}` } };
  const op = parsed.op;
  const opsFile = join(deps.agentDir, 'state', 'ledger-ops.json');
  const ops = readOps(opsFile);
  let rec = ops.find((o) => o.op === op.op);
  const hash = opContentHash(op);
  // Jim B1: a reused name with DIFFERENT content would otherwise be answered "already applied"
  // (or, mid-retry, finished with the new content beside the old): refused, nothing written.
  if (rec && rec.hash !== hash) {
    return { status: 409, body: { ok: false, line: `refused: op ${op.op} was already used for a different operation; choose a new op name` } };
  }
  if (rec?.line) return { status: 200, body: { ok: true, line: `${rec.line} (already applied)` } };
  const now = deps.now();

  // 1) Everything that can be checked against the current state, before any write.
  let tasks: HiveTask[];
  try { tasks = deps.readTasks(); } catch (e) { return { status: 500, body: { ok: false, line: `refused: tasks.json could not be read (${String(e).slice(0, 160)})` } }; }
  const card = op.card;
  if (card && !rec?.card) {
    const exists = tasks.some((t) => t?.id === card.id);
    if (card.create && exists) return { status: 409, body: { ok: false, line: `refused: card ${card.id} already exists (use patch)` } };
    if (!card.create && !exists) return { status: 404, body: { ok: false, line: `refused: no card ${card.id} (use create)` } };
  }
  if (op.message && !rec?.message && !deps.isRecipient(op.message.to)) {
    return { status: 400, body: { ok: false, line: `refused: message.to "${op.message.to}" is not a registered agent, "god" or "broadcast"` } };
  }
  // REQUESTS-BADGE-84 A: a message's card must exist (the op's own card is checked above).
  const msgCard = op.message?.card;
  if (op.message && msgCard && !rec?.message && msgCard !== card?.id && !tasks.some((t) => t?.id === msgCard)) {
    return { status: 404, body: { ok: false, line: `refused: message.card ${msgCard} is not a card` } };
  }
  // REQUESTS-BADGE-84 D/E: every ask must be one the caller owes (owner) or sent (requester).
  const closers = new Map<string, 'owner' | 'requester' | 'closed'>();
  if (op.close) {
    if (!deps.askCloser || !deps.closeAsk) return { status: 400, body: { ok: false, line: 'refused: close is not available here' } };
    for (const c of op.close) {
      if (rec?.closed?.includes(c.id)) continue;
      const by = deps.askCloser(c.id);
      if (!by) return { status: 404, body: { ok: false, line: `refused: ${c.id} is not an open ask you owe or sent` } };
      closers.set(c.id, by);
    }
  }
  const memFile = join(deps.agentDir, 'memory.md');
  const asClaim = !!op.memory && deps.memoryClaim?.level === 'writer';
  if (op.memory && asClaim && !rec?.memory) {
    const len = charLen(op.memory.append.trim());
    if (len > CLAIM_TEXT_MAX) {
      return { status: 400, body: { ok: false, line: `refused: memory.append is ${len} characters. Your claim ledger is on, so a memory note is one claim of at most ${CLAIM_TEXT_MAX} characters (never cut): split it into several notes` } };
    }
    // S3: a card.* note meeting a live same-key claim must choose first; the whole op is refused.
    const why = deps.memoryClaim!.precheck?.(memoryNoteArgs(op.memory)) ?? null;
    if (why) return { status: 409, body: { ok: false, line: `refused: ${why}` } };
  }
  let lessonText: string | null = null;
  if (op.memory?.lesson && !rec?.memory && !asClaim) {
    let cur = '';
    try { cur = readFileSync(memFile, 'utf8'); } catch { cur = ''; }
    lessonText = insertLesson(cur, op.memory.append);
    if (lessonText === null) return { status: 400, body: { ok: false, line: `refused: memory.md has no "${LESSONS_HEADING}" section for a lesson` } };
  }

  if (!rec) { rec = { op: op.op, at: now.toISOString(), hash }; ops.push(rec); }
  const done: string[] = [];
  // W6-D1 (Jim R2): re-read and merge by op name before every save, so this op's snapshot (read
  // before an await) can never drop the record of another op that finished meanwhile.
  const save = (): void => {
    const cur = readOps(opsFile);
    const i = cur.findIndex((o) => o.op === rec!.op);
    if (i >= 0) cur[i] = rec!; else cur.push(rec!);
    writeOps(opsFile, cur);
  };
  const fail = (part: string, e: unknown): LedgerReply => {
    try { save(); } catch { /* the reply still says what is done */ }
    return { status: 500, body: { ok: false, line: `partial: ${done.length ? done.join(' ') + '; ' : ''}${part} failed (${String(e).slice(0, 160)}). Run the same op again to finish it.` } };
  };

  // 2) The card.
  if (card) {
    if (!rec.card) {
      try {
        if (card.create) {
          const t: HiveTask = {
            id: card.id, title: card.create.title, status: card.create.status ?? 'todo',
            dependsOn: card.create.dependsOn ?? [], priority: card.create.priority ?? 0, createdAt: now.toISOString(),
            ...(card.create.description !== undefined ? { description: card.create.description } : {}),
            ...(card.create.assignee !== undefined ? { assignee: card.create.assignee } : {}),
            ...(card.appendResult ? { result: appended(undefined, card.appendResult, now) } : {}),
            ...(card.appendNote ? { notes: appended(undefined, card.appendNote, now) } : {})
          };
          if (!deps.addTask(t)) throw new Error(`card ${card.id} appeared meanwhile`);
        } else {
          const cur = deps.readTasks().find((t) => t?.id === card.id) as (HiveTask & Record<string, unknown>) | undefined;
          if (!cur) throw new Error(`card ${card.id} disappeared meanwhile`);
          // The assignee is kept unless the patch names one (a patch never touches other fields).
          const patch: Partial<HiveTask> = { ...(card.patch ?? {}) };
          if (card.appendResult) patch.result = appended(cur.result, card.appendResult, now);
          if (card.appendNote) patch.notes = appended(cur.notes, card.appendNote, now);
          if (!deps.patchTask(card.id, patch)) throw new Error(`card ${card.id} could not be patched`);
        }
        rec.card = true;
        save();
      } catch (e) { return fail(`card ${card.id}`, e); }
    }
    const status = card.patch?.status ?? card.create?.status ?? (deps.readTasks().find((t) => t?.id === card.id)?.status ?? '?');
    done.push(`card=${card.id}:${status}`);
  }

  // 3) The message: one file in the caller's outbox, written whole (temp + rename).
  if (op.message) {
    if (!rec.message) {
      try {
        const m = op.message;
        const file = `ledger-${op.op}.json`;
        const outbox = join(deps.agentDir, 'outbox');
        mkdirSync(outbox, { recursive: true });
        const msg = {
          to: m.to, act: m.act, subject: m.subject, body: m.body,
          ...(m.conversation !== undefined ? { conversation: m.conversation } : {}),
          ...(m.in_reply_to !== undefined ? { in_reply_to: m.in_reply_to } : {}),
          ...(m.supersedes !== undefined ? { supersedes: m.supersedes } : {}),
          ...(m.card !== undefined ? { card: m.card } : {}),
          ...(m.needs_human !== undefined ? { needs_human: m.needs_human } : {})
        };
        const tmp = join(outbox, `${file}.tmp-${process.pid}`);
        writeFileSync(tmp, JSON.stringify(msg, null, 2), 'utf8');
        renameSync(tmp, join(outbox, file));
        rec.message = file;
        save();
      } catch (e) { return fail('message', e); }
    }
    done.push(`msg=${rec.message}`);
  }

  // 3b) REQUESTS-BADGE-84 D/E: the asks closed by hand, each with its recorded reason.
  if (op.close) {
    const closed = rec.closed ?? [];
    for (const c of op.close) {
      if (closed.includes(c.id)) continue;
      const by = closers.get(c.id)!;
      try {
        // Jim N3: an ask closed meanwhile (routing closed it by this op's own reply) is done, not an error.
        if (by !== 'closed' && !deps.closeAsk!(c.id, by, `${by === 'owner' ? 'owner' : 'withdrawn'}:${c.reason}`)
          && deps.askCloser!(c.id) !== 'closed') throw new Error(`${c.id} was not open any more`);
        closed.push(c.id);
        rec.closed = closed;
        save();
      } catch (e) { return fail(`close ${c.id}`, e); }
    }
    done.push(`closed=${closed.length}`);
  }

  const finish = (): LedgerReply => {
    rec!.line = `ok op=${op.op} ${done.join(' ')}`;
    try { save(); } catch { /* the work is done; a retry is then a no-op per part */ }
    return { status: 200, body: { ok: true, line: rec!.line } };
  };
  // 4a) Memory at level 'writer': one claim (G6.6). The claim id is recorded for the op, so a retry
  // after the ack does not note it twice.
  if (op.memory && asClaim && !rec.memory) {
    const m = op.memory;
    const r0 = rec;
    return deps.memoryClaim!.note(memoryNoteArgs(m)).then((r) => {
      if (!r.ok) return fail('memory', `the claim was refused: ${r.error ?? 'no reason given'}`);
      try {
        r0.memory = Buffer.byteLength(m.append, 'utf8');
        if (r.id) r0.claim = r.id;
        save();
      } catch (e) { return fail('memory', e); }
      done.push(`memory=claim ${r0.claim ?? '?'}${m.lesson ? ' (lesson)' : ''}`);
      return finish();
    }, (e: unknown) => fail('memory', e));
  }
  // 4) Memory: appended at the end, or (lesson) inserted at the end of the standing lessons.
  if (op.memory) {
    if (rec.claim) done.push(`memory=claim ${rec.claim}${op.memory.lesson ? ' (lesson)' : ''}`);
    else if (!rec.memory) {
      try {
        if (lessonText !== null) {
          const tmp = `${memFile}.tmp-${process.pid}`;
          writeFileSync(tmp, lessonText, 'utf8');
          renameSync(tmp, memFile);
        } else {
          let cur = '';
          try { cur = existsSync(memFile) ? readFileSync(memFile, 'utf8') : ''; } catch { cur = ''; }
          appendFileSync(memFile, `${cur && !cur.endsWith('\n') ? '\n' : ''}${op.memory.append.trimEnd()}\n`, 'utf8');
        }
        rec.memory = Buffer.byteLength(op.memory.append, 'utf8');
        save();
      } catch (e) { return fail('memory', e); }
    }
    if (!rec.claim) done.push(`memory=+${rec.memory}B${op.memory.lesson ? ' (lesson)' : ''}`);
  }
  return finish();
}
