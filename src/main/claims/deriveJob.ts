/**
 * STARTUP-FREEZE-104 A19 (god 424399): derive and chunksFor off main. This module is pure and runs in the derive
 * worker thread (deriveWorker.ts); tests run it in-process too.
 *
 * Main keeps the MAC verify and the single writer. It hands the worker the segment paths of a ledger it has VERIFIED,
 * plus that read's head (the sha256 of its last line) and record count. The worker reads and parses the files itself
 * (posting 134k records costs main more than the derive: Andy's 10x measure), walks the sha256 prev chain from the
 * first line, and uses the records only when line `count` is exactly the verified head. The hash chain commits to
 * every line before it, so those records are byte for byte the ones main verified; anything else is 'stale' and
 * main derives in-process as before.
 *
 * The worker answers only what its caller needs, as one string (a string crosses threads as a copy, objects as a
 * clone that costs main hundreds of ms at 10x):
 *   - codes:  one status letter per record, in ledger order (STATUS_CODE; '-' for none). Main reads it by index
 *             against its own verified records, so it decodes no ids (an id list cost main 54-108 ms at 10x);
 *   - chunks: withParts(chunksFor(...)) as JSON, with the head and the count (the index sync).
 */
import { readFileSync } from 'node:fs';
import type { KeyRegistry, LedgerRec, Status } from '../../shared/claims';
import { sha256Hex } from './canonical';
import { chunksFor, withParts } from './chunks';
import { derive } from './derive';

export type DeriveWant = 'codes' | 'chunks';

export interface DeriveJob {
  want: DeriveWant;
  agentId: string;
  /** The agent's segment files, in ledger order. */
  files: string[];
  /** sha256 of the last verified line. */
  head: string;
  /** The verified record count. */
  count: number;
  /** The registry, or null: the one the worker kept from its last job (main sends it only when it changed). */
  registry: KeyRegistry | null;
  r4: boolean;
}

export type DeriveJobResult =
  | { ok: true; out: string; head?: string; count?: number }
  | { ok: false; why: 'stale' | 'no-registry' | 'error'; error?: string };

/** The first `count` records of `files` when line `count` is `head` and the prev chain holds up to it; else null. */
export function verifiedRecordsFromFiles(files: readonly string[], head: string, count: number, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): LedgerRec[] | null {
  if (count <= 0) return null;   // an empty head never matches: every line's hash is 64 hex
  const out: LedgerRec[] = [];
  let prev = '';
  for (const f of files) {
    for (const line of read(f).split('\n')) {
      if (!line) continue;
      let rec: LedgerRec;
      try { rec = JSON.parse(line) as LedgerRec; } catch { return null; }
      if (!rec || rec.prev !== prev) return null;
      prev = sha256Hex(line);
      out.push(rec);
      if (out.length === count) return prev === head ? out : null;
    }
  }
  return null;
}

/** One letter per status; '-' for a record that is not a claim or that derive gives no status. */
export const STATUS_CODE: Readonly<Record<Status, string>> = { live: 'L', superseded: 'S', 'superseded?': 'Q', retracted: 'R', purged: 'P' };
const CODE_STATUS: Readonly<Record<string, Status>> = { L: 'live', S: 'superseded', Q: 'superseded?', R: 'retracted', P: 'purged' };

/** Record i's status letter at index i: main reads it by index (no ids, no split, no Set on main). */
export function encodeCodes(records: readonly LedgerRec[], claims: Record<string, { status: Status }>): string {
  const out = new Array<string>(records.length);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const c = r.t === 'claim' ? claims[r.id] : undefined;
    out[i] = c ? STATUS_CODE[c.status] : '-';
  }
  return out.join('');
}
/** The status a letter stands for; undefined for '-' (or anything else). */
export function statusOfCode(code: string): Status | undefined {
  return CODE_STATUS[code];
}

/** One job, as the worker runs it. `kept` is the registry from the previous job (null on the first). */
export function runDeriveJob(job: DeriveJob, kept: KeyRegistry | null, read?: (f: string) => string): DeriveJobResult {
  const registry = job.registry ?? kept;
  if (!registry) return { ok: false, why: 'no-registry' };
  const records = verifiedRecordsFromFiles(job.files, job.head, job.count, read);
  if (!records) return { ok: false, why: 'stale' };
  const state = derive(records, registry, { r4: job.r4 });
  if (job.want === 'codes') return { ok: true, out: encodeCodes(records, state.claims), count: records.length };
  const chunks = withParts(chunksFor(records, state));
  // derive's ledgerHead is the last record's mac (records is never empty here): the head the in-process sync sends.
  const head = state.ledgerHead;
  return { ok: true, out: JSON.stringify(chunks), head, count: chunks.length };
}
