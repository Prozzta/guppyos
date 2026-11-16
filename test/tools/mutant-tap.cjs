'use strict';

// MUTANT-TAP-SPLIT (Jim d6a960): the TAP side of every mutant census lives here, NOT in mutant-runner-helper.cjs.
// run-tests.cjs requires mutant-runner-helper (journalState), every test file requires own-job, which requires
// run-tests, and the heavy-lock classifier follows those requires. runTests spawns node --test on computed files,
// so with it in the helper nearly every single test file classified heavy (555/593). Only the census runners and
// their guard test require this module; nothing on the suite runner's require chain may (pinned in
// test/mutant-runners-tap.test.cjs).
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// MUTANT-RUNNERS-TAP-PARSE: every census runs its tests through runTests and reads them with verdict.
// On Node >=23 `node --test` defaults to the spec reporter, which prints no 'not ok N - title' and no
// '# fail N'; a runner that parsed those saw nothing, and one that only read the exit code counted a run
// that never reported (a crash, a timeout, a refused heavy slot) as a kill. runTests always asks for TAP,
// and a run without TAP's top-level summary, or with no test run at all, is NO-RESULT: never a kill and
// never a survivor, and every census counts it as a failure.
function tapResult(r) {
  const stdout = String(r.stdout ?? '');
  const stderr = String(r.stderr ?? '');
  // TAP's top-level summary rows only: a subtest's own counts are indented.
  const counts = {};
  for (const m of stdout.matchAll(/^# (tests|pass|fail|cancelled) (\d+)[ \t]*\r?$/gm)) counts[m[1]] = Number(m[2]);
  const count = (key) => counts[key] ?? null;
  const tests = count('tests');
  const pass = count('pass');
  const fail = count('fail');
  const cancelled = count('cancelled') ?? 0;
  const failed = stdout.split(/\r?\n/).filter((l) => /^not ok \d+ - /.test(l))
    .map((l) => l.replace(/^not ok \d+ - /, '').replace(/\s+#\s.*$/, '').trim());
  const failures = failureText(stdout);
  let why = null;
  if (r.error) why = `${r.error.code ?? r.error.message}`;
  else if (r.signal) why = `killed by ${r.signal}`;
  else if (tests === null || pass === null || fail === null) why = `no TAP summary (exit ${r.status})`;
  else if (tests === 0) why = 'no test ran';
  else if (r.status !== 0 && fail === 0 && cancelled === 0) why = `exit ${r.status} with no failing test`;
  else if (r.status === 0 && (fail > 0 || cancelled > 0)) why = `exit 0 with ${fail} failing test(s)`;
  return { status: r.status, signal: r.signal ?? null, error: r.error ?? null, stdout, stderr,
    tests, pass, fail, cancelled, failed, failures, noResult: why !== null, why };
}
// MUTANT-DIES-FAILED-ONLY: the text a `dies` RegExp may match. Only what TAP says about FAILING tests, at any
// depth: each 'not ok N - title' line and its YAML diagnostic block (the assertion message lives there). Never
// an 'ok' row, a '# Subtest: <name>' header (printed for passing tests too), a passing test's YAML, or stderr,
// so a passing test whose name matches can not turn a kill elsewhere into KILLED.
function failureText(stdout) {
  const out = [];
  let close = null; // the '...' line that ends the current failing test's YAML block
  for (const line of stdout.split(/\r?\n/)) {
    if (close !== null) {
      out.push(line);
      if (line === close) close = null;
      continue;
    }
    const m = /^(\s*)not ok \d+ - /.exec(line);
    if (m) { out.push(line); close = `${m[1]}  ...`; }
  }
  return out.join('\n');
}
// files: test paths relative to root. args: extra node flags (--test-name-pattern ...), never a reporter.
function runTests(root, files, { args = [], env, timeout = 600_000 } = {}) {
  if (args.some((a) => /^--test-reporter/.test(a))) throw new Error('runTests picks the reporter (TAP); do not pass one');
  // A census started from inside a test inherits NODE_TEST_CONTEXT, which makes the child node --test speak
  // the parent runner's serialized protocol instead of TAP: drop it, so the run is always read as TAP.
  const childEnv = { ...(env ?? process.env) };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args, ...files], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: childEnv,
  });
  return tapResult(r);
}
// KILLED: the run failed (at the named test when `dies` is given: a RegExp on the failing tests' TAP rows and
// diagnostics only (see failureText), or a function of the failing titles). KILLED ELSEWHERE: it failed, but not there. SURVIVED: it ran and passed.
// NO-RESULT: it never reported (see tapResult).
function verdict(res, dies) {
  if (res.noResult) return 'NO-RESULT';
  if (res.fail === 0 && res.cancelled === 0) return 'SURVIVED';
  if (!dies) return 'KILLED';
  const named = typeof dies === 'function' ? dies(res.failed) : new RegExp(dies.source, dies.flags.replace(/[gy]/g, '')).test(res.failures);
  return named ? 'KILLED' : 'KILLED ELSEWHERE';
}
// A census proves nothing against a baseline that is red or never reported: say which and exit 2.
// The line is written synchronously: a piped stdout is asynchronous on Windows, and process.exit would drop it.
function requireBaseline(res, what) {
  const stop = (line) => { fs.writeSync(1, `${line}
`); process.exit(2); };
  if (res.noResult) stop(`BASELINE NO-RESULT: ${what} (${res.why}), so no mutant proves anything.`);
  if (res.fail !== 0 || res.cancelled !== 0 || res.pass === 0) {
    stop(`BASELINE RED: ${what} fails unmutated (${res.fail} failing, ${res.pass} passing), so no mutant proves anything.`);
  }
  return res;
}

module.exports = { runTests, tapResult, verdict, requireBaseline };
