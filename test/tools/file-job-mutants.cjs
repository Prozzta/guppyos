'use strict';

// AV-FILEJOB-FLAG: the hand-mutant census of the per-file job tool's build folder, hash, prune and
// fail-closed join (Jim SHOULD 2 on 991d11bc), committed so a later audit can re-run it. Each mutant
// damages ONE file at a unique anchor and must make the named test FAIL; a survivor, a kill
// elsewhere or a missing anchor fails the census. Windows only (the LIVE rows build with the in-box
// csc). Each run is one test file run directly with a name filter (not `node --test`). The heavy
// lock still classes the whole census as a bench: run it in a heavy slot.
//   node test/tools/file-job-mutants.cjs
// The mutants are in test/tools and test/, which mutant-runner-helper.cjs refuses (src only, on
// purpose), so this runner restores each file itself in a finally.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

const run = (file, pattern) => spawnSync(process.execPath, [`--test-name-pattern=${pattern}`, file], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
const failed = (r, pattern) => r.status !== 0 && new RegExp(`^not ok \\d+ - ${pattern}`, 'm').test(r.stdout);

let bad = 0;
for (const [file, pattern] of [...new Set(MUTANTS.map((m) => `${m[4]}\0${m[5]}`))].map((k) => k.split('\0'))) {
  const r = run(file, pattern);
  if (r.status !== 0 || !/^# pass [1-9]/m.test(r.stdout)) {
    console.log(`BASELINE RED: ${file} "${pattern}" (status ${r.status}), so no mutant proves anything.`);
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
    fs.writeFileSync(abs, mutated);
    r = run(file, pattern);
  } finally {
    fs.writeFileSync(abs, original);
  }
  const killed = failed(r, pattern);
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
