'use strict';
/**
 * FS-CONTAINMENT-TOCTOU: build the handle-path addon (resources/fs-handle/guppy-fs-handle.c) for the
 * installed Electron, the same toolchain electron-rebuild uses for node-pty (@electron/node-gyp against
 * the Electron headers in ~/.electron-gyp), into resources/fs-handle/bin, which electron-builder ships
 * as <resources>/fs-handle. Built from source on every install, locally and in the release job; no
 * prebuilt binary is committed. It is plain N-API, so the same file also loads in the Node that runs
 * the tests.
 *
 * Linux needs no addon (src/main/fs.ts reads /proc/self/fd), so there it only makes the empty folder.
 * Anywhere else a failed build fails the install: the app refuses every confined file access when the
 * addon is missing, so a build that "succeeds" without it would ship a file browser that cannot open
 * anything.
 */
const { mkdirSync, copyFileSync, rmSync, statSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'resources', 'fs-handle');
const OUT_DIR = join(SRC_DIR, 'bin');
const NAME = 'guppy_fs_handle.node';

mkdirSync(OUT_DIR, { recursive: true });
if (process.platform === 'linux') {
  console.log('[build-fs-handle] Linux uses /proc/self/fd: skipped');
  process.exit(0);
}

const electronVersion = require('electron/package.json').version;
const gyp = join(dirname(require.resolve('@electron/node-gyp/package.json')), 'bin', 'node-gyp.js');
const args = [
  gyp, 'rebuild',
  `--target=${electronVersion}`,
  `--arch=${process.env.npm_config_arch || process.arch}`,
  '--dist-url=https://electronjs.org/headers',
  `--devdir=${join(homedir(), '.electron-gyp')}`
];
const r = spawnSync(process.execPath, args, { cwd: SRC_DIR, stdio: 'inherit', windowsHide: true });
if (r.status !== 0) {
  console.error(`[build-fs-handle] node-gyp failed (${r.status ?? r.error})`);
  process.exit(1);
}
const OUT = join(OUT_DIR, NAME);
copyFileSync(join(SRC_DIR, 'build', 'Release', NAME), OUT);
// The intermediates (MSBuild projects, obj, logs) hold the build machine's user folder; only the
// binary is kept, and only bin/ is shipped.
rmSync(join(SRC_DIR, 'build'), { recursive: true, force: true });
console.log(`[build-fs-handle] ${OUT} for Electron ${electronVersion} (${statSync(OUT).size} bytes)`);
