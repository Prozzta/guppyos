'use strict';
/**
 * LOAD-FLAKES-178: run-tests.cjs loads this into every process of its `node --test` through
 * NODE_OPTIONS. In a test-file process (NODE_TEST_CONTEXT), before any test code runs, the file
 * joins a job of its own (file-job.cs join): every process it starts is then created inside that
 * job, and the watchdog's kill takes them all at once. The file takes this back out of NODE_OPTIONS,
 * so nothing it starts loads it again (its children are in its job already), and marks the join
 * in GUPPY_FILE_JOB_PID, only after it succeeded (bare-node-test-owner pins that with a failing
 * join exe), so the file's own join (own-job.cjs, BARE-NODE-TEST-NO-OWNER) verifies it and stops.
 */
const exe = process.env.GUPPY_FILE_JOB_EXE;
const opt = process.env.GUPPY_FILE_JOB_OPT; // the exact text run-tests added to NODE_OPTIONS
if (exe && opt && String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
  process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || '').replace(opt, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  delete process.env.GUPPY_FILE_JOB_EXE;
  delete process.env.GUPPY_FILE_JOB_OPT;
  const r = require('child_process').spawnSync(exe, ['join', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) {
    const why = (r.stderr || '').trim() || (r.error ? String(r.error) : `exit ${r.status}`);
    process.stderr.write(`[test-runner] ${process.argv[1] || 'a test file'} is not in a job of its own (${why}): a hung run of it is killed from a snapshot\n`);
  } else {
    // BARE-NODE-TEST-NO-OWNER: the file's own join (test/tools/own-job.cjs) sees this and does nothing.
    process.env.GUPPY_FILE_JOB_PID = String(process.pid);
  }
}
