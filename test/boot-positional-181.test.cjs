'use strict';

/**
 * BOOT-REENTER-PASTE-PROOF (1.1.81). A real Claude collapses god's typed 6-line orientation into
 * "[Pasted text #1 +3 lines]", so 1.1.80's G2 own-draft proof can never match it. God's orientation
 * now rides on Claude's command line, as its initial prompt after `--`, put there by MAIN and only
 * when THIS spawn's resume decision is fresh; the renderer no longer types it for a Claude god.
 *
 * Probed on Claude Code 2.1.287 in a hidden ConPTY (hive/agents/jim-mtujpe28/t12/probe181), twice:
 *   (a) SessionStart (a 3 s command hook) started AND finished before the positional's turn, and
 *       its additionalContext reached the model (it answered with the secret word it carried);
 *   (b) the positional fired UserPromptSubmit with the exact multi-line text; no paste placeholder.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const GO = loadTs('src/shared/godOrientation.ts');
const P = GO.INITIAL_GOD_PROMPT;
const BASE = ['--model', 'opus', '--append-system-prompt', 'You are "Michael".\nHIVE PROTOCOL (inbox)', '--remote-control', 'Michael'];

const K = {};

// ─── the args transform (pure) ──────────────────────────────────────────────────────────────

K.freshAppendsAfterEndOfOptions = (M = GO) => {
  const r = M.withGodOrientationArg(BASE, true);
  assert.equal(r.onArgv, true);
  assert.deepEqual(r.args.slice(0, BASE.length), BASE, 'every flag kept, in order');
  assert.deepEqual(r.args.slice(BASE.length), ['--', M.INITIAL_GOD_PROMPT], 'FRESH: "--" THEN THE ORIENTATION, LAST');
};
test('fresh: the orientation goes last, after a "--" end-of-options marker', () => K.freshAppendsAfterEndOfOptions());

K.resumeGetsNothing = (M = GO) => {
  const r = M.withGodOrientationArg([...BASE, '--resume', 'sid-1'], false);
  assert.equal(r.onArgv, false, 'A RESUMED GOD IS NEVER RE-ORIENTED (onArgv)');
  assert.deepEqual(r.args, [...BASE, '--resume', 'sid-1'], 'A RESUMED GOD IS NEVER RE-ORIENTED');
};
test('resume: nothing is added', () => K.resumeGetsNothing());

K.relaunchIsIdempotent = (M = GO) => {
  const once = M.withGodOrientationArg(BASE, true).args;
  const twice = M.withGodOrientationArg(once, true);
  assert.deepEqual(twice.args, once, 'A RELAUNCH RE-RUN CARRIES ONE ORIENTATION, NOT TWO');
  const resumed = M.withGodOrientationArg([...once, '--resume', 'sid-2'], false);
  assert.deepEqual(resumed.args, [...BASE, '--resume', 'sid-2'], 'A RELAUNCH THAT NOW RESUMES DROPS THE EARLIER ORIENTATION');
};
test('the install relaunch re-runs the spawn with its built args: one orientation, or none on a resume', () => K.relaunchIsIdempotent());

test('the input array is never mutated, and a foreign "--" positional is left alone', () => {
  const input = [...BASE, '--', 'something else'];
  const copy = [...input];
  const r = GO.withGodOrientationArg(input, false);
  assert.deepEqual(input, copy);
  assert.deepEqual(r.args, copy);
});

test('the orientation text: what god is told (moved verbatim from the renderer)', () => {
  assert.match(P, /^You're online as Michael, the orchestrator of the hive\. Get oriented, then start running the floor:\n1\. Read your memory\.md;/);
  assert.equal(P.split('\n').length, 6);
  assert.ok(!P.startsWith('-'), 'and it would be safe even without "--"');
});

test('Windows: node-pty\'s CRT command line carries the "--" and the orientation back byte for byte', { skip: process.platform !== 'win32' }, () => {
  const { argsToCommandLine } = require('node-pty/lib/windowsPtyAgent.js');
  const args = GO.withGodOrientationArg(BASE, true).args;
  const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  // The exact line node-pty would hand CreateProcess, minus the file, run verbatim by a real child.
  const line = argsToCommandLine('x', ['-e', script, '--', ...args]).slice(2);
  const r = spawnSync(process.execPath, [line], { windowsVerbatimArguments: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), args);
});

// ─── the wiring ─────────────────────────────────────────────────────────────────────────────

K.mainDecidesOnThisSpawn = (index = readSource('src/main/index.ts')) => {
  const block = /hive\.noteSpawnPrompt\(opts\.hive\.id, promptFp, resumedSid\);\n    opts\.args = args;\n(?:    \/\/[^\n]*\n)*    if \(opts\.hive\.isGod\) \{\n      const g = withGodOrientationArg\(args, !didResume\);\n      opts\.args = g\.args;\n      orientationOnArgv = g\.onArgv;\n/;
  assert.match(index, block, 'MAIN ADDS IT AFTER THIS SPAWN\'S RESUME DECISION, FOR A FRESH GOD ONLY');
  const claudeBlock = index.slice(index.indexOf('  if (opts.hive && claudeProvider) {'), index.indexOf('  if (opts.hive && !claudeProvider) {'));
  assert.ok(claudeBlock.includes('withGodOrientationArg('), 'ONLY IN THE CLAUDE BLOCK');
  assert.equal(index.split('withGodOrientationArg(').length - 1, 1, 'exactly one call site');
  assert.match(index, /\.\.\.\(orientationOnArgv \? \{ orientationOnArgv: true \} : \{\}\) \};/, 'THE RENDERER IS TOLD');
};
test('main: added in spawnAgentCore\'s Claude block after the resume decision, god only, and reported back', () => K.mainDecidesOnThisSpawn());

K.rendererDoesNotTypeItTwice = (hiveSrc = readSource('src/renderer/src/hooks/useHive.ts')) => {
  assert.match(hiveSrc, /if \(!res\.orientationOnArgv\) await submitBootPrompt\(GOD_ID, INITIAL_GOD_PROMPT\);/, 'THE RENDERER TYPES IT ONLY WHEN MAIN DID NOT PUT IT ON ARGV');
  assert.equal(hiveSrc.split('submitBootPrompt(GOD_ID, INITIAL_GOD_PROMPT)').length - 1, 1);
  assert.doesNotMatch(hiveSrc, /const INITIAL_GOD_PROMPT = \[/, 'one copy of the text, in shared');
  assert.match(hiveSrc, /import \{ INITIAL_GOD_PROMPT \} from '\.\.\/\.\.\/\.\.\/shared\/godOrientation';/);
};
test('renderer: a Claude god is not typed at; any other god still is', () => K.rendererDoesNotTypeItTwice());

test('the spawn result type carries orientationOnArgv and installer in main and the preload', () => {
  assert.match(readSource('src/main/index.ts'), /async function spawnAgentCore\([^)]*\): Promise<\{[^}]*seedPrompt\?: string; orientationOnArgv\?: boolean; installer\?: boolean \}>/);
  assert.match(readSource('src/preload/index.ts'), /spawnPty: \(opts: SpawnPtyOptions\): Promise<\{[^}]*seedPrompt\?: string; orientationOnArgv\?: boolean; installer\?: boolean \}>/);
});

// ─── the install path (god's 1.1.81 tidy): nothing is typed into an installer PTY ──────────

K.installerResultIsMarked = (index = readSource('src/main/index.ts')) => {
  const install = index.slice(index.indexOf("    if (binAction === 'install') {"), index.indexOf('  // Git isolation: when requested'));
  assert.ok(install.includes('const res = await ptyManager.spawn('), 'found the installer branch');
  assert.match(install, /\n      return \{ \.\.\.res, installer: true \};\n    \}\n  \}\n$/, 'MAIN MARKS THE INSTALLER RESULT');
  assert.doesNotMatch(install, /\n      return res;\n/, 'and never returns it unmarked');
};
test('main: the missing-CLI installer\'s spawn result says installer:true', () => K.installerResultIsMarked());

K.noBootTypingIntoInstaller = (hiveSrc = readSource('src/renderer/src/hooks/useHive.ts')) => {
  const boot = hiveSrc.slice(hiveSrc.indexOf('const resumedGod = res.resumed === true;'), hiveSrc.indexOf('if (!res.orientationOnArgv) await submitBootPrompt(GOD_ID, INITIAL_GOD_PROMPT);'));
  assert.ok(boot.includes('if (res.seedPrompt) await submitBootPrompt(GOD_ID, res.seedPrompt);'), 'the seed and the orientation share one guard');
  assert.match(boot, /if \(!cancelled && !resumedGod && !res\.installer\) \{\n/, 'NOTHING IS TYPED INTO AN INSTALLER PTY');
};
test('renderer: on an installer result god\'s boot prompts (seed and orientation) are not typed', () => K.noBootTypingIntoInstaller());

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

const MUTANTS = [
  { name: 'no "--": the prompt follows the flags bare', file: 'src/shared/godOrientation.ts', module: true,
    edits: [["  out.push('--', INITIAL_GOD_PROMPT);", '  out.push(INITIAL_GOD_PROMPT);']],
    killer: 'freshAppendsAfterEndOfOptions', dies: /FRESH: "--" THEN THE ORIENTATION, LAST/ },
  { name: 'a resume is oriented too', file: 'src/shared/godOrientation.ts', module: true,
    edits: [['  if (!fresh) return { args: out, onArgv: false };\n', '']],
    killer: 'resumeGetsNothing', dies: /A RESUMED GOD IS NEVER RE-ORIENTED/ },
  { name: 'no strip: a relaunch stacks a second orientation', file: 'src/shared/godOrientation.ts', module: true,
    edits: [['    if (out[i + 1] === INITIAL_GOD_PROMPT) out.splice(i, 2);\n    else i += 1;', '    i += 1;']],
    killer: 'relaunchIsIdempotent', dies: /A RELAUNCH RE-RUN CARRIES ONE ORIENTATION, NOT TWO/ },
  { name: 'main: fresh decided as "resumed"', file: 'src/main/index.ts',
    edits: [['withGodOrientationArg(args, !didResume)', 'withGodOrientationArg(args, didResume)']],
    killer: 'mainDecidesOnThisSpawn', dies: /FOR A FRESH GOD ONLY/ },
  { name: 'main: the renderer is not told', file: 'src/main/index.ts',
    edits: [['...(orientationOnArgv ? { orientationOnArgv: true } : {}) };', '};']],
    killer: 'mainDecidesOnThisSpawn', dies: /THE RENDERER IS TOLD/ },
  { name: 'renderer: types the orientation anyway (god oriented twice)', file: 'src/renderer/src/hooks/useHive.ts',
    edits: [['if (!res.orientationOnArgv) await submitBootPrompt(GOD_ID, INITIAL_GOD_PROMPT);', 'await submitBootPrompt(GOD_ID, INITIAL_GOD_PROMPT);']],
    killer: 'rendererDoesNotTypeItTwice', dies: /THE RENDERER TYPES IT ONLY WHEN MAIN DID NOT PUT IT ON ARGV/ },
  { name: 'main: the installer result is returned unmarked (as 1.1.80)', file: 'src/main/index.ts',
    edits: [['      return { ...res, installer: true };\n', '      return res;\n']],
    killer: 'installerResultIsMarked', dies: /MAIN MARKS THE INSTALLER RESULT/ },
  { name: 'renderer: boot prompts typed into the installer PTY (as 1.1.80)', file: 'src/renderer/src/hooks/useHive.ts',
    edits: [['if (!cancelled && !resumedGod && !res.installer) {', 'if (!cancelled && !resumedGod) {']],
    killer: 'noBootTypingIntoInstaller', dies: /NOTHING IS TYPED INTO AN INSTALLER PTY/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const arg = m.module ? loadTs.fromText(m.file, text) : text;
      assert.throws(() => K[m.killer](arg), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
