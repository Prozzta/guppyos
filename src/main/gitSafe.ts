import { devNull } from 'node:os';

/**
 * GIT-RUN-HARDEN-108: what every git call the app makes on its own is run with, so that reading a
 * repository never runs a program that repository names. A repo's config (and a hostile folder can
 * carry one) can name a program for the file-system monitor, for hooks, for the pager, for signature
 * checks and for diff output; each is switched off here. Nothing a person runs in a terminal is
 * touched: this is only for the app's own calls.
 *
 * Not covered: clean/smudge filters named in a repo's config (git has no switch that turns them all
 * off, and turning one off shows its files as changed).
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

/** The most one git call may write before it is stopped (the size derivedGit already allowed). */
export const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
