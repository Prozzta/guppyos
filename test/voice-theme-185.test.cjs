'use strict';

// VOICE-THEME-185 (Jim's release SHOULD b): 1.1.84 could switch the theme by voice
// (update_setting officeTheme, the global key). 1.1.85 made themes per project and dropped
// the key from the voice policy, so the ask was refused. Voice now takes the Settings
// picker's path: the current project's theme through config:setProjectTheme's function,
// validated as that IPC validates (a built-in or an installed pack). The legacy global
// officeTheme write path is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// realtimeActions.ts registers on electron's ipcMain: a fake that keeps the handlers.
const handlers = {};
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } }
};
const loadTs = require('./load-ts.cjs');
const RA = loadTs('src/main/realtimeActions.ts');
const PT = loadTs('src/shared/projectTheme.ts');
// main registers the packs installed in this build at start-up; here, tes.
PT.registerPackThemes([{ id: 'tes', label: 'TES' }]);

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const state = { theme: 'office', sets: [], patches: [], sent: [] };
RA.registerRealtimeActionIpc({
  hiveEnabled: () => true,
  hiveRegistry: () => ({ agents: [] }),
  hiveSend: (m) => { state.sent.push(m); },
  hiveLog: () => {},
  getConfigValue: () => undefined,
  patchConfig: (p) => { state.patches.push(p); },
  getProjectTheme: () => state.theme,
  setProjectTheme: (t) => { state.sets.push(t); state.theme = t; }
});
const say = (input) => handlers['realtime:action'](null, { verb: 'update_setting', ...input });
const reset = (theme) => { state.theme = theme; state.sets.length = 0; state.patches.length = 0; };

test('voice switches THIS project to an installed pack, by label or id, through the per-project path', async () => {
  reset('office');
  const r = await say({ key: 'officeTheme', value: 'TES' });
  assert.equal(r.ok, true, r.spoken);
  assert.deepEqual(state.sets, ['tes']);
  assert.deepEqual(state.patches, [], 'never the global config patch (legacy officeTheme key)');
  assert.match(r.spoken, /now TES \(was The Office\)/);
  reset('tes');
  const back = await say({ key: 'officeTheme', value: 'the office' });
  assert.equal(back.ok, true, back.spoken);
  assert.deepEqual(state.sets, ['office']);
  reset('office');
  assert.equal((await say({ key: 'projectTheme', value: 'tes' })).ok, true);
  assert.deepEqual(state.sets, ['tes']);
  reset('office');
  assert.equal((await say({ key: 'theme', value: 'Friends' })).ok, true, 'a built-in theme, as the picker allows');
  assert.deepEqual(state.sets, ['friends']);
  reset('office');
  assert.equal((await say({ key: 'officeTheme', value: 'got' })).ok, true, 'by id where the label differs');
  assert.deepEqual(state.sets, ['got']);
  assert.deepEqual(state.patches, []);
});

test('voice refuses a theme that is not a built-in or an installed pack, and changes nothing', async () => {
  for (const value of ['starwars', 'other-pack', '', '   ', 'toString', '__proto__']) {
    reset('office');
    const r = await say({ key: 'officeTheme', value });
    assert.equal(r.ok, false, `${JSON.stringify(value)}: ${r.spoken}`);
    assert.match(r.spoken, /The choices are: The Office, .*TES\./);
    assert.deepEqual(state.sets, [], JSON.stringify(value));
    assert.deepEqual(state.patches, []);
  }
});

test('the same theme again is a no-op; other settings still go through the policy table', async () => {
  reset('tes');
  const r = await say({ key: 'officeTheme', value: 'TES' });
  assert.equal(r.ok, true);
  assert.match(r.spoken, /already TES/);
  assert.deepEqual(state.sets, []);
  reset('office');
  const n = await say({ key: 'notifications', value: 'off' });
  assert.equal(n.ok, true, n.spoken);
  assert.deepEqual(state.patches, [{ notifications: false }]);
  assert.deepEqual(state.sets, []);
});

test('wiring: voice and the Settings picker share one function; the legacy global key stays out of the voice policy', () => {
  const ra = src('src/main/realtimeActions.ts');
  assert.doesNotMatch(ra, /^\s*officeTheme: \{ tier:/m, 'no global officeTheme entry in SETTING_POLICY');
  const ix = src('src/main/index.ts');
  assert.match(ix, /ipcMain\.handle\('config:setProjectTheme', \(_evt, theme: unknown\) => chooseProjectTheme\(theme\)\);/);
  assert.match(ix, /setProjectTheme: \(theme\) => \{ chooseProjectTheme\(theme\); \}/);
  assert.match(ix, /function chooseProjectTheme\(theme: unknown\): HarnessConfig \{[\s\S]{0,900}?return setProjectThemeForHome\(home, theme\);\r?\n\}/);
  // The floor shows the new theme at once, as after the picker.
  const ac = src('src/renderer/src/realtime/actions.ts');
  assert.match(ac, /setOfficeTheme\(floorSceneTheme\(resolveProjectTheme\(c, c\.harnessHome\), c\.tvShowOffices\) as ThemeId\)/);
  assert.match(ac, /act\('update_setting', input, \/\^\(officeTheme\|projectTheme\|theme\)\$\/\.test\(String\(obj\(input\)\.key \?\? ''\)\) \? showProjectTheme : undefined\)/);
  assert.match(ac, /else if \(onOk\) await onOk\(\)/);
});
