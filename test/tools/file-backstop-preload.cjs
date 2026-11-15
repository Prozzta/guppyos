'use strict';
/**
 * GUPPY-NODE-LTS (god 57be0d): the runner's own per-file backstop, the record half.
 *
 * run-tests.cjs loads this into its `node --test` through NODE_OPTIONS. In a test-file process
 * (NODE_TEST_CONTEXT child) it appends one row to GUPPY_FILE_BACKSTOP: { pid, bornMs, file, name },
 * where bornMs is a time taken while this process is alive (own-procs' rule: the process created at
 * or before it under this pid and name is this one). On a normal exit it appends { pid, exited }.
 * file-backstop.cjs reads the rows and kills a file still running past the backstop.
 *
 * It takes itself back out of NODE_OPTIONS (as file-job-preload does), so a process the file starts
 * is not recorded as a file of the run. The backstop no longer rests on `node --test --test-timeout`:
 * from Node 22/24 that times out TESTS only, and a file whose tests passed but which never exits
 * was never killed (Node 20 killed it at the timeout).
 */
const out = process.env.GUPPY_FILE_BACKSTOP;
const opt = process.env.GUPPY_FILE_BACKSTOP_OPT; // the exact text run-tests added to NODE_OPTIONS
if (out && opt && String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
  process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || '').replace(opt, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  delete process.env.GUPPY_FILE_BACKSTOP;
  delete process.env.GUPPY_FILE_BACKSTOP_OPT;
  const fs = require('fs');
  const pid = process.pid;
  // own-procs.bornNow(), inline: this runs in every file, so it loads nothing it does not need.
  const bornMs = Math.round(Date.now() - process.uptime() * 1000);
  const name = require('path').basename(process.execPath);
  try { fs.appendFileSync(out, `${JSON.stringify({ pid, bornMs, file: process.argv[1] || '', name })}\n`); } catch { /* the watchdog still covers it */ }
  process.on('exit', () => { try { fs.appendFileSync(out, `${JSON.stringify({ pid, exited: true })}\n`); } catch { /* noop */ } });
}
