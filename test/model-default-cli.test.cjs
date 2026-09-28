// MODEL-DEFAULT-CLI: new agents (every provider) default to "CLI default" (no --model). The old
// factory `defaultModel: 'claude-fable-5'` seed is gone, a saved one is cleared ONCE by a
// config-load migration (flagged, logged to the hive by main), godModel is untouched, and an
// existing agent's stored model is never affected.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { AGENT_PROVIDER_PRESETS, providerPreset } = loadTs('src/shared/agentProvider.ts');

const REPO = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const tmpDirs = [];
const mkUserData = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-model-default-cli-'));
  tmpDirs.push(d);
  return d;
};
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// The in-process config module (one "launch"). Its userData is fixed at first load.
const userData = mkUserData();
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const cfgMod = loadTs('src/main/config.ts');
const { readConfig, writeConfig, modelForHiveSpawn, modelForRole, takeClearedDefaultModel, CLEAR_SAVED_DEFAULT_MODEL } = cfgMod;
const configFile = path.join(userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));

/** A fresh "launch": a child node process loads config.ts against `dir`, runs `ops` (readConfig /
 *  writeConfig / take), and prints the results. Proves the flag, not an in-process latch, holds. */
function launch(dir, ops) {
  const script = [
    "'use strict';",
    'const electron = require.resolve("electron");',
    `require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => ${JSON.stringify(dir)} } } };`,
    `const m = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/main/config.ts');`,
    `const ops = ${JSON.stringify(ops)};`,
    'const out = [];',
    'for (const op of ops) {',
    '  if (op.op === "read") { const c = m.readConfig(); out.push({ defaultModel: c.defaultModel ?? null, godModel: c.godModel ?? null, flag: c.defaultModelCliMigratedV1 ?? null }); }',
    '  else if (op.op === "write") { try { m.writeConfig(op.patch); out.push(null); } catch (e) { out.push({ error: String(e && e.message || e) }); } }',
    '  else if (op.op === "take") out.push(m.takeClearedDefaultModel());',
    '  else if (op.op === "reset") { m.resetConfig(); out.push(null); }',
    '}',
    'process.stdout.write(JSON.stringify(out));'
  ].join('\n');
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: REPO, encoding: 'utf8', windowsHide: true }));
}

test('the clear is ON (the single switch)', () => {
  assert.equal(CLEAR_SAVED_DEFAULT_MODEL, true);
});

test('MIGRATION: a saved defaultModel is cleared once, the flag is recorded, the old value is reported once, godModel untouched', () => {
  fs.writeFileSync(configFile, JSON.stringify({
    onboardingComplete: true, defaultCommand: 'claude', defaultModel: 'claude-fable-5',
    godProvider: 'claude', godModel: 'claude-opus-5-5', maxTurns: 77
  }), 'utf8');
  const c = readConfig();
  assert.equal(c.defaultModel, undefined, 'cleared in the returned config');
  assert.equal(c.defaultModelCliMigratedV1, true);
  assert.equal(c.godModel, 'claude-opus-5-5', 'godModel untouched');
  assert.equal(c.maxTurns, 77, 'other keys untouched');
  const disk = onDisk();
  assert.ok(!('defaultModel' in disk), 'cleared on disk');
  assert.equal(disk.defaultModelCliMigratedV1, true, 'flag on disk');
  assert.equal(disk.godModel, 'claude-opus-5-5', 'godModel on disk untouched');
  assert.equal(takeClearedDefaultModel(), 'claude-fable-5', 'old value handed to main for the hive log');
  assert.equal(takeClearedDefaultModel(), null, 'handed out once');
  // A later explicit choice in this same process is kept.
  writeConfig({ defaultModel: 'claude-opus-5-5' });
  assert.equal(readConfig().defaultModel, 'claude-opus-5-5');
  assert.equal(takeClearedDefaultModel(), null);
});

test('MIGRATION across launches: clears on launch 1; an explicitly re-set value survives launch 2 and 3', () => {
  const dir = mkUserData();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    onboardingComplete: true, defaultCommand: 'claude', defaultModel: 'claude-fable-5', godModel: 'claude-opus-4-8'
  }), 'utf8');
  const l1 = launch(dir, [{ op: 'read' }, { op: 'take' }, { op: 'read' }, { op: 'write', patch: { defaultModel: 'claude-sonnet-5' } }]);
  assert.deepEqual(l1[0], { defaultModel: null, godModel: 'claude-opus-4-8', flag: true });
  assert.equal(l1[1], 'claude-fable-5');
  assert.deepEqual(l1[2], { defaultModel: null, godModel: 'claude-opus-4-8', flag: true });
  const l2 = launch(dir, [{ op: 'read' }, { op: 'take' }]);
  assert.deepEqual(l2[0], { defaultModel: 'claude-sonnet-5', godModel: 'claude-opus-4-8', flag: true }, 'explicit choice kept');
  assert.equal(l2[1], null, 'nothing cleared, nothing to log');
  const l3 = launch(dir, [{ op: 'read' }]);
  assert.equal(l3[0].defaultModel, 'claude-sonnet-5');
});

test('MIGRATION with no saved defaultModel: flag recorded, nothing reported', () => {
  const dir = mkUserData();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ onboardingComplete: true, godModel: 'claude-opus-4-8' }), 'utf8');
  const out = launch(dir, [{ op: 'read' }, { op: 'take' }]);
  assert.deepEqual(out[0], { defaultModel: null, godModel: 'claude-opus-4-8', flag: true });
  assert.equal(out[1], null);
});

test('NEW INSTALL: no defaultModel; a default the user picks before any config.json exists is kept next launch', () => {
  const dir = mkUserData();
  const l1 = launch(dir, [{ op: 'read' }, { op: 'write', patch: { defaultModel: 'claude-opus-5-5' } }, { op: 'take' }]);
  assert.equal(l1[0].defaultModel, null, 'no factory defaultModel');
  assert.equal(l1[0].godModel, 'claude-opus-4-8', 'the god default is unchanged');
  assert.equal(l1[2], null);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.defaultModelCliMigratedV1, true);
  const l2 = launch(dir, [{ op: 'read' }]);
  assert.equal(l2[0].defaultModel, 'claude-opus-5-5');
  // and a brand-new install's defaults have no provider defaults either
  const fresh = mkUserData();
  const l3 = launch(fresh, [{ op: 'read' }]);
  assert.equal(l3[0].defaultModel, null);
});

// MDC-172-AUDIT D3 / D8 (Jim): the two paths that REPLACE the config must also be born flagged, or
// a default the user picks afterwards (in the same process, where the latch is already set) is
// written unflagged and cleared on the next launch.
test('RESET (D3): a default picked after Reset settings survives the next launch', () => {
  const dir = mkUserData();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ defaultModel: 'claude-opus-5', godModel: 'claude-opus-5-5[1m]' }));
  const l1 = launch(dir, [{ op: 'read' }, { op: 'reset' }, { op: 'write', patch: { defaultModel: 'claude-sonnet-5' } }]);
  assert.equal(l1[0].defaultModel, null, 'launch 1 clears the saved default once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).defaultModelCliMigratedV1, true, 'the reset config is flagged on disk');
  const l2 = launch(dir, [{ op: 'read' }]);
  assert.equal(l2[0].defaultModel, 'claude-sonnet-5', 'the default picked after the reset is kept');
});

// D8 under LEDGER-WIPE (1.1.74): a corrupt config.json is no longer replaced by defaults on the next
// write. The read falls back to defaults (born flagged, so the migration never runs on them), the
// write is REFUSED, the original bytes stay, and a quarantine copy is kept. Once repaired, the
// normal D3 path applies.
test('CORRUPT CONFIG (D8): the fallback is flagged, a write is refused, the damaged file is kept', () => {
  const dir = mkUserData();
  const bad = '{ this is not json';
  fs.writeFileSync(path.join(dir, 'config.json'), bad);
  const l1 = launch(dir, [{ op: 'read' }, { op: 'write', patch: { defaultModel: 'claude-sonnet-5' } }]);
  assert.equal(l1[0].defaultModel, null, 'the fallback has no defaultModel');
  assert.equal(l1[0].flag, true, 'the fallback is born flagged');
  assert.ok(l1[1] && /refusing to overwrite/.test(l1[1].error), `the write is refused: ${JSON.stringify(l1[1])}`);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), bad, 'the damaged original is kept byte for byte');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.corrupt-')), 'a quarantine copy exists');
});

test('MAIN: bootstrapHiveServices writes ONE hive log row with the cleared value', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /const clearedDefaultModel = takeClearedDefaultModel\(\);\s*if \(clearedDefaultModel\) \{\s*try \{ hive\.appendLog\(\{ kind: 'model-default-cleared', previous: clearedDefaultModel \}\); \}/);
  const boot = src.slice(src.indexOf('function bootstrapHiveServices'));
  assert.ok(boot.indexOf('takeClearedDefaultModel()') > boot.indexOf("kind: 'app-start'"), 'logged after app-start, inside bootstrap');
  assert.ok(boot.indexOf('takeClearedDefaultModel()') < boot.indexOf('hive.startRouter()'));
});

test('GOD: godModel resolves first, with or without a defaultModel', () => {
  const god = { id: 'god', name: 'Michael', isGod: true };
  const cfg = { godProvider: 'claude', godModel: 'claude-opus-5-5' };
  assert.equal(modelForRole(god, cfg), 'claude-opus-5-5');
  assert.equal(modelForHiveSpawn(god, cfg), 'claude-opus-5-5');
  assert.equal(modelForHiveSpawn(god, { ...cfg, defaultModel: 'claude-sonnet-5' }), 'claude-opus-5-5');
  assert.equal(modelForHiveSpawn(god, { godProvider: 'claude' }), providerPreset('claude').recommendedOrchestratorModel,
    'unset godModel: the preset orchestrator model, never undefined');
  assert.ok(modelForHiveSpawn(god, { godProvider: 'claude' }));
});

test('WORKER spawn: no defaultModel = undefined (main adds no --model); a set default still applies', () => {
  const w = { id: 'jim', name: 'Jim', role: 'worker' };
  const helper = { id: 'h', name: 'Helper', role: 'triage' };
  const cfg = { godProvider: 'claude', godModel: 'claude-opus-4-8' };
  assert.equal(modelForHiveSpawn(w, cfg), undefined);
  assert.equal(modelForHiveSpawn(helper, cfg), undefined, 'no role tier sneaks a --model in');
  assert.equal(modelForHiveSpawn(w, { ...cfg, defaultModel: '  ' }), undefined);
  assert.equal(modelForHiveSpawn(w, { ...cfg, defaultModel: 'claude-sonnet-5' }), 'claude-sonnet-5');
});

test('EXISTING agents: a stored model is unaffected by the cleared default', () => {
  const w = { id: 'jim', name: 'Jim' };
  const cfg = { godProvider: 'claude', godModel: 'claude-opus-4-8' };
  assert.equal(modelForHiveSpawn(w, cfg, 'claude-fable-5'), 'claude-fable-5');
  assert.equal(modelForHiveSpawn({ ...w, isGod: true }, cfg, 'claude-fable-5-1'), 'claude-fable-5-1');
  // Restore/relaunch reuses the agent's stored command (which carries its --model) as is.
  assert.match(read('src/renderer/src/hooks/useRestoreTeam.ts'), /\(a\.command \?\? ''\)\.trim\(\) \|\|/);
  assert.match(read('src/renderer/src/hooks/useHive.ts'), /\(a\.command \?\? ''\)\.trim\(\) \|\|/);
});

// ── renderer ─────────────────────────────────────────────────────────────────
const { buildSpawnCommand, modelsForProvider, seedModelForProvider } = loadTs('src/renderer/src/store/config.ts');

test('ADD/EDIT AGENT seed: undefined for every provider when no defaults are set; set defaults still seed', () => {
  for (const p of AGENT_PROVIDER_PRESETS) {
    assert.equal(seedModelForProvider({}, p.id), undefined, p.id);
    assert.equal(seedModelForProvider({ providerDefaultModels: {} }, p.id), undefined, p.id);
  }
  assert.equal(seedModelForProvider({ defaultModel: 'claude-opus-5-5' }, 'claude'), 'claude-opus-5-5');
  assert.equal(seedModelForProvider({ defaultModel: 'claude-opus-5-5' }, 'codex'), undefined, 'the Claude default never seeds another engine');
  assert.equal(seedModelForProvider({ providerDefaultModels: { codex: 'gpt-5.6-sol' } }, 'codex'), 'gpt-5.6-sol');
  assert.equal(seedModelForProvider({ defaultModel: ' ' }, 'claude'), undefined);
});

test('PICKERS: every model-capable provider has an undefined-id entry, "CLI default" for claude/codex/agy (Claude first)', () => {
  for (const p of AGENT_PROVIDER_PRESETS.filter((x) => x.supportsModel && x.id !== 'custom')) {
    assert.ok(modelsForProvider(p.id).some((m) => m.id === undefined), `${p.id} has a no --model entry`);
  }
  for (const id of ['claude', 'codex', 'antigravity']) {
    const e = modelsForProvider(id).find((m) => m.id === undefined);
    assert.equal(e.label, 'CLI default', id);
  }
  assert.deepEqual(modelsForProvider('claude')[0], { id: undefined, label: 'CLI default' });
});

test('buildSpawnCommand with an undefined model passes no --model (claude, codex, agy)', () => {
  for (const autoMode of [false, true]) {
    const cfg = { defaultCommand: 'claude', autoMode };
    for (const id of ['claude', 'codex', 'antigravity']) {
      const flag = providerPreset(id).modelFlag;
      const cmd = buildSpawnCommand(cfg, seedModelForProvider({}, id), id);
      assert.ok(flag && !cmd.includes(flag), `${id}: ${cmd}`);
      assert.ok(buildSpawnCommand(cfg, 'x-model', id).includes(`${flag} x-model`), `${id} with a model still has it`);
    }
  }
});

test('UI wiring: Add/Edit Agent seed through the helper; Settings offers CLI default and clears defaultModel', () => {
  const add = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(add, /const initialModel = seedModelForProvider\(config, initialProvider\);/);
  assert.match(add, /const nextModel = seedModelForProvider\(config, id\);/);
  const edit = read('src/renderer/src/components/EditAgentModal.tsx');
  assert.match(edit, /const nextModel = seedModelForProvider\(config, id\);/);
  const s = read('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(!s.includes("?? 'claude-fable-5'"), 'no hardcoded fallback selection');
  assert.match(s, /useState<string \| undefined>\(cfgX\.defaultModel \|\| undefined\)/);
  assert.match(s, /onClick=\{\(\) => \{ void saveDefaultModel\(m\.id\); \}\}/, 'CLI default (undefined id) saves too');
  assert.match(s, /updateConfig\(\{ defaultModel: id \}/);
});
