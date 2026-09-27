'use strict';
/**
 * MEMSPIKE-168: OUR per-agent Codex config.toml always carries the [tui] keys that stop Codex
 * replaying its whole transcript on every pty resize (alternate screen + fullscreen transcript,
 * reflow capped), whatever the seed copied from the user's ~/.codex/config.toml says; the user's
 * other tui settings are kept and the global file is never written.
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

const WANT = { alternate_screen: 'always', fullscreen_transcript: true, terminal_resize_reflow_max_rows: 50 };

function assertOurs(tui) {
  for (const [k, v] of Object.entries(WANT)) assert.equal(tui[k], v, k);
}

test('CODEX_TUI_KEYS is the measured no-replay set', () => {
  assert.deepEqual({ ...C.CODEX_TUI_KEYS }, WANT);
});

test('a seed [tui] table that turns inline mode on is overridden in place; the user\'s other tui keys stay', () => {
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
  const out = C.setCodexTuiKeys(seed, C.CODEX_TUI_KEYS);
  const cfg = toml.parse(out); // a duplicate key would throw
  assertOurs(cfg.tui);
  assert.equal(cfg.tui.theme, 'dark');
  assert.equal(cfg.tui.notifications.enabled, true);
  assert.equal(cfg.features.x, 1);
  assert.equal(cfg.model, 'm');
  assert.equal((out.match(/^\s*\[tui\]/gm) || []).length, 1, 'one [tui] header');
});

test('no [tui] in the seed: a [tui] table is appended (valid after a [tui.*] sub-table too); an empty seed works', () => {
  const cfg = toml.parse(C.setCodexTuiKeys('model = "m"\n\n[tui.notifications]\nenabled = false\n', C.CODEX_TUI_KEYS));
  assertOurs(cfg.tui);
  assert.equal(cfg.tui.notifications.enabled, false);
  assertOurs(toml.parse(C.setCodexTuiKeys('', C.CODEX_TUI_KEYS)).tui);
});

test('top-level dotted tui.* keys in the seed: ours are written as dotted keys too (a later [tui] header would be invalid)', () => {
  // (The `toml` package here predates dotted keys, so this one is checked as text.)
  const seed = 'tui.alternate_screen = "never"\ntui.theme = "light"\nmodel = "m"\n\n[features]\nx = 1\n';
  const out = C.setCodexTuiKeys(seed, C.CODEX_TUI_KEYS);
  const top = out.slice(0, out.indexOf('[features]'));
  assert.match(top, /^tui\.alternate_screen = "always"$/m);
  assert.match(top, /^tui\.fullscreen_transcript = true$/m);
  assert.match(top, /^tui\.terminal_resize_reflow_max_rows = 50$/m);
  assert.match(top, /^tui\.theme = "light"$/m, 'the user\'s other tui key stays');
  assert.doesNotMatch(out, /never/);
  assert.doesNotMatch(out, /^\s*\[tui\]/m, 'no [tui] header after dotted tui keys');
  assert.equal(toml.parse(out.slice(out.indexOf('[features]'))).features.x, 1);
});

test('idempotent: applying twice leaves one copy of each key', () => {
  const once = C.setCodexTuiKeys('[tui]\nalternate_screen = "never"\n', C.CODEX_TUI_KEYS);
  const twice = C.setCodexTuiKeys(once, C.CODEX_TUI_KEYS);
  assertOurs(toml.parse(twice).tui);
  assert.equal((twice.match(/alternate_screen/g) || []).length, 1);
});

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

test('the generated per-agent config.toml overrides a seed\'s inline mode; the global config.toml is byte-identical', async (t) => {
  const seed = 'model = "gpt-6-astra"\n\n[tui]\nalternate_screen = "never"\nfullscreen_transcript = false\ntheme = "dark"\n';
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  const cfg = toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assertOurs(cfg.tui);
  assert.equal(cfg.tui.theme, 'dark');
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'our hooks are still wired');
  assert.match(cfg.developer_instructions, /You are "Dwight"/);
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed, 'the global file is never written');
});

test('with no user config.toml at all, the generated one still carries the keys', async (t) => {
  const s = sandbox(t, '');
  fs.rmSync(path.join(s.home, '.codex', 'config.toml'));
  const inj = await s.hive.ensureAgent({ id: 'dw-2', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assertOurs(toml.parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8')).tui);
});
