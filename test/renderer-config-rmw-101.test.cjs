'use strict';
require('./tools/own-job.cjs');
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

// ─── WIRING, driven: the handlers and the preload run for real; the renderer callers by rule ─
const IX = 'src/main/index.ts', PRE = 'src/preload/index.ts';
const MCP = 'src/renderer/src/components/McpDefaultsSettings.tsx', SM = 'src/renderer/src/components/SettingsModal.tsx';
const AI = 'src/renderer/src/components/AiEnginesSettings.tsx', ADD = 'src/renderer/src/components/AddAgentModal.tsx';
const SCHED = 'src/renderer/src/components/triggers/SchedulesSection.tsx';
const RENDERER = [MCP, SM, AI, ADD, SCHED];

/** The balanced `open...close` span that starts at the first `open` at or after `from`. */
function spanAt(src, from, open, close, tag) {
  const start = src.indexOf(open, from);
  assert.ok(start >= 0, `${tag}: no ${open} found`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  return assert.fail(`${tag}: unbalanced ${open}`);
}
const HANDLER_CHANNELS = ['config:registerRepo', 'config:unregisterRepo', 'missions:patch'];
/** The three handler registrations exactly as index.ts writes them, run against the real config.ts
 *  (the same cached module as `cfg`) with a capturing ipcMain, syncMissions and liveWebContents. */
function handlersFrom(main) {
  const statements = HANDLER_CHANNELS.map((ch) => {
    const at = main.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(at >= 0, `${ch} IS REGISTERED in src/main/index.ts`);
    return `ipcMain.handle${spanAt(main, at, '(', ')', ch)};`;
  });
  const text = [
    "import { registerRepo, unregisterRepo, patchMission } from './config';",
    'export const calls: string[] = [];',
    'export const handlers: Record<string, (...a: unknown[]) => unknown> = {};',
    'const ipcMain = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers[ch] = fn; } };',
    "const syncMissions = () => { calls.push('syncMissions'); };",
    'const liveWebContents = () => ({ send: (ch: string) => { calls.push(`send:${ch}`); } });',
    ...statements
  ].join('\n');
  return loadTs.fromText('src/main/renderer-config-rmw-handlers.ts', text);
}
const API_ENTRIES = ['registerRepo', 'unregisterRepo', 'patchMission'];
/** The three preload entries exactly as index.ts writes them, over a capturing ipcRenderer. */
function apiFrom(pre) {
  const entries = API_ENTRIES.map((name) => {
    const at = pre.indexOf(`\n  ${name}: (`);
    assert.ok(at >= 0, `${name} IS ON THE PRELOAD API`);
    const inv = pre.indexOf('ipcRenderer.invoke', at);
    assert.ok(inv >= 0 && inv - at < 400, `${name} invokes ipcRenderer`);
    return pre.slice(at + 1, inv) + 'ipcRenderer.invoke' + spanAt(pre, inv, '(', ')', name);
  });
  const text = [
    'export const invoked: unknown[][] = [];',
    'const ipcRenderer = { invoke: (...a: unknown[]): Promise<unknown> => { invoked.push(a); return Promise.resolve(undefined); } };',
    'type HarnessConfig = unknown; type ScheduledMission = Record<string, unknown>;',
    'export const api = {',
    entries.join(',\n'),
    '};'
  ].join('\n');
  return loadTs.fromText('src/preload/renderer-config-rmw-api.ts', text);
}
/** Every `updateConfig(<arg>)` in src whose argument carries `key:`. */
function updateConfigArgs(src, key) {
  const out = [];
  for (let at = src.indexOf('updateConfig('); at >= 0; at = src.indexOf('updateConfig(', at + 1)) {
    const arg = spanAt(src, at, '(', ')', key);
    if (new RegExp(`\\b${key}:`).test(arg)) out.push(arg);
  }
  return out;
}

K.wiringHandlers = (M, main = readSource(IX)) => {
  const { handlers, calls } = handlersFrom(main);
  for (const ch of HANDLER_CHANNELS) assert.equal(typeof handlers[ch], 'function', `${ch} IS REGISTERED`);
  const [A, B, C] = N('C:/repos/a', 'C:/repos/b', 'C:/repos/c');
  start(M, { registeredRepos: [A] });
  handEdit({ registeredRepos: [A, B] }); // registered by another window meanwhile, inside the cache window
  handlers['config:registerRepo'](null, 'C:/repos/c');
  assert.deepEqual(onDisk().registeredRepos, [C, A, B], 'REGISTER PUTS THE PICK IN FRONT of the list on disk');
  handlers['config:registerRepo'](null, 'C:/repos/c', false);
  assert.deepEqual(onDisk().registeredRepos, [A, B, C], 'REGISTER WITH front=false PUTS THE PICK AT THE BACK');
  handlers['config:unregisterRepo'](null, 'C:/repos/a');
  assert.deepEqual(onDisk().registeredRepos, [B, C], 'UNREGISTER REMOVES THE ENTRY');
  start(M, { missions: [mission('m1', { lastFiredAt: 5 }), mission('m2')] });
  calls.length = 0;
  const r = handlers['missions:patch'](null, 'm1', { enabled: false });
  assert.deepEqual(r, { ok: true });
  const [m1, m2] = onDisk().missions;
  assert.equal(m1.enabled, false, 'MISSIONS:PATCH LANDS ON DISK');
  assert.equal(m1.lastFiredAt, 5, 'the scheduler stamp is kept');
  assert.equal(m2.enabled, true, 'the other mission is untouched');
  assert.deepEqual(calls, ['syncMissions', 'send:missions:updated'], 'MISSIONS:PATCH RE-SYNCS AND ANNOUNCES');
  assert.throws(() => handlers['missions:patch'](null, 'nope', { enabled: false }), /unknown mission/);
};
K.wiringPreload = (pre) => {
  const { api, invoked } = apiFrom(typeof pre === 'string' ? pre : readSource(PRE));
  invoked.length = 0; // loadTs caches a module per text
  void api.registerRepo('C:/x'); void api.registerRepo('C:/x', false); void api.unregisterRepo('C:/x'); void api.patchMission('m1', { enabled: false });
  assert.deepEqual(invoked, [
    ['config:registerRepo', 'C:/x', true], ['config:registerRepo', 'C:/x', false], ['config:unregisterRepo', 'C:/x'], ['missions:patch', 'm1', { enabled: false }]
  ], 'THE PRELOAD PASSES EVERY ARGUMENT through unchanged');
};
K.wiringRenderer = (over = {}) => {
  const src = Object.fromEntries(RENDERER.map((rel) => [rel, over[rel] ?? readSource(rel)]));
  // Each merged-map patch carries one entry or the form's own fields and NO spread of any kind.
  for (const [rel, key, shape] of [
    [MCP, 'mcpDefaults', /mcpDefaults:\s*\{\s*\[id\]:\s*\{\s*enabled:\s*next\s*\}\s*\}/],
    [SM, 'knowledgeGraph', /knowledgeGraph:\s*\{\s*enabled:\s*next\s*\}/],
    [SM, 'circuitBreaker', /circuitBreaker:\s*\{\s*enabled:\s*brkEnabled,/],
    [AI, 'providerBaseUrls', /providerBaseUrls:\s*\{\s*\[id\]:\s*next\[id\]\s*\}/],
    [AI, 'providerDefaultModels', /providerDefaultModels:\s*\{\s*\[id\]:\s*next\[id\]\s*\}/]
  ]) {
    const args = updateConfigArgs(src[rel], key);
    assert.equal(args.length, 1, `${path.basename(rel)} sends ${key} from exactly one updateConfig call`);
    assert.doesNotMatch(args[0], /\.\.\./, `NO SPREAD INSIDE THE ${key} PATCH (${path.basename(rel)})`);
    assert.match(args[0], shape, `THE ${key} PATCH IS ONE ENTRY (${path.basename(rel)})`);
  }
  const enabledFor = src[MCP].slice(src[MCP].indexOf('const enabledFor'), src[MCP].indexOf(';', src[MCP].indexOf('const enabledFor')));
  assert.match(enabledFor, /defaults\[id\]/, 'ENABLEDFOR READS THE MIRROR of what main saved');
  assert.doesNotMatch(enabledFor, /\bconfig\b/, 'ENABLEDFOR READS THE MIRROR, never the Settings-open snapshot');
  assert.match(src[MCP], /setDefaults\(saved\.mcpDefaults/, 'McpDefaultsSettings mirrors what main saved');
  assert.doesNotMatch(src[SM], /updateConfig\(\{\s*missions/, 'the auto-compact toggle no longer writes a whole missions list');
  assert.match(src[SM], /patchMission\('compact-maintenance', \{ enabled: next \}\)/, 'the auto-compact toggle patches one mission');
  assert.doesNotMatch(src[ADD], /updateConfig\(\{\s*registeredRepos/, 'AddAgentModal no longer writes a whole registeredRepos list');
  assert.match(src[ADD], /window\.cth\.registerRepo\(/, 'AddAgentModal registers one repo');
  assert.match(src[ADD], /window\.cth\.unregisterRepo\(/, 'AddAgentModal unregisters one repo');
  assert.match(src[SCHED], /window\.cth\.patchMission\(id, fields\)/, 'a Schedules row edit patches one mission');
  assert.match(src[SCHED], /onMissionsUpdated/, 'the Schedules panel reloads on missions:updated');
};

test('the three handlers, driven with the real config.ts: register in front or at the back, unregister, patch one mission and announce', () => K.wiringHandlers(cfg));
test('the preload passes every argument of registerRepo, unregisterRepo and patchMission through', () => K.wiringPreload());
test('the renderer callers send one entry with no spread of any kind, and the MCP rows read the mirrored map', () => K.wiringRenderer());

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

/** Jim's seven survivors of 8c9c3ae8 (wiring guarded by text only); each now dies at a driven killer. */
const WIRING_MUTANTS = [
  { name: 'A3 missions:patch never calls patchMission (every toggle silently does nothing)', file: IX, killer: 'handlers', dies: /MISSIONS:PATCH LANDS ON DISK/,
    edits: [['  patchMission(id, fields);\n  syncMissions();', '  void id; void fields;\n  syncMissions();']] },
  { name: 'A4 config:registerRepo always appends to the back (a pick is no longer the default cwd)', file: IX, killer: 'handlers', dies: /REGISTER PUTS THE PICK IN FRONT/,
    edits: [['registerRepo(repo, front !== false));', 'registerRepo(repo, false));']] },
  { name: 'A5 config:unregisterRepo registers instead', file: IX, killer: 'handlers', dies: /UNREGISTER REMOVES THE ENTRY/,
    edits: [['(_evt, repo: unknown) => unregisterRepo(repo));', '(_evt, repo: unknown) => registerRepo(repo, true));']] },
  { name: 'A8 preload patchMission drops the fields', file: PRE, killer: 'preload', dies: /THE PRELOAD PASSES EVERY ARGUMENT/,
    edits: [["ipcRenderer.invoke('missions:patch', id, fields),", "ipcRenderer.invoke('missions:patch', id, {}),"]] },
  { name: 'A1 McpDefaults row state reads the stale config prop again (bug 7 on screen)', file: MCP, killer: 'renderer', dies: /ENABLEDFOR READS THE MIRROR/,
    edits: [['    defaults[id]?.enabled ?? MCP_CATALOG', '    config.mcpDefaults?.[id]?.enabled ?? MCP_CATALOG']] },
  { name: 'A14 the kg toggle spreads the stale snapshot map again (bug 9 in the renderer)', file: SM, killer: 'renderer', dies: /NO SPREAD INSIDE THE knowledgeGraph PATCH/,
    edits: [['await window.cth.updateConfig({ knowledgeGraph: { enabled: next } });', 'await window.cth.updateConfig({ knowledgeGraph: { ...(config.knowledgeGraph ?? {}), enabled: next } });']] },
  { name: 'A16 saveBudget spreads the stale breaker again, without parens', file: SM, killer: 'renderer', dies: /NO SPREAD INSIDE THE circuitBreaker PATCH/,
    edits: [['      circuitBreaker: {\n        enabled: brkEnabled,', '      circuitBreaker: {\n        ...breakerCfg.circuitBreaker,\n        enabled: brkEnabled,']] },
  // Jim's three controls (killed at 8c9c3ae8 already) stay in the set so his 10 run as one census.
  { name: 'C1 saveBudget spreads the stale breaker again, with parens', file: SM, killer: 'renderer', dies: /NO SPREAD INSIDE THE circuitBreaker PATCH/,
    edits: [['      circuitBreaker: {\n        enabled: brkEnabled,', '      circuitBreaker: {\n        ...(breakerCfg.circuitBreaker ?? {}),\n        enabled: brkEnabled,']] },
  { name: 'C2 AiEngines sends the whole base-URL map', file: AI, killer: 'renderer', dies: /THE providerBaseUrls PATCH IS ONE ENTRY/,
    edits: [['providerBaseUrls: { [id]: next[id] }', 'providerBaseUrls: next']] },
  { name: 'C3 McpDefaults spreads the mirrored map', file: MCP, killer: 'renderer', dies: /NO SPREAD INSIDE THE mcpDefaults PATCH/,
    edits: [['mcpDefaults: { [id]: { enabled: next } }', 'mcpDefaults: { ...defaults, [id]: { enabled: next } }']] },
];
const WIRING_KILLERS = {
  handlers: (file, text) => K.wiringHandlers(cfg, text),
  preload: (file, text) => K.wiringPreload(text),
  renderer: (file, text) => K.wiringRenderer({ [file]: text })
};

test('census: every mutant dies at its killer, and the real module passes every killer', () => {
  for (const k of Object.keys(K)) K[k](cfg);
  for (const m of MUTANTS) {
    const text = mutateText(CFG, m.edits, m.name);
    const M = loadTs.fromText(CFG, text);
    assert.throws(() => K[m.killer](M), (e) => m.dies.test(String(e && e.message)), `mutant "${m.name}" must die at ${m.dies}`);
  }
  for (const m of WIRING_MUTANTS) {
    const text = mutateText(m.file, m.edits, m.name);
    assert.throws(() => WIRING_KILLERS[m.killer](m.file, text), (e) => m.dies.test(String(e && e.message)), `mutant "${m.name}" must die at ${m.dies}`);
  }
  assert.equal(MUTANTS.length + WIRING_MUTANTS.length, 21, "11 config.ts mutants + Jim's 10");
});
