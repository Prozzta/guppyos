#!/usr/bin/env node
/**
 * TEST-RUNNER-FILE-TIMEOUT (1.1.76), win32: the per-file TREE kill.
 *
 * run-tests.cjs starts this beside its (blocking) `node --test`. It polls the process table, finds
 * each test-file process under that `node --test`, and when one has run past the limit it kills the
 * file's WHOLE process tree (`taskkill /T /F`, while the parent links are still intact) and records
 * the file. node --test's own `--test-timeout` (the backstop, set a little later) kills only the
 * file's process: a ConPTY conhost is not in node's kill-on-close job, so it outlived the file (the
 * rc/1.1.76 gate hang: a PTY killed before its first output). This kills it with the file.
 *
 * Usage: node file-watchdog.cjs <runnerPid> <limitMs> <outJsonl> [pollMs]
 * It exits on its own when the runner process is gone.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

/** Parse PowerShell's ConvertTo-Json rows ({ProcessId, ParentProcessId, Name, CommandLine, CreationDate:"/Date(ms)/"}). */
function parseRows(json) {
  let rows;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  return rows.map((r) => {
    const m = /Date\((-?\d+)/.exec(String(r.CreationDate || ''));
    return { pid: r.ProcessId, ppid: r.ParentProcessId, name: String(r.Name || ''), cmd: String(r.CommandLine || ''), startedAt: m ? Number(m[1]) : NaN };
  });
}

/** The test file a `node --test` child is running, from its command line (null if none). */
function fileOf(cmd) {
  const q = /"([^"]+\.test\.cjs)"/i.exec(cmd);   // a quoted path (it may hold spaces)
  if (q) return q[1];
  const m = /([^\s"']+\.test\.cjs)\b/i.exec(cmd);
  return m ? m[1] : null;
}

/**
 * PURE: which test-file processes to kill. `procs` is the process table, `runnerPid` the
 * run-tests.cjs process. The file processes are the node children of the runner's `node --test`
 * child that run a *.test.cjs; one is due when it has run longer than `limitMs`.
 */
function dueFiles(procs, runnerPid, limitMs, now) {
  const kids = (pid) => procs.filter((p) => p.ppid === pid);
  const nodeTest = kids(runnerPid).filter((p) => /node(\.exe)?$/i.test(p.name) && /--test\b/.test(p.cmd));
  const due = [];
  for (const nt of nodeTest) {
    for (const f of kids(nt.pid)) {
      const file = fileOf(f.cmd);
      if (!file || !Number.isFinite(f.startedAt)) continue;
      if (now - f.startedAt > limitMs) due.push({ pid: f.pid, file, ageMs: now - f.startedAt });
    }
  }
  return due;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function snapshot() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return parseRows(out);
}

module.exports = { parseRows, fileOf, dueFiles };

if (require.main === module) {
  const [runnerPid, limitMs, outFile, pollMs = '30000'] = process.argv.slice(2);
  const runner = Number(runnerPid); const limit = Number(limitMs); const poll = Number(pollMs);
  const killed = new Set();
  const tick = () => {
    if (!alive(runner)) process.exit(0);
    let procs;
    try { procs = snapshot(); } catch { return; }   // one missed poll is not fatal
    for (const d of dueFiles(procs, runner, limit, Date.now())) {
      if (killed.has(d.pid)) continue;
      killed.add(d.pid);
      try { execFileSync('taskkill', ['/T', '/F', '/PID', String(d.pid)], { stdio: 'ignore', windowsHide: true, timeout: 30_000 }); } catch { /* already gone */ }
      try { fs.appendFileSync(outFile, `${JSON.stringify({ file: d.file, message: `killed with its process tree after ${d.ageMs} ms (limit ${limit} ms)`, by: 'watchdog' })}\n`); } catch { /* noop */ }
    }
  };
  setInterval(tick, poll);
}
