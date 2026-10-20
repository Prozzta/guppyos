'use strict';
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
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const FULL = { heavy: true, kind: 'suite', why: 'npm test' };
const BENCH = { heavy: true, kind: 'bench', why: 'node capacity-mutants.cjs' };
const BUILD = { heavy: true, kind: 'build', why: 'npm run build' };

function rig(M, limit) {
  let now = 1_000_000; const logs = []; const notes = []; const gone = new Set();
  const l = new M.HeavyJobLock({
    limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k) => notes.push(a), alive: (a) => !gone.has(a)
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
}
test('the classes: FULLs, benches, mutant runners and the explicit marker are exclusive', () => K.classes());
test('N=1: exclusive changes nothing', () => K.one());

test('HOOK: at 2 slots a FULL from one agent denies another agent\'s build (the classifier reaches the lock)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hse-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  t.after(() => {
    if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph;
    if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu;
    // The hive may still be writing (ENOTEMPTY): retry, and a leftover temp dir is not a failure.
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
  });
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const { HeavyJobLock } = loadTs(HJF);
  const hive = new HiveManager(() => home);
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
    edits: [["  return cls.heavy && (cls.exclusive === true || cls.kind === 'suite' || cls.kind === 'bench');", '  return cls.heavy && cls.exclusive === true;']],
    killer: 'classes', dies: /A FULL, A BENCH, A MUTANT RUNNER OR THE MARKER RUNS ALONE/ },
  { name: 'no explicit marker',
    edits: [['(SCALE|BENCH|STRESS|SOAK|EXCLUSIVE)', '(SCALE|BENCH|STRESS|SOAK)']],
    killer: 'classes', dies: /A FULL, A BENCH, A MUTANT RUNNER OR THE MARKER RUNS ALONE: GUPPY_HEAVY_EXCLUSIVE/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const M = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      assert.throws(() => K[m.killer](M, m.n ?? 2), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
