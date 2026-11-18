'use strict';
/**
 * FS-CONTAINMENT-TOCTOU: build the handle-path addon (resources/fs-handle/guppy-fs-handle.c) for the
 * installed Electron, the same toolchain electron-rebuild uses for node-pty (node-gyp against
 * the Electron headers in ~/.electron-gyp), into resources/fs-handle/bin, which electron-builder ships
 * as <resources>/fs-handle. Built from source on every install, locally and in the release job; no
 * prebuilt binary is committed. It is plain N-API, so the same file also loads in the Node that runs
 * the tests.
 *
 * Built on Linux too (FS-REMOVE-READDIR-GAP-108): src/main/fs.ts still reads /proc/self/fd there for
 * the handle path, but the link-safe tree delete (removeTree) is this addon on every platform, and
 * there is no JS walk to fall back to.
 * A failed build fails the install: the app refuses every confined file access (Windows, macOS) and
 * every tree delete (everywhere) when the addon is missing, so a build that "succeeds" without it
 * would ship a file browser that cannot open anything and a cleanup that keeps every folder.
 */
const { mkdirSync, copyFileSync, rmSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
// WORKTREE-NATIVE-BUILD-GAP: the sources' digest is taken before the build and recorded in the
// (gitignored, unshipped) root .worktree-setup.json after it succeeds, so the test runner reads this
// binary as fresh until those sources change.
const stampBuilt = require('./worktree-setup.cjs').buildStamp(ROOT, 'fs-handle');
const SRC_DIR = join(ROOT, 'resources', 'fs-handle');
const OUT_DIR = join(SRC_DIR, 'bin');
const NAME = 'guppy_fs_handle.node';

mkdirSync(OUT_DIR, { recursive: true });

const electronVersion = require('electron/package.json').version;
// electron-rebuild 4 uses the upstream node-gyp package. Resolving its executable from the
// dependency tree keeps this build on the same toolchain as the native modules it ships with.
const gyp = require.resolve('node-gyp/bin/node-gyp.js');
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
stampBuilt();
console.log(`[build-fs-handle] ${OUT} for Electron ${electronVersion} (${statSync(OUT).size} bytes)`);
