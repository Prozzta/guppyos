/**
 * READS-PROMPT-TRIM (1.1.83): leave out of each hive Claude agent's starting text the built-in
 * tools, skills and claude.ai connectors its role has never used. Every request re-reads that
 * text, so what a role never calls is paid for on every turn.
 *
 * Evidence (_work/creed-183-trim-evidence, every hive transcript 2026-09-11..10-03, ~54k tool
 * calls by god, Creed, Jim and Andy):
 * - Never called by any hive agent: Workflow, ReportFindings (only the /code-review recipe calls
 *   it) and every claude.ai connector tool (Claude Docs).
 * - Used by god only: AskUserQuestion (36), ListAgents (1), the only two Skill calls (loop,
 *   artifact-design) and so ScheduleWakeup, which /loop paces itself with. So the other roles
 *   also lose the bundled skills listing; god keeps it.
 * - Kept for every role because some agent used it: Agent, Artifact (god 22, Andy 1),
 *   SendFeedback (god 2, Jim 2), Monitor/TaskStop/WebFetch/WebSearch (deferred), Bash/PowerShell
 *   and the file tools.
 *
 * The skills nobody called are listed by name only (still loadable), not removed.
 *
 * All of it is spawn env, one argv token and the per-agent settings file, never the injected
 * prompt, so the session-prompt
 * fingerprint is unchanged and a resumed session keeps its history. A change reaches an agent at
 * its next spawn. `claudePromptTrim: false` in the config spawns exactly as before.
 *
 * CLAUDE_CODE_DISABLE_BUNDLED_SKILLS goes WITH a disallowed Workflow, never alone: with the
 * bundled skills off, Claude Code 2.1.288 folds the workflow-authoring reference into the Workflow
 * tool's own description (9k -> 43k characters), so the switch alone ADDS ~4k tokens (probed).
 */

/** Never called by any hive agent: left out for every role. */
export const TRIM_TOOLS_ALL = ['Workflow', 'ReportFindings'] as const;
/** Used only by god: left out for every other role. */
export const TRIM_TOOLS_NON_GOD = ['AskUserQuestion', 'ScheduleWakeup', 'ListAgents'] as const;

/** Skills god keeps listed in full: the two it called, and the Artifact guides its Artifact tool
 *  (god's most-used non-file tool) tells it to load. */
export const GOD_SKILLS_FULL = ['loop', 'artifact-design', 'artifact-capabilities', 'artifact-diagramming', 'dataviz'] as const;
/** Claude Code 2.1.288's other bundled skills plus the official plugin's plugin-authoring: no hive
 *  agent called one. A name Claude Code no longer ships is a harmless unknown key. */
export const LISTED_BY_NAME_ONLY = ['update-config', 'keybindings-help', 'code-review', 'simplify', 'fewer-permission-prompts',
  'schedule', 'claude-api', 'workflow-authoring', 'run', 'init', 'security-review', 'plugin-authoring'] as const;

export interface PromptTrim {
  /** Added to the spawn env. */
  env: Record<string, string>;
  /** One argv token (`--disallowedTools=A,B`): the `=` form, so the variadic flag can never
   *  swallow a following positional (god's initial prompt rides after `--`). Null = none. */
  arg: string | null;
  /** The per-agent settings file's `skillOverrides`: "name-only" lists a skill without its
   *  description; it can still be loaded by name. Null = none. */
  skillOverrides: Record<string, 'name-only'> | null;
}

/** The per-agent settings object with this trim's `skillOverrides` added (unchanged when none). */
export function withSkillOverrides<T extends object>(settings: T, trim: PromptTrim): T | (T & { skillOverrides: Record<string, 'name-only'> }) {
  return trim.skillOverrides ? { ...settings, skillOverrides: trim.skillOverrides } : settings;
}

/** The trim for one Claude agent; `enabled: false` (config claudePromptTrim) = none.
 *  `syncedSkills`: the names of the skills synced from the user's claude.ai account (no hive agent
 *  ever called one); they are listed by name only for every role. Pure. */
export function claudePromptTrimFor(agent: { isGod?: boolean }, enabled: boolean = true, syncedSkills: readonly string[] = []): PromptTrim {
  if (!enabled) return { env: {}, arg: null, skillOverrides: null };
  const tools: string[] = [...TRIM_TOOLS_ALL];
  const env: Record<string, string> = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
  if (!agent.isGod) {
    tools.push(...TRIM_TOOLS_NON_GOD);
    env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
  }
  const skillOverrides: Record<string, 'name-only'> = {};
  for (const name of [...LISTED_BY_NAME_ONLY, ...syncedSkills]) {
    if (!(GOD_SKILLS_FULL as readonly string[]).includes(name)) skillOverrides[name] = 'name-only';
  }
  return { env, arg: `--disallowedTools=${tools.join(',')}`, skillOverrides };
}
