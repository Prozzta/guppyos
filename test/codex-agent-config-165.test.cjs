'use strict';
/**
 * CODEX-BLOAT-165: what OUR per-agent Codex config.toml changes relative to the seed copied from
 * the user's ~/.codex/config.toml, and that the user's file itself is never written.
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

/** The shape of the Human's global config (plugins as quoted-key tables, mixed with others). */
const SEED = [
  'model = "gpt-6-astra"',
  'model_reasoning_effort = "high"',
  '[windows]',
  'sandbox = "unelevated"',
  '',
  '[projects.\'c:\\przedit\']',
  'trust_level = "trusted"',
  '',
  '[plugins."codex-app-tools@openai-bundled"]',
  'enabled = true',
  '',
  '[plugins."browser@openai-bundled"]',
  'enabled = true',
  '',
  '[plugins."pdf@openai-primary-runtime"]',
  'enabled = false',
  '',
  '[plugins."sites@openai-bundled"]',
  '',
  '[features]',
  'js_repl = false',
  '',
  '[mcp_servers.node_repl.env]',
  'enabled = true',
  ''
].join('\n');

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-cfg-'));
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

async function agentConfig(t, seed = SEED, opts = {}) {
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, opts);
  const text = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  return { s, inj, text, cfg: toml.parse(text) };
}

// ── fix 5: plugins off ─────────────────────────────────────────────────────────────────────

test('fix 5: disableCodexPlugins turns every [plugins.*] off, adds enabled=false where missing, touches nothing else', () => {
  const { text, disabled } = C.disableCodexPlugins(SEED);
  const cfg = toml.parse(text);
  assert.equal(disabled, 3, 'two enabled=true rewritten + one table with no key');
  for (const [name, p] of Object.entries(cfg.plugins)) assert.equal(p.enabled, false, name);
  assert.equal(cfg.mcp_servers.node_repl.env.enabled, true, 'a non-plugin table is untouched');
  assert.equal(cfg.features.js_repl, false);
  assert.equal(cfg.model, 'gpt-6-astra');
  assert.equal(C.disableCodexPlugins('model = "m"\n').disabled, 0, 'no plugins: no change');
  assert.equal(C.disableCodexPlugins('model = "m"\n').text, 'model = "m"\n');
});

test('fix 5: the generated per-agent config.toml has every plugin off; the global config.toml is byte-identical afterwards', async (t) => {
  const { s, cfg } = await agentConfig(t);
  for (const [name, p] of Object.entries(cfg.plugins)) assert.equal(p.enabled, false, name);
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'our hooks are still wired');
  assert.match(cfg.developer_instructions, /You are "Dwight"/);
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), SEED, 'the global file is never written');
});

// ── fix 6: auto-compact limit ─────────────────────────────────────────────────────────────

test('fix 6: CODEX_AUTO_COMPACT_TOKEN_LIMIT is 120000', () => {
  assert.equal(C.CODEX_AUTO_COMPACT_TOKEN_LIMIT, 120000);
});

test('fix 6: setCodexTopLevelKeys replaces a seed top-level value (bare or quoted), leaves table keys, and null only removes', () => {
  const seed = 'model = "m"\nmodel_auto_compact_token_limit = 999\n"model_auto_compact_token_limit" = 5\n\n[profiles.p]\nmodel_auto_compact_token_limit = 7\n';
  const out = C.setCodexTopLevelKeys(seed, { model_auto_compact_token_limit: 120000 });
  const cfg = toml.parse(out); // a duplicate key would throw
  assert.equal(cfg.model_auto_compact_token_limit, 120000);
  assert.equal(cfg.profiles.p.model_auto_compact_token_limit, 7, 'a profile value is the user\'s choice');
  assert.equal(cfg.model, 'm');
  const removed = toml.parse(C.setCodexTopLevelKeys(seed, { model_auto_compact_token_limit: null }));
  assert.equal(removed.model_auto_compact_token_limit, undefined);
  assert.equal(toml.parse(C.setCodexTopLevelKeys('', { a_limit: 5 })).a_limit, 5, 'an empty seed');
});

test('Route A: setCodexFeatureFlags pins retain_client_developer_messages off without changing other feature flags', () => {
  const seed = '[features]\nretain_client_developer_messages = true\njs_repl = false\n\n[profiles.p]\nretain_client_developer_messages = true\n';
  const cfg = toml.parse(C.setCodexFeatureFlags(seed, { retain_client_developer_messages: false }));
  assert.equal(cfg.features.retain_client_developer_messages, false);
  assert.equal(cfg.features.js_repl, false);
  assert.equal(cfg.profiles.p.retain_client_developer_messages, true, 'a profile key is untouched');
  assert.equal(toml.parse(C.setCodexFeatureFlags('model = "m"\n', { retain_client_developer_messages: false })).features.retain_client_developer_messages, false, 'a missing table is added');
});

test('fix 6: the generated per-agent config.toml carries model_auto_compact_token_limit = 120000 at top level', async (t) => {
  const { cfg, text } = await agentConfig(t, 'model_auto_compact_token_limit = 250000\n' + SEED);
  assert.equal(cfg.model_auto_compact_token_limit, 120000);
  assert.ok(text.indexOf('model_auto_compact_token_limit = 120000') < text.indexOf('['), 'before the first table');
  assert.match(cfg.developer_instructions, /You are "Dwight"/, 'the instructions are still set');
});

test('Route A: generated Codex config pins retain_client_developer_messages = false even when the seed enables it', async (t) => {
  const { cfg } = await agentConfig(t, '[features]\nretain_client_developer_messages = true\n');
  assert.equal(cfg.features.retain_client_developer_messages, false);
});
