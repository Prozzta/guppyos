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
  assert.deepEqual(lane.filter((a) => a.endsWith('.perf.cjs')), [path.join('test', 'perf', 'claims-derive-w2.perf.cjs')]);
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

// ── Andy's PERF-LANE-AUDIT shoulds: one totals line at the end, and the lane's per-file timeout ──

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const counts = (c) => Object.entries(c).map(([count, n]) => JSON.stringify({ count, n })).join('\n');

test('the run ends with ONE totals line combining the main run and the lane (unknown counts print ?, never 0)', () => {
  const files = {
    ev: counts({ tests: 40, pass: 37, fail: 1, cancelled: 0, skipped: 2, todo: 0 }),
    'ev.perf': counts({ tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 }),
  };
  const run = (opts) => {
    const logs = [];
    const code = R.run({ testDir: path.join(ROOT, 'test'), cwd: ROOT, perfDir: path.join(ROOT, 'test', 'perf'), timeoutMs: 60_000, isTTY: false, eventsFile: 'ev',
      readdir: (d) => (d.endsWith('perf') ? ['claims-derive-w2.perf.cjs'] : ['a.test.cjs']), readFile: (p) => files[p] ?? '', removeFile: () => {},
      watchdog: () => ({ stop: () => {} }), log: (l) => logs.push(l), err: () => {}, ...opts });
    return { code, last: logs[logs.length - 1], logs };
  };
  const ok = run({ spawn: () => ({ status: 0 }) });
  assert.equal(ok.last, '[test-runner] totals: tests 42 pass 39 fail 1 cancelled 0 skipped 2 lane pass exit 0');
  assert.equal(ok.logs.filter((l) => l.includes('totals:')).length, 1);
  let n = 0;
  const laneFails = run({ spawn: () => ({ status: n++ === 0 ? 0 : 1 }) });
  assert.match(laneFails.last, /^\[test-runner\] totals: .* lane fail exit 1$/);
  const filtered = run({ filters: ['a'], spawn: () => ({ status: 0 }) });
  assert.equal(filtered.last, '[test-runner] totals: tests 40 pass 37 fail 1 cancelled 0 skipped 2 lane skipped exit 0');
  const unread = run({ readFile: () => '', spawn: () => ({ status: 0 }) });
  assert.equal(unread.last, '[test-runner] totals: tests ? pass ? fail ? cancelled ? skipped ? lane pass exit 0');
  const noLane = run({ perfDir: null, spawn: () => ({ status: 0 }) });
  assert.match(noLane.last, /lane off exit 0$/);
});

test('the lane gets the main run\'s per-file timeout: watchdog, backstop, timeout reporter, a NAMED failure', () => {
  const calls = []; const errs = []; let started = 0; let stopped = 0; const removed = [];
  const rec = JSON.stringify({ file: path.join(ROOT, 'test', 'perf', 'claims-derive-w2.perf.cjs'), message: 'timed out' });
  const code = R.run({ testDir: path.join(ROOT, 'test'), cwd: ROOT, perfDir: path.join(ROOT, 'test', 'perf'), timeoutMs: 5000, isTTY: false, eventsFile: 'ev',
    readdir: (d) => (d.endsWith('perf') ? ['claims-derive-w2.perf.cjs'] : ['a.test.cjs']),
    readFile: (p) => (p === 'ev.perf.watchdog' ? rec : ''), removeFile: (p) => removed.push(p),
    watchdog: () => { started += 1; return { stop: () => { stopped += 1; } }; },
    spawn: (args) => { calls.push(args); return { status: 0 }; }, log: () => {}, err: (l) => errs.push(l) });
  assert.equal(code, 1, 'a timed-out lane file fails the run even when node --test exits 0');
  assert.equal(started, 2); assert.equal(stopped, 2);
  const lane = calls[1];
  assert.ok(lane.includes(`--test-timeout=${R.backstopMs(5000)}`));
  const dests = lane.flatMap((x, i) => (x === '--test-reporter-destination' ? [lane[i + 1]] : []));
  assert.deepEqual(dests, ['stdout', 'ev.perf'], 'the lane writes its own record file');
  assert.match(errs.join('\n'), /perf lane FILE TIMED OUT after 5000 ms .*claims-derive-w2\.perf\.cjs/);
  assert.match(errs.join('\n'), /perf lane FAILED/);
  assert.deepEqual(removed.sort(), ['ev', 'ev.perf', 'ev.perf.watchdog', 'ev.watchdog']);
});

test('end to end (a real nested node --test): the totals match node\'s own counts, and a hung perf file is named', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-lane-e2e-'));
  try {
    fs.mkdirSync(path.join(dir, 'test', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'a.test.cjs'), "const t = require('node:test'); t('one', () => {}); t('two', () => {}); t('three', { skip: true }, () => {});\n");
    fs.writeFileSync(path.join(dir, 'test', 'perf', 'quick.perf.cjs'), "require('node:test')('quick', () => {});\n");
    const go = () => {
      const logs = []; const errs = [];
      const code = R.run({ testDir: path.join(dir, 'test'), perfDir: path.join(dir, 'test', 'perf'), cwd: dir, timeoutMs: 3000, isTTY: false,
        spawn: (a, o) => spawnSync(process.execPath, a, { ...o, stdio: 'pipe' }), log: (l) => logs.push(l), err: (l) => errs.push(l) });
      return { code, last: logs[logs.length - 1], errs: errs.join('\n') };
    };
    const ok = go();
    assert.equal(ok.last, '[test-runner] totals: tests 4 pass 3 fail 0 cancelled 0 skipped 1 lane pass exit 0');
    assert.equal(ok.code, 0);
    fs.writeFileSync(path.join(dir, 'test', 'perf', 'stuck.perf.cjs'), "require('node:test')('stuck', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
    const hung = go();
    assert.notEqual(hung.code, 0);
    assert.match(hung.errs, /perf lane FILE TIMED OUT after 3000 ms .*stuck\.perf\.cjs/);
    assert.match(hung.last, /lane fail exit [1-9]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
