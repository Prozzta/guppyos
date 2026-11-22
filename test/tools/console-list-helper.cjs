'use strict';
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY. Not a test file.
 *
 * The processes on the console of a pid, for the test harness (pty-child.cjs), with a failure told
 * apart from an empty list. It makes the same native call as node-pty's own list helper (a fork: a
 * process has one console, and the call leaves this process's console for the one of the pid).
 * node-pty's helper, as patched in this repo, answers [] for any failure of that call; the app
 * needs that, and a test that reads [] as "nobody is on the console" does not.
 *
 * Sends { consoleProcessList, error }: error is null and the list is what the call returned, or
 * the list is [] and error is the text of what the call threw. Nothing is ended.
 *
 * usage (a fork): console-list-helper.cjs <pid>
 */
let consoleProcessList = [];
let error = null;
try {
  const { getConsoleProcessList } = require('node-pty/lib/utils').loadNativeModule('conpty_console_list').module;
  consoleProcessList = getConsoleProcessList(parseInt(process.argv[2], 10));
} catch (e) { consoleProcessList = []; error = String((e && e.message) || e); }
try { process.send({ consoleProcessList, error }); } catch { /* parent gone */ }
process.exit(0);
