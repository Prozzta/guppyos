#!/usr/bin/env node
'use strict';

// Run against the unpacked modules with the packaged Electron binary.  This is
// deliberately a separate process: a successful builder exit is not evidence
// that Electron can load the ABI-specific native addons it just shipped.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FS_HANDLE_REQUIRED_EXPORTS = Object.freeze([
  'finalPath', 'procOpen', 'procAlive', 'procClose', 'procAdopt', 'posixRename', 'posixRenameAsync', 'threadCpuMs'
]);

function missingFsHandleExports(exports) {
  return FS_HANDLE_REQUIRED_EXPORTS.filter((name) => typeof exports[name] !== 'function');
}
function deleteEnvCaseInsensitive(target, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(target)) {
    if (key.toLowerCase() === wanted) delete target[key];
  }
}
function main(electron, modules, options = {}) {
  if (!electron || !modules) {
    console.error('usage: check-cut-natives.cjs <electron.exe> <unpacked node_modules>');
    return 2;
  }
  const electronPath = path.resolve(electron);
  const modulesPath = path.resolve(modules);
  const resourcesPath = path.dirname(path.dirname(modulesPath));
  const archiveModules = path.join(resourcesPath, 'app.asar', 'node_modules');
  const fsHandleAddon = path.join(resourcesPath, 'fs-handle', 'guppy_fs_handle.node');
  const probe = [
    `const fsHandle = { exports: {} }; process.dlopen(fsHandle, ${JSON.stringify(fsHandleAddon)});`,
    `const fsHandleMissing = ${JSON.stringify(FS_HANDLE_REQUIRED_EXPORTS)}.filter((name) => typeof fsHandle.exports[name] !== 'function');`,
    "if (fsHandleMissing.length) throw new Error('CUT FS-HANDLE MISSING EXPORTS: ' + fsHandleMissing.join(', '));",
    `const pty = require(${JSON.stringify(path.join(archiveModules, 'node-pty'))});`,
    `const Database = require(${JSON.stringify(path.join(archiveModules, 'better-sqlite3'))});`,
    "if (typeof pty.spawn !== 'function') throw new Error('node-pty did not load');",
    "const db = new Database(':memory:');",
    "if (db.prepare('select 42 as n').get().n !== 42) throw new Error('better-sqlite3 query failed');",
    "db.close(); console.log('CUT NATIVES OK: fs-handle + node-pty + better-sqlite3');"
  ].join('\n');
  const env = { ...(options.env || process.env), ELECTRON_RUN_AS_NODE: '1' };
  deleteEnvCaseInsensitive(env, 'NoDefaultCurrentDirectoryInExePath');
  deleteEnvCaseInsensitive(env, 'NODE_PATH');
  deleteEnvCaseInsensitive(env, 'NODE_OPTIONS');
  const r = (options.spawn || spawnSync)(electronPath, ['-e', probe], { encoding: 'utf8', env, windowsHide: true });
  if (r.error || r.status !== 0 || !r.stdout.includes('CUT NATIVES OK')) {
    console.error('CUT NATIVES FAILED');
    if (r.error) console.error(r.error.message);
    if (r.stdout) process.stderr.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status || 1;
  }
  process.stdout.write(r.stdout);
  return 0;
}

if (require.main === module) process.exitCode = main(...process.argv.slice(2));
module.exports = { FS_HANDLE_REQUIRED_EXPORTS, missingFsHandleExports, main };
