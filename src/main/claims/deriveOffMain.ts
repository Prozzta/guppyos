/**
 * STARTUP-FREEZE-104 A19 (god 424399): main's side of the derive worker thread (deriveWorker.ts, deriveJob.ts).
 *
 * run() posts one job and resolves with the worker's answer, or with null: the caller then derives in-process, exactly
 * as before A19, so a worker problem costs time and never a result or a wedge. Null when:
 *   - the worker cannot start, crashes, exits or errors: it is terminated, every job it held resolves null, and the
 *     next job starts a fresh worker; after `maxFailures` such failures the worker is off for this run;
 *   - a job takes longer than `timeoutMs` (a hang): the same as a crash;
 *   - the worker answers 'stale' (the files no longer reach the verified head), 'no-registry' or 'error'.
 * Each null is logged as claims-derive-fallback with its reason.
 * The registry (megabytes at 10x) is posted only when it is not the object the live worker already holds.
 *
 * CLAIMS-WARM-BACKFILL-106 (Jim's SHOULD on the A19 gate: warm backfill 16-17 s against A18's 4.5-5.5 s): a warm
 * backfill runs nine syncDerived passes over an unchanged derived ledger, and each posted the same 'codes' job (one
 * worker read, verify and derive, ~1.8 s at 10x). A18's deriveOnce reused the in-process result; this is its off-main
 * twin: an agent's last 'codes' answer is reused while the job's head, count, frozen registry and r4 are the same. A
 * verified chain with the same head and count is the same records, so the answer is the one the worker would give.
 *
 * 106 drain (Jim's SHOULD on c9cf16c6, god go): when a worker fails, the jobs it held settle null one per macrotask
 * turn, so each caller's in-process fallback runs in its own turn, not one microtask chain (7 at 10x: one 1.96 s
 * block). A job run() meanwhile waits for the drain and one more turn before it reaches the fresh worker.
 */
import type { KeyRegistry } from '../../shared/claims';
import type { DeriveJob, DeriveJobResult } from './deriveJob';

export interface DeriveWorkerLike {
  postMessage(msg: unknown): void;
  on(ev: 'message', fn: (msg: { id: number; result: DeriveJobResult }) => void): unknown;
  on(ev: 'error', fn: (e: unknown) => void): unknown;
  on(ev: 'exit', fn: (code: number) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

export interface DeriveOffMainDeps {
  spawn: () => DeriveWorkerLike;
  log?: (row: Record<string, unknown>) => void;
  timeoutMs?: number;
  maxFailures?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** 106: one macrotask turn for the fallback drain (default setImmediate). */
  yieldTurn?: (fn: () => void) => void;
}

export const DERIVE_WORKER_TIMEOUT_MS = 30_000;
export const DERIVE_WORKER_MAX_FAILURES = 3;

type Ok = Extract<DeriveJobResult, { ok: true }>;
interface Pending { resolve: (r: Ok | null) => void; timer: unknown; agentId: string; want: string; memo: CodesMemo | null }
/** 106: what an agent's last 'codes' answer was for (registry by identity: loadRegistryShared's frozen object). */
interface CodesMemo { head: string; count: number; registry: KeyRegistry; r4: boolean; result?: Ok }

export class DeriveOffMain {
  private w: DeriveWorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sentRegistry: KeyRegistry | null = null;
  private failures = 0;
  private disabled = false;
  /** 106: per agent, the last 'codes' answer and the job it answered. */
  private readonly codes = new Map<string, CodesMemo & { result: Ok }>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  /** 106: a failed worker's jobs still settling, one per turn (null when none). */
  private drain: Promise<void> | null = null;
  private readonly yieldTurn: (fn: () => void) => void;

  constructor(private readonly d: DeriveOffMainDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.yieldTurn = d.yieldTurn ?? ((fn) => { setImmediate(fn); });
  }

  /** Whether jobs go to the worker (false once it failed `maxFailures` times). */
  get enabled(): boolean { return !this.disabled; }

  run(job: Omit<DeriveJob, 'registry'> & { registry: KeyRegistry }): Promise<Ok | null> {
    if (this.disabled) return Promise.resolve(null);
    const memo: CodesMemo | null = job.want === 'codes' ? { head: job.head, count: job.count, registry: job.registry, r4: !!job.r4 } : null;
    if (memo) {
      const last = this.codes.get(job.agentId);
      if (last && last.head === memo.head && last.count === memo.count && last.registry === memo.registry && last.r4 === memo.r4) {
        return Promise.resolve(last.result);
      }
    }
    if (this.drain) return this.drain.then(() => this.run(job));
    const w = this.worker();
    if (!w) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<Ok | null>((resolve) => {
      const timer = this.setTimer(() => this.fail(w, 'timeout'), this.d.timeoutMs ?? DERIVE_WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, agentId: job.agentId, want: job.want, memo });
      const registry = job.registry === this.sentRegistry ? null : job.registry;
      try {
        w.postMessage({ id, job: { ...job, registry } });
        this.sentRegistry = job.registry;
      } catch (e) {
        this.fail(w, 'post', e);
      }
    });
  }

  /** Stop the worker (app quit); jobs it held resolve null. */
  stop(): void {
    const w = this.w;
    this.w = null;
    this.sentRegistry = null;
    this.codes.clear();
    if (w) { try { w.terminate(); } catch { /* gone */ } }
    this.settleAll(null);
  }

  private worker(): DeriveWorkerLike | null {
    if (this.w) return this.w;
    let w: DeriveWorkerLike;
    try { w = this.d.spawn(); } catch (e) { this.fail(null, 'spawn', e); return null; }
    this.w = w;
    w.unref?.();
    w.on('message', (msg) => {
      if (this.w !== w) return;
      const p = this.pending.get(msg?.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.clearTimer(p.timer);
      const r = msg.result;
      if (r && r.ok) {
        if (p.memo && Object.isFrozen(p.memo.registry)) this.codes.set(p.agentId, { ...p.memo, result: r });
        p.resolve(r);
        return;
      }
      this.d.log?.({ kind: 'claims-derive-fallback', agentId: p.agentId, want: p.want, why: r ? r.why : 'no-result', ...(r && !r.ok && r.error ? { error: r.error } : {}) });
      p.resolve(null);
    });
    w.on('error', (e) => this.fail(w, 'error', e));
    w.on('exit', (code) => this.fail(w, 'exit', code));
    return w;
  }

  private fail(w: DeriveWorkerLike | null, why: string, detail?: unknown): void {
    if (w && this.w !== w) return;   // a worker already given up on
    this.failures++;
    this.w = null;
    this.sentRegistry = null;
    if (w) { try { w.terminate(); } catch { /* gone */ } }
    this.d.log?.({ kind: 'claims-derive-fallback', why, pending: this.pending.size, failures: this.failures, ...(detail !== undefined ? { detail: String(detail).slice(0, 200) } : {}) });
    if (this.failures >= (this.d.maxFailures ?? DERIVE_WORKER_MAX_FAILURES) && !this.disabled) {
      this.disabled = true;
      this.d.log?.({ kind: 'claims-derive-worker-disabled', failures: this.failures });
    }
    this.settleAll(null);
  }

  /** 106: the held jobs settle one per turn (the first after one turn); the drain ends one turn after the last. */
  private settleAll(r: null): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) this.clearTimer(p.timer);
    if (!all.length) return;
    // No drain is running here: run() waits for a drain before it posts, so pending is empty during one.
    this.drain = new Promise<void>((done) => {
      const next = (): void => {
        const p = all.shift();
        if (!p) { this.drain = null; done(); return; }
        p.resolve(r);
        this.yieldTurn(next);
      };
      this.yieldTurn(next);
    });
  }
}
