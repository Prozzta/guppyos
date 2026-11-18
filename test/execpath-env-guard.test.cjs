'use strict';
require('./tools/own-job.cjs');
/**
 * TEST-EXECPATH-ENV-108: no test or rig starts a REAL Electron app by spawning process.execPath
 * without ELECTRON_RUN_AS_NODE.
 *
 * Under the Electron leg (ELECTRON_RUN_AS_NODE=1 electron.exe --test ...) process.execPath is
 * electron.exe; a child whose env lacks the key is an Electron app, not node (drill-tree-183: an
 * allowlisted env dropped the key and an app came up on the Human's desktop).
 *
 *  1. THE TREE: test/tools/execpath-env-lint.cjs finds every spawn of process.execPath in test/,
 *     tools/ and scripts/ whose env is not visibly process.env-derived or wrapped in nodeEnv()
 *     (tools/node-env.cjs). Any finding fails here, naming file:line and why.
 *  2. TEETH: the lint flags each unsafe shape (allowlist, parameter, this.env, a deleted key, a rest
 *     destructure, an alias, a helper fed [process.execPath, ...]) and passes each safe one. Jim's
 *     audit shapes each have their own subtest: a parameter used as the command, destructured /
 *     element-access / chained aliases, exec templates, spreads or assigns of unknown objects,
 *     writes and deletes of the key (process.env included), options mutated after creation,
 *     fork (it always runs process.execPath unless its execPath option says otherwise), and a
 *     scan that does not skip files lacking the literal 'process.execPath'.
 *  3. nodeEnv adds the key only under Electron, and always returns a copy.
 *  4. PtyManager spawns (command: process.execPath, env {}) are safe because buildPtyEnv keeps the
 *     key from the parent: pinned here so a strip there cannot reopen the hole unseen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { analyzeSource, scan, KEY } = require('./tools/execpath-env-lint.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const HEAD = "const { spawn, spawnSync, execFileSync, exec, execSync, fork } = require('node:child_process');\nconst { nodeEnv } = require('./tools/node-env.cjs');\n";
const lint = (body) => analyzeSource(HEAD + body, 'fixture.cjs');

test('THE TREE: every spawn of process.execPath keeps ELECTRON_RUN_AS_NODE under Electron', () => {
  const r = scan(REPO);
  assert.ok(r.checked > 50, `the scan reached the tree (${r.checked} files mention process.execPath)`);
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line}  ${f.why}`), [],
    'A SPAWN OF process.execPath WHOSE ENV MAY LACK ELECTRON_RUN_AS_NODE: under the Electron leg it starts a real Electron app. Wrap the env in nodeEnv() from tools/node-env.cjs');
});

test('TEETH: each unsafe env shape is a finding', () => {
  const unsafe = {
    'an allowlist': "spawnSync(process.execPath, ['-e', '0'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });",
    'an allowlist local': "function f() { const env = {}; env.PATH = process.env.PATH; return spawnSync(process.execPath, ['-e', '0'], { cwd: '.', env }); }",
    'a parameter': "function run(file, env) { return spawn(process.execPath, [file], { env }); }",
    'a parameter spread into an allowlist': "function run(env) { return spawn(process.execPath, [], { env: { PATH: 'x', ...env } }); }",
    'this.env': "class R { go() { return spawnSync(process.execPath, ['p'], { env: this.env }); } }",
    'an imported builder': "const { rigEnv } = require('./iso.cjs'); spawn(process.execPath, ['h'], { env: rigEnv('s') });",
    'a deleted key': "const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; spawn(process.execPath, [], { env });",
    'a delete loop naming the key': "function clean() { const env = { ...process.env }; for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[k]; return env; } spawn(process.execPath, [], { env: clean() });",
    'a rest destructure pulling the key out': "const { ELECTRON_RUN_AS_NODE: _e, ...base } = process.env; spawn(process.execPath, [], { env: base });",
    'the key set empty': "spawn(process.execPath, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });",
    'the key set to a variable': "const v = undefined; spawn(process.execPath, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: v } });",
    'an alias of process.execPath': "const NODE = process.execPath; execFileSync(NODE, ['-v'], { env: {} });",
    'a helper fed [process.execPath, ...]': "function start(args) { const env = { PATH: 'x' }; return spawn(args[0], args.slice(1), { env }); } start([process.execPath, 'a.cjs']);",
    'opaque options': "function sp(args, opts) { return spawnSync(process.execPath, args, opts); }",
    'an options spread with no env': "const sp = (args, opts) => spawnSync(process.execPath, args, { ...opts, stdio: 'pipe' });",
    'a reassigned env': "let env = { ...process.env }; env = { PATH: 'x' }; spawn(process.execPath, [], { env });",
    'fork with an allowlist': "fork(process.execPath, [], { env: { PATH: 'x' } });"
  };
  for (const [name, body] of Object.entries(unsafe)) {
    const f = lint(body);
    assert.equal(f.length, 1, `${name}: ${JSON.stringify(f)}`);
  }
});

// Jim's audit SHOULD: shapes the first lint missed. Each one is its own subtest so a miss names its shape;
// every one was red against the lint at f76df0fd.
test('TEETH (Jim SHOULD): each shape the first lint missed is a finding', async (t) => {
  const unsafe = {
    'a helper whose parameter is the command': "function run(cmd, args) { return spawnSync(cmd, args, { env: { PATH: 'x' } }); } run(process.execPath, ['-v']);",
    'a destructured execPath': "const { execPath } = process; spawn(execPath, [], { env: { PATH: 'x' } });",
    'a renamed destructure': "const { execPath: NODE } = process; spawn(NODE, [], { env: {} });",
    "element access process['execPath']": "spawn(process['execPath'], [], { env: { PATH: 'x' } });",
    'a chained alias': "const A = process.execPath; const B = A; let C; C = B; spawn(C, [], { env: {} });",
    'execSync with a template': "execSync(`\"${process.execPath}\" -v`, { env: { PATH: 'x' } });",
    'exec with a concatenation': "exec('\"' + process.execPath + '\" a.cjs', { env: {} }, () => {});",
    'Object.assign of a parameter onto a process.env copy': "function bare(extra) { const env = { ...process.env }; return Object.assign(env, extra); } spawn(process.execPath, [], { env: bare({}) });",
    'a parameter spread after process.env': "function run(o) { return spawn(process.execPath, [], { env: { ...process.env, ...o } }); }",
    'env[KEY] = undefined': "const KEY = 'ELECTRON_RUN_AS_NODE'; const env = { ...process.env }; env[KEY] = undefined; spawn(process.execPath, [], { env });",
    "env['ELECTRON_RUN_AS_NODE'] = ''": "const env = { ...process.env }; env['ELECTRON_RUN_AS_NODE'] = ''; spawn(process.execPath, [], { env });",
    'Object.assign blanking the key': "const env = { ...process.env }; Object.assign(env, { ELECTRON_RUN_AS_NODE: undefined }); spawn(process.execPath, [], { env });",
    'delete o.env.KEY': "const o = { env: { ...process.env } }; delete o.env.ELECTRON_RUN_AS_NODE; spawn(process.execPath, [], o);",
    'delete process.env.KEY, then an inherited env': "delete process.env.ELECTRON_RUN_AS_NODE; spawnSync(process.execPath, ['-v']);",
    'a computed key set undefined': "const KEY = 'ELECTRON_RUN_AS_NODE'; spawn(process.execPath, [], { env: { ...process.env, [KEY]: undefined } });",
    'options env replaced after creation': "const o = { env: { ...process.env } }; o.env = { PATH: 'x' }; spawn(process.execPath, [], o);",
    "fork's execPath option": "fork('child.cjs', [], { execPath: process.execPath, env: { PATH: 'x' } });",
    'fork of a script (it runs process.execPath)': "fork('child.cjs', [], { env: { PATH: 'x' } });"
  };
  for (const [name, body] of Object.entries(unsafe)) {
    await t.test(name, () => {
      const f = lint(body);
      assert.equal(f.length, 1, `${name}: ${JSON.stringify(f)}`);
    });
  }
  await t.test('the scan reads a file without the literal process.execPath', (st) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execpath-prefilter-'));
    st.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test', 'alias.cjs'), "const { spawn } = require('child_process');\nconst { execPath: N } = process;\nspawn(N, [], { env: {} });\n");
    fs.writeFileSync(path.join(root, 'test', 'fork.cjs'), "const { fork } = require('child_process');\nfork('c.cjs', [], { env: {} });\n");
    const r = scan(root);
    assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line}`).sort(), ['test/alias.cjs:3', 'test/fork.cjs:2']);
  });
});

test('TEETH (Jim 01-35-58 NIT 1): Reflect.deleteProperty and rest-parameter helpers; the command guard is narrow', async (t) => {
  const unsafe = {
    'Reflect.deleteProperty of the key on a copy': "const env = { ...process.env }; Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE'); spawn(process.execPath, [], { env });",
    'Reflect.deleteProperty of the key on process.env': "Reflect.deleteProperty(process.env, 'ELECTRON_RUN_AS_NODE'); spawnSync(process.execPath, ['-v']);",
    'Reflect.deleteProperty of a computed key in a loop': "const env = { ...process.env }; for (const k of ['A', 'ELECTRON_RUN_AS_NODE']) Reflect.deleteProperty(env, k); spawn(process.execPath, [], { env });",
    'a rest-parameter helper': "function run(...a) { return spawnSync(a[0], a[1], { env: { PATH: 'x' } }); } run(process.execPath, ['-v']);",
    'a rest-parameter helper after a fixed parameter': "const run = (label, ...a) => spawnSync(a[0], a.slice(1), { env: { PATH: 'x' } }); run('v', process.execPath, '-v');",
    'a guard on another variable than the command': "function run(cmd, other, env) { return spawnSync(cmd, [], { env: other === process.execPath ? nodeEnv(env) : env }); } run(process.execPath, 'x', { PATH: 'x' });",
    'a guard whose raw arm is the execPath arm': "function run(cmd, env) { return spawnSync(cmd, [], { env: cmd !== process.execPath ? nodeEnv(env) : env }); } run(process.execPath, { PATH: 'x' });"
  };
  for (const [name, body] of Object.entries(unsafe)) {
    await t.test(name, () => {
      const f = lint(body);
      assert.equal(f.length, 1, `${name}: ${JSON.stringify(f)}`);
    });
  }
  const safe = {
    'Reflect.deleteProperty of another key': "const env = { ...process.env }; Reflect.deleteProperty(env, 'NODE_OPTIONS'); spawn(process.execPath, [], { env });",
    'a rest-parameter helper with nodeEnv': "function run(...a) { return spawnSync(a[0], a[1], { env: nodeEnv({ PATH: 'x' }) }); } run(process.execPath, ['-v']);",
    'a rest-parameter helper called with another command': "function run(...a) { return spawnSync(a[0], a[1], { env: { PATH: 'x' } }); } run('git', ['status']);",
    'a guard that wraps only when the command is process.execPath (build-trial)': "function run(command, args, env) { return spawnSync(command, args, { env: command === process.execPath ? nodeEnv(env) : env }); } run(process.execPath, ['x'], { PATH: 'x' });",
    'a negated guard': "function run(cmd, env) { return spawnSync(cmd, [], { env: cmd !== process.execPath ? env : nodeEnv(env) }); } run(process.execPath, { PATH: 'x' });"
  };
  for (const [name, body] of Object.entries(safe)) {
    await t.test(`safe: ${name}`, () => assert.deepEqual(lint(body), [], name));
  }
});

// Does this source load code from test/? A literal relative require/import of ../test/..., or a
// require (or require.resolve) of path.join / path.resolve whose arguments name a 'test' segment
// ('test', 'test/...', '../test/...'). A path.join(..., 'test') that is not required (a directory
// read) is not a load.
const TEST_SEG = /['"`](?:\.\.\/)*test(?:['"`]|\/)/;
function loadsFromTest(text) {
  if (/require\(\s*['"`](?:\.\.\/)+test\/|from\s+['"`](?:\.\.\/)+test\//.test(text)) return true;
  for (const m of text.matchAll(/require(?:\.resolve)?\(\s*path\.(?:join|resolve)\(([^()]*)\)/g)) if (TEST_SEG.test(m[1])) return true;
  return false;
}
// In a named exception file, every load the regex can see, each as its call text: a literal
// relative ../test/ require/import, and EVERY require(path.join|resolve(...)) whatever its
// arguments, so a path built in a variable first (related-tests :183, testDir) is counted too.
function loadCallsOf(text) {
  const out = [];
  for (const m of text.matchAll(/require\(\s*['"`](?:\.\.\/)+test\/[^'"`]*['"`]\s*\)|from\s+['"`](?:\.\.\/)+test\/[^'"`]*['"`]/g)) out.push(m[0]);
  for (const m of text.matchAll(/require(?:\.resolve)?\(\s*path\.(?:join|resolve)\([^()]*\)\s*\)/g)) out.push(m[0]);
  return out.map((s) => s.replace(/\s+/g, ' ')).sort();
}
// Older tools/ and scripts/ files that load test/ code today (Jim eca9fada NIT 2). Not part of
// TEST-EXECPATH-ENV-108; named so that any NEW file goes red, and each lists its loads exactly
// (Jim 1e1cb898 NIT 1), so a NEW load added to a listed file goes red too. Remove an entry when
// its file stops loading from test/.
const TEST_LOAD_EXCEPTIONS = {
  'scripts/claims-derived-backfill.cjs': ["require(path.join(REPO, 'test', 'load-ts.cjs'))"],
  'scripts/claims-mailcard-backfill.cjs': ["require(path.join(REPO, 'test', 'load-ts.cjs'))"],
  'scripts/native-memory-migrate.cjs': ["require(path.join(REPO, 'test', 'load-ts.cjs'))"],
  // :171 FEATURE_TEST_DIRS; :183 discoverTestFiles, through testDir = path.join(repo, 'test').
  'scripts/related-tests.cjs': [
    "require(path.join(repo, 'test', 'tools', 'run-tests.cjs'))",
    "require(path.join(testDir, 'tools', 'run-tests.cjs'))"
  ],
  // this tree and the legacy tree
  'tools/gen-legacy-prompt-fp.cjs': [
    "require(path.join(__dirname, '../test/load-ts.cjs'))",
    "require(path.join(legacyRoot, 'test/load-ts.cjs'))"
  ],
  'tools/make-logo.cjs': ["require(path.join(ROOT, 'test/load-ts.cjs'))"],
  'tools/make-ph-thumbnail.cjs': ["require(path.join(ROOT, 'test/load-ts.cjs'))"]
};

test('LAYOUT detector (Jim eca9fada NIT 2): path.join/path.resolve loads of test/ count, directory reads do not', () => {
  const loads = [
    "require('../test/tools/node-env.cjs');",
    "import { x } from '../test/x.cjs';",
    "require(path.join(__dirname, '..', 'test', 'load-ts.cjs'));",
    "require(path.join(ROOT, 'test/load-ts.cjs'));",
    "require(path.join(__dirname, '../test/load-ts.cjs'));",
    "require(path.resolve(REPO, 'test', 'tools', 'run-tests.cjs')).FEATURE_TEST_DIRS;",
    "require.resolve(path.join(ROOT, 'test', 'x.cjs'));"
  ];
  for (const s of loads) assert.equal(loadsFromTest(s), true, `a load: ${s}`);
  const notLoads = [
    "const testDir = path.join(repo, 'test');",
    "require(path.join(ROOT, 'tools', 'x.cjs'));",
    "require(path.join(ROOT, 'latest', 'x.cjs'));",
    "require('./node-env.cjs');",
    "if (p.startsWith('test/')) out.push(p);"
  ];
  for (const s of notLoads) assert.equal(loadsFromTest(s), false, `not a load: ${s}`);
});

test('LAYOUT (Jim 01-35-58 + eca9fada NIT 2): nodeEnv lives in tools/; no tools/ or scripts/ file loads code from test/ except the named older ones', () => {
  assert.equal(require('../tools/node-env.cjs').nodeEnv, nodeEnv, 'test/tools/node-env.cjs re-exports tools/node-env.cjs');
  const found = [];
  for (const d of ['tools', 'scripts']) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(c?js|mjs|ts)$/.test(e.name)) continue;
        if (loadsFromTest(fs.readFileSync(p, 'utf8'))) found.push(path.relative(REPO, p).replace(/\\/g, '/'));
      }
    };
    walk(path.join(REPO, d));
  }
  const known = Object.keys(TEST_LOAD_EXCEPTIONS);
  assert.deepEqual(found.filter((f) => !known.includes(f)).sort(), [], 'a NEW tool or script loads code from test/: move the helper to tools/ (as node-env.cjs was)');
  assert.deepEqual(known.filter((f) => !found.includes(f)).sort(), [], 'a named exception no longer loads from test/: remove it from TEST_LOAD_EXCEPTIONS');
  for (const f of known) {
    assert.deepEqual(loadCallsOf(fs.readFileSync(path.join(REPO, f), 'utf8')), [...TEST_LOAD_EXCEPTIONS[f]].sort(),
      `${f}: its loads changed. A new load from test/ in a listed file is not covered by the exception; move the helper to tools/`);
  }
});

test('LAYOUT exception loads (Jim 1e1cb898 NIT 1): a listed file counts every path-built require, not just one naming test', () => {
  const text = [
    "const a = require(path.join(repo, 'test', 'tools', 'run-tests.cjs'));",
    "const testDir = path.join(repo, 'test');",
    "const b = require( path.join(testDir, 'tools', 'run-tests.cjs') );",
    "const c = require('../test/load-ts.cjs');",
    "const d = require('./node-env.cjs');"
  ].join('\n');
  assert.deepEqual(loadCallsOf(text), [
    "require( path.join(testDir, 'tools', 'run-tests.cjs') )",
    "require('../test/load-ts.cjs')",
    "require(path.join(repo, 'test', 'tools', 'run-tests.cjs'))"
  ]);
});

test('build-trial: only a process.execPath spawn gets nodeEnv (Jim 01-35-58 NIT 2)', () => {
  const src = fs.readFileSync(path.join(REPO, 'tools', 'build-trial.cjs'), 'utf8');
  assert.match(src, /env: command === process\.execPath \? nodeEnv\(env\) : env/);
});

test('TEETH: each safe env shape passes, and an electron.exe launch is not matched', () => {
  const safe = {
    'no options (inherits)': "spawnSync(process.execPath, ['-e', '0']);",
    'options with no env': "spawn(process.execPath, ['a'], { stdio: 'pipe' });",
    'process.env': "spawn(process.execPath, ['a'], { env: process.env });",
    'a process.env spread': "spawn(process.execPath, ['a'], { env: { ...process.env, X: '1' } });",
    'nodeEnv of an allowlist': "spawn(process.execPath, ['a'], { env: nodeEnv({ PATH: 'x' }) });",
    'nodeEnv of a parameter': "function run(env) { return spawn(process.execPath, [], { env: nodeEnv(env) }); }",
    'the key set': "spawn(process.execPath, [], { env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' } });",
    'a local copy with other keys deleted': "function bare(extra) { const env = { ...process.env }; for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[k]; return Object.assign(env, { A: '1' }); } spawn(process.execPath, [], { env: bare() });",
    'a rest destructure of another key': "const { NODE_TEST_CONTEXT: _c, ...base } = process.env; spawn(process.execPath, [], { env: { ...base, A: '1' } });",
    'a helper with a process.env copy': "function start(args) { const env = { ...process.env }; return spawn(args[0], args.slice(1), { env }); } start([process.execPath, 'a.cjs']);",
    'options spread with nodeEnv': "const sp = (args, opts) => spawnSync(process.execPath, args, { ...opts, env: nodeEnv(opts.env) });",
    'an intentional electron.exe launch (category A)': "const exe = require('electron'); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; spawn(exe, ['.'], { env });",
    'a fallback to process.env': "function f(env) { return spawn(process.execPath, [], { env: nodeEnv(env ?? process.env) }); }",
    'a computed key set to a non-empty literal': "const KEY = 'ELECTRON_RUN_AS_NODE'; spawn(process.execPath, [], { env: { PATH: 'x', [KEY]: '1' } });",
    'a conditional spread of literals': "function f(ctx) { return spawn(process.execPath, [], { env: { ...process.env, ...(ctx ? { A: '1' } : {}) } }); }",
    'a helper called with another command': "function run(cmd, args) { return spawnSync(cmd, args, { env: { PATH: 'x' } }); } run('git', ['status']);",
    'execSync of another command': "execSync('git status', { env: { PATH: 'x' } });",
    'fork with no options (inherits)': "fork('child.cjs');",
    'fork with nodeEnv': "fork('child.cjs', [], { env: nodeEnv({ PATH: 'x' }) });",
    'fork with another execPath': "fork('child.cjs', [], { execPath: 'C:/node/node.exe', env: { PATH: 'x' } });"
  };
  for (const [name, body] of Object.entries(safe)) assert.deepEqual(lint(body), [], name);
});

test('nodeEnv: the key only under Electron, and always a copy', () => {
  const base = { PATH: 'p', A: '1' };
  const asElectron = nodeEnv(base, { node: '24', electron: '45.3.0' });
  assert.deepEqual(asElectron, { PATH: 'p', A: '1', [KEY]: '1' });
  const asNode = nodeEnv(base, { node: '24' });
  assert.deepEqual(asNode, base, 'under node nothing is added');
  assert.notEqual(asNode, base, 'a copy: the caller can change it freely');
  assert.deepEqual(base, { PATH: 'p', A: '1' }, 'the input is untouched');
  assert.deepEqual(nodeEnv(undefined, { node: '24' }), { ...process.env }, 'default: a copy of process.env');
  assert.deepEqual(nodeEnv(null, { node: '24' }), { ...process.env }, 'null is the default too, not {} (Jim NIT 1)');
  assert.equal(nodeEnv({})[KEY], process.versions.electron ? '1' : undefined, 'this runtime');
});

test('PtyManager path: buildPtyEnv keeps ELECTRON_RUN_AS_NODE from the parent (env {} is safe)', () => {
  const { buildPtyEnv } = loadTs(path.join(REPO, 'src/main/ptyEnv.ts'));
  const env = buildPtyEnv({ PATH: 'C:\\x', SystemRoot: 'C:\\Windows', [KEY]: '1' }, 'C:\\x', {}, 'win32');
  assert.equal(env[KEY], '1', 'a strip here would make every PtyManager spawn of process.execPath an Electron app under the Electron leg');
});
