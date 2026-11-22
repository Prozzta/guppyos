'use strict';
/**
 * ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108: one real PTY child that reports the bytes it read.
 *
 * The child prints READY:<its stdout and stdin are TTYs>, echoes the first stdin chunk as BYTES:[...] and exits 0; with no input it
 * prints TIMEOUT and exits 2 after 3 s. childBytes(input) resolves with the byte array, or rejects
 * naming what the child did instead.
 *
 * The program is a parameter. A Windows GUI-subsystem program (electron.exe, also when it runs as
 * Node) is NOT attached to the pseudoconsole: its stdout and stdin are not the console, so no READY
 * comes out and no input goes in. Tests that need the bytes pass consoleNode().file (console-node.cjs).
 *
 * Teardown: the terminal is armed with the app's armEarlyKill, and the promise settles only once the
 * conout worker thread has exited. Without the arm, node-pty never kills a terminal that printed
 * nothing, the worker stays, and the test file never ends (every Electron leg waited out the 30 min
 * file limit). A teardown that does not finish is a named failure.
 *
 * TEST-ONLY. This teardown always ends in an explicit kill, so a green run here says nothing about
 * what the app frees when a terminal exits by itself: PtyManager's exit path calls no kill and leaves
 * the worker and the input socket (PTY-NATURAL-EXIT-NO-KILL-LEAK). A test that claims to cover the
 * app's own teardown must go through PtyManager, not through this helper.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const pty = require('node-pty');
const loadTs = require('../load-ts.cjs');
const { armEarlyKill } = loadTs('src/main/pty.ts');
const { holdRoot, rootHandoff } = loadTs('src/main/procIdentity.ts');

/**
 * From the kill to the conout worker's exit node-pty takes 1 s (its flush interval). On the inbox
 * conhost the same cap is also given, before that kill, to the wait for a child ended by its pid.
 */
const TEARDOWN_CAP_MS = 8000;

const CHILD = [
  "process.stdin.setRawMode?.(true); process.stdin.resume();",
  "process.stdout.write('READY:' + (process.stdout.isTTY === true && process.stdin.isTTY === true) + '\\n');",
  "process.stdin.once('data', (data) => { process.stdout.write('BYTES:' + JSON.stringify([...data]) + '\\n'); process.exit(0); });",
  "setTimeout(() => { process.stdout.write('TIMEOUT\\n'); process.exit(2); }, 3000);"
].join(' ');

/** electron.exe, by name or because this process is one. */
function isElectronExe(file) {
  return /^electron(\.exe)?$/i.test(path.basename(file)) || (file === process.execPath && Boolean(process.versions.electron));
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Is `child` on the OWNER's console? The owner is this process, the one that runs childBytes and
 * owns the terminal: the console that node-pty's list kill must not reach is this one. It is asked
 * through this process's own pid (console-list-helper.cjs, a fork: a process has one console), so
 * the answer does not depend on whether the child's pid can still be attached to.
 *
 * { listed, list } only for a list that proves it is the owner's: the call did not fail and the
 * list holds the owner itself. Everything else is { why }: no answer, which says nothing about the
 * child. A failed call, an empty list, a list without the owner and a helper that ended without a
 * message are all "no answer". (The list of the CHILD's pid, taken with node-pty's own helper, was
 * read here before: that helper answers [] for any failure, and [] was read as "the child is gone".)
 *
 * Not covered, and safe: a console-subsystem child on this host is on the pseudoconsole, never on
 * the owner's console. The owner's list never holds it, so its terminal is closed as soon as its
 * hold says it has exited, with no wait for the pseudoconsole to drop it. node-pty's list kill
 * then reaches the pseudoconsole's processes only, which are the terminal's own.
 */
function onOwnerConsole(child) {
  return new Promise((resolve) => {
    const agent = cp.fork(path.join(__dirname, 'console-list-helper.cjs'), [String(process.pid)]);
    let got = null;
    agent.on('message', (m) => { got = m; });
    agent.on('exit', () => resolve(ownerAnswer(got, child)));
    agent.on('error', (e) => resolve({ why: `the list helper did not start (${e && e.message})` }));
  });
}
function ownerAnswer(m, child) {
  if (!m) return { why: 'the list helper ended without a message' };
  if (m.error) return { why: m.error };
  const list = m.consoleProcessList;
  if (!Array.isArray(list) || !list.includes(process.pid)) return { why: `the list does not hold the owner itself (${JSON.stringify(list)})` };
  return { listed: list.includes(child), list };
}

/**
 * Resolves once a child is off the owner's console: first its hold says it has exited, then a list
 * of the owner's console no longer holds it. The second step is not the first again: an exit
 * signals the process handle, and the console drops the process from its list in its own time. So
 * it is asked for every child, also one that exited by itself (`byPid` false: the hold said so at
 * once and no kill was sent). Only a list that is the owner's counts (see onOwnerConsole): no answer
 * is asked again. Both steps share one cap; at the cap it rejects with the step that did not come,
 * and for a list that never came with the reason the last ask gave.
 */
async function offConsole(pid, hold, byPid) {
  const end = Date.now() + TEARDOWN_CAP_MS;
  const since = byPid ? 'after its kill by pid' : 'after its hold first said so';
  while (hold.alive()) {
    if (Date.now() >= end) throw new Error(`the child never exited after its kill by pid (its hold still says it runs, ${TEARDOWN_CAP_MS} ms on), so its terminal is not closed`);
    await sleep(25);
  }
  for (;;) {
    const got = await onOwnerConsole(pid);
    if (got.listed === false) return;
    if (Date.now() >= end) {
      throw new Error(got.listed
        ? `the child has exited and the console of its pid still lists it ${TEARDOWN_CAP_MS} ms ${since} (the owner's console: ${JSON.stringify(got.list)}), so its terminal is not closed`
        : `the owner's own console could not be listed: ${got.why} (the child has exited, ${TEARDOWN_CAP_MS} ms ${since}), so its terminal is not closed`);
    }
    await sleep(25);
  }
}

/** The electron binary of this checkout (the running one under the Electron leg). */
function electronExe() {
  return process.versions.electron ? process.execPath : require('electron');
}

/**
 * @param input what the test writes once the child said READY
 * @param opts.file the child program; opts.env its env; opts.onSpawn(proc) sees the terminal first
 * @param opts.prelude JS run in the child before its script (a test uses it to make a child that is
 *   on the PTY say it is not)
 * @param opts.host Windows only. 'openconsole' (the default): the bundled OpenConsole, the host the
 *   app runs every terminal on. 'inbox': the Windows inbox conhost, which the app no longer uses; a
 *   test that asks for it says why.
 */
function childBytes(input, { file = process.execPath, env = process.env, onSpawn, prelude = '', host = 'openconsole' } = {}) {
  // An electron.exe without this key is a real app with a window: never start one from here.
  if (isElectronExe(file)) assert.equal(env.ELECTRON_RUN_AS_NODE, '1', `${file} runs as Node only (ELECTRON_RUN_AS_NODE=1 in its env)`);
  assert.equal(host === 'openconsole' || host === 'inbox', true, `host is 'openconsole' or 'inbox', not ${JSON.stringify(host)}`);
  const inbox = process.platform === 'win32' && host === 'inbox';
  return new Promise((resolve, reject) => {
    const proc = pty.spawn(file, ['-e', `${prelude}${CHILD}`], {
      name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(), env,
      // NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: as the app spawns every terminal (PtyManager.spawn,
      // PTY-CONHOST-ORPHAN option A). On the bundled OpenConsole node-pty's kill asks for no
      // console list.
      useConptyDll: process.platform === 'win32' && !inbox
    });
    // Inbox path only: held in the same turn as the spawn, as the app holds every root
    // (PTY-KILL-PID-IDENTITY). While it is held the pid is this child's and nobody else's. Null
    // with no addon: finish() then names no pid and closes nothing, and fails by name.
    const hold = inbox ? holdRoot(proc.pid, process.platform, rootHandoff(proc)) : null;
    const releaseHold = () => { if (hold) hold.release(); };
    // As the app does for every terminal (PtyManager.spawn): node-pty alone holds kill() back until
    // the terminal's first data chunk, and a child that never prints is then never killed.
    if (process.platform === 'win32') assert.equal(armEarlyKill(proc), true, 'armEarlyKill fits this node-pty');
    if (onSpawn) onSpawn(proc);
    // node-pty frees the conout worker thread only from its kill (1 s after it), never from the exit.
    const worker = proc._agent?._conoutSocketWorker?._worker ?? null;
    if (process.platform === 'win32') assert.ok(worker, 'the terminal has a conout worker (node-pty 1.1.0 internals)');
    const workerGone = worker && new Promise((res) => worker.once('exit', res));
    let output = '';
    let ended = false;
    let wrote = false;
    const timer = setTimeout(() => finish(new Error('PTY child did not answer')), 5000);
    /** No close: the failure is named, and the worker is ended here so the test file can still end. */
    const refuse = (why, error) => {
      const named = new Error(`PTY teardown: ${why}${error ? `; after: ${error.message}` : ''}`);
      const done = () => { releaseHold(); reject(named); };
      worker.terminate().then(done, done);
    };
    function finish(error, value) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (!inbox) { close(error, value); return; }
      // NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: on the inbox conhost node-pty's kill ends every process
      // on the console of the child's pid. An electron.exe child is on THIS test file's console, the
      // one the runner shares between its files: a child still alive here took the sibling files
      // with it. So the child is ended by its pid first, and the terminal is closed only once a
      // list of this process's own console no longer holds the child.
      // The pid is named only while the hold says the child runs. With no hold nothing says whose
      // the pid is, and nothing can be waited on: no pid is named and no console is listed.
      if (!hold) {
        refuse('no hold on the child (the procIdentity addon is not built), so its terminal on the inbox conhost is not closed:'
          + ' the close ends every process on the console of a pid, and nothing says that pid is still the child\'s', error);
        return;
      }
      const byPid = hold.alive();
      if (byPid) { try { process.kill(proc.pid); } catch { /* gone already */ } }
      // FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY: that kill returns at once, and the child
      // is on the owner's console until it has gone. The terminal is closed only after that. A child
      // that had exited by itself is waited off the console too: its exit alone does not say so.
      offConsole(proc.pid, hold, byPid).then(() => close(error, value), (stuck) => refuse(stuck.message, error));
    }
    function close(error, value) {
      try { proc.kill(); } catch { /* child already exited */ }
      // The hold goes after the last kill that names the pid: node-pty's kill lists the console
      // from a helper it forks, so not before the teardown has settled.
      if (!workerGone) { releaseHold(); error ? reject(error) : resolve(value); return; }
      // Settle only once the terminal is torn down: a kill that did not run fails HERE, by name,
      // instead of leaving a thread that keeps the test file from ending.
      let watchdog;
      Promise.race([workerGone, new Promise((_, rej) => {
        watchdog = setTimeout(() => rej(new Error(
          'PTY teardown: the conout worker of the terminal never exited, so the kill did not run'
          + ' (node-pty holds kill() back until a first data chunk; armEarlyKill runs it at once)'
          + (error ? `; after: ${error.message}` : ''))), TEARDOWN_CAP_MS);
      })]).then(
        () => { error ? reject(error) : resolve(value); },
        (stuck) => worker.terminate().then(() => reject(stuck))   // named red, and the file still ends
      ).finally(() => { clearTimeout(watchdog); releaseHold(); });
    }
    proc.onData((data) => {
      output += data;
      const hit = /BYTES:(\[[^\n]*\])/.exec(output);
      // Asserted, not assumed: the child itself says its stdout and stdin are the console.
      if (hit && !output.includes('READY:true')) finish(new Error(`PTY child is not on the console (its stdout/stdin isTTY is not true): ${output}`));
      if (hit) finish(null, JSON.parse(hit[1]));
      if (output.includes('TIMEOUT')) finish(new Error('PTY child timed out'));
      if (!wrote && output.includes('READY')) { wrote = true; proc.write(input); }
    });
    proc.onExit(({ exitCode }) => {
      if (!/BYTES:/.test(output)) finish(new Error(`PTY child exited ${exitCode}: ${output}`));
    });
  });
}

module.exports = { childBytes, electronExe, isElectronExe, CHILD };
