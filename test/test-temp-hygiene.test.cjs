'use strict';
require('./tools/own-job.cjs');
/**
 * TEST-TEMP-HYGIENE (1.1.98): ordinary tests left mkdtemp folders in the temp folder
 * (md-update-applied, md-cost, md-roster, proj/home/transcript, kg-test, ...; Jim 2026-09-20), and
 * an interim script (C:\Dunder\_tools\clean-test-temp.py) cleaned up after them. Now run-tests.cjs gives
 * every test-file process a temp folder of its own (temp-jail-preload.cjs) and FAILS the run naming
 * each file whose folder is not empty afterwards. A per-file folder, not a before/after diff of the
 * shared temp folder: other agents and apps write there all the time, so a diff could not name the
 * file and would go red on their files.
 *
 * PRELOAD: in a test-file process TEMP/TMP/TMPDIR move to <root>\<pid>-<unique>, inherited by its children;
 * elsewhere nothing changes. TEMPLEAKS: names the non-empty folders only. RUN: a real run of two
 * fixture files, one leaking: the run fails, names that file only, and removes its folder.
 * TEMPDIR / REMOVEDIR: test/tools/test-temp.cjs, what the offending files now use: tempDir's
 * folders go when the process ends, and removeDir waits (async) while a file in the folder is still held.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('./tools/run-tests.cjs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-hygiene-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => { const d = path.join(tmpRoot, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

/** A node process with the preload as run-tests adds it; prints its tmpdir, its NODE_OPTIONS and a child's tmpdir. */
function preloaded(root, { context = 'child-v8' } = {}) {
  const opt = `--require "${runner.TEMP_JAIL_PRELOAD.split(path.sep).join('/')}"`;
  const env = { ...process.env, NODE_OPTIONS: opt, GUPPY_TEMP_JAIL: root, GUPPY_TEMP_JAIL_OPT: opt, TEMP: os.tmpdir(), TMP: os.tmpdir(), TMPDIR: os.tmpdir() };
  delete env.GUPPY_SHARED_TEMP; // set by the preload of this file under run-tests; the child's must set it itself
  delete env.NODE_TEST_CONTEXT;
  if (context) env.NODE_TEST_CONTEXT = context;
  const script = "const os=require('os');const c=require('child_process').spawnSync(process.execPath,['-e','process.stdout.write(require(\"os\").tmpdir())'],{encoding:'utf8'});"
    + "process.stdout.write(JSON.stringify({ tmp: os.tmpdir(), pid: process.pid, opts: process.env.NODE_OPTIONS || '', jail: process.env.GUPPY_TEMP_JAIL || '', child: c.stdout, shared: require(" + JSON.stringify(path.join(__dirname, 'tools', 'shared-temp.cjs')) + ").sharedTemp() }))";
  const file = path.join(fresh('script'), 'probe.test.cjs');
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, [file], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout), file };
}

test('PRELOAD: a test-file process and its children get <root>\\<pid>-<unique> as their temp folder; the preload leaves NODE_OPTIONS', () => {
  const root = fresh('jail');
  const o = preloaded(root);
  const mine = fs.readdirSync(root).filter((x) => x.startsWith(`${o.pid}-`) && !x.endsWith('.file'));
  assert.equal(mine.length, 1, 'TEMP JAIL: one folder named <pid>-<unique>');
  const dir = path.join(root, mine[0]);
  assert.equal(o.tmp, dir, 'TEMP JAIL: os.tmpdir() is the file\'s own folder');
  assert.equal(o.child, dir, 'TEMP JAIL: a child the file starts inherits it');
  assert.ok(fs.statSync(dir).isDirectory(), 'TEMP JAIL: the folder exists');
  assert.equal(fs.readFileSync(`${dir}.file`, 'utf8'), o.file, 'TEMP JAIL: <folder>.file names the file (argv[1])');
  assert.equal(o.opts, '', 'TEMP JAIL: the preload takes itself out of NODE_OPTIONS');
  assert.equal(o.jail, '', 'TEMP JAIL: and its variables');
  assert.equal(o.shared, os.tmpdir(), 'TEMP JAIL: sharedTemp() is still the real temp folder (the deliberate caches)');
});

test('PRELOAD: outside a test-file process (no NODE_TEST_CONTEXT) nothing moves', () => {
  const root = fresh('jail');
  const o = preloaded(root, { context: null });
  assert.equal(o.tmp, os.tmpdir(), 'TEMP JAIL: the main node --test process keeps the real temp folder');
  assert.deepEqual(fs.readdirSync(root), [], 'TEMP JAIL: and makes no folder');
});

test('TEMPLEAKS: names each file whose folder is not empty, with its entries; empty folders and other names are not leaks', () => {
  const root = fresh('leaks');
  for (const [pid, file, entries] of [['11-aaaaaa', 'b.test.cjs', ['x-1', 'a-2']], ['12-bbbbbb', 'clean.test.cjs', []], ['13-cccccc', 'a.test.cjs', ['y']], ['13-dddddd', 'c.test.cjs', ['w']]]) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, `${pid}.file`), file);
    for (const e of entries) fs.mkdirSync(path.join(root, pid, e));
  }
  fs.mkdirSync(path.join(root, '14-eeeeee'));
  fs.writeFileSync(path.join(root, '14-eeeeee', 'z'), '');            // no .file: named by pid
  fs.mkdirSync(path.join(root, 'notapid'));
  fs.writeFileSync(path.join(root, 'notapid', 'q'), '');
  assert.deepEqual(runner.tempLeaks(root), [
    { file: '(pid 14)', entries: ['z'] },
    { file: 'a.test.cjs', entries: ['y'] },
    { file: 'b.test.cjs', entries: ['a-2', 'x-1'] },
    { file: 'c.test.cjs', entries: ['w'] }
  ], 'TEMP LEAKS: the non-empty folders, sorted, each named by its file (a recycled pid 13 keeps two files apart)');
  assert.deepEqual(runner.tempLeaks(path.join(root, 'missing')), [], 'TEMP LEAKS: no root, no leaks');
  const lines = [];
  assert.equal(runner.reportTempLeaks(runner.tempLeaks(root), (l) => lines.push(l)), 4);
  assert.match(lines[1], /^\[test-runner\] TEMP LEAK: a\.test\.cjs left 1 entry in its temp folder: y$/, 'TEMP LEAKS: one line per file');
  assert.match(lines[4], /4 test file\(s\) left files in the temp folder - the run FAILS/, 'TEMP LEAKS: and the verdict');
});

test('RUN: a real run of a leaking and a clean file fails, names the leaking one only, and removes the run\'s temp folders', { timeout: 300_000 }, () => {
  const dir = fresh('suite');
  const testDir = path.join(dir, 'test');
  fs.mkdirSync(testDir);
  fs.writeFileSync(path.join(testDir, 'leaky.test.cjs'), "const t=require('node:test');const fs=require('fs');const os=require('os');const p=require('path');t('leaks',()=>{fs.mkdtempSync(p.join(os.tmpdir(),'md-cost-'))});\n");
  fs.writeFileSync(path.join(testDir, 'tidy.test.cjs'), "const t=require('node:test');const fs=require('fs');const os=require('os');const p=require('path');t('tidy',()=>{const d=fs.mkdtempSync(p.join(os.tmpdir(),'md-roster-'));fs.rmSync(d,{recursive:true})});\n");
  const jailDir = path.join(dir, 'jails');
  fs.mkdirSync(jailDir);
  const out = [];
  const errs = [];
  const code = runner.run({ testDir, cwd: dir, isTTY: false, log: (l) => out.push(l), err: (l) => errs.push(l), cpuMask: () => null,
    tempJail: () => runner.prepareTempJail({ dir: jailDir }) });
  const leakLines = errs.filter((l) => l.includes('TEMP LEAK:'));
  assert.equal(code, 1, `TEMP RUN: a leak fails a run whose tests all pass\n${errs.join('\n')}`);
  assert.equal(leakLines.length, 1, `TEMP RUN: exactly one file is named\n${errs.join('\n')}`);
  assert.match(leakLines[0], /leaky\.test\.cjs left 1 entry in its temp folder: md-cost-\w{6}$/, 'TEMP RUN: the leaking file and what it left');
  assert.match(out.join('\n'), /\[test-runner\] totals: tests 2 pass 2 fail 0 .* exit 1$/, 'TEMP RUN: the totals line carries the failing exit');
  assert.deepEqual(fs.readdirSync(jailDir), [], 'TEMP RUN: the run\'s temp folders are removed afterwards');
});

test('RUN: a run whose temp folders cannot be removed says so, naming the folder (Jim NIT 1)', () => {
  const root = fresh('held');
  const errs = [];
  const code = runner.run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: () => ({ status: 0 }), log: () => {}, err: (l) => errs.push(l),
    readFile: () => '', removeFile: () => {}, cpuMask: () => null, tempJail: () => ({ root }),
    removeJail: () => { const e = new Error('held'); e.code = 'ENOTEMPTY'; throw e; } });
  assert.equal(code, 0, `TEMP RUN: nothing leaked, so the run itself passes\n${errs.join('\n')}`);
  assert.ok(errs.some((l) => l.includes('could not be removed (ENOTEMPTY') && l.includes(root)), `TEMP RUN: the root left behind is named\n${errs.join('\n')}`);
});

test('RUNNER pins: the preload goes in NODE_OPTIONS for the real runs, and a leak fails a run that would pass', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  assert.match(src, /tempJail = spawn === nodeSpawn && watchdog === startWatchdog \? prepareTempJail : \(\) => null,/, 'TEMP PIN: real runs only');
  assert.match(src, /env\.GUPPY_TEMP_JAIL = jail\.root;\r?\n\s*env\.GUPPY_TEMP_JAIL_OPT = opt;/, 'TEMP PIN: the root and the exact option text');
  assert.match(src, /const mainCode = leaked\(\) && hungCode === 0 \? 1 : hungCode;/, 'TEMP PIN: the perf-lane path checks leaks too');
});

test('TEMPDIR: every folder tempDir made, in module scope or in a test, is gone when the file\'s process ends', () => {
  const root = fresh('tempdir');
  const script = path.join(fresh('script'), 'uses.test.cjs');
  fs.writeFileSync(script, `const { tempDir } = require(${JSON.stringify(path.join(__dirname, 'tools', 'test-temp.cjs'))});const fs = require('fs');const p = require('path');`
    + "const a = tempDir('mod-'); fs.writeFileSync(p.join(a, 'x'), '1'); console.log(a);"
    + "require('node:test')('t', () => { const b = tempDir('in-'); fs.mkdirSync(p.join(b, 'sub')); console.log(b); });\n");
  const env = { ...process.env, TEMP: root, TMP: root, TMPDIR: root };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const made = r.stdout.split(/\r?\n/).filter((l) => l.startsWith(root));
  assert.equal(made.length, 2, `TEMP DIR: both folders were made in the temp folder\n${r.stdout}`);
  assert.deepEqual(fs.readdirSync(root), [], 'TEMP DIR: and both are removed when the process ends');
});

test('REMOVEDIR: waits while something holds the folder, and gives up after its budget', async () => {
  const { removeDir } = require('./tools/test-temp.cjs');
  let now = 0;
  let calls = 0;
  const pauses = [];
  const held = (times) => () => { calls += 1; if (calls <= times) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } };
  const clock = { now: () => now, pause: (ms) => { pauses.push(ms); now += ms; } };
  assert.equal(await removeDir('x', { rm: held(3), ...clock }), true, 'TEMP REMOVE: gone once the holder lets go');
  assert.deepEqual([calls, pauses], [4, [250, 250, 250]], 'TEMP REMOVE: tried again every 250 ms');
  calls = 0; now = 0;
  assert.equal(await removeDir('x', { rm: held(Infinity), budgetMs: 1000, ...clock }), false, 'TEMP REMOVE: a folder held for good is given up');
  assert.equal(calls, 5, 'TEMP REMOVE: at 0, 250, 500, 750 and 1000 ms, then no more');
});
