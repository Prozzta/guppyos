/**
 * The inbox-wake nudge — the text queued for an agent that has unread hive mail,
 * and the predicate the message queue uses to keep only one of them pending.
 *
 * The nudge is QUEUED the moment fresh mail is seen but TYPED only once the agent
 * is idle and off cooldown, and it survives a renderer reload in the persisted
 * queue. By the time it lands, the mail has often already reached the agent (1.1.75: in the
 * hook context of a turn it was already in; before, by reading its inbox), so the nudge
 * arrives with nothing new to show.
 */

/** The fixed head of every nudge; the ids that follow differ per nudge. ZT-I1-MAIL (1.1.75, §5
 *  P4): mail travels in hook context, so the injection-mode nudge only says it is there. */
const NUDGE_HEAD = 'You have new hive mail';
/** The 1.1.74 head, still typed for agents that move their own mail (§11.7), and still in the
 *  persisted queues of older sessions: recognised as a nudge too. */
const LEGACY_NUDGE_HEAD = 'You have new hive inbox message(s)';

/** §5 / §11.7: which mail instructions a nudge carries (mirrors main's `MailNudgeMode`). */
export type NudgeMailMode = 'inject' | 'legacy-read' | 'legacy-move' | 'work-order' | 'degraded-move' | 'degraded-read';
const NUDGE_MODES: readonly NudgeMailMode[] = ['inject', 'legacy-read', 'legacy-move', 'work-order', 'degraded-move', 'degraded-read'];

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
export function inboxNudgeText(ids: string[], mode: NudgeMailMode = 'inject'): string {
  const list = ids.join(', ');
  // ZT-I1-MAIL §5 P4: the ids stay (the submit attestation and "did I already see this?", #58);
  // the read/move instruction goes. The bodies are in the hook context of this very turn.
  if (mode === 'inject') return `${NUDGE_HEAD} (delivered in context below)${ids.length ? `: ${list}` : ''}.`;
  // Creed Q27: a degraded injection agent still runs with the injection P1 ("you do not read or
  // move inbox files") until it respawns, so its nudge says the channel changed and what to do.
  if (mode === 'degraded-move') return `${NUDGE_HEAD}${ids.length ? `: ${list}` : ''}. Mail channel degraded: read each file in your inbox/ and move it to inbox/.done/ yourself once handled.`;
  if (mode === 'degraded-read') return `${NUDGE_HEAD}${ids.length ? `: ${list}` : ''}. Mail channel degraded: read those files in your inbox/ and act; the harness archives them when your turn ends.`;
  // Legacy-read (§2.2): the agent reads the files; the harness archives them at its Stop. Also a
  // terminal work-order agent (Creed Q26: never "move"; its mail normally arrives typed whole).
  if (mode === 'legacy-read' || mode === 'work-order') return `${NUDGE_HEAD}${ids.length ? `: ${list}` : ''}. Read those files in your inbox/ and act; the harness archives them when your turn ends.`;
  // Legacy-move (§11.7: no Stop signal): the 1.1.74 text, unchanged.
  const named = ids.length ? ` - at least: ${list}` : '';
  return `${LEGACY_NUDGE_HEAD}${named}. Read your inbox (authoritative; ids already in inbox/.done/ were handled), act, move handled ones to inbox/.done/.`;
}

/** The nudge without ids, for size checks (tests, docs): the longest fixed text of the modes. */
export const INBOX_NUDGE_FIXED_CHARS = Math.max(...NUDGE_MODES.map((m) => inboxNudgeText([], m).length));

/** Keep Codex's retained user item free of dynamic inbox ids. The hook supplies
 * those current facts as transient developer context instead. */
export function inboxWakeTextForProvider(provider: string | undefined, ids: string[], mode: NudgeMailMode = 'inject'): string {
  return provider === 'codex' ? CODEX_INBOX_WAKE_SENTINEL : inboxNudgeText(ids, mode);
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
  return trimmed === CODEX_INBOX_WAKE_SENTINEL || trimmed.startsWith(NUDGE_HEAD) || trimmed.startsWith(LEGACY_NUDGE_HEAD);
}
