'use strict';
/**
 * QUIT-SWEEP-ELECTRON-SILENT-EXIT: how a test's fixture process ended, for the failure message.
 *
 * A fixture that ends early leaves the test with one fact a reader needs first: did it crash (a large
 * code such as 0xC0000005), did it get a signal (off win32), or did it end with a small code. The
 * note NARROWS the cause; it does not prove one. Code 1 with no signal on win32 is an outside kill
 * (process.kill, taskkill /F, TerminateProcess) OR the fixture's own exit(1) or uncaught throw: the
 * code alone does not tell these apart, so a code-1 fail is not to be attributed as a kill from it.
 * These helpers only REPORT; they judge nothing and change no verdict.
 * test/quit-sweep-exit-report.test.cjs runs them on a real child.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Resolves once `child` has exited: { code, signal, ms } with ms counted from `bornMs`. */
function seenExit(child, bornMs) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - bornMs }));
  });
}

/** One line for a failure message. `seen` is seenExit's value, or 'timeout' when the hang guard won. */
function exitNote(seen) {
  if (seen === 'timeout') return 'fixture did not exit (the hang guard ended it)';
  // An NTSTATUS crash code reads as a nine or ten digit number; the hex form is the one to look up.
  const hex = Number.isInteger(seen.code) && seen.code > 0xffff ? ` (0x${seen.code.toString(16).toUpperCase()})` : '';
  return `fixture exited code=${seen.code}${hex}, signal=${seen.signal}, after ${seen.ms} ms`;
}

/** The files under <sandbox>/crashDumps with their sizes, sorted; says so when there is no folder or no file.
 *  Crashpad writes a dump after the process is gone, so right after a fast fail 'no files' does not rule a crash out. */
function crashDumpNote(sandbox) {
  const root = path.join(sandbox, 'crashDumps');
  const files = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), at); continue; }
      let size = '?';
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* went away while listing */ }
      files.push(`${at} (${size} bytes)`);
    }
  };
  try { walk(root, ''); } catch (e) {
    if (e && e.code === 'ENOENT' && !files.length) return 'crashDumps: no folder';
    return `crashDumps: not readable (${e && e.code})${files.length ? `; seen: ${files.sort().join(', ')}` : ''}`;
  }
  return files.length ? `crashDumps: ${files.sort().join(', ')}` : 'crashDumps: no files';
}

/** Removes the sandbox. '' when it is gone; otherwise the error code and the entries still in it. */
function removeSandbox(sandbox) {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
    return '';
  } catch (e) {
    let left = [];
    try { left = fs.readdirSync(sandbox).sort(); } catch { /* not listable either */ }
    return `sandbox not removed (${(e && e.code) || e}); left in it: ${left.length ? left.join(', ') : 'nothing listable'}`;
  }
}

module.exports = { seenExit, exitNote, crashDumpNote, removeSandbox };
