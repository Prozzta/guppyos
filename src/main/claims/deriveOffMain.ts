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
}

export const DERIVE_WORKER_TIMEOUT_MS = 30_000;
export const DERIVE_WORKER_MAX_FAILURES = 3;

type Ok = Extract<DeriveJobResult, { ok: true }>;
interface Pending { resolve: (r: Ok | null) => void; timer: unknown; agentId: string; want: string }

export class DeriveOffMain {
  private w: DeriveWorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sentRegistry: KeyRegistry | null = null;
  private failures = 0;
  private disabled = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly d: DeriveOffMainDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** Whether jobs go to the worker (false once it failed `maxFailures` times). */
  get enabled(): boolean { return !this.disabled; }

  run(job: Omit<DeriveJob, 'registry'> & { registry: KeyRegistry }): Promise<Ok | null> {
    if (this.disabled) return Promise.resolve(null);
    const w = this.worker();
    if (!w) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<Ok | null>((resolve) => {
      const timer = this.setTimer(() => this.fail(w, 'timeout'), this.d.timeoutMs ?? DERIVE_WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, agentId: job.agentId, want: job.want });
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
      if (r && r.ok) { p.resolve(r); return; }
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

  private settleAll(r: null): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { this.clearTimer(p.timer); p.resolve(r); }
  }
}
