'use strict';

/**
 * READS-PROMPT-TRIM (1.1.83): each hive Claude agent spawns without the tools, skills and claude.ai
 * connectors its role has never used (src/shared/claudePromptTrim.ts).
 *
 * The rule the card sets: no capability an agent actually uses may go. USED below is the evidence
 * (_work/creed-183-trim-evidence/usage.json: every tool call in every hive transcript,
 * 2026-09-11..10-03), frozen here so a later edit to the trim lists cannot drop a used tool
 * without failing this file. Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const T = loadTs('src/shared/claudePromptTrim.ts');
const K = {};

/** Built-in tools each role called (deferred ones included; hive MCP and Skill names aside). */
const USED = {
  god: ['Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'Glob', 'Grep',
    'ListAgents', 'Monitor', 'PowerShell', 'PushNotification', 'Read', 'SendFeedback', 'SendMessage', 'SendUserFile', 'Skill',
    'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
    // /loop (Skill:loop, god 1) paces itself with ScheduleWakeup.
    'ScheduleWakeup'],
  builder: ['Agent', 'Artifact', 'Bash', 'Edit', 'Glob', 'Grep', 'Monitor', 'PowerShell', 'Read', 'SendFeedback', 'SendMessage',
    'TaskCreate', 'TaskStop', 'TaskUpdate', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write']
};
const disallowed = (trim) => (trim.arg ? trim.arg.replace(/^--disallowedTools=/, '').split(',') : []);

// ─── the policy ─────────────────────────────────────────────────────────────────────────────

K.noUsedToolGoes = (M = T) => {
  for (const [role, isGod] of [['god', true], ['builder', false]]) {
    const off = disallowed(M.claudePromptTrimFor({ isGod }));
    for (const t of USED[role]) assert.ok(!off.includes(t), `NO TOOL A ${role.toUpperCase()} USED IS TRIMMED: ${t}`);
  }
};
test('no tool a role used is trimmed (the card\'s rule, against the frozen evidence)', () => K.noUsedToolGoes());

K.roles = (M = T) => {
  const god = M.claudePromptTrimFor({ isGod: true });
  const builder = M.claudePromptTrimFor({ isGod: false });
  assert.deepEqual(disallowed(god).sort(), ['ReportFindings', 'Workflow'], 'GOD LOSES ONLY WHAT NO AGENT EVER USED');
  assert.deepEqual(disallowed(builder).sort(), ['AskUserQuestion', 'ListAgents', 'ReportFindings', 'ScheduleWakeup', 'Workflow'], 'BUILDERS LOSE GOD-ONLY TOOLS TOO');
  assert.equal(god.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false', 'NO HIVE AGENT EVER CALLED A CLAUDE.AI CONNECTOR');
  assert.equal(builder.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(god.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, undefined, 'GOD KEEPS THE BUNDLED SKILLS (loop, artifact-design)');
  assert.equal(builder.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, '1', 'BUILDERS NEVER CALLED A SKILL');
};
test('roles: god keeps its own tools and the bundled skills; builders lose god-only tools and the skills listing', () => K.roles());

K.bundledNeedsWorkflowOff = (M = T) => {
  // Bundled skills off WITHOUT Workflow disallowed makes the start text bigger (probed on 2.1.288:
  // the Workflow description grows 9k -> 43k characters).
  for (const isGod of [true, false]) {
    const t = M.claudePromptTrimFor({ isGod });
    if (t.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS) assert.ok(disallowed(t).includes('Workflow'), 'BUNDLED SKILLS GO OFF ONLY WITH WORKFLOW DISALLOWED');
  }
};
test('the bundled-skills switch only ever comes with Workflow disallowed', () => K.bundledNeedsWorkflowOff());

K.oneToken = (M = T) => {
  for (const isGod of [true, false]) {
    const { arg } = M.claudePromptTrimFor({ isGod });
    assert.match(arg, /^--disallowedTools=[A-Za-z]+(,[A-Za-z]+)*$/, 'ONE ARGV TOKEN (the variadic flag never swallows a positional)');
  }
};
test('the flag is one `--disallowedTools=A,B` token', () => K.oneToken());

K.off = (M = T) => {
  for (const isGod of [true, false]) assert.deepEqual(M.claudePromptTrimFor({ isGod }, false), { env: {}, arg: null, skillOverrides: null }, 'THE OFF SWITCH SPAWNS AS BEFORE');
};
test('claudePromptTrim false: no env, no flag', () => K.off());

// ─── skills: listed by name only, never removed ──────────────────────────────────────────────

K.skills = (M = T) => {
  const synced = ['pdf', 'docx', 'morning'];
  const god = M.claudePromptTrimFor({ isGod: true }, true, synced).skillOverrides;
  const builder = M.claudePromptTrimFor({ isGod: false }, true, synced).skillOverrides;
  for (const o of [god, builder]) {
    for (const v of Object.values(o)) assert.equal(v, 'name-only', 'A SKILL IS ONLY EVER LISTED BY NAME, NEVER TURNED OFF');
    for (const n of synced) assert.equal(o[n], 'name-only', `THE CLAUDE.AI SKILLS ARE LISTED BY NAME: ${n}`);
  }
  for (const n of ['loop', 'artifact-design']) assert.equal(god[n], undefined, `GOD KEEPS THE SKILLS IT CALLED IN FULL: ${n}`);
  assert.equal(M.claudePromptTrimFor({ isGod: true }, true, ['loop']).skillOverrides.loop, undefined, 'even if an account skill shares the name');
  assert.equal(M.claudePromptTrimFor({ isGod: true }, false, synced).skillOverrides, null);
  const base = { hooks: { Stop: [] }, disableAgentView: true };
  assert.deepEqual(M.withSkillOverrides(base, M.claudePromptTrimFor({ isGod: false }, true, synced)), { ...base, skillOverrides: builder }, 'THE SETTINGS KEEP EVERYTHING AND GAIN THE OVERRIDES');
  assert.equal(M.withSkillOverrides(base, M.claudePromptTrimFor({ isGod: false }, false)), base, 'off: the settings object is unchanged');
};
test('skills: unused ones are listed by name only (still loadable); god keeps loop and the Artifact guides in full', () => K.skills());

test('the synced claude.ai skill names are read from ~/.claude/skills/synced/*/manifest.json, best-effort', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const H = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trim183-'));
  try {
    assert.deepEqual(H.syncedClaudeSkillNames(home), [], 'none synced: none');
    const d = path.join(home, '.claude', 'skills', 'synced', 'org_user');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ skills: [{ name: 'pdf' }, { name: 'docx' }, { name: 'bad name"' }, { name: 3 }] }));
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'synced', 'broken'));
    assert.deepEqual(H.syncedClaudeSkillNames(home), ['docx', 'pdf'], 'valid names only; a broken folder is skipped');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ─── the wiring ─────────────────────────────────────────────────────────────────────────────

K.wiring = (hive = readSource('src/main/hive.ts'), idx = readSource('src/main/index.ts')) => {
  const claude = hive.slice(hive.indexOf("    env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';"), hive.indexOf('    return { args, env };\n  }\n\n  /** Update the durable job string'));
  assert.ok(claude.length > 500, 'the Claude spawn block is found');
  assert.match(claude, /const trim = claudePromptTrimFor\(\{ isGod: meta\.isGod \}, opts\.claudePromptTrim !== false, syncedClaudeSkillNames\(\)\);/, 'THE TRIM IS RESOLVED PER ROLE WITH THE CONFIG SWITCH');
  assert.match(claude, /\n    Object\.assign\(env, trim\.env\);\n    if \(trim\.arg\) \{\n      args\.push\(trim\.arg\);/, 'THE FLAG AND THE ENV REACH THE SPAWN');
  assert.match(claude, /this\.writeJson\(settingsPath, withSkillOverrides\(this\.hookSettings\([^\n]*, trim\)\);/, 'THE SKILL OVERRIDES REACH THE SETTINGS FILE');
  // Only after the non-Claude early return: other CLIs are untouched.
  assert.ok(hive.indexOf('    if (!claudeProvider) return { args, env };') < hive.indexOf('const trim = claudePromptTrimFor('), 'CLAUDE SPAWNS ONLY');
  assert.match(idx, /claudePromptTrim: readConfig\(\)\.claudePromptTrim !== false,/, 'THE CONFIG SWITCH IS PASSED TO THE SPAWN');
};
test('wiring: Claude spawns only; env, flag and settings file; the config switch passed through', () => K.wiring());

test('the session-prompt fingerprint reads the injected prompt, never the args, env or settings', () => {
  const hive = readSource('src/main/hive.ts');
  const fp = hive.slice(hive.indexOf('  sessionPromptFingerprint('), hive.indexOf('  sessionPromptFingerprint(') + 3000);
  assert.ok(fp.length > 100 && !/disallowed|PromptTrim|skillOverrides|\.env/i.test(fp));
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const SH = 'src/shared/claudePromptTrim.ts';
const MUTANTS = [
  { name: 'god loses AskUserQuestion', file: SH, module: true,
    edits: [["export const TRIM_TOOLS_ALL = ['Workflow', 'ReportFindings'] as const;", "export const TRIM_TOOLS_ALL = ['Workflow', 'ReportFindings', 'AskUserQuestion'] as const;"]],
    killer: 'noUsedToolGoes', dies: /NO TOOL A GOD USED IS TRIMMED: AskUserQuestion/ },
  { name: 'builders lose Artifact', file: SH, module: true,
    edits: [["['AskUserQuestion', 'ScheduleWakeup', 'ListAgents']", "['AskUserQuestion', 'ScheduleWakeup', 'ListAgents', 'Artifact']"]],
    killer: 'noUsedToolGoes', dies: /NO TOOL A BUILDER USED IS TRIMMED: Artifact/ },
  { name: 'god loses the bundled skills', file: SH, module: true,
    edits: [["    env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';\n  }", "  }\n  env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';"]],
    killer: 'roles', dies: /GOD KEEPS THE BUNDLED SKILLS/ },
  { name: 'Workflow is not disallowed', file: SH, module: true,
    edits: [["['Workflow', 'ReportFindings']", "['ReportFindings']"]],
    killer: 'bundledNeedsWorkflowOff', dies: /BUNDLED SKILLS GO OFF ONLY WITH WORKFLOW DISALLOWED/ },
  { name: 'the flag is two tokens', file: SH, module: true,
    edits: [["arg: `--disallowedTools=${tools.join(',')}`", "arg: `--disallowedTools ${tools.join(' ')}`"]],
    killer: 'oneToken', dies: /ONE ARGV TOKEN/ },
  { name: 'the off switch is ignored', file: SH, module: true,
    edits: [["  if (!enabled) return { env: {}, arg: null, skillOverrides: null };\n", '']], killer: 'off', dies: /THE OFF SWITCH SPAWNS AS BEFORE/ },
  { name: 'the env never reaches the spawn', file: 'src/main/hive.ts', hive: true,
    edits: [['    Object.assign(env, trim.env);\n', '']], killer: 'wiring', dies: /THE FLAG AND THE ENV REACH THE SPAWN/ },
  { name: 'the config switch is not read', file: 'src/main/hive.ts', hive: true,
    edits: [['claudePromptTrimFor({ isGod: meta.isGod }, opts.claudePromptTrim !== false, syncedClaudeSkillNames())', 'claudePromptTrimFor({ isGod: meta.isGod }, true, syncedClaudeSkillNames())']],
    killer: 'wiring', dies: /THE TRIM IS RESOLVED PER ROLE WITH THE CONFIG SWITCH/ },
  { name: 'the settings file never gets the overrides', file: 'src/main/hive.ts', hive: true,
    edits: [[', meta.id) as object, trim));', ', meta.id));']],
    killer: 'wiring', dies: /THE SKILL OVERRIDES REACH THE SETTINGS FILE/ },
  { name: 'a skill is turned off', file: SH, module: true,
    edits: [["skillOverrides[name] = 'name-only';", "skillOverrides[name] = 'off' as 'name-only';"]], killer: 'skills', dies: /NEVER TURNED OFF/ },
  { name: 'god loses loop', file: SH, module: true,
    edits: [["export const GOD_SKILLS_FULL = ['loop', ", "export const GOD_SKILLS_FULL = ["], ["'schedule', 'claude-api'", "'schedule', 'loop', 'claude-api'"]], killer: 'skills', dies: /GOD KEEPS THE SKILLS IT CALLED IN FULL: loop/ },
  { name: 'the config switch is not passed', file: 'src/main/index.ts', index: true,
    edits: [['          claudePromptTrim: readConfig().claudePromptTrim !== false,\n', '']], killer: 'wiring', dies: /THE CONFIG SWITCH IS PASSED TO THE SPAWN/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const run = m.module ? () => K[m.killer](loadTs.fromText(m.file, text))
        : m.index ? () => K[m.killer](undefined, text)
        : () => K[m.killer](text);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
