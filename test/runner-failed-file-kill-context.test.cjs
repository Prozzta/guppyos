'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads run-tests.cjs, a file a census mutates in
// place; refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * RUNNER-FAILED-FILE-KILL-CONTEXT-POST108: a failed test file is shown with the kills other files made
 * while it ran, and the start and kill records of a failed run are kept.
 *
 * GTC suite, Node leg, 2026-11-20: quit-sweep.electron failed because the process IT started ended
 * with no output. The test file itself exited normally, so the runner's FILE ENDED WITHOUT EXITING
 * report (which looks only at test FILE pids with no exit row) said nothing, and the start and kill
 * records were deleted with the run. Whether another file made a kill in those 7.9 s could not be
 * read afterwards.
 *
 * Wanted:
 * - the preload's exit row carries its time, so a file's run window has an end;
 * - killsDuring(starts, kills, failedFiles): per failed file, the kills OTHER files recorded inside
 *   its window;
 * - runNodeTest prints them (at most 20 rows a file) and hands the record texts back on a failed run;
 * - the run writes the records beside the failing-test list. The record files beside the events file
 *   are still removed, as before.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nodeEnv } = require('./tools/node-env.cjs');
const runner = require('./tools/run-tests.cjs');

const row = (o) => JSON.stringify(o);

/** One failed file (pid 11, 1000..9000) and one that passed, with kills before, inside and after the window. */
function records({ inWindow = 1 } = {}) {
  const starts = [
    row({ pid: 11, bornMs: 1000, file: 'failed.test.cjs', name: 'node.exe' }),
    row({ pid: 12, bornMs: 1000, file: 'ok.test.cjs', name: 'node.exe' }),
    row({ pid: 12, exited: true, t: 2000 }),
    row({ pid: 11, exited: true, t: 9000 }),
  ].join('\n');
  const kills = [
    row({ pid: 20, file: 'early.test.cjs', via: 'taskkill', targets: [7], t: 900 }),
    row({ pid: 21, file: 'killer.test.cjs', via: 'taskkill', targets: [7, 8], t: 1792 }),
    row({ pid: 11, file: 'failed.test.cjs', via: 'process.kill', targets: [9], t: 2000 }),   // its own kill
    ...Array.from({ length: inWindow - 1 }, (_, i) => row({ pid: 22, file: 'busy.test.cjs', via: 'process.kill', targets: [100 + i], t: 3000 + i })),
    row({ pid: 23, file: 'late.test.cjs', via: 'process.kill', targets: [7], t: 9500 }),
    'torn',
  ].join('\n');
  return { starts, kills };
}

test('killsDuring: a failed file is given the kills other files made inside its run window, and no other', () => {
  const { starts, kills } = records();
  assert.equal(typeof runner.killsDuring, 'function', 'run-tests exports killsDuring');
  assert.deepEqual(runner.killsDuring(starts, kills, ['failed.test.cjs']), [
    { pid: 11, file: 'failed.test.cjs', ranMs: 8000, kills: [{ via: 'taskkill', file: 'killer.test.cjs', pid: 21, targets: [7, 8], afterMs: 792 }] },
  ], 'the early kill, the late kill and the file\'s own kill are left out; the passing file is not listed');
  assert.deepEqual(runner.killsDuring(starts, kills, ['not-started.test.cjs']), [], 'a failed file with no start row: none');
  assert.deepEqual(runner.killsDuring('', '', ['failed.test.cjs']), []);
});

test('killsDuring: an exit row with no time (an older preload) leaves the window open and says so', () => {
  const starts = [row({ pid: 11, bornMs: 1000, file: 'failed.test.cjs' }), row({ pid: 11, exited: true })].join('\n');
  const kills = row({ pid: 23, file: 'late.test.cjs', via: 'process.kill', targets: [7], t: 9500 });
  assert.equal(typeof runner.killsDuring, 'function', 'run-tests exports killsDuring');
  assert.deepEqual(runner.killsDuring(starts, kills, ['failed.test.cjs']), [
    { pid: 11, file: 'failed.test.cjs', ranMs: null, kills: [{ via: 'process.kill', file: 'late.test.cjs', pid: 23, targets: [7], afterMs: 8500 }] },
  ]);
});

test('killsDuring: a later file under the same pid ends the window of the one before it', () => {
  const starts = [
    row({ pid: 11, bornMs: 1000, file: 'failed.test.cjs' }),
    row({ pid: 11, exited: true }),
    row({ pid: 11, bornMs: 5000, file: 'later-same-pid.test.cjs' }),
    row({ pid: 11, exited: true, t: 6000 }),
  ].join('\n');
  const kills = [
    row({ pid: 21, file: 'killer.test.cjs', via: 'taskkill', targets: [7], t: 1500 }),
    row({ pid: 22, file: 'other.test.cjs', via: 'taskkill', targets: [7], t: 5500 }),
  ].join('\n');
  assert.equal(typeof runner.killsDuring, 'function', 'run-tests exports killsDuring');
  assert.deepEqual(runner.killsDuring(starts, kills, ['failed.test.cjs']).map((f) => f.kills.map((k) => k.file)), [['killer.test.cjs']]);
});

test('killsDuring: on Windows a failed file named in another case than its start row still has its window', () => {
  // Jim (mutants on 80601784, NIT 2): node's report and the preload can spell one file's path in two
  // cases on Windows (drive letter, folder). Elsewhere a path in another case is another file.
  const started = path.resolve('Some-Dir', 'Failed.test.cjs');
  const reported = started.toLowerCase();
  assert.notEqual(reported, started, 'CONTROL: the two spellings differ');
  const starts = [row({ pid: 11, bornMs: 1000, file: started }), row({ pid: 11, exited: true, t: 9000 })].join('\n');
  const kills = row({ pid: 21, file: 'killer.test.cjs', via: 'taskkill', targets: [7], t: 1792 });
  const got = runner.killsDuring(starts, kills, [reported]);
  if (process.platform === 'win32') {
    assert.deepEqual(got, [{ pid: 11, file: started, ranMs: 8000, kills: [{ via: 'taskkill', file: 'killer.test.cjs', pid: 21, targets: [7], afterMs: 792 }] }],
      'THE WINDOW IS FOUND UNDER THE OTHER SPELLING, and the file is named as its start row has it');
  } else {
    assert.deepEqual(got, [], 'a path in another case is another file here');
  }
});

test('the preload writes the time into a file\'s exit row',{ timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killctx-'));
  try {
    const out = path.join(dir, 'starts.jsonl');
    const opt = `--require "${runner.BACKSTOP_PRELOAD.split(path.sep).join('/')}"`;
    const before = Date.now();
    const r = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', env: nodeEnv({ ...process.env, NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: opt, GUPPY_FILE_BACKSTOP: out, GUPPY_FILE_BACKSTOP_OPT: opt }) });
    const after = Date.now();
    assert.equal(r.status, 0, r.stderr);
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2, 'CONTROL: one start row and one exit row');
    assert.equal(rows[1].exited, true, 'CONTROL: the second row is the exit row');
    assert.ok(Number.isFinite(rows[1].t) && rows[1].t >= before && rows[1].t <= after, `THE EXIT ROW CARRIES ITS TIME, got ${JSON.stringify(rows[1])}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** runNodeTest over stubbed record files; `failed` names the files node's report lists as failed. */
function runStub({ starts, kills, failed, status }) {
  const files = {
    'ev.jsonl': failed.map((file) => row({ failure: { file, name: 'a test' } })).join('\n'),
    'ev.jsonl.starts': starts,
    'ev.jsonl.starts.kills': kills,
  };
  const e = []; const removed = [];
  const r = runner.runNodeTest({ rel: ['x'], label: '', spawn: () => ({ status }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: (f) => removed.push(f), watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: (l) => e.push(l) });
  return { r, errs: e.join('\n'), removed, files };
}

test('runNodeTest names the kills other files made while a failed file ran', () => {
  const { starts, kills } = records();
  const { r, errs, removed } = runStub({ starts, kills, failed: ['failed.test.cjs'], status: 1 });
  assert.deepEqual(r.failures, [{ file: 'failed.test.cjs', name: 'a test' }], 'CONTROL: the stub run has the one failed file');
  assert.doesNotMatch(errs, /FILE ENDED WITHOUT EXITING/, 'CONTROL: the file wrote its exit row, so the silent-exit report has nothing to say');
  assert.ok(removed.includes('ev.jsonl.starts') && removed.includes('ev.jsonl.starts.kills'), 'CONTROL: the record files beside the events file are removed, as before');
  assert.match(errs, /^\[test-runner\] KILLS WHILE A FAILED FILE RAN \(pid 11, 8000 ms\): 1 by other files: failed\.test\.cjs$/m, `THE FAILED FILE HAS ITS KILL CONTEXT:\n${errs}`);
  assert.match(errs, /^\[test-runner\] {3}taskkill of pid 7,8 by killer\.test\.cjs \(pid 21\), 792 ms after it started$/m, `THE KILL, ITS TARGETS AND ITS FILE ARE NAMED:\n${errs}`);
  assert.doesNotMatch(errs, /early\.test\.cjs|late\.test\.cjs|ok\.test\.cjs|of pid 9 /, 'kills outside the window, the file\'s own kill and the passing file are not printed');
});

test('runNodeTest says so when no other file made a kill, and prints at most 20 rows a file', () => {
  const none = runStub({ starts: records().starts, kills: '', failed: ['failed.test.cjs'], status: 1 });
  assert.match(none.errs, /^\[test-runner\] KILLS WHILE A FAILED FILE RAN \(pid 11, 8000 ms\): none recorded by other files \(a kill made by a process a test file started is not recorded\): failed\.test\.cjs$/m,
    `NO KILL IS SAID, NOT LEFT OUT:\n${none.errs}`);
  const many = runStub({ ...records({ inWindow: 25 }), failed: ['failed.test.cjs'], status: 1 });
  assert.match(many.errs, /\(pid 11, 8000 ms\): 25 by other files: failed\.test\.cjs$/m, `THE COUNT IS THE WHOLE COUNT:\n${many.errs}`);
  assert.equal((many.errs.match(/ms after it started$/gm) || []).length, 20, 'twenty rows are printed');
  assert.match(many.errs, /^\[test-runner\] {3}\.\.\. and 5 more, in the kept records$/m, 'the rest are counted and pointed to');
});

test('runNodeTest hands the start and kill records back on a failed run, and nothing on a green one', () => {
  const { starts, kills } = records();
  const red = runStub({ starts, kills, failed: ['failed.test.cjs'], status: 1 });
  assert.deepEqual(red.r.records, { starts, kills }, 'A FAILED RUN KEEPS ITS RECORDS');
  const green = runStub({ starts, kills, failed: [], status: 0 });
  assert.doesNotMatch(green.errs, /KILLS WHILE A FAILED FILE RAN/, 'CONTROL: a green run prints no kill context');
  assert.equal(green.r.records, null, 'a green run keeps none');
});

test('a run with two failed lanes keeps both lanes\' records in the one file, each under its lane', () => {
  // Jim (audit of the red-before, SHOULD 1): the main lane and the render lane each run runNodeTest;
  // a render-lane fail must not lose its records, and one lane must not overwrite the other's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killctx-'));
  try {
    fs.writeFileSync(path.join(dir, 'plain.test.cjs'), '// an ordinary file\n');
    fs.writeFileSync(path.join(dir, 'drawn.test.cjs'), "// require('./electron-harness/run.cjs') puts a file in the render lane\n");
    const plain = path.join(dir, 'plain.test.cjs'); const drawn = path.join(dir, 'drawn.test.cjs');
    const files = {
      'ev.jsonl': row({ failure: { file: plain, name: 'a test' } }),
      'ev.jsonl.starts': [row({ pid: 11, bornMs: 1000, file: plain }), row({ pid: 11, exited: true, t: 2000 })].join('\n'),
      'ev.jsonl.starts.kills': row({ pid: 21, file: 'main-killer.test.cjs', via: 'taskkill', targets: [7], t: 1500 }),
      'ev.jsonl.render': row({ failure: { file: drawn, name: 'a drawn test' } }),
      'ev.jsonl.render.starts': [row({ pid: 31, bornMs: 3000, file: drawn }), row({ pid: 31, exited: true, t: 4000 })].join('\n'),
      'ev.jsonl.render.starts.kills': row({ pid: 41, file: 'render-killer.test.cjs', via: 'process.kill', targets: [8], t: 3500 }),
    };
    const e = []; const logs = []; const written = []; const lanes = [];
    const code = runner.run({ testDir: dir, cwd: dir, spawn: (args) => { lanes.push(args[args.length - 1]); return { status: 1 }; }, timeoutMs: 5, isTTY: false,
      eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: () => {}, failureFile: () => 'failures.json', writeFailureFile: (p, text) => written.push({ p, text }),
      watchdog: () => ({ stop: () => {} }), backstop: () => ({ opt: '', env: {}, stop: () => {} }), log: (l) => logs.push(l), err: (l) => e.push(l),
      cores: 4, processEnv: {}, jobRate: () => 5000, mutantJournal: () => ({ files: [], live: false, owner: null }) });
    const errs = e.join('\n');
    assert.equal(code, 1, `CONTROL: the run fails:\n${errs}`);
    assert.deepEqual(lanes.map((l) => path.basename(l)), ['plain.test.cjs', 'drawn.test.cjs'], 'CONTROL: two lanes ran, the ordinary file then the render-lane file');
    assert.match(errs, /^\[test-runner\] KILLS WHILE A FAILED FILE RAN \(pid 11, 1000 ms\): 1 by other files: .*plain\.test\.cjs$/m, `the main lane's failed file has its context:\n${errs}`);
    assert.match(errs, /^\[test-runner\] render lane: KILLS WHILE A FAILED FILE RAN \(pid 31, 1000 ms\): 1 by other files: .*drawn\.test\.cjs$/m, `THE RENDER LANE'S FAILED FILE HAS ITS CONTEXT, under the lane's label:\n${errs}`);
    assert.match(errs, /^\[test-runner\] render lane: {3}process\.kill of pid 8 by render-killer\.test\.cjs \(pid 41\), 500 ms after it started$/m, errs);
    const kept = written.filter((w) => w.p === 'failures.json.records.jsonl');
    assert.equal(kept.length, 1, `THE RECORDS ARE WRITTEN ONCE, to one file: ${written.map((w) => w.p).join(', ')}`);
    const rows = kept[0].text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.lane || x.via || (x.exited ? 'exit' : 'start')), ['main', 'start', 'exit', 'taskkill', 'render', 'start', 'exit', 'process.kill'], 'BOTH LANES ARE IN IT, each under its own lane row');
    assert.deepEqual(logs.filter((l) => l.includes('records')), ['[test-runner] start and kill records of the failed run written to failures.json.records.jsonl']);
    assert.match(logs[logs.length - 1], /^\[test-runner\] totals: /, 'CONTROL: the totals line is still the last line');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed perf lane keeps its records in the one file, under its own lane row', () => {
  // Jim (mutants on 80601784, SHOULD 1): the perf lane runs runNodeTest too, after the parallel run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killctx-'));
  try {
    fs.writeFileSync(path.join(dir, 'plain.test.cjs'), '// an ordinary file\n');
    fs.mkdirSync(path.join(dir, 'perf'));
    fs.writeFileSync(path.join(dir, 'perf', 'slow.perf.cjs'), '// a wall-clock file\n');
    const slow = path.join(dir, 'perf', 'slow.perf.cjs');
    const files = {
      'ev.jsonl.perf': row({ failure: { file: slow, name: 'a wall-clock gate' } }),
      'ev.jsonl.perf.starts': [row({ pid: 51, bornMs: 5000, file: slow }), row({ pid: 51, exited: true, t: 6000 })].join('\n'),
      'ev.jsonl.perf.starts.kills': row({ pid: 61, file: 'perf-killer.test.cjs', via: 'taskkill', targets: [9], t: 5250 }),
    };
    const e = []; const logs = []; const written = []; const lanes = [];
    const code = runner.run({ testDir: dir, cwd: dir, perfDir: path.join(dir, 'perf'),
      spawn: (args) => { const last = path.basename(args[args.length - 1]); lanes.push(last); return { status: last === 'slow.perf.cjs' ? 1 : 0 }; }, timeoutMs: 5, isTTY: false,
      eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: () => {}, failureFile: () => 'failures.json', writeFailureFile: (p, text) => written.push({ p, text }),
      watchdog: () => ({ stop: () => {} }), backstop: () => ({ opt: '', env: {}, stop: () => {} }), log: (l) => logs.push(l), err: (l) => e.push(l),
      cores: 4, processEnv: {}, jobRate: () => 5000, mutantJournal: () => ({ files: [], live: false, owner: null }) });
    const errs = e.join('\n');
    assert.equal(code, 1, `CONTROL: the run fails:\n${errs}\n${logs.join('\n')}`);
    assert.deepEqual(lanes, ['plain.test.cjs', 'slow.perf.cjs'], 'CONTROL: the parallel run passed, then the perf lane ran its one file');
    assert.match(errs, /^\[test-runner\] the perf lane FAILED /m, `CONTROL: only the perf lane failed:\n${errs}`);
    assert.match(errs, /^\[test-runner\] perf lane KILLS WHILE A FAILED FILE RAN \(pid 51, 1000 ms\): 1 by other files: .*slow\.perf\.cjs$/m, `THE PERF LANE'S FAILED FILE HAS ITS CONTEXT, under the lane's label:\n${errs}`);
    const kept = written.filter((w) => w.p === 'failures.json.records.jsonl');
    assert.equal(kept.length, 1, `THE RECORDS ARE WRITTEN ONCE, to one file: ${written.map((w) => w.p).join(', ')}`);
    const rows = kept[0].text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((x) => x.lane || x.via || (x.exited ? 'exit' : 'start')), ['perf', 'start', 'exit', 'taskkill'], 'THE PERF LANE\'S RECORDS ARE IN IT under a { lane: "perf" } row; the lanes that passed have none');
    assert.deepEqual(rows[0], { lane: 'perf' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('END TO END: a file fails while another kills a process by number; the run names that kill and keeps the records', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killctx-'));
  const up = path.join(dir, 'a.up');
  const done = path.join(dir, 'b.done');
  const wait = (file) => `for (let i = 0; i < 300 && !fs.existsSync(${JSON.stringify(file)}); i++) await new Promise((r) => setTimeout(r, 100));`;
  try {
    // a-fails is running (a.up) for the whole of the other file's kill, then fails by its own assert.
    fs.writeFileSync(path.join(dir, 'a-fails.test.cjs'), [
      "const fs = require('node:fs');",
      "require('node:test')('fails after the other file made its kill', async () => {",
      `  fs.writeFileSync(${JSON.stringify(up)}, '');`,
      `  ${wait(done)}`,
      `  if (!fs.existsSync(${JSON.stringify(done)})) throw new Error('the killer never finished');`,
      "  throw new Error('the failure under test');",
      '});',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b-killer.test.cjs'), [
      "const fs = require('node:fs'); const cp = require('node:child_process');",
      "require('node:test')('ends its own child by number', async () => {",
      `  ${wait(up)}`,
      `  if (!fs.existsSync(${JSON.stringify(up)})) throw new Error('the other file never started');`,
      "  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
      "  const gone = new Promise((r) => child.once('exit', r));",
      "  await new Promise((r) => child.once('spawn', r));",
      '  process.kill(child.pid);',
      '  await gone;',
      `  fs.writeFileSync(${JSON.stringify(done)}, '');`,
      '});',
    ].join('\n'));
    const e = []; const logs = []; let out = '';
    const spawn = (args, opts) => { const r = spawnSync(process.execPath, args, { ...opts, env: nodeEnv(opts.env), stdio: 'pipe', encoding: 'utf8', timeout: 100_000, killSignal: 'SIGKILL' }); out = `${r.stdout}${r.error ? `\n-- spawn error: ${r.error}\n${r.stderr}` : ''}`; return r; };
    const failuresFile = path.join(dir, 'failures.json');
    const code = runner.run({ testDir: dir, cwd: dir, spawn, timeoutMs: 90_000, isTTY: false, log: (l) => logs.push(l), err: (l) => e.push(l),
      failureFile: () => failuresFile, eventsFile: path.join(dir, 'ev.jsonl'), watchdog: () => ({ stop: () => {} }), backstop: runner.startBackstop });
    const errs = e.join('\n');
    assert.notEqual(code, 0, 'CONTROL: the run fails');
    assert.match(out, /^not ok \d+ - fails after the other file made its kill$/m, `CONTROL: a-fails failed by its own test:\n${out}\n-- stderr of the run:\n${errs}\n-- log of the run:\n${logs.join('\n')}`);
    assert.match(out, /^ok \d+ - ends its own child by number$/m, `CONTROL: the killer passed:\n${out}`);
    assert.doesNotMatch(out, /the killer never finished|the other file never started/, 'CONTROL: the two files met');
    assert.doesNotMatch(errs, /FILE ENDED WITHOUT EXITING/, 'CONTROL: both files exited, so the silent-exit report has nothing to say');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('ev.jsonl')), [], 'CONTROL: the record files beside the events file are removed, as before');
    assert.match(errs, /KILLS WHILE A FAILED FILE RAN \(pid \d+, \d+ ms\): 1 by other files: .*a-fails\.test\.cjs$/m, `THE FAILED FILE HAS ITS KILL CONTEXT:\n${errs}`);
    assert.match(errs, /^\[test-runner\] {3}process\.kill of pid \d+ by .*b-killer\.test\.cjs \(pid \d+\), \d+ ms after it started$/m, `THE OTHER FILE'S KILL IS NAMED:\n${errs}`);
    assert.doesNotMatch(errs, /KILLS WHILE A FAILED FILE RAN.*b-killer\.test\.cjs$/m, 'the file that passed gets no kill context line');
    const kept = `${failuresFile}.records.jsonl`;
    assert.ok(fs.existsSync(kept), `THE RECORDS OF THE FAILED RUN ARE KEPT beside the failing-test list: ${fs.readdirSync(dir).join(', ')}`);
    const rows = fs.readFileSync(kept, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((x) => /a-fails\.test\.cjs$/.test(x.file || '') && Number.isFinite(x.bornMs)), 'the kept records hold the failed file\'s start row');
    assert.ok(rows.some((x) => x.exited === true && Number.isFinite(x.t)), 'and an exit row with its time');
    assert.ok(rows.some((x) => x.via === 'process.kill' && /b-killer\.test\.cjs$/.test(x.file || '')), 'and the kill row');
    assert.ok(logs.some((l) => l === `[test-runner] start and kill records of the failed run written to ${kept}`), `the kept file is named in the log:\n${logs.join('\n')}`);
  } finally {
    for (let i = 0; i < 50; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { env: nodeEnv() }); } }
  }
});
