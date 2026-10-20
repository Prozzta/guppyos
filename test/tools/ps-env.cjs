'use strict';
// TEST-PS-MODCACHE-LEAK: the env for a PowerShell child of a test. Windows PowerShell 5.1 saves its
// module analysis cache (about 10 s after a module command such as Get-CimInstance autoloads) to
// GetFolderPath(LocalApplicationData)\Microsoft\Windows\PowerShell\ModuleAnalysisCache. With
// USERPROFILE pointing at a jail that has no AppData\Local, that folder path is '' and the file lands
// RELATIVE TO THE CHILD'S CWD: the repo root (four stray Microsoft\ folders in worktree roots,
// 2026-10-15/16). LOCALAPPDATA does not move it (GetFolderPath does not read it); the
// PSModuleAnalysisCachePath variable does. So every test PowerShell gets one inside a temp folder.
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

/** `base` plus PSModuleAnalysisCachePath in a temp folder; one already set (any case) is kept. */
function psEnv(base = process.env) {
  const env = { ...base };
  if (Object.keys(env).some((k) => k.toUpperCase() === KEY.toUpperCase() && env[k])) return env;
  env[KEY] = path.join(psCacheDir(), 'ModuleAnalysisCache');
  return env;
}

module.exports = { psEnv, psCacheDir, KEY };
