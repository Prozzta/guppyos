/**
 * STARTUP-FREEZE-104 A19: the derive worker thread's entry (built as out/main/claimsDeriveWorker.js; main starts it
 * through DeriveOffMain). One job at a time, in the order main posts them. See deriveJob.ts.
 */
import { parentPort } from 'node:worker_threads';
import type { KeyRegistry } from '../../shared/claims';
import { runDeriveJob, type DeriveJob } from './deriveJob';

let kept: KeyRegistry | null = null;
parentPort?.on('message', (msg: { id: number; job: DeriveJob }) => {
  let result;
  try {
    if (msg.job.registry) kept = msg.job.registry;
    result = runDeriveJob(msg.job, kept);
  } catch (e) {
    result = { ok: false, why: 'error', error: String(e).slice(0, 200) };
  }
  parentPort?.postMessage({ id: msg.id, result });
});
