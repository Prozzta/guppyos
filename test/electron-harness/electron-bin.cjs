'use strict';
/**
 * Electron executable selection for the harness. CPU-rate control leaves every processor visible,
 * but SwiftShader's worker pool must still be kept within a capped job's CPU share.  An uncapped
 * job keeps c1e8c5e7's plain view.
 */
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { join, dirname, basename } = require('node:path');

const HEAVYJOB_HELPER = join(__dirname, '..', '..', 'resources', 'heavyjob', 'bin', 'guppy-heavyjob.exe');

function cappedHeavyJob(env = process.env) {
  if (env.GUPPY_HEAVY_CPU_CAP === '1') return true;
  if (env.GUPPY_HEAVY_CPU_CAP === '0' || process.platform !== 'win32') return false;
  try {
    const reply = JSON.parse(execFileSync(HEAVYJOB_HELPER, ['self-query'], { encoding: 'utf8', windowsHide: true, env }));
    return reply?.rate > 0;
  } catch { return false; } // a focused npm-ci tree may not have the helper built yet
}

function halfCpuMask(logical = os.cpus().length) {
  return (1n << BigInt(Math.max(1, Math.floor(Math.min(logical, 64) / 2)))) - 1n;
}

function swiftShaderMaskForHeavyJob(env = process.env, logical = os.cpus().length) {
  return cappedHeavyJob(env) ? halfCpuMask(logical) : null;
}

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

/** A self-healing view; a mask writes SwiftShader.ini, null keeps the uncapped plain view. */
function swiftShaderView(exe, mask = null, suppliedTmp) {
  const tmp = suppliedTmp ?? (typeof mask === 'string' ? mask : require('../tools/shared-temp.cjs').sharedTemp());
  const version = require('electron/package.json').version;
  const sm = mask === null ? null : Number(mask & 0x7fffffffn);
  if (mask !== null && !sm) throw new Error(`electron-bin: the CPU mask ${mask.toString(16)} has no SwiftShader-supported processor`);
  const dir = join(tmp, 'guppy-electron-view', sm === null ? `${version}-plain` : `${version}-${sm.toString(16)}`);
  const name = basename(exe); const from = dirname(exe);
  if (!viewReady(dir, from)) {
    const part = `${dir}.part-${process.pid}`;
    linkTree(from, part);
    if (sm !== null) fs.writeFileSync(join(part, 'SwiftShader.ini'), `[Processor]\nAffinityMask=${sm}\n`);
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

function harnessElectron(env = process.env) {
  const exe = require('electron');
  return process.platform === 'win32' ? swiftShaderView(exe, swiftShaderMaskForHeavyJob(env)) : exe;
}

module.exports = { harnessElectron, cappedHeavyJob, halfCpuMask, swiftShaderMaskForHeavyJob, swiftShaderView };
