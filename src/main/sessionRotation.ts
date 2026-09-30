import { createHash } from 'crypto';

/**
 * SESSION-PROMPT-ROTATION (1.1.76). A resumed Claude session keeps the system prompt it was
 * STARTED with: `--resume` replays the old conversation, and the `--append-system-prompt` on
 * the new command line does not replace it (1.1.75 real run #3, B4: a relaunch with the new
 * prompt plus `--resume` still answered with the OLD marker). So a prompt change at an upgrade
 * never reached a running agent; 1.1.75 needed a hand-run registry clear (fresh-start-175.cjs).
 *
 * The fix: every Claude session is stamped with a fingerprint of the prompt its process was
 * spawned with. An AUTOMATIC resume (restore on restart, power-resume revive) of a session
 * whose stamp differs from the prompt it would now get, or that has no stamp at all (a session
 * from before 1.1.76), starts a fresh session instead. The agent's identity, memory.md, inbox
 * and mail ledger are keyed by agent id, so only the conversation is new. A resume the human
 * asks for by id ("restart & continue", a model change, a typed id) is still honoured.
 */

/** How many session stamps an agent keeps (newest last). Enough for the current, the
 *  previous (the resume fallback) and a few /clear rotations. */
export const SESSION_PROMPT_CAP = 8;

/** The prompt fingerprint of a Claude spawn: sha256 of the `--append-system-prompt` value,
 *  first 16 hex chars. null when the args carry no hive prompt (nothing to compare). */
export function promptFingerprint(args: readonly string[]): string | null {
  const i = args.indexOf('--append-system-prompt');
  if (i < 0 || typeof args[i + 1] !== 'string') return null;
  return createHash('sha256').update(args[i + 1], 'utf8').digest('hex').slice(0, 16);
}

export type StaleReason = 'prompt-changed' | 'prompt-unrecorded';

/**
 * Would resuming a session stamped `recorded` put an agent on an out-of-date prompt, given
 * the fingerprint `current` of the prompt this spawn carries? null = not stale (resume).
 * No current fingerprint means there is nothing to compare, so never stale.
 */
export function staleReason(recorded: string | undefined, current: string | null): StaleReason | null {
  if (!current) return null;
  if (!recorded) return 'prompt-unrecorded';
  return recorded === current ? null : 'prompt-changed';
}

/** A stamps map with `sessionId -> fp` added (or moved to newest), capped. Pure. */
export function withSessionStamp(
  stamps: Readonly<Record<string, string>> | undefined,
  sessionId: string,
  fp: string
): Record<string, string> {
  const entries = Object.entries(stamps ?? {}).filter(([k]) => k !== sessionId);
  entries.push([sessionId, fp]);
  return Object.fromEntries(entries.slice(-SESSION_PROMPT_CAP));
}
