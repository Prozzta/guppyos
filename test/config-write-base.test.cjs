'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER (config), found by the widened mutation scan after Jim's FAIL on the tasks
 * cache: readConfig() serves a cached value up to CONFIG_REVALIDATE_MS (1 s) old, and every
 * read-modify-write of config.json outside config.ts built its patch on it (the voice schedules,
 * the scheduler's lastFiredAt stamps, the boot migrations, webhooks, codex opt-ins, integrations,
 * triggers, the term hold...). A change another process made inside that window was lost. Those
 * bases now come from readConfigForWrite(), which skips the window (the stat decides), and the
 * voice schedules write through deps.editMissions, which applies the edit to that fresh read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-write-base-'));
const handlers = {};
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } }
};
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { readConfig, readConfigForWrite, writeConfig, __resetConfigCacheForTests } = loadTs('src/main/config.ts');
const RA = loadTs('src/main/realtimeActions.ts');
const file = path.join(userData, 'config.json');
const MIGRATED = { triggersMigratedV1: true, defaultModelCliMigratedV1: true };

const clock = 1_000_000;
const handEdit = (obj) => fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, onboardingComplete: true, ...obj }), 'utf8');
// The window clock stands still (every read below is inside one window); the racy wall is a
// minute ahead, so the files just written count as old (proven) writes and the cache serves them.
const start = (obj) => { handEdit(obj); __resetConfigCacheForTests(() => clock, () => Date.now() + 60_000); readConfig(); };
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).missions.map((m) => `${m.id}:${m.enabled}:${m.lastFiredAt ?? '-'}`);
const mission = (id, extra = {}) => ({ id, label: `${id} label`, intervalMs: 3_600_000, to: 'god', body: 'b', enabled: true, ...extra });

// The same wiring as index.ts.
RA.registerRealtimeActionIpc({
  hiveEnabled: () => true,
  hiveRegistry: () => ({ agents: {} }),
  hiveLog: () => {},
  listMissions: () => readConfig().missions ?? [],
  editMissions: (edit) => { writeConfig({ missions: edit(readConfigForWrite().missions ?? []) }); }
});
const say = (verb, args) => handlers['realtime:action'](null, { verb, ...args });
const confirm = () => handlers['realtime:action:confirm'](null, { phrase: 'confirm' });

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('readConfigForWrite reads through the window; readConfig keeps serving the cache', () => {
  start({ missions: [mission('A')] });
  handEdit({ missions: [mission('A'), mission('B')] });
  assert.deepEqual(readConfig().missions.map((m) => m.id), ['A'], 'control: the cache still serves the old list');
  assert.deepEqual(readConfigForWrite().missions.map((m) => m.id), ['A', 'B']);
});

test('a voice create_schedule keeps a mission another writer added inside the window', async () => {
  start({ missions: [mission('A')] });
  handEdit({ missions: [mission('A'), mission('B')] });
  const p = await say('create_schedule', { label: 'Nightly', prompt: 'run the sweep', intervalMinutes: 30 });
  assert.equal(p.needsConfirm, true, p.spoken);
  const r = await confirm();
  assert.equal(r.ok, true, r.spoken);
  const ids = onDisk();
  assert.deepEqual(ids.slice(0, 2), ['A:true:-', 'B:true:-']);
  assert.match(ids[2], /^voice-nightly-.*:true:-$/);
});

test('a voice edit_schedule keeps a scheduler stamp and a mission written inside the window', async () => {
  start({ missions: [mission('A'), mission('C')] });
  handEdit({ missions: [mission('A', { lastFiredAt: 123 }), mission('C'), mission('B')] });
  const p = await say('edit_schedule', { label: 'A label', action: 'disable' });
  assert.equal(p.needsConfirm, true, p.spoken);
  assert.equal((await confirm()).ok, true);
  assert.deepEqual(onDisk(), ['A:false:123', 'C:true:-', 'B:true:-']);
  start({ missions: [mission('A'), mission('C')] });
  handEdit({ missions: [mission('A'), mission('C'), mission('B')] });
  await say('edit_schedule', { label: 'C label', action: 'delete' });
  assert.equal((await confirm()).ok, true);
  assert.deepEqual(onDisk(), ['A:true:-', 'B:true:-']);
});

// Every read-modify-write base in main, by its verbatim line (a census: each must be present).
const BASES = {
  'src/main/index.ts': [
    ['scheduler stamp (gate)', 1, '              const current = readConfigForWrite().missions ?? [];'],
    ['scheduler stamp (no gate)', 1, '          const current = readConfigForWrite().missions ?? [];'],
    ['ops standup seed', 1, '  const cfg = readConfigForWrite();'],
    ['heartbeat retire', 1, '  const cfg2 = readConfigForWrite();'],
    ['delta gate seed', 1, '  const cfgGate = readConfigForWrite();'],
    ['compact maintenance retire', 1, '  const cfg3 = readConfigForWrite();'],
    ['autoCompact strip', 1, '  const cfg4 = readConfigForWrite();'],
    ['project theme', 1, '  const current = readConfigForWrite(), home = current.harnessHome;'],
    ['home change maps', 1, '  const maps = applyProjectHomeChange(readConfigForWrite(), {'],
    ['codex opt-in allow', 1, '  const cur = readConfigForWrite().codexLayerOptIns ?? [];'],
    ['codex opt-in revoke', 1, '  writeConfig({ codexLayerOptIns: (readConfigForWrite().codexLayerOptIns ?? []).filter('],
    ['auto-delivery pause', 1, '  const current = new Set(readConfigForWrite().autoDeliveryPausedAgents ?? []);'],
    ['missions:save merge', 1, '    (readConfigForWrite().missions ?? []).map((m) => [m.id, m] as const)'],
    ['context trigger', 1, '  const current = readConfigForWrite().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;'],
    ['webhooks:save', 1, '  const existing = readConfigForWrite().webhookTriggers ?? [];'],
    ['webhooks:delete', 1, '  const list = (readConfigForWrite().webhookTriggers ?? []).filter((t) => t.id !== id);'],
    ['org trigger', 1, '  const current = readConfigForWrite().orgTrigger ?? DEFAULT_ORG_TRIGGER;'],
    ['legacy webhook', 1, '  const list = readConfigForWrite().webhookTriggers ?? [];'],
    ['voice schedules', 1, '  editMissions: (edit) => { writeConfig({ missions: edit(readConfigForWrite().missions ?? []) }); },'],
    ['term hold', 1, '  floorHold: { get: () => parseFloorHold(readConfigForWrite().floorHold), set: (h) => { writeConfig({ floorHold: h }); } },']
  ],
  'src/main/integrations.ts': [
    ['integration upsert', 1, '  const current = readConfigForWrite().integrations ?? [];'],
    ['integration remove', 1, '  const next = (readConfigForWrite().integrations ?? []).filter((r) => r.id !== id);']
  ]
};
test('every read-modify-write of config.json in main builds on readConfigForWrite (census)', () => {
  for (const [rel, rows] of Object.entries(BASES)) {
    const src = readSource(rel).replace(/\r\n/g, '\n');
    // Each anchor carries its indentation, so the two scheduler stamps stay apart.
    const lines = src.split('\n');
    for (const [what, n, line] of rows) assert.equal(lines.filter((l) => l.startsWith(line)).length, n, `${rel}: ${what}`);
  }
});

// The rule for new code: a config write whose block calls a cached source above it must be one of the
// read-only uses below (a scalar decision, a compare, a deps read), never a base.
// - Files: every src/main file (writes in files that import writeConfig from ./config; wrapper calls anywhere).
// - Sources: readConfig() and any function in main whose returned value calls a source, to a fixed
//   point (Jim C3). Calls are resolved by the type checker, not by name: a member call counts when it
//   resolves to a source (jimApi.hooks(), deps.listMissions() through the deps interface, Jim R3),
//   another object's method of the same name does not (hive.enabled()), and a declaration is no call.
// - Write sites: every writeConfig() call, plus every call of a wrapper whose writeConfig patch uses
//   one of its own parameters as a value (Jim R1: saveHooks(list) on a cached list). A parameter
//   applied to a fresh read (editMissions' edit(...)) does not make a wrapper. A parameter counts
//   through a local (Jim W1: const copy = list) and through destructuring (Jim W2: save({ list })).
// - A read counts when ANY function around it also holds the write (Jim N1-N3: a read in a callback,
//   an IIFE or a promise chain feeds the handler around it). A closure inside a RETURNED value is
//   still no read when deciding what is a source.
// Known limits (a text window, not data flow; the census above and the audits prove the current tree):
// - R4: a cached read more than 30 lines above the write in the same block is not seen.
// - A template string in a returned value is not followed (a spoken or logged text is no base), so a
//   helper returning `${readConfig().x}` is not a source.
// - A local is followed one name at a time, through its initializer only: a later reassignment
//   (let x = fresh; x = cached) is not seen.
// - A read-only entry exempts its exact text in its own function (or ipcMain.handle channel) only;
//   a second, stale use of that same text in that same function would be exempt too.
// - R5: a module-level snapshot (let snap = readConfig()) used later as a base is not seen.
// - A cached base captured by an edit callback (const base = deps.listMissions(); deps.editMissions(() =>
//   [...base, m])) is not seen; the voice create_schedule test above catches that shape at run time.
// Each entry is keyed to its file and the function or ipcMain.handle channel it sits in (Jim X1), so
// the same text elsewhere is not exempt; the real-tree test asserts every entry is still used.
const READ_ONLY = [
  ['src/main/index.ts', 'readMission', /readMission: \(\) => \(readConfig\(\)\.missions/, 'the standup gate input'],
  ['src/main/index.ts', 'ipc:config:changeHome', /^const cfg = readConfig\(\);$/, 'changeHome recovery: restarts the slack server, writes nothing'],
  ['src/main/index.ts', ['ipc:slack:setConfig', 'ipc:webhook:setConfig'], /^const previousBindAllInterfaces = readConfig\(\)\.inboundBindAllInterfaces === true;$/, 'a scalar compare'],
  ['src/main/index.ts', '<module>', /^if \(readConfig\(\)\.realtimeVoiceEnabled\) writeConfig\(\{ realtimeVoiceEnabled: false \}\);$/, 'a scalar decision'],
  ['src/main/index.ts', '<module>', /^const cfgHome = readConfig\(\)\.harnessHome \?\? '';$/, 'a scalar compare'],
  ['src/main/index.ts', 'fire', /^emitContextTrigger\('compact', contextRule\('compact'\)\);$/, "the scheduler's compact emit reads the rule, it is no base"],
  ['src/main/standupDelta.ts', 'runStandupTick', /^const m = deps\.readMission\(\);$/, "the standup gate decides on the mission; stamp()'s patch carries only new values"],
  ['src/main/realtimeActions.ts', 'proposeDestructive', /^const oldValue = deps\.getConfigValue\(key\);$/, 'voice set_config: a scalar compare and the spoken undo'],
  ['src/main/realtimeActions.ts', 'setThemeByVoice', /^const themes = offeredProjectThemes\(deps\.getConfigValue\('tvShowOffices'\) === true\);$/, 'the voice theme offer list'],
  ['src/main/realtimeActions.ts', 'setThemeByVoice', /^const old = deps\.getProjectTheme\(\);$/, 'the voice theme compare and its spoken label'],
  ['src/main/index.ts', 'fire', /^gate = runStandupTick\(m\.id, \{$/, 'the gate decision; the stamp inside writes only new values on a fresh read'],
  ['src/main/index.ts', 'rearm', /^const persisted = \(readConfig\(\)\.missions \?\? \[\]\)\.find\(\(x\) => x\.id === m\.id\)\?\.lastFiredAt \?\? 0;$/, 'the weekly re-arm delay, a scalar'],
  ['src/main/claims/ledgerUi.ts', 'setLevel', /^const writers = d\.store\(\) \? d\.agents\(\)\.filter\(\(a\) => d\.level\(a\) === 'writer'\) : \[\];$/, 'who holds writer, for the confirm text']
];
const ts = require('typescript');
const MAIN = 'src/main';
const ROOT = path.join(__dirname, '..');
const mainFiles = () => fs.readdirSync(path.join(ROOT, MAIN), { recursive: true })
  .map((f) => String(f).replace(/\\/g, '/'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ rel: `${MAIN}/${f}`, text: readSource(`${MAIN}/${f}`) }));
const CONFIG = `${MAIN}/config.ts`;
// One program over main, served from memory so a fixture can replace a file. No lib and no
// resolution outside main: only main's own symbols need resolving.
function program(files) {
  const byPath = new Map(files.map((f) => [path.resolve(ROOT, f.rel).replace(/\\/g, '/'), f]));
  const options = { noLib: true, noResolve: false, allowJs: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, types: [] };
  const host = ts.createCompilerHost(options);
  const norm = (p) => path.resolve(p).replace(/\\/g, '/');
  host.fileExists = (p) => byPath.has(norm(p));
  host.readFile = (p) => byPath.get(norm(p))?.text;
  host.getSourceFile = (p, lang) => { const f = byPath.get(norm(p)); return f ? ts.createSourceFile(p, f.text, lang, true, ts.ScriptKind.TS) : undefined; };
  host.directoryExists = () => true;
  const prog = ts.createProgram([...byPath.keys()], options, host);
  const sfs = new Map();
  for (const [abs, f] of byPath) sfs.set(f.rel, prog.getSourceFile(abs));
  return { checker: prog.getTypeChecker(), sfs };
}
const walkAll = (node, fn) => { fn(node); ts.forEachChild(node, (c) => walkAll(c, fn)); };
// A function node's declaration: the node itself, or the const/property that holds it.
const holderOf = (fn) => {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return fn;
  const p = fn.parent;
  if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === fn) return p;
  return undefined;
};
// The values a function returns: its return statements (not those of nested functions) or an arrow's body.
const returned = (fn) => {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const walk = (n) => { if (ts.isFunctionLike(n)) return; if (ts.isReturnStatement(n) && n.expression) out.push(n.expression); ts.forEachChild(n, walk); };
  ts.forEachChild(fn.body, walk);
  return out;
};
function analyse(files) {
  const { checker, sfs } = program(files);
  const declsOf = (call) => {
    const callee = call.expression;
    const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    let sym = checker.getSymbolAtLocation(at);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations ?? [];
  };
  const fns = [];
  const calls = [];
  for (const sf of sfs.values()) walkAll(sf, (n) => {
    if (ts.isFunctionLike(n) && holderOf(n)) fns.push(n);
    if (ts.isCallExpression(n)) calls.push(n);
  });
  // A deps entry's interface member is the same function to its callers (deps.listMissions()).
  const withSignatures = (holder) => {
    const out = [holder];
    if (ts.isPropertyAssignment(holder)) {
      const type = checker.getContextualType(holder.parent);
      const prop = type && checker.getPropertyOfType(type, holder.name.getText());
      for (const d of prop?.declarations ?? []) if (d !== holder) out.push(d);
    }
    return out;
  };
  const named = (decls) => new Set(decls.map((d) => d.name?.getText()).filter(Boolean));
  const readConfigDecl = sfs.get(CONFIG).statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'readConfig');
  const writeConfigDecl = sfs.get(CONFIG).statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'writeConfig');
  const hits = (node, set) => {
    let hit = false;
    const seen = new Set();
    const walk = (n) => {
      if (hit || ts.isFunctionLike(n) || ts.isTemplateExpression(n)) return; // a spoken or logged string is no base
      if (ts.isCallExpression(n) && declsOf(n).some((d) => set.has(d))) { hit = true; return; }
      // A local holding a source's value: const c = readConfig(); return f(c).
      if (ts.isIdentifier(n)) { const d = checker.getSymbolAtLocation(n)?.declarations?.[0]; if (d && ts.isVariableDeclaration(d) && d.initializer && !seen.has(d)) { seen.add(d); walk(d.initializer); } return; }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return hit;
  };
  const sources = new Set([readConfigDecl]);
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of fns) {
      const h = holderOf(fn);
      if (!sources.has(h) && returned(fn).some((e) => hits(e, sources))) { for (const d of withSignatures(h)) sources.add(d); grew = true; }
    }
  }
  // Wrappers: a function whose writeConfig() (or wrapper) argument uses one of its own parameters as a value.
  const writers = new Set([writeConfigDecl]);
  // A parameter, or a name destructured out of one (Jim W2: function save({ list })).
  const paramOf = (d, fn) => {
    while (d && (ts.isBindingElement(d) || ts.isObjectBindingPattern(d) || ts.isArrayBindingPattern(d))) d = d.parent;
    return !!d && ts.isParameter(d) && d.parent === fn;
  };
  const usesParamAsValue = (arg, fn) => {
    let hit = false;
    const seen = new Set();
    const walk = (n) => {
      if (hit) return;
      if (ts.isCallExpression(n)) { n.arguments.forEach(walk); if (!ts.isIdentifier(n.expression)) walk(n.expression); return; }
      if (ts.isIdentifier(n)) {
        const d = checker.getSymbolAtLocation(n)?.declarations?.[0];
        if (paramOf(d, fn)) hit = true;
        // A local holding a parameter's value (Jim W1: const copy = list).
        else if (d && ts.isVariableDeclaration(d) && d.initializer && !seen.has(d)) { seen.add(d); walk(d.initializer); }
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(arg);
    return hit;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of fns) {
      const h = holderOf(fn);
      if (writers.has(h) || !fn.body) continue;
      let wraps = false;
      walkAll(fn.body, (n) => { if (!wraps && ts.isCallExpression(n) && declsOf(n).some((d) => writers.has(d)) && n.arguments.some((a) => usesParamAsValue(a, fn))) wraps = true; });
      if (wraps) { for (const d of withSignatures(h)) writers.add(d); grew = true; }
    }
  }
  // Every function around a read (Jim N1-N3: a read inside a callback or an IIFE still feeds the
  // handler around it); a module-level read has only its file.
  const scopesOf = (n) => { const out = []; for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) out.push(p); return out.length ? out : [n.getSourceFile()]; };
  // Where a read sits, for the read-only list: the nearest named function or ipcMain.handle channel.
  const contextOf = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      const h = holderOf(p);
      if (h?.name) return h.name.getText();
      const c = p.parent;
      if (ts.isCallExpression(c) && c.expression.getText() === 'ipcMain.handle' && c.arguments[0] && ts.isStringLiteral(c.arguments[0])) return `ipc:${c.arguments[0].text}`;
    }
    return '<module>';
  };
  const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const sourceLines = new Map();
  const writeSites = [];
  for (const [rel, sf] of sfs) {
    if (rel === CONFIG) continue;
    const lines = new Map();
    walkAll(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const decls = declsOf(n);
      if (decls.some((d) => sources.has(d))) { const l = lineOf(sf, n.expression.name ?? n.expression); lines.set(l, [...(lines.get(l) ?? []), { scopes: scopesOf(n), context: contextOf(n) }]); }
      if (decls.some((d) => writers.has(d))) writeSites.push({ rel, line: lineOf(sf, n.expression.name ?? n.expression), call: n });
    });
    sourceLines.set(rel, lines);
  }
  return { sources: named([...sources]), writers: named([...writers]), sourceLines, writeSites };
}
function staleBases(files, used) {
  const { sourceLines, writeSites } = analyse(files);
  const text = new Map(files.map((f) => [f.rel, f.text.split(/\r?\n/)]));
  const bad = new Set();
  for (const { rel, line: i, call } of writeSites) {
    const lines = text.get(rel);
    const reads = sourceLines.get(rel);
    for (let j = i; j >= Math.max(0, i - 30); j--) {
      const t = lines[j];
      for (const read of reads.get(j) ?? []) {
        if (!read.scopes.some((sc) => sc.pos <= call.pos && call.end <= sc.end)) continue;
        const allowed = READ_ONLY.find(([file, context, re]) => file === rel && [context].flat().includes(read.context) && re.test(t.trim()));
        if (allowed) { used?.add(allowed); continue; }
        if (process.env.CWB_DEBUG) console.log('HIT', rel, read.context, t.trim());
        bad.add(`${rel}:${j + 1} (for the write at ${i + 1}): ${t.trim()}`);
      }
      if (j < i && /^(ipcMain\.handle|function |export function |async function |const \w+ = \(|\}\);?$|\};?$)/.test(t)) break;
    }
  }
  return [...bad];
}
const withFile = (files, rel, text) => [...files.filter((f) => f.rel !== rel), { rel, text }];
const appendTo = (files, rel, extra) => withFile(files, rel, files.find((f) => f.rel === rel).text + extra);
test('the cached-source scan finds the helpers that return readConfig() values, and the wrappers', () => {
  const { sources, writers } = analyse(mainFiles());
  for (const name of ['readConfig', 'listRecords', 'getRecord', 'listMissions']) assert.ok(sources.has(name), name);
  assert.equal(sources.has('readConfigForWrite'), false);
  assert.ok(writers.has('writeConfig'));
  assert.equal(writers.has('editMissions'), false, 'edit(...) on a fresh read is not a wrapper');
});
test('no config write in main builds on a cached read (the rule for new code)', () => {
  const used = new Set();
  assert.deepEqual(staleBases(mainFiles(), used), []);
  // Every read-only entry still matches a real read in its own file and function (none is stale).
  assert.deepEqual(READ_ONLY.filter((e) => !used.has(e)).map(([file, context, re]) => `${file} ${context} ${re}`), []);
});
test('the rule refuses Jim C3 (a base read through a helper) and C7 (a stale merge in a file outside the census)', () => {
  const files = mainFiles();
  const c3 = appendTo(files, `${MAIN}/index.ts`, `
function jimCachedHooks() { return readConfig().webhookTriggers ?? []; }
ipcMain.handle('jim:c3', () => {
  const cur = jimCachedHooks();
  writeConfig({ webhookTriggers: [...cur] });
});
`);
  assert.deepEqual(staleBases(c3).map((b) => b.split(': ')[1]), ['const cur = jimCachedHooks();']);
  const c7 = withFile(files, `${MAIN}/knowledge.ts`, `import { readConfig, writeConfig } from './config';
export function jimKnowledge(on: boolean): void {
  writeConfig({ knowledgeGraph: { ...readConfig().knowledgeGraph, on } });
}
`);
  assert.deepEqual(staleBases(c7).map((b) => b.split(': ')[0]), [`${MAIN}/knowledge.ts:3 (for the write at 3)`]);
  // The same merge through readConfigForWrite passes.
  assert.deepEqual(staleBases(withFile(files, `${MAIN}/knowledge.ts`, c7[c7.length - 1].text.replace('readConfig()', 'readConfigForWrite()'))), []);
});
test('the rule refuses Jim R3 (a member-call helper base) and R1 (a cached base passed to a writer)', () => {
  const files = mainFiles();
  const r3 = appendTo(files, `${MAIN}/index.ts`, `
const jimApi = { hooks: () => readConfig().webhookTriggers ?? [] };
ipcMain.handle('jim:r3', () => {
  const cur = jimApi.hooks();
  writeConfig({ webhookTriggers: [...cur] });
});
`);
  assert.deepEqual(staleBases(r3).map((b) => b.split(': ')[1]), ['const cur = jimApi.hooks();']);
  const r1 = appendTo(files, `${MAIN}/index.ts`, `
function jimSaveHooks(list) { writeConfig({ webhookTriggers: list }); }
ipcMain.handle('jim:r1', () => {
  jimSaveHooks([...(readConfig().webhookTriggers ?? [])]);
});
`);
  assert.deepEqual(staleBases(r1).map((b) => b.split(': ')[1]), ['jimSaveHooks([...(readConfig().webhookTriggers ?? [])]);']);
  // The same writer on a fresh read passes.
  assert.deepEqual(staleBases(appendTo(files, `${MAIN}/index.ts`, `
function jimSaveHooks(list) { writeConfig({ webhookTriggers: list }); }
ipcMain.handle('jim:r1', () => {
  jimSaveHooks([...(readConfigForWrite().webhookTriggers ?? [])]);
});
`)), []);
});
test('a source function\'s own declaration is no read (Jim C7F: a fresh base in a method that also returns readConfig())', () => {
  const files = mainFiles();
  const c7f = withFile(files, `${MAIN}/knowledge.ts`, `import { readConfig, readConfigForWrite, writeConfig } from './config';
export class JimKnowledge {
  active(): boolean {
    const k = readConfigForWrite().knowledgeGraph;
    writeConfig({ knowledgeGraph: { ...k } });
    return readConfig().knowledgeGraph !== undefined;
  }
}
`);
  const { sources } = analyse(c7f);
  assert.ok(sources.has('active'), 'control: active() is a source');
  assert.deepEqual(staleBases(c7f), []);
});
test('the rule refuses a read in a callback, an IIFE or a promise chain (Jim N1-N3)', () => {
  const files = mainFiles();
  const stale = (body) => staleBases(appendTo(files, `${MAIN}/index.ts`, `
ipcMain.handle('jim:n', () => {
${body}
});
`)).map((b) => b.split(': ')[1]);
  assert.deepEqual(stale(`  const cur = [0].flatMap(() => readConfig().webhookTriggers ?? []);
  writeConfig({ webhookTriggers: [...cur] });`), ['const cur = [0].flatMap(() => readConfig().webhookTriggers ?? []);'], 'N1');
  assert.deepEqual(stale(`  const cur = (() => readConfig().webhookTriggers ?? [])();
  writeConfig({ webhookTriggers: [...cur] });`), ['const cur = (() => readConfig().webhookTriggers ?? [])();'], 'N2');
  assert.deepEqual(stale(`  Promise.resolve().then(() => readConfig().webhookTriggers ?? [])
    .then((cur) => { writeConfig({ webhookTriggers: [...cur] }); });`), ['Promise.resolve().then(() => readConfig().webhookTriggers ?? [])'], 'N3');
  assert.deepEqual(stale(`  const cur = [0].flatMap(() => readConfigForWrite().webhookTriggers ?? []);
  writeConfig({ webhookTriggers: [...cur] });`), [], 'the same callback on a fresh read passes');
});
test('the rule refuses a wrapper that passes its parameter through a local or destructuring (Jim W1, W2), and an aliased read', () => {
  const files = mainFiles();
  const stale = (extra) => staleBases(appendTo(files, `${MAIN}/index.ts`, extra)).map((b) => b.slice(b.indexOf("): ") + 3));
  assert.deepEqual(stale(`
function jimSaveHooks2(list) { const copy = list; writeConfig({ webhookTriggers: copy }); }
ipcMain.handle('jim:w1', () => {
  jimSaveHooks2([...(readConfig().webhookTriggers ?? [])]);
});
`), ['jimSaveHooks2([...(readConfig().webhookTriggers ?? [])]);'], 'W1');
  assert.deepEqual(stale(`
function jimSaveHooks3({ list }) { writeConfig({ webhookTriggers: list }); }
ipcMain.handle('jim:w2', () => {
  jimSaveHooks3({ list: [...(readConfig().webhookTriggers ?? [])] });
});
`), ['jimSaveHooks3({ list: [...(readConfig().webhookTriggers ?? [])] });'], 'W2');
  // The checker follows an import alias (Jim R2), so this is caught, not a limit.
  const aliased = withFile(files, `${MAIN}/knowledge.ts`, `import { readConfig as jimRc, writeConfig } from './config';
export function jimKnowledge(on: boolean): void {
  writeConfig({ knowledgeGraph: { ...jimRc().knowledgeGraph, on } });
}
`);
  assert.deepEqual(staleBases(aliased).map((b) => b.split(': ')[0]), [`${MAIN}/knowledge.ts:3 (for the write at 3)`], 'R2');
});
test('a read-only entry exempts its text only in its own function (Jim X1)', () => {
  const x1 = appendTo(mainFiles(), `${MAIN}/index.ts`, `
ipcMain.handle('jim:x1', () => {
  const cfg = readConfig();
  writeConfig({ webhookTriggers: [...(cfg.webhookTriggers ?? [])] });
});
`);
  assert.deepEqual(staleBases(x1).map((b) => b.split(': ')[1]), ['const cfg = readConfig();']);
});
