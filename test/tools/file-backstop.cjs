#!/usr/bin/env node
'use strict';
/**
 * GUPPY-NODE-LTS (god 57be0d): the runner's own per-file backstop, the kill half.
 *
 * run-tests.cjs starts this beside its (blocking) `node --test`, on every platform. Each test file
 * records itself at start (file-backstop-preload.cjs: { pid, bornMs, file, name }, and { pid, exited }
 * on a normal exit). A file still running `limitMs` after its birth is killed here, and the kill is
 * written to <outJsonl> so the runner names the file and FAILS the run.
 *
 * Why: the backstop used to be `node --test --test-timeout`. Node 24 applies that to tests only, so a
 * file whose tests passed but which never exits was never killed (Node 20 killed it); the per-file
 * watchdog (win32) was then the only kill. This one depends on no `node --test` semantics.
 *
 * Order per due file: VERIFY it is still ours and alive (a file the watchdog already killed, or a
 * pid now held by another process, is left alone and not reported), RECORD it, KILL, record the
 * outcome. Recording before the kill matters: the kill ends `node --test`, the runner then stops
 * this process at once, and a row written after a slow kill could be lost.
 * win32: through the file's job (file-job.cs kill <pid> <createdMs>), else its verified tree
 * (own-procs). Elsewhere: SIGKILL to the file's pid (no process table to verify a tree with).
 * Known limit off win32 (Jim N1): only "is the pid alive" is checked, not its start time, so a pid
 * reused within the poll interval after the file exited could be signalled. The exit row the
 * preload writes on a normal exit takes the file out of the due list first, which narrows it to a
 * file that died without exiting normally; CI's ubuntu legs are short-lived runners.
 *
 * Usage: node file-backstop.cjs <runnerPid> <limitMs> <startsJsonl> <outJsonl> [jobExe]
 * It exits on its own when the runner process is gone.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

/** PURE: the start rows still running ({ pid, bornMs, file, name }), the latest start per pid. */
function liveStarts(text) {
  const live = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a torn last line: read again next tick
    if (!r || !Number.isInteger(r.pid)) continue;
    if (r.exited) live.delete(r.pid);
    else if (Number.isFinite(r.bornMs) && r.file) live.set(r.pid, { pid: r.pid, bornMs: r.bornMs, file: String(r.file), name: String(r.name || 'node.exe') });
  }
  return [...live.values()];
}

/** PURE: which of `starts` are past the backstop now and not handled yet. */
function dueStarts(starts, limitMs, now, handled = new Set()) {
  return starts.filter((s) => !handled.has(`${s.pid}:${s.bornMs}`) && now - s.bornMs > limitMs).map((s) => ({ ...s, ageMs: now - s.bornMs }));
}

/**
 * win32: is `s` still the live process it recorded? Its pid's row must have its name and a
 * CreationDate at or before bornMs (own-procs). Returns the row, or { why } when it is not ours.
 */
function verifyWin(s, { lookup = (pids) => require('./own-procs.cjs').lookupPids(pids) } = {}) {
  const row = lookup([s.pid]).find((r) => r.pid === s.pid);
  if (!row) return { why: 'gone' };
  if (String(row.name).toLowerCase() !== String(s.name).toLowerCase() || row.created > s.bornMs) return { why: 'its pid belongs to another process now' };
  return { row };
}

/** win32: the job kill, else the verified tree. Returns { by, ... } as the watchdog's killFile does. */
function killWin(s, row, { jobExe, run = spawnSync, tree = (rec) => require('./own-procs.cjs').killOwnTree(rec) } = {}) {
  if (jobExe) {
    const r = run(jobExe, ['kill', String(s.pid), String(row.created)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0) return { by: 'job' };
    if (r.status === 4) return { by: 'none', why: 'another process has the pid now' };
    if (r.status === 5) return { by: 'job', alive: 1 };
  }
  const t = tree({ pid: s.pid, bornMs: s.bornMs, name: s.name });
  return { by: 'tree', killed: (t.killed || []).length };
}

/** One pass: verify, record, kill, record the outcome, for each due file. */
function tick({ text, limitMs, now, handled, record, verify, kill }) {
  for (const d of dueStarts(liveStarts(text), limitMs, now, handled)) {
    handled.add(`${d.pid}:${d.bornMs}`);
    const v = verify(d);
    if (!v.row && v.why) continue; // already gone (the watchdog's kill, or a crash) or not ours: nothing to do
    record({ file: d.file, by: 'backstop', message: `BACKSTOP: still running ${d.ageMs} ms after it started (backstop ${limitMs} ms; the watchdog did not end it): killing it` });
    let r;
    try { r = kill(d, v.row); } catch (e) { r = { by: 'none', why: `the kill threw: ${String((e && e.message) || e).slice(0, 120)}` }; }
    record({ file: d.file, by: 'backstop', kill: r.by, message: r.by === 'none' ? `BACKSTOP: not killed: ${r.why}` : `BACKSTOP: killed through its ${r.by === 'job' ? 'job' : r.by === 'tree' ? 'process tree' : 'pid'}${r.alive ? `, but ${r.alive} process(es) still alive` : ''}` });
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

module.exports = { liveStarts, dueStarts, verifyWin, killWin, tick };

if (require.main === module) {
  const [runnerPid, limitMs, startsFile, outFile, jobExe = ''] = process.argv.slice(2);
  const runner = Number(runnerPid); const limit = Number(limitMs);
  const handled = new Set();
  const win = process.platform === 'win32';
  const verify = win ? (d) => { try { return verifyWin(d); } catch (e) { return { why: `no process table: ${String(e).slice(0, 80)}`, retry: true }; } }
    : (d) => (alive(d.pid) ? { row: { pid: d.pid } } : { why: 'gone' });
  const kill = win ? (d, row) => killWin(d, row, { jobExe: jobExe || null })
    : (d) => { process.kill(d.pid, 'SIGKILL'); return { by: 'pid' }; };
  setInterval(() => {
    if (!alive(runner)) process.exit(0);
    let text = '';
    try { text = fs.readFileSync(startsFile, 'utf8'); } catch { return; }
    tick({ text, limitMs: limit, now: Date.now(), handled,
      record: (row) => fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`),
      verify: (d) => { const v = verify(d); if (v.retry) handled.delete(`${d.pid}:${d.bornMs}`); return v; },
      kill });
  }, Math.min(5_000, Math.max(250, Math.floor(limit / 20))));
}
