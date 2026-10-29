'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-SLOT-EXCLUSIVE-192. With "Heavy jobs at once" = 2 a FULL (21-24 of 32 logical CPUs) and a
 * load bench (48+ burners) shared the machine with another heavy job and contaminated timing-sensitive
 * runs; the run-alone rule broke twice by discipline, and the Human went back to 1 slot. Now a whole
 * suite and a bench (the mutant runners, an opt-in bench gate, the explicit `GUPPY_HEAVY_EXCLUSIVE=1`
 * marker) are EXCLUSIVE: the lock grants one only when every slot is free (it waits for the drain),
 * starts nothing beside it while it holds or is reserved, and lets no newcomer past it while it waits
 * at the head of the queue (FIFO, so it is not starved). Builds and installs still share. At 1 slot
 * nothing changes. Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('../tools/test-temp.cjs');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const FULL = { heavy: true, kind: 'suite', why: 'npm test' };
const BENCH = { heavy: true, kind: 'bench', why: 'node capacity-mutants.cjs' };
const BUILD = { heavy: true, kind: 'build', why: 'npm run build' };

function rig(M, limit, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const gone = new Set();
  const l = new M.HeavyJobLock({
    limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k) => notes.push(a), alive: (a) => !gone.has(a), ...extra
  });
  let n = 0;
  const take = (a, cls) => { const id = `c${++n}`; const d = l.acquire(a, cls, cls.why, id, false); return { ...d, id }; };
  return { l, logs, notes, gone, take, tick: (ms) => { now += ms; } };
}
const reserved = (r) => r.l.queueSnapshot().reserved.map((x) => x.agentId);

const K = {
  classes(M = HJ) {
    for (const cmd of ['npm test', 'node test/tools/run-tests.cjs', 'node --test test/*.test.cjs', 'node test/tools/capacity-mutants.cjs',
      'node test/tools/agy-mutants.cjs D-1', 'GUPPY_BENCH=1 node x.cjs', 'GUPPY_HEAVY_EXCLUSIVE=1 npm run build', 'GUPPY_HEAVY_EXCLUSIVE=1 node x.cjs']) {
      const c = M.classifyCommand(cmd);
      assert.equal(c.heavy && M.heavyExclusive(c), true, `A FULL, A BENCH, A MUTANT RUNNER OR THE MARKER RUNS ALONE: ${cmd} -> ${JSON.stringify(c)}`);
    }
    for (const cmd of ['npm ci', 'npm run build', 'electron-builder --win']) assert.equal(M.heavyExclusive(M.classifyCommand(cmd)), false, `${cmd} may share`);
    assert.equal(M.classifyCommand('node --test test/one.test.cjs').heavy, false, 'a single test file stays light');
    assert.equal(M.heavyExclusive({ heavy: true, kind: 'build', exclusive: true }), true, 'a class that declares exclusive is');
  },

  // N-1 builds hold; one slot is free. A FULL still waits until every slot has drained.
  drain(M = HJ, N = 2) {
    const r = rig(M, N);
    const builds = [];
    for (let i = 1; i < N; i++) builds.push([`b${i}`, r.take(`b${i}`, BUILD)]);
    for (const [, d] of builds) assert.equal(d.allow, true);
    const x = r.take('x', FULL);
    assert.equal(x.allow, false, `EXCLUSIVE WAITS FOR DRAIN: a FULL is denied at ${N} slots with a slot free`);
    assert.match(x.reason, /runs alone/, 'the deny says why a free slot is not yours');
    for (const [a, d] of builds.slice(0, -1)) { r.l.callDone(a, d.id); assert.deepEqual(reserved(r), [], `EXCLUSIVE WAITS FOR DRAIN: not reserved while another job still runs (${N} slots)`); }
    const [a, d] = builds[builds.length - 1];
    r.l.callDone(a, d.id);
    assert.deepEqual(reserved(r), ['x'], 'RESERVED WHEN THE MACHINE IS EMPTY');
    assert.deepEqual(r.notes, ['x'], 'and told');
    assert.equal(r.take('x', FULL).allow, true, 'the FULL takes its reservation');
    assert.equal(r.l.snapshot()[0].exclusive, true, 'the holder is marked exclusive');
  },

  // A FULL (or a bench) holds, or is reserved: nothing else starts, though slots are free.
  nothingJoins(M = HJ, N = 2) {
    const r = rig(M, N);
    assert.equal(r.take('x', BENCH).allow, true);
    assert.equal(r.take('y', BUILD).allow, false, `NOTHING JOINS AN EXCLUSIVE HOLDER: a build is denied at ${N} slots`);
    assert.equal(r.take('z', FULL).allow, false, 'nor another FULL');
    assert.equal(r.l.snapshot().length, 1, 'one holder');
    const s = rig(M, N);
    const b = s.take('b', BUILD);
    assert.equal(s.take('x', FULL).allow, false);
    s.l.callDone('b', b.id);
    assert.deepEqual(reserved(s), ['x']);
    assert.equal(s.take('y', BUILD).allow, false, 'NOTHING JOINS A RESERVED EXCLUSIVE');
  },

  // FIFO: a FULL waiting at the head for the drain is not overtaken by builds that come and go.
  fifo(M = HJ, N = 2) {
    const r = rig(M, N);
    let b = r.take('b0', BUILD);
    assert.equal(r.take('x', FULL).allow, false);
    for (let i = 1; i <= 5; i++) {
      const y = r.take(`y${i}`, BUILD);
      assert.equal(y.allow, false, `A NEWCOMER DOES NOT JUMP AN EXCLUSIVE WAITER (${N} slots, round ${i})`);
      assert.match(y.reason, /runs alone/);
    }
    r.l.callDone('b0', b.id);
    assert.deepEqual(reserved(r), ['x'], 'THE EXCLUSIVE IS SERVED FIRST, NOT STARVED');
    const x = r.take('x', FULL);
    r.l.callDone('x', x.id);
    // Then the builds behind it, as many as fit.
    assert.deepEqual(reserved(r), ['y1', 'y2', 'y3', 'y4', 'y5'].slice(0, N), 'AFTER THE EXCLUSIVE, THE WAITERS BEHIND IT SHARE THE SLOTS');
    void b;
  },

  // An exclusive head that leaves the queue (gone, or gives up its place) frees the waiters behind it.
  headLeaves(M = HJ, N = 2) {
    for (const how of ['gone', 'unreserve']) {
      const r = rig(M, N);
      r.take('b', BUILD);
      assert.equal(r.take('x', FULL).allow, false);
      assert.equal(r.take('y', BUILD).allow, false);
      if (how === 'gone') { r.gone.add('x'); r.l.agentGone('x'); } else r.l.unreserve('x');
      assert.deepEqual(reserved(r), ['y'], `A HEAD THAT LEAVES THE QUEUE LETS THE NEXT ONE IN (${how}, ${N} slots)`);
    }
  },

  // An agent holding a shared slot that starts a FULL waits for the others, then runs alone.
  reentry(M = HJ, N = 2) {
    const r = rig(M, N);
    const a = r.take('a', BUILD);
    const c = r.take('c', BUILD);
    assert.equal(c.allow, true);
    assert.equal(r.take('a', FULL).allow, false, 'AN EXCLUSIVE RE-ENTRY WAITS FOR THE OTHER HOLDERS');
    r.l.callDone('c', c.id);
    assert.deepEqual(reserved(r), ['a']);
    const again = r.take('a', FULL);
    assert.equal(again.allow, true, 'the reserved re-entry runs');
    assert.equal(again.acquired, false, 'on its own slot');
    assert.equal(r.l.snapshot().length, 1);
    assert.equal(r.l.snapshot()[0].exclusive, true, 'its slot is now exclusive');
    assert.equal(r.take('y', BUILD).allow, false, 'and nothing joins it');
    void a;
  },

  // Jim MUST-1: a slot reserved for a queued BUILD is not the empty machine. A FULL run on it goes
  // back to the head of the queue; nothing passes it; it is told when the others are done.
  reservedShared(M = HJ, N = 2) {
    const r = rig(M, N);
    const held = [['b', r.take('b', BUILD)]];
    for (let i = 1; i < N; i++) held.push([`c${i}`, r.take(`c${i}`, BUILD)]);
    assert.equal(r.take('x', BUILD).allow, false);
    assert.equal(r.take('z', BUILD).allow, false, 'z queues behind x');
    const [c, cd] = held.pop();
    r.l.callDone(c, cd.id);
    assert.deepEqual(reserved(r), ['x'], 'x is reserved for its build');
    const x = r.take('x', FULL);
    assert.equal(x.allow, false, `A SHARED RESERVATION IS NOT THE EMPTY MACHINE: a FULL on it waits (${N} slots)`);
    assert.equal(r.l.snapshot().some((h) => h.agentId === 'x'), false, 'x holds nothing');
    const q = r.l.queueSnapshot();
    assert.deepEqual([q.waiters[0].agentId, q.waiters[0].exclusive, q.reserved.length], ['x', true, 0], 'X KEEPS ITS TURN: it waits, exclusive, at the head, ahead of z');
    assert.equal(r.take('y', BUILD).allow, false, 'NOTHING PASSES IT');
    for (const [a, d] of held.slice(0, -1)) { r.l.callDone(a, d.id); assert.deepEqual(reserved(r), [], 'not reserved while another job runs'); }
    const [a, d] = held[held.length - 1];
    r.l.callDone(a, d.id);
    assert.deepEqual(reserved(r), ['x'], 'reserved when the machine is empty');
    assert.equal(r.notes[r.notes.length - 1], 'x', 'and told');
    assert.equal(r.take('x', FULL).allow, true);
    assert.equal(r.l.snapshot()[0].exclusive, true);
  },

  // Jim SHOULD 1: a holder's FULL waits for the other HOLDERS, not behind a waiter (it already holds).
  reentryAhead(M = HJ, N = 2) {
    const r = rig(M, N);
    r.take('a', BUILD);
    const c = r.take('c', BUILD);
    assert.equal(r.take('w', FULL).allow, false);
    r.l.callDone('c', c.id);
    const a = r.take('a', FULL);
    assert.equal(a.allow, true, `A HOLDER'S FULL DOES NOT QUEUE BEHIND A WAITER (${N} slots)`);
    assert.equal(r.l.snapshot()[0].exclusive, true);
    assert.equal(r.l.queueSnapshot().waiters[0].agentId, 'w', 'w still waits');
  },

  // Jim SHOULD 2: an exclusive head dropped by the scheduled sweep lets the waiter behind it in.
  // HEAVY-QUEUE-WAIT-DROPS: the sweep reaps a GONE head (by liveness); a live one is never dropped by age.
  staleHead(M = HJ, N = 2) {
    const r = rig(M, N);
    r.take('b', BUILD);
    assert.equal(r.take('x', FULL).allow, false);
    assert.equal(r.take('y', BUILD).allow, false);
    r.tick(M.HEAVY_TTL_MS / 2);
    r.take('b', BUILD);                                   // the holder re-enters inside ITS TTL
    r.tick(M.HEAVY_TTL_MS / 2 + 1_000);
    r.take('b', BUILD);
    assert.deepEqual(r.l.queueSnapshot().waiters.map((w) => w.agentId), ['x', 'y'], 'an hour on, the live head still waits');
    r.gone.add('x');
    r.tick(1_000);
    assert.deepEqual(reserved(r), ['y'], `A STALE EXCLUSIVE HEAD LETS THE NEXT ONE IN (${N} slots)`);
  },

  // Jim SHOULD 3: a waiter queued for a BUILD that is denied again for a FULL waits as an exclusive.
  reDeny(M = HJ, N = 2) {
    const r = rig(M, N);
    const held = [];
    for (let i = 1; i <= N; i++) held.push([`b${i}`, r.take(`b${i}`, BUILD)]);
    assert.equal(r.take('x', BUILD).allow, false);
    assert.equal(r.take('x', FULL).allow, false);
    r.l.callDone(held[0][0], held[0][1].id);
    assert.deepEqual(reserved(r), [], `A RE-DENY FOR A FULL MAKES THE WAITER EXCLUSIVE (${N} slots)`);
  },

  // Jim SHOULD 4: a waiting test process (a lease, no hook) that dies at the head lets the next one in.
  async leaseGone(M = HJ, N = 2) {
    let procs = null;
    const r = rig(M, N, { probe: async () => procs });
    for (let i = 1; i < N; i++) r.take(`b${i}`, BUILD);
    const w = await r.l.lease('x', { op: 'acquire', pid: 111, createdMs: 5_000, suite: true });
    assert.equal(w.state, 'wait');
    assert.equal(r.take('y', BUILD).allow, false);
    procs = [{ pid: 999, parentPid: 0, commandLine: 'other', createdMs: 1 }];
    await r.l.scan();
    assert.deepEqual(reserved(r), ['y'], `A TEST PROCESS THAT DIES AT THE HEAD LETS THE NEXT ONE IN (${N} slots)`);
  },

  // Jim SHOULD 5: a queued test process asking again while an exclusive cannot fit is not denied again.
  async leasePoll(M = HJ, N = 2) {
    const r = rig(M, N, { leasePollMs: 0 });
    for (let i = 1; i < N; i++) r.take(`b${i}`, BUILD);
    const ask = () => r.l.lease('x', { op: 'acquire', pid: 111, createdMs: 5_000, suite: true });
    assert.equal((await ask()).state, 'wait');
    assert.equal((await ask()).state, 'wait');
    const denies = r.logs.filter((x) => x.action === 'deny' && x.agentId === 'x').length;
    assert.equal(denies, 1, `A WAITING TEST PROCESS ASKS AGAIN WITHOUT A NEW DENY (${N} slots)`);
  },

  // One slot is always alone: the same grants, denies and texts as before.
  one(M = HJ) {
    const r = rig(M, 1);
    const x = r.take('x', FULL);
    const d = r.take('b', BUILD);
    assert.equal(d.allow, false);
    assert.doesNotMatch(d.reason, /runs alone/, 'ONE SLOT: NO NEW TEXT');
    r.l.callDone('x', x.id);
    assert.deepEqual(reserved(r), ['b']);
  }
};

for (const N of [2, 3]) {
  test(`N=${N}: an exclusive waits for every slot to drain`, () => K.drain(HJ, N));
  test(`N=${N}: nothing joins an exclusive holder or reservation`, () => K.nothingJoins(HJ, N));
  test(`N=${N}: FIFO, builds coming and going do not starve a waiting FULL`, () => K.fifo(HJ, N));
  test(`N=${N}: an exclusive head that leaves the queue lets the next in`, () => K.headLeaves(HJ, N));
  test(`N=${N}: a holder's own FULL waits for the others, then runs alone`, () => K.reentry(HJ, N));
  test(`N=${N}: a FULL on a slot reserved for a build waits at the head for the drain`, () => K.reservedShared(HJ, N));
  test(`N=${N}: a holder's FULL does not queue behind a waiter`, () => K.reentryAhead(HJ, N));
  test(`N=${N}: a stale exclusive head lets the next one in`, () => K.staleHead(HJ, N));
  test(`N=${N}: a build waiter denied again for a FULL waits as an exclusive`, () => K.reDeny(HJ, N));
  test(`N=${N}: a waiting test process that dies at the head lets the next one in`, () => K.leaseGone(HJ, N));
  test(`N=${N}: a waiting test process asks again without a new deny`, () => K.leasePoll(HJ, N));
}
test('the classes: FULLs, benches, mutant runners and the explicit marker are exclusive', () => K.classes());
test('N=1: exclusive changes nothing', () => K.one());

test('HOOK: at 2 slots a FULL from one agent denies another agent\'s build (the classifier reaches the lock)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hse-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  let hive = null;
  t.after(async () => {
    if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph;
    if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu;
    // The hive keeps its log open until dispose, and may still be writing (ENOTEMPTY): removeDir
    // waits for it (TEST-TEMP-HYGIENE: a leftover fails the run).
    if (hive) hive.dispose();
    await removeDir(home);
  });
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const { HeavyJobLock } = loadTs(HJF);
  hive = new HiveManager(() => home);
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  s.setHeavyLock(new HeavyJobLock({ limit: () => 2, setTimer: () => ({}), clearTimer: () => {} }));
  const fire = (agent_id, command, id) => s.handle({ agent_id, hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, transcript_path: '' });
  const first = await fire('a1', 'npm test', 'u1');
  assert.notEqual(first?.hookSpecificOutput?.permissionDecision, 'deny', 'a1 takes the machine');
  const denied = await fire('a2', 'npm run build', 'u2');
  assert.equal(denied?.hookSpecificOutput?.permissionDecision, 'deny', 'HOOK: NOTHING JOINS A FULL');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /runs alone/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const MUTANTS = [
  { name: 'an exclusive is counted like any job (no drain)',
    edits: [['    return exclusive ? others === 0 : this.holders.size + this.reservations.size < limit;', '    return this.holders.size + this.reservations.size < limit;']],
    killer: 'drain', dies: /EXCLUSIVE WAITS FOR DRAIN/ },
  { name: 'an exclusive holder does not block the others',
    edits: [['    for (const h of this.holders.values()) { if (h.agentId === agentId) continue; if (h.exclusive) return false; others++; }', '    for (const h of this.holders.values()) { if (h.agentId === agentId) continue; others++; }']],
    killer: 'nothingJoins', dies: /NOTHING JOINS AN EXCLUSIVE HOLDER/ },
  { name: 'an exclusive reservation does not block the others',
    edits: [['    for (const [a, r] of this.reservations) { if (a === agentId) continue; if (r.exclusive) return false; others++; }', '    for (const [a, r] of this.reservations) { if (a === agentId) continue; others++; }']],
    killer: 'nothingJoins', dies: /NOTHING JOINS A RESERVED EXCLUSIVE/ },
  { name: 'a newcomer may pass the queue (exclusive starves)',
    edits: [['    if ((at < 0 ? this.waiters.length : at) > 0) return false;\n', '']],
    killer: 'fifo', dies: /A NEWCOMER DOES NOT JUMP AN EXCLUSIVE WAITER/ },
  { name: 'the grant skips a blocked exclusive head',
    edits: [['    while (this.waiters.length && this.fits(this.waiters[0].agentId, this.waiters[0].exclusive, limit)) {', '    while (this.waiters.length && this.holders.size + this.reservations.size < limit) {']],
    killer: 'drain', n: 3, dies: /EXCLUSIVE WAITS FOR DRAIN: not reserved while another job still runs/ },
  { name: 'a gone head keeps the queue blocked',
    edits: [['    else if (queued) this.grant();\n', '']],
    killer: 'headLeaves', dies: /A HEAD THAT LEAVES THE QUEUE LETS THE NEXT ONE IN \(gone/ },
  { name: 'a re-entry joins without waiting',
    edits: [['      if (excl && !mine.exclusive && !reserved && !this.fits(agentId, true, limit)) return this.deny(agentId, cls, limit, callId);\n', '']],
    killer: 'reentry', dies: /AN EXCLUSIVE RE-ENTRY WAITS FOR THE OTHER HOLDERS/ },
  { name: 'the classifier marks nothing exclusive',
    edits: [["  return cls.heavy && !cls.provisional && (cls.exclusive === true || cls.kind === 'suite' || cls.kind === 'bench');", '  return cls.heavy && cls.exclusive === true;']],
    killer: 'classes', dies: /A FULL, A BENCH, A MUTANT RUNNER OR THE MARKER RUNS ALONE/ },
  { name: 'no explicit marker',
    edits: [['(SCALE|BENCH|STRESS|SOAK|EXCLUSIVE)', '(SCALE|BENCH|STRESS|SOAK)']],
    killer: 'classes', dies: /A FULL, A BENCH, A MUTANT RUNNER OR THE MARKER RUNS ALONE: GUPPY_HEAVY_EXCLUSIVE/ },
  { name: 'a shared reservation takes a FULL (Jim MUST-1)',
    edits: [['    if (reserved && excl && !this.fits(agentId, true, limit)) {', '    if (false) {']],
    killer: 'reservedShared', dies: /A SHARED RESERVATION IS NOT THE EMPTY MACHINE/ },
  { name: 'the FULL goes to the back of the queue (Jim NIT-1)',
    edits: [['      this.waiters.unshift({ agentId, kind: cls.kind as HeavyKind,', '      this.waiters.push({ agentId, kind: cls.kind as HeavyKind,']],
    killer: 'reservedShared', dies: /X KEEPS ITS TURN/ },
  { name: 'a holder\'s FULL queues behind a waiter (re-entry admits)',
    edits: [['      if (excl && !mine.exclusive && !reserved && !this.fits(agentId, true, limit)) return', '      if (excl && !mine.exclusive && !reserved && !this.admits(agentId, true, limit)) return']],
    killer: 'reentryAhead', dies: /A HOLDER'S FULL DOES NOT QUEUE BEHIND A WAITER/ },
  { name: 'a stale head leaves without a grant',
    edits: [['    if (passed || left) this.grant();', '    if (passed) this.grant();']],
    killer: 'staleHead', dies: /A STALE EXCLUSIVE HEAD LETS THE NEXT ONE IN/ },
  { name: 'a re-deny keeps the waiter shared',
    edits: [['this.waiters[i].exclusive ||= exclusive; ', '']],
    killer: 'reDeny', dies: /A RE-DENY FOR A FULL MAKES THE WAITER EXCLUSIVE/ },
  { name: 'a dead waiting test process leaves without a grant',
    edits: [['    let freed = waiterLeft;', '    let freed = false;']],
    killer: 'leaseGone', dies: /A TEST PROCESS THAT DIES AT THE HEAD LETS THE NEXT ONE IN/ },
  { name: 'the lease counts slots, not fits()',
    edits: [["      const full = limit !== 'off' && !this.fits(agentId, heavyExclusive(cls), limit);", "      const full = limit !== 'off' && this.holders.size + this.reservations.size >= limit;"]],
    killer: 'leasePoll', dies: /A WAITING TEST PROCESS ASKS AGAIN WITHOUT A NEW DENY/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const M = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](M, m.n ?? 2), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
