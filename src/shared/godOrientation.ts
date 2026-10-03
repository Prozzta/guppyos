/**
 * BOOT-REENTER-PASTE-PROOF (1.1.81): god's orientation rides on Claude's command line.
 *
 * Until 1.1.80 the renderer TYPED the orientation into a fresh god's chat box. That raced Claude's
 * start-up (1.1.80 G1 waits for SessionStart), and a real Claude collapses the 6-line text into
 * "[Pasted text #1 +3 lines]", so G2's own-draft proof can never match it and its one re-Enter is
 * inert. Claude Code takes an initial prompt as a positional (`claude [options] [command] [prompt]`).
 * Probed on 2.1.287 in a hidden ConPTY (hive/agents/jim-mtujpe28/t12/probe181): SessionStart runs,
 * and finishes, and its additionalContext (god's handoff) reaches the model, BEFORE the positional's
 * turn; and the positional fires UserPromptSubmit with the exact text, like a typed prompt.
 *
 * So main appends it, after a `--` end-of-options marker (a prompt starting with a subcommand
 * name or a "-" would otherwise be misparsed), ONLY when this spawn's own resume decision is fresh.
 * Nothing persists it: a resumed god is never re-oriented mid-thread.
 *
 * Pure: the text and the args transform.
 */

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
export const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of the hive. Get oriented, then start running the floor:",
  // ZT-I1-MAIL §5 P8: how mail reaches god depends on its mail mode (delivered in context, or read
  // from inbox/ when legacy or degraded); the renderer does not know it, so this line is neutral
  // and defers to the start-up instructions (P1), which are mode-specific (Jim, slices 4/4b/5).
  '1. Read your memory.md; then handle your pending hive mail as your start-up instructions describe.',
  // GOD-STARTUP-TOKENS R2: the harness keeps the board summarised (floor-digest.md, board-status.md, a
  // few KB); board.md and tasks.json are megabytes, and a god that reads them whole at every start
  // re-sends them at every later step.
  '2. Read floor-digest.md and board-status.md (hive root) and the current roster of agents (active vs archived). Open board.md or tasks.json only for a named card, with grep or jq; never read them whole.',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use — and run `memory wake-up` for a memory digest (the built-in memory engine; skip it if semantic memory is off).',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

/**
 * The Claude god's args for this spawn: any orientation an earlier pass put there is removed
 * (the install relaunch re-runs the spawn with the args it already built), then, when `fresh`,
 * `--` and the orientation go LAST. Never mutates `args`.
 */
export function withGodOrientationArg(args: readonly string[], fresh: boolean): { args: string[]; onArgv: boolean } {
  const out = [...args];
  for (let i = out.indexOf('--'); i >= 0; i = out.indexOf('--', i)) {
    if (out[i + 1] === INITIAL_GOD_PROMPT) out.splice(i, 2);
    else i += 1;
  }
  if (!fresh) return { args: out, onArgv: false };
  out.push('--', INITIAL_GOD_PROMPT);
  return { args: out, onArgv: true };
}
