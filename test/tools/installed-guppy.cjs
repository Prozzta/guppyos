'use strict';
// Find the installed Electron outside a per-test LOCALAPPDATA jail, read-only.
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');

let cached;

function wantedMajor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const m = /(\d+)\./.exec(String((pkg.devDependencies || {}).electron || ''));
  return m ? m[1] : '';
}

function find() {
  if (process.platform !== 'win32') return { skip: 'the installed app is the Windows one' };
  const local = process.env.GUPPY_SHARED_LOCALAPPDATA || process.env.LOCALAPPDATA || '';
  const exe = process.env.GUPPY_PACKAGED_EXE || (local && path.join(local, 'Programs', 'Guppy', 'Guppy.exe'));
  if (!exe) return { skip: 'no installed Guppy: GUPPY_PACKAGED_EXE and LOCALAPPDATA are both unset' };
  if (!fs.existsSync(exe)) return { skip: `no installed Guppy at ${exe}` };
  const result = child.spawnSync(exe, ['-p', 'process.versions.electron'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const electron = String(result.stdout || '').trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/.test(electron)) return { skip: `${exe} does not run as Node (exit ${result.status})` };
  if (electron.split('.')[0] !== wantedMajor()) return { skip: `${exe} is Electron ${electron}; this tree builds against Electron ${wantedMajor()}` };
  return { exe, electron };
}

function installedGuppy() {
  if (!cached) cached = find();
  return cached;
}

module.exports = { installedGuppy, find };
