'use strict';

// TEST-TEMP-HYGIENE: the hand-mutant census of the temp jail (Jim NIT 2 on 4925892c), committed so
// a later audit can re-run it. Each mutant damages ONE file at a unique anchor and must make
// test/test-temp-hygiene.test.cjs fail AT ITS OWN NAMED ASSERTION; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/temp-hygiene-mutants.cjs
// The mutants are in test/tools, which mutant-runner-helper.cjs refuses (src only, on purpose), so
// this runner restores each file itself in a finally.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/test-temp-hygiene.test.cjs';
const PRELOAD = 'test/tools/temp-jail-preload.cjs';
const RUNNER = 'test/tools/run-tests.cjs';
const TOOL = 'test/tools/test-temp.cjs';

const MUTANTS = [
  ['M1 the preload leaves TEMP', PRELOAD, '    process.env.TEMP = dir;\n    process.env.TMP = dir;\n    process.env.TMPDIR = dir;\n', '', /TEMP JAIL: os\.tmpdir\(\) is the file's own folder/],
  ['M2 the preload stays in NODE_OPTIONS', PRELOAD, ".replace(opt, '').trim()", '.trim()', /TEMP JAIL: the preload takes itself out of NODE_OPTIONS/],
  ['M3 the preload records no shared temp', PRELOAD, "  if (!process.env.GUPPY_SHARED_TEMP) process.env.GUPPY_SHARED_TEMP = require('os').tmpdir();\n", '', /TEMP JAIL: sharedTemp\(\) is still the real temp folder/],
  ['M4 sharedTemp ignores the env', 'test/tools/shared-temp.cjs', 'return env.GUPPY_SHARED_TEMP || os.tmpdir();', 'return os.tmpdir();', /TEMP JAIL: sharedTemp\(\) is still the real temp folder/],
  ['M5 empty folders count as leaks', RUNNER, '    if (!entries.length) continue;\n', '', /TEMP LEAKS: the non-empty folders/],
  ['M6 pid-only folder names', RUNNER, 'const pid = /^(\\d+)-[A-Za-z0-9]+$/.exec(name);', 'const pid = /^(\\d+)$/.exec(name);', /TEMP LEAKS: the non-empty folders|TEMP RUN/],
  ['M7 a leak does not fail the run', RUNNER, 'return totals(n && hungCode === 0 ? 1 : hungCode,', 'return totals(hungCode,', /TEMP RUN: a leak fails a run whose tests all pass/],
  ['M8 the perf-lane path ignores leaks', RUNNER, 'const mainCode = leaked() && hungCode === 0 ? 1 : hungCode;', 'const mainCode = hungCode;', /TEMP PIN: the perf-lane path checks leaks too/],
  ['M9 the jail root is kept', RUNNER, '    if (jail) { try { removeJail(jail.root); }', '    if (jail) { try { /* kept */ }', /TEMP RUN: the run's temp folders are removed afterwards/],
  ['M10 tempDir does not remove at exit', TOOL, "  if (!made.length) process.once('exit', removeAll);\n", '', /TEMP DIR: and both are removed when the process ends/],
  ['M11 removeDir does not wait', TOOL, '    try { rm(dir); return true; } catch { if (now() >= end) return false; }', '    try { rm(dir); return true; } catch { return false; }', /TEMP REMOVE: gone once the holder lets go/],
  ['M12 a root that cannot be removed is silent', RUNNER, "catch (e) { err(`[test-runner] the run's temp folders could not be removed", "catch (e) { (() => {})(`[test-runner] the run's temp folders could not be removed", /TEMP RUN: the root left behind is named/]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
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
    r = run();
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named assertion` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
