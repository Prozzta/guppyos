'use strict';
/**
 * HEAVY-CPU-OPTIONS-191: the Electron a test starts.
 *
 * On Windows a test always starts Electron from a view of its dist folder (hard links, so nothing is
 * copied when the volume allows) whose SwiftShader.ini keeps the harness's software renderer on the
 * processors option 2 allows. Inside a heavy job limited to part of the processors (Settings, "Heavy
 * jobs on half the processors") SwiftShader (--disable-gpu) would otherwise hang. Its marl worker threads
 * ask for every processor of the machine, the job refuses them, and the GPU process waits forever for
 * workers that never started (heavycpu/ROOTCAUSE.md; Phyllis PRIOR-ART Q3). SwiftShader reads
 * SwiftShader.ini from the folder of the executable ([Processor] AffinityMask) and then asks only for
 * those processors. The limit can be turned on while a suite runs (live apply), so the view is used
 * with no limit too: a later limit never takes a processor the workers were given (Jim MUST-1, r9).
 * The flags and the renderer stay the same, so the pixels do too. The hardware GPU and WARP were tried
 * instead, and both miss the floor's exact texel check. Elsewhere it is the installed Electron.
 */
const fs = require('node:fs');
const os = require('node:os');
const { join, dirname, basename } = require('node:path');

/**
 * This process's processor mask (BigInt) when it may use fewer logical processors than the machine
 * has, else null. Node cannot see a job's limit (os.availableParallelism() still says all of
 * them), so a PowerShell child, which inherits the job, reads it. The test runner asks once and
 * passes the answer down in HARNESS_CPU_MASK (a decimal mask, or '' for no limit).
 */
function harnessCpuMask(env = process.env) {
  if (env.HARNESS_CPU_MASK !== undefined) return /^[1-9]\d*$/.test(env.HARNESS_CPU_MASK) ? BigInt(env.HARNESS_CPU_MASK) : null;
  if (process.platform !== 'win32') return null;
  let out;
  try {
    out = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '"$([uint64][int64][Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity) $env:NUMBER_OF_PROCESSORS"'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: require('../tools/ps-env.cjs').psEnv() });
  } catch {
    return null; // unknown: the installed Electron, as before
  }
  const [mask, all] = out.trim().split(/\s+/);
  if (!/^\d+$/.test(mask ?? '') || !/^\d+$/.test(all ?? '')) return null;
  const m = BigInt(mask);
  let has = 0;
  for (let x = m; x; x >>= 1n) has += Number(x & 1n);
  return has > 0 && has < Number(all) ? m : null;
}

/**
 * The AffinityMask for SwiftShader.ini. SwiftShader reads it as a 32-bit signed int, so a mask
 * with bit 31 or higher set would be misread; the processors the job allows below bit 31 are used
 * (the half-processors option always allows the lowest ones).
 */
function swiftShaderMask(mask) {
  const m = mask & 0x7fffffffn;
  if (!m) throw new Error(`electron-bin: the CPU limit ${mask.toString(16)} allows no processor below 31, so SwiftShader cannot be kept inside it`);
  return Number(m);
}

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory()) linkTree(src, dst);
    else {
      try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
    }
  }
}

/** The view of the dist folder for this mask, made once and shared (under the temp folder). */
function swiftShaderView(exe, mask, tmp = os.tmpdir()) {
  const version = require('electron/package.json').version;
  const sm = swiftShaderMask(mask);
  const dir = join(tmp, 'guppy-electron-view', `${version}-${sm.toString(16)}`);
  const done = join(dir, '.complete');
  if (!fs.existsSync(done)) {
    const part = `${dir}.part-${process.pid}`;
    linkTree(dirname(exe), part);
    fs.writeFileSync(join(part, 'SwiftShader.ini'), `[Processor]\nAffinityMask=${sm}\n`);
    fs.writeFileSync(join(part, '.complete'), '');
    try { fs.renameSync(part, dir); } catch (e) {
      // Another test made it first: use that one. The part holds only links and plain files.
      if (!fs.existsSync(done)) throw e;
      fs.rmSync(part, { recursive: true, force: true });
    }
  }
  return join(dir, basename(exe));
}

/**
 * The processors option 2 allows: the lowest floor(n/2) logical ones, at least 1, as the helper sets
 * them (resources/heavyjob/guppy-heavyjob.cs HalfMask). Where Node sees fewer processors than the
 * helper (one processor group), the mask is a subset of the helper's, which is still inside it.
 */
function halfCpuMask(logical = os.cpus().length) {
  return (1n << BigInt(Math.max(1, Math.floor(Math.min(logical, 64) / 2)))) - 1n;
}

/** The Electron executable for a test to start. */
function harnessElectron(env = process.env) {
  const exe = require('electron');
  if (process.platform !== 'win32') return exe;
  // The processors of option 2 (a limit turned on later never takes one away), within any limit
  // already in force; a limit outside them all is used as it is.
  const limit = harnessCpuMask(env);
  const half = halfCpuMask();
  return swiftShaderView(exe, limit === null ? half : (limit & half) || limit);
}

module.exports = { harnessElectron, harnessCpuMask, halfCpuMask, swiftShaderMask, swiftShaderView };
