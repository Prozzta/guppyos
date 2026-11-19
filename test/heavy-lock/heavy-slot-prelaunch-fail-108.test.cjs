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

/** A watcher rig: Dwight's PTY root (pid 10) and his suite (pid 11). `s.mode`: 'running' | 'idle'. */
function watched(M = HJ) {
  const s = { mode: 'idle' };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'node test/tools/run-tests.cjs', createdMs: 1_000_100 };
  const x = reservedForDwight(M, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => (s.mode === 'running' ? [root, kid] : [root]) });
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
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'node test/tools/run-tests.cjs', createdMs: 1_000_100 };
  const x = rig(M, { roots: () => [{ agentId: 'dwight', pid: 10 }, { agentId: 'andy', pid: 30 }], probe: async () => (s.mode === 'running' ? [root, kid] : [root]) });
  x.l.acquire('dwight', SUITE, 'npm test', 'e1', true);
  await scanOnce(x, M);
  assert.equal(x.l.snapshot()[0].seenRunning, true, 'the first hold was seen running');
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

// MUTANT CENSUS (each must fail at least one test above): filled in with the fix.
module.exports = { K };
