/**
 * SYNC-CHILD-CALLS (1.1.73): the ONE place main resolves a bare command name to an executable.
 *
 * Every lookup here is ASYNC (execFile, never a *Sync child API): a `where` / login-shell `which`
 * used to run as spawnSync on the main thread, ~80 ms per call on Windows (seconds on a slow
 * zshrc), on every agent spawn/restart, every hidden check session and every setup-panel open.
 *
 * Two entry points share the same primitives (execP, the platform lookup):
 * - resolveCliAsync(d, bin): the models-refresh adapters' resolver (Jim, REFRESH-MODELS). Moved
 *   here from providerModels.ts VERBATIM: uncached, `where` / `$SHELL -lc command -v`, a string or
 *   null. providerModels re-exports it, so its adapters behave exactly as before.
 * - resolveCommandAsync(command): the app's resolver (agent spawn, the missing-CLI check, hidden
 *   claude, codex remote, the setup catalog). Spawn-grade: on Windows it takes the first
 *   PATHEXT-eligible `where` hit (never an extensionless npm sh-shim); on POSIX it asks the user's
 *   INTERACTIVE login shell (fenced, so rc-file chatter cannot poison it), because nvm/asdf/brew
 *   PATH edits live in .zshrc. CACHED, misses included:
 *     * a hit is re-validated with exists() on every use (uninstall/update -> re-probe);
 *     * a miss is trusted for MISS_TTL_MS (60 s), then re-checked;
 *     * invalidateCommandCache(command?) drops one entry or all of them. The missing-CLI
 *       auto-install calls it when its installer exits, so the relaunch sees the new binary;
 *     * concurrent callers of one name share ONE lookup; a lookup that started before an
 *       invalidate is never written back over it.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// ── Deps (injectable for tests) ─────────────────────────────────────────────────────────

export type ExecErr = Error & { code?: unknown; killed?: boolean };
/** child_process.execFile in the app. It returns the child (its pid is needed to kill a Windows
 *  process TREE on timeout). `timeout: 0` means no built-in timeout (the caller times the run). */
export type ResolverExec = (file: string, args: string[], opts: { timeout: number; windowsHide: true; maxBuffer: number; windowsVerbatimArguments?: boolean }, cb: (err: ExecErr | null, stdout: string) => void) => { pid?: number } | void;
export interface ResolverDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: ResolverExec;
  exists: (p: string) => boolean;
}

/** The live process: execFile (async), existsSync, and the current platform/env. */
export function nodeResolverDeps(): ResolverDeps {
  return {
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    exec: (file, args, opts, cb) => execFile(file, args, opts, (err, stdout) => cb(err, String(stdout ?? '')))
  };
}

/** How long a tree kill may take before the time box gives up waiting for it. */
export const TREE_KILL_TIMEOUT_MS = 10_000;

/**
 * execFile as a promise that never rejects. On failure `out` keeps whatever the child printed
 * (execFile hands stdout to the callback even with an error; empty after a time-box kill).
 *
 * MODELS-173-AUDIT (Jim/Dwight, moved here from providerModels.ts): on Windows the time box must end
 * the whole PROCESS TREE. execFile's own timeout kills only the direct child, and for an npm .cmd
 * shim that is cmd.exe: its node/codex descendants would keep running, orphaned. So on win32 this
 * times the run itself; on expiry it awaits an ASYNC `taskkill /PID <pid> /T /F` on the still-live
 * child (the tree goes with it) and then reports a timeout. Races are tolerated: the process may
 * exit on its own first, and taskkill may fail. POSIX keeps execFile's timeout.
 */
export const execP = (d: ResolverDeps, file: string, args: string[], timeout: number, maxBuffer: number, verbatim = false): Promise<{ stdout: string } | { err: ExecErr; out: string }> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (r: { stdout: string } | { err: ExecErr; out: string }): void => { if (!settled) { settled = true; resolve(r); } };
    const ownTimer = d.platform === 'win32';
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Once the time box fires, the result IS a timeout: the killed process's own exit (exit 1) can
    // arrive before taskkill answers and must not be reported instead.
    let timingOut = false;
    try {
      const child = d.exec(file, args, { timeout: ownTimer ? 0 : timeout, windowsHide: true, maxBuffer, ...(verbatim ? { windowsVerbatimArguments: true } : {}) },
        (err, stdout) => { if (timer) clearTimeout(timer); if (timingOut) return; done(err ? { err, out: String(stdout ?? '') } : { stdout: String(stdout) }); });
      if (ownTimer) {
        timer = setTimeout(() => {
          if (settled) return;
          timingOut = true;
          const pid = child && typeof child.pid === 'number' ? child.pid : null;
          const timedOut = Object.assign(new Error('timeout'), { killed: true }) as ExecErr;
          if (!pid) { done({ err: timedOut, out: '' }); return; }
          // Await the tree kill (bounded), then report the timeout; an error or race is not fatal.
          let killDone = false;
          const finish = (): void => { if (!killDone) { killDone = true; done({ err: timedOut, out: '' }); } };
          try {
            d.exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: TREE_KILL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, () => finish());
          } catch { finish(); }
          setTimeout(finish, TREE_KILL_TIMEOUT_MS + 1000);
        }, timeout);
      }
    } catch (e) {
      if (timer) clearTimeout(timer);
      done({ err: e as ExecErr, out: '' });
    }
  });

/** A plain executable name — the only shape resolved against the user's PATH. A resolver may
 *  interpolate this token into a shell (`$SHELL -ilc "… which <it> …"`), so it is constrained to
 *  characters that are unambiguously part of a binary name (`[A-Za-z0-9._+-]`); anything else is
 *  not a command name and is refused rather than resolved. Callers early-return real paths
 *  (containing `/` or `\`) before this. */
export function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(command);
}

// ── Jim's models-refresh resolver (moved verbatim from providerModels.ts) ────────────────

/** Where is `bin`? `where` (Windows) / `command -v` in a login shell, then the usual install dirs. */
export async function resolveCliAsync(d: ResolverDeps, bin: string): Promise<string | null> {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(bin)) return null;
  const pick = (out: string, last: boolean): string | null => {
    let lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (d.platform === 'win32') lines = [...lines.filter((l) => /\.(exe|cmd|bat)$/i.test(l)), ...lines.filter((l) => !/\.(exe|cmd|bat)$/i.test(l))];
    for (const p of last ? lines.reverse() : lines) if (d.exists(p)) return p;
    return null;
  };
  if (d.platform === 'win32') {
    const r = await execP(d, 'where', [bin], 3000, 64 * 1024);
    if ('stdout' in r) { const p = pick(r.stdout, false); if (p) return p; }
    const la = d.env.LOCALAPPDATA ?? ''; const ad = d.env.APPDATA ?? '';
    for (const c of [`${la}\\${bin}\\bin\\${bin}.exe`, `${ad}\\npm\\${bin}.cmd`]) if (d.exists(c)) return c;
    return null;
  }
  const r = await execP(d, d.env.SHELL || '/bin/sh', ['-lc', `command -v ${bin}`], 3000, 64 * 1024);
  if ('stdout' in r) { const p = pick(r.stdout, true); if (p) return p; }
  const home = d.env.HOME ?? '';
  for (const c of [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`, `${home}/.local/bin/${bin}`]) if (d.exists(c)) return c;
  return null;
}

// ── The interactive login shell (POSIX), async ───────────────────────────────────────────

/** Run `script` in the user's INTERACTIVE login shell and return only what the script itself
 *  printed. An interactive shell is required to pick up nvm/asdf/brew PATH edits, but it also
 *  runs the user's rc files, which are free to print (a zsh session-save plugin emits
 *  `Restored session: <date>` BEFORE the script's output). Fencing the output between two markers
 *  makes rc-file chatter impossible to mistake for a result. Null when the shell fails or the
 *  fence never appears. Uncached. */
export async function captureFromLoginShellAsync(script: string, d: ResolverDeps = nodeResolverDeps()): Promise<string | null> {
  const mark = '__MD_SHELL_FENCE__';
  const r = await execP(d, d.env.SHELL ?? '/bin/zsh', ['-ilc', `printf %s ${mark}; ${script}; printf %s ${mark}`], 3000, 1024 * 1024);
  // spawnSync handed back stdout even on a non-zero exit (an rc file that fails its last
  // command); execFile's error carries it too, so a fenced result still counts.
  const out = 'stdout' in r ? r.stdout : r.out;
  const start = out.indexOf(mark);
  const end = out.lastIndexOf(mark);
  if (start < 0 || end <= start) return null;
  return out.slice(start + mark.length, end);
}

// ── The app's (spawn-grade) lookup ───────────────────────────────────────────────────────

export interface ResolvedCommand {
  /** The best path; the bare command when nothing was found (a spawn would then ENOENT). */
  path: string;
  /** Whether an existing executable was actually located — what the missing-CLI path keys on. */
  found: boolean;
}

/** One uncached lookup (the former PtyManager.resolveCommandUncached / shellEnv.resolveCommand). */
export async function lookupCommandAsync(command: string, d: ResolverDeps = nodeResolverDeps()): Promise<ResolvedCommand> {
  // Already an absolute/relative path (Unix `/` or Windows `\`) — pass through; `found`
  // reflects whether that path actually exists on disk.
  if (command.includes('/') || command.includes('\\')) return { path: command, found: d.exists(command) };
  // Only a plain command name is resolved against PATH. Anything else is refused here so it
  // never reaches `which`/`where`; `found:false` makes the caller treat it as missing.
  if (!isSafeCommandName(command)) return { path: command, found: false };
  if (d.platform === 'win32') {
    // `where` can return MULTIPLE matches in PATH order; the first is often an EXTENSIONLESS
    // npm shim (bare `claude`, a POSIX sh script). Skip extensionless hits and take the first
    // PATHEXT-eligible one (.CMD/.BAT/.EXE/…). No `shell:true`: `command` is proven
    // metacharacter-free above, and running where.exe directly keeps cmd.exe out of the loop.
    const r = await execP(d, 'where', [command], 3000, 64 * 1024);
    if ('stdout' in r) {
      const lines = r.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pathExts = (d.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
      const isExecutable = (p: string): boolean => {
        const dot = p.lastIndexOf('.');
        const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
        if (dot <= sep) return false; // no extension on the basename
        return pathExts.includes(p.slice(dot).toUpperCase());
      };
      const exe = lines.find((p) => isExecutable(p) && d.exists(p));
      if (exe) return { path: exe, found: true };
    }
    // Common Windows install locations (npm global = %APPDATA%\npm\<cmd>.cmd).
    const appData = d.env.APPDATA ?? '';
    const localAppData = d.env.LOCALAPPDATA ?? '';
    const home = d.env.USERPROFILE ?? d.env.HOME ?? '';
    const winCandidates = [
      `${appData}\\npm\\${command}.cmd`,
      `${appData}\\npm\\${command}`,
      `${localAppData}\\Programs\\claude\\${command}.exe`,
      `${home}\\.claude\\local\\${command}.cmd`,
      `${home}\\.claude\\local\\${command}`
    ];
    for (const c of winCandidates) if (d.exists(c)) return { path: c, found: true };
    return { path: command, found: false };
  }
  // macOS / Linux — `which` against an interactive shell so we pick up nvm/asdf/brew paths.
  const which = await captureFromLoginShellAsync(`which ${command}`, d);
  if (which) {
    const path = which.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (path && d.exists(path)) return { path, found: true };
  }
  const home = d.env.HOME ?? '';
  const candidates = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
    `${home}/.local/bin/${command}`,
    `${home}/.claude/local/${command}`,
    `${home}/.volta/bin/${command}`
  ];
  for (const c of candidates) if (d.exists(c)) return { path: c, found: true };
  return { path: command, found: false };
}

// ── The cache ────────────────────────────────────────────────────────────────────────────

/** How long a MISS is trusted before it is looked up again. */
export const MISS_TTL_MS = 60_000;

export interface CommandResolverOptions {
  deps?: () => ResolverDeps;
  now?: () => number;
  missTtlMs?: number;
  lookup?: (command: string, d: ResolverDeps) => Promise<ResolvedCommand>;
}

export class CommandResolver {
  private readonly deps: () => ResolverDeps;
  private readonly now: () => number;
  private readonly missTtlMs: number;
  private readonly lookup: (command: string, d: ResolverDeps) => Promise<ResolvedCommand>;
  private readonly cache = new Map<string, ResolvedCommand & { at: number }>();
  private readonly inFlight = new Map<string, Promise<ResolvedCommand>>();
  /** Bumped by invalidate() (all / one name): a lookup started before it is not cached. */
  private generation = 0;
  private readonly nameGeneration = new Map<string, number>();
  /** How many real lookups ran (diagnostics / tests). */
  lookups = 0;

  constructor(opts: CommandResolverOptions = {}) {
    this.deps = opts.deps ?? nodeResolverDeps;
    this.now = opts.now ?? Date.now;
    this.missTtlMs = opts.missTtlMs ?? MISS_TTL_MS;
    this.lookup = opts.lookup ?? lookupCommandAsync;
  }

  resolve(command: string): Promise<ResolvedCommand> {
    const d = this.deps();
    // A path or an unsafe name costs no child process: answered directly, never cached.
    if (command.includes('/') || command.includes('\\') || !isSafeCommandName(command)) {
      return lookupCommandAsync(command, d);
    }
    const hit = this.cache.get(command);
    if (hit) {
      if (hit.found ? d.exists(hit.path) : this.now() - hit.at < this.missTtlMs) {
        return Promise.resolve({ path: hit.path, found: hit.found });
      }
      this.cache.delete(command);
    }
    const running = this.inFlight.get(command);
    if (running) return running;
    const gen = this.generation;
    const nameGen = this.nameGeneration.get(command) ?? 0;
    this.lookups += 1;
    const p = this.lookup(command, d)
      .catch((): ResolvedCommand => ({ path: command, found: false }))
      .then((res) => {
        if (this.inFlight.get(command) === p) this.inFlight.delete(command);
        if (gen === this.generation && nameGen === (this.nameGeneration.get(command) ?? 0)) {
          this.cache.set(command, { ...res, at: this.now() });
        }
        return { path: res.path, found: res.found };
      });
    this.inFlight.set(command, p);
    return p;
  }

  /** Forget one command (or every command): the next resolve looks it up again. */
  invalidate(command?: string): void {
    if (command === undefined) { this.generation += 1; this.cache.clear(); this.inFlight.clear(); return; }
    this.nameGeneration.set(command, (this.nameGeneration.get(command) ?? 0) + 1);
    this.cache.delete(command);
    this.inFlight.delete(command);
  }
}

/** The app-wide resolver every main-process caller shares. */
export const commandResolver = new CommandResolver();

/** Resolve a bare command (e.g. 'claude', 'agy') for THIS user: `{ path, found }`, async, cached
 *  (misses for MISS_TTL_MS). `path` is the bare command when `found` is false. */
export function resolveCommandAsync(command: string): Promise<ResolvedCommand> {
  return commandResolver.resolve(command);
}

/** Drop the cached answer for `command` (or all) — call it after something installs a CLI or
 *  changes PATH. */
export function invalidateCommandCache(command?: string): void {
  commandResolver.invalidate(command);
}
