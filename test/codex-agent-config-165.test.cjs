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
