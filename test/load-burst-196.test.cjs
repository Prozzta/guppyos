'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * LOAD-BURST-196 (god 3c612c, Jim a094f1). node --test starts a file process per core at once, and
 * all of them load in the FULL's first seconds: a stub hook took 30 s and five files failed only
 * there. The runner now gates file start-up (test/tools/file-start-gate.cjs): at most N files load
 * at once, and every file's start is recorded for a burst line after the run.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GATE_FILE = path.join(__dirname, 'tools', 'file-start-gate.cjs');
const RUNNER_FILE = path.join(__dirname, 'tools', 'run-tests.cjs');
const G = require(GATE_FILE);
const R = require(RUNNER_FILE);
const DRIVER_FILE = path.join(__dirname, 'mail-rig', 'driver.cjs');
const D = require(DRIVER_FILE);

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lb196-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
/** A module from edited source text, for the mutants (the file's own requires resolve as usual). */
function fromText(file, text) {
  const Module = require('module');
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(text, file);
  return m.exports;
}

const K = {};

/** Another process holding slot k: its folder with a marker named by that pid (the gate's own layout). */
const holdAs = (d, k, pid) => {
  const p = path.join(d, `slot-${k}`);
  fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p);
  fs.writeFileSync(path.join(p, String(pid)), '');
  return p;
};

K.slots = (g = G, d) => {
  assert.equal(g.tryTake(d, 2), 0);
  assert.equal(g.tryTake(d, 2), 1, 'A TAKEN SLOT IS NOT TAKEN AGAIN');
  assert.equal(g.tryTake(d, 2), -1, 'NO THIRD FILE GETS ONE OF TWO SLOTS');
  g.give(d, 0);
  assert.equal(g.tryTake(d, 2), 0, 'A GIVEN-BACK SLOT IS TAKEN AGAIN');
  // A holder that is gone is taken over: a dead pid, or held past STALE_MS.
  holdAs(d, 1, 999999);
  assert.equal(g.tryTake(d, 2), -1, 'the pass that finds a dead holder clears it');
  assert.equal(g.tryTake(d, 2), 1, 'A DEAD HOLDER IS TAKEN OVER');
  const old = (Date.now() - g.STALE_MS - 1000) / 1000;
  fs.utimesSync(path.join(d, 'slot-0', String(process.pid)), old, old);
  g.tryTake(d, 2);
  assert.equal(g.tryTake(d, 2), 0, 'A STALE HOLDER IS TAKEN OVER');
  // Only the holder gives a slot back.
  holdAs(d, 0, 4);
  g.give(d, 0);
  assert.deepEqual(fs.existsSync(path.join(d, 'slot-0')) ? fs.readdirSync(path.join(d, 'slot-0')) : null, ['4'], 'ANOTHER PROCESS DOES NOT GIVE BACK A SLOT IT DOES NOT HOLD');
};
test('slots: exclusive, given back, a dead or stale holder taken over, only the holder gives back', (t) => K.slots(G, tmp(t)));

// TEST-GATE-SLOT-TAKEOVER-107: the full suite once had 3 files past a 2-slot gate. A waiter B read
// slot-k and saw holder A. Before B looked at A, A gave the slot back and exited, and C took slot-k.
// B then found A dead and removed slot-k by its path: C's. The window is the two fs calls between
// B's read and B's remove, so the step is made here by hand: the swap runs inside B's last look at A.
K.takeover = (g = G, d) => {
  const slot = path.join(d, 'slot-0');
  const A = 999999;           // dead
  const C = process.ppid;     // alive, and not this process (B)
  holdAs(d, 0, A);
  const real = { readdirSync: fs.readdirSync, statSync: fs.statSync };
  let swaps = 0;
  // The waiter's last look at the old holder (its stat) still finds A; C is in place when it returns.
  fs.statSync = function (p, ...rest) {
    const out = real.statSync.call(fs, p, ...rest);
    if (String(p).startsWith(slot) && !swaps++) holdAs(d, 0, C);
    return out;
  };
  let got;
  try { got = g.tryTake(d, 1); } finally { Object.assign(fs, real); }
  assert.equal(swaps, 1, 'the waiter looked at the old holder (the step this test makes)');
  assert.equal(got, -1, 'the waiter finds the slot held on this pass');
  assert.deepEqual(fs.existsSync(slot) ? fs.readdirSync(slot) : null, [String(C)], 'A WAITER NEVER REMOVES A NEWER HOLDER');
  assert.equal(g.tryTake(d, 1), -1, 'A WAITER NEVER REMOVES A NEWER HOLDER (the slot stays held on the next pass)');
  // The holder that is really gone is still cleared, in one pass, and the slot taken on the next.
  holdAs(d, 0, A);
  assert.equal(g.tryTake(d, 1), -1);
  assert.equal(g.tryTake(d, 1), 0, 'A DEAD HOLDER IS TAKEN OVER');
  g.give(d, 0);
  // A slot never exists without its holder in it: a slot seen empty could be removed by a waiter
  // and taken by another file, and the first holder's marker would then land in the other's slot.
  const seen = [];
  const watch = (name) => {
    const orig = fs[name];
    fs[name] = function (...a) { const out = orig.apply(fs, a); if (fs.existsSync(slot)) seen.push(`${name}: ${JSON.stringify(real.readdirSync.call(fs, slot))}`); return out; };
    return () => { fs[name] = orig; };
  };
  const undo = ['mkdirSync', 'writeFileSync', 'renameSync'].map(watch);
  try { got = g.tryTake(d, 1); } finally { undo.forEach((u) => u()); }
  assert.equal(got, 0);
  assert.ok(seen.length > 0, 'the slot was seen being taken');
  for (const s of seen) assert.ok(s.endsWith(`: ["${process.pid}"]`), `A SLOT NEVER EXISTS WITHOUT ITS HOLDER IN IT, saw ${seen.join(' | ')}`);
  g.give(d, 0);
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('slot-') || f.startsWith('claim-')), [], 'a given-back slot leaves nothing behind');
};
test('takeover: a waiter that read the old holder never removes the newer one; a slot never exists without its holder', (t) => K.takeover(G, tmp(t)));

// The rig's tree kill: own-procs' process table (a PowerShell CIM query) can time out in the burst.
// A fake kill on this live pid (never the real one: it would kill this process).
K.rigKill = (d = D) => {
  const rec = { pid: process.pid, bornMs: 0 };
  const kills = (fails) => { let n = 0; return { kill: () => { n++; if (n <= fails) throw new Error(`ETIMEDOUT ${n}`); }, calls: () => n }; };
  const ok = kills(0); d.killTree(rec, ok.kill);
  assert.equal(ok.calls(), 1, 'a kill that works runs once');
  const once = kills(1); d.killTree(rec, once.kill);
  assert.equal(once.calls(), 2, 'A FAILED KILL IS TRIED ONCE MORE');
  const twice = kills(2);
  assert.throws(() => d.killTree(rec, twice.kill), /rig cleanup failed: phase "kill tree" of pid \d+, twice \(ETIMEDOUT 1; then ETIMEDOUT 2\)/, 'TWICE IS A NAMED CLEANUP FAILURE');
};
/** destroy(): every step runs whatever an earlier one threw, then one named report. */
K.rigDestroy = async (d = D, dir) => {
  const sandbox = fs.mkdtempSync(path.join(dir, 'rig-'));
  const rig = new d.Rig(sandbox);
  rig.stop = async () => { throw new Error('stop: ETIMEDOUT'); };
  let stubsChecked = false;
  rig.waitStubsGone = async () => { stubsChecked = true; };
  const e = await rig.destroy().then(() => null, (x) => x);
  assert.ok(stubsChecked, 'A FAILED STOP DOES NOT SKIP THE REST OF THE CLEANUP');
  assert.ok(!fs.existsSync(sandbox), 'A FAILED STOP DOES NOT SKIP THE REST OF THE CLEANUP (sandbox)');
  assert.match(String(e && e.message), /^rig cleanup failed \(1\): stop: ETIMEDOUT$/, 'A CLEANUP FAILURE IS REPORTED, NAMED');
};
test('rig cleanup: a failed tree kill is tried once more, then a named cleanup failure', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => K.rigKill(D));
test('rig cleanup: destroy() runs every step past a failure and reports it once, named', (t) => K.rigDestroy(D, tmp(t)));

K.waits = (g = G, d) => {
  // A full gate waits, bounded: it never hangs a start.
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => { clock += ms; };
  g.tryTake(d, 1);
  const r = g.take(d, 1, { waitMs: 1000, now, sleep });
  assert.equal(r.slot, -1);
  assert.equal(r.timedOut, true, 'A FULL GATE WAITS A BOUNDED TIME, THEN STARTS WITHOUT A SLOT');
  assert.ok(r.waitMs >= 1000 && r.waitMs < 1100);
  assert.deepEqual(fs.readdirSync(d).filter((f) => f.startsWith('claim-')), [], 'A FILE THAT GOES ON WITHOUT A SLOT LEAVES NO CLAIM FOLDER BEHIND');
  // No gate folder: nothing to wait for.
  clock = 0;
  const gone = g.take(path.join(d, 'nope'), 2, { waitMs: 1000, now, sleep });
  assert.deepEqual(gone, { slot: -1, waitMs: 0, timedOut: false }, 'A MISSING GATE FOLDER IS NO WAIT');
  // A slot whose create fails for another reason (EPERM: Windows refuses a create while another
  // process's delete of that file is pending) is busy, never "the gate is gone".
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  assert.equal(g.tryTake(d, 1, Date.now, eperm), -3, 'A SLOT THAT CANNOT BE CREATED IS BUSY, NOT A MISSING GATE');
  // A fault on every slot for a moment is waited out; FAULT_POLLS in a row is a gate that cannot be written.
  const sub = (n) => { const p = path.join(d, n); fs.mkdirSync(p); return p; };
  let faults = 0;
  const passing = (p) => { if (++faults <= 5) eperm(); g.claim(p); };
  clock = 0;
  assert.equal(g.take(sub('passing'), 1, { now, sleep, make: passing }).slot, 0, 'A PASSING CREATE FAULT IS WAITED OUT');
  clock = 0;
  const stuck = g.take(sub('stuck'), 1, { waitMs: 120_000, now, sleep, make: eperm });
  assert.equal(stuck.faulted, true, 'A CREATE FAULT THAT PERSISTS ENDS THE WAIT EARLY');
  assert.ok(stuck.waitMs < 5000 && stuck.slot === -1, `A CREATE FAULT THAT PERSISTS ENDS THE WAIT EARLY (${stuck.waitMs} ms)`);
  // 0 slots records only.
  assert.deepEqual(g.take(d, 0, { now, sleep }), { slot: -1, waitMs: 0, timedOut: false });
};
test('a full gate waits a bounded time; a missing gate folder or 0 slots is no wait', (t) => K.waits(G, tmp(t)));

K.summary = (g = G) => {
  // heldFrom/heldTo: the same moments as before (slot taken, top level done), on the run's one clock.
  const line = (file, bornMs, waitMs, loadMs, slot = 0) => JSON.stringify({ file, bornMs, waitMs, loadMs, slot, heldFrom: bornMs + waitMs, heldTo: bornMs + loadMs });
  const text = [
    line('a', 1000, 0, 500), line('b', 1000, 0, 700), line('c', 1000, 400, 900), line('d', 1100, 600, 1000, -1),
    'torn {', line('late', 1000 + 61_000, 0, 50)
  ].join('\n');
  const s = g.burstSummary(text);
  assert.equal(s.files, 5);
  assert.equal(s.early, 4, 'ONLY THE FIRST MINUTE IS THE BURST');
  assert.deepEqual([s.loadP50, s.loadP95, s.loadMax], [700, 1000, 1000]);
  assert.deepEqual([s.netP50, s.netP95, s.netMax], [500, 700, 700], 'THE NET LOAD LEAVES THE GATE WAIT OUT');
  assert.equal(s.waitMax, 600);
  assert.equal(s.peakLoading, 4, 'THE MOST LOADING AT ONCE COUNTS FROM BIRTH');
  assert.equal(s.peakHolding, 3, 'THE MOST PAST THE GATE AT ONCE COUNTS FROM THE SLOT');
  assert.equal(s.noSlot, 1);
  assert.equal(g.burstSummary(''), null);
  // FLAKE-LOAD-BURST-196-GATE-OVERADMIT. A file that went on without a slot is past the gate: counted, and named.
  const why = 'create faults: 40 passes in a row, no slot could be created';
  const over = g.burstSummary([
    line('a', 1000, 0, 500), line('b', 1000, 0, 500),
    JSON.stringify({ file: 'c', bornMs: 1000, waitMs: 100, loadMs: 400, slot: -1, heldFrom: 1100, heldTo: 1400, why })
  ].join('\n'));
  assert.equal(over.peakHolding, 3, 'A FILE THAT WENT ON WITHOUT A SLOT IS COUNTED AS PAST THE GATE');
  assert.deepEqual(over.without, [`c: ${why}`], 'A FILE THAT WENT ON WITHOUT A SLOT IS NAMED, WITH ITS REASON');
  // The files' own wall clocks (bornMs, takenMs, loadMs) are never what the count is summed from:
  // b's wall clock is 50 ms behind a's, and it took the slot 1 ms after a gave it back.
  const skewed = g.burstSummary([
    JSON.stringify({ file: 'a', bornMs: 1000, takenMs: 1000, waitMs: 0, loadMs: 300, slot: 0, heldFrom: 5000, heldTo: 5300 }),
    JSON.stringify({ file: 'b', bornMs: 950, takenMs: 1251, waitMs: 301, loadMs: 601, slot: 0, heldFrom: 5301, heldTo: 5601 })
  ].join('\n'));
  assert.equal(skewed.peakHolding, 1, 'PAST THE GATE IS SUMMED ON THE ONE CLOCK, NOT THE WALL CLOCKS OF THE FILES');
  assert.equal(skewed.unclocked, 0);
  assert.equal(g.burstSummary(JSON.stringify({ file: 'old', bornMs: 1, waitMs: 0, loadMs: 9, slot: 0 })).unclocked, 1, 'A RECORD WITHOUT THE ONE CLOCK IS COUNTED AS SUCH, NOT DROPPED IN SILENCE');
};

// A start without a slot records why (the live test below fails on any such start, by name).
K.why = (g = G, d) => {
  let clock = 0;
  const now = () => clock;
  const sleep = (ms) => { clock += ms; };
  let ticks = 100;
  const tick = () => ++ticks;
  const sub = (n) => { const p = path.join(d, n); fs.mkdirSync(p); return p; };
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  const stuck = g.start(sub('stuck'), 1, 'f', { bornMs: 0, wall: now, tick, now, sleep, make: eperm }).end();
  assert.equal(stuck.slot, -1);
  assert.match(String(stuck.why), /^create faults: 40 passes in a row/, 'A START WITHOUT A SLOT RECORDS WHY: create faults');
  const full = sub('full'); g.tryTake(full, 1);
  clock = 0;
  assert.match(String(g.start(full, 1, 'f', { bornMs: 0, wall: now, tick, waitMs: 1000, now, sleep }).end().why), /^timeout: waited 1\d\d\d ms$/, 'A START WITHOUT A SLOT RECORDS WHY: timeout');
  assert.equal(g.start(path.join(d, 'nope'), 1, 'f', { bornMs: 0, wall: now, tick, now, sleep }).end().why, 'gate folder gone', 'A START WITHOUT A SLOT RECORDS WHY: gate folder gone');
  // With a slot, or with 0 slots (record only), there is no reason to give.
  clock = 500;
  const ok = g.start(sub('ok'), 1, 'f', { bornMs: 0, wall: now, tick, now, sleep });
  const t1 = ticks;
  clock = 800;
  const rec = ok.end();
  assert.equal('why' in rec, false, 'A START WITH A SLOT GIVES NO REASON');
  assert.equal('why' in g.start(sub('zero'), 0, 'f', { bornMs: 0, wall: now, tick, now, sleep }).end(), false, '0 SLOTS IS RECORD ONLY, NOT A START WITHOUT A SLOT');
  assert.deepEqual([rec.heldFrom, rec.heldTo], [t1, t1 + 1], 'THE HOLD IS READ ON THE ONE CLOCK: once after the take, once before the give');
  assert.deepEqual([rec.takenMs, rec.loadMs, rec.slot], [500, 800, 0], 'THE TAKE TIME IS ONE READING OF THE WALL CLOCK, AFTER THE TAKE');
  assert.deepEqual(fs.readdirSync(path.join(d, 'ok')), [], 'end() gives the slot back');
};
test('a start without a slot records why; the hold is read on the one clock', (t) => K.why(G, tmp(t)));
test('the burst summary: first minute only, load percentiles, gate wait, the most loading and past the gate at once', () => K.summary());

K.slotsDefault = (r = R) => {
  assert.equal(r.startSlots({}, 32), 8, 'THE DEFAULT IS A QUARTER OF THE CORES');
  assert.equal(r.startSlots({}, 4), 2, 'and at least 2');
  assert.equal(r.startSlots({ GUPPY_START_SLOTS: '0' }, 32), 0, 'GUPPY_START_SLOTS=0 IS RECORD ONLY');
  assert.equal(r.startSlots({ GUPPY_START_SLOTS: '5' }, 32), 5);
  for (const bad of ['', 'x', '-1', '1.5']) assert.equal(r.startSlots({ GUPPY_START_SLOTS: bad }, 32), 8, `a bad value is the default: ${JSON.stringify(bad)}`);
};
test('the slot count: a quarter of the cores (at least 2), GUPPY_START_SLOTS overrides, 0 records only', () => K.slotsDefault());

K.wiring = (r = R, d) => {
  const calls = []; const logs = [];
  const gate = { slots: 3, dir: path.join(d, 'gate') };
  fs.mkdirSync(gate.dir);
  fs.writeFileSync(path.join(gate.dir, 'starts.jsonl'), `${JSON.stringify({ file: 'a', bornMs: 1, waitMs: 0, loadMs: 9, slot: 0 })}\n`);
  const code = r.run({
    testDir: 'test', readdir: () => ['a.test.cjs'], spawn: (args, opts) => { calls.push({ args, env: { ...opts.env } }); return { status: 0 }; },
    log: (l) => logs.push(l), err: () => {}, timeoutMs: 5000, eventsFile: 'ev', readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }, removeFile: () => {},
    watchdog: () => ({ stop: () => {} }), fileJob: () => ({ exe: 'job.exe' }), startGate: () => gate, cpuMask: () => null
  });
  assert.equal(code, 0);
  const env = calls[0].env;
  assert.equal(env.GUPPY_START_GATE, `3|${gate.dir}`, 'THE RUN HANDS ITS FILES THE GATE');
  const g = env.NODE_OPTIONS.indexOf('file-start-gate.cjs'); const j = env.NODE_OPTIONS.indexOf('file-job-preload.cjs');
  assert.ok(g >= 0 && j > g, `THE GATE LOADS BEFORE THE JOB JOIN: ${env.NODE_OPTIONS}`);
  assert.ok(env.NODE_OPTIONS.includes(env.GUPPY_START_OPT));
  const burst = logs.findIndex((l) => l.startsWith('[test-runner] start-up burst: 1 files, 3 start slots'));
  assert.ok(burst >= 0, `THE RUN LOGS ITS BURST: ${logs.join(' | ')}`);
  assert.ok(burst < logs.length - 1, 'before the totals line, which stays last');
  assert.equal(fs.existsSync(gate.dir), false, 'THE GATE FOLDER IS REMOVED AFTER THE RUN');
  // An injected spawn gets no gate by default (nothing real to gate).
  const plain = [];
  r.run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: (args, opts) => { plain.push(opts.env); return { status: 0 }; }, log: () => {}, err: () => {}, timeoutMs: 5000, eventsFile: 'ev', readFile: () => '', removeFile: () => {}, watchdog: () => ({ stop: () => {} }), fileJob: () => ({ exe: null, why: null }), cpuMask: () => null });
  assert.equal(plain[0].GUPPY_START_GATE, undefined);
};
test('wiring: the run hands its files the gate before the job join, logs the burst before the totals, removes the gate', (t) => K.wiring(R, tmp(t)));

// Real processes through the preload: 6 files, 2 slots, each holding its top level for 300 ms.
const SLOW_TOP = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\nprocess.stdout.write(String(process.env.NODE_OPTIONS || '') + '|' + String(process.env.GUPPY_START_GATE || ''));\n";
async function liveRun(d, slots, n = 6, { gateFile = GATE_FILE, body = SLOW_TOP, pre = null } = {}) {
  const gateDir = path.join(d, 'gate'); fs.mkdirSync(gateDir, { recursive: true });
  const file = path.join(d, 'slow.cjs');
  fs.writeFileSync(file, body);
  const opt = [pre, gateFile].filter(Boolean).map((f) => `--require "${f.split(path.sep).join('/')}"`).join(' ');
  const env = { ...process.env, NODE_OPTIONS: opt, GUPPY_START_GATE: `${slots}|${gateDir}`, GUPPY_START_OPT: opt, NODE_TEST_CONTEXT: 'child-v8' };
  let errs = '';
  const outs =await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { errs += b; });
    p.on('error', reject); p.on('exit', () => resolve(out));
  })));
  const text = fs.readFileSync(path.join(gateDir, 'starts.jsonl'), 'utf8');
  return { outs, errs, text, summary: G.burstSummary(text), left: fs.readdirSync(gateDir).filter((f) => f.startsWith('slot-')) };
}

/**
 * FLAKE-LOAD-BURST-196-GATE-OVERADMIT: a file that went on without a slot is past the gate on purpose
 * (timeout, create faults, gate gone). It used to say so only on its own stderr, which nothing read,
 * and the run then failed as "more than SLOTS past the gate". It fails here first, by name and reason.
 */
const assertAllHadASlot = (summary, errs) => {
  assert.deepEqual(summary.without, [], `NO FILE GOES ON WITHOUT A SLOT: ${summary.without.join('; ')} | stderr: ${String(errs).trim()}`);
  assert.equal(summary.unclocked, 0, 'EVERY START IS ON THE ONE CLOCK');
};

K.live = async (gateFile, d) => {
  const { outs, errs, summary, left } = await liveRun(d, 2, 6, { gateFile });
  assert.equal(summary.files, 6, 'EVERY FILE RECORDS ITS START ONCE');
  assertAllHadASlot(summary, errs);
  assert.ok(summary.peakHolding <= 2, `AT MOST 2 FILES PAST THE GATE AT ONCE, got ${summary.peakHolding}`);
  assert.ok(summary.waitMax >= 250, `later files waited for a slot (${summary.waitMax} ms)`);
  assert.deepEqual(left, [], 'EVERY SLOT IS GIVEN BACK');
  for (const o of outs) assert.equal(o, '|', `THE PRELOAD TAKES ITSELF BACK OUT OF THE FILE'S ENV: ${o}`);
};
test('live: 6 files through the preload with 2 slots never have more than 2 past the gate; each records once and gives its slot back', { timeout: 120_000 }, (t) => K.live(GATE_FILE, tmp(t)));

/**
 * FLAKE-LOAD-BURST-196-GATE-OVERADMIT, the red-before. Every process fixes its own wall clock at its
 * start, so two processes disagree. Here the disagreement is made large enough to be certain: two
 * files hold both slots, and a third, whose wall clock is skewMs behind (a preload ahead of the gate),
 * is started once both slots are held. It takes a slot only after a holder gave one back: never 3 past
 * the gate. Its wall clock says it took the slot skewMs earlier, while both holders still held theirs:
 * summed on the wall clocks, that is 3 on 2.
 * Every step is released on a signal, never on a timer in the files (Jim e38f17: node startup under
 * load would eat a fixed hold). The holders hold until the test writes 'release', and it writes that
 * HOLD_MS after the late file is seen waiting at the gate: the gate's own claim-<pid> folder, made
 * after the wait began. So the late file waited HOLD_MS or more by construction. The late file then
 * holds until 'late-release', written skewMs after both slots were seen held, so that on its wall
 * clock its hold still reaches into the holders'. starve: the holders are released before the late
 * file is started (the fixture then has to say so itself).
 */
const HOLD_MS = 500;
const SKEW_MS = 6000;
const holdTop = (until) => `const a = new Int32Array(new SharedArrayBuffer(4)); const t0 = process.hrtime.bigint();\nwhile (!require('fs').existsSync(${JSON.stringify(until)}) && process.hrtime.bigint() - t0 < 60_000_000_000n) Atomics.wait(a, 0, 0, 20);\n`;
K.skew = async (gateFile, d, { skewMs = SKEW_MS, starve = false } = {}) => {
  const gateDir = path.join(d, 'gate'); fs.mkdirSync(gateDir, { recursive: true });
  const fwd = (f) => f.split(path.sep).join('/');
  const holder = path.join(d, 'holder.cjs'); const late = path.join(d, 'late.cjs'); const pre = path.join(d, 'skew.cjs');
  const release = path.join(d, 'release'); const lateRelease = path.join(d, 'late-release');
  fs.writeFileSync(holder, holdTop(release)); fs.writeFileSync(late, holdTop(lateRelease));
  fs.writeFileSync(pre, `const real = Date.now; Date.now = () => real() - ${skewMs};\n`);
  let errs = '';
  const run = (file, opt) => {
    const env = { ...process.env, NODE_OPTIONS: opt, GUPPY_START_GATE: `2|${gateDir}`, GUPPY_START_OPT: opt, NODE_TEST_CONTEXT: 'child-v8' };
    const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    p.stderr.on('data', (b) => { errs += b; });
    return { pid: p.pid, done: new Promise((resolve, reject) => { p.on('error', reject); p.on('exit', resolve); }) };
  };
  const mono = () => Number(process.hrtime.bigint() / 1_000_000n);
  const until = async (ok, what) => {
    for (const t0 = mono(); !ok();) {
      assert.ok(mono() - t0 < 60_000, `the fixture: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const plain = `--require "${fwd(gateFile)}"`;
  const holders = [run(holder, plain), run(holder, plain)];
  await until(() => [0, 1].every((k) => fs.existsSync(path.join(gateDir, `slot-${k}`))), 'the two holders never took their slots');
  const bothHeld = mono();
  if (starve) { fs.writeFileSync(release, ''); await Promise.all(holders.map((h) => h.done)); }
  const third = run(late, `--require "${fwd(pre)}" ${plain}`);
  if (!starve) {
    await until(() => fs.existsSync(path.join(gateDir, `claim-${third.pid}`)), 'the late file never reached the gate');
    const seen = mono();
    await until(() => mono() - seen >= HOLD_MS + 2, 'the hold never ended');
    fs.writeFileSync(release, '');
  }
  await until(() => [0, 1].some((k) => fs.existsSync(path.join(gateDir, `slot-${k}`, String(third.pid)))), 'the late file never took a slot');
  const took = mono();
  await until(() => mono() - bothHeld >= skewMs + 250 && mono() - took >= 50, 'the late hold never ended');
  fs.writeFileSync(lateRelease, '');
  await Promise.all([...holders, third].map((h) => h.done));
  const text = fs.readFileSync(path.join(gateDir, 'starts.jsonl'), 'utf8');
  const recs = text.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const summary = G.burstSummary(text);
  assert.equal(summary.files, 3);
  assertAllHadASlot(summary, errs);
  // The fixture did what it says: on the wall clocks, the late file took its slot while both holders held theirs.
  const lateRec = recs.find((r) => /late\.cjs$/.test(r.file)); const held = recs.filter((r) => /holder\.cjs$/.test(r.file));
  assert.equal(held.length, 2);
  assert.ok(lateRec.waitMs >= HOLD_MS, `the fixture: the late file waited for a holder, ${HOLD_MS} ms or more (${lateRec.waitMs} ms)`);
  const wallFrom = Math.max(...recs.map((r) => r.takenMs)); const wallTo = Math.min(...recs.map((r) => r.bornMs + r.loadMs));
  assert.ok(wallFrom < wallTo, `the fixture: on the files' wall clocks all three hold at once (latest take ${wallFrom}, first end ${wallTo})`);
  assert.ok(summary.peakHolding <= 2, `CLOCKS THAT DISAGREE BETWEEN PROCESSES DO NOT PUT A THIRD FILE PAST A 2-SLOT GATE, got ${summary.peakHolding}`);
};
test('live: a file whose wall clock is behind takes a slot after a holder gave it back, and is never summed as a third past the gate', { timeout: 120_000 }, (t) => K.skew(GATE_FILE, tmp(t)));
// The skew test is only worth its green when the fixture really made the overlap: starved, it says so by name.
// The second case skews the late clock 2 s AHEAD (Jim ac9183): with no skew, "no overlap" would itself
// rest on the files' wall clocks agreeing to a few ms, which is what this card says they do not.
test('live: the skew fixture, starved, fails as the fixture and not as the gate', { timeout: 120_000 }, async (t) => {
  await assert.rejects(() => K.skew(GATE_FILE, tmp(t), { skewMs: 300, starve: true }), /the fixture: the late file waited for a holder/, 'HOLDERS GONE BEFORE THE LATE FILE: NAMED AS THE FIXTURE');
  await assert.rejects(() => K.skew(GATE_FILE, tmp(t), { skewMs: -2000 }), /the fixture: on the files' wall clocks all three hold at once/, 'THE LATE CLOCK AHEAD, NOT BEHIND: NAMED AS THE FIXTURE');
});

// The slot goes back once the top level has run, not at exit (Jim a5a246): 1 slot, 2 files whose
// tests run 2 s AFTER a quick top level. Held to exit, the gate would cap the whole run, not its start.
// LOAD-FLAKES-105: the 2 s tail starts once BOTH files have reached the gate (a preload ahead of it
// marks each arrival), so the second always arrives while the first holds its slot. A fixed tail from
// the top level let a loaded machine boot the second file after the first had exited, and a held-to-
// exit slot then cost it no wait (g6: the mutant survived).
const ARRIVE = "const fs = require('fs'), path = require('path'); const m = path.join(__dirname, 'arrived');\n"
  + "fs.mkdirSync(m, { recursive: true }); fs.writeFileSync(path.join(m, String(process.pid)), '');\n";
const LONG_TAIL = "const fs = require('fs'), path = require('path'); const m = path.join(__dirname, 'arrived');\n"
  + 'const iv = setInterval(() => { if (fs.readdirSync(m).length >= 2) { clearInterval(iv); setTimeout(() => {}, 2000); } }, 20);\n';
K.release = async (gateFile, d) => {
  const pre = path.join(d, 'arrive.cjs');
  fs.writeFileSync(pre, ARRIVE);
  const { summary, text } = await liveRun(d, 1, 2, { gateFile, body: LONG_TAIL, pre });
  assert.equal(summary.files, 2);
  const waits = text.trim().split(/\r?\n/).map((l) => JSON.parse(l).waitMs);
  assert.ok(Math.max(...waits) < 1500, `THE SLOT IS GIVEN BACK ONCE THE TOP LEVEL HAS RUN, NOT AT EXIT (waits ${waits.join(', ')} ms)`);
};
test('live: the slot is given back once the top level has run, not when the file exits', { timeout: 120_000 }, (t) => K.release(GATE_FILE, tmp(t)));

test('live: 0 slots records only (the before measurement): no wait', { timeout: 120_000 }, async (t) => {
  const { summary } = await liveRun(tmp(t), 0, 4);
  assert.equal(summary.files, 4);
  assert.equal(summary.waitMax, 0);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutatedText(file, edits, tag) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');   // a CRLF checkout (autocrlf): one target form
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const mutate = (file, edits, tag) => fromText(file, mutatedText(file, edits, tag));

const MUTANTS = [
  { name: 'slots are not exclusive', file: GATE_FILE, edits: [['  try { fs.renameSync(mine, p); } catch (e) {', '  try { fs.renameSync(mine, p); } catch (e) { return;']], killer: 'slots', dies: /A TAKEN SLOT IS NOT TAKEN AGAIN/ },
  { name: 'a dead holder is never taken over', file: GATE_FILE, edits: [['if ((pid > 0 && !alive(pid)) || held > STALE_MS)', 'if (held > STALE_MS)']], killer: 'slots', dies: /A DEAD HOLDER IS TAKEN OVER/ },
  { name: 'a stale holder is never taken over', file: GATE_FILE, edits: [['if ((pid > 0 && !alive(pid)) || held > STALE_MS)', 'if (pid > 0 && !alive(pid))']], killer: 'slots', dies: /A STALE HOLDER IS TAKEN OVER/ },
  { name: 'any process gives a slot back', file: GATE_FILE, edits: [["  try { fs.rmSync(path.join(p, String(process.pid)), { force: true }); fs.rmdirSync(p); } catch { /* taken over */ }", "  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* taken over */ }"]], killer: 'slots', dies: /ANOTHER PROCESS DOES NOT GIVE BACK/ },
  // TEST-GATE-SLOT-TAKEOVER-107.
  { name: 'a waiter clears a gone holder by the slot path (the defect)', file: GATE_FILE, edits: [['|| held > STALE_MS) fs.rmSync(m, { force: true });', '|| held > STALE_MS) fs.rmSync(p, { recursive: true, force: true });']], killer: 'takeover', dies: /A WAITER NEVER REMOVES A NEWER HOLDER/ },
  { name: 'a waiter removes a slot folder that is not empty', file: GATE_FILE, edits: [["  try { fs.rmdirSync(p); } catch { /* held (not empty), or gone meanwhile */ }", "  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* held (not empty), or gone meanwhile */ }"]], killer: 'takeover', dies: /A WAITER NEVER REMOVES A NEWER HOLDER/ },
  { name: 'a cleared slot folder is left behind', file: GATE_FILE, edits: [["  try { fs.rmdirSync(p); } catch { /* held (not empty), or gone meanwhile */ }", '']], killer: 'takeover', dies: /A DEAD HOLDER IS TAKEN OVER/ },
  { name: 'the slot is made, then marked (two steps)', file: GATE_FILE, edits: [['  try { fs.renameSync(mine, p); } catch (e) {', "  try { fs.mkdirSync(p); fs.writeFileSync(path.join(p, String(process.pid)), ''); } catch (e) {"]], killer: 'takeover', dies: /A SLOT NEVER EXISTS WITHOUT ITS HOLDER IN IT/ },
  { name: 'a file without a slot leaves its claim folder (Jim G2)', file: GATE_FILE, edits: [['  const out = (r) => { if (r.slot < 0) unclaim(dir); return r; };', '  const out = (r) => r;']], killer: 'waits', dies: /A FILE THAT GOES ON WITHOUT A SLOT LEAVES NO CLAIM FOLDER BEHIND/ },
  { name: 'the wait is unbounded', file: GATE_FILE, edits: [['    if (now() - t0 >= waitMs) return', '    if (now() - t0 >= Infinity) return']], killer: 'waits', dies: /A FULL GATE WAITS A BOUNDED TIME|Infinity|timed out/, guard: true },
  { name: 'a missing gate folder is waited on', file: GATE_FILE, edits: [["      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return -2;", '']], killer: 'waits', dies: /A MISSING GATE FOLDER IS NO WAIT/ },
  { name: 'any failed create is a missing gate (the after FULL: starts without a slot)', file: GATE_FILE, edits: [["      if (e.code !== 'EEXIST') { faults++; continue; }", "      if (e.code !== 'EEXIST') return -2;"]], killer: 'waits', dies: /A SLOT THAT CANNOT BE CREATED IS BUSY, NOT A MISSING GATE/ },
  { name: 'a persistent create fault waits the full time', file: GATE_FILE, edits: [['    if (faulted >= FAULT_POLLS) return out({ slot: -1, waitMs: now() - t0, timedOut: false, faulted: true });\n', '']], killer: 'waits', dies: /A CREATE FAULT THAT PERSISTS ENDS THE WAIT EARLY/ },
  { name: 'a passing create fault ends the wait', file: GATE_FILE, edits: [['if (faulted >= FAULT_POLLS)', 'if (faulted >= 1)']], killer: 'waits', dies: /A PASSING CREATE FAULT IS WAITED OUT/ },
  // Live: the preload runs from a mutated copy of the gate file (it requires only fs and path).
  { name: 'the slot is given back at exit (Jim a5a246)', file: GATE_FILE, live: true, edits: [['  setImmediate(finish);', "  process.once('beforeExit', finish);"]], killer: 'release', dies: /THE SLOT IS GIVEN BACK ONCE THE TOP LEVEL HAS RUN, NOT AT EXIT/ },
  { name: 'the burst is the whole run', file: GATE_FILE, edits: [['  const early = recs.filter((r) => r.bornMs - t0 < windowMs);', '  const early = recs;']], killer: 'summary', dies: /ONLY THE FIRST MINUTE IS THE BURST/ },
  { name: 'past the gate counts from birth', file: GATE_FILE, edits: [['peakHolding: peakOf((r) => r.heldFrom, (r) => r.heldTo, held),', 'peakHolding: peakOf((r) => r.bornMs, (r) => r.heldTo, held),']], killer: 'summary', dies: /THE MOST PAST THE GATE AT ONCE COUNTS FROM THE SLOT/ },
  // FLAKE-LOAD-BURST-196-GATE-OVERADMIT
  { name: 'past the gate is summed on the wall clocks of the files (the defect)', file: GATE_FILE, edits: [['peakHolding: peakOf((r) => r.heldFrom, (r) => r.heldTo, held),', 'peakHolding: peakOf((r) => r.takenMs ?? r.bornMs + (r.waitMs || 0), undefined, held),']], killer: 'summary', dies: /PAST THE GATE IS SUMMED ON THE ONE CLOCK/ },
  { name: 'a file without a slot is not counted as past the gate', file: GATE_FILE, edits: [['Number.isFinite(r.heldFrom) && Number.isFinite(r.heldTo));', 'Number.isFinite(r.heldFrom) && Number.isFinite(r.heldTo) && r.slot >= 0);']], killer: 'summary', dies: /A FILE THAT WENT ON WITHOUT A SLOT IS COUNTED AS PAST THE GATE/ },
  { name: 'a file without a slot is not named', file: GATE_FILE, edits: [['    without: recs.filter((r) => r.why)', '    without: recs.filter((r) => r.why && 0)']], killer: 'summary', dies: /A FILE THAT WENT ON WITHOUT A SLOT IS NAMED/ },
  { name: 'a record without the one clock is dropped in silence', file: GATE_FILE, edits: [['unclocked: recs.length - held.length', 'unclocked: 0']], killer: 'summary', dies: /A RECORD WITHOUT THE ONE CLOCK IS COUNTED AS SUCH/ },
  { name: 'a start without a slot records no reason', file: GATE_FILE, edits: [['    if (why) rec.why = why;\n', '']], killer: 'why', dies: /A START WITHOUT A SLOT RECORDS WHY: create faults/ },
  { name: 'a timeout is recorded as a create fault', file: GATE_FILE, edits: [['  if (got.timedOut) return `timeout: waited ${got.waitMs} ms`;\n', '']], killer: 'why', dies: /A START WITHOUT A SLOT RECORDS WHY: timeout/ },
  { name: '0 slots is recorded as a start without a slot', file: GATE_FILE, edits: [['  if (got.slot >= 0 || slots <= 0) return undefined;', '  if (got.slot >= 0) return undefined;']], killer: 'why', dies: /0 SLOTS IS RECORD ONLY, NOT A START WITHOUT A SLOT/ },
  { name: 'the hold is read on the wall clock (unit)', file: GATE_FILE, edits: [['  const heldFrom = tick();', '  const heldFrom = wall();'], ['    const heldTo = tick();', '    const heldTo = wall();']], killer: 'why', dies: /THE HOLD IS READ ON THE ONE CLOCK/ },
  { name: 'the hold is read on the wall clock (live: 3 on 2 from skew alone)', file: GATE_FILE, live: true, edits: [['  const heldFrom = tick();', '  const heldFrom = wall();'], ['    const heldTo = tick();', '    const heldTo = wall();']], killer: 'skew', dies: /CLOCKS THAT DISAGREE BETWEEN PROCESSES DO NOT PUT A THIRD FILE PAST A 2-SLOT GATE, got 3/ },
  { name: 'every create faults: the files go on without a slot (live)', file: GATE_FILE, live: true, edits: [['      make(p);\n      return k;', "      throw Object.assign(new Error('EPERM: mutant'), { code: 'EPERM' });"]], killer: 'live', dies: /NO FILE GOES ON WITHOUT A SLOT: .*create faults: 40 passes in a row/ },
  { name: 'the net load keeps the gate wait', file: GATE_FILE, edits: [['  const nets = sorted((r) => r.loadMs - (r.waitMs || 0));', '  const nets = sorted((r) => r.loadMs);']], killer: 'summary', dies: /THE NET LOAD LEAVES THE GATE WAIT OUT/ },
  { name: 'the default is every core', file: RUNNER_FILE, edits: [[': Math.max(2, Math.ceil(cores / 4));', ': cores;']], killer: 'slotsDefault', dies: /THE DEFAULT IS A QUARTER OF THE CORES/ },
  { name: '0 slots is the default, not record only', file: RUNNER_FILE, edits: [['Number.isInteger(n) && n >= 0 ?', 'Number.isInteger(n) && n > 0 ?']], killer: 'slotsDefault', dies: /GUPPY_START_SLOTS=0 IS RECORD ONLY/ },
  { name: 'the gate is not handed to the files', file: RUNNER_FILE, edits: [['    env.GUPPY_START_GATE = `${gate.slots}|${gate.dir}`;\n', '']], killer: 'wiring', dies: /THE RUN HANDS ITS FILES THE GATE/ },
  { name: 'the gate is not in NODE_OPTIONS', file: RUNNER_FILE, edits: [['    env.NODE_OPTIONS = [env.NODE_OPTIONS, opt].filter(Boolean).join(\' \');\n    env.GUPPY_START_GATE', '    env.NODE_OPTIONS = [env.NODE_OPTIONS].filter(Boolean).join(\' \');\n    env.GUPPY_LATE_GATE = opt;\n    env.GUPPY_START_GATE']], killer: 'wiring', dies: /THE GATE LOADS BEFORE THE JOB JOIN/ },
  { name: 'no burst line', file: RUNNER_FILE, edits: [["  if (gate) log(burstLine(readFile(path.join(gate.dir, 'starts.jsonl')), gate.slots));\n", '']], killer: 'wiring', dies: /THE RUN LOGS ITS BURST/ },
  { name: 'the gate folder is left behind', file: RUNNER_FILE, edits: [['    if (gate) { try { fs.rmSync(gate.dir, { recursive: true, force: true }); } catch { /* best effort */ } }', '    if (gate) { /* left */ }']], killer: 'wiring', dies: /THE GATE FOLDER IS REMOVED AFTER THE RUN/ },
  { name: 'a failed tree kill is not tried again', file: DRIVER_FILE, win32: true, edits: [['    if (!pidAlive(rec.pid)) return;\n    try { kill(rec); } catch (e) {', '    return;\n    try { kill(rec); } catch (e) {']], killer: 'rigKill', dies: /A FAILED KILL IS TRIED ONCE MORE/ },
  { name: 'a second failure is a bare error', file: DRIVER_FILE, win32: true, edits: [['      throw new Error(`rig cleanup failed: phase "kill tree"', '      throw e; throw new Error(`rig cleanup failed: phase "kill tree"']], killer: 'rigKill', dies: /TWICE IS A NAMED CLEANUP FAILURE/ },
  { name: 'a failed stop ends destroy()', file: DRIVER_FILE, edits: [['const step = async (f) => { try { await f(); } catch (e) { failed.push(e.message); } };', 'const step = async (f) => f();']], killer: 'rigDestroy', dies: /A FAILED STOP DOES NOT SKIP THE REST OF THE CLEANUP/ },
  { name: 'cleanup failures are swallowed', file: DRIVER_FILE, edits: [['    if (failed.length) throw new Error(`rig cleanup failed', '    if (failed.length && 0) throw new Error(`rig cleanup failed']], killer: 'rigDestroy', dies: /A CLEANUP FAILURE IS REPORTED, NAMED/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    if (m.win32 && process.platform !== 'win32') continue;
    await t.test(`mutant: ${m.name}`, async (tt) => {
      const d = tmp(tt);
      let M;
      if (m.live) {
        M = path.join(d, 'gate-mutant.cjs');
        fs.writeFileSync(M, mutatedText(m.file, m.edits, m.name));
      } else M = mutate(m.file, m.edits, m.name);
      if (m.guard) {
        // An unbounded wait would loop forever on the fake clock: cap the loop from the sleep.
        let n = 0;
        const orig = M.take;
        M.take = (dir, slots, o = {}) => orig(dir, slots, { ...o, sleep: (ms) => { if (++n > 10_000) throw new Error('timed out: the wait never ended'); o.sleep(ms); } });
      }
      await assert.rejects(async () => K[m.killer](M, d), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
