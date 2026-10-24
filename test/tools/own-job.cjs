'use strict';
/**
 * BARE-NODE-TEST-NO-OWNER: a test file owns a kill-on-close job of its own, however it was started.
 *
 * run-tests.cjs puts each file in a job through NODE_OPTIONS (file-job-preload.cjs), and the
 * watchdog ends that job. A bare `node --test <file>` (or `node <file>`) typed by hand, by an IDE,
 * by a script or by another agent has no such owner: what a failing test started and never stopped
 * (a detached probe, an agent, a ping) lived on, 32 of them for 5.5 days. So every test file requires
 * this module as its FIRST statement (own-job-guard.test.cjs guards that), and the module joins the
 * process to a job of its own before any test code runs: everything the file starts is created
 * inside it (a detached child too: the job allows no breakaway), and the job's only handle lives in
 * the file's process, so when the process is gone, exited or hard-killed, the rest goes with it.
 *
 * The mark: the runner's preload sets GUPPY_FILE_JOB_PID after its join, and a process started by a
 * joined file inherits the mark with the job. The mark is a hint, not a proof (Jim r1 MINOR 1: a
 * stale or forged one, exported in a shell or passed to something outside the job, would silently
 * leave the file unowned): it is verified with `file-job check <mark> <own pid>` (the job of that
 * name exists and holds this process); a mark that does not verify is said on stderr and the file
 * joins a job of its own anyway. Not on win32 (no jobs), and when the job tool cannot be built (no
 * in-box csc), this says so on stderr once and the file runs as before: a missing owner is never a
 * failed test.
 */
const JOINED_ENV = 'GUPPY_FILE_JOB_PID';

/**
 * Join this process to a job of its own, unless a verified mark says one owns it already. `prepare`
 * builds (or finds) the job tool as run-tests.cjs does; `spawnSync` runs it; both are injected by the
 * unit test. Returns { joined, why, exe }.
 */
function joinOwnJob({ env = process.env, platform = process.platform, pid = process.pid, argv1 = process.argv[1],
  prepare = () => require('./run-tests.cjs').prepareFileJob(), spawnSync = require('node:child_process').spawnSync,
  warn = (s) => process.stderr.write(s + '\n') } = {}) {
  if (platform !== 'win32') return { joined: false, why: 'not win32', exe: null };
  const file = argv1 || 'this test file';
  let job;
  try { job = prepare() || {}; } catch (e) { job = { exe: null, why: e && e.message ? e.message : String(e) }; }
  if (!job.exe) {
    const why = job.why || 'no job tool';
    warn(`[own-job] ${file} runs in no job of its own (${why}): what a failing test starts can outlive it`);
    return { joined: false, why, exe: null };
  }
  const run = (args) => spawnSync(job.exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60_000 });
  const said = (r) => (r.stderr || '').trim() || (r.error ? String(r.error) : `exit ${r.status}`);
  const mark = env[JOINED_ENV];
  if (mark) {
    // the runner's preload joined (or an ancestor test file did): the job must exist and hold this process
    const c = run(['check', String(mark), String(pid)]);
    if (c.status === 0) return { joined: false, why: `in the job of ${mark} already`, exe: job.exe };
    warn(`[own-job] ${file}: ${JOINED_ENV}=${mark} names no job holding this process (${said(c)}): joining a job of its own`);
  }
  const r = run(['join', String(pid)]);
  if (r.status !== 0) {
    const why = said(r);
    warn(`[own-job] ${file} is not in a job of its own (${why}): what a failing test starts can outlive it`);
    return { joined: false, why, exe: job.exe };
  }
  env[JOINED_ENV] = String(pid);
  return { joined: true, why: null, exe: job.exe };
}

// On require: the join itself (a unit test of joinOwnJob passes fakes; under the runner the mark verifies).
const result = joinOwnJob();

module.exports = { JOINED_ENV, joinOwnJob, result };
