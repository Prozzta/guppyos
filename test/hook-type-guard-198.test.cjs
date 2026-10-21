'use strict';
/**
 * RULE-FIX-HOOK-NO-MODEL (god 82f71a): hive hook wiring uses only the zero-token hook types
 * (command, http, mcp_tool), never prompt/agent (a model call on every event they fire for).
 *  - What Guppy writes is stripped (Claude --settings, the Codex config.toml copy of the user's
 *    seed, the AGY 'munder-hive' group, the Gemini system settings, the Grok own file), with a
 *    'hook-type-guard' row; a Codex seed that cannot be cleaned refuses the spawn.
 *  - What the CLIs merge in that Guppy does not own is scanned only: a 'hook-model-warning' row
 *    once per change and a floor decision while it stands. The files are never written.
 * Pure functions with a fake fs, plus HiveManager runs under a redirected HOME.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const G = loadTs('src/main/hookTypeGuard.ts');
const D = loadTs('src/main/floorDigest.ts');
const M = loadTs('src/main/codexHookMcp.ts');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

const cmd = (c = 'x') => ({ type: 'command', command: c });
const fakeFs = (files, dirs = {}) => ({
  readFile: (p) => (p in files ? files[p] : null),
  list: (p) => dirs[p] ?? []
});

// ── the allow-list on event maps (Claude, Gemini, Grok, AGY shapes) ──

test('the allow-list is exactly command, http and mcp_tool', () => {
  assert.deepEqual([...G.ALLOWED_HOOK_TYPES].sort(), ['command', 'http', 'mcp_tool']);
});

test('stripHookMap drops prompt, agent and untyped handlers, keeps the zero-token ones, drops an emptied group', () => {
  const hooks = {
    Stop: [{ hooks: [cmd(), { type: 'prompt', prompt: 'judge' }] }, { matcher: '*', hooks: [{ type: 'agent', prompt: 'p' }] }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: 'http://127.0.0.1/h' }, { type: 'mcp_tool', server: 's', tool: 't' }] }],
    PostToolUse: [{ hooks: [{ command: 'no type' }] }],
    // AGY flat events: the handler is the entry itself.
    PreInvocation: [cmd('flat'), { type: 'prompt', prompt: 'flat' }]
  };
  const r = G.stripHookMap(hooks);
  assert.deepEqual(r.hooks, {
    Stop: [{ hooks: [cmd()] }],
    PreToolUse: hooks.PreToolUse,
    PreInvocation: [cmd('flat')]
  });
  assert.deepEqual(r.stripped, [
    { event: 'Stop', type: 'prompt' }, { event: 'Stop', type: 'agent' },
    { event: 'PostToolUse', type: '(none)' }, { event: 'PreInvocation', type: 'prompt' }
  ]);
  assert.deepEqual(G.scanHookMap(hooks), r.stripped, 'scan and strip agree');
  assert.deepEqual(G.scanHookMap(r.hooks), [], 'the stripped map scans clean');
});

test('stripSettingsHooks keeps every other key and returns the same object when there are no hooks', () => {
  const s = { hooksConfig: { enabled: true }, statusLine: { type: 'command', command: 's' }, hooks: { Stop: [{ hooks: [{ type: 'agent' }] }] } };
  const r = G.stripSettingsHooks(s);
  assert.deepEqual(r.settings, { hooksConfig: { enabled: true }, statusLine: s.statusLine, hooks: {} });
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'agent' }]);
  const none = { a: 1 };
  assert.equal(G.stripSettingsHooks(none).settings, none);
});

// ── the Codex seed (copied verbatim into OUR config.toml before this card) ──

const SEED = [
  'model = "gpt-5"',
  '',
  '[[hooks.Stop]]',
  '[[hooks.Stop.hooks]]',
  'type = "prompt"',
  'prompt = "judge the turn"',
  '',
  '[[hooks.PreToolUse]]',
  'matcher = "*"',
  '[[hooks.PreToolUse.hooks]]',
  'type = "command"',
  "command = 'user-cmd'",
  '[[hooks.PreToolUse.hooks]]',
  "type = 'agent'",
  'prompt = "p"',
  '',
  '[profiles.x]',
  'model = "o3"',
  ''
].join('\n');

test('Codex seed: a prompt/agent handler table is removed, a group left empty goes with it, the rest is kept byte for byte', () => {
  const r = G.stripCodexModelHooks(SEED);
  assert.equal(r.clean, true);
  assert.equal(r.allHooksDropped, false);
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'prompt' }, { event: 'PreToolUse', type: 'agent' }]);
  assert.equal(r.text, ['model = "gpt-5"', '', '[[hooks.PreToolUse]]', 'matcher = "*"', '[[hooks.PreToolUse.hooks]]', 'type = "command"', "command = 'user-cmd'", '[profiles.x]', 'model = "o3"', ''].join('\n'));
  assert.deepEqual(G.scanCodexToml(r.text), []);
  assert.ok(!r.text.includes('[[hooks.Stop]]'), 'the emptied group is gone (it would be an untyped entry)');
});

test('Codex seed: a group with an inline disallowed handler is removed; a clean inline group is kept', () => {
  const seed = 'a = 1\n[[hooks.Stop]]\nhooks = [{ type = "prompt", prompt = "x" }]\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "c" }]\n[tui]\nx = 1\n';
  const r = G.stripCodexModelHooks(seed);
  assert.equal(r.clean, true);
  assert.equal(r.text, 'a = 1\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "c" }]\n[tui]\nx = 1\n');
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'prompt' }]);
});

test('Codex seed: a group keeps its allowed handler tables when one of them is dropped', () => {
  const seed = '[[hooks.Stop]]\nmatcher = "*"\n[[hooks.Stop.hooks]]\ntype = "agent"\n[[hooks.Stop.hooks]]\ntype = "http"\nurl = "u"\n';
  const r = G.stripCodexModelHooks(seed);
  assert.equal(r.text, '[[hooks.Stop]]\nmatcher = "*"\n[[hooks.Stop.hooks]]\ntype = "http"\nurl = "u"\n');
  assert.equal(r.allHooksDropped, false);
});

test('Codex seed: a dropped handler takes its sub-tables (they would re-parent onto the kept one; Jim NIT 1)', () => {
  const seed = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "c"\n[[hooks.Stop.hooks]]\ntype = "prompt"\n[hooks.Stop.hooks.extra]\nx = 1\n[tui]\ny = 2\n';
  const r = G.stripCodexModelHooks(seed);
  assert.equal(r.text, '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "c"\n[tui]\ny = 2\n');
  assert.equal(r.allHooksDropped, false);
});

test('Codex seed: a quoted type key is read like a bare one (Jim NIT 2)', () => {
  const seed = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\n"type" = "command"\ncommand = "c"\n[[hooks.Stop.hooks]]\n\'type\' = "prompt"\n[[hooks.Pre]]\nhooks = [{ "type" = "agent" }]\n[[hooks.Post]]\nhooks = [{ "type" = "http", url = "u" }]\n';
  const r = G.stripCodexModelHooks(seed);
  assert.equal(r.text, '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\n"type" = "command"\ncommand = "c"\n[[hooks.Post]]\nhooks = [{ "type" = "http", url = "u" }]\n');
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'prompt' }, { event: 'Pre', type: 'agent' }]);
  assert.equal(r.allHooksDropped, false);
});

test('Codex seed: a shape the table splitter cannot place falls back to dropping every hooks table; CRLF is kept', () => {
  const seed = 'a = 1\r\n[hooks]\r\nStop = [{ hooks = [{ type = "agent", prompt = "x" }] }]\r\n[tui]\r\nx = 1\r\n';
  const r = G.stripCodexModelHooks(seed);
  assert.equal(r.clean, true);
  assert.equal(r.allHooksDropped, true);
  assert.equal(r.text, 'a = 1\r\n[tui]\r\nx = 1\r\n');
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'agent' }]);
});

test('Codex seed: hooks in a root inline table cannot be removed by table, so the result is not clean (the spawn refuses)', () => {
  const r = G.stripCodexModelHooks('hooks = { Stop = [{ hooks = [{ type = "prompt", prompt = "x" }] }] }\n');
  assert.equal(r.clean, false);
  assert.deepEqual(r.stripped, [{ event: 'Stop', type: 'prompt' }]);
});

test('Codex seed: a clean seed is returned as is; one that does not parse is left alone (codex rejects it too)', () => {
  const clean = 'model = "x"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "c"\n';
  assert.deepEqual(G.stripCodexModelHooks(clean), { text: clean, stripped: [], clean: true, allHooksDropped: false });
  const bad = '[[hooks.Stop.hooks]\ntype = "prompt"\n';
  assert.equal(G.scanCodexToml(bad), null);
  assert.deepEqual(G.stripCodexModelHooks(bad), { text: bad, stripped: [], clean: true, allHooksDropped: false, unparsed: true });
});

test('Codex: our own command and mcp_tool tables scan clean (the final scan never refuses our output)', () => {
  const t = M.codexMcpHookToml('http://127.0.0.1:1/mcp/x', 'tok');
  const ours = `${t.server}${t.hook('PreToolUse')}${t.hook('PostToolUse')}\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = 'node shim'\ntimeout = 30\n`;
  assert.deepEqual(G.scanCodexToml(ours), []);
});

// ── files Guppy does not own: scanned, never edited ──

test('foreign files: Claude user, project, local, managed (per platform) and installed plugin hooks', () => {
  const home = path.join('H');
  const plugins = path.join(home, '.claude', 'plugins');
  const p1 = path.join(plugins, 'cache', 'mkt', 'p1');
  const dirs = {
    [plugins]: [{ name: 'cache', dir: true }, { name: '.git', dir: true }],
    [path.join(plugins, 'cache')]: [{ name: 'mkt', dir: true }, { name: 'node_modules', dir: true }],
    [path.join(plugins, 'cache', 'mkt')]: [{ name: 'p1', dir: true }],
    [p1]: [{ name: 'hooks', dir: true }, { name: 'hooks.json', dir: false }],
    [path.join(p1, 'hooks')]: [{ name: 'hooks.json', dir: false }],
    [path.join(plugins, '.git')]: [{ name: 'hooks', dir: true }],
    [path.join(plugins, 'cache', 'node_modules')]: [{ name: 'hooks', dir: true }],
    [path.join(plugins, '.git', 'hooks')]: [{ name: 'hooks.json', dir: false }],
    [path.join(plugins, 'cache', 'node_modules', 'hooks')]: [{ name: 'hooks.json', dir: false }]
  };
  const files = G.foreignHookFiles('claude', { home, cwd: 'P', platform: 'win32', fs: fakeFs({}, dirs) });
  assert.deepEqual(files.map((f) => f.path), [
    path.join(home, '.claude', 'settings.json'),
    path.join('P', '.claude', 'settings.json'),
    path.join('P', '.claude', 'settings.local.json'),
    'C:\\Program Files\\ClaudeCode\\managed-settings.json',
    path.join(p1, 'hooks', 'hooks.json')
  ], 'only hooks/hooks.json; dot dirs and node_modules are not walked');
  assert.equal(G.foreignHookFiles('claude', { home, cwd: null, platform: 'linux', fs: fakeFs({}) })[1].path, '/etc/claude-code/managed-settings.json');
  assert.equal(G.foreignHookFiles('claude', { home, cwd: null, platform: 'darwin', fs: fakeFs({}) })[1].path, '/Library/Application Support/ClaudeCode/managed-settings.json');
});

test('foreign files: the plugin walk is bounded in depth and count', () => {
  const root = path.join('H', '.claude', 'plugins');
  const dirs = {};
  let d = root;
  for (let i = 0; i < 10; i++) { dirs[d] = [{ name: 'hooks', dir: true }, { name: `n${i}`, dir: true }]; dirs[path.join(d, 'hooks')] = [{ name: 'hooks.json', dir: false }]; d = path.join(d, `n${i}`); }
  const deep = G.foreignHookFiles('claude', { home: 'H', cwd: null, platform: 'linux', fs: fakeFs({}, dirs) }).filter((f) => f.label === 'an installed Claude plugin');
  assert.equal(deep.length, G.PLUGIN_WALK_MAX_DEPTH, 'a hooks folder one level below each walked folder, down to the depth cap');
  const wide = { [root]: Array.from({ length: 300 }, (_, i) => ({ name: `p${i}`, dir: true })) };
  for (let i = 0; i < 300; i++) { wide[path.join(root, `p${i}`)] = [{ name: 'hooks', dir: true }]; wide[path.join(root, `p${i}`, 'hooks')] = [{ name: 'hooks.json', dir: false }]; }
  const many = G.foreignHookFiles('claude', { home: 'H', cwd: null, platform: 'linux', fs: fakeFs({}, wide) }).filter((f) => f.label === 'an installed Claude plugin');
  assert.equal(many.length, G.PLUGIN_WALK_MAX_FILES);
});

test('foreign files: Codex seed, both AGY hooks files, Gemini user + project, Grok files except our own', () => {
  const home = 'H';
  assert.deepEqual(G.foreignHookFiles('codex', { home, cwd: 'P', fs: fakeFs({}) }).map((f) => [f.path, f.kind]), [[path.join(home, '.codex', 'config.toml'), 'codex-toml']]);
  assert.deepEqual(G.foreignHookFiles('antigravity', { home, cwd: 'P', fs: fakeFs({}) }).map((f) => [f.path, f.kind]), [
    [path.join(home, '.gemini', 'config', 'hooks.json'), 'agy-hooks'], [path.join(home, '.gemini', 'antigravity-cli', 'hooks.json'), 'agy-hooks']]);
  assert.deepEqual(G.foreignHookFiles('gemini', { home, cwd: 'P', fs: fakeFs({}) }).map((f) => f.path), [path.join(home, '.gemini', 'settings.json'), path.join('P', '.gemini', 'settings.json')]);
  const grokDir = path.join(home, '.grok', 'hooks');
  const grok = G.foreignHookFiles('grok', { home, cwd: null, fs: fakeFs({}, { [grokDir]: [{ name: 'munder-hive.json', dir: false }, { name: 'mine.json', dir: false }, { name: 'notes.txt', dir: false }, { name: 'sub.json', dir: true }] }) });
  assert.deepEqual(grok.map((f) => f.path), [path.join(grokDir, 'mine.json')]);
  assert.equal(G.GROK_OWN_FILE, 'munder-hive.json');
});

test('scanForeignHookFile: named model types only; our AGY key is skipped; unreadable or unparsable is no finding', () => {
  const f = (p, kind) => ({ path: p, kind, label: 'l' });
  const files = {
    s: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt' }, cmd(), { command: 'untyped' }] }] } }),
    bom: '\ufeff' + JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'agent' }] }] } }),
    agy: JSON.stringify({ 'munder-hive': { Stop: [{ type: 'prompt' }] }, mine: { Stop: [{ type: 'agent' }], PreToolUse: [{ matcher: '*', hooks: [cmd()] }] } }),
    toml: '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "prompt"\n',
    junk: '{not json'
  };
  const fsx = fakeFs(files);
  assert.deepEqual(G.scanForeignHookFile(f('s', 'settings'), fsx), [{ event: 'Stop', type: 'prompt' }]);
  assert.deepEqual(G.scanForeignHookFile(f('bom', 'settings'), fsx), [{ event: 'Stop', type: 'agent' }]);
  assert.deepEqual(G.scanForeignHookFile(f('agy', 'agy-hooks'), fsx), [{ event: 'mine/Stop', type: 'agent' }]);
  assert.equal(G.AGY_OWN_KEY, 'munder-hive');
  assert.deepEqual(G.scanForeignHookFile(f('toml', 'codex-toml'), fsx), [{ event: 'Stop', type: 'prompt' }]);
  assert.deepEqual(G.scanForeignHookFile(f('junk', 'settings'), fsx), []);
  assert.deepEqual(G.scanForeignHookFile(f('missing', 'settings'), fsx), []);
  assert.equal(G.findingsText([{ event: 'Stop', type: 'prompt' }, { event: 'X', type: 'agent' }]), 'Stop: prompt, X: agent');
});

// ── the floor decision ──

test('digest: one decision item per file and finding set, naming the file and what to do', () => {
  const m = { file: 'C:\\u\\.claude\\settings.json', label: 'your Claude user settings', provider: 'claude', findings: 'Stop: prompt', stripped: false, since: 1000 };
  const a = D.modelHooksItem(m, 61000);
  assert.match(a.id, /^hook-model:[0-9a-f]{12}$/);
  assert.ok(a.line.includes(m.file) && a.line.includes('Stop: prompt') && a.line.includes('never edits this file'), a.line);
  assert.ok(a.line.includes('merges them in'), 'not ours to strip: the CLI merges it');
  assert.equal(D.modelHooksItem({ ...m, since: 5 }, 9).id, a.id, 'the same set keeps its id (god is woken once)');
  assert.notEqual(D.modelHooksItem({ ...m, findings: 'Stop: agent' }, 9).id, a.id, 'a changed set is a new decision');
  assert.ok(D.modelHooksItem({ ...m, stripped: true, provider: 'codex' }, 9).line.includes("drops them from every codex agent's copy"));
  const digest = D.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now: 61000, modelHooks: [m] });
  assert.deepEqual(digest.decisionItems.map((i) => i.id), [a.id]);
  assert.ok(digest.markdown.includes(`- [${a.id}]`));
});

test('wiring: the digest asks the host fail-safe, and index.ts hands it the hive warnings', () => {
  assert.ok(src('src/main/floorDigest.ts').includes('modelHooks: (() => { try { return this.host.modelHooks?.() ?? []; } catch { return []; } })(),'));
  assert.ok(src('src/main/index.ts').includes('  modelHooks: () => hive.modelHookWarnings(),'));
});

// ── HiveManager: every writer, per provider, under a redirected HOME ──

const { HiveManager } = loadTs('src/main/hive.ts');

function redirectedHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-hook-guard-')));
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home, 'home redirect failed: aborting before any hive object reads or writes a real home');
  return home;
}
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
function hiveIn(t, home, live = false) {
  const hive = live ? new HiveManager(() => home, undefined, {}, () => true) : new HiveManager(() => home);
  t.after(() => hive.dispose());
  const rows = [];
  hive.appendLog = (r) => { rows.push(r); };
  return { hive, rows };
}

test('Claude: a prompt/agent hook in our --settings is stripped and logged; the user layers are warned on, never written', async (t) => {
  const home = redirectedHome(t);
  const user = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'judge' }] }] } });
  put(path.join(home, '.claude', 'settings.json'), user);
  const { hive, rows } = hiveIn(t, home);
  const real = hive.hookSettings.bind(hive);
  hive.hookSettings = (...a) => { const s = real(...a); s.hooks.Stop[0].hooks.push({ type: 'agent', prompt: 'x' }); return s; };
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const written = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'a1', 'settings.json'), 'utf8'));
  assert.deepEqual(G.scanHookMap(written.hooks), [], 'only zero-token types in the file we wrote');
  assert.ok(written.hooks.Stop[0].hooks.length > 0, 'our own Stop hook stays');
  assert.deepEqual(rows.filter((r) => r.kind === 'hook-type-guard').map((r) => [r.provider, r.action, r.stripped]), [['claude', 'strip', [{ event: 'Stop', type: 'agent' }]]]);
  const warn = rows.filter((r) => r.kind === 'hook-model-warning');
  assert.deepEqual(warn.map((r) => [r.provider, r.file, r.findings]), [['claude', path.join(home, '.claude', 'settings.json'), [{ event: 'Stop', type: 'prompt' }]]]);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), user, 'the user file is never edited');
  assert.equal(hive.modelHookWarnings().length, 1);
});

test('foreign warnings: one row per change, cleared when the file is fixed', (t) => {
  const home = redirectedHome(t);
  const p = path.join(home, '.gemini', 'settings.json');
  put(p, JSON.stringify({ hooks: { AfterAgent: [{ hooks: [{ type: 'prompt' }] }] } }));
  const { hive, rows } = hiveIn(t, home);
  hive.scanForeignHooks('a1', 'gemini', null);
  hive.scanForeignHooks('a2', 'gemini', null);
  assert.equal(rows.filter((r) => r.kind === 'hook-model-warning').length, 1, 'the same set is not logged again');
  put(p, JSON.stringify({ hooks: { AfterAgent: [{ hooks: [{ type: 'agent' }] }] } }));
  hive.scanForeignHooks('a1', 'gemini', null);
  assert.equal(rows.filter((r) => r.kind === 'hook-model-warning').length, 2, 'a changed set is a new row');
  assert.equal(hive.modelHookWarnings()[0].findings, 'AfterAgent: agent');
  put(p, JSON.stringify({ hooks: { AfterAgent: [{ hooks: [cmd()] }] } }));
  hive.scanForeignHooks('a1', 'gemini', null);
  assert.deepEqual(hive.modelHookWarnings(), []);
  assert.equal(rows.at(-1).cleared, true);
});

test('Codex: the seed\'s model hooks are dropped from OUR copy (the user file untouched); an uncleanable seed refuses', (t) => {
  const home = redirectedHome(t);
  const seedPath = path.join(home, '.codex', 'config.toml');
  put(seedPath, SEED);
  const { hive, rows } = hiveIn(t, home);
  const dir = path.join(home, 'hive', 'agents', 'c1');
  fs.mkdirSync(dir, { recursive: true });
  const r = hive.installCodexHooks(dir, 'c1');
  assert.equal(r.refusal, undefined);
  const ours = fs.readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8');
  assert.deepEqual(G.scanCodexToml(ours), []);
  assert.ok(ours.includes("command = 'user-cmd'"), "the user's command hook is kept");
  assert.equal(fs.readFileSync(seedPath, 'utf8'), SEED, 'the seed is read, never written');
  assert.deepEqual(rows.filter((x) => x.kind === 'hook-type-guard').map((x) => [x.action, x.stripped.length]), [['strip', 2]]);
  hive.scanForeignHooks('c1', 'codex', null);
  const w = hive.modelHookWarnings();
  assert.deepEqual(w.map((x) => [x.file, x.stripped]), [[seedPath, true]]);

  put(seedPath, 'hooks = { Stop = [{ hooks = [{ type = "prompt", prompt = "x" }] }] }\n');
  rows.length = 0;
  const refused = hive.installCodexHooks(dir, 'c1');
  assert.match(refused.refusal, /^Not started: your Codex config .* has model-invoking hooks \(Stop: prompt\)/);
  assert.deepEqual(rows.filter((x) => x.kind === 'hook-type-guard').map((x) => x.action), ['refuse']);
});

test('Codex: a loading project layer\'s model hooks are warned on, by file', (t) => {
  const home = redirectedHome(t);
  const { hive, rows } = hiveIn(t, home);
  const layer = path.join(home, 'proj', '.codex');
  put(path.join(layer, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'agent' }] }] } }));
  put(path.join(layer, 'config.toml'), '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "prompt"\n');
  // A linked worktree's hooks come from its main checkout (codexProjectLayers hooksFrom).
  const wt = path.join(home, 'wt', '.codex');
  const main = path.join(home, 'main', '.codex');
  put(path.join(wt, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt' }] }] } }));
  put(path.join(main, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'agent' }] }] } }));
  hive.scanCodexLayerHooks('c1', { layers: [{ dotCodex: layer, trust: 'user', execute: [], confine: [], parse: [] }, { dotCodex: wt, hooksFrom: main, trust: 'user', execute: [], confine: [], parse: [] }], unknown: [], managedConfig: false, projectFolder: '' });
  assert.deepEqual(rows.map((r) => [r.kind, r.file, r.stripped]), [
    ['hook-model-warning', path.join(layer, 'config.toml'), false], ['hook-model-warning', path.join(layer, 'hooks.json'), false],
    ['hook-model-warning', path.join(main, 'hooks.json'), false]]);
});

test('AGY and Grok: our group and our file are clean; the user\'s entries in the shared file stay as they are and are warned on', (t) => {
  const home = redirectedHome(t);
  const agy = path.join(home, '.gemini', 'config', 'hooks.json');
  put(agy, JSON.stringify({ mine: { Stop: [{ type: 'prompt', prompt: 'x' }] } }));
  put(path.join(home, '.grok', 'hooks', 'theirs.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'agent' }] }] } }));
  const { hive } = hiveIn(t, home, true);
  hive.ensureHive();
  hive.installAgyHooks();
  hive.installGrokHooks();
  const shared = JSON.parse(fs.readFileSync(agy, 'utf8'));
  assert.deepEqual(shared.mine, { Stop: [{ type: 'prompt', prompt: 'x' }] }, "the user's key is kept as it was");
  assert.deepEqual(G.scanHookMap(shared['munder-hive']), []);
  assert.ok(Object.keys(shared['munder-hive']).length > 0);
  const grokOwn = JSON.parse(fs.readFileSync(path.join(home, '.grok', 'hooks', 'munder-hive.json'), 'utf8'));
  assert.deepEqual(G.scanHookMap(grokOwn.hooks), []);
  hive.scanForeignHooks('g1', 'antigravity', null);
  hive.scanForeignHooks('k1', 'grok', null);
  assert.deepEqual(hive.modelHookWarnings().map((w) => [w.provider, w.findings]).sort(), [['antigravity', 'mine/Stop: prompt'], ['grok', 'Stop: agent']]);
});

test('Gemini: the per-agent system settings are clean', (t) => {
  const home = redirectedHome(t);
  const { hive } = hiveIn(t, home);
  const p = hive.installGeminiHooks(path.join(home, 'hive', 'agents', 'm1'), 'm1');
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Object.keys(s.hooks).length > 0);
  assert.deepEqual(G.scanHookMap(s.hooks), []);
});

/** Swap one export of hookTypeGuard for the duration of `fn` (hive.ts reads the same module). */
async function withGuard(name, impl, fn) {
  const real = G[name];
  G[name] = impl;
  try { return await fn(); } finally { G[name] = real; }
}

test('wiring: AGY, Gemini and Grok write what the guard returns, and log what it stripped', async (t) => {
  const home = redirectedHome(t);
  const { hive, rows } = hiveIn(t, home, true);
  hive.ensureHive();
  const mark = { Marked: [{ hooks: [cmd('guarded')] }] };
  const stripped = [{ event: 'Marked', type: 'prompt' }];
  await withGuard('stripHookMap', () => ({ hooks: mark, stripped }), () => hive.installAgyHooks());
  for (const p of [path.join(home, '.gemini', 'config', 'hooks.json'), path.join(home, '.gemini', 'antigravity-cli', 'hooks.json')]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8'))['munder-hive'], mark, `agy ${p}`);
  }
  await withGuard('stripSettingsHooks', (s) => ({ settings: { ...s, hooks: mark }, stripped }), () => {
    hive.installGrokHooks();
    hive.installGeminiHooks(path.join(home, 'hive', 'agents', 'm1'), 'm1');
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.grok', 'hooks', 'munder-hive.json'), 'utf8')).hooks, mark, 'grok');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'hive', 'agents', 'm1', '.gemini-hive', 'system-settings.json'), 'utf8')).hooks, mark, 'gemini');
  assert.deepEqual(rows.filter((r) => r.kind === 'hook-type-guard').map((r) => [r.provider, r.agentId, r.action]), [['antigravity', null, 'strip'], ['grok', null, 'strip'], ['gemini', 'm1', 'strip']]);
});

test('wiring: a Codex config that still has a model hook at the write is refused, never written', async (t) => {
  const home = redirectedHome(t);
  put(path.join(home, '.codex', 'config.toml'), SEED);
  const { hive, rows } = hiveIn(t, home);
  const dir = path.join(home, 'hive', 'agents', 'c1');
  fs.mkdirSync(dir, { recursive: true });
  const r = await withGuard('stripCodexModelHooks', (text) => ({ text, stripped: [], clean: true, allHooksDropped: false }), () => hive.installCodexHooks(dir, 'c1'));
  assert.match(r.refusal, /^Not started: this Codex agent's generated config would carry model-invoking hooks \(Stop: prompt, PreToolUse: agent\)/);
  assert.equal(fs.existsSync(path.join(dir, '.codex', 'config.toml')), false);
  assert.deepEqual(rows.filter((x) => x.kind === 'hook-type-guard').map((x) => x.action), ['refuse']);
});

// ── source pins: every writer goes through the guard, every spawn path scans ──

test('pins: each provider\'s writer goes through the guard and each spawn branch scans the merged files', () => {
  const hive = src('src/main/hive.ts');
  assert.ok(hive.includes("this.writeJson(settingsPath, this.guardHookSettings(meta.id, 'claude', settingsPath, withSkillOverrides(this.hookSettings("), 'claude --settings');
  assert.ok(hive.includes("this.scanForeignHooks(meta.id, 'claude', meta.cwd);"), 'claude scan');
  assert.ok(hive.includes("const group = this.guardHookMap(null, 'antigravity', `hooks.json[${AGY_OWN_KEY}]`, {"), 'agy group');
  assert.ok(hive.includes("existing['munder-hive'] = group;"), 'agy writes the guarded group');
  assert.ok(hive.includes("join(hookDir, 'munder-hive.json'),") && G.AGY_OWN_KEY === 'munder-hive' && G.GROK_OWN_FILE === 'munder-hive.json', 'the scan skips exactly what the writers write');
  assert.ok(hive.includes("writeFileSync(settingsPath, JSON.stringify(this.guardHookSettings(agentId, 'gemini', settingsPath, settings), null, 2), 'utf8');"), 'gemini');
  assert.ok(hive.includes("JSON.stringify(this.guardHookSettings(null, 'grok', GROK_OWN_FILE, { hooks }), null, 2),"), 'grok');
  for (const p of ['antigravity', 'codex', 'gemini', 'grok']) assert.ok(hive.includes(`this.scanForeignHooks(meta.id, '${p}', meta.cwd);`), `${p} scan`);
  const fn = hive.slice(hive.indexOf('  private installCodexHooks('), hive.indexOf("writeFileSync(join(home, 'config.toml'), config, 'utf8');"));
  const plugins = fn.indexOf('if (config && !inheritPlugins) config = disableCodexPlugins(config).text;');
  const strip = fn.indexOf('const g = stripCodexModelHooks(config);');
  assert.ok(plugins > 0 && strip > plugins && strip < fn.indexOf('const configBeforeSeed = config;'), 'the seed is stripped before the trust seed and the layer check');
  assert.ok(fn.indexOf('this.scanCodexLayerHooks(agentId ?? null, report);') > fn.indexOf('const decision = decideCodexLayers(report, layer.optIns);'));
  const final = fn.indexOf('const finalHooks = scanCodexToml(config);');
  assert.ok(final > fn.indexOf('if (shim) {') && final > fn.indexOf('withCodexDeveloperInstructions(config'), 'the final scan is the last step before the write');
  const refuse = fn.slice(fn.indexOf('if (finalHooks && finalHooks.length) {'));
  assert.ok(refuse.length < 900 && refuse.includes("action: 'refuse'") && refuse.trimEnd().endsWith('}'), 'a dirty final config refuses (logged) instead of being written');
  assert.ok(refuse.includes('return { home, refusal: reason };'));
});
