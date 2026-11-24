'use strict';
require('./tools/own-job.cjs');
// MAILRIG-EVENTLOG-EMPTY-READS-COMMAND-FAILED-108: the F3 diag's Application event-log read. Get-WinEvent with no
// matching event makes powershell exit 1 with empty stdout and stderr; that must read "nothing", not "Command failed".
// Any other failure (timeout kill, spawn error, exit 1 WITH stderr, other codes) keeps its error text.
const test = require('node:test');
const assert = require('node:assert');
const { eventLogReport } = require('./mail-rig/driver.cjs');
const err = (o) => Object.assign(new Error('Command failed: powershell.exe -NoProfile ...\nmore'), o);
const NONE = 'application event log, last 60 s: nothing for electron.exe or this pid';

test('eventLogReport: output present: the rows, whatever the exit', () => {
  assert.strictEqual(eventLogReport(null, 'a\nb\n', ''), 'application event log, last 60 s:\na\nb');
  assert.match(eventLogReport(err({ code: 1 }), 'row', ''), /^application event log, last 60 s:\nrow$/);
});
test('eventLogReport: exit 0, nothing: plain "nothing", no error text', () => {
  assert.strictEqual(eventLogReport(null, '', ''), NONE);
});
test('eventLogReport: exit 1 with empty stdout AND stderr (the NoMatchingEvents case): plain "nothing", no "Command failed"', () => {
  assert.strictEqual(eventLogReport(err({ code: 1 }), '', ''), NONE);
  assert.strictEqual(eventLogReport(err({ code: 1 }), undefined, undefined), NONE);
});
test('eventLogReport: every other failure keeps its error text', () => {
  const k = (e, so, se) => eventLogReport(e, so, se);
  assert.match(k(err({ code: 1 }), '', 'Get-WinEvent : access denied'), /^application event log, last 60 s: nothing for electron.exe or this pid \(Command failed: /);
  assert.match(k(err({ code: 2 }), '', ''), /\(Command failed: /);
  assert.match(k(err({ code: null, killed: true, signal: 'SIGKILL' }), '', ''), /\(Command failed: /);
  assert.match(k(err({ code: 'ENOENT' }), '', ''), /\(Command failed: /);
  assert.doesNotMatch(k(err({ code: 2 }), '', ''), /more/);
});
