'use strict';
/**
 * RENDERER-CONFIG-RMW (1.1.101). The renderer holds ONE config snapshot (fetched at boot and when
 * Settings opens; nothing pushes a change back), and ten of its config:update callers sent a whole
 * list or map built from that snapshot, so main's writeConfig replaced the key with stale data:
 *   - bug 7: the second MCP toggle of one Settings visit reverted the first (McpDefaultsSettings
 *     spread the open-time map);
 *   - bug 9: a knowledge-graph toggle sent `{ enabled }` and erased rootPath;
 *   - bug 10: the Settings auto-compact toggle and the Schedules panel each wrote a whole missions
 *     list, undoing the other's `enabled` and any scheduler stamp landed meanwhile.
 * Now (A) writeConfig merges the map keys in CONFIG_MERGE_KEYS one level deep on the fresh read, an
 * entry sent as undefined is removed, and callers send only the entry they changed; (B) the Add
 * Agent modal registers/unregisters one repo through registerRepo/unregisterRepo, keyed in main on
 * readConfigForWrite; (C) both mission surfaces patch one mission through patchMission(id, fields),
 * which keeps the scheduler's own fields and announces missions:updated.
 * The census runs each rule's mutant against the killer that must notice it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-renderer-config-rmw-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, ipcMain: { handle: () => {} } }
};
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const CFG = 'src/main/config.ts';
const cfg = loadTs(CFG);
const file = path.join(userData, 'config.json');
const MIGRATED = { triggersMigratedV1: true, defaultModelCliMigratedV1: true };
const clock = 1_000_000;
const handEdit = (obj) => fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, onboardingComplete: true, ...obj }), 'utf8');
/** A fresh cache over `obj`, then one cached read: what the renderer's snapshot was taken from. */
const start = (M, obj) => { handEdit(obj); M.__resetConfigCacheForTests(() => clock, () => Date.now() + 60_000); return M.readConfig(); };
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
/** expandTilde normalises a repo path to the platform's separators (backslashes on Windows). */
const N = (...ps) => ps.map((p) => path.normalize(p));
const mission = (id, extra = {}) => ({ id, label: `${id} label`, intervalMs: 3_600_000, to: 'god', body: 'b', enabled: true, ...extra });

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

// ─── KILLERS (named assertions over a config module M; the census runs them on mutants) ──────
const K = {};

/** Bug 7: MCP A survives enabling B. The renderer sends only B's entry; main merges it on disk. */
K.mcpMerge = (M) => {
  start(M, { mcpDefaults: {} });
  M.writeConfig({ mcpDefaults: { 'mcp-a': { enabled: true } } });
  const after = M.writeConfig({ mcpDefaults: { 'mcp-b': { enabled: true } } });
  assert.deepEqual(after.mcpDefaults, { 'mcp-a': { enabled: true }, 'mcp-b': { enabled: true } }, 'MCP A SURVIVES ENABLING B');
  assert.deepEqual(onDisk().mcpDefaults, { 'mcp-a': { enabled: true }, 'mcp-b': { enabled: true } }, 'ON DISK TOO');
  // The merge is one level: an entry sent replaces that entry whole.
  const off = M.writeConfig({ mcpDefaults: { 'mcp-a': { enabled: false } } });
  assert.deepEqual(off.mcpDefaults, { 'mcp-a': { enabled: false }, 'mcp-b': { enabled: true } }, 'AN ENTRY SENT REPLACES THAT ENTRY');
};

/** Bug 9: rootPath survives a `{ enabled }` toggle. */
K.kgMerge = (M) => {
  start(M, { knowledgeGraph: { enabled: true, rootPath: 'C:/kg-root' } });
  const after = M.writeConfig({ knowledgeGraph: { enabled: false } });
  assert.deepEqual(after.knowledgeGraph, { enabled: false, rootPath: 'C:/kg-root' }, 'ROOTPATH SURVIVES A TOGGLE');
  assert.equal(onDisk().knowledgeGraph.rootPath, 'C:/kg-root', 'ON DISK TOO');
};

/** Every map key in CONFIG_MERGE_KEYS merges; a field the form does not own is kept. */
K.mergeKeys = (M) => {
  assert.deepEqual([...M.CONFIG_MERGE_KEYS], ['mcpDefaults', 'providerBaseUrls', 'providerDefaultModels', 'knowledgeGraph', 'circuitBreaker'], 'THE MERGE KEYS');
  start(M, { circuitBreaker: { enabled: true, tokensPerMinute: 1000, extraField: 'kept' }, providerDefaultModels: { ollama: 'llama3', lmstudio: 'qwen' } });
  const a = M.writeConfig({ circuitBreaker: { enabled: false } });
  assert.deepEqual(a.circuitBreaker, { enabled: false, tokensPerMinute: 1000, extraField: 'kept' }, 'A BREAKER FIELD THE FORM DOES NOT OWN IS KEPT');
  const b = M.writeConfig({ providerDefaultModels: { ollama: 'llama4' } });
  assert.deepEqual(b.providerDefaultModels, { ollama: 'llama4', lmstudio: 'qwen' }, 'ONE PROVIDER MODEL SENT KEEPS THE OTHERS');
};

/** An entry sent as undefined is removed (AiEnginesSettings clears a base URL with `value.trim() || undefined`). */
K.undefinedClears = (M) => {
  start(M, { providerBaseUrls: { ollama: 'http://a', lmstudio: 'http://b' } });
  const after = M.writeConfig({ providerBaseUrls: { ollama: undefined } });
  assert.deepEqual(after.providerBaseUrls, { lmstudio: 'http://b' }, 'UNDEFINED REMOVES THE ENTRY');
  assert.deepEqual(Object.keys(onDisk().providerBaseUrls), ['lmstudio'], 'NOT ON DISK EITHER');
};

/** A list key is still replaced whole (registeredRepos, missions): the merge is for maps only. */
K.listsReplace = (M) => {
  start(M, { registeredRepos: ['C:/a', 'C:/b'], missions: [mission('m1'), mission('m2')] });
  const after = M.writeConfig({ registeredRepos: ['C:/c'], missions: [mission('m2')] });
  assert.deepEqual(after.registeredRepos, N('C:/c'), 'REGISTEREDREPOS IS REPLACED WHOLE');
  assert.deepEqual(after.missions.map((m) => m.id), ['m2'], 'MISSIONS IS REPLACED WHOLE');
};

/** registerRepo merges against the list ON DISK, not the cached read the renderer's snapshot came from. */
K.registerFresh = (M) => {
  start(M, { registeredRepos: ['C:/a'] });
  handEdit({ registeredRepos: ['C:/a', 'C:/ext'] }); // another writer, after the snapshot
  const after = M.registerRepo('C:/new');
  assert.deepEqual(after.registeredRepos, N('C:/new', 'C:/a', 'C:/ext'), 'A REPO REGISTERED MEANWHILE SURVIVES registerRepo');
  assert.deepEqual(onDisk().registeredRepos, N('C:/new', 'C:/a', 'C:/ext'), 'ON DISK TOO');
  assert.deepEqual(M.registerRepo('C:/a').registeredRepos, N('C:/a', 'C:/new', 'C:/ext'), 'RE-REGISTERING MOVES TO THE FRONT, NO DUPLICATE');
  assert.deepEqual(M.registerRepo('C:/back', false).registeredRepos, N('C:/a', 'C:/new', 'C:/ext', 'C:/back'), 'front=false APPENDS');
  const tilde = M.registerRepo('~/proj').registeredRepos[0];
  assert.ok(!tilde.startsWith('~') && tilde.endsWith('proj'), `A TYPED ~ IS EXPANDED: ${tilde}`);
  for (const bad of ['', '   ', 7, null, undefined]) assert.throws(() => M.registerRepo(bad), /invalid repo path/, `REFUSES ${JSON.stringify(bad)}`);
};

/** unregisterRepo removes one entry from the list on disk and keeps the rest. */
K.unregisterFresh = (M) => {
  start(M, { registeredRepos: ['C:/a', 'C:/b'] });
  handEdit({ registeredRepos: ['C:/a', 'C:/b', 'C:/ext'] }); // hand-written forward slashes
  const after = M.unregisterRepo('C:/a');
  assert.deepEqual(after.registeredRepos, N('C:/b', 'C:/ext'), 'A REPO REGISTERED MEANWHILE SURVIVES unregisterRepo');
  assert.deepEqual(M.unregisterRepo('C:/nope').registeredRepos, N('C:/b', 'C:/ext'), 'AN UNKNOWN REPO IS A NO-OP');
  assert.throws(() => M.unregisterRepo(''), /invalid repo path/);
};

/** patchMission: one mission's fields against the list on disk; scheduler fields and the id are never set by it. */
K.patchMission = (M) => {
  start(M, { missions: [mission('compact-maintenance'), mission('standup')] });
  // Meanwhile: the Schedules panel disabled standup and the scheduler stamped compact-maintenance.
  handEdit({ missions: [mission('compact-maintenance', { lastFiredAt: 5 }), mission('standup', { enabled: false })] });
  const after = M.patchMission('compact-maintenance', { enabled: false, lastFiredAt: 99, lastDeltaFingerprint: 'x', lastDispatchAt: 1, id: 'evil' });
  const byId = Object.fromEntries(after.missions.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), ['compact-maintenance', 'standup'], 'THE ID IS NEVER PATCHED');
  assert.equal(byId['compact-maintenance'].enabled, false, 'THE PATCHED FIELD LANDS');
  assert.equal(byId['compact-maintenance'].lastFiredAt, 5, 'THE SCHEDULER STAMP ON DISK IS KEPT, NOT THE CALLER\'S');
  assert.equal(byId['compact-maintenance'].lastDeltaFingerprint, undefined, 'A SCHEDULER FIELD IS NEVER SET BY A PATCH');
  assert.equal(byId['compact-maintenance'].lastDispatchAt, undefined, 'A SCHEDULER FIELD IS NEVER SET BY A PATCH (2)');
  assert.equal(byId.standup.enabled, false, 'THE OTHER SURFACE\'S EDIT MADE MEANWHILE SURVIVES');
  assert.equal(onDisk().missions.find((m) => m.id === 'standup').enabled, false, 'ON DISK TOO');
  assert.equal(M.patchMission('standup', { label: 'renamed', intervalMs: 60_000 }).missions.find((m) => m.id === 'standup').label, 'renamed', 'A ROW EDIT PATCHES ITS FIELDS');
  assert.throws(() => M.patchMission('missing', { enabled: true }), /unknown mission missing/, 'AN UNKNOWN ID THROWS (the control reverts)');
  for (const [id, fields] of [['', {}], [null, {}], ['standup', null], ['standup', 'x'], ['standup', []]]) assert.throws(() => M.patchMission(id, fields), /invalid mission patch/, `REFUSES ${JSON.stringify([id, fields])}`);
};

// ─── THE TESTS ──────────────────────────────────────────────────────────────────────────────
test('bug 7: MCP A survives enabling B (one entry sent, merged on disk)', () => K.mcpMerge(cfg));
test('bug 9: knowledgeGraph rootPath survives an { enabled } toggle', () => K.kgMerge(cfg));
test('every CONFIG_MERGE_KEYS map merges one level; a field the form does not own is kept', () => K.mergeKeys(cfg));
test('an entry sent as undefined is removed from the map', () => K.undefinedClears(cfg));
test('list keys are still replaced whole', () => K.listsReplace(cfg));
test('registerRepo merges against the list on disk (a repo registered meanwhile survives)', () => K.registerFresh(cfg));
test('unregisterRepo removes one entry from the list on disk', () => K.unregisterFresh(cfg));
test('patchMission patches one mission on disk, keeps scheduler stamps and the other surface\'s edit', () => K.patchMission(cfg));

test('the wiring: handlers, preload, and the renderer callers no longer send whole lists or maps', () => {
  const main = readSource('src/main/index.ts');
  for (const ch of ['config:registerRepo', 'config:unregisterRepo', 'missions:patch']) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}'`), `${ch} handler`);
  assert.match(main, /ipcMain\.handle\('missions:patch'[\s\S]{0,400}syncMissions\(\);[\s\S]{0,200}'missions:updated'/, 'missions:patch re-syncs and announces missions:updated');
  const pre = readSource('src/preload/index.ts');
  for (const ch of ['config:registerRepo', 'config:unregisterRepo', 'missions:patch']) assert.match(pre, new RegExp(`ipcRenderer\\.invoke\\('${ch}'`), `${ch} preload`);
  const mcp = readSource('src/renderer/src/components/McpDefaultsSettings.tsx');
  assert.doesNotMatch(mcp, /\.\.\.config\.mcpDefaults/, 'McpDefaultsSettings no longer spreads the snapshot map');
  assert.match(mcp, /mcpDefaults: \{ \[id\]: \{ enabled: next \} \}/, 'McpDefaultsSettings sends one entry');
  assert.match(mcp, /setDefaults\(saved\.mcpDefaults/, 'McpDefaultsSettings mirrors what main saved');
  const ai = readSource('src/renderer/src/components/AiEnginesSettings.tsx');
  assert.match(ai, /providerBaseUrls: \{ \[id\]: next\[id\] \}/, 'AiEnginesSettings sends one base URL');
  assert.match(ai, /providerDefaultModels: \{ \[id\]: next\[id\] \}/, 'AiEnginesSettings sends one model');
  const settings = readSource('src/renderer/src/components/SettingsModal.tsx');
  assert.doesNotMatch(settings, /\.\.\.\(breakerCfg\.circuitBreaker/, 'saveBudget no longer spreads the snapshot breaker');
  assert.doesNotMatch(settings, /updateConfig\(\{\s*missions/, 'the auto-compact toggle no longer writes a whole missions list');
  assert.match(settings, /patchMission\('compact-maintenance', \{ enabled: next \}\)/, 'the auto-compact toggle patches one mission');
  const add = readSource('src/renderer/src/components/AddAgentModal.tsx');
  assert.doesNotMatch(add, /updateConfig\(\{\s*registeredRepos/, 'AddAgentModal no longer writes a whole registeredRepos list');
  assert.match(add, /window\.cth\.registerRepo\(/, 'AddAgentModal registers one repo');
  assert.match(add, /window\.cth\.unregisterRepo\(/, 'AddAgentModal unregisters one repo');
  const sched = readSource('src/renderer/src/components/triggers/SchedulesSection.tsx');
  assert.match(sched, /window\.cth\.patchMission\(id, fields\)/, 'a Schedules row edit patches one mission');
  assert.match(sched, /onMissionsUpdated/, 'the Schedules panel reloads on missions:updated');
});

// ─── CENSUS: each rule's mutant dies at its killer ──────────────────────────────────────────
function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const MUTANTS = [
  { name: 'the map merge is gone (writeConfig replaces the key, 1.1.100)', killer: 'mcpMerge', dies: /MCP A SURVIVES ENABLING B/,
    edits: [['  mergeMapKeys(current, patch, next);', '']] },
  { name: 'knowledgeGraph is not a merge key', killer: 'kgMerge', dies: /ROOTPATH SURVIVES A TOGGLE/,
    edits: [["'providerDefaultModels', 'knowledgeGraph', 'circuitBreaker'", "'providerDefaultModels', 'circuitBreaker'"]] },
  { name: 'circuitBreaker is not a merge key', killer: 'mergeKeys', dies: /THE MERGE KEYS/,
    edits: [["'knowledgeGraph', 'circuitBreaker']", "'knowledgeGraph']"]] },
  { name: 'an undefined entry is stored, not removed', killer: 'undefinedClears', dies: /UNDEFINED REMOVES THE ENTRY/,
    edits: [['      if (v === undefined) delete merged[e];', '      if (v === undefined) merged[e] = v;']] },
  { name: 'the merge takes the patch map whole (the stale snapshot wins again)', killer: 'mcpMerge', dies: /MCP A SURVIVES ENABLING B/,
    edits: [['    const merged: Record<string, unknown> = { ...((current[k] as Record<string, unknown> | undefined) ?? {}) };', '    const merged: Record<string, unknown> = {};']] },
  { name: 'registerRepo builds on the cached read', killer: 'registerFresh', dies: /A REPO REGISTERED MEANWHILE SURVIVES registerRepo/,
    edits: [['  const rest = (readConfigForWrite().registeredRepos ?? []).filter((r) => expandTilde(r) !== p);', '  const rest = (readConfig().registeredRepos ?? []).filter((r) => expandTilde(r) !== p);']] },
  { name: 'unregisterRepo compares the raw disk entry (a hand-written C:/x never matches)', killer: 'unregisterFresh', dies: /A REPO REGISTERED MEANWHILE SURVIVES unregisterRepo/,
    edits: [['  return writeConfig({ registeredRepos: (readConfigForWrite().registeredRepos ?? []).filter((r) => expandTilde(r) !== p) });', '  return writeConfig({ registeredRepos: (readConfigForWrite().registeredRepos ?? []).filter((r) => r !== p) });']] },
  { name: 'unregisterRepo builds on the cached read', killer: 'unregisterFresh', dies: /A REPO REGISTERED MEANWHILE SURVIVES unregisterRepo/,
    edits: [['  return writeConfig({ registeredRepos: (readConfigForWrite().registeredRepos ?? []).filter((r) => expandTilde(r) !== p) });', '  return writeConfig({ registeredRepos: (readConfig().registeredRepos ?? []).filter((r) => expandTilde(r) !== p) });']] },
  { name: 'patchMission builds on the cached read', killer: 'patchMission', dies: /THE SCHEDULER STAMP ON DISK IS KEPT/,
    edits: [['  const current = readConfigForWrite().missions ?? [];', '  const current = readConfig().missions ?? [];']] },
  { name: 'patchMission lets the caller set the scheduler fields and the id', killer: 'patchMission', dies: /THE ID IS NEVER PATCHED/,
    edits: [['  for (const k of MISSION_SCHEDULER_FIELDS) delete own[k];', '']] },
  { name: 'patchMission ignores an unknown id', killer: 'patchMission', dies: /AN UNKNOWN ID THROWS/,
    edits: [['  if (!current.some((m) => m.id === id)) throw new Error(`unknown mission ${id}`);', '']] },
];

test('census: every mutant dies at its killer, and the real module passes every killer', () => {
  for (const k of Object.keys(K)) K[k](cfg);
  for (const m of MUTANTS) {
    const text = mutateText(CFG, m.edits, m.name);
    const M = loadTs.fromText(CFG, text);
    assert.throws(() => K[m.killer](M), (e) => m.dies.test(String(e && e.message)), `mutant "${m.name}" must die at ${m.dies}`);
  }
  assert.equal(MUTANTS.length, 11);
});
