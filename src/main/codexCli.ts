/**
 * CODEX-WAKE-161 addendum (Jim, CODEX-WAKE-ROOTCAUSE.md): which Codex CLI the harness is
 * running. Every Codex agent spawns whatever global `codex` is installed, so a global npm update
 * (0.154.0 -> 0.157.1 at 06:32Z on 2026-09-27) silently changed every Codex agent at its next
 * respawn. This makes that visible, and gates the one flag that depends on the version.
 *
 *   readCodexVersion(cmd)   the installed CLI's version, read from its npm package.json (no
 *                           process is started), or null
 *   codexSupportsNoDaemon   `--no-daemon` exists from 0.157.0 (it pins the in-process app-server
 *                           each agent already runs, with no shared background server); an older
 *                           CLI would refuse the unknown flag and the agent would not start
 *   CodexVersionLog         a `codex-version` row at app start and at each Codex spawn, and a
 *                           `codex-version-changed` row when it differs from the last one seen
 *                           (persisted, so a change between app runs is caught too)
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export const CODEX_NO_DAEMON_SINCE = '0.157.0';
const PKG = join('@openai', 'codex', 'package.json');

export interface CodexFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf8') => string;
  realpathSync: (p: string) => string;
}
const realFs: CodexFs = { existsSync, readFileSync: (p, enc) => readFileSync(p, enc), realpathSync: (p) => realpathSync(p) };

/** Where the npm package of the `codex` at `commandPath` can live. Windows npm shims sit in the
 *  prefix dir beside `node_modules`; a POSIX bin is a symlink into `lib/node_modules`. */
export function codexPackageJsonCandidates(commandPath: string, fs: CodexFs = realFs): string[] {
  const out: string[] = [];
  const dir = dirname(commandPath);
  out.push(join(dir, 'node_modules', PKG));
  out.push(join(dir, '..', 'lib', 'node_modules', PKG));
  try {
    const real = fs.realpathSync(commandPath);
    const marker = `${sep}@openai${sep}codex${sep}`;
    const i = real.indexOf(marker);
    if (i >= 0) out.unshift(join(real.slice(0, i + marker.length), 'package.json'));
  } catch { /* not resolvable: the candidates above */ }
  return [...new Set(out)];
}

/** The installed Codex CLI's version (`x.y.z`), or null when it cannot be read. */
export function readCodexVersion(commandPath: string | null | undefined, fs: CodexFs = realFs): string | null {
  if (!commandPath) return null;
  for (const p of codexPackageJsonCandidates(commandPath, fs)) {
    try {
      if (!fs.existsSync(p)) continue;
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name !== '@openai/codex') continue;
      if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) return pkg.version;
    } catch { /* unreadable: try the next */ }
  }
  return null;
}

/** Compare `x.y.z` versions numerically (a pre-release suffix is ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Is the CLI KNOWN to have the flag (a readable version >= 0.157.0)? The layer-b runner's strict
 *  proof. The spawn itself uses codexNoDaemonGate, which also adds the flag for an unknown version. */
export function codexSupportsNoDaemon(version: string | null): boolean {
  return !!version && compareVersions(version, CODEX_NO_DAEMON_SINCE) >= 0;
}

export type CodexNoDaemonReason = 'supported' | 'version-unknown' | 'version-too-old';

/**
 * CODEX-NODAEMON-HARDENING (1.1.76): the spawn gate. Every Codex hive agent gets `--no-daemon`
 * unless its CLI is KNOWN to be older than 0.157.0. An unreadable version gets the flag too: without
 * it codex may start (or attach to) the shared app-server daemon, whose git child processes open
 * visible console windows (codex git_process.rs has no CREATE_NO_WINDOW), and a `codex resume` over a
 * daemon target is a "persistent resume" that skips --dangerously-bypass-hook-trust for the startup
 * hooks review (tui/src/lib.rs:1967-1972), i.e. a review screen nobody can answer. An old CLI that
 * rejects the flag fails to start, visibly; that is the lesser failure.
 */
export function codexNoDaemonGate(version: string | null): { noDaemon: boolean; reason: CodexNoDaemonReason } {
  if (!version) return { noDaemon: true, reason: 'version-unknown' };
  return compareVersions(version, CODEX_NO_DAEMON_SINCE) >= 0
    ? { noDaemon: true, reason: 'supported' }
    : { noDaemon: false, reason: 'version-too-old' };
}

export type CodexVersionCause = 'app-start' | 'spawn';

export class CodexVersionLog {
  private last: string | null | undefined;

  constructor(private readonly stateFile: string, private readonly log: (row: Record<string, unknown>) => void) {}

  private lastSeen(): string | null {
    if (this.last !== undefined) return this.last;
    try {
      const v = (JSON.parse(readFileSync(this.stateFile, 'utf8')) as { version?: unknown }).version;
      this.last = typeof v === 'string' ? v : null;
    } catch { this.last = null; }
    return this.last;
  }

  /** One `codex-version` row; plus `codex-version-changed` when it differs from the last seen. */
  note(version: string | null, path: string | null, cause: CodexVersionCause, agentId?: string): void {
    this.log({ kind: 'codex-version', version, path, cause, ...(agentId ? { agentId } : {}) });
    if (!version) return;
    const prev = this.lastSeen();
    if (prev === version) return;
    if (prev) this.log({ kind: 'codex-version-changed', from: prev, to: version, cause, ...(agentId ? { agentId } : {}) });
    this.last = version;
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({ version, at: new Date().toISOString() }), 'utf8');
    } catch { /* best-effort: next run compares against an older value, at worst */ }
  }
}
