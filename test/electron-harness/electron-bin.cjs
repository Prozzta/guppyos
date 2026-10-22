'use strict';
/**
 * Electron executable selection for the harness. CPU-rate control deliberately leaves every
 * processor visible; do not manufacture an affinity view here or teach the runner a smaller CPU
 * count. A plain linked view remains for the existing view self-heal coverage.
 */
const fs = require('node:fs');
const { join, dirname, basename } = require('node:path');

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name); const dst = join(to, e.name);
    if (e.isDirectory()) linkTree(src, dst);
    else { try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); } }
  }
}

function viewReady(dir, from) {
  if (!fs.existsSync(join(dir, '.complete'))) return false;
  try { return fs.readdirSync(from).every((n) => fs.existsSync(join(dir, n))); } catch { return false; }
}

/** A self-healing plain view. The middle argument is retained only for old test callers. */
function swiftShaderView(exe, ignored, suppliedTmp) {
  const tmp = suppliedTmp ?? (typeof ignored === 'string' ? ignored : require('../tools/shared-temp.cjs').sharedTemp());
  const version = require('electron/package.json').version;
  const dir = join(tmp, 'guppy-electron-view', `${version}-plain`);
  const name = basename(exe); const from = dirname(exe);
  if (!viewReady(dir, from)) {
    const part = `${dir}.part-${process.pid}`;
    linkTree(from, part);
    fs.writeFileSync(join(part, '.complete'), '');
    if (fs.existsSync(dir) && !viewReady(dir, from)) {
      const stale = `${dir}.stale-${process.pid}-${Date.now()}`;
      try { fs.renameSync(dir, stale); } catch { /* another test moved it */ }
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* held files are harmless */ }
    }
    try { fs.renameSync(part, dir); } catch (e) {
      if (!viewReady(dir, from)) throw e;
      fs.rmSync(part, { recursive: true, force: true });
    }
  }
  return join(dir, name);
}

function harnessElectron() {
  const exe = require('electron');
  return process.platform === 'win32' ? swiftShaderView(exe) : exe;
}

module.exports = { harnessElectron, swiftShaderView };
