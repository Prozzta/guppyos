'use strict';
/**
 * ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108: a Node that a test may run INSIDE a PTY.
 *
 * Under the Electron leg process.execPath is electron.exe, a Windows GUI-subsystem program. Windows
 * does not attach such a program to a pseudoconsole (also when it runs as Node): its stdout and stdin
 * are not the console, so a PTY child that must talk over the console needs a console-subsystem
 * node.exe. consoleNode() finds one, in this order:
 *   1. the env key GUPPY_TEST_CONSOLE_NODE (the leg launch sets it; a set key is never passed over:
 *      a bad one fails by name);
 *   2. this process itself, when it is a plain Node (the Node leg: the child is the runner's own exe);
 *   3. node on PATH.
 * It is never electron.exe and never an unchecked process.execPath. The result is asserted: on
 * Windows the PE subsystem is console (3), it is not electron.exe, and `--version` runs. With none
 * found it throws by name; callers do not skip.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KEY = 'GUPPY_TEST_CONSOLE_NODE';
const SUBSYSTEM_GUI = 2;
const SUBSYSTEM_CONSOLE = 3;

/** The Subsystem field of a PE file's optional header (2 = GUI, 3 = console). */
function peSubsystem(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) < 64 || dos.toString('latin1', 0, 2) !== 'MZ') throw new Error(`not a PE file: ${file}`);
    const at = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(24 + 70);
    if (fs.readSync(fd, pe, 0, pe.length, at) < pe.length || pe.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`not a PE file: ${file}`);
    return pe.readUInt16LE(24 + 68);   // optional header starts after the 4-byte signature and the 20-byte COFF header
  } finally { fs.closeSync(fd); }
}

function isElectronName(file) { return /^electron(\.exe)?$/i.test(path.basename(file)); }

/** First `node` on PATH, or null. */
function nodeOnPath(env, platform) {
  const raw = platform === 'win32' ? (env.PATH ?? env.Path ?? '') : (env.PATH ?? '');
  const name = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of raw.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    const file = path.join(dir.replace(/^"|"$/g, ''), name);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/**
 * FLAKE-RIG-ELECTRON-LEG-CONSOLE-NODE-VERSION-FAIL-108: what a failed `--version` run left behind. Node's
 * own message is "Command failed: <cmd>" plus stderr; with an empty stderr that says nothing about whether
 * the child was killed, could not set up its console, or exited by itself. The exit code is given in hex
 * too (Windows status codes are read that way; -1 and 4294967295 are both 0xFFFFFFFF).
 */
function failedRun(e, ms) {
  const CUT = 400;
  const text = (v) => {
    if (v === undefined || v === null) return 'none';
    const s = String(v);
    return s.length > CUT ? `${JSON.stringify(s.slice(0, CUT))} (${s.length} chars, first ${CUT})` : JSON.stringify(s);
  };
  const code = Number.isInteger(e.status) ? `${e.status} (0x${(e.status >>> 0).toString(16).toUpperCase().padStart(8, '0')})` : 'none';
  return `exit code ${code}, signal ${e.signal || 'none'}, error code ${e.code || 'none'}, after ${ms} ms, stderr ${text(e.stderr)}, stdout ${text(e.stdout)}`;
}

/**
 * Step 2 of the same card: who the run's journals say was asked to end the child. `pid` is the one Node puts
 * on the execFileSync error (none when the child never started), `sinceMs` is taken before the spawn. The
 * text is own-procs' own: the stops rows (handed to a stop script) and the kills rows (a run file's
 * process.kill / taskkill) that carry the pid, or that none of N does; '' outside a run. Those two journals
 * are all it reads: a child ended by any other path leaves no row. own-procs is loaded here, on the failure
 * path only, so the files that load this module do not get it in their load path.
 */
function journalsNaming(pid, sinceMs) {
  if (!Number.isInteger(pid)) return '';
  try {
    const P = require('./own-procs.cjs');
    return `${P.stopsNaming(pid)}${P.killsNaming(pid, sinceMs)}`;
  } catch { return ''; }
}

/** Throws, naming `from`, unless `file` is a console-subsystem Node that runs. Returns its version. */
function assertConsoleNode(file, from, { platform = process.platform, run = execFileSync } = {}) {
  if (isElectronName(file)) throw new Error(`no console node.exe: ${from} is electron.exe (${file}), a GUI-subsystem program that a PTY does not attach`);
  if (platform === 'win32') {
    const sub = peSubsystem(file);
    if (sub !== SUBSYSTEM_CONSOLE) throw new Error(`no console node.exe: ${from} (${file}) has PE subsystem ${sub}${sub === SUBSYSTEM_GUI ? ' (GUI)' : ''}, not 3 (console): a PTY does not attach it`);
  }
  let version;
  const startedMs = Date.now();
  try { version = String(run(file, ['--version'], { encoding: 'utf8', windowsHide: true, env: process.env })).trim(); } catch (e) {
    throw new Error(`no console node.exe: ${from} (${file}) did not run --version: ${e.message} [pid ${Number.isInteger(e.pid) ? e.pid : 'none'}, started ${new Date(startedMs).toISOString()}, ${failedRun(e, Date.now() - startedMs)}]${journalsNaming(e.pid, startedMs)}`);
  }
  if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error(`no console node.exe: ${from} (${file}) answered --version with ${JSON.stringify(version.slice(0, 60))}`);
  return version;
}

/**
 * @returns {{ file: string, version: string, from: string }}
 * Options are for the unit pin; a test calls consoleNode() bare.
 */
function consoleNode({ env = process.env, execPath = process.execPath, versions = process.versions, platform = process.platform, run = execFileSync } = {}) {
  const check = (file, from) => ({ file, version: assertConsoleNode(file, from, { platform, run }), from });
  if (env[KEY]) return check(env[KEY], `${KEY}`);
  if (!versions.electron) return check(execPath, 'this Node');
  const onPath = nodeOnPath(env, platform);
  if (onPath) return check(onPath, 'node on PATH');
  throw new Error(`no console node.exe: set ${KEY} or put node on PATH`);
}

module.exports = { consoleNode, assertConsoleNode, peSubsystem, nodeOnPath, KEY };
