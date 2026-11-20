'use strict';
require('./tools/own-job.cjs');
/**
 * NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: closing a terminal must never end a process outside that
 * terminal's own tree.
 *
 * node-pty 1.1.0, Windows, the non-DLL ConPTY path (lib/windowsPtyAgent.js kill): it forks a helper
 * that attaches to THE CONSOLE OF THE ROOT'S PID and lists every process on it
 * (src/win/conpty_console_list.cc: AttachConsole(pid), GetConsoleProcessList), and then calls
 * process.kill on every entry. That list is "whoever shares a console with the root", not "the
 * terminal's tree". For a console program the two are the same thing (its console is the
 * pseudoconsole). A GUI-subsystem program (electron.exe run as Node) is not put on the
 * pseudoconsole: it attaches itself to its PARENT's console, the console of the process that owns
 * the terminal. If such a root is still alive when the kill runs, the list is the owner's whole
 * console: the owner itself and everything else on it.
 *
 *   (a) the test harness (tools/pty-child.cjs childBytes): the owner is the test file, the console
 *       is the runner's shared hidden one, and the kill names every test file running at the time.
 *       Seen 2026-11-20: onbinary-drop's child started slowly under load, was alive when childBytes
 *       gave up at 5 s, and seven test files ended without exiting.
 *   (b) the product (PtyManager): kill(id) and the quit sweep the tree with taskkill FIRST, which
 *       ends the root, and then the list finds nothing. When that sweep ends nothing (it failed, or
 *       was cut at its cap) the same list kill runs with the root alive: the owner is the app's main
 *       process, and the kill names it and whatever else is on its console.
 *
 * Everything here happens in tools/console-list-kill-driver.cjs, a process on a console of its own
 * whose process.kill only records. No cell can end a process of the suite, red or green.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('./tools/test-temp.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');

if (process.platform !== 'win32') {
  require('./tools/inert.cjs').announceInert('NODEPTY-CONSOLE-LIST-KILL-SIBLINGS', "node-pty's console-list kill (AttachConsole, GetConsoleProcessList) is Windows only");
  return;
}
const { consoleNode } = require('./tools/console-node.cjs');

const DRIVER = path.join(__dirname, 'tools', 'console-list-kill-driver.cjs');
/** The driver's own work is about 40 s on a quiet machine (two 5 s give-ups, seven Electron starts). */
const DRIVER_CAP_MS = 240000;

let ran = null;
/** One driver run for the whole file; every cell reads its own case from the result. */
function driver() {
  if (ran) return ran;
  const outFile = path.join(tempDir('clk-'), 'result.json');
  ran = new Promise((resolve, reject) => {
    // windowsHide: the child gets a NEW console with no window, so nothing of the suite is on it.
    const child = spawn(consoleNode().file, [DRIVER, outFile, String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: nodeEnv(process.env) });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    const cap = setTimeout(() => { child.kill(); reject(new Error(`the driver did not end in ${DRIVER_CAP_MS} ms; its output: ${text.slice(-1500)}`)); }, DRIVER_CAP_MS);
    child.once('error', (e) => { clearTimeout(cap); reject(e); });
    child.once('close', (code) => {
      clearTimeout(cap);
      let out = null;
      try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* said below */ }
      if (!out || !out.done) { reject(new Error(`the driver ended (exit ${code}) without a full result: ${(out && out.failed) || text.slice(-1500)}`)); return; }
      resolve(out);
    });
  });
  return ran;
}
const kase = async (key) => {
  const c = (await driver()).cases[key];
  assert.ok(c, `the driver ran case ${key}`);
  return c;
};
const NOBODY = (c, what) => assert.deepEqual(c.strangers, [],
  `CLOSING A TERMINAL NAMES ONLY ITS OWN TREE: ${what}, and node-pty's kill named ${JSON.stringify(c.named)}`
  + " (driver = the process that owns the terminal, bystander = another process on the owner's console)");
/** The product control: the terminal started, its root ran, and it was on the console the cell is about. */
function built(c, { ownerConsole, sweeps }) {
  assert.equal(c.spawn, 'ok', 'PtyManager.spawn');
  assert.equal(c.up, true, 'the root ran its script before the kill');
  assert.equal(c.result === 'ok' || c.result === 'quit', true, `the kill was accepted (${c.result})`);
  assert.equal(c.closed, true, "node-pty's kill ran");
  assert.equal(c.consoleBefore.includes('root'), true, `the root is on a console before the kill (${JSON.stringify(c.consoleBefore)})`);
  assert.equal(c.consoleBefore.includes('driver'), ownerConsole,
    `before the kill the root's console ${ownerConsole ? 'is the owner process\'s own' : 'is the pseudoconsole, not the owner\'s'} (${JSON.stringify(c.consoleBefore)})`);
  if (ownerConsole) assert.equal(c.consoleBefore.includes('bystander'), true, `and the bystander is on it too (${JSON.stringify(c.consoleBefore)})`);
  if (sweeps !== null) assert.equal(c.treeSweeps, sweeps, `tree sweeps answered as "ended nothing" (${c.treeSweeps})`);
}

test('the driver is on a console of its own: no case ever lists or names this test file', async () => {
  const out = await driver();
  for (const [key, c] of Object.entries(out.cases)) {
    assert.equal(JSON.stringify(c).includes('TEST FILE'), false, `case ${key} reached the test file's own console: ${JSON.stringify(c)}`);
    assert.equal(JSON.stringify(c).includes('other('), false, `case ${key} met a process the driver did not start: ${JSON.stringify(c)}`);
  }
});

// ---- (a) the test harness ----
test('harness: a GUI-subsystem child still alive when childBytes gives up is closed without naming the test file or its siblings', async (t) => {
  const c = await kase('harnessAlive');
  assert.match(c.result, /PTY child did not answer/, 'childBytes gave up at its 5 s (the child is not on the terminal, so it never answers there)');
  assert.equal(c.closed, true, "node-pty's kill ran");
  assert.equal(c.aliveAtKill, true, 'the child was alive when the kill ran');
  // The child attaches to the owner's console as it starts. On a machine so loaded that it had not
  // run a line of its script by the give-up this is said, not failed: the rule below holds either way.
  if (!c.upAtKill) t.diagnostic('the child had not run its script when the kill came: the scenario may not be built in this run');
  NOBODY(c, 'the child of childBytes was alive at the give-up');
});
test('harness: a GUI-subsystem child that is gone when childBytes closes its terminal names nobody (pin)', async () => {
  const c = await kase('harnessGone');
  assert.match(c.result, /PTY child exited 2/, "the child ended by its own 3 s exit before childBytes' 5 s");
  assert.equal(c.aliveAtKill, false, 'the child was gone when the kill ran');
  assert.equal(c.closed, true, "node-pty's kill ran");
  assert.deepEqual(c.named, [], `a root that is gone has no console to list, and the kill named ${JSON.stringify(c.named)}`);
});

// ---- the mechanism, probed directly ----
test('a GUI-subsystem root on a terminal is on the console of the process that owns the terminal; a console root is not (control)', async () => {
  const gui = await kase('guiKill');
  assert.equal(gui.up, true, 'the electron-as-node root ran');
  assert.deepEqual([...gui.consoleBefore].sort(), ['bystander', 'driver', 'helper', 'root'],
    `the console of an electron-as-node root holds the owner process and what else is on the owner's console (${JSON.stringify(gui.consoleBefore)})`);
  const con = await kase('consoleKill');
  assert.equal(con.up, true, 'the console root ran');
  assert.deepEqual([...con.consoleBefore].sort(), ['helper', 'root'], `the console of a console root is the pseudoconsole: itself only (${JSON.stringify(con.consoleBefore)})`);
});

// ---- (b) the product ----
test("product: kill(id) of a terminal with no hold, whose root is gone and whose pid is another console's process now, does not name that console (the recycled pid is simulated)", async () => {
  const c = await kase('recycledPid');
  built(c, { ownerConsole: false, sweeps: null });
  assert.equal(c.pidNow, 'bystander', `the pid the terminal holds is the stranger's at the kill (${JSON.stringify(c)})`);
  // The tree sweep before it names the same pid: that is PTY-CLOSETREE-PIDREUSE's known no-hold gap, answered as "ended nothing" here.
  NOBODY(c, "the root was gone and its pid was a process on the owner's console");
});
test('product: kill(id) of a GUI-subsystem root names nobody when the tree sweep ends the root first (pin)', async () => {
  const c = await kase('guiKill');
  built(c, { ownerConsole: true, sweeps: 0 });
  assert.equal(c.aliveAtKill, false, 'the real taskkill ended the root before node-pty\'s kill');
  assert.deepEqual(c.named, [], `the kill named ${JSON.stringify(c.named)}`);
});
test('product: kill(id) of a GUI-subsystem root whose tree sweep ended nothing does not name the app or its console', async () => {
  const c = await kase('guiKillSweepFailed');
  built(c, { ownerConsole: true, sweeps: 2 });
  assert.equal(c.aliveAtKill, true, 'the root was alive when node-pty\'s kill ran');
  NOBODY(c, 'kill(id) ran after two tree sweeps that ended nothing');
});
test('product: the quit (killAllAsync) of a GUI-subsystem root whose tree sweep ended nothing does not name the app or its console', async () => {
  const c = await kase('guiQuitSweepFailed');
  built(c, { ownerConsole: true, sweeps: 1 });
  assert.equal(c.aliveAtKill, true, 'the root was alive when node-pty\'s kill ran');
  NOBODY(c, 'the quit ran after a tree sweep that ended nothing');
});
test('product: kill(id) of a console root names nobody outside its tree, with the tree sweep failed or not (pin)', async () => {
  const failed = await kase('consoleKillSweepFailed');
  built(failed, { ownerConsole: false, sweeps: 2 });
  NOBODY(failed, 'kill(id) of a console root ran after two tree sweeps that ended nothing');
  const swept = await kase('consoleKill');
  built(swept, { ownerConsole: false, sweeps: 0 });
  NOBODY(swept, 'kill(id) of a console root ran after a real tree sweep');
});
