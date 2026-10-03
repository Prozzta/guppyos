/**
 * READS-181 A: the `ledger` command's work, done in main. One call updates a task card, writes
 * one outbox message and appends to the caller's memory.md.
 *
 * Why: god and the agents spent 2-4 tool calls on that bookkeeping, and each call re-reads the
 * whole context (10-02: 111 of god's 328 requests, 20M of its 66M reads). Why in main: tasks.json
 * has no lock (writeTasks re-reads, merges and swaps, so an outside writer can race it), and the
 * memory reflector re-reads memory.md just before its swap (reflect.ts 4b), which an in-process
 * append cannot fall between.
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
const TOP_KEYS = new Set(['op', 'card', 'message', 'memory']);
const CARD_KEYS = new Set(['id', 'create', 'patch', 'appendResult', 'appendNote']);
const CREATE_KEYS = new Set(['title', 'description', 'assignee', 'status', 'priority', 'dependsOn']);
const PATCH_KEYS = new Set(['title', 'description', 'assignee', 'status', 'priority', 'dependsOn']);
const MESSAGE_KEYS = new Set(['to', 'act', 'subject', 'body', 'conversation', 'in_reply_to', 'supersedes']);
const MEMORY_KEYS = new Set(['append', 'lesson']);
/** Where `lesson: true` text goes: the pinned section every agent's memory.md starts with. */
const LESSONS_HEADING = '## How I work (standing lessons)';
const OPS_KEPT = 200;

export interface LedgerCard {
  id: string;
  create?: { title: string; description?: string; assignee?: string; status?: HiveTask['status']; priority?: number; dependsOn?: string[] };
  patch?: Partial<Pick<HiveTask, 'title' | 'description' | 'assignee' | 'status' | 'priority' | 'dependsOn'>>;
  appendResult?: string;
  appendNote?: string;
}
export interface LedgerMessage { to: string; act: string; subject: string; body: string; conversation?: string; in_reply_to?: string | null; supersedes?: string[] }
export interface LedgerOp { op: string; card?: LedgerCard; message?: LedgerMessage; memory?: { append: string; lesson?: boolean } }

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
  memoryClaim?: { level: LedgerLevel; note(args: { kind: 'fact' | 'lesson'; text: string; pin?: true }): Promise<{ ok: boolean; id?: string; error?: string }> } | null;
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
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(', ')} (allowed: op, card, message, memory)` };
  if (typeof raw.op !== 'string' || !OP_RE.test(raw.op)) return { ok: false, error: 'op: required, 1-80 of A-Z a-z 0-9 . _ - (a unique name for this operation, e.g. "creed-181-3")' };
  if (raw.card === undefined && raw.message === undefined && raw.memory === undefined) return { ok: false, error: 'nothing to do: give card, message and/or memory' };
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
    if (!str(m.subject, 1000)) return { ok: false, error: 'message.subject: required' };
    if (typeof m.body !== 'string' || m.body.length > LEDGER_TEXT_MAX) return { ok: false, error: `message.body: a string of at most ${LEDGER_TEXT_MAX} chars` };
    if (m.conversation !== undefined && !str(m.conversation, 120)) return { ok: false, error: 'message.conversation: a short string' };
    if (m.in_reply_to !== undefined && m.in_reply_to !== null && !str(m.in_reply_to, 200)) return { ok: false, error: 'message.in_reply_to: a message id or null' };
    if (m.supersedes !== undefined && (!Array.isArray(m.supersedes) || m.supersedes.length > 10 || !m.supersedes.every((s) => str(s, 200)))) {
      return { ok: false, error: 'message.supersedes: up to 10 message ids' };
    }
    op.message = m as unknown as LedgerMessage;
  }
  if (raw.memory !== undefined) {
    const m = raw.memory;
    if (!isObj(m)) return { ok: false, error: 'memory: must be an object' };
    const x = unknownKeys(m, MEMORY_KEYS);
    if (x.length) return { ok: false, error: `memory: unknown field(s): ${x.join(', ')}` };
    if (typeof m.append !== 'string' || !m.append.trim() || m.append.length > LEDGER_MEMORY_MAX) return { ok: false, error: `memory.append: non-empty text of at most ${LEDGER_MEMORY_MAX} chars` };
    if (m.lesson !== undefined && typeof m.lesson !== 'boolean') return { ok: false, error: 'memory.lesson: true or false' };
    if (m.lesson === true && /^##\s/m.test(m.append)) return { ok: false, error: 'memory.append: a lesson may not contain a "## " heading (it would end the standing-lessons section); use ### or bullets' };
    op.memory = { append: m.append, ...(m.lesson === true ? { lesson: true } : {}) };
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
  return null;
}

/** Text for a free-text field: the old value, then `[iso] text` on its own line (god's form). */
const appended = (old: unknown, text: string, at: Date): string => `${typeof old === 'string' ? old : ''}\n[${at.toISOString()}] ${text}`;

interface OpRecord { op: string; at: string; hash?: string; card?: boolean; message?: string; memory?: number; claim?: string; line?: string }

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
  const memFile = join(deps.agentDir, 'memory.md');
  const asClaim = !!op.memory && deps.memoryClaim?.level === 'writer';
  if (op.memory && asClaim && !rec?.memory) {
    const len = charLen(op.memory.append.trim());
    if (len > CLAIM_TEXT_MAX) {
      return { status: 400, body: { ok: false, line: `refused: memory.append is ${len} characters. Your claim ledger is on, so a memory note is one claim of at most ${CLAIM_TEXT_MAX} characters (never cut): split it into several notes` } };
    }
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
  const save = (): void => { writeOps(opsFile, ops); };
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
          ...(m.supersedes !== undefined ? { supersedes: m.supersedes } : {})
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
    return deps.memoryClaim!.note({ kind: m.lesson ? 'lesson' : 'fact', text: m.append.trim(), ...(m.lesson ? { pin: true as const } : {}) }).then((r) => {
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
