'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE: this file loads run-tests.cjs, a file a census mutates in place.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
// FLAKE-OWN-PROCS-POWERSHELL-EXIT-NEG1-EMPTY-108: an own-procs PowerShell lookup exited with status 4294967295
// after 1402 ms, with empty stdout and stderr, under suite load. That is the exit code Stop-Process -Force gives
// its target, and own-procs' stop script is the only code of ours that uses it. The failure line named neither
// the child nor the time, and no record said which processes a stop script was handed. These cells pin the
// diagnosis only:
//   (a) the failure line carries the child's pid and the UTC wall time before and after the call;
//   (b) every process handed to a stop script is one row in <GUPPY_FILE_BACKSTOP>.stops, and a failed run names
//       the rows that carry its child's pid, or says that none does.
// A row means HANDED to a stop script, not stopped: the script checks the name and CreationDate again and may
// skip. Nothing here changes a retry, a timeout, a sleep or the route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nodeEnv } = require('./tools/node-env.cjs');
const own = require('./tools/own-procs.cjs');
const runner = require('./tools/run-tests.cjs');

const KEY = Symbol.for('guppy.file-backstop');
const nodeFail = (props, message) => (() => { const e = new Error(message); Object.assign(e, props); throw e; });
const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;
const CHILD = new RegExp(String.raw` \[own-procs powershell child pid=(\d+) started=(${ISO}) ended=(${ISO})\]`);

/** Run `fn` with this process's backstop record set to `value` (undefined: as outside the runner), then put it back. */
function withBackstop(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process, KEY); const old = process[KEY];
  if (value === undefined) delete process[KEY]; else process[KEY] = value;
  try { return fn(); } finally { if (had) process[KEY] = old; else delete process[KEY]; }
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'own-procs-neg1-'));
const readRows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const failWith = (pid) => { try { own.runPowershell('x', { exec: nodeFail({ status: 4294967295, signal: null, stderr: '', stdout: '', pid }, 'Command failed: powershell.exe -NoProfile') }); } catch (e) { return e; } return null; };

test('(a) a failed run that had a child names its pid and the UTC wall time before and after the call', () => {
  const before = Date.now();
  const err = withBackstop(undefined, () => failWith(4321));
  const after = Date.now();
  assert.ok(err, 'it still throws');
  assert.match(err.message, /status=4294967295 signal=null code=null stderr="" stdout=""\] \[own-procs powershell child pid=4321 /, 'the child follows the failure line');
  const m = CHILD.exec(err.message);
  assert.ok(m, `the message carries the child's pid and times: ${err.message}`);
  assert.ok(err.message.endsWith(m[0]), 'outside the runner nothing follows it');
  const started = Date.parse(m[2]); const ended = Date.parse(m[3]);
  assert.ok(before <= started && started <= ended && ended <= after, `started ${m[2]} and ended ${m[3]} are the wall times around the call`);
  assert.ok(err.powershellWhy.endsWith(m[0].trim()), 'the same text is on powershellWhy');
  assert.equal(err.status, 4294967295, 'the original error object, not a copy');
});

test('(a) a real failing child (not PowerShell: node refuses the flag) is named by its real pid', () => {
  let err = null;
  withBackstop(undefined, () => { try { own.runPowershell('x', { exe: process.execPath }); } catch (e) { err = e; } });
  assert.ok(err, 'node exits non-zero on -NoProfile');
  assert.ok(Number.isInteger(err.pid) && err.pid > 0, 'execFileSync puts the pid on its error');
  const m = CHILD.exec(err.message);
  assert.ok(m, `the message carries the child's pid and times: ${err.message}`);
  assert.equal(Number(m[1]), err.pid);
});

test('(b) each process handed to a stop script is one journal row: time, pid, parent, name, CreationDate, rule, file, killer', { skip: process.platform !== 'win32' && 'own-procs stops nothing off win32' }, () => {
  const dir = tmpDir();
  try {
    const stops = path.join(dir, 'starts.jsonl.stops');
    const rows = [
      { pid: 100, ppid: 1, created: 5000, name: 'node.exe' },        // a live root of ours
      { pid: 101, ppid: 100, created: 5100, name: 'powershell.exe' }, // its child
      { pid: 201, ppid: 200, created: 7050, name: 'conhost.exe' },    // the orphan of a root that is gone
      { pid: 300, ppid: 1, created: 9000, name: 'cmd.exe' },          // rows a caller passes itself
    ];
    const scripts = [];
    const t0 = Date.now();
    withBackstop({ stops, file: 'killer.test.cjs' }, () => {
      const live = own.ownTree(rows, { pid: 100, bornMs: 5001, name: 'node.exe' });
      const gone = own.ownTree(rows, { pid: 200, bornMs: 7000, name: 'node.exe' });
      assert.deepEqual([live.tree.map((r) => r.pid), gone.tree.map((r) => r.pid)], [[100, 101], [201]]);
      own.stopIfSame([...live.tree, ...gone.tree, rows[3]], (s) => scripts.push(s));
    });
    const t1 = Date.now();
    assert.equal(scripts.length, 1, 'the stop script still runs once, as before');
    assert.equal(scripts[0], own.stopScript(rows), 'and it is the same script: the journal changes nothing in it');
    const got = readRows(stops);
    assert.deepEqual(got.map(({ t, ...r }) => r), [
      { pid: 100, ppid: 1, name: 'node.exe', created: 5000, rule: 'own-tree', file: 'killer.test.cjs', by: process.pid },
      { pid: 101, ppid: 100, name: 'powershell.exe', created: 5100, rule: 'own-tree', file: 'killer.test.cjs', by: process.pid },
      { pid: 201, ppid: 200, name: 'conhost.exe', created: 7050, rule: 'orphan', file: 'killer.test.cjs', by: process.pid },
      { pid: 300, ppid: 1, name: 'cmd.exe', created: 9000, rule: 'direct', file: 'killer.test.cjs', by: process.pid },
    ]);
    assert.ok(got.every((r) => t0 <= r.t && r.t <= t1), 'each row carries the wall time it was handed over');
    assert.deepEqual(Object.keys(rows[1]).sort(), ['created', 'name', 'pid', 'ppid'], 'the rows themselves keep their shape');
    withBackstop({ stops, file: 'second.test.cjs' }, () => own.stopIfSame([rows[3]], () => {}));
    assert.equal(readRows(stops).length, 5, 'append-only: a later stop adds its row');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(b) the journal is a no-op outside the runner, and a journal that cannot be written never stops the stop', { skip: process.platform !== 'win32' && 'own-procs stops nothing off win32' }, () => {
  const dir = tmpDir();
  try {
    const rows = [{ pid: 300, ppid: 1, created: 9000, name: 'cmd.exe' }];
    let ran = 0;
    withBackstop(undefined, () => own.stopIfSame(rows, () => { ran += 1; }));
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing is written when the record is absent');
    withBackstop({ stops: path.join(dir, 'no-such-folder', 'x.stops'), file: 'f' }, () => own.stopIfSame(rows, () => { ran += 1; }));
    withBackstop({ stops: 7, file: 'f' }, () => own.stopIfSame(rows, () => { ran += 1; }));
    assert.equal(ran, 3, 'the stop script ran every time');
    const err = withBackstop({ stops: path.join(dir, 'no-such-folder', 'x.stops'), file: 'f' }, () => failWith(4321));
    assert.match(err.message, /\[own-procs stops: none of 0 rows names pid 4321; a row means handed to a stop script, not stopped\]$/, 'an unreadable journal reads as no rows');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(b) a failed run names the journal rows that carry its child\'s pid, or says that none of N does', () => {
  const dir = tmpDir();
  try {
    const stops = path.join(dir, 'starts.jsonl.stops');
    fs.writeFileSync(stops, [
      JSON.stringify({ t: Date.UTC(2026, 10, 23, 6, 12, 1, 5), pid: 4321, ppid: 77, name: 'powershell.exe', created: 1795414320000, rule: 'orphan', file: 'test/killer.test.cjs', by: 55 }),
      'torn',
      JSON.stringify({ t: 2, pid: 9, ppid: 1, name: 'node.exe', created: 1, rule: 'own-tree', file: 'test/other.test.cjs', by: 56 }),
    ].join('\n') + '\n');
    const hit = withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4321));
    assert.match(hit.message, CHILD, 'the child block is still there');
    assert.ok(hit.message.endsWith(' [own-procs stops: pid 4321 was handed to a stop script (handed, not proven stopped): powershell.exe created=1795414320000 ppid=77 rule=orphan by test/killer.test.cjs (pid 55) at 2026-11-23T06:12:01.005Z]'), hit.message);
    const miss = withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4322));
    assert.ok(miss.message.endsWith(' [own-procs stops: none of 2 rows names pid 4322; a row means handed to a stop script, not stopped]'), miss.message);
    const noPid = withBackstop({ stops, file: 'me.test.cjs' }, () => { try { own.runPowershell('x', { exec: nodeFail({ status: 1 }, 'Command failed') }); } catch (e) { return e; } return null; });
    assert.match(noPid.message, /stdout=""\]$/, 'a failure with no child pid has nothing to look up');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(b) the preload keeps the journal path for the test file process only: on process, not in its env', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'starts.jsonl');
    const opt = `--require "${runner.BACKSTOP_PRELOAD.split(path.sep).join('/')}"`;
    const script = "const b = process[Symbol.for('guppy.file-backstop')]; console.log(JSON.stringify({ b: b || null, env: Object.keys(process.env).filter((k) => /BACKSTOP|STOPS/i.test(k)), opts: process.env.NODE_OPTIONS || '' }));";
    const run = (extra) => spawnSync(process.execPath, [path.join(dir, 'probe.test.cjs')], { encoding: 'utf8', windowsHide: true, env: nodeEnv({ ...process.env, NODE_OPTIONS: opt, GUPPY_FILE_BACKSTOP: out, GUPPY_FILE_BACKSTOP_OPT: opt, ...extra }) });
    fs.writeFileSync(path.join(dir, 'probe.test.cjs'), script);
    const r = run({ NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { b: { stops: `${out}.stops`, file: path.join(dir, 'probe.test.cjs') }, env: [], opts: '' });
    assert.equal(fs.existsSync(`${out}.stops`), false, 'the preload itself writes no stops row');
    const notAFile = run({ NODE_TEST_CONTEXT: '' });
    assert.equal(notAFile.status, 0, notAFile.stderr);
    assert.equal(JSON.parse(notAFile.stdout.trim().split('\n').pop()).b, null, 'a process that is not a test file of the run gets no record');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(b) the runner removes the stops journal with its other record files at the end of a leg', () => {
  const removed = [];
  runner.runNodeTest({ rel: ['x'], label: '', spawn: () => ({ status: 0 }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: () => '', removeFile: (f) => removed.push(f), watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: () => {} });
  assert.ok(removed.includes('ev.jsonl.starts.kills'), 'the kills record is cleaned up, as before');
  assert.ok(removed.includes('ev.jsonl.starts.stops'), 'and so is the stops journal');
});
