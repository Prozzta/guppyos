/**
 * RESOLVER-TIMEOUT-MISS (1.1.76): what each caller does with a CLI lookup that may be UNKNOWN.
 *
 * `commandResolver` answers `found`, a real miss, or `unknown` (the lookup gave no answer: its time
 * box fired, `where` failed some other way, the shell never ran; Andy C1). Only a real miss may be
 * acted on as "not installed". These are the decisions, pure, so they are tested as behaviour
 * (Andy R2); index.ts and pty.ts call them and keep one pin per call site.
 */
import type { ResolvedCommand } from './commandResolver';

export type CliStatus = 'found' | 'missing' | 'unknown';

/** The status of one resolver answer. */
export function cliStatus(r: ResolvedCommand): CliStatus {
  return r.found ? 'found' : r.unknown ? 'unknown' : 'missing';
}

/** The distinct, retryable reason for a spawn refused because its CLI lookup gave no answer. */
export function cliLookupUnknownReason(bin: string): string {
  return `engine CLI "${bin}" could not be checked: its lookup timed out or failed (machine under load); retry the spawn`;
}

/** The spawn's missing-CLI check: ONLY a known miss runs the installer. Unknown goes ahead (and is
 *  logged); a truly absent CLI then fails visibly, and PtyManager refuses the lossy route (C2). */
export function missingCliAction(status: CliStatus): 'install' | 'proceed' | 'log-and-proceed' {
  return status === 'missing' ? 'install' : status === 'unknown' ? 'log-and-proceed' : 'proceed';
}

/** The installer's npm rung: a KNOWN missing npm is unavailable; an unknown npm or node keeps the
 *  npm rung (never download Node over what may be a working one); otherwise the node version decides. */
export function npmRungDecision(npm: CliStatus, node: CliStatus): 'available' | 'unavailable' | 'check-node-version' {
  if (npm === 'missing') return 'unavailable';
  if (npm === 'unknown' || node === 'unknown') return 'available';
  return 'check-node-version';
}

/** The headless (spawn-request) engine check: null = go on; otherwise the refusal text. An unknown
 *  never says "not installed". */
export function headlessSpawnRefusal(bin: string, status: CliStatus): string | null {
  if (status === 'unknown') return cliLookupUnknownReason(bin);
  if (status === 'missing') return `engine CLI "${bin}" is not installed`;
  return null;
}

/** The codex daemon start: the executable to run, or null (no answer: start the local TUI). */
export function daemonExecutable(r: ResolvedCommand): string | null {
  return r.unknown ? null : r.path;
}

/** One Setup-catalog row: `path` only for a real, existing hit; `unknown` when not checked. */
export function toolRowStatus(r: ResolvedCommand, bin: string, exists: (p: string) => boolean): { found: boolean; path: string | null; unknown: boolean } {
  const path = r.found && r.path !== bin && exists(r.path) ? r.path : null;
  return { found: path !== null, path, unknown: path === null && r.unknown === true };
}

/** Andy C2: PtyManager.spawn's guard before the LOSSY cmd.exe route. An UNRESOLVED bare name (the
 *  lookup gave no answer) with a multi-line argument would start through `cmd.exe /d /s /c`, which
 *  cuts the argument at its first newline: the agent would look healthy without its hive
 *  protocol. Refuse it with the retryable reason. Null = allowed. */
export function lossyRouteRefusal(command: string, r: ResolvedCommand, args: readonly string[]): string | null {
  if (!r.unknown) return null;
  return args.some((a) => a.includes('\n')) ? cliLookupUnknownReason(command) : null;
}
