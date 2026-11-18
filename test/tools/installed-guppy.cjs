'use strict';
/**
 * The installed Guppy, for the tests that prove a thing in Electron as Node.
 *
 * run-tests gives every test file a LOCALAPPDATA of its own (temp-jail-preload.cjs), so
 * %LOCALAPPDATA%\Programs\Guppy\Guppy.exe is never there under the suite. This is the one place
 * that finds the app: GUPPY_PACKAGED_EXE if it is set, else the app under the real local app-data
 * folder the preload kept (read only), else under LOCALAPPDATA when the file runs on its own.
 *
 * The app is used only if it runs as Node and its Electron major is the one this tree builds
 * against (package.json devDependencies.electron): the addon and the claims are for that Electron.
 *
 * installedGuppy() -> { exe, electron } or { skip: '<reason>' }. A test passes `skip` to node:test
 * as its skip reason, so a machine with no usable app says so by name and does not go red. It
 * never writes anything.
 */
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');

let cached;

function wantedMajor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const v = String((pkg.devDependencies || {}).electron || '');
  const m = /(\d+)\./.exec(v);
  return m ? m[1] : '';
}

/** The real local app-data folder: the one the preload kept, else this process's own. Read only. */
function localAppData() {
  return process.env.GUPPY_SHARED_LOCALAPPDATA || process.env.LOCALAPPDATA || '';
}

function find() {
  const env = process.env;
  if (process.platform !== 'win32') return { skip: 'the installed app is the Windows one' };
  const given = env.GUPPY_PACKAGED_EXE;
  const local = localAppData();
  const exe = given || (local ? path.join(local, 'Programs', 'Guppy', 'Guppy.exe') : '');
  if (!exe) return { skip: 'no installed Guppy: GUPPY_PACKAGED_EXE and LOCALAPPDATA are both unset' };
  if (!fs.existsSync(exe)) return { skip: `no installed Guppy at ${exe}` };
  const r = child.spawnSync(exe, ['-p', 'process.versions.electron'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const electron = String(r.stdout || '').trim();
  if (r.status !== 0 || !/^\d+\.\d+\.\d+/.test(electron)) return { skip: `${exe} does not run as Node (exit ${r.status}): ${String(r.stderr || r.error || '').trim().slice(0, 200)}` };
  const want = wantedMajor();
  if (electron.split('.')[0] !== want) return { skip: `${exe} is Electron ${electron}; this tree builds against Electron ${want}` };
  return { exe, electron };
}

function installedGuppy() {
  if (!cached) cached = find();
  return cached;
}

module.exports = { installedGuppy, find };
