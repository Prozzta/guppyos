'use strict';
/**
 * ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108: one real PTY child that reports the bytes it read.
 *
 * The child prints READY, echoes the first stdin chunk as BYTES:[...] and exits 0; with no input it
 * prints TIMEOUT and exits 2 after 3 s. childBytes(input) resolves with the byte array, or rejects
 * naming what the child did instead.
 *
 * The program is a parameter. A Windows GUI-subsystem program (electron.exe, also when it runs as
 * Node) is NOT attached to the pseudoconsole: its stdout and stdin are not the console, so no READY
 * comes out and no input goes in.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const pty = require('node-pty');

const CHILD = [
  "process.stdin.setRawMode?.(true); process.stdin.resume();",
  "process.stdout.write('READY\\n');",
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
    if (onSpawn) onSpawn(proc);
    let output = '';
    let ended = false;
    let wrote = false;
    const timer = setTimeout(() => finish(new Error('PTY child did not answer')), 5000);
    function finish(error, value) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* child already exited */ }
      error ? reject(error) : resolve(value);
    }
    proc.onData((data) => {
      output += data;
      const hit = /BYTES:(\[[^\n]*\])/.exec(output);
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
