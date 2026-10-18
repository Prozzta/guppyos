#!/usr/bin/env node
/**
 * TEST-RUNNER-FILE-TIMEOUT (1.1.76), win32: the per-file TREE kill.
 *
 * run-tests.cjs starts this beside its (blocking) `node --test`. It polls the process table, finds
 * each test-file process under that `node --test`, and when one has run past the limit it kills the
 * file's WHOLE process tree (own-procs.cjs: verified pids, while the parent links are still intact) and records
 * the file. node --test's own `--test-timeout` (the backstop, set a little later) kills only the
 * file's process: a ConPTY conhost is not in node's kill-on-close job, so it outlived the file (the
 * rc/1.1.76 gate hang: a PTY killed before its first output). This kills it with the file.
 *
 * LOAD-FLAKES-178: with a job tool (file-job.cs; each file joined its own job at start) the kill is
 * that job's, atomic; the snapshot's tree is the fallback when a file has no job.
 *
 * Usage: node file-watchdog.cjs <runnerPid> <limitMs> <outJsonl> [pollMs] [jobExe]
 * It exits on its own when the runner process is gone.
 */
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const own = require('./own-procs.cjs');

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
  // TEST-GLOB-PID-RECYCLE: a child is created at or after its parent (a pid is reused, and an older
  // process keeps the ParentProcessId of a parent long gone).
  const kids = (parent) => procs.filter((p) => p.ppid === parent.pid && p.startedAt >= parent.startedAt);
  const runner = procs.find((p) => p.pid === runnerPid);
  if (!runner) return [];
  const nodeTest = kids(runner).filter((p) => /node(\.exe)?$/i.test(p.name) && /--test\b/.test(p.cmd));
  const due = [];
  for (const nt of nodeTest) {
    for (const f of kids(nt)) {
      const file = fileOf(f.cmd);
      if (!file || !Number.isFinite(f.startedAt)) continue;
      if (now - f.startedAt > limitMs) due.push({ pid: f.pid, file, ageMs: now - f.startedAt });
    }
  }
  return due;
}

/**
 * Act on the due files: RECORD each one as due, THEN kill its tree, THEN record what the kill did. The order matters: the kill ends the
 * file, `node --test` then returns, and the runner stops this watchdog at once; a record written
 * after a slow `taskkill` (a loaded machine) could be lost with it, leaving a failed run that names
 * no file (the 1.1.76 final gate #4, round 3/a). A due file has overrun the limit, so it is named
 * whether or not the kill still finds it.
 */
function killDue(due, { killed, record, kill, outcome = () => {} }) {
  for (const d of due) {
    if (killed.has(d.pid)) continue;
    killed.add(d.pid);
    try { record(d); } catch { /* noop */ }
    // Jim NIT-1: the first row says only that the file is due; what the kill did is written after
    // it (by job / tree / none), so a recycled pid is never logged as killed.
    let r;
    try { r = kill(d.pid); } catch (e) { r = { by: 'none', why: `the kill threw: ${String(e && e.message || e).slice(0, 120)}` }; }
    try { outcome(d, r || { by: 'none', why: 'no result' }); } catch { /* noop */ }
  }
}

/** The row written AFTER a due file's kill: what was done, never more. */
function outcomeRow(d, r, limit) {
  const by = r.by;
  let message;
  if (by === 'none') message = `not killed: ${r.why || 'nothing to kill'}`;
  else if (r.alive) message = `killed through its ${by === 'job' ? 'job' : 'process tree'}, but ${r.alive} process(es) still alive after 5 s`;
  else message = `killed through its ${by === 'job' ? 'job' : 'process tree'} after ${d.ageMs} ms (limit ${limit} ms)`;
  return { file: d.file, message, by: 'watchdog', kill: by, ...(r.alive ? { alive: r.alive } : {}) };
}

/** The tree of a due file, from the same snapshot (each link created at or after its parent), killed
 *  pid by pid, each one only while it still has the name and CreationDate it had in the snapshot. Not
 *  `taskkill /T`: it follows ParentProcessId alone (TEST-GLOB-PID-RECYCLE). */
function killTree(procs, pid, deps) {
  const rows = procs.filter((p) => Number.isFinite(p.startedAt)).map((p) => ({ pid: p.pid, ppid: p.ppid, created: p.startedAt, name: p.name }));
  const root = rows.find((r) => r.pid === pid);
  if (!root) return { killed: [], skipped: [] };
  return own.killVerified([root, ...own.treeOf(rows, root)], deps);
}

/**
 * LOAD-FLAKES-178: kill a due file through its own job (file-job.cs, joined by the file's preload
 * before any test code ran). TerminateJobObject takes every process in it at once, whenever it was
 * born; the snapshot's tree misses a child born after the snapshot (an orphan ping kept the file's
 * temp folder in use: EBUSY). The tool checks that the pid is still the process the snapshot saw.
 * Falls back to the snapshot's tree only when there is no job for the file. Returns how it went.
 */
function killFile(procs, pid, { jobExe, run = spawnSync, tree = killTree } = {}) {
  const row = procs.find((p) => p.pid === pid);
  if (jobExe && row && Number.isFinite(row.startedAt)) {
    const r = run(jobExe, ['kill', String(pid), String(row.startedAt)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0) return { by: 'job' };
    if (r.status === 4) return { by: 'none', why: 'another process has the pid now' };
    if (r.status === 5) { const m = /alive (\d+)/.exec(String(r.stdout || '')); return { by: 'job', alive: m ? Number(m[1]) : -1 }; }
  }
  return { by: 'tree', ...tree(procs, pid) };
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function snapshot() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  return parseRows(out);
}

module.exports = { parseRows, fileOf, dueFiles, killDue, outcomeRow, killTree, killFile, snapshot };

if (require.main === module) {
  const [runnerPid, limitMs, outFile, pollMs = '30000', jobExe = ''] = process.argv.slice(2);
  const runner = Number(runnerPid); const limit = Number(limitMs); const poll = Number(pollMs);
  const killed = new Set();
  const tick = () => {
    if (!alive(runner)) process.exit(0);
    let procs;
    try { procs = snapshot(); } catch { return; }   // one missed poll is not fatal
    killDue(dueFiles(procs, runner, limit, Date.now()), {
      killed,
      record: (d) => fs.appendFileSync(outFile, `${JSON.stringify({ file: d.file, message: `over the limit after ${d.ageMs} ms (limit ${limit} ms): killing it`, by: 'watchdog' })}\n`),
      kill: (pid) => killFile(procs, pid, { jobExe }),
      outcome: (d, r) => fs.appendFileSync(outFile, `${JSON.stringify(outcomeRow(d, r, limit))}\n`)
    });
  };
  setInterval(tick, poll);
}
