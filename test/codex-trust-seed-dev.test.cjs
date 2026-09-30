'use strict';
/**
 * TRUST-SEED-175, DEV half: with MUNDER_DEV=1 (set BEFORE any product module loads, as DEV_ISOLATION
 * is read at load) the seed sanitiser still drops the USER's [projects.*] list, and the agent's OWN
 * cwd entry is added AFTER it, so a DEV codex agent meets no trust screen. HOME redirected + asserted.
 */
process.env.MUNDER_DEV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const iso = loadTs('src/main/devIsolation.ts');
const ts = loadTs('src/main/codexTrustSeed.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const SEED = ['model = "gpt-6-astra"', '', "[projects.'c:\\przedit']", 'trust_level = "trusted"', ''].join('\n');

test('DEV: the user\'s trust list is dropped by the sanitise, and the agent\'s own cwd is trusted after it', async (t) => {
  assert.equal(iso.DEV_ISOLATION, true, 'DEV mode is on in this process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-seed-dev-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  let hive = null;
  t.after(() => {
    if (hive) hive.dispose();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), SEED);
  // The DEV credential migration's bound is the FIXED DEV root (C:\Dunder\MunderDevData\hive\agents),
  // which a test must never use; it is stubbed to "nothing to migrate" (no link exists here). The
  // config seeding under test is untouched by the stub.
  const realMigrate = iso.migrateCodexAuthLink;
  iso.migrateCodexAuthLink = () => ({ ok: true, action: 'none' });
  t.after(() => { iso.migrateCodexAuthLink = realMigrate; });
  hive = new HiveManager(() => path.join(home, 'harness'));
  const cwd = path.join(home, 'work', 'dev-x');
  fs.mkdirSync(cwd, { recursive: true });
  const inj = await hive.ensureAgent({ id: 'cxd-1', name: 'Codex', provider: 'codex', cwd });
  assert.equal(inj.refusal, undefined);
  const text = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  const cfg = toml.parse(text);
  const keys = Object.keys(cfg.projects || {});
  assert.deepEqual(keys, [ts.codexProjectTrustKey(cwd)], 'only the agent\'s own cwd: the user\'s c:\\przedit was dropped');
  assert.equal(cfg.projects[keys[0]].trust_level, 'trusted');
  // The pure order: the sanitiser alone drops everything, so the entry must come after it.
  const out = iso.sanitizeCodexConfigForDev(SEED, { codexHome: inj.env.CODEX_HOME, pipeSuffix: 'dev-x' });
  assert.equal(out.droppedTables, 1);
  assert.equal(iso.sanitizeCodexConfigForDev(ts.withAgentTrust(out.text, cwd).text, { codexHome: inj.env.CODEX_HOME, pipeSuffix: 'dev-x' }).droppedTables, 1, 'had the seed come BEFORE the sanitise, it would be dropped');
});
