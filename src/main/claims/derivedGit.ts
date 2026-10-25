/**
 * CLAIMS-90 M5: the derived writer's git port over one repository (read only: cat-file, log,
 * merge-base, for-each-ref, show). Answers are cached for the life of the object; `prefetch`
 * resolves many shas with one `git cat-file --batch-check` and one `git log --no-walk`.
 */
import { execFile, spawn } from 'node:child_process';
import type { GitPort, TagLike } from './derivedFacts';

const SHA_RE = /^[0-9a-f]{7,40}$/;

function git(repo: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, out) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
      resolve({ code, out: out ?? '' });
    });
  });
}

function gitStdin(repo: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', repo, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
    p.stdin.end(input);
  });
}

export class DerivedGit implements GitPort {
  private readonly commits = new Map<string, string | null>();
  private readonly times = new Map<string, number>();
  private readonly ancestry = new Map<string, boolean>();
  constructor(readonly repo: string) {}

  /** Whether the folder answers as a git repository. */
  async ok(): Promise<boolean> { return (await git(this.repo, ['rev-parse', '--git-dir'])).code === 0; }

  async prefetch(shas: readonly string[]): Promise<void> {
    const want = [...new Set(shas.filter((s) => SHA_RE.test(s) && !this.commits.has(s)))];
    if (want.length === 0) return;
    const out = await gitStdin(this.repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${want.join('\n')}\n`);
    const lines = out.split('\n');
    // One output line per input line, in order: "<full> <type>", "<sha> missing" or "<sha> ambiguous".
    want.forEach((s, i) => {
      const m = /^([0-9a-f]{40}) (\w+)$/.exec(lines[i] ?? '');
      this.commits.set(s, m && m[2] === 'commit' ? m[1] : null);
    });
    const full = [...new Set([...this.commits.values()].filter((v): v is string => !!v && !this.times.has(v)))];
    for (let i = 0; i < full.length; i += 500) {
      const r = await git(this.repo, ['log', '--no-walk=unsorted', '--format=%H %ct', ...full.slice(i, i + 500)]);
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
    const v = (await git(this.repo, ['merge-base', '--is-ancestor', a, b])).code === 0;
    this.ancestry.set(k, v);
    return v;
  }

  async time(commit: string): Promise<number> {
    if (!this.times.has(commit)) {
      const r = await git(this.repo, ['show', '-s', '--format=%ct', commit]);
      this.times.set(commit, Number(r.out.trim()) || 0);
    }
    return this.times.get(commit) ?? 0;
  }

  /** Every tag: its name, the commit it names (an annotated tag peeled) and its date. */
  async tags(): Promise<TagLike[]> {
    const r = await git(this.repo, ['for-each-ref', '--format=%(refname:short)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)', 'refs/tags']);
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
    const r = await git(this.repo, ['show', `${ref}:${file}`]);
    return r.code === 0 ? r.out : null;
  }
}
