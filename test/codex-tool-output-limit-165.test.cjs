'use strict';
/**
 * CODEX-BLOAT-165 fix 2: the Codex tool-output cap (`tool_output_token_limit`), configurable in
 * Settings → Agents & Models. Default 4000, 1000-10000, or Off. Persisted in the app config and
 * written ONLY into our per-agent Codex config.toml (Off = no key). Never the global file.
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-cfgdata-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const L = loadTs('src/shared/codexToolOutputLimit.ts');
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const ui = loadTs('src/renderer/src/components/CodexToolOutputSetting.tsx');

// ── the value contract ────────────────────────────────────────────────────────────────────

test('default 4000, range 1000-10000', () => {
  assert.equal(L.CODEX_TOOL_OUTPUT_LIMIT_DEFAULT, 4000);
  assert.equal(L.CODEX_TOOL_OUTPUT_LIMIT_MIN, 1000);
  assert.equal(L.CODEX_TOOL_OUTPUT_LIMIT_MAX, 10000, "Codex's own policy limit (audit F4)");
});

test('normalize: off, in-range numbers, clamping, rounding; garbage is INVALID (null)', () => {
  assert.equal(L.normalizeCodexToolOutputLimit('off'), 'off');
  assert.equal(L.normalizeCodexToolOutputLimit(' OFF '), 'off');
  assert.equal(L.normalizeCodexToolOutputLimit(7000), 7000);
  assert.equal(L.normalizeCodexToolOutputLimit(999), 1000, 'clamped up');
  assert.equal(L.normalizeCodexToolOutputLimit(-5), 1000, 'clamped up');
  assert.equal(L.normalizeCodexToolOutputLimit(50000), 10000, 'clamped down');
  assert.equal(L.normalizeCodexToolOutputLimit(15000), 10000, 'above Codex\'s own 10,000 is clamped');
  assert.equal(L.normalizeCodexToolOutputLimit(4000.6), 4001, 'rounded');
  for (const bad of [NaN, Infinity, '4000', 'abc', '', null, undefined, true, {}, []]) {
    assert.equal(L.normalizeCodexToolOutputLimit(bad), null, JSON.stringify(bad));
  }
});

test('for the config.toml: absent/invalid -> the default, off -> no key (null), a number -> itself', () => {
  assert.equal(L.codexToolOutputLimitForConfig(undefined), 4000);
  assert.equal(L.codexToolOutputLimitForConfig('garbage'), 4000);
  assert.equal(L.codexToolOutputLimitForConfig('off'), null);
  assert.equal(L.codexToolOutputLimitForConfig(8000), 8000);
  assert.equal(L.codexToolOutputLimitForConfig(25000), 10000);
});

test('the Settings field: whole numbers only (clamped, and it says so); anything else refused', () => {
  assert.deepEqual(L.parseCodexToolOutputLimitInput('6000'), { ok: true, value: 6000, clamped: false });
  assert.deepEqual(L.parseCodexToolOutputLimitInput(' 8,000 '), { ok: true, value: 8000, clamped: false });
  assert.deepEqual(L.parseCodexToolOutputLimitInput('500'), { ok: true, value: 1000, clamped: true });
  assert.deepEqual(L.parseCodexToolOutputLimitInput('99999'), { ok: true, value: 10000, clamped: true });
  for (const bad of ['', 'abc', '4.5', '-3', '4k', 'off']) {
    const r = L.parseCodexToolOutputLimitInput(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /whole number from 1000 to 10000/);
  }
});

// ── persistence (the app config) ─────────────────────────────────────────────────────────

test('app config: the default is 4000; a custom value, a clamped value and Off persist; invalid is refused and changes nothing', () => {
  assert.equal(readConfig().codexToolOutputTokenLimit, 4000, 'default');
  assert.equal(writeConfig({ codexToolOutputTokenLimit: 7000 }).codexToolOutputTokenLimit, 7000);
  assert.equal(readConfig().codexToolOutputTokenLimit, 7000, 'custom value read back');
  assert.equal(writeConfig({ codexToolOutputTokenLimit: 90000 }).codexToolOutputTokenLimit, 10000, 'clamped');
  assert.equal(writeConfig({ codexToolOutputTokenLimit: 'off' }).codexToolOutputTokenLimit, 'off');
  assert.equal(readConfig().codexToolOutputTokenLimit, 'off', 'Off read back');
  for (const bad of ['abc', null, {}, NaN]) {
    assert.throws(() => writeConfig({ codexToolOutputTokenLimit: bad }), /invalid codexToolOutputTokenLimit/, JSON.stringify(bad));
    assert.equal(readConfig().codexToolOutputTokenLimit, 'off', 'unchanged after a refused write');
  }
  assert.equal(writeConfig({ autoMode: true }).codexToolOutputTokenLimit, 'off', 'an unrelated write keeps it');
  writeConfig({ codexToolOutputTokenLimit: 4000 });
});

// ── the generated per-agent config.toml ─────────────────────────────────────────────────────

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-tol-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const seed = 'model = "m"\ntool_output_token_limit = 99\n\n[plugins."pdf@x"]\nenabled = true\n';
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive, seed };
}
async function cfgFor(t, value) {
  const s = sandbox(t);
  const opts = value === undefined ? {} : { codexToolOutputTokenLimit: value };
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, opts);
  const text = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), s.seed, 'the global config.toml is never written');
  return { text, cfg: toml.parse(text) };
}

test('config.toml: absent setting -> tool_output_token_limit = 4000 (replacing the seed value), top level', async (t) => {
  const { cfg, text } = await cfgFor(t, undefined);
  assert.equal(cfg.tool_output_token_limit, 4000);
  assert.equal((text.match(/^tool_output_token_limit/mg) || []).length, 1, 'one key, no duplicate');
  assert.ok(text.indexOf('tool_output_token_limit = 4000') < text.indexOf('['), 'before the first table');
});

test('config.toml: a custom value reaches it; an out-of-range one arrives clamped', async (t) => {
  assert.equal((await cfgFor(t, 8000)).cfg.tool_output_token_limit, 8000);
  assert.equal((await cfgFor(t, 500)).cfg.tool_output_token_limit, 1000);
});

test('config.toml: Off writes no key of ours (the other limits and fixes stay)', async (t) => {
  const { cfg, text } = await cfgFor(t, 'off');
  assert.ok(!/tool_output_token_limit = (4000|1000|10000)/.test(text), 'no key of ours');
  assert.equal(cfg.model_auto_compact_token_limit, 120000);
  assert.equal(cfg.plugins['pdf@x'].enabled, false);
});

// ── the Settings control ─────────────────────────────────────────────────────────────────

test('the control renders the default, an on/off switch, the unit, the restart hint and the verified truncation wording', () => {
  const html = renderToStaticMarkup(React.createElement(ui.CodexToolOutputSetting));
  assert.ok(html.includes('Codex tool output cap'));
  assert.match(html, /value="4000"/, 'shows the default until main answers');
  assert.ok(html.includes('tokens per tool output'));
  assert.ok(html.includes('running Codex agents keep their current cap until they are restarted'));
  assert.ok(html.includes('keeps its beginning and its end'));
  assert.ok(html.includes('…N tokens truncated…'));
  assert.match(html, /your own Codex config is not changed/);
});

test('the control follows the 1.1.57 rules: reads the CURRENT config on mount, theme tokens only (dark mode)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'CodexToolOutputSetting.tsx'), 'utf8');
  assert.match(src, /useEffect\(\(\) => \{\s*void window\.cth\.getConfig\(\)/);
  assert.match(src, /window\.cth\.updateConfig\(\{ codexToolOutputTokenLimit: value \}\)/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgb\(|\bwhite\b|\bblack\b/, 'no hard-coded colour');
  assert.match(src, /background: 'var\(--cth-paper-100\)', color: 'var\(--cth-ink-900\)'/);
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'), 'utf8');
  assert.match(modal, /<AiEnginesSettings config=\{config\} \/>[\s\S]{0,300}<CodexToolOutputSetting \/>/, 'in Agents & Models, after the engines');
});

test('codexToolOutputSettingOf: the stored value, or the default for absent/invalid', () => {
  assert.equal(ui.codexToolOutputSettingOf({ codexToolOutputTokenLimit: 'off' }), 'off');
  assert.equal(ui.codexToolOutputSettingOf({ codexToolOutputTokenLimit: 8000 }), 8000);
  assert.equal(ui.codexToolOutputSettingOf({}), 4000);
  assert.equal(ui.codexToolOutputSettingOf({ codexToolOutputTokenLimit: 'x' }), 4000);
  assert.equal(ui.codexToolOutputSettingOf(null), 4000);
});
