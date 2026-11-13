'use strict';
require('./tools/own-job.cjs');
// MUTANT-RUNNERS-TAP-PARSE: every mutant runner reads its test runs through one parser,
// test/tools/mutant-tap.cjs (runTests + tapResult + verdict + requireBaseline). On Node >=23
// `node --test` defaults to the spec reporter, which prints no 'not ok' and no '# fail N', so a runner that
// parsed those saw nothing; and a runner that read only the exit code counted a run that never reported
// (a crash, a timeout, a refused slot) as a kill. A run with no TAP summary is NO-RESULT: never a kill,
// never a survivor, and every census counts it as a failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { tapResult, verdict, runTests } = require('./tools/mutant-tap.cjs');
// The classify-all pin below reads census-mutated code (src TS, run-tests.cjs): load-ts gates on the mutant journal.
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'test', 'tools');

const tap = (rows, { tests, pass, fail, cancelled = 0 } = {}) => [
  'TAP version 13', ...rows,
  // a subtest's own summary is indented and must never be read as the run's
  '    # tests 9', '    # pass 9', '    # fail 0',
  `1..${tests}`, `# tests ${tests}`, '# suites 0', `# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`,
  '# skipped 0', '# todo 0', '# duration_ms 12.3', ''].join('\n');
const GREEN = tap(['ok 1 - a', 'ok 2 - b'], { tests: 2, pass: 2, fail: 0 });
const RED = tap(['ok 1 - a', 'not ok 2 - b breaks # TODO-ish note', '  ---', '  ...'], { tests: 2, pass: 1, fail: 1 });
const SPEC = '✔ a (1.2ms)\n✖ b (0.4ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n';

test('tapResult reads only the top-level TAP summary, and the failing titles', () => {
  const g = tapResult({ status: 0, signal: null, stdout: GREEN, stderr: '' });
  assert.deepEqual([g.tests, g.pass, g.fail, g.cancelled, g.noResult], [2, 2, 0, 0, false]);
  const r = tapResult({ status: 1, signal: null, stdout: RED.replace(/\n/g, '\r\n'), stderr: '' });
  assert.deepEqual([r.tests, r.pass, r.fail, r.noResult], [2, 1, 1, false]);
  assert.deepEqual(r.failed, ['b breaks']);
  assert.equal(verdict(g), 'SURVIVED');
  assert.equal(verdict(r), 'KILLED');
});

test('a run that never reported is NO-RESULT, loudly, whatever its exit code', () => {
  const cases = [
    ['spec output (no reporter)', { status: 1, signal: null, stdout: SPEC }, /no TAP summary/],
    ['empty output', { status: 1, signal: null, stdout: '' }, /no TAP summary \(exit 1\)/],
    ['killed by a signal', { status: null, signal: 'SIGTERM', stdout: GREEN }, /killed by SIGTERM/],
    ['spawn error / timeout', { status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), stdout: '' }, /ETIMEDOUT/],
    ['no test ran', { status: 0, signal: null, stdout: tap([], { tests: 0, pass: 0, fail: 0 }) }, /no test ran/],
    ['exit 1 with every test passing (a crash outside any test)', { status: 1, signal: null, stdout: GREEN }, /exit 1 with no failing test/],
    ['exit 0 with a failing test', { status: 0, signal: null, stdout: RED }, /exit 0 with 1 failing/],
    ['only a subtest summary', { status: 1, signal: null, stdout: 'not ok 1 - x\n    # tests 1\n    # pass 0\n    # fail 1\n' }, /no TAP summary/],
  ];
  for (const [what, r, why] of cases) {
    const res = tapResult(r);
    assert.equal(res.noResult, true, what);
    assert.match(res.why, why, what);
    assert.equal(verdict(res), 'NO-RESULT', what);
    assert.equal(verdict(res, /not ok/), 'NO-RESULT', `${what} (named)`);
    assert.equal(verdict(res, () => true), 'NO-RESULT', `${what} (named fn)`);
  }
});

test('verdict: a kill at the named test is KILLED, any other failure KILLED ELSEWHERE', () => {
  const r = tapResult({ status: 1, signal: null, stdout: RED, stderr: '' });
  assert.equal(verdict(r, /not ok \d+ - b breaks/), 'KILLED');
  assert.equal(verdict(r, /not ok \d+ - a\b/), 'KILLED ELSEWHERE');
  assert.equal(verdict(r, (failed) => failed.includes('b breaks')), 'KILLED');
  assert.equal(verdict(r, (failed) => failed.includes('a')), 'KILLED ELSEWHERE');
});

// MUTANT-DIES-FAILED-ONLY (Jim NIT on fa764993): a dies RegExp ran over the whole TAP output, which names
// passing tests too ('# Subtest: <name>', 'ok N - <name>', nested rows), so a kill elsewhere read KILLED.
const MIXED = [
  'TAP version 13',
  '# Subtest: outer group',
  '    # Subtest: the named guard holds',
  '    ok 1 - the named guard holds',
  '      ---',
  '      duration_ms: 1.1',
  "      type: 'test'",
  '      ...',
  '    # Subtest: some other check',
  '    not ok 2 - some other check',
  '      ---',
  '      duration_ms: 0.9',
  "      error: 'GUARD MSG: the other check broke'",
  '      ...',
  '    1..2',
  'not ok 1 - outer group',
  '  ---',
  "  error: '1 subtest failed'",
  '  ...',
  '# Subtest: the named guard top',
  'ok 2 - the named guard top',
  '  ---',
  '  duration_ms: 0.5',
  '  ...',
  '1..2', '# tests 3', '# suites 0', '# pass 1', '# fail 2', '# cancelled 0', ''].join('\n');

test('a passing test whose name matches can not count as a kill: dies sees failing tests only', () => {
  const r = tapResult({ status: 1, signal: null, stdout: MIXED, stderr: 'the named guard holds\n' });
  assert.equal(r.noResult, false, r.why);
  // the passing tests' names are everywhere in the output, but they passed: a kill elsewhere
  assert.equal(verdict(r, /the named guard holds/), 'KILLED ELSEWHERE');
  assert.equal(verdict(r, /the named guard top/), 'KILLED ELSEWHERE');
  assert.equal(verdict(r, /^ok \d+ - the named guard/m), 'KILLED ELSEWHERE');
  // what the failing tests say does count: a nested row, its assertion message, the top-level row
  assert.equal(verdict(r, /not ok \d+ - some other check/), 'KILLED');
  assert.equal(verdict(r, /GUARD MSG: the other check broke/), 'KILLED');
  assert.equal(verdict(r, /^not ok \d+ - outer group/m), 'KILLED');
  // a passing test's YAML is not a failure's diagnostics
  assert.equal(verdict(r, /duration_ms: 0\.5/), 'KILLED ELSEWHERE');
  assert.match(r.failures, /GUARD MSG/);
  assert.doesNotMatch(r.failures, /Subtest|^\s*ok /m);
  // a sticky or global flag can not make the match depend on an earlier call
  const g = /some other check/g;
  assert.equal(verdict(r, g), 'KILLED');
  assert.equal(verdict(r, g), 'KILLED');
  // nor anchor it to the first failing row (a sticky regex only matches at index 0)
  assert.equal(verdict(r, /GUARD MSG/y), 'KILLED');
});

test('runTests runs real node --test under TAP: pass, fail and a hang give SURVIVED, KILLED and NO-RESULT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-runners-tap-'));
  try {
    fs.writeFileSync(path.join(dir, 'pass.test.cjs'), "require('node:test')('fine', () => {});\n");
    fs.writeFileSync(path.join(dir, 'fail.test.cjs'), "require('node:test')('breaks here', () => { throw new Error('x'); });\n");
    fs.writeFileSync(path.join(dir, 'hang.test.cjs'), "require('node:test')('never ends', () => new Promise(() => setInterval(() => {}, 1000)));\n");
    const p = runTests(dir, ['pass.test.cjs'], { timeout: 120_000 });
    assert.equal(verdict(p), 'SURVIVED', p.why ?? p.stdout);
    assert.equal(p.pass, 1);
    const f = runTests(dir, ['fail.test.cjs'], { timeout: 120_000 });
    assert.equal(verdict(f, /not ok \d+ - breaks here/), 'KILLED', f.why ?? f.stdout);
    assert.deepEqual(f.failed, ['breaks here']);
    assert.match(f.failures, /^not ok \d+ - breaks here/m);
    assert.match(f.failures, /error: 'x'/, 'the real failing YAML (assertion message) is in failures');
    const h = runTests(dir, ['hang.test.cjs'], { timeout: 3_000 });
    assert.equal(verdict(h), 'NO-RESULT', h.stdout);
    assert.throws(() => runTests(dir, ['pass.test.cjs'], { args: ['--test-reporter=spec'] }), /picks the reporter/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('requireBaseline stops a census (exit 2) when the unmutated run never reported or is red', () => {
  const { spawnSync } = require('node:child_process');
  const helper = JSON.stringify(path.join(TOOLS, 'mutant-tap.cjs'));
  const call = (res) => spawnSync(process.execPath, ['-e',
    `const { requireBaseline } = require(${helper}); const r = requireBaseline(${JSON.stringify(res)}, 'X'); console.log('RETURNED ' + r.pass);`],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const none = call({ noResult: true, why: 'no TAP summary (exit 1)', status: 1, tests: null, pass: null, fail: null, cancelled: null, failed: [] });
  assert.equal(none.status, 2, none.stdout + none.stderr);
  assert.match(none.stdout, /BASELINE NO-RESULT: X \(no TAP summary/);
  const red = call({ noResult: false, why: null, status: 1, tests: 2, pass: 1, fail: 1, cancelled: 0, failed: ['b'] });
  assert.equal(red.status, 2, red.stdout + red.stderr);
  assert.match(red.stdout, /BASELINE RED: X/);
  const green = call({ noResult: false, why: null, status: 0, tests: 2, pass: 2, fail: 0, cancelled: 0, failed: [] });
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /RETURNED 2/);
});

// Every census under test/tools spawns its tests through runTests (never node --test itself) and turns a
// NO-RESULT into a failure, so none can return no result silently.
const SPAWNS_TEST = /['"`]--test['"`]/;
function runnerProblems(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  src.split(/\r?\n/).forEach((l, i) => { if (SPAWNS_TEST.test(l)) out.push(`${path.basename(file)}:${i + 1} spawns node --test itself (use runTests)`); });
  if (!/\brunTests\(/.test(src)) out.push(`${path.basename(file)} never calls runTests`);
  if (!/\bverdict\(|\.noResult\b/.test(src)) out.push(`${path.basename(file)} never tells NO-RESULT apart (use verdict)`);
  return out;
}

test('every mutant runner spawns through runTests and reads NO-RESULT as a failure', () => {
  const runners = fs.readdirSync(TOOLS).filter((f) => /-mutants\.cjs$/.test(f));
  assert.ok(runners.length >= 25, `the pin sees the runners (${runners.length})`);
  const bad = runners.flatMap((f) => runnerProblems(path.join(TOOLS, f)));
  assert.deepEqual(bad, []);
  // not vacuous: a runner that spawns node --test and reads the exit code is caught
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-runners-pin-'));
  try {
    const f = path.join(tmp, 'x-mutants.cjs');
    fs.writeFileSync(f, "const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', T]);\nif (r.status !== 0) killed++;\n");
    assert.equal(runnerProblems(f).length, 3);
    fs.writeFileSync(f, "const r = runTests(ROOT, [T]);\nif (verdict(r) === 'KILLED') killed++;\n");
    assert.deepEqual(runnerProblems(f), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// MUTANT-TAP-SPLIT (Jim d6a960): runTests spawns node --test on computed files, and the heavy-lock classifier
// follows requires. While it sat in mutant-runner-helper.cjs (required by run-tests.cjs, which own-job.cjs and so
// every test file requires), 555 of 593 single test files classified heavy and queued behind the one heavy slot.
// It lives in mutant-tap.cjs now, which only the census runners and this file require. Pin both the cause and
// the effect: no file is heavy BECAUSE of mutant-tap unless it requires it itself, and the floor-wide count of
// heavy single-file runs stays near int's (90 of 582 on 6fc92d03; 91 here, this file being one).
const HEAVY_SINGLE_FILE_CEILING = 110;
test('a single test file run is not heavy just because the suite runner can reach the census TAP helper', () => {
  const { classifyHeavy } = loadTs('src/main/heavyJob.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const ctx = HookServer.heavyScriptCtx(ROOT);
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.test.cjs')) files.push(rel(p));
    }
  })(path.join(ROOT, 'test'));
  assert.ok(files.length > 500, `the pin sees the suite (${files.length} files)`);
  const heavy = [];
  const viaTap = [];
  for (const f of files) {
    const g = classifyHeavy('Bash', { command: `node --test ${f}` }, ctx);
    if (!g.heavy) continue;
    heavy.push(f);
    const direct = /require\([^)]*mutant-tap\.cjs/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    if (/mutant-tap\.cjs/.test(g.why ?? '') && !direct) viaTap.push(`${f}: ${g.why}`);
  }
  assert.deepEqual(viaTap, [], 'heavy only through a require chain into mutant-tap.cjs (keep it off run-tests.cjs / own-job.cjs)');
  assert.ok(heavy.length <= HEAVY_SINGLE_FILE_CEILING,
    `${heavy.length} of ${files.length} single test files classify heavy (ceiling ${HEAVY_SINGLE_FILE_CEILING}): a shared require ` +
    'probably pulled a node --test spawn into every file; raise the ceiling only for genuinely heavy new tests');
  // not vacuous: the suite runner itself must stay light, and a plain test file must too
  for (const f of ['test/census-reporter-tap.test.cjs', 'test/kg-core.test.cjs']) {
    assert.equal(classifyHeavy('Bash', { command: `node --test ${f}` }, ctx).heavy, false, f);
  }
  assert.equal(classifyHeavy('Bash', { command: 'node --test test/mutant-runners-tap.test.cjs' }, ctx).heavy, true,
    'a file that requires mutant-tap.cjs (it spawns node --test) is heavy, so the classifier does see the helper');
});
