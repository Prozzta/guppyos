'use strict';
/**
 * MODEL-LIST-CENSUS-MASK-196: fakes a test spawned, stopped through what it spawned them with.
 *
 * Under suite load a cleanup in `finally` (a 60 s WMI pid lookup) threw ETIMEDOUT, which REPLACED the
 * test's AssertionError: the mutant census printed SURVIVED, the fake lived, and the file hung 30 min.
 * So:
 *  - verdict(): the check's error always wins; a cleanup error rides on it (`cleanupError`) and is thrown
 *    only when the check passed;
 *  - tracker(): every child is kept by its ChildProcess handle. stop() writes each child's stop file (the
 *    fake exits by itself, below any .cmd shim), waits a bounded time for the handles' exit, then
 *    kills what is left by its handle. No pid lookup, no taskkill, no WMI.
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function verdict(check, cleanup) {
  let failed = null;
  try { await check(); } catch (e) { failed = e; }
  let cleanupError = null;
  try { await cleanup(); } catch (e) { cleanupError = e; }
  if (failed) {
    if (cleanupError && failed && typeof failed === 'object') failed.cleanupError = cleanupError;
    throw failed;
  }
  if (cleanupError) throw cleanupError;
}

function tracker() {
  const live = new Set();
  /** spawn(), keeping the handle until its exit; `stopFile` is the file the child polls for. */
  function track(file, args, opts, stopFile) {
    const c = spawn(file, args, opts);
    const h = { c, stopFile };
    live.add(h);
    c.once('exit', () => live.delete(h));
    c.once('error', () => live.delete(h));
    return c;
  }
  /** Stop every live child; resolves with the number still live after the handle kill. */
  async function stop(ms = 5000) {
    for (const h of live) { try { if (h.stopFile) fs.writeFileSync(h.stopFile, ''); } catch { /* jail gone */ } }
    const t0 = Date.now();
    while (live.size && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
    for (const h of live) { try { h.c.kill('SIGKILL'); } catch { /* exited meanwhile */ } }
    const t1 = Date.now();
    while (live.size && Date.now() - t1 < 1000) await new Promise((r) => setTimeout(r, 50));
    return live.size;
  }
  return { track, stop, live };
}

module.exports = { verdict, tracker };
