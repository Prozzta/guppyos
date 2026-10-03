import { spawn } from 'node:child_process';
import type { ClaimRec, ClaimsState, LedgerRec } from '../../shared/claims';

export interface ClaimsWorldSnapshot {
  commits: Map<string, boolean>;
  changedFiles: Map<string, boolean>;
}

/** One git call: stdout on exit 0, else null (never throws). `timeoutMs` bounds this child. */
export type GitRunner = (cwd: string, args: string[], input: string | undefined, timeoutMs: number) => Promise<string | null>;

/** S-2 (Jim, CL-W4-INT): at most this many git children at once per snapshot. */
export const WORLD_GIT_CONCURRENCY = 4;
/** S-2: the whole snapshot's deadline; whatever is left after it is unknown (no flag). */
export const WORLD_SNAPSHOT_DEADLINE_MS = 1_500;
const GIT_CHILD_TIMEOUT_MS = 5_000;

export const runGit: GitRunner = (cwd, args, input, timeoutMs) => new Promise((resolve) => {
  let child;
  try { child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { resolve(null); return; }
  let stdout = '';
  let settled = false;
  const finish = (value: string | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
  const timer = setTimeout(() => { child.kill(); finish(null); }, Math.max(1, Math.min(GIT_CHILD_TIMEOUT_MS, timeoutMs)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > 1_000_000) { child.kill(); finish(null); } });
  child.on('error', () => finish(null));
  child.on('close', (code: number | null) => finish(code === 0 ? stdout : null));
  child.stdin.on('error', () => { /* the child exited first */ });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
});

export interface WorldSnapshotOptions {
  git?: GitRunner;
  deadlineMs?: number;
  concurrency?: number;
  now?: () => number;
}

/** Resolve only cited refs; absent map entries deliberately mean unknown to synchronous W2 callbacks.
 *  Bounded (S-2): at most `concurrency` git children at once, and nothing starts after the deadline. */
export async function buildClaimsWorldSnapshot(records: LedgerRec[], state: ClaimsState, cwd: string, o: WorldSnapshotOptions = {}): Promise<ClaimsWorldSnapshot> {
  const git = o.git ?? runGit;
  const now = o.now ?? Date.now;
  const deadline = now() + (o.deadlineMs ?? WORLD_SNAPSHOT_DEADLINE_MS);
  const left = (): number => deadline - now();
  const claims = records.filter((r): r is ClaimRec => r.t === 'claim' && state.claims[r.id]?.status === 'live');
  const commits = [...new Set(claims.flatMap(c => c.refs ?? []).filter(r => r.type === 'commit').map(r => r.value).filter(s => /^[0-9a-f]{7,64}$/i.test(s)))];
  const fileSince = new Map<string, string>();
  for (const claim of claims) for (const ref of claim.refs ?? []) {
    const since = state.claims[claim.id]?.lastAt;
    if (ref.type !== 'file' || !since || !Number.isFinite(Date.parse(since))) continue;
    const key = `${ref.value}\0${since}`;
    fileSince.set(key, since);
  }
  const snapshot: ClaimsWorldSnapshot = { commits: new Map(), changedFiles: new Map() };
  if (commits.length && left() > 0) {
    const out = await git(cwd, ['cat-file', '--batch-check'], `${commits.join('\n')}\n`, left());
    if (out !== null) {
      const lines = out.trimEnd().split('\n');
      if (lines.length === commits.length) commits.forEach((sha, i) => {
        // `<sha> commit <size>` exists; `<sha> missing` does not; anything else (a short sha that is
        // `ambiguous`, another object type) is unknown: no entry, so no stale-ref flag (Jim's note).
        const type = lines[i].split(' ')[1];
        if (type === 'commit') snapshot.commits.set(sha, true);
        else if (type === 'missing') snapshot.commits.set(sha, false);
      });
    }
  }
  const queue = [...fileSince];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (left() <= 0) return;   // past the deadline: the rest stays unknown
      const [key, since] = next;
      const file = key.slice(0, key.indexOf('\0'));
      const out = await git(cwd, ['log', `--since=${since}`, '--format=%H', '--', file], undefined, left());
      if (out !== null) snapshot.changedFiles.set(key, !!out.trim());
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? WORLD_GIT_CONCURRENCY, queue.length)) }, worker));
  return snapshot;
}
