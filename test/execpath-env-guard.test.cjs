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
 *     (test/tools/node-env.cjs). Any finding fails here, naming file:line and why.
 *  2. TEETH: the lint flags each unsafe shape (allowlist, parameter, this.env, a deleted key, a rest
 *     destructure, an alias, a helper fed [process.execPath, ...]) and passes each safe one.
 *  3. nodeEnv adds the key only under Electron, and always returns a copy.
 *  4. PtyManager spawns (command: process.execPath, env {}) are safe because buildPtyEnv keeps the
 *     key from the parent: pinned here so a strip there cannot reopen the hole unseen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { analyzeSource, scan, KEY } = require('./tools/execpath-env-lint.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const HEAD = "const { spawn, spawnSync, execFileSync, fork } = require('node:child_process');\nconst { nodeEnv } = require('./tools/node-env.cjs');\n";
const lint = (body) => analyzeSource(HEAD + body, 'fixture.cjs');

test('THE TREE: every spawn of process.execPath keeps ELECTRON_RUN_AS_NODE under Electron', () => {
  const r = scan(REPO);
  assert.ok(r.checked > 50, `the scan reached the tree (${r.checked} files mention process.execPath)`);
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line}  ${f.why}`), [],
    'A SPAWN OF process.execPath WHOSE ENV MAY LACK ELECTRON_RUN_AS_NODE: under the Electron leg it starts a real Electron app. Wrap the env in nodeEnv() from test/tools/node-env.cjs');
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
    'fork with an allowlist': "fork('child.cjs', [], { env: { PATH: 'x' } }); fork(process.execPath, [], { env: { PATH: 'x' } });"
  };
  for (const [name, body] of Object.entries(unsafe)) {
    const f = lint(body);
    assert.equal(f.length, 1, `${name}: ${JSON.stringify(f)}`);
  }
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
    'a local copy with other keys deleted': "function bare(extra) { const env = { ...process.env }; for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[k]; return Object.assign(env, extra); } spawn(process.execPath, [], { env: bare({}) });",
    'a rest destructure of another key': "const { NODE_TEST_CONTEXT: _c, ...base } = process.env; spawn(process.execPath, [], { env: { ...base, A: '1' } });",
    'a helper with a process.env copy': "function start(args) { const env = { ...process.env }; return spawn(args[0], args.slice(1), { env }); } start([process.execPath, 'a.cjs']);",
    'options spread with nodeEnv': "const sp = (args, opts) => spawnSync(process.execPath, args, { ...opts, env: nodeEnv(opts.env) });",
    'an intentional electron.exe launch (category A)': "const exe = require('electron'); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; spawn(exe, ['.'], { env });",
    'a fallback to process.env': "function f(env) { return spawn(process.execPath, [], { env: nodeEnv(env ?? process.env) }); }"
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
  assert.equal(nodeEnv({})[KEY], process.versions.electron ? '1' : undefined, 'this runtime');
});

test('PtyManager path: buildPtyEnv keeps ELECTRON_RUN_AS_NODE from the parent (env {} is safe)', () => {
  const { buildPtyEnv } = loadTs(path.join(REPO, 'src/main/ptyEnv.ts'));
  const env = buildPtyEnv({ PATH: 'C:\\x', SystemRoot: 'C:\\Windows', [KEY]: '1' }, 'C:\\x', {}, 'win32');
  assert.equal(env[KEY], '1', 'a strip here would make every PtyManager spawn of process.execPath an Electron app under the Electron leg');
});
