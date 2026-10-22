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
// (shared-temp.cjs), made per process and removed at exit.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'PSModuleAnalysisCachePath';
let dir = null;

/** This process's cache folder (made on first use, removed at exit). */
function psCacheDir() {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-psmac-'));
    const made = dir;
    process.on('exit', () => { try { fs.rmSync(made, { recursive: true, force: true }); } catch { /* still in use: temp */ } });
  }
  return dir;
}

let tempDir = null;
const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'];

/** This process's temp folder for its PowerShell children (made on first use, removed at exit). */
function psTempDir() {
  if (!tempDir) {
    tempDir = fs.mkdtempSync(path.join(require('./shared-temp.cjs').sharedTemp(), 'guppy-pstemp-'));
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

module.exports = { psEnv, psCacheDir, psTempDir, KEY, TEMP_KEYS };
