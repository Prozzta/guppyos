'use strict';
/**
 * TEST-TEMP-LEAK-UNDER-LOAD (1.1.107): a test removes its temp folder only after every process that
 * can still touch it has EXITED. Not after a fixed wait, and not by trying the remove again.
 *
 * Under the full suite (a hard-capped Job Object that freezes whole processes for 0.6-0.8 s) the old
 * teardowns raced their own children:
 * - pty-late-ready-enoent / pty-early-close-eof: the ConPTY roots (`node root.js`, cwd = the jail)
 *   were killed, but killAllAsync waits for node-pty's exit report (capped at 1.5 s, and a synthetic
 *   one after the late-READY guard), not for the process. The rmSync then hit a root still exiting
 *   (EPERM, root.js left), the catch swallowed it, and run-tests named the jail (TEMP LEAK).
 * - crash-dump-harness: the child's 'close' means the Electron MAIN exited; its own children (the
 *   Crashpad handler, the GPU and utility processes) can still be running, with the sandbox in their
 *   paths, and can write into it after the remove.
 *
 * awaitHeldExit(holds): roots this process spawned, each held by handle AT the spawn (procIdentity
 *   holdRoot with node-pty's handoff, so the pid cannot be reused). A process handle is signalled
 *   only after the process has released its handles (its cwd included). Resolves when every hold is
 *   signalled; REJECTS, naming the pids, if one still runs at capMs.
 * awaitOrphansExit(rec): the processes a child that has exited left behind (its tree, by own-procs'
 *   identity rules), waited for by handle in ONE PowerShell (the name and CreationDate are checked again
 *   once the handle is open). Resolves with the rows it waited for; REJECTS, naming them, if one still
 *   runs at capMs.
 * A reject is a test failure that names the process. The caller never swallows it.
 */
const { execFile } = require('node:child_process');
const { processTable, ownTree } = require('./own-procs.cjs');
const { psEnv } = require('./ps-env.cjs');

const CAP_MS = 30_000;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{ pid: number, hold: { alive(): boolean } }[]} holds */
async function awaitHeldExit(holds, { capMs = CAP_MS, stepMs = 20, now = Date.now } = {}) {
  const end = now() + capMs;
  for (;;) {
    const live = holds.filter((h) => h.hold.alive());
    if (!live.length) return;
    if (now() >= end) throw new Error(`await-exit: still running ${capMs} ms after the kill: pid ${live.map((h) => h.pid).join(', ')}`);
    await tick(stepMs);
  }
}

/** The PowerShell that waits, by handle, for each row that is still the same process. */
function waitScript(rows, capMs) {
  const json = JSON.stringify(rows.map((r) => ({ pid: r.pid, created: r.created, name: r.name }))).replace(/'/g, "''");
  // assigned first: PowerShell 5.1 passes ConvertFrom-Json's array down a pipeline as ONE object
  return `$ProgressPreference = 'SilentlyContinue'
$list = '${json}' | ConvertFrom-Json
$end = [DateTime]::UtcNow.AddMilliseconds(${Number(capMs)})
foreach ($t in $list) {
  try { $p = [System.Diagnostics.Process]::GetProcessById([int]$t.pid); $null = $p.Handle } catch { continue }
  $q = Get-CimInstance Win32_Process -Filter "ProcessId=$($t.pid)"
  if (-not $q -or $q.Name -ne $t.name -or ([DateTimeOffset]$q.CreationDate).ToUnixTimeMilliseconds() -ne $t.created) { continue }
  $left = [int][Math]::Max(0, ($end - [DateTime]::UtcNow).TotalMilliseconds)
  if (-not $p.WaitForExit($left)) { "LIVE $($t.pid) $($t.name)" }
}`;
}

function runPs(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: CAP_MS * 3, env: psEnv() },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * @param {{ pid: number, bornMs: number, goneBy: number }} rec the child (gone), Date.now() right after
 *   its spawn, and a time by which it was known gone (its 'close').
 */
async function awaitOrphansExit(rec, { capMs = CAP_MS, table = processTable, ps = runPs, platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const { tree } = ownTree(table(), rec);
  const rows = tree.filter((r) => r.pid !== rec.pid);
  if (!rows.length) return [];
  const live = String(await ps(waitScript(rows, capMs))).split(/\r?\n/).filter((l) => l.startsWith('LIVE '));
  if (live.length) throw new Error(`await-exit: still running ${capMs} ms after pid ${rec.pid} exited: ${live.map((l) => l.slice(5)).join(', ')}`);
  return rows;
}

module.exports = { awaitHeldExit, awaitOrphansExit, waitScript, CAP_MS };
