import { createHash } from 'crypto';
import { LEGACY_175_PROMPT_FP } from './sessionRotationLegacy';

/**
 * SESSION-PROMPT-ROTATION (1.1.76). A resumed Claude session keeps the system prompt it was
 * STARTED with: `--resume` replays the old conversation, and the `--append-system-prompt` on
 * the new command line does not replace it (1.1.75 real run #3, B4: a relaunch with the new
 * prompt plus `--resume` still answered with the OLD marker). So a prompt change at an upgrade
 * never reached a running agent; 1.1.75 needed a hand-run registry clear (fresh-start-175.cjs).
 *
 * The fix: every Claude session is stamped with a fingerprint of the NORMALISED prompt its
 * process was spawned with. An AUTOMATIC resume (restore on restart, power-resume revive) of a
 * session whose stamp differs from the normalised prompt it would now get starts a fresh
 * session instead. The agent's identity, memory.md, inbox and mail ledger are keyed by agent
 * id, so only the conversation is new. A resume the human asks for by id ("restart &
 * continue", a model change, a typed id) is still honoured.
 */

/**
 * THE NORMALISER. The fingerprint hashes a CANONICAL render of the prompt (hive.ts
 * injectedPrompt with `canonical`), so only a change of INSTRUCTIONS changes it. It fixes:
 *  - memory availability: rendered as if the `memory` command is on the PATH (the memory line
 *    and the memory wording of protocol line 1). A memory service that is down at a restart
 *    never costs a conversation;
 *  - the Knowledge Graph: rendered as off, so the KG line and its CLI path are absent;
 *  - the RUNNING BUILD line: omitted (the version, packaged/dev, and the app path);
 *  - the agent's name and id, its workspace dir, the hive root and the bundled node path:
 *    these placeholders, with `/` separators on every platform. They are fixed for an agent's
 *    life, and placeholders make the fingerprint the same for every agent of one variant, which
 *    the build-time 1.1.75 table needs.
 * Everything else counts, including the mail-mode text (a degrade changes the mail rules, so
 * rotating there is correct), the role lines and god's spawn-queue line.
 */
export const CANONICAL_PROMPT = {
  name: '<AGENT_NAME>',
  id: '<AGENT_ID>',
  agentDir: '<AGENT_DIR>',
  hiveRoot: '<HIVE_ROOT>',
  node: '<HIVE_NODE>'
} as const;

/** Paths under the placeholders use `/`, whatever the platform's join() produced. */
export function normaliseCanonicalPaths(text: string): string {
  return text.replace(/(<AGENT_DIR>|<HIVE_ROOT>)((?:[\\/][^\s\\/`'"),;]+)+)/g, (_m, base: string, rest: string) => base + rest.replace(/\\/g, '/'));
}

/** sha256 of the canonical render (paths normalised), first 16 hex chars. */
export function canonicalPromptFingerprint(canonicalText: string): string {
  return createHash('sha256').update(normaliseCanonicalPaths(canonicalText), 'utf8').digest('hex').slice(0, 16);
}

/** The key of the build-time table: the inputs that still vary after normalisation. */
export function promptVariant(provider: string, mailMode: string, role: 'god' | 'god+spawn' | 'assistant' | 'worker'): string {
  return `${provider}|${mailMode}|${role}`;
}

/** How many session stamps an agent keeps (newest last). Enough for the current, the
 *  previous (the resume fallback) and a few /clear rotations. */
export const SESSION_PROMPT_CAP = 8;

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

/**
 * The resume decision for one session. An UNSTAMPED session was recorded before stamps existed,
 * i.e. launched by 1.1.75 (whose install fresh-started every agent, FRESH-START-175 H13): it
 * takes the build-time 1.1.75 fingerprint of its variant (`stampLegacy`), then compares as
 * usual. So an install that does not change the instruction text rotates nobody, and one that
 * does rotates everyone. A variant missing from the table stays unrecorded (it rotates).
 */
export function resumeDecision(
  recorded: string | undefined,
  variant: string | null,
  current: string | null,
  legacy: Readonly<Record<string, string>> = LEGACY_175_PROMPT_FP
): { stale: StaleReason | null; stampLegacy: string | null } {
  const stampLegacy = !recorded && variant && legacy[variant] ? legacy[variant] : null;
  return { stale: staleReason(recorded ?? stampLegacy ?? undefined, current), stampLegacy };
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
