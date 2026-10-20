'use strict';
// TEST-TEMP-HYGIENE: a temp folder the test file removes again. tempDir(prefix) is mkdtemp in
// os.tmpdir(); every folder made here is removed when the file's process ends (after its last test
// and after-hooks), so a file that makes folders in helpers and module scope cannot forget one.
// A folder still in use then (a child left running, a file left open) stays, and run-tests names
// it (TEMP LEAK).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];

/**
 * Removes `dir` (await it in t.after), trying again every 250 ms for up to `budgetMs` while
 * something still holds a file in it: a write stream of this process that has not closed yet, or
 * a child that is still exiting. The wait is async: a sync wait (rmSync's own retries) blocks the
 * very event loop that would close this process's handle. True when it is gone.
 */
async function removeDir(dir, { budgetMs = 30_000, rm = (d) => fs.rmSync(d, { recursive: true, force: true }), now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = now() + budgetMs;
  for (;;) {
    try { rm(dir); return true; } catch { if (now() >= end) return false; }
    await pause(250);
  }
}

function removeAll() {
  for (const d of made.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* run-tests names it */ }
  }
}

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!made.length) process.once('exit', removeAll);
  made.push(d);
  return d;
}

module.exports = { tempDir, removeDir, removeAll };
