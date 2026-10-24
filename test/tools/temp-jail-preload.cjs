'use strict';
/**
 * TEST-TEMP-HYGIENE: run-tests.cjs loads this into every process of its `node --test` through
 * NODE_OPTIONS. In a test-file process (NODE_TEST_CONTEXT), before any test code runs, TEMP, TMP and
 * TMPDIR and LOCALAPPDATA point at a folder of the file's own, <root>\<pid>, and <root>\<pid>.file names the file.
 * os.tmpdir() reads them on every call, and every process the file starts inherits them, so what
 * the file and its children leave in "the temp folder" is in that folder. After the run the runner
 * names each file whose folder is not empty and fails the run (tempLeaks in run-tests.cjs). The
 * file takes this back out of NODE_OPTIONS, so nothing it starts loads it again.
 */
const root = process.env.GUPPY_TEMP_JAIL;
const opt = process.env.GUPPY_TEMP_JAIL_OPT; // the exact text run-tests added to NODE_OPTIONS
if (root && opt && String(process.env.NODE_TEST_CONTEXT || '').startsWith('child')) {
  const fs = require('fs');
  const path = require('path');
  process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || '').replace(opt, '').trim();
  if (!process.env.NODE_OPTIONS) delete process.env.NODE_OPTIONS;
  delete process.env.GUPPY_TEMP_JAIL;
  delete process.env.GUPPY_TEMP_JAIL_OPT;
  // The real temp folder, for the caches that are shared on purpose and kept between runs
  // (shared-temp.cjs). A nested run keeps the outermost one.
  if (!process.env.GUPPY_SHARED_TEMP) process.env.GUPPY_SHARED_TEMP = require('os').tmpdir();
  try {
    // <pid>-<unique>: a later file can get a finished file's pid, and must not share its folder.
    const dir = fs.mkdtempSync(path.join(root, `${process.pid}-`));
    fs.writeFileSync(`${dir}.file`, String(process.argv[1] || ''), 'utf8');
    process.env.TEMP = dir;
    process.env.TMP = dir;
    process.env.TMPDIR = dir;
    // Native helpers use Environment.SpecialFolder.LocalApplicationData for durable-looking
    // state such as job markers.  It is test state too: keep it under the per-file jail so the
    // runner can reject leaks and no test mutates the real user profile.
    process.env.LOCALAPPDATA = dir;
  } catch (e) {
    process.stderr.write(`[test-runner] ${process.argv[1] || 'a test file'} has no temp folder of its own (${String(e)}): its temp leaks are not checked\n`);
  }
}
