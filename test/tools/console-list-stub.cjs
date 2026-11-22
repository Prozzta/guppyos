'use strict';
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY. Not a test file.
 *
 * A console list helper that answers what it is told to, and lists nothing. console-list-kill-driver.cjs
 * starts it in place of the helper that the harness (pty-child.cjs) asks, for the asks a case scripts:
 * the answers a real helper gives when it could not list the console, made on purpose and with no load.
 *
 *   fails      the list call failed: [] and the failure's text (what a helper that cannot attach says)
 *   empty      an empty list, and the call did not fail
 *   strangers  a list that holds neither the owner nor the child: this process only
 *   silent     the helper ends without any message
 *
 * usage (a fork): console-list-stub.cjs <fails|empty|strangers|silent>
 */
const mode = process.argv[2];
const answers = {
  fails: { consoleProcessList: [], error: 'AttachConsole failed' },
  empty: { consoleProcessList: [], error: null },
  strangers: { consoleProcessList: [process.pid], error: null }
};
if (answers[mode]) { try { process.send(answers[mode]); } catch { /* parent gone */ } }
process.exit(mode === 'silent' || answers[mode] ? 0 : 1);
