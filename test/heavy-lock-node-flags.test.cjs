'use strict';
/**
 * HEAVY-LOCK-NODE-FLAGS-COMPLETE (god 7ab969). Two escapes left by HEAVY-LOCK-PRELOAD-ESCAPE:
 *  (a) a node option that takes its value as the next word, missing from NODE_VALUE_FLAGS, made
 *      that value the "script", so `node --title x test/tools/run-tests.cjs` ran the suite light.
 *      Every `=...` option of `node --help` (node 20.19.5) was measured headless in a temp dir:
 *      `node F VALUE s.cjs` runs s.cjs (F consumed VALUE). The table below is that measurement.
 *  (b) a suite runner (or bench script) PRELOADED with -r/--require/--import runs before the
 *      program: measured, `node -e 1 -r ./pre.cjs` preloads, `node s.cjs -r ./pre.cjs` does not.
 * All commands are invented; nothing here runs a process.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

const RUNNER = 'test/tools/run-tests.cjs';
const heavy = (c) => classifyCommand(c).heavy;

// [flag, a valid value] as measured (node 20.19.5; Windows).
const MEASURED = [
  ['-C', 'dev'], ['--conditions', 'dev'], ['--diagnostic-dir', 'd'], ['--disable-warning', 'ExperimentalWarning'],
  ['--env-file', '.env'], ['--env-file-if-exists', '.env'], ['--heapsnapshot-near-heap-limit', '1'], ['--icu-data-dir', 'icu'],
  ['--max-http-header-size', '16384'], ['--network-family-autoselection-attempt-timeout', '250'], ['--redirect-warnings', 'w.log'],
  ['--report-filename', 'r.json'], ['--report-signal', 'SIGUSR2'], ['--secure-heap', '0'], ['--secure-heap-min', '2'],
  ['--test-concurrency', '1'], ['--test-name-pattern', 'x'], ['--test-reporter', 'spec'], ['--test-reporter-destination', 'stdout'],
  ['--test-shard', '1/2'], ['--test-timeout', '1000'], ['--title', 'x'], ['--tls-cipher-list', 'x'], ['--tls-keylog', 'k.log'],
  ['--trace-event-categories', 'v8'], ['--trace-event-file-pattern', 'x'], ['--v8-pool-size', '2'], ['--watch-path', 'src'],
  ['--allow-fs-read', '*'], ['--allow-fs-write', 'd'], ['--cpu-prof-dir', 'd'], ['--cpu-prof-interval', '1000'], ['--cpu-prof-name', 'c'],
  ['--heap-prof-dir', 'd'], ['--heap-prof-interval', '524288'], ['--heap-prof-name', 'h'], ['--disable-proto', 'delete'],
  ['--dns-result-order', 'ipv4first'], ['--experimental-default-type', 'commonjs'], ['--experimental-policy', 'p.json'],
  ['--heapsnapshot-signal', 'SIGINT'], ['--input-type', 'commonjs'], ['--inspect-publish-uid', 'stderr'], ['--openssl-config', 'o.cnf'],
  ['--trace-require-module', 'all'], ['--unhandled-rejections', 'strict'], ['--use-largepages', 'off'],
  ['--loader', './l.mjs'], ['--experimental-loader', './l.mjs'], ['--inspect-port', '0'], ['--debug-port', '0'],
  ['--report-dir', 'd'], ['--report-directory', 'd'],
  // Separate and `=` forms fail alike on the value (it was consumed): integrity, snapshot, SEA.
  ['--policy-integrity', 'sha384-x'], ['--snapshot-blob', 'x.blob'], ['--build-snapshot-config', 'c.json'], ['--experimental-sea-config', 's.json'],
];

test('(a) every measured value flag: its value is not the script, the runner after it is', () => {
  for (const [f, v] of MEASURED) assert.equal(heavy(`node ${f} ${v} ${RUNNER}`), true, `SUITE RUNS: node ${f} ${v} ${RUNNER}`);
  // And with a filter after the runner it stays a filtered run.
  assert.equal(heavy(`node --title x ${RUNNER} heavy-lock`), false);
  // Optional-value options take a value only with `=`: measured, `node --inspect-brk s.cjs` debugs s.cjs.
  for (const f of ['--inspect', '--inspect-brk', '--inspect-wait']) assert.equal(heavy(`node ${f} ${RUNNER}`), true, `${f} RUNNER: the runner is the script`);
  assert.equal(heavy(`node --inspect=0 ${RUNNER}`), true);
});

test('(b) a suite runner or bench script preloaded is the suite or the bench', () => {
  for (const c of [
    `node -r ${RUNNER} -e 1`,
    `node -r ./${RUNNER} x.cjs`,
    `node --require=${RUNNER} x.cjs`,
    `node --import ./${RUNNER} x.cjs`,
    `node -e 1 -r ${RUNNER}`,                     // options go on after -e code (measured)
    `node --title t -r ${RUNNER} x.cjs`,
  ]) assert.equal(heavy(c), true, `PRELOADED SUITE: ${c}`);
  assert.equal(classifyCommand(`node -r ${RUNNER} x.cjs`).kind, 'suite');
  assert.equal(classifyCommand(`node -r zz-gate-stress.cjs x.cjs`).kind, 'bench');
  // After the script, -r is the script's argv (measured: no preload); a plain preload is light.
  assert.equal(heavy(`node x.cjs -r ${RUNNER}`), false);
  assert.equal(heavy(`node -r ./pre.cjs x.cjs`), false);
  // Measured: `node -e "…" x.cjs -r ./pre.cjs` does not preload; argv is [x.cjs, -r, ./pre.cjs].
  assert.equal(heavy(`node -e 1 x.cjs -r ${RUNNER}`), false, 'after the first positional, -r is argv even with -e');
});
