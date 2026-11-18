'use strict';
// RIG-NODE-DIR-SHARED-108: the rig's shared node-only dir must never be shared by the node leg and the
// Electron leg. Electron 45 runs as node v24.22.2, the same process.version as the node leg, so a dir
// keyed by version alone got electron.exe linked in by an Electron-leg rig; every node-leg rig after
// that refused ("the node dir holds more than node"). 65 node-leg reds on 2026-11-18.
//
// The test plants the Electron leg the way it really happens: same process.version, process.execPath
// named electron.exe. Both executables are small stand-in files (only the names matter to the check),
// and the shared temp root is this test's own temp dir (GUPPY_SHARED_TEMP), so nothing real is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isolation = require('./mail-rig/isolation.cjs');

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
  const env1 = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s1, process.env));
  assert.equal(isolation.checkIsolation(env1, s1, { who: 'node leg before' }), true);
  // 2. an Electron-leg rig: same version, execPath electron.exe
  const s2 = sandbox(2);
  const env2 = withExec(exes['electron.exe'], shared, () => isolation.rigEnv(s2, process.env));
  // 3. the next node-leg rig: its node dir must hold node only
  const s3 = sandbox(3);
  const env3 = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s3, process.env));
  assert.equal(isolation.checkIsolation(env3, s3, { who: 'node leg after the Electron leg' }), true);
  assert.deepEqual(fs.readdirSync(env3.RIG_NODE_DIR), ['node.exe']);
  // the two legs got two dirs, and the Electron one holds only its own executable
  assert.notEqual(path.resolve(env2.RIG_NODE_DIR).toLowerCase(), path.resolve(env3.RIG_NODE_DIR).toLowerCase());
  assert.deepEqual(fs.readdirSync(env2.RIG_NODE_DIR), ['electron.exe']);
});

test('RIG-NODE-DIR-SHARED-108: the Electron leg first, then the node leg (a fresh floor): the node leg passes', (t) => {
  const { shared, exes, sandbox } = setup(t);
  const s1 = sandbox(1);
  withExec(exes['electron.exe'], shared, () => isolation.rigEnv(s1, process.env));
  const s2 = sandbox(2);
  const env = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s2, process.env));
  assert.equal(isolation.checkIsolation(env, s2, { who: 'node leg' }), true);
  assert.deepEqual(fs.readdirSync(env.RIG_NODE_DIR), ['node.exe']);
});

test('RIG-NODE-DIR-SHARED-108: the check itself is unchanged: a node dir holding electron.exe beside node.exe is still refused', (t) => {
  const { shared, exes, sandbox } = setup(t);
  const s1 = sandbox(1);
  const env = withExec(exes['node.exe'], shared, () => isolation.rigEnv(s1, process.env));
  fs.copyFileSync(exes['electron.exe'], path.join(env.RIG_NODE_DIR, 'electron.exe'));
  assert.throws(() => isolation.checkIsolation(env, s1, { who: 'planted' }), /the node dir holds more than node: .*electron\.exe, node\.exe/);
});
