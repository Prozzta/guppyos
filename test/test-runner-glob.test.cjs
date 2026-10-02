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
const { selectTestFiles, run } = runner;

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

test('the timeout reporter records ONLY a file-level timeout (not a per-test timeout, not a plain failure)', async () => {
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
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(JSON.parse(out[0]), { file: F, message: 'test timed out after 5ms' });
});

// THE rc/1.1.76 HANG, for real: a ConPTY killed before its first output (node-pty defers the kill
// until then), so the file's process never exits and its conhost is NOT in node's kill-on-close job.
// Plus a plain child process. After the run, nothing the hung file started may still be running.
const NODE_PTY = path.join(REPO, 'node_modules', 'node-pty');
const HAS_PTY = process.platform === 'win32' && fs.existsSync(NODE_PTY);

function childrenOf(pid) {
  const { execFileSync } = require('node:child_process');
  if (process.platform !== 'win32') return [];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', windowsHide: true });
  return out.split(/\r?\n/).filter(Boolean);
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
    { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean).join(', ');
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
      `  fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      `  fs.writeFileSync(${JSON.stringify(filePidFile)}, String(process.pid));`,
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
    const code = run({ testDir: dir, cwd: dir, spawn, timeoutMs: 4_000, isTTY: false, log: () => {}, err: e.write });
    assert.notStrictEqual(code, 0, 'a hung file fails the run');
    assert.ok(Date.now() - t0 < 60_000, `ended at the limit, not never (${Date.now() - t0} ms)`);
    assert.match(e.lines.join('\n'), /FILE TIMED OUT after 4000 ms .*a-hung\.test\.cjs/);
    assert.doesNotMatch(e.lines.join('\n'), /b-ok/, 'only the hung file is named');
    assert.match(out, /^ok \d+ - ok$/m, 'the healthy file still ran and passed');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) { try { process.kill(pid, 0); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']); } catch { alive = false; } }
    if (alive) { try { process.kill(pid); } catch { /* gone */ } }
    assert.strictEqual(alive, false, 'the hung file\'s child process was killed with it');
    // The file's own children (the ConPTY conhost among them) are gone too, not orphaned.
    const left = childrenOf(Number(fs.readFileSync(filePidFile, 'utf8')));
    for (const l of left) { try { process.kill(Number(l.split(' ')[0])); } catch { /* gone */ } }
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

test('PIN: against the REAL test directory the runner selects this file and many more', () => {
  const { files } = selectTestFiles(fs.readdirSync(TEST_DIR));
  assert.ok(files.includes('test-runner-glob.test.cjs'), 'the runner must pick up its own test');
  assert.ok(files.length > 100, `expected the whole suite, got ${files.length}`);
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
    P(32, 30, 'conhost.exe', 'conhost.exe --headless', 6_000),             // a grandchild: taskkill /T takes it
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
  const opts = { killed, record: (d) => order.push(`record ${d.file}`), kill: (pid) => { order.push(`kill ${pid}`); if (pid === 31) throw new Error('gone'); } };
  killDue([{ pid: 30, file: 'a.test.cjs', ageMs: 6 }, { pid: 31, file: 'b.test.cjs', ageMs: 6 }], opts);
  killDue([{ pid: 30, file: 'a.test.cjs', ageMs: 7 }], opts);
  assert.deepStrictEqual(order, ['record a.test.cjs', 'kill 30', 'record b.test.cjs', 'kill 31']);
});

test('END TO END, the backstop alone (no watchdog): node --test\'s own file timeout is NAMED through the timeout reporter', { timeout: 120_000 }, () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-backstop-'));
  try {
    fs.writeFileSync(path.join(dir, 'a-hung.test.cjs'), "require('node:test')('done', () => { setInterval(() => {}, 1000); });\n");
    const e = sink();
    const spawn = (args, opts) => spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8' });
    const code = run({ testDir: dir, cwd: dir, spawn, timeoutMs: 3_000, isTTY: false, log: () => {}, err: e.write, watchdog: () => ({ stop: () => {} }) });
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
      `  fs.writeFileSync(${JSON.stringify(filePidFile)}, String(process.pid));`,
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
      return { stop: () => { try { spawnSync('taskkill', ['/T', '/F', '/PID', String(wrapper.pid)], { windowsHide: true }); } catch { /* gone */ } } };
    };
    const spawnTap = (args, opts) => spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8' });
    const code = run({ testDir: dir, cwd: dir, spawn: spawnTap, timeoutMs: 4_000, isTTY: false, log: () => {}, err: e.write, watchdog: lateWatchdog });
    assert.notStrictEqual(code, 0, 'a hung file fails the run');
    const left = childrenOf(Number(fs.readFileSync(filePidFile, 'utf8')));
    for (const l of left) { try { process.kill(Number(l.split(' ')[0])); } catch { /* gone */ } }
    assert.deepStrictEqual(left, [], `A LATE WATCHDOG STILL TREE-KILLS FIRST: the hung file's tree outlived the run: ${left.join(', ')}`);
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    const r = removeWhenFree(dir);
    if (!r.removed && !failed) assert.fail(`the temp folder was still in use ${r.waitedMs} ms after the run (${r.code}); recent processes: ${recentProcesses()}`);
  }
});
