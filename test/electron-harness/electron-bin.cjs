'use strict';
/**
 * Electron executable selection for the harness. CPU-rate control leaves every processor visible,
 * but SwiftShader's worker pool must always be bounded.  A plain view can stall even before a
 * cap is applied, and a live cap must never take processors away from an existing renderer.
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
    const reply = JSON.parse(execFileSync(HEAVYJOB_HELPER, ['self-query'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, env }));
    return reply?.rate > 0;
  } catch { return false; } // a focused npm-ci tree may not have the helper built yet
}

function halfCpuMask(logical = os.cpus().length) {
  return (1n << BigInt(Math.max(1, Math.floor(Math.min(logical, 64) / 2)))) - 1n;
}

function harnessCpuMask(env = process.env) {
  if (env.HARNESS_CPU_MASK !== undefined) return /^[1-9]\d*$/.test(env.HARNESS_CPU_MASK) ? BigInt(env.HARNESS_CPU_MASK) : null;
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '"$([uint64][int64][Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity) $env:NUMBER_OF_PROCESSORS"'],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: require('../tools/ps-env.cjs').psEnv(env) });
    const [mask, all] = out.trim().split(/\s+/);
    if (!/^\d+$/.test(mask ?? '') || !/^\d+$/.test(all ?? '')) return null;
    const m = BigInt(mask); let has = 0;
    for (let x = m; x; x >>= 1n) has += Number(x & 1n);
    return has > 0 && has < Number(all) ? m : null;
  } catch { return null; }
}

function swiftShaderMaskForHeavyJob(env = process.env, logical = os.cpus().length) {
  const half = halfCpuMask(logical);
  const limit = harnessCpuMask(env);
  return limit === null ? half : (limit & half) || limit;
}

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name); const dst = join(to, e.name);
    if (e.isDirectory()) linkTree(src, dst);
    else { try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); } }
  }
}

function viewReady(dir, from, sm) {
  if (!fs.existsSync(join(dir, '.complete'))) return false;
  try {
    if (!fs.readdirSync(from).every((n) => fs.existsSync(join(dir, n)))) return false;
    return sm === null || fs.readFileSync(join(dir, 'SwiftShader.ini'), 'utf8') === `[Processor]\nAffinityMask=${sm}\n`;
  } catch { return false; }
}

/** A self-healing bounded view; stale partial and broken attempts are discarded first. */
function swiftShaderView(exe, mask = null, suppliedTmp) {
  const tmp = suppliedTmp ?? (typeof mask === 'string' ? mask : require('../tools/shared-temp.cjs').sharedTemp());
  const version = require('electron/package.json').version;
  const sm = mask === null ? null : Number(mask & 0x7fffffffn);
  if (mask !== null && !sm) throw new Error(`electron-bin: the CPU mask ${mask.toString(16)} has no SwiftShader-supported processor`);
  const dir = join(tmp, 'guppy-electron-view', sm === null ? `${version}-plain` : `${version}-${sm.toString(16)}`);
  const name = basename(exe); const from = dirname(exe);
  const root = dirname(dir);
  try {
    for (const name of fs.readdirSync(root)) if (name.startsWith(`${basename(dir)}.part-`) || name.startsWith(`${basename(dir)}.broken-`)) fs.rmSync(join(root, name), { recursive: true, force: true });
  } catch { /* root does not exist yet */ }
  if (!viewReady(dir, from, sm)) {
    const part = `${dir}.part-${process.pid}`;
    linkTree(from, part);
    if (sm !== null) fs.writeFileSync(join(part, 'SwiftShader.ini'), `[Processor]\nAffinityMask=${sm}\n`);
    fs.writeFileSync(join(part, '.complete'), '');
    if (fs.existsSync(dir) && !viewReady(dir, from, sm)) {
      const stale = `${dir}.broken-${process.pid}-${Date.now()}`;
      try { fs.renameSync(dir, stale); } catch { /* another test moved it */ }
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* held files are harmless */ }
    }
    try { fs.renameSync(part, dir); } catch (e) {
      if (!viewReady(dir, from, sm)) throw e;
      fs.rmSync(part, { recursive: true, force: true });
    }
  }
  return join(dir, name);
}

function harnessElectron(env = process.env) {
  const exe = require('electron');
  return process.platform === 'win32' ? swiftShaderView(exe, swiftShaderMaskForHeavyJob(env)) : exe;
}

module.exports = { harnessElectron, cappedHeavyJob, harnessCpuMask, halfCpuMask, swiftShaderMaskForHeavyJob, swiftShaderView };
