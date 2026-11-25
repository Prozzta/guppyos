'use strict';
// TEST-TEMP-HYGIENE: a temp folder the test file removes again. tempDir(prefix) is mkdtemp in
// os.tmpdir(); every folder made here is removed when the file's process ends (after its last test
// and after-hooks), so a file that makes folders in helpers and module scope cannot forget one.
// A folder still in use then (a child left running, a file left open) stays, and run-tests names
// it (TEMP LEAK).
// Under Electron `fs` shows a *.asar as a folder and cannot remove one (EPERM), so a temp folder
// that holds an archive would stay. The unpatched fs removes it as the file it is.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];

// Clears the read-only bit on every file under `d`. Links are left alone: chmod would follow one out of the folder.
function makeWritable(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) makeWritable(p); else fs.chmodSync(p, 0o666);
  }
}

/**
 * rmSync of a whole folder that also removes READ-ONLY files. On Windows the rmSync of Electron 45
 * (node 24) fails with EPERM on a read-only file, where Node 26's removes it; git writes its object
 * files read-only, so a temp repo could not be removed on the Electron leg. On EPERM the read-only
 * bit is cleared and the removal is tried once more; any other failure, and a second one, is thrown.
 */
function rmTree(d, opts = {}) {
  const o = { recursive: true, force: true, ...opts };
  try { fs.rmSync(d, o); } catch (e) {
    if (e.code !== 'EPERM') throw e;
    try { makeWritable(d); } catch { throw e; }
    fs.rmSync(d, o);
  }
}

/**
 * Removes `dir` (await it in t.after), trying again every 250 ms for up to `budgetMs` while
 * something still holds a file in it: a write stream of this process that has not closed yet, or
 * a child that is still exiting. The wait is async: a sync wait (rmSync's own retries) blocks the
 * very event loop that would close this process's handle. True when it is gone.
 */
async function removeDir(dir, { budgetMs = 30_000, rm = rmTree, now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = now() + budgetMs;
  for (;;) {
    try { rm(dir); return true; } catch { if (now() >= end) return false; }
    await pause(250);
  }
}

function removeAll() {
  for (const d of made.splice(0)) {
    try { rmTree(d, { maxRetries: 5, retryDelay: 100 }); } catch { /* run-tests names it */ }
  }
}

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (!made.length) process.once('exit', removeAll);
  made.push(d);
  return d;
}

module.exports = { tempDir, removeDir, removeAll, rmTree };
