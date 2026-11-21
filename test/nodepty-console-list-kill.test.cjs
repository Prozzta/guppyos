'use strict';
require('./tools/own-job.cjs');
require('./tools/mutant-runner-helper.cjs').gate(__filename);
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
 *       Fixed in the harness: it spawns with useConptyDll by default, as the app does, and where a
 *       test asks for the inbox conhost it ends its child by pid before node-pty's kill.
 *   (b) the product (PtyManager): since PTY-CONHOST-ORPHAN-OWNER-DEATH every terminal runs on the
 *       bundled OpenConsole (useConptyDll), where node-pty's kill asks for no console list at all.
 *       That is pinned in pty-kill-pid-identity.test.cjs ("NO BY-PID SWEEP AFTER THE CLOSE"). The
 *       cells here measure the outcome: what the kill names, for a console root and for a pid that
 *       is a stranger's by the time of the kill.
 *
 * NOT COVERED HERE: a kill that meets a GUI-subsystem root still alive. On OpenConsole such a
 * terminal reports its exit while the root lives, so no kill reaches it with a session
 * (PTY-GUI-ROOT-EXIT-EARLY-UNTRACKED). Whether that is acceptable is not ruled, so it is not pinned.
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
/**
 * The driver's own work was about 15 s on a quiet machine (two 5 s give-ups, three Electron starts,
 * three console roots). The five late-exit cases add a 5 s give-up each, and a harness that waits
 * for its child to be off the console adds up to its 8 s teardown wait in a case.
 */
const DRIVER_CAP_MS = 240000;

let ran = null;
/** The one folder of this file: tempDir removes it when the file ends. The driver's result and work files are in it. */
let ownDir = null;
/** One driver run for the whole file; every cell reads its own case from the result. */
function driver() {
  if (ran) return ran;
  ownDir = tempDir('clk-');
  const outFile = path.join(ownDir, 'result.json');
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
  + " (driver = the process that owns the terminal, bystander = another process on the owner's console)"
  // Read from a second handle on the root as node-pty's kill was entered. false: the close came before
  // the exit. true: the root had exited and its console still listed it.
  + (c.rootExitedAtClose === undefined ? '' : `; the root had exited at that close: ${c.rootExitedAtClose}`));
/** The product control: the terminal started, its root ran, and it was on the console the cell is about. */
function built(c, { ownerConsole, sweeps }) {
  assert.equal(c.spawn, 'ok', 'PtyManager.spawn');
  assert.equal(c.up, true, 'the root ran its script before the kill');
  assert.equal(c.result, 'ok', `the kill was accepted (${JSON.stringify(c)})`);
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

// ---- (a) the test harness, on the inbox conhost (the host where node-pty's kill lists the console) ----
test('harness, inbox conhost: a GUI-subsystem child still alive when childBytes gives up is ended by its pid first, and the close names nobody', async () => {
  const c = await kase('harnessAlive');
  assert.match(c.result, /PTY child did not answer/, 'childBytes gave up at its 5 s (the child is not on the terminal, so it never answers there)');
  assert.equal(c.closed, true, "node-pty's kill ran");
  assert.equal(c.swept, true, "node-pty's kill asked for the console list: this is the host with the list path");
  NOBODY(c, 'the child of childBytes was alive at the give-up');
  assert.equal(c.endedByPid, true, 'childBytes ended its child by pid before node-pty\'s kill');
  assert.deepEqual(c.consoleAfter, [], `the child is gone after the close (its console holds ${JSON.stringify(c.consoleAfter)})`);
});
test('harness, inbox conhost: the by-pid end names the pid only while the hold on the child says it runs, and the hold is released after the kill', async () => {
  const c = await kase('harnessAlive');
  assert.equal(c.holdTaken, true, 'childBytes took a hold on its child at the spawn (procIdentity holdRoot)');
  assert.equal(c.holdAskedBeforeKill, true, "the hold was asked before node-pty's kill, and said the child runs");
  assert.equal(c.holdReleasedAfterKill, true, "the hold was released, and only after node-pty's kill");
  const gone = await kase('harnessHoldSaysGone');
  assert.equal(gone.holdTaken, true, 'childBytes took a hold on its child at the spawn');
  assert.equal(gone.holdAskedBeforeKill, false, 'the hold was asked and answered "exited" (the driver answers for it)');
  // The guarantee first: a by-pid end that should not have happened has ended the child by the time
  // the control below samples it, so the control read first would name the harness, not the fault.
  assert.equal(gone.endedByPid, undefined, 'A PID IS NAMED ONLY WHILE IT IS HELD: the hold said the child had exited, and childBytes still ended that pid');
  // The child is in fact alive and on the owner's console, for good. The harness reads the console
  // list of the pid before any close, so it no longer closes this terminal at all.
  assert.deepEqual(gone.cleanupKills, ['held, running'], "control: the child itself was alive all along (the driver's own hold ended it after the case)");
  assert.equal(gone.closed, false, "NO CLOSE WHILE THE CHILD IS ON THE OWNER'S CONSOLE: the console of the pid still listed the child, and node-pty's kill ran");
  assert.deepEqual(gone.named, [], `no console list was taken by node-pty, so nothing was named (${JSON.stringify(gone.named)})`);
  assert.match(gone.result, /^PTY teardown: the child has exited and the console of its pid still lists it/, 'the failure names the child that is still on its console');
  assert.equal(gone.workerExited, true, 'the conout worker was ended by the harness: the test file can end');
  assert.equal(gone.holdReleasedAfterKill, false, "the hold was released with no kill by node-pty before it (there was none)");
  assert.equal(gone.holdReleasedAfterWorkerExit, true, 'the hold was released, and only after the refusal had ended the terminal\'s worker');
});
test('harness: a GUI-subsystem child that is gone when childBytes closes its terminal names nobody (pin)', async () => {
  const c = await kase('harnessGone');
  assert.match(c.result, /PTY child exited 2/, "the child ended by its own 3 s exit before childBytes' 5 s");
  assert.equal(c.aliveAtKill, false, 'the child was gone when the kill ran');
  assert.equal(c.closed, true, "node-pty's kill ran");
  assert.deepEqual(c.named, [], `a root that is gone has no console to list, and the kill named ${JSON.stringify(c.named)}`);
});
// FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY. A kill by pid returns at once; the child leaves
// its console later. Seen 2026-11-21 under suite load: the harness closed the terminal in the same
// turn as its kill by pid, node-pty's list helper attached while the dying child was still on the
// owner's console, and the close named the bystander and the driver. The driver makes that order
// exact, with no load: the kill reaches the child only after node-pty's list has answered, or 2 s on.
test('harness, inbox conhost: a kill by pid that takes effect late is waited for, and the close then names nobody', async () => {
  const c = await kase('harnessDiesSlowly');
  assert.match(c.result, /PTY child did not answer/, 'childBytes gave up at its 5 s');
  assert.equal(c.endedByPid, true, 'control: childBytes sent its kill by pid');
  assert.match(String(c.killDelivered), /^late: /, `control: the driver held that kill back and delivered it late (${c.killDelivered})`);
  assert.equal(c.closed, true, "node-pty's kill ran");
  NOBODY(c, 'the child of childBytes was still alive when its terminal was closed, the kill by pid not yet in effect');
  assert.equal(c.rootExitedAtClose, true, "THE CLOSE WAITS FOR THE EXIT: the child had not exited when node-pty's kill was entered");
  assert.match(c.killDelivered, /node-pty had asked for no console list by then/, `no console list was asked for while the child lived (${c.killDelivered})`);
  assert.equal(c.holdReleasedAfterKill, true, "the hold was released, and only after node-pty's kill");
  assert.deepEqual(c.consoleAfter, [], `the child is gone after the close (its console holds ${JSON.stringify(c.consoleAfter)})`);
});
// An exit is not yet "off the console": the process handle is signalled, and the console drops the
// process from its list in its own time. The hold cannot see that, so the harness asks the list.
test('harness, inbox conhost: a child whose hold says "exited" while its console still lists it is waited off the console first', async () => {
  const c = await kase('harnessExitedStillOnConsole');
  assert.match(c.result, /PTY child did not answer/, 'childBytes gave up at its 5 s');
  assert.equal(c.endedByPid, true, 'control: childBytes sent its kill by pid');
  assert.match(String(c.killDelivered), /^late: /, `control: the driver held that kill back, so the child stayed on the console (${c.killDelivered})`);
  assert.equal(c.closed, true, "node-pty's kill ran");
  NOBODY(c, 'the hold said the child had exited, and the child was still on the console of its pid');
  assert.match(c.killDelivered, /node-pty had asked for no console list by then/, `no console list was asked for by node-pty while the child was on the console (${c.killDelivered})`);
  assert.deepEqual(c.consoleAfter, [], `the child is gone after the close (its console holds ${JSON.stringify(c.consoleAfter)})`);
});
// The same window with no kill by pid before it: the child ended by itself, the hold says so at the
// first ask, and the console of its pid lists it for 2 s more.
test('harness, inbox conhost: a child that exited by itself and is still on its console is waited off the console before the close', async () => {
  const c = await kase('harnessExitedByItselfStillOnConsole');
  assert.match(c.result, /PTY child did not answer/, 'childBytes gave up at its 5 s');
  assert.equal(c.holdAskedBeforeKill, false, 'control: the hold answered "exited" at the first ask (the driver answers for it)');
  assert.equal(c.endedByPid, undefined, 'A PID IS NAMED ONLY WHILE IT IS HELD: the hold said the child had exited, and childBytes still ended that pid');
  assert.equal(c.leavesArmed, true, 'control: the driver kept the child on the console past that first ask');
  assert.equal(c.closed, true, "node-pty's kill ran");
  NOBODY(c, 'the hold said at the first ask that the child had exited, and the child was still on the console of its pid');
  assert.match(String(c.leftConsole), /^left its console 2000 ms after/, `control: the child left the console only when the driver ended it (${c.leftConsole})`);
  assert.equal(c.rootExitedAtClose, true, "THE CLOSE WAITS UNTIL THE CHILD IS OFF THE CONSOLE: the child was still running when node-pty's kill was entered");
  assert.deepEqual(c.consoleAfter, [], `the child is gone after the close (its console holds ${JSON.stringify(c.consoleAfter)})`);
});
test('harness, inbox conhost: a child that never exits after the kill by pid fails by name, its terminal is not closed, and the file can still end', async () => {
  const c = await kase('harnessNeverExits');
  assert.equal(c.endedByPid, true, 'control: childBytes sent its kill by pid');
  assert.equal(c.closed, false, "NO CLOSE WHILE THE CHILD MAY BE ON THE OWNER'S CONSOLE: the hold never said the child had exited, and node-pty's kill ran");
  assert.match(c.result, /^PTY teardown: the child never exited/, 'the failure names the child that never exited');
  assert.deepEqual(c.named, [], `no console list was taken, so nothing was named (${JSON.stringify(c.named)})`);
  assert.equal(c.workerExited, true, 'the conout worker was ended by the harness: the test file can end');
});
test('harness, inbox conhost: with no hold on the child no pid is named and the terminal is not closed; the failure says so and the file can still end', async () => {
  const c = await kase('harnessNoHold');
  assert.equal(c.holdTaken, false, 'control: childBytes got no hold on its child (the driver answers for a missing addon)');
  assert.equal(c.endedByPid, undefined, 'A PID IS NAMED ONLY WHILE IT IS HELD: nothing held the child, and childBytes ended that pid');
  assert.equal(c.closed, false, "NO BLIND CLOSE: nothing held the child's pid, and node-pty's kill listed its console");
  assert.match(c.result, /^PTY teardown: no hold on the child/, 'the failure names the missing hold');
  assert.deepEqual(c.named, [], `no console list was taken, so nothing was named (${JSON.stringify(c.named)})`);
  assert.equal(c.workerExited, true, 'the conout worker was ended by the harness: the test file can end');
  assert.deepEqual(c.cleanupKills, ['held, running'], "control: the child was alive all along (the driver's own hold ended it)");
});
// The driver's own cleanup (not node-pty's kill, not the harness's): it used to end every root by its
// number when a case was over, also a root dead for a second or more, whose number can be any
// process's on the machine by then.
test("the driver's own cleanup names a root only while its own hold says the root runs: no kill goes to the pid of a root that is gone", async () => {
  const out = await driver();
  for (const [key, c] of Object.entries(out.cases)) {
    assert.equal((c.cleanupKills || []).includes('DEAD PID'), false,
      `NO KILL IS SENT TO A DEAD ROOT'S PID: case ${key} sent one after the driver's hold said the root had exited (${JSON.stringify(c.cleanupKills)}, ${c.cleanup})`);
    assert.notEqual(c.cleanup, 'no hold: no pid named', `control: the driver held the root of case ${key} (the hold addon is built)`);
  }
  const { harnessAlive, harnessHoldSaysGone, harnessGone } = out.cases;
  assert.deepEqual(harnessHoldSaysGone.cleanupKills, ['held, running'], 'control: a root still running at the cleanup is ended, by pid, under the hold');
  assert.equal(harnessAlive.cleanup, 'gone: no pid named', 'the root that childBytes ended is not named again');
  assert.equal(harnessGone.cleanup, 'gone: no pid named', 'the root that exited by itself is not named');
});

// The runner fails a run in which a test file leaves an entry in its temp folder. The driver is a
// process of this file, so what it writes must be in the folder this file removes.
test('the driver leaves nothing in the temp folder: its work files are in the one folder this file removes', async () => {
  const out = await driver();
  for (const key of Object.keys(out.cases)) {
    assert.equal(fs.existsSync(path.join(ownDir, `${key}.up`)), true,
      `THE DRIVER WORKS IN THE FOLDER THIS FILE REMOVES: the marker of case ${key} is not in ${ownDir} (it holds ${JSON.stringify(fs.readdirSync(ownDir))}), so the driver made a folder of its own that nobody removes`);
  }
});

// ---- the mechanism, probed directly ----
test('a GUI-subsystem root on a terminal is on the console of the process that owns the terminal; a console root is not (control)', async () => {
  const gui = await kase('guiProbe');
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
test('product: kill(id) of a console root names nobody outside its tree, with the tree sweep failed or not (pin)', async () => {
  const failed = await kase('consoleKillSweepFailed');
  built(failed, { ownerConsole: false, sweeps: 2 });
  NOBODY(failed, 'kill(id) of a console root ran after two tree sweeps that ended nothing');
  const swept = await kase('consoleKill');
  built(swept, { ownerConsole: false, sweeps: 0 });
  NOBODY(swept, 'kill(id) of a console root ran after a real tree sweep');
});
