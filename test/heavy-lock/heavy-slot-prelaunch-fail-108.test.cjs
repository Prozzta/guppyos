'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-SLOT-PRELAUNCH-FAIL-108 (god e1cf96, 2026-11-19). A heavy slot reserved for an agent was lost
 * when the reserved launch died before any test started. Seen live four times:
 *  - 2026-11-18T10:00Z and 2026-11-19T10:17Z (Dwight): `npm test` from PowerShell resolved to npm.ps1,
 *    which the execution policy refused before Node started;
 *  - 2026-11-18T10:54Z (Dwight): run-tests.cjs asked for its lease, then its preflight said
 *    "TREE GAP fs-handle" and exited before either leg;
 *  - 2026-11-18T09:26Z (Andy): npm ci ended rc=127. `npm ci && npm test` classes as an INSTALL, and an
 *    install that ran used its slot: this rule does not apply to it (K.chain pins the class).
 * One cause: acquireAs() spends the reservation when the call is ALLOWED; PostToolUse then releases
 * the holder and grant() reserves the slot for the next waiter. "The call returned" was read as "the
 * job ran". Now a SUITE holder whose slot came from a reservation, and that ends (posttool, job-exit,
 * process-exit) with no test process having leased under it and no sighting by the watcher, keeps
 * its slot: reserved for the same agent for a fresh HEAVY_RESERVE_MS ('reserve-kept'), and it is told.
 * THE BOUND (god: "state the timing bound"): once per grant. A kept reservation is never kept again,
 * whatever spends it, and neither is one queued again after it lapsed: the queue waits at most ONE
 * extra HEAVY_RESERVE_MS behind a launch that keeps failing. Lock state is memory only: a restart
 * drops a kept slot like any reservation. Suite only: a bench or an install has no proof of a start.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const SUITE = { heavy: true, kind: 'suite', why: 'npm test' };
const INSTALL = { heavy: true, kind: 'install', why: 'npm ci' };
const BENCH = { heavy: true, kind: 'bench', why: 'a bench' };
const RUNNER = 'C:\\Dunder\\wt\\test\\tools\\run-tests.cjs';
const C0 = 1_000_050;

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const kept = []; const lapses = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), notifyKept: (a, k, until) => kept.push({ a, k, until }), notifyLapse: (a, k, why) => lapses.push([a, k, why]),
    alive: () => true, pidAlive: () => true, leasePollMs: 0, ...extra
  });
  return { l, logs, notes, kept, lapses, tick: (ms) => { now += ms; }, now: () => now, rows: (action) => logs.filter((r) => r.action === action), held: () => l.snapshot().map((h) => h.agentId) };
}
const waiters = (x) => x.l.queueSnapshot().waiters.map((w) => w.agentId);
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [], ...more });
const settle = () => new Promise((r) => setImmediate(r));
/** Another agent's suite really runs: a test process of its hold takes a lease and ends. (Without it,
 *  that agent's own reserved call would be a launch that started nothing, and ITS slot would be kept.) */
async function testRan(x, agentId, pid) {
  const t = await ask(x, agentId, pid, { suite: true });
  assert.equal(t.state, 'held');
  await x.l.lease(agentId, { op: 'release', leaseId: t.leaseId });
}

/** The live shape: Andy holds; Dwight, then Jim, are denied and queued; Andy's job ends and the slot
 *  is reserved for Dwight (told HEAVY SLOT FREE). `cls`: what Dwight was denied. */
function reservedForDwight(M = HJ, extra = {}, cls = SUITE) {
  const x = rig(M, extra);
  x.l.acquire('andy', SUITE, 'npm test', 'a1', false);
  assert.equal(x.l.acquire('dwight', cls, 'npm test', 'd0', false).allow, false);
  assert.equal(x.l.acquire('jim', SUITE, 'npm test', 'j0', false).allow, false);
  x.l.callDone('andy', 'a1');
  return x;
}
const KEPT = (M, x, reason) => ({ kind: 'heavy-lock', action: 'reserve-kept', agentId: 'dwight', heavyKind: 'suite', reason, until: new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString() });

const K = {};

// ── the four red-before cases ────────────────────────────────────────────────────────────────

K.shimRefused = async (M = HJ) => {
  // npm.ps1 refused: the call is allowed, nothing starts, PostToolUse comes back at once.
  const x = reservedForDwight(M);
  await settle();
  assert.deepEqual(reservedFor(x), ['dwight']);
  assert.equal(x.l.acquire('dwight', SUITE, 'npm test', 'd1', false).allow, true);
  x.tick(900);
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(x.held(), []);
  assert.deepEqual(reservedFor(x), ['dwight'], 'A LAUNCH THAT DIED BEFORE ANY TEST KEEPS ITS SLOT');
  assert.deepEqual(waiters(x), ['jim'], 'the queue behind it is unchanged');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'posttool')], 'ONE reserve-kept ROW: agent, kind, reason, until');
  assert.deepEqual(x.notes.map((n) => n.a), ['dwight'], 'no second HEAVY SLOT FREE');
  assert.deepEqual(x.kept, [{ a: 'dwight', k: 'suite', until: x.now() + M.HEAVY_RESERVE_MS }], 'THE AGENT IS TOLD, ONCE, THAT THE SLOT IS KEPT, FOR A FRESH RESERVE WINDOW');
  // MUST 3: the others see it as any reservation.
  const d = x.l.acquire('jim', SUITE, 'npm test', 'j1', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, new RegExp(`reserved for dwight until ${new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString().slice(11, 19)}Z`), 'A DENY TO OTHERS NAMES THE KEPT RESERVATION, WITH ITS TIME');
  assert.deepEqual(x.l.queueSnapshot().reserved, [{ agentId: 'dwight', kind: 'suite', until: new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString(), exclusive: true }], 'THE SNAPSHOT SHOWS IT AS A RESERVE (same shape)');
  // The fixed launch runs on the kept slot.
  assert.equal(x.l.acquire('dwight', SUITE, 'npm.cmd test', 'd2', false).allow, true, 'THE RETRY HAS THE SLOT');
  assert.deepEqual(x.held(), ['dwight']);
};
test('case 1 (npm.ps1 refused): a reserved suite call that returns with no test started keeps its slot, once, and says so', () => K.shimRefused());

K.preflight = async (M = HJ) => {
  // run-tests.cjs asks for its lease BEFORE its preflight: the runner's own lease is no proof of a test.
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm.cmd test', 'd1', false);
  const r = await ask(x, 'dwight', 2001, { runner: [RUNNER], cwd: 'C:\\Dunder\\wt' });
  assert.equal(r.state, 'held', 'the runner shares the call\'s slot');
  await x.l.lease('dwight', { op: 'release', leaseId: r.leaseId });
  assert.deepEqual(x.held(), ['dwight'], 'the call is still open');
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['dwight'], 'A RUNNER THAT EXITED IN ITS PREFLIGHT STARTED NO TEST: KEPT');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'posttool')]);
};
test('case 2 (runner preflight TREE GAP): the suite runner\'s own lease is not a started test', () => K.preflight());

K.chain = (M = HJ) => {
  // Case 3 (Andy, npm ci rc=127): the chain is an INSTALL to the classifier. An install that ran used
  // its slot; the rule is N/A for it (Jim SHOULD 2: do not reclass).
  for (const c of ['npm ci && npm test', 'npm ci; npm test', 'npm.cmd ci && npm.cmd test']) assert.equal(M.classifyCommand(c, 0, {}).kind, 'install', c);
  assert.equal(M.classifyCommand('npm test', 0, {}).kind, 'suite');
  const x = reservedForDwight(M, {}, INSTALL);
  x.l.acquire('dwight', INSTALL, 'npm ci && npm test', 'd1', false);
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['jim'], 'AN INSTALL IS NOT KEPT');
  const y = reservedForDwight(M, {}, BENCH);
  y.l.acquire('dwight', BENCH, 'node bench.cjs', 'd1', false);
  y.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(y), ['jim'], 'A BENCH IS NOT KEPT (no proof of a start)');
  assert.equal(x.rows('reserve-kept').length + y.rows('reserve-kept').length, 0);
};
test('case 3 (npm ci chain): the chain classes as an install; suite only, so an install or a bench passes on as before', () => K.chain());

/** What the watcher lists: Dwight's PTY root (pid 10), his suite RUNNER (pid 11: it runs the preflight
 *  and starts no test by itself), and a TEST process below the runner (pid 12). */
const P_ROOT = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
const P_RUNNER = { pid: 11, parentPid: 10, commandLine: 'node test/tools/run-tests.cjs', createdMs: 1_000_100 };
const P_TEST = { pid: 12, parentPid: 11, commandLine: '"C:\\Program Files\\nodejs\\node.exe" --test --test-reporter tap test/a.test.cjs', createdMs: 1_000_200 };
const listing = (mode) => (mode === 'running' ? [P_ROOT, P_RUNNER, P_TEST] : mode === 'runner' ? [P_ROOT, P_RUNNER] : [P_ROOT]);
/** A watcher rig. `s.mode`: 'idle' (root only) | 'runner' (the runner, no test yet) | 'running' (a test). */
function watched(M = HJ) {
  const s = { mode: 'idle' };
  const x = reservedForDwight(M, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => listing(s.mode) });
  return { ...x, s };
}
const scanOnce = async (x, M) => { x.tick(M.HEAVY_SCAN_MS); await x.l.scan(); };

K.background = async (M = HJ) => {
  const x = watched(M);
  await settle();
  assert.deepEqual(reservedFor(x), ['dwight']);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', true);
  // MUST 1: a background call's PostToolUse comes as the launch returns. It is not a release.
  x.l.callDone('dwight', 'd1');
  await settle();
  assert.deepEqual(x.held(), ['dwight'], 'A BACKGROUND HOLDER STAYS THE HOLDER AT PostToolUse');
  assert.equal(x.rows('reserve-kept').length, 0, 'and nothing is kept there');
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['posttool', 'process-exit']);
  assert.deepEqual(reservedFor(x), ['dwight'], 'NEVER SEEN RUNNING, NO TEST LEASE: KEPT AT process-exit');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'process-exit')]);
  // Control: the watcher saw the job once. It ran; the slot passes on.
  const y = watched(M);
  await settle();
  y.l.acquire('dwight', SUITE, 'npm test', 'd1', true);
  y.s.mode = 'running';
  await scanOnce(y, M);
  y.s.mode = 'idle';
  await scanOnce(y, M); await scanOnce(y, M);
  assert.deepEqual(y.held(), []);
  assert.deepEqual(reservedFor(y), ['jim'], 'A JOB THE WATCHER SAW RUNNING IS NOT KEPT');
  assert.equal(y.rows('reserve-kept').length, 0);
};
test('case 4 (background): PostToolUse keeps nothing; process-exit keeps an unsighted suite, and passes a sighted one on', () => K.background());

K.slowPrelaunch = async (M = HJ) => {
  // Jim SHOULD 1, god e833a9 (a): a prelaunch failure that outlasts a scan. The watcher sees the
  // RUNNER (a preflight build or tsc that fails after 30 s, an npm step that hangs and then fails)
  // and no test process below it. The runner is a live job (the slot stays held while it lives),
  // and it is not a started test.
  const x = watched(M);
  await settle();
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', true);
  x.l.callDone('dwight', 'd1');
  await settle();
  x.s.mode = 'runner';
  await scanOnce(x, M); await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(x.held(), ['dwight'], 'A LIVE RUNNER HOLDS THE SLOT (three scans, 60 s)');
  assert.equal(x.l.snapshot()[0].seenRunning, true, 'and is seen running, as a job');
  x.s.mode = 'idle';
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(x.held(), []);
  assert.deepEqual(reservedFor(x), ['dwight'], 'A RUNNER SIGHTED WITH NO TEST PROCESS BELOW IT STARTED NO TEST: KEPT');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'process-exit')]);
  // The bound holds on this path too: the kept slot's next slow failure passes on.
  x.l.acquire('dwight', SUITE, 'npm test', 'd2', true);
  x.s.mode = 'runner';
  await scanOnce(x, M);
  x.s.mode = 'idle';
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(reservedFor(x), ['jim'], 'A SECOND SLOW FAILURE PASSES THE SLOT ON');
  assert.equal(x.rows('reserve-kept').length, 1);
};
test('SHOULD 1 (a): a runner the watcher saw with no test process below it is not a started test (a slow prelaunch failure keeps its slot)', () => K.slowPrelaunch());

K.slowPrelaunchForeground = async (M = HJ) => {
  // The same failure with the call returning while the runner still lives (orphan-kept): the runner
  // is a live job, so the hold stays; it is still not a started test.
  const x = watched(M);
  await settle();
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.s.mode = 'runner';
  x.l.callDone('dwight', 'd1');
  await settle(); await settle();
  assert.equal(x.rows('orphan-kept').length, 1, 'the live runner keeps the hold');
  assert.deepEqual(x.held(), ['dwight']);
  x.s.mode = 'idle';
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(reservedFor(x), ['dwight'], 'A RUNNER FOUND ALIVE AT PostToolUse WITH NO TEST PROCESS STARTED NO TEST: KEPT');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'process-exit')]);
};
test('SHOULD 1 (a): the same at PostToolUse (orphan-kept on the runner alone is not a started test)', () => K.slowPrelaunchForeground());

K.testProcess = (M = HJ) => {
  // What a sighting must show to count: node or electron run as the test runner, or on a test file.
  const yes = [
    'node --test',
    'node --test --test-reporter tap test/a.test.cjs',
    'node --test-reporter tap --test test/',
    '"C:\\Program Files\\nodejs\\node.exe" --test-reporter=tap test\\heavy-lock\\x.test.cjs',
    'C:\\wt\\node_modules\\electron\\dist\\electron.exe --test test/a.test.cjs',
    'node -r ./pre.cjs test/b.test.mjs',
    'node test/c.test.ts'
  ];
  const no = [
    'bash',
    'node test/tools/run-tests.cjs',
    'node test/tools/run-tests.cjs test/a.test.cjs',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" test -- test/a.test.cjs',
    'node node_modules/typescript/bin/tsc --noEmit',
    'node scripts/build.cjs --test',
    'cmd /c npm test',
    'pwsh -File test/a.test.cjs',
    'node -e "require(\'./test/a.test.cjs\')"',
    ''
  ];
  for (const c of yes) assert.equal(M.isTestProcess(c), true, `A TEST PROCESS: ${c}`);
  for (const c of no) assert.equal(M.isTestProcess(c), false, `NOT A TEST PROCESS: ${c}`);
};
test('SHOULD 1 (a): what counts as a test process in the watcher\'s listing (not the runner, npm, a build or a shell)', () => K.testProcess());

K.regrant = async (M = HJ) => {
  // Jim SHOULD 2: a reserved EXCLUSIVE call that finds the machine not empty goes back to the head
  // of the queue (HEAVY-SLOT-EXCLUSIVE-192) and is granted again after the drain. That second
  // reservation is still the first one's: hooked, and lapsed once already.
  const x = rig(M, { limit: () => 2 });
  x.l.acquire('b', INSTALL, 'npm ci', 'b1', false);
  x.l.acquire('c', INSTALL, 'npm ci', 'c1', false);
  assert.equal(x.l.acquire('dwight', INSTALL, 'npm ci', 'd0', false).allow, false);
  x.l.callDone('c', 'c1');
  assert.deepEqual(reservedFor(x), ['dwight'], 'a shared slot, reserved beside b');
  x.tick(M.HEAVY_RESERVE_MS);
  assert.deepEqual(x.held(), ['b']);   // snapshot() runs expire(): lapsed once, queued again, granted again
  assert.deepEqual(reservedFor(x), ['dwight']);
  assert.equal(x.l.acquire('dwight', SUITE, 'npm test', 'd1', false).allow, false, 'a suite on a shared reservation waits at the head');
  assert.deepEqual([waiters(x), reservedFor(x)], [['dwight'], []]);
  x.l.callDone('b', 'b1');
  assert.deepEqual(reservedFor(x), ['dwight'], 'granted again when the machine is empty');
  assert.equal(x.l.acquire('dwight', SUITE, 'npm test', 'd2', false).allow, true);
  x.l.callDone('dwight', 'd2');
  assert.deepEqual(reservedFor(x), ['dwight'], 'AN EXCLUSIVE SUITE RE-GRANTED AFTER THE DRAIN KEEPS ITS SLOT WHEN ITS LAUNCH DIES');
  assert.deepEqual(x.rows('reserve-kept').map((r) => r.reason), ['posttool']);
  x.lapses.length = 0;
  x.tick(M.HEAVY_RESERVE_MS);
  assert.deepEqual(x.held(), []);
  assert.deepEqual([reservedFor(x), waiters(x)], [[], []], 'A RESERVATION THAT LAPSED ONCE BEFORE THE RE-GRANT IS NOT QUEUED AGAIN AFTER THE KEEP');
  assert.deepEqual(x.lapses, [['dwight', 'suite', 'expired']], 'and its owner is told plainly');
};
test('SHOULD 2: an exclusive suite re-granted after the drain is kept like any other, and carries that it lapsed once', () => K.regrant());

K.jobExit = (M = HJ) => {
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', true);
  x.l.noteJob('dwight', 'd1', 'job-1');
  x.l.jobExited('dwight', 'd1', 'job-1');
  assert.deepEqual(reservedFor(x), ['dwight'], 'A HELD JOB THAT ENDED WITH NO TEST: KEPT');
  assert.deepEqual(x.rows('reserve-kept'), [KEPT(M, x, 'job-exit')]);
};
test('a held job that exits with no test started keeps the slot (job-exit)', () => K.jobExit());

// ── started: passes on as before ─────────────────────────────────────────────────────────────

K.started = async (M = HJ) => {
  // A test process of the runner (parentRun) is the proof.
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm.cmd test', 'd1', false);
  const r = await ask(x, 'dwight', 2001, { runner: [RUNNER], cwd: 'C:\\Dunder\\wt' });
  const t = await ask(x, 'dwight', 2002, { files: ['test/a.test.cjs', 'test/b.test.cjs'], parentRun: r.run });
  assert.equal(t.state, 'held', 'a test process of a held run');
  await x.l.lease('dwight', { op: 'release', leaseId: r.leaseId });
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['jim'], 'A SUITE THAT STARTED A TEST AND THEN DIED PASSES THE SLOT ON');
  assert.equal(x.rows('reserve-kept').length, 0);
  // node --test with no files (its own discovery) is a test process too.
  const y = reservedForDwight(M);
  y.l.acquire('dwight', SUITE, 'node --test', 'd1', false);
  const s = await ask(y, 'dwight', 2003, { suite: true });
  assert.equal(s.state, 'held');
  await y.l.lease('dwight', { op: 'release', leaseId: s.leaseId });
  y.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(y), ['jim'], 'node --test ITSELF IS A STARTED TEST');
  // An Electron launch is a start.
  const z = reservedForDwight(M);
  z.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  const e = await ask(z, 'dwight', 2004, { preloadKind: 'electron' });
  assert.equal(e.state, 'held');
  await z.l.lease('dwight', { op: 'release', leaseId: e.leaseId });
  z.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(z), ['jim'], 'AN ELECTRON LAUNCH IS A START');
};
test('control: a test process (a runner\'s child, node --test itself, an Electron launch) is a start; the slot passes on', () => K.started());

K.thisGrant = async (M = HJ) => {
  // MUST 2: proof counts only under THIS grant. Dwight's earlier hold started tests; its runner is
  // still exiting when his next reserved launch fails.
  const x = rig(M);
  x.l.acquire('dwight', SUITE, 'npm test', 'e1', false);
  const old = await ask(x, 'dwight', 1901, { runner: [RUNNER], cwd: 'C:\\Dunder\\wt' });
  await ask(x, 'dwight', 1902, { files: ['test/a.test.cjs', 'test/b.test.cjs'], parentRun: old.run });
  x.l.callDone('dwight', 'e1');
  x.l.acquire('andy', SUITE, 'npm test', 'a0', false);
  await x.l.lease('dwight', { op: 'release', leaseId: old.leaseId });
  assert.deepEqual(x.held(), [], 'the first hold is over');
  assert.equal(x.rows('reserve-kept').length, 0, 'a hold that was not from a reservation is never kept');
  // Andy took the reservation the release made; Dwight and Jim queue behind him.
  assert.equal(x.l.acquire('andy', SUITE, 'npm test', 'a1', false).allow, true);
  x.l.acquire('dwight', SUITE, 'npm test', 'd0', false);
  x.l.acquire('jim', SUITE, 'npm test', 'j0', false);
  await testRan(x, 'andy', 3001);
  x.l.callDone('andy', 'a1');
  assert.deepEqual(reservedFor(x), ['dwight']);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  // A straggler of the OLD run asks now: it names the old run as its parent.
  // (Its runner is gone, so the lock no longer knows that run: the straggler leases on the open hold.)
  const late = await ask(x, 'dwight', 1903, { files: ['test/c.test.cjs', 'test/d.test.cjs'], parentRun: old.run });
  assert.equal(late.state, 'held');
  if (late.leaseId) await x.l.lease('dwight', { op: 'release', leaseId: late.leaseId });
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['dwight'], 'A TEST PROCESS OF AN EARLIER RUN IS NO PROOF FOR THIS GRANT: KEPT');
  // A light single-file lease (another call of the agent, beside the suite call) takes no slot and
  // proves nothing; nor does a process it starts.
  const y = reservedForDwight(M);
  y.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  y.l.noteCall('dwight', 'o1', 'node mut.cjs');
  const one = await ask(y, 'dwight', 2101, { files: ['test/a.test.cjs'] });
  assert.deepEqual([one.state, one.why], ['light', 'one test file, one at a time']);
  const under = await ask(y, 'dwight', 2102, { files: ['test/a.test.cjs', 'test/b.test.cjs'], parentRun: one.run });
  assert.equal(under.leaseId, null, 'it inherits; it takes no lease');
  y.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(y), ['dwight'], 'A LIGHT LEASE THAT ACQUIRES NOTHING IS NO PROOF: KEPT');
};
test('MUST 2: only a test process of this grant\'s own run counts (not an earlier run\'s straggler, not a light lease)', () => K.thisGrant());

K.sightedBefore = async (M = HJ) => {
  // MUST 2: a sighting belongs to the hold it was made in.
  const s = { mode: 'running' };
  const x = rig(M, { roots: () => [{ agentId: 'dwight', pid: 10 }, { agentId: 'andy', pid: 30 }], probe: async () => listing(s.mode) });
  x.l.acquire('dwight', SUITE, 'npm test', 'e1', true);
  await scanOnce(x, M);
  assert.equal(x.l.snapshot()[0].seenRunning, true, 'the first hold was seen running (a test process of it)');
  x.l.acquire('andy', SUITE, 'npm test', 'a0', false);
  s.mode = 'idle';
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(reservedFor(x), ['andy'], 'the sighted hold passed on');
  x.l.acquire('andy', SUITE, 'npm test', 'a1', false);
  x.l.acquire('dwight', SUITE, 'npm test', 'd0', false);
  x.l.acquire('jim', SUITE, 'npm test', 'j0', false);
  await testRan(x, 'andy', 3001);
  x.l.callDone('andy', 'a1');
  await settle();
  assert.deepEqual(reservedFor(x), ['dwight']);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.l.callDone('dwight', 'd1');
  await settle();
  assert.deepEqual(reservedFor(x), ['dwight'], 'A SIGHTING BEFORE THE GRANT DOES NOT COUNT: KEPT');
};
test('MUST 2: a sighting from an earlier hold does not mark this grant as started', () => K.sightedBefore());

// ── the bound: once per grant ────────────────────────────────────────────────────────────────

K.once = (M = HJ) => {
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['dwight']);
  x.l.acquire('dwight', SUITE, 'npm test', 'd2', false);
  x.l.callDone('dwight', 'd2');
  assert.deepEqual(reservedFor(x), ['jim'], 'A SECOND FAILED LAUNCH PASSES THE SLOT ON (once per grant)');
  assert.equal(x.rows('reserve-kept').length, 1);
  assert.deepEqual(waiters(x), [], 'and the agent is not queued by the lock (as before)');
  // Kept, spent by another heavy kind with a suite beside it: still never kept again.
  const y = reservedForDwight(M);
  y.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  y.l.callDone('dwight', 'd1');
  y.l.acquire('dwight', INSTALL, 'npm ci', 'd2', false);
  y.l.acquire('dwight', SUITE, 'npm test', 'd3', false);
  y.l.callDone('dwight', 'd3');
  y.l.callDone('dwight', 'd2');
  assert.deepEqual(reservedFor(y), ['jim'], 'A KEPT SLOT SPENT BY AN INSTALL, THEN A FAILED SUITE: PASSED ON');
  assert.equal(y.rows('reserve-kept').length, 1);
};
test('the bound: a kept reservation is never kept again, whatever spends it', () => K.once());

K.lapse = async (M = HJ) => {
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.l.callDone('dwight', 'd1');
  x.tick(M.HEAVY_RESERVE_MS);
  assert.deepEqual(x.held(), []);   // snapshot() runs expire()
  assert.deepEqual(reservedFor(x), ['jim'], 'AN UNUSED KEPT RESERVATION PASSES ON AFTER ONE WINDOW');
  assert.deepEqual(waiters(x), ['dwight'], 'its owner is queued again, at the back (as any lapsed reservation)');
  assert.deepEqual(x.lapses, [['dwight', 'suite', 'requeued']], 'ONE lapse notice');
  // Its next reservation, from the queue-again, is not kept either.
  x.l.acquire('jim', SUITE, 'npm test', 'j1', false);
  await testRan(x, 'jim', 3002);
  x.l.callDone('jim', 'j1');
  assert.deepEqual(reservedFor(x), ['dwight']);
  x.l.acquire('dwight', SUITE, 'npm test', 'd2', false);
  x.l.callDone('dwight', 'd2');
  assert.deepEqual(reservedFor(x), [], 'A RESERVATION QUEUED AGAIN AFTER A KEEP IS NOT KEPT');
  assert.equal(x.rows('reserve-kept').length, 1);
};
test('the bound: a kept reservation that lapses passes on through expire() with one notice, and its queue-again is not kept', () => K.lapse());

// ── what the rule never touches ──────────────────────────────────────────────────────────────

K.untouched = async (M = HJ) => {
  // No reservation behind the hold: a free machine, a failed launch, nothing to keep.
  const a = rig(M);
  a.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  a.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(a), []);
  assert.equal(a.rows('reserve-kept').length, 0);
  // `heavy release` by the holder gives the slot up.
  const b = reservedForDwight(M);
  b.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  b.l.callDone('dwight', 'd1');
  const u = await b.l.lease('dwight', { op: 'unreserve' });
  assert.equal(u.reserved, true);
  assert.deepEqual(reservedFor(b), ['jim'], 'heavy release GIVES UP A KEPT SLOT');
  // The agent's terminal is gone.
  const c = reservedForDwight(M);
  c.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  c.l.agentGone('dwight');
  assert.deepEqual(reservedFor(c), ['jim'], 'pty-exit KEEPS NOTHING');
  // The TTL.
  const d = reservedForDwight(M);
  d.l.acquire('dwight', SUITE, 'npm test', 'd1', true);
  d.tick(M.HEAVY_TTL_MS);
  assert.deepEqual(d.held(), []);
  assert.deepEqual(reservedFor(d), ['jim'], 'ttl KEEPS NOTHING');
  // Limit Off: no queue, nothing kept.
  let limit = 1;
  const e = reservedForDwight(M, { limit: () => limit });
  e.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  limit = 'off';
  e.l.limitChanged();
  e.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(e), []);
  assert.equal(e.rows('reserve-kept').length, 0, 'limit Off KEEPS NOTHING');
  assert.equal(b.rows('reserve-kept').length, 1);
  assert.equal(c.rows('reserve-kept').length + d.rows('reserve-kept').length + e.rows('reserve-kept').length, 0);
};
test('control: no reservation, heavy release, pty-exit, ttl and limit Off keep nothing', () => K.untouched());

K.notice = (M = HJ) => {
  const until = Date.UTC(2026, 10, 19, 10, 22, 0);
  const free = M.heavySlotFreeNotice('dwight', 'suite', until);
  assert.match(free.message.subject, /^HEAVY SLOT FREE: /, 'the first notice is unchanged');
  const kept = M.heavySlotKeptNotice('dwight', 'suite', until);
  assert.match(kept.message.subject, /^HEAVY SLOT KEPT: your suite ended before any test started; the slot is still reserved for you until 10:22Z$/, 'THE CAUSE AS THE LOCK KNOWS IT');
  assert.doesNotMatch(`${kept.message.subject} ${kept.message.body}`, /npm|polic|python|preflight/i, 'IT DOES NOT GUESS WHY THE LAUNCH DIED');
  assert.match(kept.message.body, /once/i, 'the body says the keep is once');
  assert.equal(kept.message.wake, 'now');
  assert.equal(kept.steer, `${kept.message.subject}.`);
};
test('MUST 4: the kept notice says "no test started", never a guessed cause', () => K.notice());

K.wired = (src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')) => {
  assert.ok(src.includes('  notifyKept: (agentId, kind, until) => notifyHeavySlotKept(agentId, kind, until),'), 'MAIN GIVES THE LOCK notifyKept');
  const fn = src.slice(src.indexOf('function notifyHeavySlotKept('), src.indexOf('function notifyHeavyUnlimited('));
  assert.ok(fn.includes('const k = heavySlotKeptNotice(agentId, kind, until);'), 'it builds the kept notice');
  assert.ok(fn.includes('hive.send(k.message as Partial<HiveMessage>, k.from)'), 'ON THE MAIL RAIL');
  assert.ok(fn.includes('control.steer(agentId, k.steer)'), 'AND THE STEER RAIL');
};
test('MUST 4: main sends the kept notice on both rails', () => K.wired());

K.unhooked = async (M = HJ) => {
  // The reservation was made for a WAITING TEST PROCESS (a lease waiter), not for a call denied at
  // the hook. The runner takes it by lease and exits in its preflight: passed on, as before.
  const x = rig(M);
  x.l.acquire('andy', SUITE, 'npm test', 'a1', false);
  const w = await ask(x, 'dwight', 2001, { runner: [RUNNER], cwd: 'C:\\Dunder\\wt' });
  assert.equal(w.state, 'wait');
  assert.equal(x.l.acquire('jim', SUITE, 'npm test', 'j0', false).allow, false);
  await testRan(x, 'andy', 3001);
  x.l.callDone('andy', 'a1');
  assert.deepEqual(reservedFor(x), ['dwight']);
  const r = await ask(x, 'dwight', 2001, { runner: [RUNNER], cwd: 'C:\\Dunder\\wt' });
  assert.equal(r.state, 'held');
  await x.l.lease('dwight', { op: 'release', leaseId: r.leaseId });
  assert.deepEqual(x.held(), []);
  assert.deepEqual(reservedFor(x), ['jim'], 'A RESERVATION NOT MADE AT THE HOOK IS NOT KEPT');
  assert.equal(x.rows('reserve-kept').length, 0);
};
test('control: a reservation made for a waiting test process (not at the hook) passes on as before', () => K.unhooked());

K.fresh = (M = HJ) => {
  // Q2 (Dwight, 11-19 10:17Z): the launch came late in the window. The kept window is a fresh one.
  const x = reservedForDwight(M);
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.tick(60_000);
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => [r.agentId, r.until]), [['dwight', new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString()]], 'A FRESH WINDOW FROM THE MOMENT THE LAUNCH DIED');
};
test('Q2: the kept window is a fresh HEAVY_RESERVE_MS from the release, not what was left', () => K.fresh());

K.orphan = async (M = HJ) => {
  // A foreground call returns while its heavy child lives on (orphan-kept): the job RAN. When the
  // child is gone the slot passes on, even if no scan ever saw it again.
  const x = watched(M);
  await settle();
  x.l.acquire('dwight', SUITE, 'npm test', 'd1', false);
  x.s.mode = 'running';
  x.l.callDone('dwight', 'd1');
  await settle(); await settle();
  assert.equal(x.rows('orphan-kept').length, 1);
  x.s.mode = 'idle';
  await scanOnce(x, M); await scanOnce(x, M);
  assert.deepEqual(x.held(), []);
  assert.deepEqual(reservedFor(x), ['jim'], 'A JOB FOUND RUNNING AT PostToolUse IS NOT KEPT');
  assert.equal(x.rows('reserve-kept').length, 0);
};
test('control: a call that returned with its heavy child still running (orphan-kept) is a started job', () => K.orphan());

// ─── MUTANT CENSUS ───────────────────────────────────────────────────────────────────────────
// Each mutant is ONE edit of the source, loaded as text, and must fail its named killer with the
// named message. The exclusive re-grant after the drain (a reservation put back at the head of the
// queue in acquireAs) is pinned by K.regrant for what it can carry: `lapsed`. NOT PINNED, said
// plainly: (1) its `kept: r.kept`. A kept reservation is exclusive (only a suite hold is kept; the
// classifier makes no provisional suite), so its owner's exclusive call always fits and that branch
// never meets a kept reservation; the carry is there so the bound holds if that ever changes.
// (2) its `hooked: r.hooked` alone: deny() marks a hook call's waiter hooked again, so dropping it
// changes nothing for a hook call (the two-edit mutant below drops both).

function mutateText(rel, edits, tag) {
  let text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', rel), 'utf8');
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const IDX = 'src/main/index.ts';
const KEEP_IF = "if (h.spent && !h.started && (reason === 'posttool' || reason === 'job-exit' || reason === 'process-exit') && this.d.limit() !== 'off' && this.alive(agentId)) {";
const MUTANTS = [
  { name: 'nothing is kept (base behaviour)', edits: [[KEEP_IF, 'if (false) {']], killer: 'shimRefused', dies: /KEEPS ITS SLOT/ },
  { name: 'a started job is kept too', edits: [['if (h.spent && !h.started && (reason', 'if (h.spent && (reason']], killer: 'started', dies: /STARTED A TEST AND THEN DIED PASSES THE SLOT ON/ },
  { name: 'any release reason keeps', edits: [["(reason === 'posttool' || reason === 'job-exit' || reason === 'process-exit') && this.d.limit()", 'true && this.d.limit()']], killer: 'untouched', dies: /pty-exit KEEPS NOTHING/ },
  { name: 'job-exit does not keep', edits: [["(reason === 'posttool' || reason === 'job-exit' || reason === 'process-exit') && this.d.limit()", "(reason === 'posttool' || reason === 'process-exit') && this.d.limit()"]], killer: 'jobExit', dies: /HELD JOB THAT ENDED WITH NO TEST/ },
  { name: 'process-exit does not keep', edits: [["(reason === 'posttool' || reason === 'job-exit' || reason === 'process-exit') && this.d.limit()", "(reason === 'posttool' || reason === 'job-exit') && this.d.limit()"]], killer: 'background', dies: /KEPT AT process-exit/ },
  { name: 'posttool does not keep', edits: [["(reason === 'posttool' || reason === 'job-exit' || reason === 'process-exit') && this.d.limit()", "(reason === 'job-exit' || reason === 'process-exit') && this.d.limit()"]], killer: 'shimRefused', dies: /KEEPS ITS SLOT/ },
  { name: 'kept with the limit Off', edits: [[" && this.d.limit() !== 'off' && this.alive(agentId)) {", ' && this.alive(agentId)) {']], killer: 'untouched', dies: /limit Off KEEPS NOTHING/ },
  { name: 'a kept reservation is kept again', edits: [['was.hooked && !was.kept && cls.kind', 'was.hooked && cls.kind']], killer: 'once', dies: /SECOND FAILED LAUNCH PASSES THE SLOT ON/ },
  { name: 'the kept reservation is not marked', edits: [['lapsed: h.spent.lapsed, kept: true });', 'lapsed: h.spent.lapsed });']], killer: 'once', dies: /SECOND FAILED LAUNCH PASSES THE SLOT ON/ },
  { name: 'any heavy kind is kept', edits: [["!was.kept && cls.kind === 'suite' ? { lapsed", '!was.kept ? { lapsed']], killer: 'chain', dies: /AN INSTALL IS NOT KEPT/ },
  { name: 'a reservation not made at the hook is kept', edits: [['const spent = was && was.hooked && !was.kept', 'const spent = was && !was.kept']], killer: 'unhooked', dies: /NOT MADE AT THE HOOK IS NOT KEPT/ },
  { name: "the runner's own lease is a start", edits: [['if (own && !Array.isArray(r.runner) && (electron', 'if (own && (electron']], killer: 'preflight', dies: /RUNNER THAT EXITED IN ITS PREFLIGHT/ },
  { name: "an earlier run's straggler is a start", edits: [["const own = typeof r.parentRun !== 'string' || parent?.grant === hold.grant;", 'const own = true;']], killer: 'thisGrant', dies: /EARLIER RUN IS NO PROOF/ },
  { name: 'a child of a light run is a start', edits: [['if (held && hold && parent.grant === hold.grant) hold.started = true;', 'if (hold) hold.started = true;']], killer: 'thisGrant', dies: /LIGHT LEASE THAT ACQUIRES NOTHING/ },
  { name: "a runner's child is not a start", edits: [['if (held && hold && parent.grant === hold.grant) hold.started = true;', '']], killer: 'started', dies: /STARTED A TEST AND THEN DIED PASSES THE SLOT ON/ },
  { name: 'a test process of its own is not a start', edits: [["if (own && !Array.isArray(r.runner) && (electron || !r.preloadKind)) hold.started = true;", '']], killer: 'started', dies: /node --test ITSELF IS A STARTED TEST/ },
  { name: 'an Electron launch is not a start', edits: [['(electron || !r.preloadKind)) hold.started = true;', '(!r.preloadKind)) hold.started = true;']], killer: 'started', dies: /AN ELECTRON LAUNCH IS A START/ },
  { name: 'a sighting is not a start', edits: [['if (probed.tested.has(h.agentId)) h.started = true;', '']], killer: 'background', dies: /SAW RUNNING IS NOT KEPT/ },
  { name: 'an orphan-kept job is not a start', edits: [['if (busy?.tested.has(agentId)) cur.started = true;', '']], killer: 'orphan', dies: /FOUND RUNNING AT PostToolUse IS NOT KEPT/ },
  // Jim SHOULD 1, god e833a9 (a): the runner is the job, not a test.
  { name: 'a runner sighted by a scan is a start', edits: [['if (probed.tested.has(h.agentId)) h.started = true;', 'if (busy.has(h.agentId)) h.started = true;']], killer: 'slowPrelaunch', dies: /RUNNER SIGHTED WITH NO TEST PROCESS BELOW IT/ },
  { name: 'a runner alive at PostToolUse is a start', edits: [['if (busy?.tested.has(agentId)) cur.started = true;', 'if (busy?.busy.has(agentId)) cur.started = true;']], killer: 'slowPrelaunchForeground', dies: /RUNNER FOUND ALIVE AT PostToolUse/ },
  { name: 'any process of the job counts as a test', edits: [['p.createdMs === created && isTestProcess(p.commandLine)) tested.add', 'p.createdMs === created) tested.add']], killer: 'slowPrelaunch', dies: /RUNNER SIGHTED WITH NO TEST PROCESS BELOW IT/ },
  { name: 'any node script is a test process (the runner too)', edits: [['return at >= 0 && /\\.test\\.[cm]?[jt]sx?$/i.test(args[at]);', 'return at >= 0;']], killer: 'testProcess', dies: /^NOT A TEST PROCESS: node test\/tools\/run-tests\.cjs\n/ },
  { name: 'a test file among the arguments counts (npm, a filtered runner)', edits: [['return at >= 0 && /\\.test\\.[cm]?[jt]sx?$/i.test(args[at]);', 'return args.some((a) => /\\.test\\.[cm]?[jt]sx?$/i.test(a));']], killer: 'testProcess', dies: /^NOT A TEST PROCESS: node test\/tools\/run-tests\.cjs test\/a\.test\.cjs\n/ },
  { name: '--test after the script counts', edits: [["if ((at < 0 ? args : args.slice(0, at)).includes('--test')) return true;", "if (args.includes('--test')) return true;"]], killer: 'testProcess', dies: /^NOT A TEST PROCESS: node scripts\/build\.cjs --test\n/ },
  { name: 'any program on a test file counts', edits: [["if (prog !== 'node' && prog !== 'electron') return false;", '']], killer: 'testProcess', dies: /^NOT A TEST PROCESS: pwsh / },
  { name: 'node --test is not a test process', edits: [["if ((at < 0 ? args : args.slice(0, at)).includes('--test')) return true;", '']], killer: 'testProcess', dies: /^A TEST PROCESS: node --test\n/ },
  { name: 'electron is not a test program', edits: [["if (prog !== 'node' && prog !== 'electron') return false;", "if (prog !== 'node') return false;"]], killer: 'testProcess', dies: /^A TEST PROCESS: C:.*electron\.exe/ },
  { name: 'a test file run by node is not a test process', edits: [['return at >= 0 && /\\.test\\.[cm]?[jt]sx?$/i.test(args[at]);', 'return false;']], killer: 'testProcess', dies: /^A TEST PROCESS: .*x\.test\.cjs\n/ },
  // Jim SHOULD 2: the exclusive re-grant after the drain carries the reservation it came from.
  { name: 'the re-grant after the drain forgets the lapse', edits: [['exclusive: true, lapsed: r.lapsed, kept: r.kept });', 'exclusive: true, lapsed: false, kept: r.kept });']], killer: 'regrant', dies: /LAPSED ONCE BEFORE THE RE-GRANT IS NOT QUEUED AGAIN/ },
  { name: 'the hold forgets that its reservation lapsed', edits: [["cls.kind === 'suite' ? { lapsed: was.lapsed } : null;", "cls.kind === 'suite' ? { lapsed: false } : null;"]], killer: 'regrant', dies: /LAPSED ONCE BEFORE THE RE-GRANT IS NOT QUEUED AGAIN/ },
  { name: 'the kept reservation forgets the lapse', edits: [['lapsed: h.spent.lapsed, kept: true });', 'lapsed: false, kept: true });']], killer: 'regrant', dies: /LAPSED ONCE BEFORE THE RE-GRANT IS NOT QUEUED AGAIN/ },
  { name: 'the re-grant after the drain is not hooked (no keep for it)', edits: [['if (i >= 0 && hooked) this.waiters[i].hooked = true;', ''], ['hooked: r.hooked, exclusive: true, lapsed: r.lapsed', 'hooked: false, exclusive: true, lapsed: r.lapsed']], killer: 'regrant', dies: /RE-GRANTED AFTER THE DRAIN KEEPS ITS SLOT|granted again when the machine is empty/ },
  { name: 'the started mark outlives its hold', edits: [['grant: ++this.grants, spent, started: false });', 'grant: ++this.grants, spent, started: this.grants > 1 });']], killer: 'sightedBefore', dies: /SIGHTING BEFORE THE GRANT DOES NOT COUNT/ },
  { name: 'a lapsed kept reservation queues as fresh', edits: [['exclusive: r.exclusive, lapsed: true, kept: r.kept });', 'exclusive: r.exclusive, lapsed: true });']], killer: 'lapse', dies: /QUEUED AGAIN AFTER A KEEP IS NOT KEPT/ },
  { name: 'a grant drops the kept mark', edits: [['exclusive: w.exclusive, lapsed: w.lapsed, kept: w.kept });', 'exclusive: w.exclusive, lapsed: w.lapsed });']], killer: 'lapse', dies: /QUEUED AGAIN AFTER A KEEP IS NOT KEPT/ },
  { name: 'the agent is not told', edits: [['try { this.d.notifyKept?.(agentId, h.kind, keptUntil); } catch', 'try { } catch']], killer: 'shimRefused', dies: /THE AGENT IS TOLD, ONCE/ },
  { name: 'the log row has no reason', edits: [["action: 'reserve-kept', agentId, heavyKind: h.kind, reason, until:", "action: 'reserve-kept', agentId, heavyKind: h.kind, until:"]], killer: 'shimRefused', dies: /ONE reserve-kept ROW/ },
  { name: 'the kept window is what was left, not a fresh one', edits: [['const keptUntil = this.now() + HEAVY_RESERVE_MS;', 'const keptUntil = h.since + HEAVY_RESERVE_MS;']], killer: 'fresh', dies: /A FRESH WINDOW FROM THE MOMENT THE LAUNCH DIED/ },
  { name: 'the notice guesses a cause', edits: [['ended before any test started; the slot is still reserved', 'ended (npm was refused by the policy?); the slot is still reserved']], killer: 'notice', dies: /THE CAUSE AS THE LOCK KNOWS IT/ },
  { name: 'main does not give the lock notifyKept', file: IDX, edits: [['  notifyKept: (agentId, kind, until) => notifyHeavySlotKept(agentId, kind, until),', '']], killer: 'wired', dies: /MAIN GIVES THE LOCK notifyKept/ },
  { name: 'main sends no mail for it', file: IDX, edits: [['try { hive.send(k.message as Partial<HiveMessage>, k.from); } catch', 'try { } catch']], killer: 'wired', dies: /ON THE MAIL RAIL/ },
  { name: 'main does not steer for it', file: IDX, edits: [['try { control.steer(agentId, k.steer); } catch', 'try { } catch']], killer: 'wired', dies: /AND THE STEER RAIL/ },
];
test('MUTANT CENSUS: every mutant dies in its named test, for its named reason', async () => {
  for (const m of MUTANTS) {
    const file = m.file ?? HJF;
    const text = mutateText(file, m.edits, m.name);
    const arg = file === IDX ? text : loadTs.fromText(file, text);
    await assert.rejects(async () => K[m.killer](arg), (e) => { assert.match(String(e.message), m.dies, `mutant "${m.name}" died for another reason`); return true; }, `MUTANT SURVIVED: ${m.name}`);
  }
});

module.exports = { K, MUTANTS };
