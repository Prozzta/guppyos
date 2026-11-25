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

// Clears the read-only bit under `dir` without following a symlink or junction outside it.
function makeWritable(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) makeWritable(file); else fs.chmodSync(file, 0o666);
  }
}

// Electron's original-fs recursive rmSync follows Windows junctions. Unlink them before either
// removal attempt so a read-only file outside `dir` is neither changed nor used to block cleanup.
function unlinkLinks(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) { fs.unlinkSync(dir); return; }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const child = fs.lstatSync(file);
    if (child.isSymbolicLink()) fs.unlinkSync(file);
    else if (child.isDirectory()) unlinkLinks(file);
  }
}

function hasLinks(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => hasLinks(path.join(dir, entry.name)));
}

/**
 * Removes a tree containing read-only files. Electron 45's rmSync reports EPERM for those files
 * on Windows, although current Node removes them. Retry once only after clearing their read-only
 * bit; any other error, or a second failure, remains the caller's normal removal failure.
 */
function rmTree(dir, options = {}) {
  const rmOptions = { recursive: true, force: true, ...options };
  // Electron's original-fs follows a junction during recursive rmSync. For a tree containing one,
  // clear owned files while lstat still protects its target, then unlink the junction before rmSync.
  if (hasLinks(dir)) { makeWritable(dir); unlinkLinks(dir); }
  try { fs.rmSync(dir, rmOptions); } catch (error) {
    if (error.code !== 'EPERM') throw error;
    try { makeWritable(dir); } catch { throw error; }
    unlinkLinks(dir);
    fs.rmSync(dir, rmOptions);
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

module.exports = { tempDir, removeDir, removeAll };
