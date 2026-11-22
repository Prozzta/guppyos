'use strict';
require('./tools/own-job.cjs');
// RIG-ELECTRON-LEG-NOT-ISOLATED-108: on the Electron leg the rig's node dir held only electron.exe
// (jailedNodeDir linked process.execPath under its own name), so the unchanged node-only check refused
// it ("rig-host: not isolated: the node dir holds more than node") and every rig file failed whole on
// that leg. Behind it, the stub CLIs' cmd-shims fall back to bare `node` on the rig PATH, which had none.
// The fix links a real console node (consoleNode) as node.exe on the Electron leg.
//
// The leg is modelled without launching Electron: process.execPath is a stand-in electron.exe and
// versions carries electron; GUPPY_TEST_CONSOLE_NODE names a real console node (a stand-in is not a PE
// file). The shared temp root is this test's own temp dir (GUPPY_SHARED_TEMP), so nothing real is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isolation = require('./mail-rig/isolation.cjs');
const { consoleNode, KEY } = require('./tools/console-node.cjs');

const ELECTRON_LEG = { versions: { node: process.versions.node, electron: '45.0.0' } };
const NAME = isolation.nodeExeName(ELECTRON_LEG);
// The rig hard-links the console node. On the Electron leg an rmSync of any link of an exe is EPERM while
// any process runs that image, under any name, and other suite files run the real console node in
// parallel. So this file's cells link a PRIVATE COPY that only they (and their --version child) run: one
// copy per file, in its own temp root, removed in after(). KEY names the copy before any consoleNode().
const SHARED_NODE = fs.realpathSync(consoleNode().file);
const PRIVATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigelec108-node-'));
const PRIVATE_NODE = path.join(PRIVATE_ROOT, path.basename(SHARED_NODE));
fs.copyFileSync(SHARED_NODE, PRIVATE_NODE);
const savedKey = process.env[KEY];
process.env[KEY] = PRIVATE_NODE;
test.after(() => {
  if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
  fs.rmSync(PRIVATE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const realNode = () => fs.realpathSync(consoleNode().file);
const electronParent = (extra = {}) => ({ ...process.env, [KEY]: realNode(), ...extra });

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigelec108-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const shared = path.join(root, 'shared');
  fs.mkdirSync(shared);
  const bin = path.join(root, 'bin-electron');
  fs.mkdirSync(bin);
  const electron = path.join(bin, 'electron.exe');
  fs.writeFileSync(electron, 'stand-in electron.exe');
  let n = 0;
  const sandbox = () => { const s = path.join(root, `sandbox-${++n}`); fs.mkdirSync(s); return s; };
  const electronRig = (parent = electronParent()) => {
    const s = sandbox();
    return { s, env: withExec(electron, shared, () => isolation.rigEnv(s, parent, ELECTRON_LEG)) };
  };
  return { root, shared, electron, sandbox, electronRig };
}

const sameId = (a, b) => { const x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev && x.size === y.size; };
// binding control: a cell that linked the shared console node again fails here by name, not by EPERM later
const notShared = (file) => assert.ok(!sameId(file, SHARED_NODE), `${file} is a link of the shared console node ${SHARED_NODE}, not this file's private copy`);

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: the Electron leg passes the unchanged isolation check; its node dir is exactly the console node', (t) => {
  const { electronRig } = setup(t);
  const { s, env } = electronRig();
  // (a) the check the rig host runs passes
  assert.equal(isolation.checkIsolation(env, s, { who: 'Electron leg' }), true);
  // (b) the dir holds node only, and that node is the console node the leg chose (one hard link)
  assert.deepEqual(fs.readdirSync(env.RIG_NODE_DIR), [NAME]);
  assert.ok(sameId(path.join(env.RIG_NODE_DIR, NAME), realNode()), 'the node dir holds the console node');
  notShared(path.join(env.RIG_NODE_DIR, NAME));
  // (c) the stubs' bare `node` resolves on the rig PATH, to the rig's node dir
  const hits = env.PATH.split(path.delimiter).map((d) => path.join(d, NAME)).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  assert.ok(hits.length > 0, `no ${NAME} on the rig PATH: ${env.PATH}`);
  assert.equal(path.dirname(hits[0]).toLowerCase(), path.resolve(env.RIG_NODE_DIR).toLowerCase());
});

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: a same-version dir holding a different node is not reused (S1); a keyed dir that differs too throws by name', (t) => {
  const { shared, electronRig } = setup(t);
  const version = consoleNode().version;
  const plain = path.join(shared, `md-rig-node-${version}-${path.basename(NAME, path.extname(NAME)).toLowerCase()}`);
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, NAME), 'another install of the same version');
  const { s, env } = electronRig();
  assert.notEqual(path.resolve(env.RIG_NODE_DIR).toLowerCase(), plain.toLowerCase());
  assert.ok(path.basename(env.RIG_NODE_DIR).startsWith(`${path.basename(plain)}-`), env.RIG_NODE_DIR);
  assert.ok(sameId(path.join(env.RIG_NODE_DIR, NAME), realNode()), 'the leg runs the node it chose');
  notShared(path.join(env.RIG_NODE_DIR, NAME));
  assert.equal(fs.readFileSync(path.join(plain, NAME), 'utf8'), 'another install of the same version');
  assert.equal(isolation.checkIsolation(env, s, { who: 'Electron leg, keyed dir' }), true);
  // the keyed dir's node replaced in place: remove the link name only (never write through the hard link)
  const keyedExe = path.join(env.RIG_NODE_DIR, NAME);
  fs.rmSync(keyedExe);
  fs.writeFileSync(keyedExe, 'replaced in place');
  assert.throws(() => electronRig(), /rig: the node dir for the Electron leg's console node .* holds a different node(\.exe)?; not running a node the leg did not choose/);
});

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: (N1) a node-leg rig does not run a same-version node an Electron-leg rig seeded into the plain dir', (t) => {
  const { root, shared, sandbox } = setup(t);
  const binN = path.join(root, 'bin-node');
  fs.mkdirSync(binN);
  const nodeExe = path.join(binN, 'node.exe');
  fs.writeFileSync(nodeExe, 'stand-in node.exe (the node leg)');
  const plain = path.join(shared, `md-rig-node-${process.version}-node`);
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'node.exe'), 'seeded by an Electron-leg rig');
  const s = sandbox();
  const env = withExec(nodeExe, shared, () => isolation.rigEnv(s, process.env, { versions: { node: process.versions.node } }));
  assert.ok(path.basename(env.RIG_NODE_DIR).startsWith(`${path.basename(plain)}-`), env.RIG_NODE_DIR);
  assert.ok(sameId(path.join(env.RIG_NODE_DIR, 'node.exe'), nodeExe), 'the node leg runs its own execPath');
  assert.equal(fs.readFileSync(path.join(plain, 'node.exe'), 'utf8'), 'seeded by an Electron-leg rig');
  assert.equal(isolation.checkIsolation(env, s, { who: 'node leg, keyed dir' }), true);
});

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: teeth: electron.exe is never the rig node; no console node throws by name', (t) => {
  const { root, electron, electronRig } = setup(t);
  // (d) GUPPY_TEST_CONSOLE_NODE naming electron.exe fails by name
  assert.throws(() => electronRig(electronParent({ [KEY]: electron })), /no console node\.exe: GUPPY_TEST_CONSOLE_NODE is electron\.exe/);
  // (e) no key and no node on PATH: throws by name, no skip
  const empty = path.join(root, 'empty-path');
  fs.mkdirSync(empty);
  assert.throws(() => electronRig({ PATH: empty }), /no console node\.exe: set GUPPY_TEST_CONSOLE_NODE or put node on PATH/);
});

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: (f) the check still refuses a stray binary beside the Electron leg\'s node', (t) => {
  const { electron, electronRig } = setup(t);
  const { s, env } = electronRig();
  notShared(path.join(env.RIG_NODE_DIR, NAME));
  fs.copyFileSync(electron, path.join(env.RIG_NODE_DIR, 'electron.exe'));
  assert.throws(() => isolation.checkIsolation(env, s, { who: 'planted' }), /the node dir holds more than node: .*electron\.exe, node(\.exe)?/);
});

test('RIG-ELECTRON-LEG-NOT-ISOLATED-108: (g) nodeExeName is node(.exe) on the Electron leg and the exe name otherwise', () => {
  assert.equal(isolation.nodeExeName(ELECTRON_LEG), process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(isolation.nodeExeName({ execPath: path.join('x', 'node.exe'), versions: { node: '24.22.2' } }), 'node.exe');
  assert.equal(isolation.nodeExeName({ execPath: path.join('x', 'electron.exe'), versions: { node: '24.22.2' } }), 'electron.exe');
});
