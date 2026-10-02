'use strict';
/**
 * CODEX-MODEL-SWITCH-PROMPT P1 (1.1.78, Jim; god 92f9b1): once either usage window reaches 90 %, Codex
 * 0.157.1 opens a modal "Approaching rate limits - Switch to gpt-6-luna for lower credit usage?"
 * picker at a turn's end (tui/src/chatwidget/rate_limits.rs:350-372, 462-537; shown from
 * turn_runtime.rs:222). It takes every key until answered, and an agent cannot answer it: Dwight was
 * held from 2026-10-01 20:27Z for 9 hours. Codex's own "never show again" is
 * `[notice] hide_rate_limit_model_nudge = true` (core/src/config/edit.rs:253), read by
 * `rate_limit_switch_prompt_hidden` (:431).
 *
 * The app regenerates every Codex agent's config.toml from the user's on each spawn, so the key is
 * written there by the app:
 *   - the generated config carries it, exactly once;
 *   - a seed [notice] table (hide_world_writable_warning, ...) is joined, never duplicated, and its
 *     other keys are kept; a seed `false` is replaced;
 *   - a respawn (regeneration) keeps it;
 *   - nothing else in the config changes;
 *   - a Claude agent gets no Codex config.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const TOML = require('toml');

const CFG = loadTs('src/main/codexAgentConfig.ts');
const K = {};

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge178-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
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
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  return { home, hive };
}

const lines = (cfg, re) => cfg.split(/\r?\n/).filter((l) => re.test(l));
const NUDGE = /^\s*(notice\.)?hide_rate_limit_model_nudge\s*=/;
const NOTICE_HEADER = /^\s*\[\s*notice\s*\]\s*$/;

async function spawnCodex(s, id = 'dwight-a') {
  const r = await s.hive.ensureAgent({ id, name: 'Dwight', provider: 'codex', cwd: s.home }, { codexNoDaemon: true });
  return { r, cfg: fs.readFileSync(path.join(r.env.CODEX_HOME, 'config.toml'), 'utf8') };
}

K.generatedHasKey = async (t) => {
  const s = sandbox(t, 'model = "gpt-x"\n');
  const { cfg } = await spawnCodex(s);
  assert.deepEqual(lines(cfg, NUDGE), ['hide_rate_limit_model_nudge = true'], 'THE GENERATED CODEX CONFIG HIDES THE RATE-LIMIT MODEL NUDGE, once');
  assert.equal(lines(cfg, NOTICE_HEADER).length, 1, 'one [notice] table');
};
test('P1: every Codex agent\'s generated config.toml says [notice] hide_rate_limit_model_nudge = true', (t) => K.generatedHasKey(t));

K.seedNoticeJoined = async (t) => {
  const s = sandbox(t, 'model = "gpt-x"\n\n[notice]\nhide_world_writable_warning = true\nhide_rate_limit_model_nudge = false\n\n[tui]\nx = 1\n');
  const { cfg } = await spawnCodex(s);
  assert.equal(lines(cfg, NOTICE_HEADER).length, 1, 'A SEED [notice] TABLE IS JOINED, NEVER DUPLICATED');
  assert.deepEqual(lines(cfg, NUDGE), ['hide_rate_limit_model_nudge = true'], 'the seed\'s false is replaced, not kept beside ours');
  assert.deepEqual(lines(cfg, /^\s*hide_world_writable_warning\s*=/), ['hide_world_writable_warning = true'], 'THE SEED\'S OTHER [notice] KEYS ARE KEPT');
  // Both keys sit in the one [notice] table.
  const at = cfg.split(/\r?\n/).findIndex((l) => NOTICE_HEADER.test(l));
  const table = cfg.split(/\r?\n/).slice(at + 1);
  const end = table.findIndex((l) => /^\s*\[/.test(l));
  const body = (end < 0 ? table : table.slice(0, end)).join('\n');
  assert.match(body, /hide_rate_limit_model_nudge = true/);
  assert.match(body, /hide_world_writable_warning = true/);
};
test('P1: a seed [notice] table is joined (one table, its other keys kept, a seed false replaced)', (t) => K.seedNoticeJoined(t));

K.respawnKeeps = async (t) => {
  const s = sandbox(t, '[notice]\nhide_world_writable_warning = true\n');
  const first = await spawnCodex(s);
  // Whatever the agent's own Codex wrote into its copy (a /model choice, a removed key) is
  // replaced by the next spawn's regeneration; ours must come back with it.
  fs.writeFileSync(path.join(first.r.env.CODEX_HOME, 'config.toml'), 'model = "gpt-6-luna"\n');
  const again = await spawnCodex(s);
  assert.equal(again.r.env.CODEX_HOME, first.r.env.CODEX_HOME, 'the same agent home');
  assert.deepEqual(lines(again.cfg, NUDGE), ['hide_rate_limit_model_nudge = true'], 'A RESPAWN (REGENERATION) KEEPS THE KEY');
  assert.equal(lines(again.cfg, NOTICE_HEADER).length, 1);
  assert.equal(again.cfg, first.cfg, 'regeneration is idempotent: the same seed gives the same config');
};
test('P1: a respawn regenerates the config and keeps the key (idempotent)', (t) => K.respawnKeeps(t));

K.nothingElseChanges = () => {
  const seeds = [
    'model = "gpt-x"\n\n[notice]\nhide_world_writable_warning = true\n\n[tui]\nx = 1\n',
    'model = "gpt-x"\n[tui]\nx = 1\n',
    '',
    'model = "gpt-x"\n[notice]\n# a user comment\nhide_world_writable_warning = true\n[projects.\'C:\\\\x\']\ntrust_level = "trusted"\n'
  ];
  for (const seed of seeds) {
    const out = CFG.setCodexRootTableKeys(seed, 'notice', { hide_rate_limit_model_nudge: true });
    // Every seed line is still there, in the same order (ours only adds).
    const outLines = out.split('\n');
    let j = 0;
    for (const l of seed.split('\n').filter((x) => x.trim() !== '')) {
      while (j < outLines.length && outLines[j] !== l) j++;
      assert.ok(j < outLines.length, `SEED LINE KEPT IN ORDER: ${JSON.stringify(l)} in ${JSON.stringify(out)}`);
      j++;
    }
    const added = outLines.filter((l) => l.trim() !== '' && !seed.split('\n').includes(l));
    assert.ok(added.every((l) => l === 'hide_rate_limit_model_nudge = true' || l === '[notice]'), `ONLY OUR KEY (and its table) IS ADDED: ${JSON.stringify(added)}`);
    const parsed = TOML.parse(out);
    assert.equal(parsed.notice.hide_rate_limit_model_nudge, true, 'valid TOML, and Codex reads it as true');
  }
};
test('P1: nothing else in the config changes (every seed line kept in order; valid TOML)', () => K.nothingElseChanges());

K.otherSeedShapes = () => {
  // A top-level inline table and top-level dotted keys forbid a later [notice] header in TOML.
  const inline = CFG.setCodexRootTableKeys('notice = { hide_world_writable_warning = true }\nmodel = "x"\n', 'notice', { hide_rate_limit_model_nudge: true });
  const p = TOML.parse(inline);
  assert.deepEqual({ ...p.notice }, { hide_world_writable_warning: true, hide_rate_limit_model_nudge: true }, 'an inline seed table is joined');
  const dotted = CFG.setCodexRootTableKeys('notice.hide_rate_limit_model_nudge = false\nnotice.hide_world_writable_warning = true\nmodel = "x"\n', 'notice', { hide_rate_limit_model_nudge: true });
  assert.deepEqual(lines(dotted, NUDGE), ['notice.hide_rate_limit_model_nudge = true'], 'a dotted seed false is replaced by a dotted true');
  assert.equal(lines(dotted, NOTICE_HEADER).length, 0, 'no [notice] header beside dotted keys');
  assert.ok(dotted.includes('notice.hide_world_writable_warning = true'));
};
test('P1: an inline or dotted seed notice is joined in its own shape', () => K.otherSeedShapes());

K.claudeUntouched = async (t) => {
  const s = sandbox(t, 'model = "gpt-x"\n');
  const claude = await s.hive.ensureAgent({ id: 'jim-c', name: 'Jim', provider: 'claude', cwd: s.home }, {});
  assert.equal(claude.env.CODEX_HOME, undefined, 'a Claude agent gets no Codex home');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), 'model = "gpt-x"\n', 'THE USER\'S OWN ~/.codex/config.toml IS NEVER WRITTEN');
};
test('P1: the user\'s ~/.codex/config.toml is never written; a Claude agent gets no Codex config', (t) => K.claudeUntouched(t));

test('wiring: installCodexHooks writes the key into the regenerated copy', () => {
  const src = readSource('src/main/hive.ts');
  assert.match(src, /config = setCodexRootTableKeys\(config, 'notice', \{ hide_rate_limit_model_nudge: true \}\);/);
});
