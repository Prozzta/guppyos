'use strict';

// Theme packs as project themes (the integration of PR-a's project themes with PR-b's packs, PR-c's UI tokens and
// PR-d's looks). Generic: no pack is named here. A registered pack id is a project theme in main and the renderer; a
// blank project created with it is seeded from the pack's orchestrator; its {light, dark} UI tokens reach the app; the
// orchestrator gets the pack's look once, as 'captain-default', and keeps its looks across a respawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PT = loadTs('src/shared/projectTheme.ts');
const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');
const L = loadTs('src/renderer/src/scene/themes/looks.ts');

const SEED = { name: 'Commander Test', appearance: { bodyId: 'body-b', colors: { shirt: '#123456' }, presetId: 'lead' } };

test('a registered pack is a project theme; unknown ids still fall back to the office', () => {
  assert.equal(PT.isProjectThemeId('deck-one'), false, 'not before registration');
  PT.registerPackThemes([
    { id: 'deck-one', label: 'Deck One', orchestrator: SEED },
    { id: 'deck-two', label: '', orchestrator: { name: '' } },   // no label: the id; an invalid seed: none
    { id: 'office', label: 'Hijack' },                             // a built-in is never replaced
    { id: 'Bad Id', label: 'x' }
  ]);
  assert.equal(PT.isProjectThemeId('deck-one'), true);
  assert.equal(PT.isPackProjectTheme('deck-one'), true);
  assert.equal(PT.isPackProjectTheme('office'), false);
  assert.equal(PT.isProjectThemeId('Bad Id'), false);
  assert.deepEqual(PT.projectTheme('deck-one'), { id: 'deck-one', label: 'Deck One', blurb: 'Deck One', swatch: '#6b5a4a', sceneTheme: 'deck-one', projectDefaults: { orchestrator: SEED } });
  assert.equal(PT.projectTheme('deck-two').label, 'deck-two');
  assert.equal(PT.projectTheme('deck-two').projectDefaults, undefined);
  assert.equal(PT.projectTheme('office').label, 'The Office');
  assert.deepEqual(PT.projectThemes().map((t) => t.id).slice(-2), ['deck-one', 'deck-two']);
  assert.equal(PT.resolveProjectTheme({ officeThemeByHive: { 'C:/A': 'deck-one' } }, 'c:\\a'), 'deck-one');
  assert.equal(PT.resolveProjectTheme({ officeTheme: 'not-a-theme' }, 'C:/missing'), 'office');
  assert.equal(PT.PROJECT_THEMES.some((t) => t.projectDefaults), false, 'the built-in catalogue is unchanged');
});

test('a blank project created with a pack is seeded from the pack; a non-blank one is not', () => {
  const made = PT.applyProjectHomeChange({}, { mode: 'fresh', newHome: 'C:/New', blankProject: true, theme: 'deck-one' });
  assert.deepEqual(made, { officeThemeByHive: { 'c:/new': 'deck-one' }, projectThemeSeedByHive: { 'c:/new': SEED } });
  const busy = PT.applyProjectHomeChange({}, { mode: 'fresh', newHome: 'C:/Old', blankProject: false, theme: 'deck-one' });
  assert.deepEqual(busy, { officeThemeByHive: {}, projectThemeSeedByHive: {} });
});

test('onboarding into a folder main saw blank is that project\'s creation: the pack seed applies', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pack-onboard-'));
  const electron = require.resolve('electron');
  const prev = require.cache[electron];
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => tmp } } };
  try {
    const C = loadTs('src/main/config.ts');
    const fresh = path.join(tmp, 'new-home');
    // Guppy: main also gets the folder it created (under MUNDER_DEV=1, the clamped dev home), to key the claim.
    assert.deepEqual(C.ensureHarnessHome(fresh), { ok: true, blank: true, home: fresh }, 'absent before the mkdir');
    assert.deepEqual(C.ensureHarnessHome(fresh), { ok: true, blank: true, home: fresh }, 'still empty');
    fs.writeFileSync(path.join(fresh, 'roster.json'), '{}');
    assert.deepEqual(C.ensureHarnessHome(fresh), { ok: true, blank: false, home: fresh }, 'a folder with files is not blank');
    // the claim is re-checked when consumed: the bare hive scaffold bootstrap writes is still no project
    const later = path.join(tmp, 'later');
    assert.equal(C.homeHasNoProject(path.join(tmp, 'absent')), true);
    fs.mkdirSync(path.join(later, 'hive', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(later, 'hive', 'registry.json'), '{"godId":null,"agents":{}}');
    assert.equal(C.homeHasNoProject(later), true, 'bootstrap scaffold only');
    fs.mkdirSync(path.join(later, 'hive', 'agents', 'god'));
    assert.equal(C.homeHasNoProject(later), false, 'an agent: a project');
    fs.rmSync(path.join(later, 'hive', 'agents', 'god'), { recursive: true });
    fs.writeFileSync(path.join(later, 'roster.json'), '{}');
    assert.equal(C.homeHasNoProject(later), false, 'a roster: a project');
    assert.equal(C.homeHasNoProject(fresh), false, 'any other file: fail closed');
    // N1, Guppy form: Guppy's bootstrap writes a wide, growing scaffold before the first theme
    // choice (state/, ledgers, crash folder, claims queue, the memory engine's palace, engine
    // configs), so an exact file whitelist would refuse every real onboarding. The claim checks
    // the PROJECT markers instead, and every one of them fails closed.
    const scaffold = path.join(tmp, 'scaffold');
    const hv = (...p) => path.join(scaffold, 'hive', ...p);
    fs.mkdirSync(hv('agents'), { recursive: true });
    fs.mkdirSync(hv('bin', 'runtime'), { recursive: true });
    fs.mkdirSync(hv('spawn-requests', '.done'), { recursive: true });
    fs.mkdirSync(hv('state'), { recursive: true });
    fs.mkdirSync(hv('crashes'), { recursive: true });
    fs.mkdirSync(hv('.git'));
    fs.mkdirSync(path.join(scaffold, 'palace'));
    fs.mkdirSync(path.join(scaffold, '.claude'));
    fs.writeFileSync(hv('bin', 'cth-hook.cjs'), '//');
    fs.writeFileSync(hv('registry.json'), '{"godId":null,"agents":{}}');
    fs.writeFileSync(hv('tasks.json'), '{"tasks":[]}');
    for (const f of ['board.md', 'log.jsonl', '.gitignore', 'PROTOCOL.md', 'COMMANDS.md', 'fleet.json', 'cost-ledger.jsonl', 'claims-reconcile-queue.json']) fs.writeFileSync(hv(f), '');
    assert.equal(C.homeHasNoProject(scaffold), true, 'the Guppy bootstrap scaffold');
    const breaks = (label, make, undo) => { make(); assert.equal(C.homeHasNoProject(scaffold), false, label); undo(); assert.equal(C.homeHasNoProject(scaffold), true, `${label} (undone)`); };
    breaks('a registry listing an agent', () => fs.writeFileSync(hv('registry.json'), '{"godId":"god","agents":{"god":{}}}'), () => fs.writeFileSync(hv('registry.json'), '{"godId":null,"agents":{}}'));
    breaks('an unreadable registry', () => fs.writeFileSync(hv('registry.json'), '{'), () => fs.writeFileSync(hv('registry.json'), '{"godId":null,"agents":{}}'));
    breaks('a registry with no agents map', () => fs.writeFileSync(hv('registry.json'), '{}'), () => fs.writeFileSync(hv('registry.json'), '{"godId":null,"agents":{}}'));
    breaks('a task', () => fs.writeFileSync(hv('tasks.json'), '{"tasks":[{"id":"t1"}]}'), () => fs.writeFileSync(hv('tasks.json'), '{"tasks":[]}'));
    breaks('an unreadable tasks file', () => fs.writeFileSync(hv('tasks.json'), 'x'), () => fs.writeFileSync(hv('tasks.json'), '{"tasks":[]}'));
    breaks('an agent folder', () => fs.mkdirSync(hv('agents', 'god')), () => fs.rmdirSync(hv('agents', 'god')));
    breaks('a spawn request', () => fs.writeFileSync(hv('spawn-requests', '.done', 'w.json'), '{}'), () => fs.rmSync(hv('spawn-requests', '.done', 'w.json')));
    breaks('roster backups', () => fs.mkdirSync(path.join(scaffold, 'roster-backups')), () => fs.rmdirSync(path.join(scaffold, 'roster-backups')));
    const fileHive = path.join(tmp, 'file-hive');
    fs.mkdirSync(fileHive); fs.writeFileSync(path.join(fileHive, 'hive'), '');
    assert.equal(C.homeHasNoProject(fileHive), false, 'a FILE named hive');
  } finally {
    if (prev) require.cache[electron] = prev; else delete require.cache[electron];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const main = read('src/main/index.ts');
  assert.match(main, /blankCreatedHomes\.clear\(\);\s+if \(res\.ok && res\.blank && res\.home\) blankCreatedHomes\.add\(projectThemeHomeKey\(res\.home\)\);/, 'only the latest onboarding home holds a claim');
  assert.match(main, /ipcMain\.handle\('config:changeHome'[\s\S]{0,1200}?blankCreatedHomes\.clear\(\);/, 'a home change drops any onboarding claim');
  assert.match(main, /if \(isProjectThemeId\(theme\) && blankCreatedHomes\.delete\(key\) && homeHasNoProject\(home\)\) \{\s*return writeConfig\(applyProjectHomeChange\(current, \{ mode: 'fresh', newHome: home, blankProject: true, theme \}\)\);/);
  assert.match(main, /return \{ ok: res\.ok, \.\.\.\(res\.error \? \{ error: res\.error \} : \{\}\) \};/, 'the renderer never sees (or sets) blank');
});

test('the TV-show flag gates the built-in TV maps only: a pack project shows its own floor', () => {
  assert.equal(PT.floorSceneTheme('deck-one', false), 'deck-one');
  assert.equal(PT.floorSceneTheme('deck-one', true), 'deck-one');
  assert.equal(PT.floorSceneTheme('office', false), 'office');
  const tv = PT.projectThemes().find((t) => t.id !== 'office' && !PT.isPackProjectTheme(t.id));
  if (tv) {
    assert.equal(PT.floorSceneTheme(tv.id, false), 'office', `${tv.id} stays behind the flag`);
    assert.equal(PT.floorSceneTheme(tv.id, true), PT.projectTheme(tv.id).sceneTheme);
  }
  const app = read('src/renderer/src/App.tsx');
  assert.match(app, /const floorScene = config \? floorSceneTheme\(resolveProjectTheme\(config, config\.harnessHome\), config\.tvShowOffices\) : null;/);
  assert.match(app, /useEffect\(\(\) => \{ if \(floorScene\) useStore\.getState\(\)\.setOfficeTheme\(floorScene as ThemeId\); \}, \[floorScene\]\);/, 'every config the app holds, onboarding\'s included');
  const picker = read('src/renderer/src/components/OfficeThemePicker.tsx');
  assert.match(picker, /setOfficeTheme\(floorSceneTheme\(current, next\) as ThemeId\)/);
  assert.match(picker, /setOfficeTheme\(floorSceneTheme\(id, enabled\) as ThemeId\)/);
  // the pack cards are not behind the flag: a pack is a per-project theme an existing project can pick
  assert.match(picker, /const offered = projectThemes\(\)\.filter\(\(theme\) => enabled \|\| theme\.id === 'office' \|\| isPackProjectTheme\(theme\.id\)\);/);
  assert.match(picker, /\{offered\.length > 1 && <div[^>]*>\s*\{offered\.map\(/);
  assert.doesNotMatch(picker, /\{enabled && <div/);
  assert.match(picker, /the seed NAME\) are intentionally creation-only/);
});

test('main reads the pack ids from the bundled manifests (validated, as the renderer does) before any config is read', () => {
  // Shape alone is not enough: an id-and-label manifest the renderer would reject is not registered.
  assert.deepEqual(loadTs('src/main/packThemeEntries.ts').validatedPackThemeEntries({
    'a/theme.json': { id: 'deck-one', label: 'Deck One', projectDefaults: { orchestrator: SEED } },
    'b/theme.json': { label: 'no id' },
    'c/theme.json': null
  }), []);
  const main = read('src/main/packThemes.ts');
  assert.match(main, /import\.meta\.glob\('\.\.\/\.\.\/themes\/\*\/theme\.json', \{ eager: true, import: 'default' \}\)/);
  assert.match(main, /registerPackThemes\(validatedPackThemeEntries\(MANIFESTS\)\)/);
  assert.match(read('src/main/index.ts'), /^import '\.\/packThemes';/, 'the first import of main');
  const renderer = read('src/renderer/src/main.tsx');
  assert.ok(renderer.indexOf('registerBundledProjectThemes();') < renderer.indexOf('createRoot('), 'registered before the first render');
  for (const f of ['HivePicker.tsx', 'OnboardingWizard.tsx']) {
    assert.match(read(`src/renderer/src/components/${f}`), /projectThemes\(\)\.filter\(\(theme\) => theme\.id === 'office' \|\| isPackProjectTheme\(theme\.id\)\)/, f);
  }
  assert.match(read('src/renderer/src/components/OfficeThemePicker.tsx'), /projectThemes\(\)\.filter\(\(theme\) => enabled \|\| /, 'Settings: every theme with the flag on');
});

test('a manifest\'s uiTokens are {light, dark} colour roles; anything else is dropped with a warning', () => {
  const base = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'themes', 'neutral-deck', 'theme.json'), 'utf8'));
  const ok = base(); ok.uiTokens = { light: { lemon: '#E3A91A', 'space-4': '9px' }, dark: { lemon: '#F2BE3A' } };
  const r = Mf.validateManifest(ok);
  assert.deepEqual(r.manifest.uiTokens, { light: { lemon: '#E3A91A' }, dark: { lemon: '#F2BE3A' } });
  assert.ok(r.diagnostics.some((d) => d.level === 'warn' && /1 entry is not a UI colour role/.test(d.message)));
  const flat = base(); flat.uiTokens = { lemon: '#E3A91A' };
  const f = Mf.validateManifest(flat);
  assert.equal(f.manifest.uiTokens, undefined);
  assert.ok(f.diagnostics.some((d) => d.level === 'warn' && /"uiTokens" must be \{light, dark\}/.test(d.message)));
  // the active theme's tokens: a pack's from its manifest, a built-in theme's from its ThemeConfig
  assert.match(read('src/renderer/src/App.tsx'), /applyThemeUiTokens\(\{ id: officeTheme, uiTokens: themeUiTokens\(officeTheme\) \?\? getTheme\(officeTheme\)\.uiTokens \}\)/);
  assert.match(read('src/renderer/src/scene/themes/packs.ts'), /\.\.\.\(m\.uiTokens \? \{ uiTokens: m\.uiTokens \} : \{\}\)/);
});

test('the orchestrator gets the pack\'s look once, as captain-default; a stored look wins; looks survive a respawn', () => {
  const builder = {
    bodies: [{ id: 'body-a', label: 'A', column: 0 }, { id: 'body-b', label: 'B', column: 1 }],
    swatches: { shirt: { navy: '#123456', red: '#aa2222' } },
    presets: [{ id: 'lead', label: 'Lead', bodyId: 'body-b', colors: { shirt: '#123456' } }],
    defaults: { bodyId: 'body-a' }
  };
  const look = L.orchestratorDefaultLook(builder, undefined, SEED.appearance);
  assert.equal(look.source, 'captain-default');
  assert.equal(look.bodyId, 'body-b');
  assert.equal(look.presetId, 'lead');
  assert.equal(L.orchestratorDefaultLook(builder, { bodyId: 'body-a', colors: {}, source: 'custom', version: 1 }, SEED.appearance), null, 'a stored look is kept');
  assert.equal(L.orchestratorDefaultLook(undefined, undefined, SEED.appearance), null, 'no builder: nothing');
  // not creation-only (god, 2026-10-13): an existing orchestrator switched to the pack (an Office look only, its own
  // name) gets the pack's look too; only the seed NAME is creation-only
  const michael = { name: 'Michael', appearanceByTheme: { office: { bodyId: 'x', colors: {}, source: 'custom', version: 1 } } };
  assert.equal(L.orchestratorDefaultLook(builder, michael.appearanceByTheme['deck-one'], SEED.appearance).source, 'captain-default');
  assert.equal(L.orchestratorDefaultLook(builder, undefined, { bodyId: 'nope' }), null, 'an unusable seed: nothing');
  const hook = read('src/renderer/src/hooks/useOrchestratorThemeLook.ts');
  assert.match(hook, /orchestratorDefaultLook\(themeBuilder\(themeId\) \?\? undefined, god\.appearanceByTheme\?\.\[themeId\], seed\.appearance\)/);
  assert.doesNotMatch(hook, /name:/, 'the name is never touched');
  assert.match(read('src/renderer/src/App.tsx'), /useOrchestratorThemeLook\(\);/);
  const hive = read('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /const godLooks = useStore\.getState\(\)\.agents\.find\(\(a\) => a\.id === GOD_ID\)\?\.appearanceByTheme;\s+useStore\.getState\(\)\.removeAgent\(GOD_ID\)/);
  assert.match(hive, /\.\.\.\(godLooks \? \{ appearanceByTheme: godLooks \} : \{\}\)/);
});
