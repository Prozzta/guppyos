/**
 * ZT-I3 §3.1: the task-ledger guard. It WATCHES `hive/tasks.json`; it never owns it.
 *
 * God edits the ledger directly with file tools, so a harness rewrite racing that edit
 * would lose one of them (atomic rename is not compare-and-swap). The guard therefore
 * never writes `tasks.json`. It sees every change, whoever made it, and keeps the
 * harness's own facts about each card in a sidecar, `hive/state/task-meta.json`:
 * how long a card has been in its status, when it was last edited, and by whom.
 *
 * Attribution. API writes (`HiveManager.writeTasks`) hand the guard the exact bytes they
 * renamed into place, AFTER the rename succeeded, in the same synchronous call
 * (`recordApiWrite`). A later read of the file with those bytes is that write, not a
 * hand edit. Any other content is attributed to `'file'`, which on this floor is god.
 *
 * Validation. Every change is checked with `validateLedger`. An error that appears in
 * the file is logged once (`task-ledger-invalid`) and shown as a non-pausing integrity
 * notice. The file is NOT reverted: the guard reports, god decides.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicJson';
import { firstOccurrenceById, validateLedger, type LedgerIssue } from '../shared/taskLedger';

export type TaskEditSource = 'ipc' | 'voice' | 'webhook' | 'slack' | 'board-auto' | 'api';

export interface CardStatusChange { at: number; from: string; to: string; by: string }

export interface CardMeta {
  status: string;
  /** sha256 of the card's JSON, so an edit is seen across app restarts too. */
  fp: string;
  statusSince: number;
  /** false when the guard could only bound the age (first seen at install): the UI says ">=". */
  statusSinceExact: boolean;
  lastEditAt: number;
  lastEditBy: string;
  history: CardStatusChange[];
}

export interface TaskMeta { v: 1; cards: Record<string, CardMeta> }

export const TASK_META_FILE = 'task-meta.json';
export const HISTORY_KEEP = 20;
export const API_HASH_RING = 8;
export const GUARD_DEBOUNCE_MS = 250;
export const GUARD_POLL_MS = 30_000;

export interface TaskLedgerChange {
  by: string;
  at: number;
  added: string[];
  removed: string[];
  statusChanged: Array<{ id: string; from: string; to: string }>;
  edited: string[];
}

export interface TaskLedgerGuardOptions {
  root: () => string | null;
  agentIds: () => ReadonlySet<string>;
  appendLog: (row: Record<string, unknown>) => void;
  now?: () => number;
  /** Called after every applied change (a file edit or an API write). */
  onChange?: (change: TaskLedgerChange) => void;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function rawId(card: unknown): string | null {
  return card && typeof card === 'object' && !Array.isArray(card)
    && typeof (card as { id?: unknown }).id === 'string' && (card as { id: string }).id
    ? (card as { id: string }).id : null;
}

function statusOf(card: unknown): string {
  const s = (card as { status?: unknown }).status;
  return typeof s === 'string' ? s : String(s ?? '');
}

/** A god-written timestamp the first run may trust as the start of the current status. */
function writtenSince(card: unknown): number | null {
  const c = card as { updatedAt?: unknown; doneAt?: unknown; status?: unknown };
  const pick = c.status === 'done' && typeof c.doneAt === 'string' ? c.doneAt : c.updatedAt;
  if (typeof pick !== 'string') return null;
  const t = Date.parse(pick);
  return Number.isNaN(t) ? null : t;
}

export class TaskLedgerGuard {
  private meta: TaskMeta | null = null;
  private lastHash: string | null = null;
  private readonly apiRing: Array<{ hash: string; source: string }> = [];
  private errorKeys = new Set<string>();
  private currentIssues: LedgerIssue[] = [];
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  private readonly listeners = new Set<(change: TaskLedgerChange) => void>();

  constructor(private readonly opts: TaskLedgerGuardOptions) {}

  /** Subscribe to applied changes (the board monitor re-runs on each). Returns unsubscribe. */
  onChange(listener: (change: TaskLedgerChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private metaPath(root: string): string { return join(root, 'state', TASK_META_FILE); }

  private loadMeta(root: string): TaskMeta {
    if (this.meta) return this.meta;
    let meta: TaskMeta = { v: 1, cards: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.metaPath(root), 'utf8')) as TaskMeta;
      if (parsed && parsed.v === 1 && parsed.cards && typeof parsed.cards === 'object') meta = parsed;
    } catch { /* missing or damaged: the sidecar is harness-owned and rebuilt from the ledger */ }
    this.meta = meta;
    return meta;
  }

  /** The sidecar as it stands (a copy). */
  taskMeta(): TaskMeta {
    const root = this.opts.root();
    const meta = root ? this.loadMeta(root) : { v: 1 as const, cards: {} };
    return JSON.parse(JSON.stringify(meta)) as TaskMeta;
  }

  /** The issues found in the ledger's current content. */
  issues(): LedgerIssue[] { return this.currentIssues.slice(); }

  /** A non-pausing notice for the `hive:integrity` banner while the ledger has errors. */
  integrityNotice(): string | null {
    const errors = this.currentIssues.filter((i) => i.level === 'error');
    if (errors.length === 0) return null;
    return `tasks.json: ${errors.map((e) => e.message).join('; ')}. The file was not changed; fix it by hand.`;
  }

  /**
   * An API write just renamed `content` into place (called only after the rename
   * succeeded; a failed write never reaches here, so nothing is recorded for it).
   */
  recordApiWrite(content: string, tasks: unknown[], source: string): void {
    const hash = sha256(content);
    this.apiRing.push({ hash, source });
    while (this.apiRing.length > API_HASH_RING) this.apiRing.shift();
    this.apply(hash, tasks, `api:${source}`);
  }

  /** Read `tasks.json` and apply whatever changed since the last applied content. */
  check(): TaskLedgerChange | null {
    const root = this.opts.root();
    if (!root) return null;
    let content: string;
    try { content = readFileSync(join(root, 'tasks.json'), 'utf8'); } catch { return null; }
    const hash = sha256(content);
    if (hash === this.lastHash) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return null; } // the hive's corrupt-file quarantine owns this case
    const tasks = parsed && typeof parsed === 'object' && Array.isArray((parsed as { tasks?: unknown }).tasks)
      ? (parsed as { tasks: unknown[] }).tasks : [];
    const ours = this.apiRing.find((r) => r.hash === hash);
    return this.apply(hash, tasks, ours ? `api:${ours.source}` : 'file');
  }

  private apply(hash: string, tasks: unknown[], by: string): TaskLedgerChange | null {
    const root = this.opts.root();
    if (!root) return null;
    const at = this.now();
    const meta = this.loadMeta(root);
    // Not watching yet (app start): a card the sidecar lacks appeared while nobody watched,
    // so its age is bounded, not known. `firstRun` (no sidecar at all) is the install case.
    const watching = this.lastHash !== null;
    const firstRun = !watching && Object.keys(meta.cards).length === 0;
    this.lastHash = hash;
    const change: TaskLedgerChange = { by, at, added: [], removed: [], statusChanged: [], edited: [] };
    const seen = new Set<string>();
    for (const card of firstOccurrenceById(tasks, rawId)) {
      const id = rawId(card);
      if (!id) continue;
      seen.add(id);
      const status = statusOf(card);
      const fp = sha256(JSON.stringify(card));
      const prior = meta.cards[id];
      if (!prior) {
        const written = watching ? null : writtenSince(card);
        const since = written ?? at;
        meta.cards[id] = {
          status, fp,
          statusSince: since,
          // A card seen while watching was just added; one found at start has an unknown age.
          statusSinceExact: watching || written !== null,
          lastEditAt: since,
          lastEditBy: firstRun ? 'install' : by,
          history: []
        };
        if (!firstRun) change.added.push(id);
        continue;
      }
      if (prior.fp === fp) continue;
      prior.fp = fp;
      prior.lastEditAt = at;
      prior.lastEditBy = by;
      change.edited.push(id);
      if (prior.status !== status) {
        prior.history.push({ at, from: prior.status, to: status, by });
        if (prior.history.length > HISTORY_KEEP) prior.history.splice(0, prior.history.length - HISTORY_KEEP);
        change.statusChanged.push({ id, from: prior.status, to: status });
        prior.status = status;
        prior.statusSince = at;
        // Jim S4: a change found at start happened while nobody watched: its time is bounded.
        prior.statusSinceExact = watching;
      }
    }
    for (const id of Object.keys(meta.cards)) {
      if (!seen.has(id)) { delete meta.cards[id]; change.removed.push(id); }
    }
    this.validate(tasks, by);
    const touched = firstRun || change.added.length + change.removed.length + change.edited.length > 0;
    if (touched) {
      try {
        mkdirSync(join(root, 'state'), { recursive: true });
        atomicWriteJson(this.metaPath(root), meta);
      } catch (error) {
        try { this.opts.appendLog({ kind: 'task-meta-write-failed', error: String(error) }); } catch { /* noop */ }
      }
      for (const listener of [this.opts.onChange, ...this.listeners]) {
        try { listener?.(change); } catch { /* a listener never breaks the guard */ }
      }
    }
    return change;
  }

  private validate(tasks: unknown[], by: string): void {
    this.currentIssues = validateLedger(tasks, this.opts.agentIds());
    const errors = this.currentIssues.filter((i) => i.level === 'error');
    const keys = new Set(errors.map((e) => e.key));
    const fresh = errors.filter((e) => !this.errorKeys.has(e.key));
    this.errorKeys = keys;
    if (fresh.length > 0) {
      try {
        this.opts.appendLog({ kind: 'task-ledger-invalid', by, errors: fresh.map((e) => ({ key: e.key, cardId: e.cardId, message: e.message })) });
      } catch { /* the log is best-effort here */ }
    }
  }

  /** Watch the hive root for `tasks.json` changes (debounced), with a poll as a fallback for
   *  missed Windows watch events. The first check runs at once. */
  start(): void {
    this.stop();
    const root = this.opts.root();
    if (!root || !existsSync(root)) return;
    this.check();
    try {
      this.watcher = watch(root, (_event, file) => {
        if (file && String(file) !== 'tasks.json') return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => { this.debounce = null; this.check(); }, GUARD_DEBOUNCE_MS);
        this.debounce.unref?.();
      });
      this.watcher.on('error', () => { /* the poll still covers it */ });
    } catch { this.watcher = null; }
    this.poll = setInterval(() => this.check(), GUARD_POLL_MS);
    this.poll.unref?.();
  }

  stop(): void {
    try { this.watcher?.close(); } catch { /* noop */ }
    this.watcher = null;
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }

  /** The hive root changed (home switch): forget everything tied to the old one. */
  reset(): void {
    this.stop();
    this.meta = null;
    this.lastHash = null;
    this.apiRing.length = 0;
    this.errorKeys.clear();
    this.currentIssues = [];
  }
}
