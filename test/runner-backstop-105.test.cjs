'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads run-tests.cjs, a file a census mutates in
// place; refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * GUPPY-NODE-LTS (god 57be0d): the runner owns the per-file backstop.
 *
 * Found on Node 24.22.2: `node --test --test-timeout=3000` on a file whose one test passes but which
 * keeps a setInterval never kills the file (Node 20.20.2 kills it at 3006 ms). run-tests.cjs leaned
 * on that flag as the backstop behind its watchdog, so on Node 24 a stuck file outlived the backstop
 * and test-runner-glob's backstop end-to-end test hung for ever. Now each file records itself
 * (file-backstop-preload.cjs) and file-backstop.cjs kills one still running past backstopMs; the
 * run names it and FAILS. No --test-timeout, and never --test-force-exit (it would pass that file).
 *
 * The END TO END test below is the one-line repro itself, through the real runner and the real
 * backstop with the watchdog stubbed out, and must pass on Node 20 and Node 24 alike.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('./tools/run-tests.cjs');
const bs = require('./tools/file-backstop.cjs');
const own = require('./tools/own-procs.cjs');

const row = (o) => JSON.stringify(o);

test('starts: the latest start per pid, an exit row removes it, a torn line is skipped', () => {
  const text = [row({ pid: 1, bornMs: 10, file: 'a.test.cjs', name: 'node.exe' }), row({ pid: 2, bornMs: 20, file: 'b.test.cjs', name: 'node.exe' }),
    row({ pid: 1, exited: true }), row({ pid: 2, bornMs: 30, file: 'c.test.cjs', name: 'node.exe' }), '{"pid": 3, "bor'].join('\n');
  assert.deepEqual(bs.liveStarts(text), [{ pid: 2, bornMs: 30, file: 'c.test.cjs', name: 'node.exe' }]);
  assert.deepEqual(bs.liveStarts(''), []);
});

test('due: only past the backstop, measured from the file\'s birth, and once', () => {
  const starts = [{ pid: 1, bornMs: 1000, file: 'a', name: 'n' }, { pid: 2, bornMs: 5000, file: 'b', name: 'n' }];
  assert.deepEqual(bs.dueStarts(starts, 3000, 4000).map((d) => d.pid), [], 'exactly at the limit is not past it');
  assert.deepEqual(bs.dueStarts(starts, 3000, 4001).map((d) => [d.pid, d.ageMs]), [[1, 3001]]);
  assert.deepEqual(bs.dueStarts(starts, 3000, 9000, new Set(['1:1000'])).map((d) => d.pid), [2]);
});

test('tick: verify, then RECORD, then kill, then the outcome; a file that is gone or not ours is left alone and not reported', () => {
  const text = [row({ pid: 1, bornMs: 0, file: 'gone.test.cjs', name: 'node.exe' }), row({ pid: 2, bornMs: 0, file: 'hung.test.cjs', name: 'node.exe' }),
    row({ pid: 3, bornMs: 0, file: 'boom.test.cjs', name: 'node.exe' })].join('\n');
  const log = [];
  const handled = new Set();
  const args = { text, limitMs: 100, now: 1000, handled,
    record: (r) => log.push(`record ${r.file} ${r.message}`),
    verify: (d) => (d.pid === 1 ? { why: 'gone' } : { row: { pid: d.pid, created: -5 } }),
    kill: (d, r) => { log.push(`kill ${d.pid} ${r.created}`); if (d.pid === 3) throw new Error('denied'); return { by: 'job' }; } };
  bs.tick(args);
  assert.deepEqual(log.map((l) => l.replace(/still running \d+ ms/, 'still running N ms')), [
    'record hung.test.cjs BACKSTOP: still running N ms after it started (backstop 100 ms; the watchdog did not end it): killing it',
    'kill 2 -5',
    'record hung.test.cjs BACKSTOP: killed through its job',
    'record boom.test.cjs BACKSTOP: still running N ms after it started (backstop 100 ms; the watchdog did not end it): killing it',
    'kill 3 -5',
    'record boom.test.cjs BACKSTOP: not killed: the kill threw: denied',
  ]);
  log.length = 0;
  bs.tick(args);
  assert.deepEqual(log, [], 'each file is handled once');
});

test('verifyWin: ours only with its name and a CreationDate at or before its recorded birth', () => {
  const s = { pid: 7, bornMs: 1000, file: 'a', name: 'node.exe' };
  assert.deepEqual(bs.verifyWin(s, { lookup: () => [] }), { why: 'gone' });
  assert.equal(bs.verifyWin(s, { lookup: () => [{ pid: 7, created: 1001, name: 'node.exe' }] }).why, 'its pid belongs to another process now', 'born after: a reuse');
  assert.equal(bs.verifyWin(s, { lookup: () => [{ pid: 7, created: 900, name: 'ping.exe' }] }).why, 'its pid belongs to another process now', 'another name');
  assert.deepEqual(bs.verifyWin(s, { lookup: () => [{ pid: 7, created: 900, name: 'NODE.EXE' }] }), { row: { pid: 7, created: 900, name: 'NODE.EXE' } });
});

test('killWin: through the job with the snapshot\'s CreationDate; the verified tree without a job or when the job tool cannot', () => {
  const calls = [];
  const run = (exe, a) => { calls.push([exe, ...a]); return { status: Number(exe.slice(-1)) }; };
  const tree = (rec) => { calls.push(['tree', rec.pid, rec.bornMs, rec.name]); return { killed: [1, 2] }; };
  const s = { pid: 7, bornMs: 1000, name: 'node.exe' };
  assert.deepEqual(bs.killWin(s, { created: 900 }, { jobExe: 'job0', run, tree }), { by: 'job' });
  assert.deepEqual(bs.killWin(s, { created: 900 }, { jobExe: 'job4', run, tree }), { by: 'none', why: 'another process has the pid now' });
  assert.deepEqual(bs.killWin(s, { created: 900 }, { jobExe: 'job2', run, tree }), { by: 'tree', killed: 2 });
  assert.deepEqual(bs.killWin(s, { created: 900 }, { jobExe: null, run, tree }), { by: 'tree', killed: 2 });
  assert.deepEqual(calls, [['job0', 'kill', '7', '900'], ['job4', 'kill', '7', '900'], ['job2', 'kill', '7', '900'], ['tree', 7, 1000, 'node.exe'], ['tree', 7, 1000, 'node.exe']]);
});

test('the preload records only a test-file process, then takes itself out of NODE_OPTIONS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backstop-preload-'));
  try {
    const out = path.join(dir, 'starts.jsonl');
    const opt = `--require "${runner.BACKSTOP_PRELOAD.split(path.sep).join('/')}"`;
    const probe = "process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS || '', process.env.GUPPY_FILE_BACKSTOP || '']))";
    // This file itself runs with NODE_TEST_CONTEXT set: take it out, so the plain probe is not a test file.
    const { NODE_TEST_CONTEXT: _ctx, ...base } = process.env;
    const go = (ctx) => spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...base, NODE_OPTIONS: opt, GUPPY_FILE_BACKSTOP: out, GUPPY_FILE_BACKSTOP_OPT: opt, ...(ctx ? { NODE_TEST_CONTEXT: ctx } : {}) } });
    const plain = go(null);
    assert.equal(fs.existsSync(out), false, 'not a test file: nothing recorded');
    assert.deepEqual(JSON.parse(plain.stdout), [opt, out], 'and nothing taken out');
    const child = go('child-v8');
    assert.deepEqual(JSON.parse(child.stdout), ['', ''], 'what the file starts is not recorded as a file of the run');
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2, 'a start and a normal exit');
    assert.equal(rows[0].pid, rows[1].pid); assert.equal(rows[1].exited, true);
    assert.ok(Number.isInteger(rows[0].bornMs) && rows[0].bornMs <= Date.now());
    assert.equal(rows[0].name.toLowerCase(), path.basename(process.execPath).toLowerCase());
    assert.deepEqual(bs.liveStarts(fs.readFileSync(out, 'utf8')), [], 'an exited file is never due');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file the backstop killed is a FAILED file even when node\'s own report lists no failure for it', () => {
  const rows = { 'ev.jsonl': '', 'ev.jsonl.watchdog': '', 'ev.jsonl.backstop': [
    row({ file: 'hung.test.cjs', by: 'backstop', message: 'BACKSTOP: still running 9 ms after it started (backstop 5 ms; the watchdog did not end it): killing it' }),
    row({ file: 'hung.test.cjs', by: 'backstop', kill: 'job', message: 'BACKSTOP: killed through its job' })].join('\n') };
  const e = [];
  const r = runner.runNodeTest({ rel: ['hung.test.cjs'], label: '', spawn: () => ({ status: 0 }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: (f) => rows[f] || '', removeFile: () => {}, watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: (l) => e.push(l) });
  assert.deepEqual(r.failures.map((f) => f.file), ['hung.test.cjs'], 'MUTANT: a backstop kill node did not report is not listed as failed');
  assert.deepEqual(r.hung.map((h) => [h.file, h.by]), [['hung.test.cjs', 'backstop']]);
  assert.match(e.join('\n'), /FILE TIMED OUT after 5 ms \(the runner's backstop killed it at \d+ ms\): hung\.test\.cjs/);
  assert.match(e.join('\n'), /BACKSTOP: killed through its job: hung\.test\.cjs/);
});

test('END TO END (the Node 24 repro): a file whose test PASSED but which never exits is killed by the runner\'s backstop and FAILS the run, on every Node', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-backstop105-'));
  const pidFile = path.join(dir, 'file.pid');
  try {
    fs.writeFileSync(path.join(dir, 'a-hung.test.cjs'), [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + Math.round(Date.now() - process.uptime() * 1000));`,
      "require('node:test')('done', () => { setInterval(() => {}, 1000); });",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b-ok.test.cjs'), "require('node:test')('ok', () => {});\n");
    const e = []; let out = '';
    // Bounded (Jim, mutant A): spawnSync blocks the event loop, so the test's own timeout cannot fire;
    // a backstop that never kills must FAIL this test, not hang the suite.
    let timedOut = false;
    const spawn = (args, opts) => { const r = spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' }); out = r.stdout; timedOut = timedOut || (r.error && r.error.code) === 'ETIMEDOUT'; return r; };
    const t0 = Date.now();
    // The watchdog stubbed out: the backstop alone must end it (on Node 24 nothing else would).
    const code = runner.run({ testDir: dir, cwd: dir, spawn, timeoutMs: 2_000, isTTY: false, log: () => {}, err: (l) => e.push(l),
      failureFile: () => path.join(dir, 'failures.json'), eventsFile: path.join(dir, 'ev.jsonl'), watchdog: () => ({ stop: () => {} }), backstop: runner.startBackstop });
    const took = Date.now() - t0;
    assert.equal(timedOut, false, 'THE BACKSTOP NEVER ENDED THE FILE: node --test was still running at 90 s');
    assert.notEqual(code, 0, 'MUTANT: a file that never exits passes the run');
    assert.ok(took >= runner.backstopMs(2_000) && took < 90_000, `ended by the backstop, not before it and not never (${took} ms)`);
    assert.match(out, /^ok \d+ - done$/m, 'its test DID pass: only the never-exiting file fails');
    assert.match(out, /^ok \d+ - ok$/m, 'the healthy file ran and passed');
    const errs = e.join('\n');
    assert.match(errs, new RegExp(`FILE TIMED OUT after 2000 ms \\(the runner's backstop killed it at ${runner.backstopMs(2_000)} ms\\): .*a-hung\\.test\\.cjs`));
    assert.doesNotMatch(errs, /b-ok/, 'only the stuck file is named');
    assert.match(fs.readFileSync(path.join(dir, 'failures.json'), 'utf8'), /a-hung\.test\.cjs/, 'listed as a FAILED file');
    const rec = own.readRec(pidFile, path.basename(process.execPath));
    if (process.platform === 'win32') assert.equal(own.stillOurs(rec), null, 'the stuck file process is gone');
    else assert.throws(() => process.kill(rec.pid, 0), /ESRCH/, 'the stuck file process is gone');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('ev.jsonl')), [], 'the record files (the backstop\'s among them) are cleaned up');
  } finally {
    // A file a broken backstop left running: killed only when it is still ours.
    try {
      const rec = own.readRec(pidFile, path.basename(process.execPath));
      if (rec && process.platform === 'win32') { if (own.stillOurs(rec)) own.killOwnTree(rec); } else if (rec) process.kill(rec.pid, 'SIGKILL');
    } catch { /* gone, or no record */ }
    for (let i = 0; i < 50; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); } }
  }
});
