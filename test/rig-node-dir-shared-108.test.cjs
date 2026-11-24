'use strict';
require('./tools/own-job.cjs');
// RIG-NODE-DIR-SHARED-108: the rig's shared node-only dir must never be shared by the node leg and the
// Electron leg. Electron 45 runs as node v24.22.2, the same process.version as the node leg, so a dir
// keyed by version alone got electron.exe linked in by an Electron-leg rig; every node-leg rig after
// that refused ("the node dir holds more than node"). 65 node-leg reds on 2026-11-18.
//
// The test plants the Electron leg the way it really happens: same process.version, process.execPath
// named electron.exe. Both executables are small stand-in files (only the names matter to the check),
// and the shared temp root is this test's own temp dir (GUPPY_SHARED_TEMP), so nothing real is touched.
// Since RIG-ELECTRON-LEG-NOT-ISOLATED-108 the Electron leg links a real console node (named by
// GUPPY_TEST_CONSOLE_NODE here) as node.exe, never electron.exe; df85d45a pinned ['electron.exe'] there
// without running the check on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isolation = require('./mail-rig/isolation.cjs');
const { consoleNode, KEY } = require('./tools/console-node.cjs');
// RIG-ELECTRON-LEG-NOT-ISOLATED-108: each leg is modelled by its versions (the suite itself may run on
// either leg). The Electron leg links a real console node (consoleNode), never electron.exe.
const NODE_LEG = { versions: { node: process.versions.node } };
const ELECTRON_LEG = { versions: { node: process.versions.node, electron: '45.0.0' } };
// The Electron-leg rigs hard-link the console node. On the Electron leg an rmSync of any link of an exe is
// EPERM while any process runs that image, under any name, and other suite files run the real console
// node in parallel. So this file links a PRIVATE COPY that only its own cells (and their --version child)
// run: one copy per file, in its own temp root, removed in after(). KEY names the copy before any consoleNode().
const SHARED_NODE = fs.realpathSync(consoleNode().file);
const PRIVATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rignode108-node-'));
const PRIVATE_NODE = path.join(PRIVATE_ROOT, path.basename(SHARED_NODE));
fs.copyFileSync(SHARED_NODE, PRIVATE_NODE);
const savedKey = process.env[KEY];
process.env[KEY] = PRIVATE_NODE;
test.after(() => {
  if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
  fs.rmSync(PRIVATE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const electronParent = () => ({ ...process.env, [KEY]: consoleNode().file });
// bigint stats: a Windows file id is 64-bit and as a JS number two different files can compare equal
const sameId = (a, b) => { const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true }); return x.ino === y.ino && x.dev === y.dev && x.size === y.size; };
// binding control: a cell that linked the shared console node again fails here by name, not by EPERM later
const notShared = (file) => assert.ok(!sameId(file, SHARED_NODE), `${file} is a link of the shared console node ${SHARED_NODE}, not this file's private copy`);

function withExec(exe, sharedRoot, fn) {
  const savedExec = process.execPath;
  const savedTemp = process.env.GUPPY_SHARED_TEMP;
  process.execPath = exe;
  process.env.GUPPY_SHARED_TEMP = sharedRoot;
  try { return fn(); } finally {
    process.execPath = savedExec;
    if (savedTemp === undefined) delete process.env.GUPPY_SHARED_TEMP; else process.env.GUPPY_SHARED_TEMP = savedTemp;
  }
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rignode108-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  const exes = {};
  for (const name of ['node.exe', 'electron.exe']) {
    const d = path.join(root, `bin-${name}`);
    fs.mkdirSync(d);
    exes[name] = path.join(d, name);
    fs.writeFileSync(exes[name], `stand-in ${name}`);
  }
  const sandbox = (n) => { const s = path.join(root, `sandbox-${n}`); fs.mkdirSync(s); return s; };
  return { shared, exes, sandbox };
}

test('RIG-NODE-DIR-SHARED-108: a node-leg rig still passes the isolation check after an Electron-leg rig (same process.version) made its node dir', (t) => {
  const { shared, exes, sandbox } = setup(t);
  // 1. a node-leg rig (the dir with node.exe exists, as on the floor before the Electron leg ran)
  const s1 = sandbox(1);
  const env1 = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s1, process.env, NODE_LEG));
  assert.equal(isolation.checkIsolation(env1, s1, { who: 'node leg before' }), true);
  // 2. an Electron-leg rig: same version, execPath electron.exe
  const s2 = sandbox(2);
  const parent2 = electronParent(); // before withExec: consoleNode() reads the real process.execPath
  const env2 = withExec(exes['electron.exe'], shared, () => isolation.rigEnv(s2, parent2, ELECTRON_LEG));
  notShared(path.join(env2.RIG_NODE_DIR, 'node.exe'));
  // 3. the next node-leg rig: its node dir must hold node only
  const s3 = sandbox(3);
  const env3 = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s3, process.env, NODE_LEG));
  assert.equal(isolation.checkIsolation(env3, s3, { who: 'node leg after the Electron leg' }), true);
  assert.deepEqual(fs.readdirSync(env3.RIG_NODE_DIR), ['node.exe']);
  // the Electron leg's console node is not the stand-in the node leg linked, so it got a dir of its own
  // (never the other file), and that dir holds node only: the check passes on it too (the gap df85d45a left)
  assert.notEqual(path.resolve(env2.RIG_NODE_DIR).toLowerCase(), path.resolve(env3.RIG_NODE_DIR).toLowerCase());
  assert.deepEqual(fs.readdirSync(env2.RIG_NODE_DIR), ['node.exe']);
  assert.equal(isolation.checkIsolation(env2, s2, { who: 'Electron leg' }), true);
});

test('RIG-NODE-DIR-SHARED-108: the Electron leg first, then the node leg (a fresh floor): the node leg passes', (t) => {
  const { shared, exes, sandbox } = setup(t);
  const s1 = sandbox(1);
  const parent1 = electronParent(); // before withExec: consoleNode() reads the real process.execPath
  const env1 = withExec(exes['electron.exe'], shared, () => isolation.rigEnv(s1, parent1, ELECTRON_LEG));
  notShared(path.join(env1.RIG_NODE_DIR, 'node.exe'));
  const s2 = sandbox(2);
  const env = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s2, process.env, NODE_LEG));
  assert.equal(isolation.checkIsolation(env, s2, { who: 'node leg' }), true);
  assert.deepEqual(fs.readdirSync(env.RIG_NODE_DIR), ['node.exe']);
});

test('RIG-NODE-DIR-SHARED-108: the check itself is unchanged: a node dir holding electron.exe beside node.exe is still refused', (t) => {
  const { shared, exes, sandbox } = setup(t);
  const s1 = sandbox(1);
  const env = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s1, process.env, NODE_LEG));
  fs.copyFileSync(exes['electron.exe'], path.join(env.RIG_NODE_DIR, 'electron.exe'));
  assert.throws(() => isolation.checkIsolation(env, s1, { who: 'planted' }), /the node dir holds more than node: .*electron\.exe, node\.exe/);
});
