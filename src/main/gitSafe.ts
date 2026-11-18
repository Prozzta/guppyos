import { execFile } from 'node:child_process';
import { devNull } from 'node:os';

/**
 * GIT-RUN-HARDEN-108: what every git call the app makes on its own is run with, so that reading a
 * repository never runs a program that repository names. A repo's config (and a hostile folder can
 * carry one) can name a program for the file-system monitor, for hooks, for the pager, for signature
 * checks and for diff output; each is switched off here. Nothing a person runs in a terminal is
 * touched: this is only for the app's own calls.
 *
 * Clean, smudge and process filters have no such switch, so gitSafeCall reads which filter drivers
 * the repo's own config defines and sets those back to what the person's config says (see below).
 */
const SAFE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // Run by `status` and `diff` to ask what changed.
  ['core.fsmonitor', 'false'],
  // Hooks are looked up in this folder; nothing can be in the null device. Run by `worktree add`, `switch`.
  ['core.hooksPath', devNull],
  ['core.pager', 'cat'],
  // With this on, `log` and `show` run the configured gpg program on every signed commit.
  ['log.showSignature', 'false'],
];

/** Subcommands that write diffs or file content: no external diff program, no text conversion program. */
const NO_PROGRAM_FLAGS = ['--no-ext-diff', '--no-textconv'];
const DIFF_WRITERS = new Set(['diff', 'log', 'show', 'diff-tree']);

/** The `-c key=value` options that go before the subcommand. */
export function gitSafeConfigArgs(): string[] {
  return SAFE_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

/** `args` (subcommand first) with the flags that keep that subcommand from running a diff program. */
export function gitSafeCommand(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  if (sub === undefined) return [];
  return DIFF_WRITERS.has(sub) ? [sub, ...NO_PROGRAM_FLAGS, ...rest] : [sub, ...rest];
}

/** The full argument list for `git`, for a call whose `args` start with the subcommand. */
export function gitSafeArgs(args: readonly string[]): string[] {
  return [...gitSafeConfigArgs(), ...gitSafeCommand(args)];
}

/** Where git reads its config files from is the launching environment's choice, not a repo's: kept. */
const KEPT = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);

/**
 * The environment for a git child: the app's own, without the GIT_* variables that point git at
 * another repository, index or program (GIT_DIR, GIT_WORK_TREE, GIT_EXTERNAL_DIFF, GIT_CONFIG_COUNT
 * and the rest), and with terminal prompts off: nobody is there to answer one.
 */
export function gitSafeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^GIT_/i.test(k) && !KEPT.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Subcommands that only read the object store and refs. They never turn a file in the work tree
 * into a blob or back, so they never run a filter driver. Anything not listed is taken to run one.
 */
const OBJECT_ONLY = new Set(['rev-parse', 'rev-list', 'merge-base', 'for-each-ref', 'diff-tree', 'log', 'show', 'branch', 'cat-file']);
const ASKS_FOR_FILTERS = new Set(['--filters', '--textconv']);

/** Whether this call can run a clean, smudge or process filter. */
export function gitRunsFilters(args: readonly string[]): boolean {
  const sub = args[0];
  if (sub === undefined || !OBJECT_ONLY.has(sub)) return true;
  return sub === 'cat-file' && args.some((a) => ASKS_FOR_FILTERS.has(a));
}

const FILTER_KEYS = '^filter\\..*\\.(clean|smudge|process|required)$';
const FILTER_VARS = ['clean', 'smudge', 'process', 'required'] as const;
/** Config the person or the machine set. Every other scope (local, worktree, a file either includes) is the repo's. */
const OUTER_SCOPES = new Set(['system', 'global']);

/**
 * From `git config --show-scope --show-origin -z --get-regexp` output (records of scope, origin,
 * "key\nvalue"), the settings that take every filter driver the repo defines back to what the outer
 * config says: its value there, or no program when it has none. A driver only the outer config
 * defines (Git LFS as it is normally installed) is not in the result and stays as it is.
 *
 * `process` is the one setting with no neutral value: set but empty, it also stops the driver's
 * clean and smudge programs. So it is only written when the outer config has one (its value) or
 * when the repo set one the outer config has not; that last driver is then off as a whole, and
 * not required, which is the safe side of a repo adding a program to the person's own driver.
 */
export function repoFilterOverrides(listing: string): Array<[string, string]> {
  const parts = listing.split('\0');
  const outer = new Map<string, Map<string, string>>();
  const fromRepo = new Map<string, Set<string>>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i];
    const nl = parts[i + 2].indexOf('\n');
    const key = nl < 0 ? parts[i + 2] : parts[i + 2].slice(0, nl);
    const value = nl < 0 ? 'true' : parts[i + 2].slice(nl + 1);
    const dot = key.lastIndexOf('.');
    const driver = key.slice('filter.'.length, dot);
    if (!OUTER_SCOPES.has(scope)) {
      if (!fromRepo.has(driver)) fromRepo.set(driver, new Set());
      fromRepo.get(driver)!.add(key.slice(dot + 1));
      continue;
    }
    if (!outer.has(driver)) outer.set(driver, new Map());
    outer.get(driver)!.set(key.slice(dot + 1), value);
  }
  const out: Array<[string, string]> = [];
  for (const [driver, set] of fromRepo) {
    const mine = outer.get(driver);
    const off = set.has('process') && !mine?.has('process');
    for (const v of FILTER_VARS) {
      if (v === 'process' && !off && !mine?.has('process')) continue;
      if (v === 'required') out.push([`filter.${driver}.required`, off ? 'false' : mine?.get(v) ?? 'false']);
      else out.push([`filter.${driver}.${v}`, mine?.get(v) ?? '']);
    }
  }
  return out;
}

function readFilterConfig(cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...gitSafeConfigArgs(), 'config', '--show-scope', '--show-origin', '-z', '--includes', '--get-regexp', FILTER_KEYS],
      { cwd, env, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        // Exit 1 is git's answer for "no such key".
        if (!err) { resolve(out); return; }
        if ((err as { code?: unknown }).code === 1) { resolve(''); return; }
        reject(new Error(`git could not list the repo's filter drivers, so the call was not made (${err.message.split('\n')[0]})`));
      });
  });
}

/**
 * The arguments and environment for one git call in `cwd`. For a call that can run a filter, the
 * repo's config is read first (a read that runs nothing) and each filter driver the repo defines is
 * overridden through GIT_CONFIG_COUNT, which takes any driver name. Rejects when that read fails:
 * the call is then not made.
 */
export async function gitSafeCall(cwd: string, args: readonly string[], timeoutMs = 5000): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const env = gitSafeEnv();
  if (gitRunsFilters(args)) {
    const pairs = repoFilterOverrides(await readFilterConfig(cwd, env, timeoutMs));
    if (pairs.length > 0) env.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  }
  return { args: gitSafeArgs(args), env };
}

/** The most one git call may write before it is stopped (the size derivedGit already allowed). */
export const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
