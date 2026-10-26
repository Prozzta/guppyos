/**
 * NATIVE-MEMORY sections 3, 6 and 8, the MAIN-process side. Electron-free: the worker fork,
 * the clock and the file reads are injected.
 *
 * What main does, and ALL it does (spec section 3: <= 2 ms p95 of synchronous work):
 *   - validate a request, look up the caller's token, and post one message to the worker;
 *   - resolve the reply, or a named degraded answer at the deadline (never block, never throw);
 *   - fork the worker LAZILY, on the first memory request (never on app start), and re-fork it
 *     after a crash with a bounded backoff.
 * It never opens the database, loads an extension, embeds, reads a source, or runs SQL.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WorkerConfig } from './worker';
import { CLAIM_KINDS } from '../../shared/claims';

/** CLI exit codes (section 6). */
export const EXIT = { ok: 0, usage: 2, unavailable: 3, degraded: 4, unauthorized: 5 } as const;

export const SEARCH_DEADLINE_WARM_MS = 250;
export const SEARCH_DEADLINE_COLD_MS = 2_000;
/** MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189: a warm search while the worker reports indexing. It
 *  waits for one index step besides its own work, on a machine the index is loading (Jim saw 1 of
 *  84 searches cross 250 ms during a 1757-part claims sync). Under the cold budget and the CLI's
 *  10 s. */
export const SEARCH_DEADLINE_INDEXING_MS = 1_000;
/** At most one log row per reason this often (a wedged worker must not flood log.jsonl); the next
 *  row carries how many were suppressed. */
export const DEGRADED_LOG_EVERY_MS = 1_000;
/** Timed-out requests remembered for their late reply (bounded). */
const LATE_MAX = 64;
/** Requests that index: while one is outstanding the worker is indexing, before its own
 *  `indexing` event can arrive (a search sent right after a claims sync). */
const INDEX_OPS = new Set(['claims-sync', 'backfill', 'claim-ledger']);
/** NATIVE-WAKEUP N1: a wake-up may first wait (engine WAKE_WAIT_MS = 5 s) for its caller's wing on
 *  a filling index; its deadline covers that wait + the cold budget + a margin. (Main must not
 *  import the engine, so the pairing is pinned by a test.) */
export const WAKE_UP_DEADLINE_MS = 8_000;
/** Crash restarts allowed in RESTART_WINDOW_MS before the worker is left down (answers exit 3). */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;

export interface WorkerHandle {
  postMessage(msg: unknown): void;
  on(ev: 'message', fn: (msg: unknown) => void): void;
  on(ev: 'exit', fn: (code: number) => void): void;
  kill(): boolean;
}

export interface Reply { ok: boolean; exit: number; text?: string; json?: unknown; error?: string }

export interface ServiceDeps {
  fork: () => WorkerHandle;
  config: () => WorkerConfig | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (row: Record<string, unknown>) => void;
  /** Told when a (re)started worker is ready (CLAIM-LEDGER: main re-sends every agent's claims). */
  onReady?: () => void;
  /** Step 3 fix R2 (god bbcb4a): answers a worker's reverse request (`{ ask, op, args }` → `{ answer, result }`);
   *  null (or absent) = the worker goes without. */
  ask?: (op: string, args: Record<string, unknown>) => unknown;
}

export class NativeMemoryClient {
  private worker: WorkerHandle | null = null;
  private ready = false;
  private warm = false;
  /** The worker said it is indexing (its `indexing` event). */
  private indexing = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Reply) => void; timer: unknown; op: string; budget: number; at: number }>();
  private timedOut = new Map<number, { op: string; budget: number; at: number }>();
  private logCaps = new Map<string, { at: number; suppressed: number }>();
  private restarts: number[] = [];
  private down = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Forked yet? (tests, status) */
  get forked(): boolean { return this.worker !== null; }

  /** NATIVE-WAKEUP-EMPTY-INDEX (a): fork the worker now instead of at the first request (its
   *  startup backfill then fills an empty index before an agent's first wake-up). Idempotent;
   *  false when the worker cannot be forked (no config, or left down). */
  prewarm(): boolean {
    return this.ensureWorker() !== null;
  }

  private ensureWorker(): WorkerHandle | null {
    if (this.worker) return this.worker;
    if (this.down) return null;
    const cfg = this.d.config();
    if (!cfg) return null;
    const w = this.d.fork();
    this.worker = w;
    this.ready = false;
    this.warm = false;
    this.indexing = false;
    w.on('message', (msg) => this.onMessage(msg));
    w.on('exit', (code) => this.onExit(w, code));
    w.postMessage({ op: 'init', config: cfg });
    return w;
  }

  private onMessage(msg: unknown): void {
    const q = msg as { ask?: unknown; op?: unknown; args?: unknown } | null;
    if (q && typeof q.ask === 'number') { this.answer(q.ask, String(q.op ?? ''), (q.args && typeof q.args === 'object' ? q.args : {}) as Record<string, unknown>); return; }
    const m = msg as { id?: number; event?: string } & Reply;
    if (m && m.event) {
      if (m.event === 'ready') { this.ready = true; try { this.d.onReady?.(); } catch { /* best effort */ } }
      // Jim N2: the model was dropped after idle, so the next search pays a model load again:
      // it gets the COLD budget, not the warm one.
      else if (m.event === 'model-unloaded') this.warm = false;
      // WARM-MEANS-MODEL-LOADED-189: whatever op loaded the model (a backfill, an embed), searches are warm now.
      else if (m.event === 'model-loaded') this.warm = true;
      // State, not a log row: a search meanwhile gets SEARCH_DEADLINE_INDEXING_MS.
      else if (m.event === 'indexing') this.indexing = (m as { on?: unknown }).on === true;
      else this.d.log?.({ ...(m as unknown as Record<string, unknown>) });
      return;
    }
    if (!m || typeof m.id !== 'number') return;
    const timing = (m as { timing?: Record<string, unknown> }).timing;
    const p = this.pending.get(m.id);
    if (!p) {
      // The reply came after its deadline: the caller already got exit 4. Say where the time went.
      const t = this.timedOut.get(m.id);
      if (!t) return;
      this.timedOut.delete(m.id);
      this.logCapped('late', { kind: 'native-memory-late-reply', op: t.op, budgetMs: t.budget, lateByMs: this.now() - t.at - t.budget, ok: !!m.ok, ...(timing ?? {}) });
      return;
    }
    this.pending.delete(m.id);
    this.clearTimer(p.timer);
    // WARM-MEANS-MODEL-LOADED-189 (Jim S3): only a search proves the model is loaded (it embeds its
    // query); a status, wake-up or backfill with nothing to embed does not, and its ok reply used to
    // mark the client warm, so the next search paid the model load on the warm budget (exit 4).
    if (m.ok && p.op === 'search') this.warm = true;
    const exit = typeof m.exit === 'number' ? m.exit : m.ok ? EXIT.ok : EXIT.degraded;
    if (!m.ok && exit === EXIT.degraded) this.degraded(m.error === 'expired' ? 'expired' : 'error', p, { error: String(m.error ?? '').slice(0, 200), ...(timing ?? {}) });
    p.resolve({ ok: !!m.ok, exit, text: m.text, json: m.json, error: m.error });
  }

  /** Step 3 fix R2: a worker's reverse request; a missing dep, a throw or a rejection answers null. */
  private answer(id: number, op: string, args: Record<string, unknown>): void {
    const w = this.worker;
    const post = (result: unknown): void => { try { w?.postMessage({ answer: id, result }); } catch { /* worker gone */ } };
    try { Promise.resolve(this.d.ask ? this.d.ask(op, args) : null).then(post, () => post(null)); } catch { post(null); }
  }

  /** MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189 (A): every degraded reply writes one row (capped). */
  private degraded(reason: string, p: { op: string; budget?: number; at?: number }, extra: Record<string, unknown> = {}): void {
    this.logCapped(`degraded:${reason}`, {
      kind: 'native-memory-degraded', op: p.op, reason, ...(p.budget !== undefined ? { budgetMs: p.budget } : {}),
      warm: this.warm, indexing: this.indexingNow(), ...(p.at !== undefined ? { elapsedMs: this.now() - p.at } : {}), ...extra
    });
  }

  /** The worker said so, or main has an indexing request outstanding. */
  private indexingNow(): boolean {
    if (this.indexing) return true;
    for (const p of this.pending.values()) if (INDEX_OPS.has(p.op)) return true;
    return false;
  }

  private logCapped(key: string, row: Record<string, unknown>): void {
    const t = this.now();
    const c = this.logCaps.get(key);
    if (c && t - c.at < DEGRADED_LOG_EVERY_MS) { c.suppressed++; return; }
    this.logCaps.set(key, { at: t, suppressed: 0 });
    this.d.log?.({ ...row, ...(c?.suppressed ? { suppressed: c.suppressed } : {}) });
  }

  private onExit(w: WorkerHandle, code: number): void {
    if (this.worker !== w) return;
    this.worker = null;
    this.ready = false;
    this.indexing = false;
    for (const [id, p] of this.pending) { this.clearTimer(p.timer); this.degraded('worker-exit', p); p.resolve({ ok: false, exit: EXIT.degraded, error: 'memory worker exited' }); this.pending.delete(id); }
    // The model died with the worker (after the rows above, which say the budget each request had).
    this.warm = false;
    this.timedOut.clear();
    const t = this.now();
    this.restarts = this.restarts.filter((x) => t - x < RESTART_WINDOW_MS);
    this.restarts.push(t);
    if (this.restarts.length > MAX_RESTARTS) this.down = true;
    this.d.log?.({ kind: 'native-memory-worker-exit', code, restarts: this.restarts.length, down: this.down });
  }

  /** One request. Never throws and never waits past the deadline: at the deadline the caller
   *  gets a named degraded reply (exit 4) and the worker drops the stale request itself. */
  request(op: string, args: Record<string, unknown>, deadlineMs?: number): Promise<Reply> {
    const w = this.ensureWorker();
    if (!w) {
      const error = this.down ? 'memory worker is down (crashed repeatedly)' : 'native memory is not configured';
      this.degraded('unavailable', { op }, { error });
      return Promise.resolve({ ok: false, exit: EXIT.unavailable, error });
    }
    const budget = deadlineMs ?? (!this.warm ? SEARCH_DEADLINE_COLD_MS : this.indexingNow() ? SEARCH_DEADLINE_INDEXING_MS : SEARCH_DEADLINE_WARM_MS);
    const id = this.nextId++;
    const at = this.now();
    return new Promise<Reply>((resolve) => {
      const timer = this.setTimer(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.degraded('deadline', p);
        this.timedOut.set(id, { op, budget, at });
        if (this.timedOut.size > LATE_MAX) this.timedOut.delete(this.timedOut.keys().next().value as number);
        resolve({ ok: false, exit: EXIT.degraded, error: `memory ${op} timed out after ${budget} ms` });
      }, budget);
      this.pending.set(id, { resolve, timer, op, budget, at });
      w.postMessage({ id, op, args, deadline: at + budget });
    });
  }

  /** Drain in-flight requests (bounded), then stop the worker. */
  async shutdown(graceMs = 2_000): Promise<void> {
    const w = this.worker;
    if (!w) return;
    await Promise.race([this.request('shutdown', {}, graceMs), new Promise((r) => this.setTimer(() => r(null), graceMs))]);
    try { w.kill(); } catch { /* gone */ }
    this.worker = null;
  }
}

/**
 * Per-agent MEMORY_TOKEN (section 6, Jim fix 3): minted for EVERY spawned agent regardless of
 * provider, revoked when its PTY exits. The endpoint resolves the caller's wing from the token;
 * a request without a valid one is refused (exit 5). Stored by SHA-256, compared in constant
 * time, so the raw token never sits in a map key.
 */
export class MemoryTokens {
  private byHash = new Map<string, { agentId: string; hash: Buffer }>();
  private byAgent = new Map<string, string>();

  mint(agentId: string): string {
    this.revoke(agentId);
    const token = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(token).digest();
    this.byHash.set(hash.toString('hex'), { agentId, hash });
    this.byAgent.set(agentId, hash.toString('hex'));
    return token;
  }

  revoke(agentId: string): void {
    const h = this.byAgent.get(agentId);
    if (h) this.byHash.delete(h);
    this.byAgent.delete(agentId);
  }

  /** The agent a token belongs to, or null. */
  resolve(token: unknown): string | null {
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
    const hash = createHash('sha256').update(token).digest();
    const e = this.byHash.get(hash.toString('hex'));
    if (!e || !timingSafeEqual(e.hash, hash)) return null;
    return e.agentId;
  }
}

export interface MemoryRequest { cmd?: unknown; args?: unknown }

const WING = /^[A-Za-z0-9._-]{1,120}$/;
const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]*)?$/;

/** Validate a `memory` command request into a worker op (section 6 ranges). Pure. */
export function validateRequest(body: MemoryRequest, callerWing: string): { op: string; args: Record<string, unknown> } | { exit: number; error: string } {
  const cmd = body.cmd;
  const a = (body.args && typeof body.args === 'object' ? body.args : {}) as Record<string, unknown>;
  const optWing = (v: unknown): string | null | { bad: true } => (v === undefined || v === null || v === '' ? null : typeof v === 'string' && WING.test(v) ? v : { bad: true });
  if (cmd === 'search') {
    const q = a.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 2000) return { exit: EXIT.usage, error: 'search needs a QUERY (1-2000 characters)' };
    const wing = optWing(a.wing); const room = optWing(a.room);
    if (typeof wing === 'object' && wing) return { exit: EXIT.usage, error: 'bad --wing' };
    if (typeof room === 'object' && room) return { exit: EXIT.usage, error: 'bad --room' };
    const n = a.results === undefined ? 5 : Number(a.results);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { exit: EXIT.usage, error: '--results must be 1-100' };
    for (const k of ['since', 'before'] as const) {
      const v = a[k];
      if (v !== undefined && v !== null && (typeof v !== 'string' || !ISO.test(v) || Number.isNaN(Date.parse(v)))) return { exit: EXIT.usage, error: `--${k} must be an ISO date` };
    }
    // CLAIM-LEDGER (A5): --history / --all (never both), --kind, --key.
    if (a.history === true && a.all === true) return { exit: EXIT.usage, error: 'use --history or --all, not both' };
    const mode = a.all === true ? 'all' : a.history === true ? 'history' : 'live';
    const kind = a.kind === undefined || a.kind === null ? null : a.kind;
    if (kind !== null && (typeof kind !== 'string' || !(CLAIM_KINDS as readonly string[]).includes(kind))) return { exit: EXIT.usage, error: `--kind is one of ${CLAIM_KINDS.join(', ')}` };
    const key = a.key === undefined || a.key === null ? null : a.key;
    if (key !== null && (typeof key !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,119}$/.test(key))) return { exit: EXIT.usage, error: 'bad --key' };
    // `caller` (the token's wing) is never a filter: only NATIVE-WAKEUP (b)'s backfill hint.
    // CLAIMS-90 M1: `--full` = the verbose (whole-chunk) text; the default is the compact text.
    // CLAIMS-90 R2 (C90-GET): `--exact` (exact text, no embedding) and `--newest` (newest first). Flags only.
    for (const k of ['exact', 'newest'] as const) if (a[k] !== undefined && a[k] !== null && typeof a[k] !== 'boolean') return { exit: EXIT.usage, error: `--${k} takes no value` };
    return { op: 'search', args: { query: q, wing, room, results: n, since: a.since ?? null, before: a.before ?? null, caller: callerWing, mode, kind, key, full: a.full === true, exact: a.exact === true, newest: a.newest === true } };
  }
  if (cmd === 'wake-up') {
    const wing = optWing(a.wing);
    if (typeof wing === 'object' && wing) return { exit: EXIT.usage, error: 'bad --wing' };
    // Without --wing, wake-up is the CALLER's (Jim fix 3).
    return { op: 'wake-up', args: { wing: wing ?? callerWing, full: a.full === true } };
  }
  if (cmd === 'status') return { op: 'status', args: {} };
  return { exit: EXIT.usage, error: `unsupported command ${String(cmd)}` };
}
