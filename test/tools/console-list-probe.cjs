'use strict';
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY, measuring only. Not a test file.
 *
 * node-pty's list helper (lib/conpty_console_list_agent.js) as this repo patches it answers [] for
 * ANY failure of its list call, so its answer does not say "the call failed" apart from "the list
 * is empty". This is the same helper with the same native call and the same answer, plus one more
 * field: `error`, the text of the failure ('AttachConsole failed', 'FreeConsole failed', ...), or
 * null when the call returned a list; and `t0`, `t1`, the times right before and right after that
 * call, so two answers can be put in order by when they were TAKEN, not by when they arrived.
 *
 * console-list-kill-driver.cjs starts it IN PLACE OF node-pty's helper, for the one case it
 * measures. Whoever asked (the harness, node-pty's kill) reads `consoleProcessList` as before.
 *
 * usage (a fork, as node-pty's helper is: a process has one console): console-list-probe.cjs <pid>
 */
const { loadNativeModule } = require('node-pty/lib/utils');

const pid = parseInt(process.argv[2], 10);
let consoleProcessList = [];
let error = null;
// The module is loaded before the clock is read: t0 and t1 are the native call's own start and end
// (Date.now(), the one clock that this process and the driver share).
const native = loadNativeModule('conpty_console_list').module;
let t0 = Date.now();
let t1 = t0;
try {
  t0 = Date.now();
  consoleProcessList = native.getConsoleProcessList(pid);
  t1 = Date.now();
} catch (e) { t1 = Date.now(); error = String((e && e.message) || e); }
try { process.send({ consoleProcessList, error, t0, t1 }); } catch { /* parent gone */ }
process.exit(0);
