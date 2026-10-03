'use strict';
/**
 * CLAIMS-PERF-LANE: run-tests.cjs runs test/perf/*.perf.cjs SERIALLY after the parallel suite, so
 * wall-clock gates measure the code and not the machine. Effects are injected (no real spawn).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./tools/run-tests.cjs');

const ROOT = path.join(__dirname, '..');
function harness({ perfEntries = ['claims-derive-w2.perf.cjs', 'README.md'], mainStatus = 0, perfStatus = 0, filters = [], perfDir = path.join(ROOT, 'test', 'perf') } = {}) {
  const calls = []; const logs = []; const errs = [];
  const code = R.run({
    testDir: path.join(ROOT, 'test'), filters, cwd: ROOT, perfDir, timeoutMs: 60_000, isTTY: false,
    readdir: (d) => (d === perfDir ? perfEntries : ['a.test.cjs', 'b.test.cjs']),
    spawn: (args) => { calls.push(args); return { status: calls.length === 1 ? mainStatus : perfStatus }; },
    readFile: () => '', removeFile: () => {}, watchdog: () => ({ stop: () => {} }),
    log: (l) => logs.push(l), err: (l) => errs.push(l),
  });
  return { code, calls, logs, errs };
}

test('an unfiltered run runs the perf lane AFTER the parallel suite, serially, with only the *.perf.cjs files', () => {
  const h = harness();
  assert.equal(h.code, 0);
  assert.equal(h.calls.length, 2);
  assert.ok(!h.calls[0].some((a) => a.endsWith('.perf.cjs')), 'the parallel run holds no perf file');
  assert.ok(!h.calls[0].includes('--test-concurrency=1'));
  const lane = h.calls[1];
  assert.ok(lane.includes('--test-concurrency=1'));
  assert.deepEqual(lane.filter((a) => a.endsWith('.cjs')), [path.join('test', 'perf', 'claims-derive-w2.perf.cjs')]);
  assert.ok(h.logs.some((l) => /perf lane: running 1 wall-clock file\(s\) serially/.test(l)));
});

test('a failing perf lane fails the run even when the parallel suite passed', () => {
  const h = harness({ perfStatus: 1 });
  assert.equal(h.code, 1);
  assert.ok(h.errs.some((l) => /perf lane FAILED/.test(l)));
});

test('a failing parallel suite keeps its code, and the lane still runs and reports', () => {
  const h = harness({ mainStatus: 3, perfStatus: 0 });
  assert.equal(h.code, 3);
  assert.equal(h.calls.length, 2);
});

test('a filtered run skips the lane and says so', () => {
  const h = harness({ filters: ['a'] });
  assert.equal(h.code, 0);
  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((l) => /perf lane SKIPPED: a filtered run/.test(l)));
});

test('an empty perf folder is an error, never a quiet pass', () => {
  const h = harness({ perfEntries: ['notes.md'] });
  assert.equal(h.code, 1);
  assert.equal(h.calls.length, 1);
  assert.ok(h.errs.some((l) => /no \*\.perf\.cjs files/.test(l)));
});

test('without perfDir (the injected unit-test shape) the runner is unchanged: one spawn', () => {
  const h = harness({ perfDir: null });
  assert.equal(h.calls.length, 1);
});

test('the CLI and npm test run the lane: the CLI passes test/perf, and package.json has a test script', () => {
  const src = fs.readFileSync(path.join(ROOT, 'test', 'tools', 'run-tests.cjs'), 'utf8');
  assert.match(src, /perfDir: path\.join\(repoRoot, 'test', 'perf'\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node test/tools/run-tests.cjs');
  assert.ok(fs.readdirSync(path.join(ROOT, 'test', 'perf')).some((n) => n.endsWith('.perf.cjs')));
});
