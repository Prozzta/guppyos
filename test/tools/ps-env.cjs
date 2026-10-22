'use strict';
// TEST-PS-MODCACHE-LEAK: the env for a PowerShell child of a test. Windows PowerShell 5.1 saves its
// module analysis cache (about 10 s after a module command such as Get-CimInstance autoloads) to
// GetFolderPath(LocalApplicationData)\Microsoft\Windows\PowerShell\ModuleAnalysisCache. With
// USERPROFILE pointing at a jail that has no AppData\Local, that folder path is '' and the file lands
// RELATIVE TO THE CHILD'S CWD: the repo root (four stray Microsoft\ folders in worktree roots,
// 2026-10-15/16). LOCALAPPDATA does not move it (GetFolderPath does not read it); the
// PSModuleAnalysisCachePath variable does. So every test PowerShell gets one inside a temp folder.
//
// PS-POLICY-TEMP-LEAK: PowerShell also writes __PSScriptPolicyTest_*.ps1/.psm1 to its temp folder
// (GetTempPath: TMP, then TEMP) at start-up and deletes them only if it gets that far; one killed or
// cut short leaves them (test-runner-glob's temp jail, 1.1.98 final sweep). So a test PowerShell also
// gets a temp folder of its own OUTSIDE the file's temp jail, under the real temp folder
// (shared-temp.cjs), made per process and removed at exit. A process killed before its exit handler
// runs leaves its folder there: the folder carries the pid, and the next psTempDir() and the end of
// a run-tests run remove the folders of dead pids (sweepPsTempDirs).
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'PSModuleAnalysisCachePath';
let dir = null;

/** This process's cache folder: guppy-psmac-<pid>-*, under the real temp folder like psTempDir
 *  (PS-POLICY-PRODUCT-TEMP: in os.tmpdir() it sat in the file's temp jail, and a killed process left
 *  it there), made on first use (sweeping dead processes' folders first), removed at exit. */
function psCacheDir() {
  if (!dir) {
    const root = require('./shared-temp.cjs').sharedTemp();
    sweepPsTempDirs(root);
    dir = fs.mkdtempSync(path.join(root, `guppy-psmac-${process.pid}-`));
    const made = dir;
    process.on('exit', () => { try { fs.rmSync(made, { recursive: true, force: true }); } catch { /* still in use: temp */ } });
  }
  return dir;
}

let tempDir = null;
const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'];
const PS_TEMP_RE = /^guppy-ps(?:temp|mac)-(\d+)-/;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Removes the guppy-pstemp-<pid>-* and guppy-psmac-<pid>-* folders in `root` whose process is gone: a test process killed
 *  before its exit handler ran (run-tests ending a hung file) leaves its folder in the real temp
 *  folder, where no temp jail looks. Returns the names removed. */
function sweepPsTempDirs(root = require('./shared-temp.cjs').sharedTemp(), { alive = pidAlive } = {}) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return removed; }
  for (const n of names) {
    const m = PS_TEMP_RE.exec(n);
    if (!m || Number(m[1]) === process.pid || alive(Number(m[1]))) continue;
    try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); removed.push(n); } catch { /* in use: next sweep */ }
  }
  return removed;
}

/** This process's temp folder for its PowerShell children: guppy-pstemp-<pid>-*, made on first use
 *  (sweeping dead processes' folders first), removed at exit. */
function psTempDir() {
  if (!tempDir) {
    const root = require('./shared-temp.cjs').sharedTemp();
    sweepPsTempDirs(root);
    tempDir = fs.mkdtempSync(path.join(root, `guppy-pstemp-${process.pid}-`));
    const made = tempDir;
    process.on('exit', () => { try { fs.rmSync(made, { recursive: true, force: true }); } catch { /* still in use: temp */ } });
  }
  return tempDir;
}

/**
 * `base` plus PSModuleAnalysisCachePath in a temp folder (one already set, in any case, is kept)
 * and TEMP/TMP/TMPDIR at psTempDir() (any spelling in `base` is replaced). `temp: false` leaves the
 * temp folder alone: only for run-tests' env for the whole run, whose files get their own temp jail.
 */
function psEnv(base = process.env, { temp = true } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!temp || !TEMP_KEYS.includes(k.toUpperCase())) env[k] = v;
  if (temp) for (const k of TEMP_KEYS) env[k] = psTempDir();
  if (Object.keys(env).some((k) => k.toUpperCase() === KEY.toUpperCase() && env[k])) return env;
  env[KEY] = path.join(psCacheDir(), 'ModuleAnalysisCache');
  return env;
}

module.exports = { psEnv, psCacheDir, psTempDir, sweepPsTempDirs, KEY, TEMP_KEYS };
