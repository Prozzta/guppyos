'use strict';
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

K.slots = (g = G, d) => {
  assert.equal(g.tryTake(d, 2), 0);
  assert.equal(g.tryTake(d, 2), 1, 'A TAKEN SLOT IS NOT TAKEN AGAIN');
  assert.equal(g.tryTake(d, 2), -1, 'NO THIRD FILE GETS ONE OF TWO SLOTS');
  g.give(d, 0);
  assert.equal(g.tryTake(d, 2), 0, 'A GIVEN-BACK SLOT IS TAKEN AGAIN');
  // A holder that is gone is taken over: a dead pid, or held past STALE_MS.
  fs.writeFileSync(path.join(d, 'slot-1'), '999999');
  assert.equal(g.tryTake(d, 2), -1, 'the pass that finds a dead holder clears it');
  assert.equal(g.tryTake(d, 2), 1, 'A DEAD HOLDER IS TAKEN OVER');
  const old = (Date.now() - g.STALE_MS - 1000) / 1000;
  fs.utimesSync(path.join(d, 'slot-0'), old, old);
  g.tryTake(d, 2);
  assert.equal(g.tryTake(d, 2), 0, 'A STALE HOLDER IS TAKEN OVER');
  // Only the holder gives a slot back.
  fs.writeFileSync(path.join(d, 'slot-0'), '4');
  g.give(d, 0);
  assert.ok(fs.existsSync(path.join(d, 'slot-0')), 'ANOTHER PROCESS DOES NOT GIVE BACK A SLOT IT DOES NOT HOLD');
};
test('slots: exclusive, given back, a dead or stale holder taken over, only the holder gives back', (t) => K.slots(G, tmp(t)));

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
  const passing = (p) => { if (++faults <= 5) eperm(); fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); };
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
  const line = (file, bornMs, waitMs, loadMs, slot = 0) => JSON.stringify({ file, bornMs, waitMs, loadMs, slot });
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
};
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
async function liveRun(d, slots, n = 6, { gateFile = GATE_FILE, body = SLOW_TOP } = {}) {
  const gateDir = path.join(d, 'gate'); fs.mkdirSync(gateDir, { recursive: true });
  const file = path.join(d, 'slow.cjs');
  fs.writeFileSync(file, body);
  const opt = `--require "${gateFile.split(path.sep).join('/')}"`;
  const env = { ...process.env, NODE_OPTIONS: opt, GUPPY_START_GATE: `${slots}|${gateDir}`, GUPPY_START_OPT: opt, NODE_TEST_CONTEXT: 'child-v8' };
  const outs = await Promise.all(Array.from({ length: n }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; p.stdout.on('data', (b) => { out += b; });
    p.on('error', reject); p.on('exit', () => resolve(out));
  })));
  const text = fs.readFileSync(path.join(gateDir, 'starts.jsonl'), 'utf8');
  return { outs, text, summary: G.burstSummary(text), left: fs.readdirSync(gateDir).filter((f) => f.startsWith('slot-')) };
}

test('live: 6 files through the preload with 2 slots never have more than 2 past the gate; each records once and gives its slot back', { timeout: 120_000 }, async (t) => {
  const { outs, summary, left } = await liveRun(tmp(t), 2);
  assert.equal(summary.files, 6, 'EVERY FILE RECORDS ITS START ONCE');
  assert.ok(summary.peakHolding <= 2, `AT MOST 2 FILES PAST THE GATE AT ONCE, got ${summary.peakHolding}`);
  assert.ok(summary.waitMax >= 250, `later files waited for a slot (${summary.waitMax} ms)`);
  assert.deepEqual(left, [], 'EVERY SLOT IS GIVEN BACK');
  for (const o of outs) assert.equal(o, '|', `THE PRELOAD TAKES ITSELF BACK OUT OF THE FILE'S ENV: ${o}`);
});

// The slot goes back once the top level has run, not at exit (Jim a5a246): 1 slot, 2 files whose
// tests run 2 s AFTER a quick top level. Held to exit, the gate would cap the whole run, not its start.
const LONG_TAIL = 'setTimeout(() => {}, 2000);\n';
K.release = async (gateFile, d) => {
  const { summary, text } = await liveRun(d, 1, 2, { gateFile, body: LONG_TAIL });
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
  { name: 'slots are not exclusive', file: GATE_FILE, edits: [["{ flag: 'wx' }", "{ flag: 'w' }"]], killer: 'slots', dies: /A TAKEN SLOT IS NOT TAKEN AGAIN/ },
  { name: 'a dead holder is never taken over', file: GATE_FILE, edits: [['if ((pid > 0 && !alive(pid)) || held > STALE_MS)', 'if (held > STALE_MS)']], killer: 'slots', dies: /A DEAD HOLDER IS TAKEN OVER/ },
  { name: 'a stale holder is never taken over', file: GATE_FILE, edits: [['if ((pid > 0 && !alive(pid)) || held > STALE_MS)', 'if (pid > 0 && !alive(pid))']], killer: 'slots', dies: /A STALE HOLDER IS TAKEN OVER/ },
  { name: 'any process gives a slot back', file: GATE_FILE, edits: [['  try { if (Number(fs.readFileSync(p, \'utf8\')) === process.pid) fs.rmSync(p, { force: true }); } catch { /* taken over */ }', '  try { fs.rmSync(p, { force: true }); } catch { /* taken over */ }']], killer: 'slots', dies: /ANOTHER PROCESS DOES NOT GIVE BACK/ },
  { name: 'the wait is unbounded', file: GATE_FILE, edits: [['    if (now() - t0 >= waitMs) return', '    if (now() - t0 >= Infinity) return']], killer: 'waits', dies: /A FULL GATE WAITS A BOUNDED TIME|Infinity|timed out/, guard: true },
  { name: 'a missing gate folder is waited on', file: GATE_FILE, edits: [["      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return -2;", '']], killer: 'waits', dies: /A MISSING GATE FOLDER IS NO WAIT/ },
  { name: 'any failed create is a missing gate (the after FULL: starts without a slot)', file: GATE_FILE, edits: [["      if (e.code !== 'EEXIST') { faults++; continue; }", "      if (e.code !== 'EEXIST') return -2;"]], killer: 'waits', dies: /A SLOT THAT CANNOT BE CREATED IS BUSY, NOT A MISSING GATE/ },
  { name: 'a persistent create fault waits the full time', file: GATE_FILE, edits: [['    if (faulted >= FAULT_POLLS) return { slot: -1, waitMs: now() - t0, timedOut: false, faulted: true };\n', '']], killer: 'waits', dies: /A CREATE FAULT THAT PERSISTS ENDS THE WAIT EARLY/ },
  { name: 'a passing create fault ends the wait', file: GATE_FILE, edits: [['if (faulted >= FAULT_POLLS)', 'if (faulted >= 1)']], killer: 'waits', dies: /A PASSING CREATE FAULT IS WAITED OUT/ },
  // Live: the preload runs from a mutated copy of the gate file (it requires only fs and path).
  { name: 'the slot is given back at exit (Jim a5a246)', file: GATE_FILE, live: true, edits: [['  setImmediate(finish);', "  process.once('beforeExit', finish);"]], killer: 'release', dies: /THE SLOT IS GIVEN BACK ONCE THE TOP LEVEL HAS RUN, NOT AT EXIT/ },
  { name: 'the burst is the whole run', file: GATE_FILE, edits: [['  const early = recs.filter((r) => r.bornMs - t0 < windowMs);', '  const early = recs;']], killer: 'summary', dies: /ONLY THE FIRST MINUTE IS THE BURST/ },
  { name: 'past the gate counts from birth', file: GATE_FILE, edits: [['peakHolding: peakOf((r) => r.takenMs ?? r.bornMs + (r.waitMs || 0)),', 'peakHolding: peakOf((r) => r.bornMs),']], killer: 'summary', dies: /THE MOST PAST THE GATE AT ONCE COUNTS FROM THE SLOT/ },
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
