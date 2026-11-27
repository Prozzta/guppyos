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
const NO_KILLS = (pid, n = 0) => ` [kills: none of ${n} rows names pid ${pid} since its spawn; only a run file's own process.kill/taskkill is recorded]`;
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
    assert.match(err.message, /\[own-procs stops: none of 0 rows names pid 4321; a row means handed to a stop script, not stopped\] \[kills: none of 0 rows names pid 4321 since its spawn; only a run file's own process\.kill\/taskkill is recorded\]$/, 'an unreadable journal reads as no rows');
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
    assert.ok(hit.message.endsWith(' [own-procs stops: pid 4321 was handed to a stop script (handed, not proven stopped): powershell.exe created=1795414320000 ppid=77 rule=orphan by test/killer.test.cjs (pid 55) at 2026-11-23T06:12:01.005Z]' + NO_KILLS(4321)), hit.message);
    const miss = withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4322));
    assert.ok(miss.message.endsWith(' [own-procs stops: none of 2 rows names pid 4322; a row means handed to a stop script, not stopped]' + NO_KILLS(4322)), miss.message);
    assert.equal(fs.readFileSync(stops, 'utf8').split('\n').filter((l) => l.includes('"psFailed"')).length, 2,'each failure left its marker row, and "none of 2 rows" above did not count the first');
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

// Jim 4ba1e5 (MUST): the stops journal is kill evidence for a lost file, as <starts>.kills is, so
// RUNNER-KEEP-RECORDS keeps a copy of it too, before the cleanup removes it.
test('(b) a file that ended without exiting: the stops journal is kept with the other records, before it is removed', () => {
  const order = [];
  const files = { 'ev.jsonl.starts': JSON.stringify({ pid: 11, bornMs: 1000, file: 'victim.test.cjs', name: 'node.exe' }) };
  runner.runNodeTest({ rel: ['x'], label: '', spawn: () => ({ status: 1 }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: (f) => order.push(['rm', f]), watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: () => {}, now: () => 9000,
    keepRecords: (dir, kept) => { order.push(['keep', ...kept]); return kept; } });
  const keeps = order.filter((o) => o[0] === 'keep');
  assert.equal(keeps.length, 1, `the lost file's records are kept once: ${JSON.stringify(order)}`);
  assert.ok(keeps[0].includes('ev.jsonl.starts.kills'), 'the kills record is kept, as before');
  assert.ok(keeps[0].includes('ev.jsonl.starts.stops'), 'and so is the stops journal');
  assert.ok(order.findIndex((o) => o[0] === 'keep') < order.findIndex((o) => o[1] === 'ev.jsonl.starts.stops' && o[0] === 'rm'), 'kept before it is removed');
});

// Jim 4ba1e5 (NIT 2): a spawn that itself failed gives pid 0. That is no child: no block, and no journal lookup.
test('(a) a failed spawn (pid 0) names no child and reads no journal', () => {
  const err = withBackstop({ stops: path.join(os.tmpdir(), 'own-procs-neg1-never-read.stops'), file: 'x.test.cjs' }, () => failWith(0));
  assert.ok(err, 'it still throws');
  assert.ok(err.message.endsWith('stdout=""]'), `nothing follows the failure line: ${err.message}`);
  assert.doesNotMatch(err.message, /own-procs powershell child|own-procs stops|kills:/);
});

// ---- 2026-11-27 (god 4c10ec): the four evidence gaps of the second sighting (a quit-sweep fixture, exit 1, no suffix) ----
const S2 = '[own-procs powershell #1 failed after 3842 ms: status=1 signal=null code=null stderr="" stdout=""] [own-procs powershell child pid=231512 started=2026-11-24T16:59:05.313Z ended=2026-11-24T16:59:09.155Z]';
const S2_START = Date.UTC(2026, 10, 24, 16, 59, 5, 313);
const markers = (file) => { try { return readRows(file).filter((r) => 'psFailed' in r); } catch { return []; } };

test('(gap B) the failure line also reads the kills journal: a kill that named the child since its spawn is on the line', () => {
  const dir = tmpDir();
  try {
    const stops = path.join(dir, 'starts.jsonl.stops');
    const later = Date.now() + 60_000;
    fs.writeFileSync(path.join(dir, 'starts.jsonl.kills'), [
      JSON.stringify({ pid: 70, file: 'old.test.cjs', via: 'process.kill', targets: [4321], t: 5 }), // an older owner of the number
      JSON.stringify({ pid: 71, file: 'killer.test.cjs', via: 'taskkill', targets: [9, 4321], t: later }),
    ].join('\n') + '\n');
    const hit = withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4321));
    assert.ok(hit.message.endsWith(` [own-procs stops: none of 0 rows names pid 4321; a row means handed to a stop script, not stopped] [kills: pid 4321 was named by a kill (taskkill) from killer.test.cjs (pid 71) at ${new Date(later).toISOString()}]`), `THE KILL IS ON THE FAILURE LINE, AFTER THE STOPS TEXT: ${hit.message}`);
    assert.doesNotMatch(hit.message, /old\.test\.cjs/, 'a kill from before the spawn named an older owner of the pid');
    assert.ok(hit.powershellWhy.includes('[kills: pid 4321 was named by a kill (taskkill)'), 'the same text is on powershellWhy');
    const miss = withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4322));
    assert.ok(miss.message.endsWith(NO_KILLS(4322, 2)), `NO KILL IS SAID, WITH THE ROW COUNT: ${miss.message}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(gap D) a failed lookup that had a child leaves one marker row in the stops journal; none outside a run or with no child', () => {
  const dir = tmpDir();
  try {
    const stops = path.join(dir, 'starts.jsonl.stops');
    const before = Date.now();
    withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(4321));
    const after = Date.now();
    const got = markers(stops);
    assert.equal(got.length, 1, 'ONE MARKER ROW');
    const { t, startedMs, endedMs, ...rest } = got[0];
    assert.deepEqual(rest, { psFailed: 4321, status: 4294967295, file: 'me.test.cjs', by: process.pid }, 'THE MARKER ROW HAS THESE FIELDS ONLY (no pid: it is not a stop row)');
    assert.ok(before <= startedMs && startedMs <= endedMs && endedMs <= t && t <= after, 'it carries the wall times of the call');
    assert.equal('pid' in got[0], false, 'no pid field: it is not a stop row');
    assert.deepEqual(runner.psFailRows(fs.readFileSync(stops, 'utf8')).map((r) => r.psFailed), [4321], 'the runner reads it back');
    withBackstop({ stops, file: 'me.test.cjs' }, () => failWith(0));
    assert.equal(markers(stops).length, 1, 'a failed spawn (pid 0) leaves no marker');
    withBackstop(undefined, () => failWith(4321));
    assert.equal(markers(stops).length, 1, 'outside a run nothing is written');
    assert.ok(withBackstop({ stops: path.join(dir, 'no-such-folder', 'x.stops'), file: 'f' }, () => failWith(4321)), 'a marker that cannot be written never hides the failure');
    assert.deepEqual(runner.psFailRows(`torn\n${JSON.stringify({ t: 1, pid: 5, file: 'a' })}\n${JSON.stringify({ psFailed: 'x', file: 'a' })}\n`), [], 'stop rows and torn rows are not markers');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(gap A) the outer test of a fixture gets the stops and kills naming for the child in the fixture\'s failure line', () => {
  const dir = tmpDir();
  try {
    const stops = path.join(dir, 'starts.jsonl.stops');
    fs.writeFileSync(stops, `${JSON.stringify({ t: S2_START + 900, pid: 231512, ppid: 77, name: 'powershell.exe', created: 1795539545000, rule: 'orphan', file: 'test/killer.test.cjs', by: 55 })}\n`);
    fs.writeFileSync(path.join(dir, 'starts.jsonl.kills'), [
      JSON.stringify({ pid: 70, file: 'old.test.cjs', via: 'process.kill', targets: [231512], t: S2_START - 1 }),
      JSON.stringify({ pid: 71, file: 'killer.test.cjs', via: 'taskkill', targets: [231512], t: S2_START + 3000 }),
    ].join('\n') + '\n');
    const text = `[fixture] Command failed: powershell.exe ${S2}\nlater: ${S2}\n`;
    const named = withBackstop({ stops, file: 'outer.test.cjs' }, () => own.namingForFixtureText(text));
    assert.equal(named, ' [fixture own-procs powershell child pid=231512, read from this test file\'s journals:'
      + ' [own-procs stops: pid 231512 was handed to a stop script (handed, not proven stopped): powershell.exe created=1795539545000 ppid=77 rule=orphan by test/killer.test.cjs (pid 55) at 2026-11-24T16:59:06.213Z]'
      + ' [kills: pid 231512 was named by a kill (taskkill) from killer.test.cjs (pid 71) at 2026-11-24T16:59:08.313Z]]', 'THE SAME LINE TWICE IS NAMED ONCE, AND THE KILL BEFORE THE SPAWN IS LEFT OUT');
    const got = markers(stops);
    assert.equal(got.length, 1, 'and it leaves ONE marker for the runner');
    assert.deepEqual([got[0].psFailed, got[0].startedMs, got[0].endedMs, got[0].file], [231512, S2_START, S2_START + 3842, 'outer.test.cjs'], 'with the times read from the line and the OUTER test as the file');
    assert.equal(withBackstop({ stops, file: 'outer.test.cjs' }, () => own.namingForFixtureText('[fixture] tree never grew a descendant (root 5)')), '', 'no child block: nothing');
    assert.equal(withBackstop(undefined, () => own.namingForFixtureText(text)), '', 'outside a run: nothing');
    assert.equal(markers(stops).length, 1, 'and neither wrote a marker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('(gap A) quit-sweep.electron, the one test whose fixture uses own-procs, appends that naming to every fixture failure message', () => {
  const src = fs.readFileSync(path.join(__dirname, 'quit-sweep.electron.test.cjs'), 'utf8');
  assert.match(src, /const named = own\.namingForFixtureText\(output\);/);
  const withOutput = src.split(/\r?\n/).filter((l) => /^\s*assert\..*output:\\n\$\{output\}/.test(l));
  assert.equal(withOutput.length, 4, 'the four asserts that print the fixture output');
  for (const l of withOutput) assert.match(l, /\$\{output\}\$\{named(?: \|\| own\.namingForFixtureText\(recorded\.error\))?\}`\);$/, `THE NAMING FOLLOWS THE OUTPUT: ${l.trim()}`);
  const fixtures = fs.readdirSync(path.join(__dirname, 'fixtures'), { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(c?js|mjs)$/.test(d.name) && /own-procs/.test(fs.readFileSync(path.join(__dirname, 'fixtures', d.name), 'utf8'))).map((d) => d.name);
  assert.deepEqual(fixtures, ['quit-sweep-main.cjs'], 'a new fixture that uses own-procs needs the same naming in its outer test');
});

const FAIL_ROW = (file) => JSON.stringify({ failure: { file, name: 'a red test' } });
/** One runNodeTest over made-up record files; returns what it kept, saved, removed and said. */
function leg(files, extra = {}) {
  const order = []; const errs = []; const saves = []; let clock = 1000;
  const out = runner.runNodeTest({ rel: ['x'], label: '', spawn: () => ({ status: 1 }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: (f) => order.push(['rm', f]), watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: (l) => errs.push(l), now: () => { clock += 500; return clock; },
    keepRecords: (dir, kept) => { order.push(['keep', dir, ...kept]); return kept; },
    saveEvents: (dir, from, to) => { saves.push([dir, from, to]); return path.join(dir, 'ps-events-400-403.json'); }, ...extra });
  return { order, errs: errs.join('\n'), saves, out };
}

test('(gap C) a red leg keeps the kills and stops journals beside the log before the cleanup; a green leg keeps nothing', () => {
  const red = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs') });
  const keeps = red.order.filter((o) => o[0] === 'keep');
  assert.deepEqual(keeps, [['keep', 'kept-ev.jsonl', 'ev.jsonl.starts.kills', 'ev.jsonl.starts.stops']], 'THE TWO JOURNALS ARE KEPT, ONCE');
  assert.ok(red.order.indexOf(keeps[0]) < red.order.findIndex((o) => o[0] === 'rm'), 'kept before anything is removed');
  assert.deepEqual(red.order.filter((o) => o[0] === 'rm').map((o) => o[1]), ['ev.jsonl', 'ev.jsonl.watchdog', 'ev.jsonl.backstop', 'ev.jsonl.starts', 'ev.jsonl.starts.kills', 'ev.jsonl.starts.stops'], 'the cleanup is unchanged');
  assert.match(red.errs, /records kept \(copied, not moved\) in kept-ev\.jsonl: ev\.jsonl\.starts\.kills, ev\.jsonl\.starts\.stops /, red.errs);
  assert.deepEqual(red.out.failures, [{ file: 'red.test.cjs', name: 'a red test' }], 'the result is the same');
  const hung = leg({ 'ev.jsonl.backstop': JSON.stringify({ file: 'hung.test.cjs', by: 'backstop', kill: 'job', message: 'BACKSTOP' }) });
  assert.equal(hung.order.filter((o) => o[0] === 'keep').length, 1, 'a timed-out file is a red leg too');
  const green = leg({}, { spawn: () => ({ status: 0 }) });
  assert.deepEqual(green.order.filter((o) => o[0] === 'keep'), [], 'A GREEN LEG KEEPS NOTHING');
  const none = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs') }, { keepRecords: () => [] });
  assert.doesNotMatch(none.errs, /records kept|no record file existed|could not keep/, 'a red leg with no journal says nothing about a keep');
  const broken = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs') }, { keepRecords: () => { throw new Error('disk full'); } });
  assert.match(broken.errs, /could not keep the journals in kept-ev\.jsonl: Error: disk full/);
  assert.deepEqual(broken.out.failures, red.out.failures, 'a keep that fails changes nothing else');
});

test('(gap D) a marker on a red file saves the PowerShell 400/403 events for the leg window; any other marker saves nothing', () => {
  const mark = (file) => JSON.stringify({ t: 1900, psFailed: 231512, startedMs: 1200, endedMs: 1800, status: 1, file, by: 9 });
  const red = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs'), 'ev.jsonl.starts.stops': `${JSON.stringify({ t: 1, pid: 3, file: 'red.test.cjs' })}\n${mark('red.test.cjs')}\n` });
  assert.deepEqual(red.saves, [['kept-ev.jsonl', 1500, 2000]], 'ONE SAVE, FOR THE LEG WINDOW (before the spawn to after it), INTO THE KEPT FOLDER');
  assert.match(red.errs, /a failed own-procs PowerShell lookup \(child pid 231512, 1970-01-01T00:00:01\.200Z to 1970-01-01T00:00:01\.800Z, status 1\) is on a red file: red\.test\.cjs/, red.errs);
  assert.match(red.errs, /PowerShell engine events 400\/403 for the leg window 1970-01-01T00:00:01\.500Z to 1970-01-01T00:00:02\.000Z saved in kept-ev\.jsonl[\\/]ps-events-400-403\.json/, red.errs);
  const other = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs'), 'ev.jsonl.starts.stops': `${mark('green.test.cjs')}\n` });
  assert.deepEqual(other.saves, [], 'A MARKER ON A FILE THAT PASSED (a test of the failure line itself) SAVES NOTHING');
  assert.doesNotMatch(other.errs, /PowerShell/);
  const green = leg({ 'ev.jsonl.starts.stops': `${mark('green.test.cjs')}\n` }, { spawn: () => ({ status: 0 }) });
  assert.deepEqual(green.saves, [], 'a green leg saves nothing');
  const lost = leg({ 'ev.jsonl.starts': JSON.stringify({ pid: 11, bornMs: 1000, file: 'lost.test.cjs', name: 'node.exe' }), 'ev.jsonl.starts.stops': `${mark('lost.test.cjs')}\n` });
  assert.equal(lost.saves.length, 1, 'a file that ended without exiting counts as red');
  const broken = leg({ 'ev.jsonl': FAIL_ROW('red.test.cjs'), 'ev.jsonl.starts.stops': `${mark('red.test.cjs')}\n` }, { saveEvents: () => { throw new Error('no log'); } });
  assert.match(broken.errs, /could not save the PowerShell engine events in kept-ev\.jsonl: Error: no log/);
  assert.deepEqual([broken.out.failures, broken.out.hung], [red.out.failures, red.out.hung], 'A SAVE THAT FAILS CHANGES NOTHING ELSE');
});

test('(gap D) savePsEvents asks for ids 400 and 403 five seconds either side of the window and writes the JSON reply', () => {
  const ran = []; const wrote = [];
  const file = runner.savePsEvents('kept', 100_000, 200_000, { platform: 'win32', run: (s) => { ran.push(s); return '[{"id":400}]'; }, write: (d, f, text) => wrote.push([d, f, text]) });
  assert.equal(file, path.join('kept', 'ps-events-400-403.json'));
  assert.deepEqual(wrote, [['kept', file, '[{"id":400}]']]);
  assert.equal(ran.length, 1);
  assert.equal(ran[0], runner.psEventsScript(95_000, 205_000), 'FIVE SECONDS EITHER SIDE');
  assert.match(ran[0], /record = \$_\.RecordId; pid = \$_\.ProcessId; message = \$_\.Message/, 'EACH ROW ASKS FOR THE RECORD\'S PROCESS ID, to tie a 400/403 pair to the failed child');
  assert.match(ran[0], /FromUnixTimeMilliseconds\(95000\)\.LocalDateTime[\s\S]*FromUnixTimeMilliseconds\(205000\)\.LocalDateTime/);
  assert.match(ran[0], /LogName = 'Windows PowerShell'; Id = 400, 403; StartTime = \$from; EndTime = \$to/);
  assert.equal(runner.savePsEvents('kept', 1, 2, { platform: 'linux', run: () => { throw new Error('RAN OFF WIN32'); } }), null, 'off win32 nothing runs');
  assert.throws(() => runner.savePsEvents('kept', 1, 2, { platform: 'win32', run: () => 'Get-WinEvent : denied', write: () => { throw new Error('WROTE A NON-JSON REPLY'); } }), SyntaxError, 'a reply that is not JSON is a failed save');
});

test('(gap D) the real query runs and replies with a JSON array for the last minute', { skip: process.platform !== 'win32' && 'the Windows PowerShell log is win32 only' }, () => {
  const dir = tmpDir();
  try {
    const file = withBackstop(undefined, () => runner.savePsEvents(dir, Date.now() - 60_000, Date.now()));
    assert.equal(file, path.join(dir, 'ps-events-400-403.json'));
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(rows), 'a JSON array');
    for (const r of rows) assert.ok([400, 403].includes(r.id) && /^\d{4}-\d\d-\d\dT/.test(r.t) && typeof r.message === 'string', JSON.stringify(r).slice(0, 300));
    for (const r of rows) assert.ok('pid' in r && (r.pid === null || Number.isInteger(r.pid)), `EACH ROW CARRIES THE RECORD'S PROCESS ID (or null): ${JSON.stringify(r).slice(0, 300)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
