'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads run-tests.cjs, a file a census mutates in
// place; refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * CLAIMS-LEDGER-W6-SILENT-EXIT: a test file killed from outside reports itself.
 *
 * Found in a full suite: test/claims-ledger-memory-w6.test.cjs ended 792 ms after it started with
 * "exitCode: 1", no test output and not one stderr line; its 13 tests were missing from the totals.
 * Exit code 1 with no output is what TerminateProcess gives (taskkill /F, a job kill): another
 * file's kill by pid NUMBER hit it after Windows handed it a dead process's number
 * (SUITE-LOAD-FLAKES-1027 saw the same from agy-teardown-tree-102). node --test cannot tell that
 * from a file that called process.exit(1), so the run said nothing about the cause.
 *
 * Now each file's kills by number are recorded (file-backstop-preload.cjs, <starts>.kills), and the
 * runner names every file that started and never wrote its exit row, with the kill that named its
 * pid and the file that made it (endedWithoutExit in run-tests.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('./tools/run-tests.cjs');

const row = (o) => JSON.stringify(o);

test('endedWithoutExit: a start with no exit row is named; an exited file and a later owner of the same pid are not', () => {
  const starts = [
    row({ pid: 10, bornMs: 1000, file: 'ok.test.cjs', name: 'node.exe' }),
    row({ pid: 11, bornMs: 1100, file: 'victim.test.cjs', name: 'node.exe' }),
    row({ pid: 10, exited: true }),
    'a torn line {',
    row({ pid: 11, bornMs: 5000, file: 'later-same-pid.test.cjs', name: 'node.exe' }),
    row({ pid: 11, exited: true }),
    row({ pid: 12, bornMs: 6000, file: 'crashed.test.cjs', name: 'node.exe' }),
  ].join('\n');
  const kills = [
    row({ pid: 20, file: 'early.test.cjs', via: 'taskkill', targets: [11], t: 900 }),   // before the victim had the pid
    row({ pid: 21, file: 'killer.test.cjs', via: 'taskkill', targets: [7, 11], t: 1892 }),
    row({ pid: 22, file: 'late.test.cjs', via: 'process.kill', targets: [11], t: 5200 }), // the later owner's time
    'torn',
  ].join('\n');
  assert.deepEqual(runner.endedWithoutExit(starts, kills), [
    { pid: 11, file: 'victim.test.cjs', kills: [{ via: 'taskkill', file: 'killer.test.cjs', pid: 21, self: false, afterMs: 792 }] },
    { pid: 12, file: 'crashed.test.cjs', kills: [] },
  ]);
  assert.deepEqual(runner.endedWithoutExit('', ''), []);
  assert.deepEqual(runner.endedWithoutExit(undefined), []);
  assert.deepEqual(runner.endedWithoutExit(row({ pid: 5, bornMs: 1, file: 'self.test.cjs' }), row({ pid: 5, file: 'self.test.cjs', via: 'process.kill', targets: [5], t: 9 }))[0].kills[0].self, true);
});

test('runNodeTest says the cause on stderr, and never for a file one of the runner\'s own timeouts ended', () => {
  const files = {
    'ev.jsonl.starts': [row({ pid: 11, bornMs: 1000, file: 'victim.test.cjs' }), row({ pid: 12, bornMs: 1000, file: 'unknown.test.cjs' }), row({ pid: 13, bornMs: 1000, file: 'hung.test.cjs' })].join('\n'),
    'ev.jsonl.starts.kills': row({ pid: 21, file: 'killer.test.cjs', via: 'taskkill', targets: [11], t: 1792 }),
    'ev.jsonl.backstop': row({ file: 'hung.test.cjs', by: 'backstop', kill: 'job', message: 'BACKSTOP: killed through its job' }),
  };
  const e = []; const removed = [];
  runner.runNodeTest({ rel: ['x'], label: '', spawn: () => ({ status: 1 }), cwd: '.', timeoutMs: 5, isTTY: false, env: {},
    eventsFile: 'ev.jsonl', readFile: (f) => files[f] || '', removeFile: (f) => removed.push(f), watchdog: () => ({ stop: () => {} }),
    backstop: () => ({ opt: '', env: {}, stop: () => {} }), err: (l) => e.push(l) });
  const errs = e.join('\n');
  assert.match(errs, /FILE ENDED WITHOUT EXITING \(pid 11\): .*: victim\.test\.cjs/, 'THE KILLED FILE IS NAMED');
  assert.match(errs, /its pid 11 was named by a kill \(taskkill\) from killer\.test\.cjs \(pid 21\), 792 ms after it started/, 'THE KILL THAT HIT IT IS NAMED');
  assert.match(errs, /FILE ENDED WITHOUT EXITING \(pid 12\): .*: unknown\.test\.cjs\n.*no recorded kill names its pid 12/, 'a file no recorded kill named is still reported');
  assert.doesNotMatch(errs, /FILE ENDED WITHOUT EXITING \(pid 13\)/, 'a file the backstop ended is reported as timed out only');
  assert.ok(removed.includes('ev.jsonl.starts.kills'), 'the kills record is cleaned up');
});

test('END TO END: one test file force-kills another by pid; the run fails and names the victim, the kill and the killer', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killed106-'));
  const pidFile = path.join(dir, 'victim.pid');
  try {
    // The victim writes its pid and waits; it is alive and known when the killer names it, so this
    // kill by number hits the process it means.
    fs.writeFileSync(path.join(dir, 'a-victim.test.cjs'), [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "require('node:test')('never finishes', () => new Promise((r) => setTimeout(r, 60_000)));",
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'b-killer.test.cjs'), [
      "const fs = require('node:fs'); const cp = require('node:child_process');",
      "require('node:test')('kills the other file', async () => {",
      `  let pid = 0; for (let i = 0; i < 300 && !pid; i++) { try { pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8')); } catch { /* not yet */ } if (!pid) await new Promise((r) => setTimeout(r, 100)); }`,
      "  if (!pid) throw new Error('the victim never wrote its pid');",
      "  await new Promise((r) => setTimeout(r, 500));",
      "  if (process.platform === 'win32') cp.spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true }); else process.kill(pid, 'SIGKILL');",
      '});',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'c-ok.test.cjs'), "require('node:test')('ok', () => {});\n");
    const e = []; let out = '';
    const spawn = (args, opts) => { const r = spawnSync(process.execPath, args, { ...opts, stdio: 'pipe', encoding: 'utf8', timeout: 100_000, killSignal: 'SIGKILL' }); out = r.stdout; return r; };
    const code = runner.run({ testDir: dir, cwd: dir, spawn, timeoutMs: 90_000, isTTY: false, log: () => {}, err: (l) => e.push(l),
      failureFile: () => path.join(dir, 'failures.json'), eventsFile: path.join(dir, 'ev.jsonl'), watchdog: () => ({ stop: () => {} }), backstop: runner.startBackstop });
    const errs = e.join('\n');
    assert.notEqual(code, 0, 'a killed file fails the run');
    assert.match(out, /^ok \d+ - kills the other file$/m, 'the killer itself passed');
    assert.doesNotMatch(out, /never finishes/, 'the victim left no test output: this is the silent exit');
    assert.match(errs, /FILE ENDED WITHOUT EXITING \(pid \d+\): .*a-victim\.test\.cjs/, `THE KILLED FILE IS NAMED WITH ITS CAUSE:\n${errs}`);
    const via = process.platform === 'win32' ? 'taskkill' : 'process\\.kill';
    assert.match(errs, new RegExp(`its pid \\d+ was named by a kill \\(${via}\\) from .*b-killer\\.test\\.cjs \\(pid \\d+\\), \\d+ ms after it started`), `THE KILL AND THE FILE THAT MADE IT ARE NAMED:\n${errs}`);
    assert.doesNotMatch(errs, /(b-killer|c-ok)\.test\.cjs$/m, 'ONLY THE KILLED FILE IS REPORTED: files that exited are not');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('ev.jsonl')), [], 'the record files (the kills record among them) are cleaned up');
  } finally {
    for (let i = 0; i < 50; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); } }
  }
});

test('the preload leaves child_process as callers read it: names, util.promisify\'s form, and the real result', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-killed106-'));
  try {
    const out = path.join(dir, 'starts.jsonl');
    const opt = `--require "${runner.BACKSTOP_PRELOAD.split(path.sep).join('/')}"`;
    const script = [
      "const cp = require('node:child_process'); const util = require('node:util');",
      "const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'].map((n) => cp[n].name);",
      "try { process.kill(process.pid, 0); } catch { /* a probe is not a kill */ }",
      "util.promisify(cp.execFile)(process.execPath, ['-e', 'console.log(1)']).then((r) => {",
      "  const s = cp.spawnSync(process.execPath, ['-e', 'console.log(\"taskkill /pid 4242 is only text here\")'], { encoding: 'utf8' });",
      "  console.log(JSON.stringify({ names, promisified: Object.keys(r).sort(), sync: s.status }));",
      '});',
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', NODE_OPTIONS: opt, GUPPY_FILE_BACKSTOP: out, GUPPY_FILE_BACKSTOP_OPT: opt } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { names: ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'], promisified: ['stderr', 'stdout'], sync: 0 });
    const kills = fs.existsSync(`${out}.kills`) ? fs.readFileSync(`${out}.kills`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    assert.deepEqual(kills.map((k) => [k.via, k.targets]), [['taskkill', [4242]]], 'a liveness probe (signal 0) is not recorded; a command naming taskkill and a pid is');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
