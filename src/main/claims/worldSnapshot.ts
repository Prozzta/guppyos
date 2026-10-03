import { spawn } from 'node:child_process';
import type { ClaimRec, ClaimsState, LedgerRec } from '../../shared/claims';

export interface ClaimsWorldSnapshot {
  commits: Map<string, boolean>;
  changedFiles: Map<string, boolean>;
}

function git(cwd: string, args: string[], input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(null); }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > 1_000_000) { child.kill(); finish(null); } });
    child.on('error', () => finish(null));
    child.on('close', (code: number | null) => finish(code === 0 ? stdout : null));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Resolve only cited refs; absent map entries deliberately mean unknown to synchronous W2 callbacks. */
export async function buildClaimsWorldSnapshot(records: LedgerRec[], state: ClaimsState, cwd: string): Promise<ClaimsWorldSnapshot> {
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
  if (commits.length) {
    const out = await git(cwd, ['cat-file', '--batch-check'], `${commits.join('\n')}\n`);
    if (out !== null) {
      const lines = out.trimEnd().split('\n');
      if (lines.length === commits.length) commits.forEach((sha, i) => snapshot.commits.set(sha, lines[i].split(' ')[1] === 'commit'));
    }
  }
  await Promise.all([...fileSince].map(async ([key, since]) => {
    const file = key.slice(0, key.indexOf('\0'));
    const out = await git(cwd, ['log', `--since=${since}`, '--format=%H', '--', file]);
    if (out !== null) snapshot.changedFiles.set(key, !!out.trim());
  }));
  return snapshot;
}
