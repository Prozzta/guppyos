/**
 * CLAIMS-90 M5: the derived writer's git port over one repository (read only: cat-file, log,
 * merge-base, for-each-ref, show). Answers are cached for the life of the object; `prefetch`
 * resolves many shas with one `git cat-file --batch-check` and one `git log --no-walk`.
 * Every git call is killed after `timeoutMs` and rejects (Jim's M5 audit SHOULD c): the run fails,
 * DerivedLive logs claims-derived-failed and the next pass tries again, so a hung git (a lock, a
 * network remote) never stalls the later passes.
 */
import { execFile, spawn } from 'node:child_process';
import type { GitPort, TagLike } from './derivedFacts';

const SHA_RE = /^[0-9a-f]{7,40}$/;
export const GIT_TIMEOUT_MS = 45_000;

export interface DerivedGitOptions {
  timeoutMs?: number;
  /** The program and its leading args (default git); tests swap in a process that hangs. */
  command?: readonly string[];
}

const timedOut = (args: readonly string[], ms: number) => new Error(`git ${args[0] ?? ''} timed out after ${ms} ms`);

function git(repo: string, args: string[], o: Required<DerivedGitOptions>): Promise<{ code: number; out: string }> {
  const [bin, ...pre] = o.command;
  return new Promise((resolve, reject) => {
    execFile(bin, [...pre, '-C', repo, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: o.timeoutMs, killSignal: 'SIGKILL' }, (err, out) => {
      if (err && (err as { killed?: boolean }).killed) { reject(timedOut(args, o.timeoutMs)); return; }
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, out: out ?? '' });
    });
  });
}

function gitStdin(repo: string, args: string[], input: string, o: Required<DerivedGitOptions>): Promise<string> {
  const [bin, ...pre] = o.command;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [...pre, '-C', repo, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let late = false;
    const timer = setTimeout(() => { late = true; p.kill('SIGKILL'); reject(timedOut(args, o.timeoutMs)); }, o.timeoutMs);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => { out += d; });
    p.on('error', () => { clearTimeout(timer); if (!late) resolve(''); });
    p.on('close', () => { clearTimeout(timer); if (!late) resolve(out); });
    p.stdin.on('error', () => { /* the process is gone; close resolves */ });
    p.stdin.end(input);
  });
}

export class DerivedGit implements GitPort {
  private readonly commits = new Map<string, string | null>();
  private readonly times = new Map<string, number>();
  private readonly ancestry = new Map<string, boolean>();
  private readonly o: Required<DerivedGitOptions>;
  constructor(readonly repo: string, opts: DerivedGitOptions = {}) {
    this.o = { timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS, command: opts.command ?? ['git'] };
  }

  /** Whether the folder answers as a git repository. */
  async ok(): Promise<boolean> { return (await git(this.repo, ['rev-parse', '--git-dir'], this.o)).code === 0; }

  async prefetch(shas: readonly string[]): Promise<void> {
    const want = [...new Set(shas.filter((s) => SHA_RE.test(s) && !this.commits.has(s)))];
    if (want.length === 0) return;
    const out = await gitStdin(this.repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${want.join('\n')}\n`, this.o);
    const lines = out.split('\n');
    // One output line per input line, in order: "<full> <type>", "<sha> missing" or "<sha> ambiguous".
    want.forEach((s, i) => {
      const m = /^([0-9a-f]{40}) (\w+)$/.exec(lines[i] ?? '');
      this.commits.set(s, m && m[2] === 'commit' ? m[1] : null);
    });
    const full = [...new Set([...this.commits.values()].filter((v): v is string => !!v && !this.times.has(v)))];
    for (let i = 0; i < full.length; i += 500) {
      const r = await git(this.repo, ['log', '--no-walk=unsorted', '--format=%H %ct', ...full.slice(i, i + 500)], this.o);
      for (const line of r.out.split('\n')) { const m = /^([0-9a-f]{40}) (\d+)$/.exec(line); if (m) this.times.set(m[1], Number(m[2])); }
    }
  }

  async commitOf(sha: string): Promise<string | null> {
    if (!SHA_RE.test(sha)) return null;
    if (!this.commits.has(sha)) await this.prefetch([sha]);
    return this.commits.get(sha) ?? null;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    const k = `${a}..${b}`;
    const hit = this.ancestry.get(k);
    if (hit !== undefined) return hit;
    const v = (await git(this.repo, ['merge-base', '--is-ancestor', a, b], this.o)).code === 0;
    this.ancestry.set(k, v);
    return v;
  }

  async time(commit: string): Promise<number> {
    if (!this.times.has(commit)) {
      const r = await git(this.repo, ['show', '-s', '--format=%ct', commit], this.o);
      this.times.set(commit, Number(r.out.trim()) || 0);
    }
    return this.times.get(commit) ?? 0;
  }

  /** Every tag: its name, the commit it names (an annotated tag peeled) and its date. */
  async tags(): Promise<TagLike[]> {
    const r = await git(this.repo, ['for-each-ref', '--format=%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)', 'refs/tags'], this.o);
    const out: TagLike[] = [];
    for (const line of r.out.split('\n')) {
      const [name, type, obj, peeled, date] = line.split('\t');
      if (!name) continue;
      const commit = type === 'tag' ? peeled : obj;
      if (commit && /^[0-9a-f]{40}$/.test(commit)) out.push({ name, commit, ...(date ? { date } : {}) });
    }
    return out;
  }

  /** A file's text at a ref, or null. */
  async show(ref: string, file: string): Promise<string | null> {
    const r = await git(this.repo, ['show', `${ref}:${file}`], this.o);
    return r.code === 0 ? r.out : null;
  }
}
