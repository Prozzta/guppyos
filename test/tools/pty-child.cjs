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
const pty = require('node-pty');
const loadTs = require('../load-ts.cjs');
const { armEarlyKill } = loadTs('src/main/pty.ts');

/** From the kill to the conout worker's exit node-pty takes 1 s (its flush interval). */
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

/** The electron binary of this checkout (the running one under the Electron leg). */
function electronExe() {
  return process.versions.electron ? process.execPath : require('electron');
}

/**
 * @param input what the test writes once the child said READY
 * @param opts.file the child program; opts.env its env; opts.onSpawn(proc) sees the terminal first
 */
function childBytes(input, { file = process.execPath, env = process.env, onSpawn } = {}) {
  // An electron.exe without this key is a real app with a window: never start one from here.
  if (isElectronExe(file)) assert.equal(env.ELECTRON_RUN_AS_NODE, '1', `${file} runs as Node only (ELECTRON_RUN_AS_NODE=1 in its env)`);
  return new Promise((resolve, reject) => {
    const proc = pty.spawn(file, ['-e', CHILD], {
      name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(), env
    });
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
    function finish(error, value) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* child already exited */ }
      if (!workerGone) { error ? reject(error) : resolve(value); return; }
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
      ).finally(() => clearTimeout(watchdog));
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
