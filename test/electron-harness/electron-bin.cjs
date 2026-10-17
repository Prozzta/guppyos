'use strict';
/**
 * HEAVY-CPU-OPTIONS-191: the Electron a test starts.
 *
 * Outside a CPU limit it is the installed one, require('electron'). Inside a heavy job limited to
 * part of the processors (Settings, "Heavy jobs on half the processors") the harness's software
 * renderer, SwiftShader (--disable-gpu), would hang. Its marl worker threads ask for every processor
 * of the machine, the job refuses them, and the GPU process waits forever for workers that never
 * started (heavycpu/ROOTCAUSE.md; Phyllis PRIOR-ART Q3). SwiftShader reads SwiftShader.ini from the
 * folder of the executable ([Processor] AffinityMask) and then asks only for those processors. So
 * under a limit a test starts Electron from a view of its dist folder (hard links, so nothing is
 * copied when the volume allows) with that file in it, set to processors the job allows. The flags
 * and the renderer stay the same, so the pixels do too. The hardware GPU and WARP were tried
 * instead, and both miss the floor's exact texel check.
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
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
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

/** The Electron executable for a test to start. */
function harnessElectron(env = process.env) {
  const exe = require('electron');
  const mask = harnessCpuMask(env);
  return mask === null ? exe : swiftShaderView(exe, mask);
}

module.exports = { harnessElectron, harnessCpuMask, swiftShaderMask, swiftShaderView };
