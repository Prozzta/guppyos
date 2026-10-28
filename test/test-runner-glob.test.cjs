/**
 * The focused-suite runner (test/tools/run-tests.cjs).
 *
 * The defect this pins: `node --test test/*.test.cjs` reached cmd.exe unexpanded on
 * Windows + Node 20, matched nothing, and exited having run ZERO tests. Every count ever
 * quoted from that script was really produced by hand-expanding the list. So the tests
 * that matter here are the ones about EMPTINESS - a run that executes nothing must never
 * be able to look like a pass - plus a pin on the package.json script itself, which is
 * the only thing that stops the glob quietly coming back.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const runner = require('./tools/run-tests.cjs');
const { selectTestFiles } = runner;
// These runner-behaviour tests are not process-job integration tests. Pin their
// concurrency to the uncapped branch so a fresh npm-ci tree need not have bin/.
const run = (options) => runner.run({ jobRate: () => 0, mutantJournal: () => ({ owner: null, live: false, files: [] }), ...options });
const helper = require('./tools/mutant-runner-helper.cjs');
const os = require('node:os');

test('MUTANT-JOURNAL-GATE bare node --test (god 5b1c57, Jim NIT): load-ts refuses mutated source under a dead-owner or foreign live journal, lets the census\'s own spawned suites (MUTANT_RUNNER_PID) and the runner itself load, and loads normally with no journal (MUTANT: a bare node --test runs on mutated bytes)', { timeout: 60_000 }, () => {
  const { spawnSync, spawn: spawnChild } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-bare-gate-'));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test', 'tools'), { recursive: true });
  for (const rel of ['test/load-ts.cjs', 'test/tools/mutant-runner-helper.cjs', 'test/tools/ps-env.cjs', 'test/tools/shared-temp.cjs']) {
    if (fs.existsSync(path.join(REPO, rel))) fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  const file = path.join(root, 'src', 'x.ts');
  fs.writeFileSync(file, 'export const x = 1;', 'utf8');
  const journal = (owner) => fs.writeFileSync(helper.journalPath(root), JSON.stringify({ owner, records: [{ file, original: Buffer.from('export const x = 1;').toString('base64') }] }), 'utf8');
  const bare = (env = {}) => spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('./test/load-ts.cjs')('src/x.ts').x))"],
    { cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules'), MUTANT_RUNNER_PID: '', ...env } });
  // No journal: loads.
  let r = bare(); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '1');
  // Dead owner, mutant on disk: a bare load is refused with the recover command; the bytes stay (recover() is the fix).
  fs.writeFileSync(file, 'export const x = 2;', 'utf8');
  journal({ pid: 2147483000, start: '2026-10-25T15:23:08Z' });
  r = bare(); assert.notEqual(r.status, 0, 'MUTANT: a bare node --test loaded the mutated bytes');
  assert.match(r.stderr, /refusing to load mutated source: an interrupted mutant runner \(pid 2147483000, dead\) left mutated files behind; run: node test\/tools\/claims90-m1-mutants\.cjs --recover-only\. Journaled: src[\\/]x\.ts/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const x = 2;');
  // In-process: the same refusal, and the runner's own pid may load (it is the one mutating).
  assert.throws(() => helper.assertUnmutated(root), /interrupted mutant runner \(pid 2147483000, dead\)/);
  journal({ pid: process.pid, start: 'x' }); assert.doesNotThrow(() => helper.assertUnmutated(root), 'the owner itself loads');
  // A live foreign owner: refused and named, unless this process is a suite that owner spawned (MUTANT_RUNNER_PID).
  const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    const start = helper.processStart(child.pid);
    assert.ok(start, 'the child start time reads');
    journal({ pid: child.pid, start });
    assert.equal(helper.journalState(root).live, true);
    r = bare(); assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`refusing to load mutated source: mutant runner pid ${child.pid} \\(started ${start.replace(/[.+*?()[\]]/g, '\\$&')}\\) is still mutating this tree; wait for it or stop it`));
    r = bare({ MUTANT_RUNNER_PID: String(child.pid) }); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '2', 'the census\'s own suite measures the mutant');
  } finally { child.kill(); }
  // mutateFile hands the pid down to the suites it spawns.
  fs.rmSync(helper.journalPath(root)); fs.writeFileSync(file, 'export const x = 1;', 'utf8');
  const saved = process.env.MUTANT_RUNNER_PID; delete process.env.MUTANT_RUNNER_PID;
  try {
    helper.mutateFile(root, file, 'export const x = 1;', 'export const x = 3;');
    assert.equal(process.env.MUTANT_RUNNER_PID, String(process.pid));
    assert.doesNotThrow(() => helper.assertUnmutated(root));
    helper.restoreFile(root, file, 'export const x = 1;');
  } finally { if (saved === undefined) delete process.env.MUTANT_RUNNER_PID; else process.env.MUTANT_RUNNER_PID = saved; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'export const x = 1;');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MUTANT-JOURNAL-GATE (Jim 1b5d87/b0a10e): the runner refuses ANY mutant-runner journal in the tree, live owner (named) or dead (recover command printed), and runs with none; recover() prints each file it restores (MUTANT: runs on mutated bytes / restores silently)', () => {
  const e = sink();
  const { spawn, calls } = fakeSpawn({ status: 0 });
  // Live owner: injected state (a live pid with a matching start time cannot be faked from a test).
  const live = { owner: { pid: 4242, start: '2026-10-25T15:23:08Z' }, live: true, files: ['src/main/nativeMemory/format.ts'] };
  assert.equal(runner.run({ jobRate: () => 0, testDir: 'test', readdir: () => ['a.test.cjs'], spawn, err: e.write, log: () => {}, mutantJournal: () => live }), 1);
  assert.match(e.lines.join('\n'), /refusing to run on mutated source: mutant runner pid 4242 \(started 2026-10-25T15:23:08Z\) is still mutating this tree; wait for it or stop it\. Journaled: src\/main\/nativeMemory\/format\.ts/);
  // Dead owner: a REAL journal in a temp tree, written by the helper, its owner a pid that is not running.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-journal-'));
  fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, 'src', 'format.ts');
  fs.writeFileSync(file, 'return compact;', 'utf8');
  fs.writeFileSync(helper.journalPath(root), JSON.stringify({ owner: { pid: 2147483000, start: '2026-10-25T15:23:08Z' }, records: [{ file, original: Buffer.from('return compact;').toString('base64') }] }), 'utf8');
  fs.writeFileSync(file, 'return full;', 'utf8');
  const state = helper.journalState(root);
  assert.equal(state.live, false); assert.deepEqual(state.files, [path.join('src', 'format.ts')]);
  const d = sink();
  assert.equal(runner.run({ jobRate: () => 0, testDir: 'test', readdir: () => ['a.test.cjs'], spawn, cwd: root, err: d.write, log: () => {} }), 1, 'MUTANT: the suite ran on the mutated bytes');
  assert.match(d.lines.join('\n'), /refusing to run on mutated source: an interrupted mutant runner \(pid 2147483000, dead\) left mutated files behind; run: node test\/tools\/claims90-m1-mutants\.cjs --recover-only\. Journaled: src[\\/]format\.ts/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'return full;', 'the runner itself restores nothing');
  assert.equal(calls.length, 0, 'nothing spawned on a mutated tree');
  // recover() puts the bytes back and says so.
  const lines = [];
  assert.equal(helper.recover(root, (l) => lines.push(l)), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'return compact;');
  assert.deepEqual(lines, [`[mutant-runner] restored ${path.join('src', 'format.ts')} left mutated by an interrupted run (pid 2147483000)`]);
  assert.equal(fs.existsSync(helper.journalPath(root)), false);
  // No journal: the real helper reads the tree and the run goes on.
  const ok = sink();
  const code = runner.run({ jobRate: () => 0, testDir: 'test', readdir: () => ['a.test.cjs'], spawn, cwd: root, err: ok.write, log: () => {} });
  assert.doesNotMatch(ok.lines.join('\n'), /mutated source/);
  assert.notEqual(code, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

const REPO = path.resolve(__dirname, '..');
const TEST_DIR = path.join(REPO, 'test');

/** A spawn stub that records its call and reports the given result. */
function fakeSpawn(result = { status: 0 }) {
  const calls = [];
  const spawn = (args, opts) => { calls.push({ args, opts }); return result; };
  return { spawn, calls };
}

function sink() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

test('selectTestFiles takes every *.test.cjs and nothing else, sorted', () => {
  const { files, total } = selectTestFiles(
    ['zeta.test.cjs', 'alpha.test.cjs', 'tools', 'README.md', 'helper.cjs', 'thing.test.js']
  );
  assert.deepStrictEqual(files, ['alpha.test.cjs', 'zeta.test.cjs']);
  assert.strictEqual(total, 2);
});

test('discoverTestFiles retains feature-relative paths for opted-in nested test groups', () => {
  const tree = {
    test: [{ name: 'area', isDirectory: () => true, isFile: () => false }, { name: 'root.test.cjs', isDirectory: () => false, isFile: () => true }],
    [path.join('test', 'area')]: [{ name: 'nested.test.cjs', isDirectory: () => false, isFile: () => true }, { name: 'note.md', isDirectory: () => false, isFile: () => true }]
  };
  assert.deepStrictEqual(runner.discoverTestFiles('test', (p) => tree[p], ['area']), [path.join('area', 'nested.test.cjs'), 'root.test.cjs']);
});

test('filters narrow by case-insensitive substring, de-duplicated and sorted', () => {
  const entries = ['wake-cold-boot.test.cjs', 'wake-stall.test.cjs', 'canary-lock.test.cjs', 'queue.test.cjs'];
  const { files, unmatched, total } = selectTestFiles(entries, ['WAKE', 'wake-stall', 'canary']);
  assert.deepStrictEqual(files, ['canary-lock.test.cjs', 'wake-cold-boot.test.cjs', 'wake-stall.test.cjs']);
  assert.deepStrictEqual(unmatched, []);
  assert.strictEqual(total, 4);
});

test('a filter that matches nothing is reported, not silently dropped', () => {
  const { unmatched } = selectTestFiles(['a.test.cjs'], ['a', 'nope']);
  assert.deepStrictEqual(unmatched, ['nope']);
});

test('THE REGRESSION: an empty test directory exits NON-ZERO and never spawns', () => {
  const { spawn, calls } = fakeSpawn();
  const e = sink();
  const code = run({ testDir: 'test', readdir: () => ['README.md', 'tools'], spawn, err: e.write, log: () => {} });
  assert.notStrictEqual(code, 0, 'a run that executed nothing must not report success');
  assert.strictEqual(calls.length, 0);
  assert.match(e.lines.join('\n'), /executed nothing/);
});

test('a typo in a filter fails the run rather than passing the files that did match', () => {
  const { spawn, calls } = fakeSpawn();
  const e = sink();
  const code = run({
    testDir: 'test', filters: ['wake', 'waek'],
    readdir: () => ['wake-stall.test.cjs'], spawn, err: e.write, log: () => {}
  });
  assert.notStrictEqual(code, 0);
  assert.strictEqual(calls.length, 0, 'nothing may run until the caller has the suite they asked for');
  assert.match(e.lines.join('\n'), /waek/);
});

test('the expanded file list is passed to node --test - no glob character survives', () => {
  const { spawn, calls } = fakeSpawn({ status: 0 });
  const code = run({
    testDir: path.join('/repo', 'test'), cwd: '/repo',
    readdir: () => ['b.test.cjs', 'a.test.cjs'], spawn, log: () => {}
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.length, 1);
  const args = calls[0].args;
  assert.strictEqual(args[0], '--test');
  // TEST-RUNNER-FILE-TIMEOUT: the runner's own options come first; the files are the tail.
  const fileArgs = args.slice(-2);
  assert.ok(args.every((a) => !a.includes('*')), `glob leaked into ${args.join(' ')}`);
  assert.ok(fileArgs.every((a) => a.endsWith('.test.cjs')));
  assert.strictEqual(args.filter((a) => a.endsWith('.test.cjs')).length, 2, 'exactly the selected files');
  assert.deepStrictEqual(fileArgs.map((a) => path.basename(a)), ['a.test.cjs', 'b.test.cjs']);
});

test('a self-queried hard-capped heavy job scales node test concurrency and its startup gate', () => {
  const { spawn, calls } = fakeSpawn({ status: 0 });
  const gates = [];
  const logs = sink();
  const code = run({
    testDir: 'test', readdir: () => ['a.test.cjs'], spawn, log: logs.write,
    processEnv: {}, cores: 32, jobRate: () => 5000,
    startGate: ({ slots }) => { gates.push(slots); return null; },
  });
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(gates, [4], 'the gate uses the 16-core capped share');
  assert.ok(calls[0].args.includes('--test-concurrency=16'), calls[0].args.join(' '));
  assert.match(logs.lines.join('\n'), /heavy CPU rate 5000: node concurrency 16 of 32 visible cores/);
  assert.strictEqual(runner.cappedCores({}, 1, 5000), 1, 'one visible core remains one');
  let helperCall;
  assert.equal(runner.selfJobRate({ env: {}, platform: 'win32', spawnSyncFn: (...args) => { helperCall = args; return { status: 0, stdout: '{"cap":true,"rate":5000}' }; } }), 5000, 'self-query makes Bash and PowerShell joins cap-aware');
  assert.equal(helperCall[0], runner.HEAVYJOB_HELPER, 'self-query uses this branch\'s built helper, not PATH');
  assert.deepEqual(helperCall[1], ['self-query']);
  assert.throws(
    () => runner.selfJobRate({ env: {}, platform: 'win32', spawnSyncFn: () => ({ status: 2, stderr: 'usage: guppy-heavyjob join ...' }) }),
    /self-query is unavailable/,
    'an old helper without self-query is a named failure, never an uncapped zero'
  );
  const notices = sink();
  assert.equal(
    runner.selfJobRate({ env: {}, platform: 'win32', notice: notices.write, spawnSyncFn: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }) }),
    0,
    'a fresh npm-ci tree has no helper and therefore no cap information'
  );
  assert.match(notices.lines.join('\n'), /helper is not built .*CPU cap unknown/);
  assert.equal(runner.selfJobRate({ env: { GUPPY_HEAVY_CPU_CAP: '0' }, platform: 'win32', spawnSyncFn: () => ({ stdout: '{"cap":true,"rate":5000}' }) }), 0, 'an explicit cap-off override wins');
  assert.equal(runner.selfJobRate({ env: {}, platform: 'win32', spawnSyncFn: () => ({ status: 0, stdout: '{"cap":false,"rate":0}' }) }), 0, 'an uncapped job reports no usable rate');

  const queryFailure = sink();
  assert.equal(run({
    testDir: 'test', readdir: () => ['a.test.cjs'], spawn: fakeSpawn({ status: 0 }).spawn,
    log: () => {}, err: queryFailure.write, jobRate: () => { throw new Error('self-query unsupported'); }
  }), 1);
  assert.match(queryFailure.lines.join('\n'), /cannot query heavy CPU cap: Error: self-query unsupported/);

  const open = fakeSpawn({ status: 0 });
  const openGates = [];
  assert.strictEqual(run({
    testDir: 'test', readdir: () => ['a.test.cjs'], spawn: open.spawn, log: () => {},
    processEnv: {}, cores: 32, jobRate: () => 0,
    startGate: ({ slots }) => { openGates.push(slots); return null; },
  }), 0);
  assert.deepStrictEqual(openGates, [8], 'cap-off preserves the 32-core startup gate');
  assert.ok(!open.calls[0].args.some((arg) => arg.startsWith('--test-concurrency=')), 'the uncapped 32-core default is not artificially restricted');
});

// ── TEST-RUNNER-FILE-TIMEOUT (1.1.76): a file that never finishes is a NAMED failure ──────────

test('every run carries the per-file wall-clock limit, the normal reporter, and the timeout reporter', () => {
  const tap = fakeSpawn({ status: 0 });
  run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: tap.spawn, log: () => {}, isTTY: false, timeoutMs: 1234, eventsFile: 'ev.jsonl', readFile: () => '', removeFile: () => {} });
  const a = tap.calls[0].args;
  assert.ok(a.includes(`--test-timeout=${runner.backstopMs(1234)}`), a.join(' '));
  assert.ok(runner.backstopMs(1234) > 1234, 'node --test\'s own timeout is only the backstop, after the watchdog\'s tree kill');
  const reporters = a.flatMap((x, i) => (x === '--test-reporter' ? [a[i + 1]] : []));
  const dests = a.flatMap((x, i) => (x === '--test-reporter-destination' ? [a[i + 1]] : []));
  assert.strictEqual(reporters[0], 'tap', 'off a terminal the gate logs keep TAP (node --test\'s own default)');
  assert.strictEqual(dests[0], 'stdout');
  assert.strictEqual(path.basename(reporters[1]), 'file-timeout-reporter.cjs');
  assert.strictEqual(dests[1], 'ev.jsonl');
  const tty = fakeSpawn({ status: 0 });
  run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: tty.spawn, log: () => {}, isTTY: true, readFile: () => '', removeFile: () => {} });
  assert.strictEqual(tty.calls[0].args[tty.calls[0].args.indexOf('--test-reporter') + 1], 'spec', 'on a terminal: spec, as before');
});

test('the limit: TEST_FILE_TIMEOUT_MS when it is a positive integer, else the generous default', () => {
  assert.strictEqual(runner.fileTimeoutMs({}), runner.FILE_TIMEOUT_MS);
  assert.ok(runner.FILE_TIMEOUT_MS >= 25 * 60_000, 'above the longest explicit per-test timeout in the suite (25 min)');
  assert.strictEqual(runner.fileTimeoutMs({ TEST_FILE_TIMEOUT_MS: '90000' }), 90_000);
  for (const bad of ['0', '-5', 'abc', '1.5', '']) assert.strictEqual(runner.fileTimeoutMs({ TEST_FILE_TIMEOUT_MS: bad }), runner.FILE_TIMEOUT_MS, bad);
});

test('a recorded file timeout is NAMED and fails the run, even when node --test itself exits 0', () => {
  const rec = (file) => JSON.stringify({ file, message: 'timed out' });
  // The reporter's record file (node --test's backstop) and the watchdog's (the tree kill): the
  // runner reads both, and one file named by both is ONE timed-out file.
  const files = { ev: `${rec('C:/r/test/hung.test.cjs')}\n{torn`, 'ev.watchdog': `${rec('C:/r/test/hung.test.cjs')}\n${rec('C:/r/test/other.test.cjs')}\n` };
  for (const status of [0, 1]) {
    const e = sink();
    const removed = [];
    let stopped = 0;
    const code = run({ testDir: 'test', readdir: () => ['hung.test.cjs', 'other.test.cjs'], spawn: fakeSpawn({ status }).spawn, log: () => {}, err: e.write, timeoutMs: 5000, eventsFile: 'ev', readFile: (p) => files[p] ?? '', removeFile: (p) => removed.push(p), watchdog: () => ({ stop: () => { stopped += 1; } }) });
    assert.notStrictEqual(code, 0, `status ${status}: a hung file never passes`);
    assert.match(e.lines.join('\n'), /FILE TIMED OUT after 5000 ms .*hung\.test\.cjs/);
    assert.match(e.lines.join('\n'), /FILE TIMED OUT after 5000 ms .*other\.test\.cjs/);
    assert.match(e.lines.join('\n'), /2 test file\(s\) timed out - the run FAILS/, 'merged and de-duplicated');
    assert.deepStrictEqual(removed.sort(), ['ev', 'ev.watchdog'], 'both record files are cleaned up');
    assert.strictEqual(stopped, 1, 'the watchdog is stopped once the run ends');
  }
  const clean = sink();
  assert.strictEqual(run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: fakeSpawn({ status: 0 }).spawn, log: () => {}, err: clean.write, readFile: () => '', removeFile: () => {} }), 0);
  assert.doesNotMatch(clean.lines.join('\n'), /TIMED OUT/);
});

test('the timeout reporter records every failure while retaining exactly one file-level timeout record', async () => {
  const reporter = require('./tools/file-timeout-reporter.cjs');
  const F = 'C:\\r\\test\\x.test.cjs';
  const fail = (data) => ({ type: 'test:fail', data });
  const events = [
    fail({ name: F, file: F, nesting: 0, details: { error: { failureType: 'testTimeoutFailure', message: 'test timed out after 5ms' } } }),
    fail({ name: 'a slow test', file: F, nesting: 0, details: { error: { failureType: 'testTimeoutFailure' } } }),
    fail({ name: F, file: F, nesting: 0, details: { error: { failureType: 'testCodeFailure' } } }),
    fail({ name: F, file: F, nesting: 1, details: { error: { failureType: 'testTimeoutFailure' } } }),
    { type: 'test:pass', data: { name: F, file: F, nesting: 0 } }
  ];
  async function* source() { for (const e of events) yield e; }
  const out = [];
  for await (const chunk of reporter(source())) out.push(chunk);
  const records = out.map(JSON.parse);
  assert.strictEqual(records.filter((r) => r.file && r.message).length, 1);
  assert.deepStrictEqual(records.find((r) => r.file && r.message), { file: F, message: 'test timed out after 5ms' });
  assert.deepStrictEqual(records.filter((r) => r.failure).map((r) => r.failure.name), [F, 'a slow test', F, F]);
});

// THE rc/1.1.76 HANG, for real: a ConPTY killed before its first output (node-pty defers the kill
// until then), so the file's process never exits and its conhost is NOT in node's kill-on-close job.
// Plus a plain child process. After the run, nothing the hung file started may still be running.
const NODE_PTY = path.join(REPO, 'node_modules', 'node-pty');
const HAS_PTY = process.platform === 'win32' && fs.existsSync(NODE_PTY);

// TEST-GLOB-PID-RECYCLE: the hung file records its pid AND birth, and only what that process started is
// listed or killed. ParentProcessId alone once listed the Human's HWiNFO64.EXE (an older process whose
// long-gone parent had the same pid) and process.kill'ed it.
const own = require('./tools/own-procs.cjs');
const { readRec } = own;
/** What a hung file left running: its own tree (own-procs ownTree), killed (verified) so a red run strands nothing.
 *  A record that cannot be right (an OLDER process under the pid) throws: never an empty, vacuous list. */
function leftBehind(rec) {
  const { tree } = own.ownTreeOrThrow(own.processTable(), rec);
  own.killVerified(tree);
  return tree.map((r) => `${r.pid} ${r.name}`);
}
/** The hung file's node child: gone, or (polled 5 s) still ours. A pid that now belongs to another process is gone. */
function childStillRunning(rec) {
  const { spawnSync } = require('node:child_process');
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) { try { process.kill(rec.pid, 0); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']); } catch { alive = false; } }
  if (!alive || process.platform !== 'win32') return alive;
  const { root } = own.ownTreeOrThrow(own.processTable(), rec);
  if (root) own.killVerified([root]);
  return !!root;
}

/**
 * GATE-178 (re-gate round 3, both sides, 2026-10-02): every assertion of the END TO END test passed,
 * then its cleanup threw EBUSY: a process of the killed tree still had the temp folder in use, and
 * the old cleanup gave it 5 x 200 ms. Process teardown on a loaded machine can take longer than
 * that. The folder is removed once it is FREE, waiting up to `budgetMs` (counted); only a folder
 * still in use after that is a failure, and it names the processes still running.
 */
const CLEANUP_BUDGET_MS = 30_000;
function removeWhenFree(dir, { budgetMs = CLEANUP_BUDGET_MS, rm = (d) => fs.rmSync(d, { recursive: true, force: true }), now = Date.now, pause = () => require('node:child_process').spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']) } = {}) {
  const t0 = now();
  for (;;) {
    try { rm(dir); return { removed: true, waitedMs: now() - t0 }; } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
      if (now() - t0 >= budgetMs) return { removed: false, waitedMs: now() - t0, code: err.code };
    }
    pause();
  }
}

/** The processes started in the last `seconds` (for the message when a folder stays in use). */
function recentProcesses(seconds = 120) {
  try {
    return require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -gt (Get-Date).AddSeconds(-${seconds}) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }`],
    { encoding: 'utf8', windowsHide: true, env: require('./tools/ps-env.cjs').psEnv() }).split(/\r?\n/).filter(Boolean).join(', ');
  } catch (e) { return `(no process list: ${e.message})`; }
}

test('GATE-178: the temp folder of a killed tree is removed once free, not after a fixed 1 s; a folder still in use past the budget fails', { timeout: 60_000 }, () => {
  const os = require('node:os');
  const { spawn, spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-'));
  // A process whose working directory IS the folder, ending 2 s from now: a slow teardown.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  try {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']);
    if (process.platform === 'win32') {
      assert.throws(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), (e) => e.code === 'EBUSY',
        'the old cleanup (5 x 200 ms) fails on a folder that is in use for 2 s');
    }
    const r = removeWhenFree(dir);
    assert.equal(r.removed, true, `A FOLDER FREED WITHIN THE BUDGET IS REMOVED (${JSON.stringify(r)})`);
    assert.equal(fs.existsSync(dir), false);
    // ...and one that never frees is reported, not waited on for ever.
    let t = 0;
    const never = removeWhenFree('x', { budgetMs: 1_000, rm: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }, now: () => t, pause: () => { t += 250; } });
    assert.deepEqual(never, { removed: false, waitedMs: 1_000, code: 'EBUSY' }, 'A FOLDER STILL IN USE PAST THE BUDGET IS REPORTED');
    assert.throws(() => removeWhenFree('x', { rm: () => { const e = new Error('nope'); e.code = 'EACCES'; throw e; } }), /nope/, 'any other error is thrown at once');
  } finally {
    try { holder.kill(); } catch { /* gone */ }
    removeWhenFree(dir);
  }
});

test('END TO END: a file that finishes its tests but never exits is killed at the limit with its WHOLE tree (ConPTY conhost too), NAMED, fails the run', { timeout: 120_000 }, () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-timeout-'));
  let failed = null;
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const filePidFile = path.join(dir, 'file.pid');
    fs.writeFileSync(path.join(dir, 'a-hung.test.cjs'), [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "test('done, but a handle, a child and (win32) a ConPTY killed before its first output stay', async () => {",
      "  const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, c.pid + ' ' + Date.now());`,
      `  fs.writeFileSync(${JSON.stringify(filePidFile)}, process.pid + ' ' + Math.round(Date.now() - process.uptime() * 1000));`,
      ...(HAS_PTY ? [
        `  const bat = ${JSON.stringify(path.join(dir, 'silent.bat'))};`,
        "  fs.writeFileSync(bat, '@echo off\\r\\nping -n 60 127.0.0.1 >nul\\r\\necho hi\\r\\n');",
        `  const p = require(${JSON.stringify(NODE_PTY)}).spawn('cmd.exe', ['/c', bat], { cols: 80, rows: 24 });`,
        '  await new Promise((r) => setTimeout(r, 300));',
        '  p.kill();   // deferred by node-pty until the first output, which never comes',
      ] : []),
      '  setInterval(() => {}, 1000);',
      '});'
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b-ok.test.cjs'), "require('node:test')('ok', () => {});\n");
    const e = sink();
    let out = '';
    // Captured, so the inner TAP never mixes into this file's own report.
    const spawn = (args, opts) => { const r = spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8' }); out = r.stdout; return r; };
    const t0 = Date.now();
    const code = run({ testDir: dir, cwd: dir, spawn, timeoutMs: 4_000, isTTY: false, log: () => {}, err: e.write, failureFile: () => path.join(dir, 'failures.json') });
    assert.notStrictEqual(code, 0, 'a hung file fails the run');
    assert.ok(Date.now() - t0 < 60_000, `ended at the limit, not never (${Date.now() - t0} ms)`);
    assert.match(e.lines.join('\n'), /FILE TIMED OUT after 4000 ms .*a-hung\.test\.cjs/);
    assert.doesNotMatch(e.lines.join('\n'), /b-ok/, 'only the hung file is named');
    assert.match(out, /^ok \d+ - ok$/m, 'the healthy file still ran and passed');
    assert.strictEqual(childStillRunning(readRec(pidFile, 'node.exe')), false, 'the hung file\'s child process was killed with it');
    // The file's own children (the ConPTY conhost among them) are gone too, not orphaned.
    const left = leftBehind(readRec(filePidFile, 'node.exe'));
    assert.deepStrictEqual(left, [], `the hung file's process tree outlived the run: ${left.join(', ')}`);
    if (HAS_PTY) assert.match(e.lines.join('\n'), /FILE TIMED OUT/, 'the ConPTY case is the real one');
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    // GATE-178: removed once free; still in use after the budget = a process of the tree outlived
    // the run. A failed assertion above is never masked by the cleanup.
    const r = removeWhenFree(dir);
    if (!r.removed && !failed) assert.fail(`the hung file's temp folder was still in use ${r.waitedMs} ms after the run (${r.code}); recent processes: ${recentProcesses()}`);
  }
});

test('it announces the count, so a reader can tell work happened', () => {
  const l = sink();
  const { spawn } = fakeSpawn({ status: 0 });
  run({ testDir: 'test', readdir: () => ['a.test.cjs', 'b.test.cjs'], spawn, log: l.write });
  assert.match(l.lines.join('\n'), /running 2 test files/);
});

test('a failing child suite propagates its exit code verbatim', () => {
  const { spawn } = fakeSpawn({ status: 7 });
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, log: () => {} });
  assert.strictEqual(code, 7);
});

test('a child killed by a signal is a failure, not a pass', () => {
  const { spawn } = fakeSpawn({ status: null, signal: 'SIGTERM' });
  const e = sink();
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, err: e.write, log: () => {} });
  assert.notStrictEqual(code, 0);
  assert.match(e.lines.join('\n'), /SIGTERM/);
});

test('a spawn that never starts is a failure, not a pass', () => {
  const { spawn } = fakeSpawn({ error: new Error('ENOENT'), status: null });
  const code = run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn, err: () => {}, log: () => {} });
  assert.notStrictEqual(code, 0);
});

test('an unreadable test directory is a failure, not an empty pass', () => {
  const { spawn, calls } = fakeSpawn();
  const code = run({
    testDir: 'test', spawn, err: () => {}, log: () => {},
    readdir: () => { throw new Error('ENOENT'); }
  });
  assert.notStrictEqual(code, 0);
  assert.strictEqual(calls.length, 0);
});

test('PIN: package.json test:focused invokes the runner and carries no shell glob', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const script = pkg.scripts['test:focused'];
  assert.ok(script, 'test:focused must exist');
  assert.ok(!script.includes('*'), `test:focused must not rely on shell glob expansion: ${script}`);
  assert.match(script, /run-tests\.cjs/);
});

test('PIN: against the REAL test directory discovery is root tests plus only folded feature tests', () => {
  const files = runner.discoverTestFiles(TEST_DIR);
  const direct = selectTestFiles(fs.readdirSync(TEST_DIR)).files;
  const folded = runner.FEATURE_TEST_DIRS.flatMap((dir) => fs.readdirSync(path.join(TEST_DIR, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(runner.TEST_SUFFIX))
    .map((entry) => path.join(dir, entry.name)));
  assert.ok(files.includes('test-runner-glob.test.cjs'), 'the runner must pick up its own test');
  // int-1.1.91: 430 on repo-tidy-191, + 6 root tests from the other 1.1.91 branches (cards x2,
  // claude-json-wipe, model-not-kept x2, worktree-remove-junction), + 2 (requests-auto-190,
  // tui-composer-allowlist-191), + 1 (nudge-cap-192), + 3 (heavy-cpu-options-191: harness, options,
  // settings), + 1 (load-flakes-178-file-job), + 1 (wake-stall-interfered-192), + 1 (wake-owner-hold-orphan-191),
  // + 1 (f11-epoch-closed-in-flight-191). 1.1.93: + 1 (startup-latch-quiet-193). 1.1.94: + 1 (god-terminal-control-193).
  // 1.1.96: + 1 (agent-env-nodefaultcwd-193), + 1 (fs-ipc-root-trust-192), + 1 (mutant-dir-helper-195),
  // + 1 (mirror-startup-196), + 1 (agy-monitor-14), + 1 (gtc-m2-196), + 1 (heavy-lock-opaque-196), + 1 (heavy-lock-shell-keyword-196).
  // 1.1.97: + 2 (gtc-m3 fully-idle and message-box), + 1 (heavy-lock-glob-loop-196), + 1 (gtc-m4-wake-197),
  // + 0 (agy-mutants-drift-197 updates an existing mutant census only).
  // + 1 (load-burst-196).
  // + 1 (build-leftovers-username-197).
  // 1.1.98: + 1 (screen-guard-alert-floor-193), + 1 (heavy-lock-release-lag-197),
  // + 1 (heavy-lock-reservation-release-198), + 1 (mutant-runner-kill-safe-197),
  // + 1 (heavy-lock-false-heavy-198).
  // 1.1.98 stage 3: + 1 (heavy-slot-exclusive-192), + 1 (needs-human-192), + 1 (hook-token-writers-192),
  // ZT-I2-CONDENSE: - 3 (hidden-claude, reflect-condense, reflect-heading-demote retired),
  // + 2 (memory-rollover-stop-zti2, zt-i2-retired-condense); + 0 (wakeup-wing-wrong-set-191), + 1 (hop-cap-192).
  // + 1 (heavy-lock-live-file-192).
  // 1.1.98 stage 4: + 1 (heavy-lock-cmd-for-198), + 1 (ps-modcache-leak), + 1 (inbound-bind-loopback-198).
  // 1.1.98 stage 5: + 1 (onbinary-drop), + 1 (test-temp-hygiene).
  // 1.1.98 stage 6: + 1 (heavy-lock-cmd-quoted-caret-198), + 1 (heavy-lock-single-file-denial-198).
  // 1.1.98 stage 7: + 1 (heavy-lock-subshell-198).
  // 1.1.98 stage 8: + 1 (pricing-cache-ttl-proxy-pin), + 1 (heavy-lock-positional-198), + 1 (heavy-lock-exec-positional-198).
  // HIVE-DWIGHT-BG-REINVOKE: + 2 (owed-continuation-198, owed-continuation-rig-198).
  // 1.1.98 stage 10: + 1 (cut-cmd-natives-198), + 1 (fleet-codex-activity), with REINVOKE above.
  // 1.1.98 stage 11: + 1 (hook-type-guard-198).
  // 1.1.98 stage 12: + 1 (electron-view-self-heal-198), + 1 (tasks-json-split-198), + 1 (release-worktrees-198).
  // ANDY-PTY-EXIT-2049: + 1 (pty-exit-record-198).
  // BRANCH-RELATED-PINS-RUN: + 1 (related-tests-198).
  // WORK-JUNCTION-DEBT step 3: + 1 (no-nm-junction-198).
  // 1.1.98 stage 18: + 1 (app-shallow-selector), + 1 (perf-151-nits).
  // 1.1.98 stage 19: + 1 (card-autodone). Stage 20: + 1 (stall-watch-198).
  // 1.1.98 stage 21: + 1 (wake-refusal-stuck).
  // WAKE-LIFECYCLE-UNKNOWN-197: + 1 (wake-stale-loading-header-197).
  // INT 1.1.99 (re-pinned once for the merged tree, 499 + 9):
  // QUIET-HOLD-ACT-ONLY: + 1 (quiet-hold-act-198), + 1 (mail-rig-quiet-198).
  // PS-POLICY-TEMP-LEAK: + 1 (ps-policy-temp-leak-198).
  // NEW-FLOOR-KNOWHOW: + 1 (new-floor-knowhow).
  // CODEX-ROLLOUT-SIZE: + 1 (codex-live-rotation).
  // WAKE-FALSE-INTERFERED-RESTART: + 1 (wake-false-interfered-198), + 1 (mail-rig-held-198).
  // HEAVY-LOCK-VARPATH-READ: + 1 (heavy-lock/heavy-lock-varpath-198).
  // UI-CRAWL fix: + 1 (ui-crawl-fix-198).
  // INT 1.1.100: NEW-FLOOR-CLEAN-SLATE: + 1 (new-floor-clean-slate).
  // CHANGELOG-HEADINGS-GATE: + 1 (changelog-history-gate).
  // HEAVY-LOCK-FALSE-POSITIVE: + 1 (heavy-lock/heavy-lock-false-positive-199).
  // HEAVY-HANDOFF-RACE: + 1 (heavy-lock/heavy-lock-handoff-race-199), + 1 (heavy-lock/heavy-lock-release-held-199).
  // HEAVY-LOCK-FALSE-NEGATIVES: + 5 (heavy-lock/heavy-lock-false-negatives-199, -false-negatives-rest-199,
  // -release-closed-199, -ttl-blind-199, -hhr-nits-199).
  // HEAVY-ELECTRON-TAG: + 1 (heavy-lock/heavy-lock-electron-tag-1101).
  // INT 1.1.101: MAIN-SYNC config cache: + 1 (config-read-cache).
  // MAIN-SYNC config write bases: + 1 (config-write-base).
  // RENDERER-CONFIG-RMW: + 1 (renderer-config-rmw-101).
  // MAIN-SYNC registry cache: + 1 (registry-read-cache).
  // MAIN-SYNC tasks cache: + 1 (tasks-read-cache).
  // MAIN-SYNC voice task writes by id: + 1 (voice-task-cache).
  // INT 1.1.102 (re-pinned once for the merged tree, 525 + 5):
  // HEAVY-CPU-CAP-199: + 1 (capped-render-lane-198); HALFCORES-OVERSUBSCRIBE: + 1 (harness-progress-199).
  // HERO-FEED-BRANCH live release line: + 1 (hero-feed-branch).
  // CODEX-MCP-ISOLATION: + 1 (codex-mcp-isolation).
  // AGY-TEARDOWN: + 1 (agy-teardown-tree-102).
  // CLAIMS-90 M1 compact memory output: + 1 (claims90-m1-compact).
  // CLAIMS-90 M3a lead line per claim hit: + 1 (claims90-m3a-lead).
  // CLAIMS-90 HISTORY-PTR: + 1 (claims90-history-ptr).
  // C90-MAILCARD: + 1 (claims90-mailcard).
  // C90-GET: + 3 (claims90-get, claims90-search-modes, claims90-get-paths); C90-FACTS M5: + 1 (claims-derived-m5).
  // CLAIMS-90 step 3 fix R1/R2 (god bbcb4a): + 1 (claims90-step3-lead).
  // CLAIMS-90 step 3 runner branch (not merged): + 3 (claims-90-runner, claims-90-labeller, claims-90-answerer-get).
  // CLAIMS-90 search S3/S4 data side (Creed 15b4c1c5): + 1 (claims-search-targets).
  // CLAIMS-DEFAULT new floor on the ledger (god bb3f5b): + 1 (claims-ledger-default).
  // CLAIMS-90 weaklink / keyfind / follow-ups / brief cost (god 79d690): + 4 (claims90-weaklink-donesha, claims90-keyfind,
  // claims90-keyfind-followups, claims90-brief-cost).
  // CLAIMS-90 round 9 (god a77298): + 1 (claims90-r9).
  assert.equal(files.length, 554,`the focused suite must retain its pre-fold file count, got ${files.length}`);
  assert.deepStrictEqual([...files].sort(), [...direct, ...folded].sort(), 'the complete focused set is the root set plus the 16 folded tests');
  assert.ok(files.includes(path.join('heavy-lock', 'heavy-lock-adhoc-node.test.cjs')), 'the heavy-lock feature folder is included');
  assert.ok(files.includes(path.join('start-fixes-163', 'start-fixes-163-boot-submit.test.cjs')), 'the start-fixes feature folder is included');
  assert.ok(!files.some((file) => file.startsWith(`claims-gates${path.sep}`)), 'claims gates are not a focused-suite feature folder');
  assert.ok(!files.includes('tools'), 'directories are not test files');
});

test('PIN: the runner stays out of the shipped app - it lives under test/', () => {
  const rel = path.relative(REPO, require.resolve('./tools/run-tests.cjs')).replace(/\\/g, '/');
  assert.ok(rel.startsWith('test/'), `runner must live under test/, found at ${rel}`);
});

test('watchdog: picks ONLY a test-file process under the runner\'s node --test that is past the limit', () => {
  const { dueFiles, fileOf } = require('./tools/file-watchdog.cjs');
  const now = 1_000_000;
  const P = (pid, ppid, name, cmd, age) => ({ pid, ppid, name, cmd, startedAt: now - age });
  const procs = [
    P(10, 1, 'node.exe', 'node run-tests.cjs', 999_999),
    P(20, 10, 'node.exe', 'node.exe --test --test-timeout=9 a.test.cjs b.test.cjs', 900_000),
    P(30, 20, 'node.exe', 'node.exe C:/r/test/hung.test.cjs', 6_000),      // past the 5 s limit
    P(31, 20, 'node.exe', 'node.exe C:/r/test/young.test.cjs', 1_000),     // still within it
    P(32, 30, 'conhost.exe', 'conhost.exe --headless', 6_000),             // a grandchild: the tree kill takes it
    P(40, 99, 'node.exe', 'node.exe --test other.test.cjs', 900_000),      // another runner's suite
    P(41, 40, 'node.exe', 'node.exe C:/o/test/old.test.cjs', 900_000)
  ];
  assert.deepStrictEqual(dueFiles(procs, 10, 5_000, now), [{ pid: 30, file: 'C:/r/test/hung.test.cjs', ageMs: 6_000 }]);
  assert.deepStrictEqual(dueFiles(procs, 10, 60_000, now), [], 'nothing past a longer limit');
  assert.deepStrictEqual(dueFiles(procs, 12345, 1, now), [], 'never another runner\'s tree');
  assert.strictEqual(fileOf('node.exe --x "C:/a b/test/q.test.cjs"'), 'C:/a b/test/q.test.cjs', 'a quoted path keeps its spaces');
  assert.strictEqual(fileOf('node.exe C:/r/test/q.test.cjs'), 'C:/r/test/q.test.cjs');
  assert.strictEqual(fileOf('node.exe -e 1'), null);
});

test('watchdog: a due file is RECORDED before its tree is killed, once, and named even if the kill fails', () => {
  // The kill ends the file, node --test returns and the runner stops the watchdog at once: a record
  // written after a slow taskkill was lost (1.1.76 final gate #4, round 3/a, a run that named no file).
  const { killDue } = require('./tools/file-watchdog.cjs');
  const order = [];
  const killed = new Set();
  const opts = { killed, record: (d) => order.push(`record ${d.file}`), kill: (pid) => { order.push(`kill ${pid}`); if (pid === 31) throw new Error('gone'); return { by: 'job' }; },
    outcome: (d, r) => order.push(`outcome ${d.file} ${r.by}`) };
  killDue([{ pid: 30, file: 'a.test.cjs', ageMs: 6 }, { pid: 31, file: 'b.test.cjs', ageMs: 6 }], opts);
  killDue([{ pid: 30, file: 'a.test.cjs', ageMs: 7 }], opts);
  // Jim NIT-1: what the kill did is written after it; a kill that threw is 'none', never 'killed'.
  assert.deepStrictEqual(order, ['record a.test.cjs', 'kill 30', 'outcome a.test.cjs job', 'record b.test.cjs', 'kill 31', 'outcome b.test.cjs none']);
});

test('END TO END, the backstop alone (no watchdog): node --test\'s own file timeout is NAMED through the timeout reporter', { timeout: 120_000 }, () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-backstop-'));
  try {
    fs.writeFileSync(path.join(dir, 'a-hung.test.cjs'), "require('node:test')('done', () => { setInterval(() => {}, 1000); });\n");
    const e = sink();
    const spawn = (args, opts) => spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8' });
    const code = run({ testDir: dir, cwd: dir, spawn, timeoutMs: 3_000, isTTY: false, log: () => {}, err: e.write, failureFile: () => path.join(dir, 'failures.json'), watchdog: () => ({ stop: () => {} }) });
    assert.notStrictEqual(code, 0, 'a hung file fails the run');
    assert.match(e.lines.join('\n'), /FILE TIMED OUT after 3000 ms .*a-hung\.test\.cjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog: parses PowerShell\'s process rows (one row or many, /Date(ms)/ start times)', () => {
  const { parseRows } = require('./tools/file-watchdog.cjs');
  const one = parseRows('{"ProcessId":5,"ParentProcessId":4,"Name":"node.exe","CommandLine":"node x.test.cjs","CreationDate":"/Date(1700000000000)/"}');
  assert.deepStrictEqual(one, [{ pid: 5, ppid: 4, name: 'node.exe', cmd: 'node x.test.cjs', startedAt: 1700000000000 }]);
  assert.strictEqual(parseRows('[{"ProcessId":1,"ParentProcessId":0,"Name":"a","CommandLine":null,"CreationDate":null},{"ProcessId":2,"ParentProcessId":1,"Name":"b","CommandLine":"c","CreationDate":"/Date(5)/"}]').length, 2);
  assert.deepStrictEqual(parseRows('not json'), []);
});

test('watchdog timing: polls at a tenth of the limit (1-30 s); node --test\'s backstop is three polls later, never under 20 s', () => {
  assert.strictEqual(runner.watchdogPollMs(4_000), 1_000);
  assert.strictEqual(runner.watchdogPollMs(30 * 60_000), 30_000);
  assert.strictEqual(runner.backstopMs(30 * 60_000), 30 * 60_000 + 90_000, 'the production margin is unchanged');
  assert.strictEqual(runner.BACKSTOP_MIN_MARGIN_MS, 20_000);
  for (const limit of [1_000, 4_000, 60_000, 200_000]) {
    assert.ok(runner.backstopMs(limit) - limit >= 20_000, `GATE-178: THE BACKSTOP LEAVES A SLOW SNAPSHOT TIME (limit ${limit} ms: margin ${runner.backstopMs(limit) - limit} ms)`);
  }
});

test('GATE-178: a watchdog whose snapshot is 8 s late still TREE-kills a hung ConPTY file before the backstop (no orphaned conhost)', { timeout: 120_000, skip: !HAS_PTY && 'needs node-pty on win32' }, () => {
  const os = require('node:os');
  const { spawn, spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-late-'));
  let failed = null;
  let wrapper = null;
  try {
    const filePidFile = path.join(dir, 'file.pid');
    fs.writeFileSync(path.join(dir, 'a-hung.test.cjs'), [
      "const test = require('node:test');",
      "const fs = require('node:fs');",
      "test('a ConPTY killed before its first output, and a handle', async () => {",
      `  fs.writeFileSync(${JSON.stringify(filePidFile)}, process.pid + ' ' + Math.round(Date.now() - process.uptime() * 1000));`,
      `  const bat = ${JSON.stringify(path.join(dir, 'silent.bat'))};`,
      "  fs.writeFileSync(bat, '@echo off\\r\\nping -n 60 127.0.0.1 >nul\\r\\n');",
      `  const p = require(${JSON.stringify(NODE_PTY)}).spawn('cmd.exe', ['/c', bat], { cols: 80, rows: 24 });`,
      '  await new Promise((r) => setTimeout(r, 300));',
      '  p.kill();',
      '  setInterval(() => {}, 1000);',
      '});'
    ].join('\n'));
    const e = sink();
    // The real watchdog, started 8 s late: a slow PowerShell snapshot under load (9.6 s seen), and
    // past the old backstop (limit + 3 polls = 7 s), so only the 20 s floor lets the tree kill win.
    const lateWatchdog = (limitMs, outFile) => {
      const args = [runner.WATCHDOG, String(process.pid), String(limitMs), outFile, String(runner.watchdogPollMs(limitMs))];
      wrapper = spawn(process.execPath, ['-e', `setTimeout(() => { const c = require('child_process').spawn(process.execPath, ${JSON.stringify(args)}, { stdio: 'ignore', windowsHide: true }); c.on('exit', () => process.exit(0)); }, 8000);`], { stdio: 'ignore', windowsHide: true });
      const rec = { pid: wrapper.pid, bornMs: Date.now(), name: 'node.exe' };
      // the wrapper and the watchdog it started: its own tree, verified (not taskkill /T: TEST-GLOB-PID-RECYCLE)
      return { stop: () => { try { own.killOwnTree(rec); } catch { /* gone */ } } };
    };
    const spawnTap = (args, opts) => spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8' });
    const code = run({ testDir: dir, cwd: dir, spawn: spawnTap, timeoutMs: 4_000, isTTY: false, log: () => {}, err: e.write, failureFile: () => path.join(dir, 'failures.json'), watchdog: lateWatchdog });
    assert.notStrictEqual(code, 0, 'a hung file fails the run');
    const left = leftBehind(readRec(filePidFile, 'node.exe'));
    assert.deepStrictEqual(left, [], `A LATE WATCHDOG STILL TREE-KILLS FIRST: the hung file's tree outlived the run: ${left.join(', ')}`);
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    const r = removeWhenFree(dir);
    if (!r.removed && !failed) assert.fail(`the temp folder was still in use ${r.waitedMs} ms after the run (${r.code}); recent processes: ${recentProcesses()}`);
  }
});
