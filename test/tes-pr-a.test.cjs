require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');

const { readSource: read } = require('./read-source.cjs');

/**
 * TES plan step 3 in Guppy: project theme resolver, creation seed, non-destructive switch and
 * god display name, ported from MunderDev fe3f39cc..5e3cc54a and adapted to Guppy's main.
 */

/** Execute the renderer-safe resolver itself, not a hand-copied imitation. */
function themeModule() {
  return tsModule('src/shared/projectTheme.ts');
}

function tsModule(rel) {
  const js = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', js)(mod.exports, mod);
  return mod.exports;
}

test('resolver honors platform-safe project keys, legacy fallback, and rejects unknown ids', () => {
  const { resolveProjectTheme, projectThemeHomeKey, projectThemeForHome } = themeModule();
  assert.equal(projectThemeHomeKey(' C:\\Work\\Alpha\\ '), 'c:/work/alpha');
  assert.equal(projectThemeHomeKey('/Projects/Alpha'), '/Projects/Alpha');
  assert.equal(projectThemeForHome({ 'C:/WORK/ALPHA/': 'friends' }, 'c:\\work\\alpha'), 'friends');
  assert.equal(resolveProjectTheme({ officeTheme: 'friends' }, 'C:/missing'), 'friends');
  assert.equal(resolveProjectTheme({ officeTheme: 'not-a-theme' }, 'C:/missing'), 'office');
  assert.equal(resolveProjectTheme({ officeTheme: 'office', officeThemeByHive: { 'C:/A': 'got' } }, 'c:\\a\\'), 'got');
});

test('new-project chooser is catalogue-driven and existing-home opening cannot apply a selection', () => {
  const source = read('src/renderer/src/components/HivePicker.tsx');
  const { PROJECT_THEMES } = themeModule();
  assert.match(source, /changeHome\(path, 'fresh', projectTheme\)/);
  assert.match(source, /if \(projectTheme\) \{ setError\('Choose a different empty folder/);
  assert.equal(PROJECT_THEMES.some((theme) => theme.projectDefaults), false);
});

test('switch is main-process atomic, cancellable, and has no lifecycle side effect', () => {
  const source = read('src/renderer/src/components/OfficeThemePicker.tsx');
  assert.match(source, /await window\.cth\.setProjectTheme\(id\)/);
  assert.match(source, /onCancel=\{\(\) => setPending\(null\)\}/);
  assert.match(source, /onClick=\{onCancel\}[^]*?>Cancel/);
  assert.match(source, /onClick=\{onConfirm\}[^]*?Switch/);
  assert.match(source, /<div onClick=\{busy \? undefined : onCancel\}/);
  assert.doesNotMatch(source, /killPty|archiveAgent|disposeTerminal|updateConfig\(\{ officeThemeByHive/);
});

test('home-map transaction only seeds blank fresh projects, migrates both maps, and clears a stale seed', () => {
  const { applyProjectHomeChange, isProjectThemeSeed } = themeModule();
  const fixtureSeed = { name: 'Fixture Captain', appearance: { bodyId: 'fixture-body', colors: { shirt: 'fixture-gold' } } };
  const otherSeed = { name: 'Other Captain', appearance: { bodyId: 'other-body' } };
  // Config normalization persists Windows keys in canonical lower case.
  const a = 'c:/projects/a';
  const b = 'c:/projects/b';
  const c = 'c:/projects/c';
  const initial = {
    officeThemeByHive: { [a]: 'friends', [b]: 'got' },
    projectThemeSeedByHive: { [a]: fixtureSeed, [b]: otherSeed },
  };

  assert.equal(isProjectThemeSeed(fixtureSeed), true);
  assert.equal(isProjectThemeSeed({ name: 'Fixture Captain', appearance: {} }), false);
  assert.deepEqual(
    applyProjectHomeChange(initial, { mode: 'move', oldHome: 'C:\\Projects\\A', newHome: 'C:\\Projects\\C', blankProject: false }),
    { officeThemeByHive: { [b]: 'got', [c]: 'friends' }, projectThemeSeedByHive: { [b]: otherSeed, [c]: fixtureSeed } },
  );
  assert.deepEqual(
    applyProjectHomeChange(initial, { mode: 'move', oldHome: 'C:\\Projects\\Absent', newHome: 'C:\\Projects\\B', blankProject: false }),
    { officeThemeByHive: { [a]: 'friends' }, projectThemeSeedByHive: { [a]: fixtureSeed } },
  );
  assert.deepEqual(
    applyProjectHomeChange(initial, { mode: 'fresh', newHome: c, blankProject: false, theme: 'office', seed: fixtureSeed }),
    initial,
  );
  assert.deepEqual(
    applyProjectHomeChange({
      officeThemeByHive: { [c]: 'friends' }, projectThemeSeedByHive: { [c]: fixtureSeed },
    }, { mode: 'fresh', newHome: c, blankProject: true, theme: 'office', seed: null }),
    { officeThemeByHive: { [c]: 'office' }, projectThemeSeedByHive: {} },
  );
  assert.deepEqual(
    applyProjectHomeChange({}, { mode: 'fresh', newHome: c, blankProject: true, theme: 'friends', seed: fixtureSeed }),
    { officeThemeByHive: { [c]: 'friends' }, projectThemeSeedByHive: { [c]: fixtureSeed } },
  );
});

test('an unthemed blank fresh project clears a reused folder\'s stale theme and seed; opening an existing hive keeps them', () => {
  const { applyProjectHomeChange, resolveProjectTheme } = themeModule();
  const seed = { name: 'Fixture Captain', appearance: { bodyId: 'fixture-body' } };
  const c = 'c:/projects/c';
  const d = 'c:/projects/d';
  const stale = { officeThemeByHive: { [c]: 'friends', [d]: 'got' }, projectThemeSeedByHive: { [c]: seed, [d]: seed } };
  // Settings' plain new hive (SettingsModal) passes no theme.
  const blank = applyProjectHomeChange(stale, { mode: 'fresh', newHome: 'C:\\Projects\\C', blankProject: true });
  assert.deepEqual(blank, { officeThemeByHive: { [d]: 'got' }, projectThemeSeedByHive: { [d]: seed } });
  assert.equal(resolveProjectTheme({ officeTheme: 'office', ...blank }, c), 'office', 'the old theme does not come back');
  // An unknown id is treated as no theme, not as a reason to keep the stale one.
  assert.deepEqual(applyProjectHomeChange(stale, { mode: 'fresh', newHome: c, blankProject: true, theme: 'not-a-theme' }), blank);
  // Opening a folder that already holds a hive is not a creation: its theme and seed stay.
  assert.deepEqual(applyProjectHomeChange(stale, { mode: 'fresh', newHome: c, blankProject: false }), stale);
});

test('creation identity is fallback-only; persisted name and appearance win after creation', () => {
  const hive = read('src/renderer/src/hooks/useHive.ts');
  const main = read('src/main/index.ts');
  const { resolveGodIdentity } = tsModule('src/shared/godIdentity.ts');
  const fixtureSeed = { name: 'Fixture Captain', appearance: { bodyId: 'fixture-body', colors: { shirt: 'fixture-gold' } } };
  const persisted = { name: 'Renamed Captain', appearance: { bodyId: 'persisted-body', presetId: 'persisted' } };
  assert.deepEqual(resolveGodIdentity(persisted, fixtureSeed), { name: 'Renamed Captain', appearance: persisted.appearance });
  assert.deepEqual(resolveGodIdentity(undefined, fixtureSeed), { name: 'Fixture Captain', appearance: fixtureSeed.appearance });
  assert.deepEqual(resolveGodIdentity(undefined, undefined), { name: 'Michael', appearance: undefined });
  assert.match(main, /Choose an empty folder for a new project/);
  // Guppy: main applies the map transaction to the config it is about to write.
  assert.match(main, /applyProjectHomeChange\(readConfigForWrite\(\), \{/);
  assert.match(hive, /resolveGodIdentity\(reg\?\.agents\?\.\[GOD_ID\], creationSeed\)/);
  assert.match(hive, /appearance: godAppearance/);
  assert.doesNotMatch(hive, /projectTheme\(resolveProjectTheme/);
});

test('a non-default god name flows through registry readers, the floor UI, and realtime voice', () => {
  const { personaFor, resolveGodNameFromRegistry } = tsModule('src/shared/godIdentity.ts');
  const registry = { godId: 'captain', agents: { captain: { name: 'Captain Kerk' } } };
  assert.equal(resolveGodNameFromRegistry(registry), 'Captain Kerk');
  assert.equal(resolveGodNameFromRegistry({ agents: {} }), 'Michael');
  assert.equal(personaFor('You are Michael, ready to help.', 'Captain Kerk'), 'You are Captain Kerk, ready to help.');
  assert.equal(personaFor('This fallback calls Michael by name.', 'Captain Kerk'), 'This fallback calls Michael by name.');
  assert.match(read('src/main/realtimeActions.ts'), /resolveGodNameFromRegistry\(reg\)/);
  // Guppy has no useResolvedGodName hook; main names god's desktop notifications.
  assert.match(read('src/main/index.ts'), /title: resolveGodNameFromRegistry\(hive\.registry\(\)\)/);
  assert.match(read('src/renderer/src/components/CommandCenterPanel.tsx'), /agents\.find\(\(a\) => a\.isGod\)\?\.name \?\? DEFAULT_GOD_NAME/);
  const session = read('src/renderer/src/realtime/session.ts');
  assert.match(session, /resolveGodNameFromRegistry\(registry\)/);
  assert.match(session, /name: godName/);
  assert.match(session, /instructions: personaFor\(MICHAEL_PERSONA, godName\)/);
  assert.match(session, /GREETINGS\.map\(\(greeting\) => greeting\.replace\('Michael', godName\)\)/);
});

test('a renamed god is oriented under its name, and a relaunch strips an orientation under any name', () => {
  const GO = require('./load-ts.cjs')('src/shared/godOrientation.ts');
  const kerk = GO.godOrientationPrompt('Captain Kerk');
  assert.ok(kerk.startsWith("You're online as Captain Kerk, the orchestrator of the hive."));
  assert.equal(GO.godOrientationPrompt('  '), GO.INITIAL_GOD_PROMPT, 'a blank name falls back to Michael');
  assert.equal(GO.godOrientationPrompt(), GO.INITIAL_GOD_PROMPT);
  assert.equal(kerk.slice(kerk.indexOf('\n')), GO.INITIAL_GOD_PROMPT.slice(GO.INITIAL_GOD_PROMPT.indexOf('\n')), 'only the first line names god');
  const base = ['--model', 'opus'];
  // An earlier pass oriented Michael; god was renamed since. One orientation, under the new name.
  const relaunch = GO.withGodOrientationArg([...base, '--', GO.INITIAL_GOD_PROMPT], true, 'Captain Kerk');
  assert.deepEqual(relaunch, { args: [...base, '--', kerk], onArgv: true });
  // A user positional that merely looks similar is not stripped.
  const lookalike = "You're online as Captain Kerk, the orchestrator of the hive. Get oriented, then start running the floor:\nsomething else";
  assert.deepEqual(GO.withGodOrientationArg([...base, '--', lookalike], true).args, [...base, '--', lookalike, '--', GO.INITIAL_GOD_PROMPT]);
  assert.deepEqual(GO.withGodOrientationArg(base, false, 'Captain Kerk'), { args: base, onArgv: false });
});
