'use strict';
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY, measuring only. Not a test file.
 *
 * node-pty's list helper (lib/conpty_console_list_agent.js) as this repo patches it answers [] for
 * ANY failure of its list call, so its answer does not say "the call failed" apart from "the list
 * is empty". This is the same helper with the same native call and the same answer, plus one more
 * field: `error`, the text of the failure ('AttachConsole failed', 'FreeConsole failed', ...), or
 * null when the call returned a list.
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
try {
  consoleProcessList = loadNativeModule('conpty_console_list').module.getConsoleProcessList(pid);
} catch (e) { error = String((e && e.message) || e); }
try { process.send({ consoleProcessList, error }); } catch { /* parent gone */ }
process.exit(0);
