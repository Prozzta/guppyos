'use strict';
/**
 * CODEX-BLOAT-165 fix 5, as the Human chose: "Hive Codex agents inherit my Codex plugins" is a
 * Settings choice, OFF by default. Off = our per-agent config.toml turns the copied plugins off;
 * On = they are left as the user's file has them. The user's ~/.codex/config.toml is never
 * written either way.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built; the app config lives in a temp
 * userData (electron's app.getPath is stubbed).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-plg-data-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const ui = loadTs('src/renderer/src/components/CodexPluginsSetting.tsx');

// Mixed on/off plugins, so "left as-is" is distinguishable from "all on" and "all off".
const SEED = [
  'model = "gpt-5.5"',
  '',
  '[plugins."browser@openai-bundled"]',
  'enabled = true',
  '',
  '[plugins."pdf@openai-primary-runtime"]',
  'enabled = false',
  '',
  '[plugins."sites@openai-bundled"]',
  'enabled = true',
  ''
].join('\n');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-plg-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), SEED);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}

async function pluginsFor(t, opts) {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, opts);
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), SEED, 'the global config.toml is byte-identical');
  return Object.fromEntries(Object.entries(cfg.plugins).map(([k, v]) => [k, v.enabled]));
}

const ALL_OFF = { 'browser@openai-bundled': false, 'pdf@openai-primary-runtime': false, 'sites@openai-bundled': false };
const AS_SEED = { 'browser@openai-bundled': true, 'pdf@openai-primary-runtime': false, 'sites@openai-bundled': true };

// ── the generated per-agent config.toml ─────────────────────────────────────────────────────

test('default (setting absent): every inherited plugin is OFF in our config.toml; the global file is unchanged', async (t) => {
  assert.deepEqual(await pluginsFor(t, {}), ALL_OFF);
});

test('Off (false): every inherited plugin is OFF; the global file is unchanged', async (t) => {
  assert.deepEqual(await pluginsFor(t, { codexInheritPlugins: false }), ALL_OFF);
});

test('On (true): the plugins are left exactly as the user has them; the global file is unchanged', async (t) => {
  assert.deepEqual(await pluginsFor(t, { codexInheritPlugins: true }), AS_SEED);
});

test('only an explicit true inherits: a truthy non-boolean does not', async (t) => {
  assert.deepEqual(await pluginsFor(t, { codexInheritPlugins: 'yes' }), ALL_OFF);
});

// ── persistence (the app config) ─────────────────────────────────────────────────────────

test('app config: default false; true and false persist; a non-boolean is refused and changes nothing', () => {
  assert.equal(readConfig().codexInheritPlugins, false, 'default');
  assert.equal(writeConfig({ codexInheritPlugins: true }).codexInheritPlugins, true);
  assert.equal(readConfig().codexInheritPlugins, true, 'read back');
  for (const bad of ['true', 1, null, {}]) {
    assert.throws(() => writeConfig({ codexInheritPlugins: bad }), /invalid codexInheritPlugins/, JSON.stringify(bad));
    assert.equal(readConfig().codexInheritPlugins, true, 'unchanged after a refused write');
  }
  assert.equal(writeConfig({ autoMode: true }).codexInheritPlugins, true, 'an unrelated write keeps it');
  assert.equal(writeConfig({ codexInheritPlugins: false }).codexInheritPlugins, false);
});

test('main passes the saved setting to the spawn (only an explicit true)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /codexInheritPlugins: readConfig\(\)\.codexInheritPlugins === true/);
});

// ── the Settings control ─────────────────────────────────────────────────────────────────

test('the control renders off by default, with the restart hint and the help text', () => {
  const html = renderToStaticMarkup(React.createElement(ui.CodexPluginsSetting));
  assert.ok(html.includes('Hive Codex agents inherit my Codex plugins'));
  assert.match(html, />off</, 'off until main answers');
  assert.ok(html.includes('running Codex agents keep their current plugins until they are restarted'));
  assert.ok(html.includes('Your own Codex config is not changed either way'));
});

test('the control follows the 1.1.57 rules and sits next to the tool cap in Agents & Models', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'CodexPluginsSetting.tsx'), 'utf8');
  assert.match(src, /useEffect\(\(\) => \{\s*void window\.cth\.getConfig\(\)/, 'reads the CURRENT config on mount');
  assert.match(src, /update: \(patch\) => window\.cth\.updateConfig\(patch\)/, 'saves through window.cth.updateConfig');
  assert.match(src, /fx\.update\(\{ codexInheritPlugins: value \}\)/, 'saves only its key');
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgb\(|\bwhite\b|\bblack\b/, 'theme tokens only (dark mode)');
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert.match(modal, /<CodexToolOutputSetting \/>[\s\S]{0,300}<CodexPluginsSetting \/>/);
});

test('a save shows what main saved; a FAILED save puts the previous value back and says so', async () => {
  const log = [];
  const fx = (update) => ({ update, setOn: (v) => log.push(['on', v]), setError: (e) => log.push(['err', e]) });
  await ui.saveCodexInheritPlugins(true, false, fx(async (p) => ({ codexInheritPlugins: p.codexInheritPlugins })));
  assert.deepEqual(log.splice(0), [['on', true], ['on', true], ['err', null]]);
  await ui.saveCodexInheritPlugins(true, false, fx(async () => { throw new Error('refused'); }));
  assert.deepEqual(log.splice(0), [['on', true], ['on', false], ['err', ui.CODEX_PLUGINS_COPY.saveFailed]]);
  await ui.saveCodexInheritPlugins(false, true, fx(async () => { throw new Error('refused'); }));
  assert.deepEqual(log.splice(0), [['on', false], ['on', true], ['err', ui.CODEX_PLUGINS_COPY.saveFailed]]);
});

test('codexInheritPluginsOf: only an explicit true is on', () => {
  assert.equal(ui.codexInheritPluginsOf({ codexInheritPlugins: true }), true);
  assert.equal(ui.codexInheritPluginsOf({ codexInheritPlugins: false }), false);
  assert.equal(ui.codexInheritPluginsOf({ codexInheritPlugins: 'true' }), false);
  assert.equal(ui.codexInheritPluginsOf({}), false);
  assert.equal(ui.codexInheritPluginsOf(null), false);
});
