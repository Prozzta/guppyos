'use strict';
require('./tools/own-job.cjs');
// FLAKE-BARE-OWNER-CIM-LOOKUP-TIMEOUT-108: a failed PowerShell run in own-procs says HOW it failed.
// Node's own message is only "Command failed: <command>"; under suite load a start-up death (status 3221225794,
// empty stderr) looked the same as a timeout or a script error. Nothing here changes timeouts, retries or sleeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const own = require('./tools/own-procs.cjs');

const nodeFail = (props, message) => (() => { const e = new Error(message); Object.assign(e, props); throw e; });

test('a start-up death (non-zero status, empty stderr) is named in the error', () => {
  let err = null;
  try { own.runPowershell('Get-Date', { exec: nodeFail({ status: 3221225794, signal: null, stderr: '', stdout: '' }, 'Command failed: powershell.exe -NoProfile') }); } catch (e) { err = e; }
  assert.ok(err, 'it still throws');
  assert.match(err.message, /^Command failed: powershell\.exe -NoProfile \[own-procs powershell #\d+ failed after \d+ ms: status=3221225794 signal=null code=null stderr="" stdout=""\]$/);
  assert.equal(err.status, 3221225794, 'the original error object, not a copy');
});

test('a timeout is told apart: code ETIMEDOUT, and a script error carries its stderr', () => {
  let t = null; let s = null;
  try { own.runPowershell('x', { exec: nodeFail({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }, 'spawnSync powershell.exe ETIMEDOUT') }); } catch (e) { t = e; }
  try { own.runPowershell('x', { exec: nodeFail({ status: 1, stderr: 'Get-CimInstance : Access denied' }, 'Command failed: powershell.exe') }); } catch (e) { s = e; }
  assert.match(t.message, /status=null signal=SIGTERM code=ETIMEDOUT/);
  assert.match(s.message, /status=1 .*stderr="Get-CimInstance : Access denied"/);
});

test('a real failing child (not PowerShell: node refuses the flag) reports its real status and stderr', () => {
  let err = null;
  try { own.runPowershell('x', { exe: process.execPath }); } catch (e) { err = e; }
  assert.ok(err, 'node exits non-zero on -NoProfile');
  assert.match(err.message, /status=[1-9]\d* signal=null code=null stderr="[^"]+"/);
});

test('success is untouched: the stdout comes back and the start count rises by one', () => {
  const before = own.powershellStarts();
  assert.equal(own.runPowershell('x', { exec: () => 'out\n' }), 'out\n');
  assert.equal(own.powershellStarts(), before + 1);
});
