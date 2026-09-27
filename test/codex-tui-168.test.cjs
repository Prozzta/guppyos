'use strict';
/**
 * MEMSPIKE-168: OUR per-agent Codex config.toml always carries the selected [tui] keys that bound
 * Codex's transcript replay on a pty resize, whatever the seed copied from the user's
 * ~/.codex/config.toml says; the user's other tui settings are kept and the global file is never
 * written. Two sets (MS-169 F2), one selection (the Human's choice):
 *   - FULLSCREEN: alternate screen + fullscreen transcript + reflow cap (no replay at all);
 *   - REFLOW_ONLY: the reflow cap only; the seed's own mode keys stay.
 * Every transform test runs for BOTH sets, so flipping the selection is one line.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/codexAgentConfig.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const FULLSCREEN = { alternate_screen: 'always', fullscreen_transcript: true, terminal_resize_reflow_max_rows: 50 };
const REFLOW_ONLY = { terminal_resize_reflow_max_rows: 50 };
const SETS = [['FULLSCREEN', C.CODEX_TUI_KEYS_FULLSCREEN], ['REFLOW_ONLY', C.CODEX_TUI_KEYS_REFLOW_ONLY]];

/** Ours are set; for a set that leaves the mode alone, the seed's own mode keys survive. */
function assertOurs(tui, keys, seedMode = {}) {
  for (const [k, v] of Object.entries(keys)) assert.equal(tui[k], v, k);
  for (const [k, v] of Object.entries(seedMode)) if (!(k in keys)) assert.equal(tui[k], v, `the seed's ${k} is kept`);
}

test('the two sets are the measured ones; the selection is REFLOW_ONLY until the Human answers', () => {
  assert.deepEqual({ ...C.CODEX_TUI_KEYS_FULLSCREEN }, FULLSCREEN);
  assert.deepEqual({ ...C.CODEX_TUI_KEYS_REFLOW_ONLY }, REFLOW_ONLY);
  // Pins THE SELECTION. Changing it is the Human's call (RENDERER-MEMSPIKE, never-shrink-scrollback).
  assert.equal(C.CODEX_TUI_KEYS, C.CODEX_TUI_KEYS_REFLOW_ONLY);
});

for (const [name, KEYS] of SETS) {
  test(`${name}: a seed [tui] table in inline mode gets ours in place; the user's other tui keys stay`, () => {
    const seed = [
      'model = "m"',
      '',
      '[tui]',
      'alternate_screen = "never"',
      '"fullscreen_transcript" = false',
      'theme = "dark"',
      'terminal_resize_reflow_max_rows = 0',
      '',
      '[tui.notifications]',
      'enabled = true',
      '',
      '[features]',
      'x = 1',
      ''
    ].join('\n');
    const out = C.setCodexTuiKeys(seed, KEYS);
    const cfg = toml.parse(out); // a duplicate key would throw
    assertOurs(cfg.tui, KEYS, { alternate_screen: 'never', fullscreen_transcript: false });
    assert.equal(cfg.tui.theme, 'dark');
    assert.equal(cfg.tui.notifications.enabled, true);
    assert.equal(cfg.features.x, 1);
    assert.equal(cfg.model, 'm');
    assert.equal((out.match(/^\s*\[tui\]/gm) || []).length, 1, 'one [tui] header');
  });

  test(`${name}: no [tui] in the seed: a [tui] table is appended (valid after a [tui.*] sub-table too); an empty seed works`, () => {
    const cfg = toml.parse(C.setCodexTuiKeys('model = "m"\n\n[tui.notifications]\nenabled = false\n', KEYS));
    assertOurs(cfg.tui, KEYS);
    assert.equal(cfg.tui.notifications.enabled, false);
    assertOurs(toml.parse(C.setCodexTuiKeys('', KEYS)).tui, KEYS);
  });

  test(`${name}: top-level dotted tui.* keys in the seed: ours are written as dotted keys too`, () => {
    // (The `toml` package here predates dotted keys, so this one is checked as text.)
    const seed = 'tui.alternate_screen = "never"\ntui.theme = "light"\nmodel = "m"\n\n[features]\nx = 1\n';
    const out = C.setCodexTuiKeys(seed, KEYS);
    const top = out.slice(0, out.indexOf('[features]'));
    for (const [k, v] of Object.entries(KEYS)) {
      assert.match(top, new RegExp(`^tui\\.${k} = ${typeof v === 'string' ? JSON.stringify(v) : v}$`, 'm'), k);
    }
    assert.match(top, /^tui\.theme = "light"$/m, 'the user\'s other tui key stays');
    if ('alternate_screen' in KEYS) assert.doesNotMatch(out, /never/);
    else assert.match(top, /^tui\.alternate_screen = "never"$/m, 'the seed\'s mode is kept');
    assert.doesNotMatch(out, /^\s*\[tui\]/m, 'no [tui] header after dotted tui keys');
    assert.equal(toml.parse(out.slice(out.indexOf('[features]'))).features.x, 1);
  });

  test(`${name}: MS-169 F1: a top-level INLINE table tui = { ... } becomes one valid [tui] table (its pairs + ours)`, () => {
    const seed = [
      'model = "m"',
      'tui = { alternate_screen = "never", theme = "a, b }", notifications = { enabled = true, kinds = ["x", "y"] }, terminal_resize_reflow_max_rows = 0 } # mine',
      'approval_policy = "never"',
      '',
      '[features]',
      'x = 1',
      ''
    ].join('\n');
    assert.ok(toml.parse(seed).tui, 'the seed itself is valid TOML');
    const out = C.setCodexTuiKeys(seed, KEYS);
    const cfg = toml.parse(out); // "Cannot redefine existing key tui" before the fix
    assertOurs(cfg.tui, KEYS, { alternate_screen: 'never' });
    assert.equal(cfg.tui.theme, 'a, b }', 'quoted commas and braces are not separators');
    assert.deepEqual(JSON.parse(JSON.stringify(cfg.tui.notifications)), { enabled: true, kinds: ['x', 'y'] });
    assert.equal(cfg.model, 'm');
    assert.equal(cfg.approval_policy, 'never', 'a top-level key after the inline table stays top-level');
    assert.equal(cfg.features.x, 1);
    assert.equal((out.match(/^\s*\[tui\]/gm) || []).length, 1, 'one [tui] header');
    assert.doesNotMatch(out, /^\s*tui\s*=/m, 'the inline table is gone');
    // Idempotent on the rewritten form.
    assert.deepEqual(toml.parse(C.setCodexTuiKeys(out, KEYS)), cfg);
  });

  test(`${name}: an inline table spread over lines (TOML 1.1), with a comment, and a quoted "tui" key`, () => {
    const seed = '"tui" = {\n  alternate_screen = "never", # inline\n  theme = "dark"\n}\nmodel = "m"\n';
    const cfg = toml.parse(C.setCodexTuiKeys(seed, KEYS));
    assertOurs(cfg.tui, KEYS, { alternate_screen: 'never' });
    assert.equal(cfg.tui.theme, 'dark');
    assert.equal(cfg.model, 'm');
    const empty = toml.parse(C.setCodexTuiKeys('tui = {}\n', KEYS));
    assertOurs(empty.tui, KEYS);
  });

  test(`${name}: idempotent: applying twice leaves one copy of each key`, () => {
    const once = C.setCodexTuiKeys('[tui]\nalternate_screen = "never"\n', KEYS);
    const twice = C.setCodexTuiKeys(once, KEYS);
    assertOurs(toml.parse(twice).tui, KEYS, { alternate_screen: 'never' });
    assert.equal((twice.match(/alternate_screen/g) || []).length, 1);
    assert.equal((twice.match(/terminal_resize_reflow_max_rows/g) || []).length, 1);
  });
}

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms168-cfg-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}

test('the generated per-agent config.toml carries the SELECTED keys over a seed\'s inline mode; the global config.toml is byte-identical', async (t) => {
  const seed = 'model = "gpt-6-astra"\n\n[tui]\nalternate_screen = "never"\nfullscreen_transcript = false\ntheme = "dark"\n';
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assertOurs(cfg.tui, C.CODEX_TUI_KEYS, { alternate_screen: 'never', fullscreen_transcript: false });
  assert.equal(cfg.tui.theme, 'dark');
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'our hooks are still wired');
  assert.match(cfg.developer_instructions, /You are "Dwight"/);
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed, 'the global file is never written');
});

test('the generated per-agent config.toml is valid over an INLINE-table tui seed (MS-169 F1: Codex would not start)', async (t) => {
  const seed = 'model = "gpt-6-astra"\ntui = { alternate_screen = "never", theme = "dark" }\n';
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-3', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assertOurs(cfg.tui, C.CODEX_TUI_KEYS, { alternate_screen: 'never' });
  assert.equal(cfg.tui.theme, 'dark');
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'our hooks are still wired');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed, 'the global file is never written');
});

test('with no user config.toml at all, the generated one still carries the keys', async (t) => {
  const s = sandbox(t, '');
  fs.rmSync(path.join(s.home, '.codex', 'config.toml'));
  const inj = await s.hive.ensureAgent({ id: 'dw-2', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assertOurs(toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8')).tui, C.CODEX_TUI_KEYS);
});
