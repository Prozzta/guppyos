#!/usr/bin/env node
'use strict';

// A Windows cut must not inherit Claude's cwd-search hardening: node-pty's
// winpty build invokes batch helpers while npm ci runs electron-rebuild.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (process.argv.includes('--print-plan')) {
  console.log(JSON.stringify({ npmCi: ['ci'], inheritedNoDefaultCurrentDirectoryInExePath: Object.keys(env).some((key) => key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') }));
  process.exit(0);
}
function run(command, args) {
  // npm.cmd is a batch shim; unlike the real Electron/node executables it
  // needs cmd.exe mediation when spawned from Node on Windows.
  const r = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: command === npm && process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status || 1);
}
function check() {
  run(process.execPath, [
    path.join('scripts', 'release-markers.cjs'),
    'node_modules',
    path.join('resources', 'models')
  ]);
  run(process.execPath, [
    path.join('scripts', 'release-markers.cjs'),
    path.join('dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules'),
    path.join('dist', 'win-unpacked', 'resources', 'models')
  ]);
  run(process.execPath, [
    path.join('scripts', 'check-cut-natives.cjs'),
    path.join('dist', 'win-unpacked', 'Guppy.exe'),
    path.join('dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules')
  ]);
}
if (process.argv.includes('--install-only')) {
  // Evidence/recovery mode: the same plain install the full cut starts with.
  run(npm, ['ci']);
} else if (process.argv.includes('--dist-only')) {
  run(npm, ['run', 'dist:win:raw']);
  check();
} else {
  // Keep this literal plain npm ci: --ignore-scripts makes a deceptively
  // successful cut that omits the better-sqlite3 rebuild.
  run(npm, ['ci']);
  run(npm, ['run', 'dist:win:raw']);
  check();
  // CHANGELOG-HEADINGS-GATE: a cut keeps every released CHANGELOG section of the last release.
  run(process.execPath, [
    path.join('scripts', 'verify-changelog-history.cjs'),
    path.join('dist', 'win-unpacked', 'resources', 'app.asar')
  ]);
}
