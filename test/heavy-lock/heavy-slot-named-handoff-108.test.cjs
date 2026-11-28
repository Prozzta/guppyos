'use strict';
require('../tools/own-job.cjs');

/**
 * FLOOR-INBOX-HOLD-DELAYS-BENCH-GO (1.1.108), F3: the slot is handed straight to the agent named next.
 *
 * The real case (2026-11-25): god keeps the bench line by mail, so the agents wait for a GO and are never
 * denied, never queued. `heavy next <agent>` on such an agent only stored the name ("it goes to the head
 * when it next asks"): when the holder's job ended the lock had nobody to tell, and the GO that followed
 * by mail sat held for 30 min (mail 5239f2).
 *
 * Now a freed slot is RESERVED for the named agent though it never queued (5 min, as for a waiter) and
 * it is told "HEAVY SLOT FREE"; a slot already free when the name is given is reserved at once. The
 * agent's kind of job is not known, so it gets the whole machine (a suite or a bench runs alone). An
 * unused hand-off passes on and does not queue the agent (it never asked).
 * A QUEUED agent, named or not, is served as before: pinned in K.queuedUnchanged.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const IXF = 'src/main/index.ts';
const HJ = loadTs(HJF);
const CLI = require('../../resources/heavy-cli.cjs');
const H = { heavy: true, kind: 'suite' };
const B = { heavy: true, kind: 'build' };   // shared: two may run beside each other

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const named = []; const lapses = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), notifyNamed: (a, until) => named.push({ a, until }),
    notifyLapse: (a, k, why) => lapses.push([a, k, why]),
    alive: () => true, isGod: (a) => a === 'god', ...extra
  });
  const status = async (a) => l.lease(a, { op: 'status' });
  return { l, logs, notes, named, lapses, status, tick: (ms) => { now += ms; }, now: () => now, rows: (action) => logs.filter((r) => r.action === action) };
}
const waiters = (x) => x.l.queueSnapshot().waiters.map((w) => w.agentId);
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);
const iso = (ms) => new Date(ms).toISOString();

const K = {};

K.namedHandOff = async (M = HJ) => {
  // The 5239f2 shape: UHera's suite holds the slot; Creed waits for god's word and never asked the lock.
  const x = rig(M);
  x.l.acquire('uhera', H, 'npm test', 'u1', false);
  assert.deepEqual(await x.l.lease('god', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: false });
  assert.deepEqual(reservedFor(x), [], 'nothing is reserved while the job runs');
  assert.deepEqual(x.named, [], 'and nobody is told yet');
  x.l.callDone('uhera', 'u1');
  assert.equal(x.rows('release').length, 1, 'the job ended and the slot was released');
  const until = x.now() + M.HEAVY_RESERVE_MS;
  assert.deepEqual(reservedFor(x), ['creed'], 'THE FREED SLOT IS RESERVED FOR THE NAMED AGENT THAT NEVER QUEUED');
  assert.deepEqual(x.rows('reserve'), [{ kind: 'heavy-lock', action: 'reserve', agentId: 'creed', heavyKind: 'suite', until: iso(until), waitedMs: 0, exclusive: true, named: true }], 'THE HAND-OFF IS LOGGED');
  assert.deepEqual(x.named, [{ a: 'creed', until }], 'THE NAMED AGENT IS TOLD HEAVY SLOT FREE');
  assert.deepEqual(x.notes, [], 'not with the text for a denied call');
  assert.equal((await x.status('god')).next, null, 'THE NAME IS SPENT');
  // The slot is his: his bench starts with no denial.
  assert.deepEqual(x.l.acquire('creed', H, 'bash bench.sh', 'c1', false), { allow: true, acquired: true }, 'THE NAMED AGENT TAKES ITS SLOT');
  assert.deepEqual(reservedFor(x), []);
  assert.equal(x.rows('acquire').at(-1).reserved, true);
};
test('F3: a slot that frees is reserved for the agent named by `heavy next` though it never queued, and it is told (the 5239f2 case)', () => K.namedHandOff());

K.namedFreeNow = async (M = HJ) => {
  // The slot is already free when god gives the word: no release will come to hand it over.
  const x = rig(M);
  const a = await x.l.lease('god', { op: 'next', to: 'creed' });
  const until = x.now() + M.HEAVY_RESERVE_MS;
  assert.deepEqual(a, { state: 'next', to: 'creed', queued: false, reserved: true }, 'A SLOT FREE NOW IS RESERVED AT ONCE');
  assert.deepEqual(reservedFor(x), ['creed']);
  assert.deepEqual(x.named, [{ a: 'creed', until }], 'and the agent is told at once');
  assert.equal((await x.status('god')).next, null);
  assert.equal(CLI.describe(a), 'heavy: the next freed slot goes to creed (not queued: a slot is free now, so it is reserved for it and it is told)\n', 'THE CLI SAYS THE SLOT WAS HANDED OVER');
  // While a job runs the answer promises the hand-off at its end.
  const y = rig(M);
  y.l.acquire('uhera', H, 'npm test', 'u1', false);
  const b = await y.l.lease('uhera', { op: 'next', to: 'creed' });
  assert.deepEqual(b, { state: 'next', to: 'creed', queued: false });
  assert.equal(CLI.describe(b), 'heavy: the next freed slot goes to creed (not queued: when the slot frees it is reserved for it and it is told)\n', 'THE CLI PROMISES THE HAND-OFF');
};
test('F3: `heavy next` on a slot that is free now reserves it at once', () => K.namedFreeNow());

K.namedAhead = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('uhera', H, 'npm test', 'u1', false);
  assert.equal(x.l.acquire('andy', H, 'npm test', 'a1', false).allow, false);
  await x.l.lease('god', { op: 'next', to: 'creed' });
  x.l.callDone('uhera', 'u1');
  assert.deepEqual(reservedFor(x), ['creed'], 'THE NAMED AGENT IS SERVED AHEAD OF THE QUEUE');
  assert.deepEqual(waiters(x), ['andy'], 'the waiter keeps its place');
  assert.deepEqual(x.notes, [], 'and is not told yet');
  assert.equal(x.l.acquire('creed', H, 'bash bench.sh', 'c1', false).allow, true);
  x.l.callDone('creed', 'c1');
  assert.deepEqual(reservedFor(x), ['andy'], 'THE WAITER IS SERVED NEXT');
  assert.deepEqual(x.notes.map((n) => n.a), ['andy']);
};
test('F3: the named agent that never queued is served ahead of the queue, and the queue follows', () => K.namedAhead());

K.queuedUnchanged = async (M = HJ) => {
  // No name: the oldest waiter, as ever.
  const x = rig(M);
  x.l.acquire('uhera', H, 'npm test', 'u1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  x.tick(7_000);
  x.l.acquire('creed', H, 'npm test', 'c1', false);
  x.tick(3_000);
  x.l.callDone('uhera', 'u1');
  const until = x.now() + M.HEAVY_RESERVE_MS;
  assert.deepEqual(reservedFor(x), ['andy'], 'WITH NO NAME THE OLDEST WAITER IS SERVED');
  assert.deepEqual(x.rows('reserve'), [{ kind: 'heavy-lock', action: 'reserve', agentId: 'andy', heavyKind: 'suite', until: iso(until), waitedMs: 10_000, exclusive: true }], 'A WAITER\'S RESERVE ROW IS AS IT WAS');
  assert.deepEqual(x.notes, [{ a: 'andy', k: 'suite', until }], 'A WAITER IS TOLD AS IT WAS');
  assert.deepEqual(x.named, []);
  // A named agent that IS queued: moved to the head, reserved with its own kind and wait, told as a waiter.
  const y = rig(M, { limit: () => 2 });
  y.l.acquire('uhera', H, 'npm test', 'u1', false);
  y.l.acquire('andy', H, 'npm test', 'a1', false);
  y.l.acquire('creed', B, 'npm run build', 'c1', false);
  assert.deepEqual(await y.l.lease('god', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: true });
  y.tick(4_000);
  y.l.callDone('uhera', 'u1');
  const yu = y.now() + M.HEAVY_RESERVE_MS;
  assert.deepEqual(y.named, [], 'A QUEUED NAMED AGENT IS TOLD AS A WAITER');
  assert.deepEqual(y.notes, [{ a: 'creed', k: 'build', until: yu }], 'with the kind it asked for');
  assert.deepEqual(y.rows('reserve'), [{ kind: 'heavy-lock', action: 'reserve', agentId: 'creed', heavyKind: 'build', until: iso(yu), waitedMs: 4_000 }], 'A QUEUED NAMED AGENT KEEPS ITS OWN KIND AND IS NOT EXCLUSIVE');
  assert.deepEqual(waiters(y), ['andy']);
};
test('F3 leaves a QUEUED agent as it was: the oldest waiter with no name, the named waiter with its own kind', () => K.queuedUnchanged());

K.namedLapse = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('uhera', H, 'npm test', 'u1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  await x.l.lease('god', { op: 'next', to: 'creed' });
  x.l.callDone('uhera', 'u1');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS - 1);
  assert.deepEqual(reservedFor(x), ['creed'], 'the hand-off stands for the 5 min of any reservation');
  x.tick(1);
  assert.deepEqual(reservedFor(x), ['andy'], 'AN UNUSED HAND-OFF PASSES TO THE QUEUE');
  assert.deepEqual(waiters(x), [], 'AN UNUSED HAND-OFF DOES NOT QUEUE THE AGENT (it never asked)');
  assert.deepEqual(x.lapses, [['creed', 'suite', 'expired']], 'THE AGENT IS TOLD ITS HAND-OFF LAPSED');
  assert.deepEqual(x.notes.map((n) => n.a), ['andy']);
};
test('F3: a hand-off the named agent does not use in 5 min passes on; the agent is told and is not queued', () => K.namedLapse());

K.namedGuards = async (M = HJ) => {
  // Two slots, a shared build runs: the named agent's job is unknown, so it waits for the whole machine.
  const x = rig(M, { limit: () => 2 });
  x.l.acquire('uhera', B, 'npm run build', 'u1', false);
  assert.deepEqual(await x.l.lease('god', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: false }, 'A NAMED AGENT IS NOT RESERVED BESIDE A RUNNING JOB');
  assert.deepEqual(reservedFor(x), []);
  assert.equal((await x.status('god')).next, 'creed', 'the name stands');
  x.l.callDone('uhera', 'u1');
  assert.deepEqual(reservedFor(x), ['creed']);
  assert.equal(x.l.acquire('andy', B, 'npm run build', 'a1', false).allow, false, 'NOTHING STARTS BESIDE THE NAMED AGENT\'S SLOT');
  assert.equal(x.l.acquire('creed', H, 'bash bench.sh', 'c1', false).allow, true, 'and its exclusive job starts');
  // The named agent left the floor before the slot freed (no PTY): nothing is reserved for it.
  const gone = new Set();
  const y = rig(M, { alive: (a) => !gone.has(a) });
  y.l.acquire('uhera', H, 'npm test', 'u1', false);
  await y.l.lease('god', { op: 'next', to: 'creed' });
  gone.add('creed');
  y.l.callDone('uhera', 'u1');
  assert.deepEqual(reservedFor(y), [], 'A NAMED AGENT THAT LEFT THE FLOOR IS NOT RESERVED');
  assert.deepEqual(y.named, []);
  assert.equal(y.l.acquire('andy', H, 'npm test', 'a1', false).allow, true, 'and the slot is free for the next call');
};
test('F3: the named agent gets the whole machine (never beside a running job), and a gone one gets nothing', () => K.namedGuards());

K.notice = (M = HJ) => {
  const until = Date.UTC(2026, 10, 25, 7, 54, 33);
  const n = M.heavySlotNamedNotice('creed', until);
  assert.equal(n.from, 'system', 'THE NOTICE IS FROM system (always wakes)');
  assert.deepEqual({ ...n.message, subject: '', body: '' }, { to: 'creed', act: 'inform', requires_reply: false, subject: '', body: '', wake: 'now' }, 'THE NOTICE WAKES NOW AND ASKS NO REPLY');
  assert.equal(n.message.subject, 'HEAVY SLOT FREE: you were named next for the heavy slot; it is reserved for you until 07:54Z');
  assert.match(n.message.body, /^You were named the next holder of the heavy-job slot \(`heavy next`\) and it is free: it is reserved for you until 07:54Z\. /);
  assert.match(n.message.body, /If you do not start it by then, the slot passes on and you are not queued/);
  assert.doesNotMatch(n.message.subject + n.message.body, /denied|queued for/, 'IT DOES NOT SPEAK OF A DENIAL THAT NEVER WAS');
  assert.equal(n.steer, `${n.message.subject}.`);
};
test('F3: the notice for a named agent (system, wake now, no reply, no talk of a denial)', () => K.notice());

K.indexWires = (text = readSource(IXF)) => {
  assert.match(text, /\n  notifyNamed: \(agentId, until\) => notifyHeavySlotNamed\(agentId, until\),\n/, 'MAIN WIRES THE NAMED NOTICE INTO THE LOCK');
  assert.match(text, /function notifyHeavySlotNamed\(agentId: string, until: number\): void \{\n  const n = heavySlotNamedNotice\(agentId, until\);\n  try \{ hive\.send\(n\.message as Partial<HiveMessage>, n\.from\); \} catch \{ \/\* best effort \*\/ \}\n  try \{ control\.steer\(agentId, n\.steer\); \} catch \{ \/\* best effort \*\/ \}\n\}/, 'MAIN SENDS THE NAMED NOTICE ON BOTH RAILS');
};
test('F3: main wires notifyNamed and sends the notice by mail and by steer', () => K.indexWires());

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

const RESERVE = "    this.reservations.set(to, { kind: 'suite', until, procs: [], hooked: true, exclusive: true, lapsed: true });";
const MUTANTS = [
  { name: 'the freed slot is not handed to a named agent that never queued (the defect)', edits: [['    if (ni < 0) this.handNamed(limit);\n', '']],
    killer: 'namedHandOff', dies: /THE FREED SLOT IS RESERVED FOR THE NAMED AGENT THAT NEVER QUEUED/ },
  { name: 'the hand-off is not logged', edits: [["    this.log({ kind: 'heavy-lock', action: 'reserve', agentId: to, heavyKind: 'suite', until: new Date(until).toISOString(), waitedMs: 0, exclusive: true, named: true });\n", '']],
    killer: 'namedHandOff', dies: /THE HAND-OFF IS LOGGED/ },
  { name: 'the named agent is reserved but not told', edits: [['    try { this.d.notifyNamed?.(to, until); } catch { /* best effort: the reservation stands */ }\n', '']],
    killer: 'namedHandOff', dies: /THE NAMED AGENT IS TOLD HEAVY SLOT FREE/ },
  { name: 'the name outlives its hand-off', edits: [['    this.nextUp = null;   // the name is spent\n', '']],
    killer: 'namedHandOff', dies: /THE NAME IS SPENT/ },
  { name: 'a slot free at `heavy next` waits for a release that never comes', edits: [['    if (!queued) this.grant();\n', '']],
    killer: 'namedFreeNow', dies: /A SLOT FREE NOW IS RESERVED AT ONCE/ },
  { name: 'the answer does not say the slot was handed over', edits: [['    if (reserved) return { state: \'next\', to, queued, reserved };\n', '']],
    killer: 'namedFreeNow', dies: /A SLOT FREE NOW IS RESERVED AT ONCE/ },
  { name: 'a queued named agent is handed the slot as if it never asked', edits: [['    if (ni < 0) this.handNamed(limit);\n', '    this.handNamed(limit);\n']],
    killer: 'queuedUnchanged', dies: /A QUEUED NAMED AGENT IS TOLD AS A WAITER/ },
  { name: 'an unused hand-off queues the agent again', edits: [[RESERVE, RESERVE.replace('lapsed: true', 'lapsed: false')]],
    killer: 'namedLapse', dies: /AN UNUSED HAND-OFF DOES NOT QUEUE THE AGENT/ },
  { name: 'the named agent is reserved beside a running job', edits: [['    if (!this.alive(to) || !this.fits(to, true, limit)) return;\n', '    if (!this.alive(to) || !this.fits(to, false, limit)) return;\n']],
    killer: 'namedGuards', dies: /A NAMED AGENT IS NOT RESERVED BESIDE A RUNNING JOB/ },
  { name: 'the hand-off is a shared reservation', edits: [[RESERVE, RESERVE.replace('exclusive: true', 'exclusive: false')]],
    killer: 'namedGuards', dies: /NOTHING STARTS BESIDE THE NAMED AGENT'S SLOT/ },
  { name: 'a named agent that left the floor is reserved', edits: [['    if (!this.alive(to) || !this.fits(to, true, limit)) return;\n', '    if (!this.fits(to, true, limit)) return;\n']],
    killer: 'namedGuards', dies: /A NAMED AGENT THAT LEFT THE FLOOR IS NOT RESERVED/ },
  { name: 'the named notice speaks of a denial (the waiter text)', edits: [['  const subject = `HEAVY SLOT FREE: you were named next for the heavy slot; it is reserved for you until ${at}`;', '  const subject = `HEAVY SLOT FREE: the suite you were denied can run now; the slot is reserved for you until ${at}`;']],
    killer: 'notice', dies: /HEAVY SLOT FREE: you were named next/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mutated = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](mutated), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
  await t.test('mutant: main does not wire notifyNamed', () => {
    const text = mutateText(IXF, [['  notifyNamed: (agentId, until) => notifyHeavySlotNamed(agentId, until),\n', '']], 'wire');
    assert.throws(() => K.indexWires(text), /MAIN WIRES THE NAMED NOTICE INTO THE LOCK/, 'MUST DIE');
  });
});
