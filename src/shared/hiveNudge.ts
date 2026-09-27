/**
 * The inbox-wake nudge — the text queued for an agent that has unread hive mail,
 * and the predicate the message queue uses to keep only one of them pending.
 *
 * The nudge is QUEUED the moment fresh mail is seen but TYPED only once the agent
 * is idle and off cooldown, and it survives a renderer reload in the persisted
 * queue. By the time it lands, the agent has often already drained that mail and
 * filed it under `inbox/.done/` — so the nudge arrives against an inbox the agent
 * itself just emptied.
 */

/** The fixed head of every nudge; the ids that follow differ per nudge. */
const NUDGE_HEAD = 'You have new hive inbox message(s)';

/** Route A: Codex retains this user item across compaction, so it must stay short,
 * fixed, and useful if its UserPromptSubmit hook cannot answer. */
export const CODEX_INBOX_WAKE_SENTINEL = '[hive] check inbox';

/**
 * Build the nudge, naming the messages that prompted it.
 *
 * The ids are diagnostic, NOT a work list: they let an agent tell "I already
 * handled this last turn" (the id sits in `inbox/.done/`) from "the harness woke
 * me for nothing", which is the distinction it otherwise cannot make and burns a
 * round-trip guessing at. The pending inbox stays authoritative — an agent that
 * has a nudge suppressed by the one-pending rule below still finds its mail by
 * reading the directory, so the text must never invite it to stop at the ids.
 *
 * PURE ASCII (CODEX-WAKE-162): a TUI may drop characters it cannot echo. Codex's composer
 * dropped the em dash this text used to carry, so the owner's screen attestation never
 * matched its own stuck wake line (Jim, POST-INSTALL-161). Keep every character printable ASCII.
 *
 * SHORT (CODEX-BLOAT-165 fix 4): every nudge is a user turn, and Codex's compaction keeps user
 * turns, so each one was re-sent on every later request of the thread (357 retained copies, about
 * 43K tokens, in Dwight's). The fixed part is now 150 chars instead of 370; the standing rules it
 * used to repeat (act autonomously, when to message god) are in the protocol already.
 */
export function inboxNudgeText(ids: string[]): string {
  const named = ids.length ? ` - at least: ${ids.join(', ')}` : '';
  return `${NUDGE_HEAD}${named}. Read your inbox (authoritative; ids already in inbox/.done/ were handled), act, move handled ones to inbox/.done/.`;
}

/** The nudge without ids, for size checks (tests, docs). */
export const INBOX_NUDGE_FIXED_CHARS = inboxNudgeText([]).length;

/** Keep Codex's retained user item free of dynamic inbox ids. The hook supplies
 * those current facts as transient developer context instead. */
export function inboxWakeTextForProvider(provider: string | undefined, ids: string[]): string {
  return provider === 'codex' ? CODEX_INBOX_WAKE_SENTINEL : inboxNudgeText(ids);
}

/**
 * Is this queued text an inbox-wake nudge?
 *
 * Matches the fixed head only, since every nudge carries different ids — the
 * point is to recognise the COMMAND, not one instance of it. Mirrors
 * `isCompactionCommand`, and the queue's one-pending rule leans on it the same way.
 */
export function isInboxNudge(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === CODEX_INBOX_WAKE_SENTINEL || trimmed.startsWith(NUDGE_HEAD);
}
