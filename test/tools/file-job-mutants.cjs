'use strict';

// AV-FILEJOB-FLAG: the hand-mutant census of the per-file job tool's build folder, hash, prune and
// fail-closed join (Jim SHOULD 2 on 991d11bc), committed so a later audit can re-run it. Each mutant
// damages ONE file at a unique anchor and must make the named test FAIL; a survivor, a kill
// elsewhere or a missing anchor fails the census. Windows only (the LIVE rows build with the in-box
// csc). Each run is one test file run directly with a name filter (not `node --test`). The heavy
// lock still classes the whole census as a bench: run it in a heavy slot.
//   node test/tools/file-job-mutants.cjs
// INT 1.1.103 (MUTANT-JOURNAL-GATE): every mutant goes through mutant-runner-helper.cjs (journal, then
// restore in a finally), so a killed run is restored by the next one; --anchors-only checks the anchors.
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors, runTests, verdict } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = 'test/load-flakes-178-file-job.test.cjs';
const HYGIENE = 'test/test-temp-hygiene.test.cjs';
const RUNNER = 'test/tools/run-tests.cjs';
const PRELOAD = 'test/tools/file-job-preload.cjs';

// [name, file mutated, anchor, replacement, test file, test-name pattern that must fail]
const MUTANTS = [
  ['FJ-a1 the tool is built in the shared temp folder', RUNNER, "const FILE_JOB_DIR = path.join(__dirname, 'bin');", "const FILE_JOB_DIR = require('./shared-temp.cjs').sharedTemp();", TEST, 'FJ-a'],
  ['FJ-a2 the tool is built in os.tmpdir()', RUNNER, "const FILE_JOB_DIR = path.join(__dirname, 'bin');", "const FILE_JOB_DIR = path.join(os.tmpdir(), 'bin');", TEST, 'FJ-a'],
  ['FJ-b the hash is over the raw bytes', RUNNER, ".update(fs.readFileSync(src, 'utf8').replace(/\\r\\n/g, '\\n'))", '.update(fs.readFileSync(src))', TEST, 'LIVE FJ-b'],
  ['FJ-c no prune after a fresh build', RUNNER, '  pruneFileJobs(dir, exe);\n  return { exe };', '  return { exe };', TEST, 'LIVE FJ-b'],
  ['FJ-d1 the preload records no row', PRELOAD, '    if (fails) {', '    if (false) {', TEST, 'FJ-d preload'],
  ['FJ-d2 the run does not count the rows', RUNNER, 'const n = leaked() + joinFailed();', 'const n = leaked();', TEST, 'FJ-d runner'],
  ['FJ-d3 the perf-lane path does not count the rows', RUNNER, 'const mainCode = leaked() + joinFailed() && hungCode === 0 ? 1 : hungCode;', 'const mainCode = leaked() && hungCode === 0 ? 1 : hungCode;', HYGIENE, 'RUNNER pins'],
  ['FJ-d4 the full suite is not strict', RUNNER, '  return !filters.length;\n}', '  return false;\n}', TEST, 'a strict run'],
  ['FJ-e the LIVE test builds its exe in a temp folder', TEST, 'dir: path.join(R.FILE_JOB_DIR, `fj-bc-${process.pid}`) });\n    assert.ok(a.exe', 'dir: path.join(os.tmpdir(), `fj-bc-${process.pid}`) });\n    assert.ok(a.exe', TEST, 'FJ-e'],
];

// MUTANT-RUNNERS-TAP-PARSE: this ran the file bare (no --test, no reporter), so under Node >= 23's spec
// output neither '# pass' nor 'not ok' ever printed; it now runs under --test with TAP via the shared helper.
const run = (file, pattern) => runTests(ROOT, [file], { timeout: 300_000, args: [`--test-name-pattern=${pattern}`] });
const dies = (pattern) => new RegExp(`^not ok \\d+ - ${pattern}`, 'm');

recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));

let bad = 0;
for (const [file, pattern] of [...new Set(MUTANTS.map((m) => `${m[4]}\0${m[5]}`))].map((k) => k.split('\0'))) {
  const r = run(file, pattern);
  if (r.noResult || r.fail !== 0 || r.cancelled !== 0 || r.pass === 0) {
    console.log(`BASELINE ${r.noResult ? `NO-RESULT (${r.why})` : 'RED'}: ${file} "${pattern}" (status ${r.status}, ${r.pass} passing), so no mutant proves anything.`);
    bad += 1;
  }
}
if (bad) process.exit(2);

for (const [name, rel, from, to, file, pattern] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${at < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, at) + to + source.slice(at + from.length);
  if (original.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  let r;
  try {
    mutateFile(ROOT, abs, original, mutated);
    r = run(file, pattern);
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const v = verdict(r, dies(pattern)); // NO-RESULT (the run never reported) is loud, never a kill
  if (v !== 'KILLED') bad += 1;
  console.log(`${v} ${name}${v === 'NO-RESULT' ? ` (${r.why})` : ''}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
