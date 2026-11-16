'use strict';

/**
 * SUITE-LOAD-FLAKES-1027: keeps a pid from being reused while a test still names it.
 *
 * Windows hands a dead process's pid to a new process within seconds on a busy machine (measured in
 * a spawn loop: 541 of 1346 new processes got a pid that had died less than 4 s before, the soonest
 * after 147 ms). A test that lets a REAL kill reach a pid after its process has died (a mutant that
 * restores a late `taskkill /T /F` sweep, a quit that sweeps a settled session) therefore force-kills
 * whatever process got the pid: in the parallel suite, another test file or one of its children, which
 * dies with exit code 1 and no output (full runs 6 and 7: claims90-m1-compact as a whole file, then
 * a `git push` inside claims-freeze-guard).
 *
 * A pid stays allocated for as long as any handle to its process object is open. So one PowerShell
 * child opens a handle to each pid it is given (while that process is alive and known to be ours) and
 * holds them until release(). After the process dies its pid then names nothing: process.kill(pid, 0)
 * throws ESRCH and taskkill finds no process, however long the test goes on naming the pid.
 *
 * win32 only (elsewhere hold() resolves false and nothing runs).
 */
const { spawn } = require('node:child_process');
const { psEnv } = require('./ps-env.cjs');

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$held = New-Object System.Collections.ArrayList',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $id = [int]$line',
  '  try {',
  '    $p = [System.Diagnostics.Process]::GetProcessById($id)',
  '    $h = $p.Handle',   // opens the handle; the Process object keeps it open while it is referenced
  '    [void]$held.Add($p)',
  '    [Console]::Out.WriteLine("held $id")',
  '  } catch { [Console]::Out.WriteLine("miss $id") }',
  '}'
].join('\n');

/** Starts the holder. `hold(pid)` resolves true once a handle to the LIVE process `pid` is open
 *  (false: it was already gone, or not win32); `release()` ends the holder, which frees every pid. */
function pidHolder() {
  if (process.platform !== 'win32') return { hold: async () => false, release: async () => {} };
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: psEnv() });
  const waiting = new Map();   // pid -> [resolve, reject]
  let text = '';
  let err = '';
  let ended = null;
  const failAll = (why) => { for (const [, [, reject]] of waiting) reject(new Error(why)); waiting.clear(); };
  ps.stderr.on('data', (d) => { err += d; });
  ps.stdout.on('data', (d) => {
    text += d;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n')) {
      const m = /^(held|miss) (\d+)\s*$/.exec(text.slice(0, i));
      text = text.slice(i + 1);
      const w = m && waiting.get(Number(m[2]));
      if (w) { waiting.delete(Number(m[2])); w[0](m[1] === 'held'); }
    }
  });
  ps.on('error', (e) => { ended = `the pid holder did not start: ${e.message}`; failAll(ended); });
  ps.on('exit', (code) => { ended = `the pid holder exited (${code}): ${err.trim().slice(0, 300)}`; failAll(ended); });
  return {
    hold(pid) {
      return new Promise((resolve, reject) => {
        if (ended) { reject(new Error(ended)); return; }
        waiting.set(pid, [resolve, reject]);
        ps.stdin.write(`${pid}\n`);
      });
    },
    release() {
      return new Promise((resolve) => {
        if (ended) { resolve(); return; }
        ps.once('exit', () => resolve());
        ps.stdin.end();
      });
    }
  };
}

module.exports = { pidHolder };
