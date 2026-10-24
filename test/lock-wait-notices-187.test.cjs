'use strict';
require('./tools/own-job.cjs');

/**
 * LOCK-WAIT-NOTICES-187 (1.1.87): the heavy-job lock left a waiting agent unaware in two places
 * (Jim's IDLE-MEANS-IDLE diagnosis, GAP 1 and GAP 2):
 *  - a waiter not denied again for HEAVY_TTL_MS was dropped from the queue as stale, silently. An
 *    agent told "do not retry, you will be told" behind a long holder waited for a notice that
 *    never came;
 *  - a reservation left unused for HEAVY_RESERVE_MS lapses, and the agent was not told it had lost
 *    the slot and was no longer queued.
 * Both got a notice, on the same two rails (mail + steer) as "HEAVY SLOT FREE".
 * HEAVY-QUEUE-WAIT-DROPS (1.1.98): the stale drop itself is GONE: it bounded the wait to 60 min
 * while a stage bench holds the slot ~90 min, so a patient waiter fell out and re-queued at the
 * back. A waiter now keeps its place until served, released, or its agent is gone; the only
 * scheduled sweep is by liveness (reason 'gone', no notice: no PTY to tell). GAP 2 is as before.
 * Not told: the agent whose own heavy call is running (its deny or acquire says it all), and a
 * gone agent (no PTY to tell).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const { HeavyJobLock, HEAVY_RESERVE_MS, HEAVY_TTL_MS } = HJ;

const T0 = Date.parse('2026-10-15T07:00:00.000Z');
const MIN = 60_000;
const SUITE = { heavy: true, kind: 'suite' };

function fakeLock(opts = {}) {
  const clock = { t: T0 };
  const rows = [];
  const freed = [];
  const lapsed = [];
  const lock = new HeavyJobLock({
    limit: () => 1, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {},
    log: (r) => rows.push(r),
    notify: (a, k, u) => freed.push([a, k, u]),
    notifyLapse: (a, k, why) => lapsed.push([a, k, why]),
    ...(opts.alive ? { alive: opts.alive } : {})
  });
  return { lock, clock, rows, freed, lapsed };
}

test('GAP 1 (HEAVY-QUEUE-WAIT-DROPS): a waiter silent past the hour is NOT dropped when the slot frees: it is reserved and told HEAVY SLOT FREE', () => {
  const { lock, clock, rows, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  assert.equal(lock.acquire('w', SUITE, 'npm test', 'w1', false).allow, false, 'queued #1');
  clock.t += HEAVY_TTL_MS - MIN;
  lock.acquire('holder', SUITE, 'npm test &', 'h2', true); // the holder's own re-entry keeps it fresh
  clock.t += 2 * MIN;
  lock.release('holder', 'process-exit');
  assert.deepEqual(rows.slice(-2).map((r) => [r.action, r.agentId]), [['release', 'holder'], ['reserve', 'w']]);
  assert.ok(!rows.some((r) => r.action === 'queue-dropped'), 'no drop by age');
  assert.deepEqual(lapsed, [], 'nothing lapsed');
  assert.deepEqual(freed.map((f) => f.slice(0, 2)), [['w', 'suite']], 'the slot is reserved for it');
  assert.deepEqual(lock.queueSnapshot().reserved.map((r) => r.agentId), ['w']);
});

test('Jim NIT 1 (HEAVY-QUEUE-WAIT-DROPS): a GONE waiter leaves the queue ON SCHEDULE while the holder still runs, untold, and no display says QUEUED any more; a live one stays past the hour', async () => {
  const ACT = loadTs('src/shared/activityView.ts');
  let gone = false;
  const { lock, clock, rows, lapsed } = fakeLock({ alive: (id) => !(gone && id === 'w') });
  let changes = 0;
  lock.onChange(() => { changes++; });
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('w', SUITE, 'npm test', 'w1', false);
  lock.acquire('v', SUITE, 'npm test', 'v1', false);
  clock.t += HEAVY_TTL_MS / 2;
  lock.acquire('holder', SUITE, 'npm test &', 'h2', true); // the holder's re-entry keeps its own TTL fresh
  clock.t += HEAVY_TTL_MS / 2 + MIN;
  await lock.scan(); // the watcher's tick an hour on: both still queued (no drop by age)
  assert.deepEqual(lock.queueSnapshot().waiters.map((x) => x.agentId), ['w', 'v'], 'an hour on, both wait');
  assert.deepEqual(lapsed, []);
  gone = true;
  const before = changes;
  await lock.scan(); // the watcher's tick (armed while the slot is held); no slot frees
  assert.deepEqual(rows.at(-1), { kind: 'heavy-lock', action: 'queue-dropped', agentId: 'w', reason: 'gone' });
  assert.equal(changes - before, 1, 'one change: the displays repaint');
  assert.deepEqual(lapsed, [], 'a gone agent is not told (no PTY)');
  const view = { holders: lock.snapshot(), ...lock.queueSnapshot() };
  assert.deepEqual(view.waiters.map((x) => [x.agentId, x.position]), [['v', 1]], 'v moves up');
  assert.equal(ACT.heavyActivity('w', view), null, 'no QUEUED #n for an agent the lock can never serve');
  assert.equal(ACT.heavyActivity('holder', view).state, 'background', 'the holder is untouched');
  // v, never asking again, outlives a second hour in its place (the holder re-enters inside ITS TTL).
  lock.acquire('holder', SUITE, 'npm test &', 'h3', true);
  clock.t += HEAVY_TTL_MS / 2;
  lock.acquire('holder', SUITE, 'npm test &', 'h4', true);
  clock.t += HEAVY_TTL_MS / 2 + MIN;
  await lock.scan();
  assert.deepEqual(lock.snapshot().map((h) => h.agentId), ['holder'], 'the holder still holds');
  assert.ok(!rows.some((r) => r.action === 'queue-dropped' && r.agentId === 'v'), 'v is not dropped');
  assert.deepEqual(lapsed, []);
});

// HEAVY-HANDOFF-RACE (c): a lapsed reservation no longer drops its owner at once: it is queued again at
// the back, once (here no one else waits, so the slot is reserved for it again and it is told HEAVY SLOT
// FREE again); the SECOND unused reservation drops it, told 'expired'.
test('GAP 2: a reservation that lapses unused queues its agent again once; the second lapse tells it it lost the slot', () => {
  const { lock, clock, rows, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('w', SUITE, 'npm test', 'w1', false);
  lock.release('holder', 'process-exit');
  assert.equal(freed.length, 1, 'HEAVY SLOT FREE as before');
  clock.t += HEAVY_RESERVE_MS;
  lock.queueSnapshot(); // the watcher (or any read) expires it
  assert.deepEqual(rows.slice(-3).map((r) => r.action), ['reserve-expired', 'queue-again', 'reserve'], 'queued again, and the free slot is its again');
  assert.deepEqual(lapsed, [], 'told HEAVY SLOT FREE again instead');
  assert.equal(freed.length, 2);
  clock.t += HEAVY_RESERVE_MS;
  lock.queueSnapshot();
  assert.deepEqual(rows.at(-1), { kind: 'heavy-lock', action: 'reserve-expired', agentId: 'w', heavyKind: 'suite', again: true });
  assert.deepEqual(lapsed, [['w', 'suite', 'expired']], 'the second lapse drops it, told plainly');
  // Once only: a later read does not re-tell it.
  lock.snapshot();
  clock.t += MIN;
  lock.queueSnapshot();
  assert.equal(lapsed.length, 1);
  assert.deepEqual(lock.queueSnapshot().waiters, [], 'and it is out');
});

test('the lapse passes the slot on as before: the next waiter is reserved and told HEAVY SLOT FREE', () => {
  const { lock, clock, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('a', SUITE, 'npm test', 'a1', false);
  lock.acquire('b', SUITE, 'npm test', 'b1', false);
  lock.release('holder', 'process-exit');
  clock.t += HEAVY_RESERVE_MS;
  lock.queueSnapshot();
  // HEAVY-HANDOFF-RACE (c): a is queued again behind b and told so ('requeued'), not dropped.
  assert.deepEqual(lapsed, [['a', 'suite', 'requeued']]);
  assert.deepEqual(freed.map((f) => f[0]), ['a', 'b']);
  assert.deepEqual(lock.queueSnapshot().reserved.map((r) => r.agentId), ['b']);
  assert.deepEqual(lock.queueSnapshot().waiters.map((w) => w.agentId), ['a']);
});

test('not told: the caller whose own call meets its lapse or its drop, and a gone agent', () => {
  // Its reservation lapsed just as it runs its job: its own acquire answers it; no lapse notice.
  {
    const { lock, clock, lapsed } = fakeLock();
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('w', SUITE, 'npm test', 'w1', false);
    lock.release('holder', 'process-exit');
    clock.t += HEAVY_RESERVE_MS;
    const d = lock.acquire('w', SUITE, 'npm test', 'w2', false);
    assert.equal(d.allow, true, 'nobody else waits, so w takes the free slot');
    assert.deepEqual(lapsed.filter((l) => l[0] === 'w'), [], 'w is not told about its own lapse');
  }
  // A waiter silent past the hour whose own acquire meets a freed slot: it takes it (no drop, no notice).
  {
    let limit = 1;
    const rows = [];
    const lapsed = [];
    const clock = { t: T0 };
    const lock = new HeavyJobLock({ limit: () => limit, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {}, log: (r) => rows.push(r), notifyLapse: (a, k, w) => lapsed.push([a, k, w]) });
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('w', SUITE, 'npm test', 'w1', false);
    clock.t += HEAVY_TTL_MS + MIN;
    limit = 2; // a raised limit frees a slot inside w's own acquire
    assert.equal(lock.acquire('w', SUITE, 'npm test', 'w2', false).allow, true, 'w takes the slot an hour on');
    assert.ok(!rows.some((r) => r.action === 'queue-dropped'), 'no drop by age');
    assert.deepEqual(lapsed, []);
  }
  // A gone waiter: dropped as gone, no notice.
  {
    const { lock, lapsed } = fakeLock({ alive: (id) => id !== 'w' });
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('w', SUITE, 'npm test', 'w1', false);
    lock.release('holder', 'process-exit');
    assert.deepEqual(lapsed, []);
  }
});

test('Dwight MUST: a gone agent is not told at the scheduled liveness sweep, nor when a reservation issued while it lived lapses', () => {
  // A gone waiter at the scheduled sweep: reaped at the next read or tick (as gone), not told.
  {
    let gone = false;
    const { lock, clock, rows, lapsed } = fakeLock({ alive: (id) => !(gone && id === 'w') });
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('w', SUITE, 'npm test', 'w1', false);
    clock.t += MIN;
    gone = true;
    lock.queueSnapshot();
    assert.deepEqual(rows.at(-1), { kind: 'heavy-lock', action: 'queue-dropped', agentId: 'w', reason: 'gone' }, 'reaped by liveness, not age');
    assert.deepEqual(lock.queueSnapshot().waiters, []);
    assert.deepEqual(lapsed, [], 'a gone agent is not told');
  }
  // Reserved while alive, gone before it lapses: the slot passes on, no lapse notice for it.
  {
    let gone = false;
    const { lock, clock, rows, freed, lapsed } = fakeLock({ alive: (id) => !(gone && id === 'a') });
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('a', SUITE, 'npm test', 'a1', false);
    lock.acquire('b', SUITE, 'npm test', 'b1', false);
    lock.release('holder', 'process-exit');
    assert.deepEqual(freed.map((f) => f[0]), ['a'], 'reserved for a while it lived');
    gone = true;
    clock.t += HEAVY_RESERVE_MS;
    lock.queueSnapshot();
    assert.ok(rows.some((r) => r.action === 'reserve-expired' && r.agentId === 'a'));
    assert.deepEqual(lapsed, [], 'a gone agent is not told its slot lapsed');
    assert.deepEqual(freed.map((f) => f[0]), ['a', 'b'], 'the slot still passes on');
  }
  // The positive control: the same live agents are told (as in GAP 1 and GAP 2).
  {
    const { lock, clock, lapsed } = fakeLock({ alive: () => true });
    lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
    lock.acquire('a', SUITE, 'npm test', 'a1', false);
    lock.release('holder', 'process-exit');
    clock.t += HEAVY_RESERVE_MS;
    lock.queueSnapshot();
    // HEAVY-HANDOFF-RACE (c): queued again and reserved again at once (told HEAVY SLOT FREE); the second lapse tells it.
    assert.deepEqual(lapsed, []);
    clock.t += HEAVY_RESERVE_MS;
    lock.queueSnapshot();
    assert.deepEqual(lapsed, [['a', 'suite', 'expired']]);
  }
});

test('an alive check that throws never breaks the lock', () => {
  const clock = { t: T0 };
  const lock = new HeavyJobLock({ limit: () => 1, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {}, log: () => {}, alive: (id) => { if (id === 'a' && clock.t > T0) throw new Error('registry down'); return true; }, notifyLapse: () => {} });
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('a', SUITE, 'npm test', 'a1', false);
  lock.acquire('b', SUITE, 'npm test', 'b1', false);
  lock.release('holder', 'process-exit');
  clock.t += HEAVY_RESERVE_MS;
  assert.doesNotThrow(() => lock.queueSnapshot());
  assert.deepEqual(lock.queueSnapshot().reserved.map((r) => r.agentId), ['b'], 'the slot still passes on');
});

test('a notice that throws never breaks the lock', () => {
  const clock = { t: T0 };
  const lock = new HeavyJobLock({ limit: () => 1, now: () => clock.t, setTimer: () => ({}), clearTimer: () => {}, log: () => {}, notifyLapse: () => { throw new Error('mail down'); } });
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('a', SUITE, 'npm test', 'a1', false);
  lock.acquire('b', SUITE, 'npm test', 'b1', false);
  lock.release('holder', 'process-exit');
  clock.t += HEAVY_RESERVE_MS;
  assert.doesNotThrow(() => lock.queueSnapshot());
  assert.deepEqual(lock.queueSnapshot().reserved.map((r) => r.agentId), ['b'], 'the slot still passes on');
});

test('the notice: a system inform that wakes, says why, and says how to queue again', () => {
  const stale = HJ.heavyWaitLapsedNotice('w', 'suite', 'stale');
  assert.equal(stale.from, 'system');
  assert.deepEqual({ to: stale.message.to, act: stale.message.act, requires_reply: stale.message.requires_reply, wake: stale.message.wake }, { to: 'w', act: 'inform', requires_reply: false, wake: 'now' });
  assert.match(stale.message.subject, /^HEAVY QUEUE LEFT: you are no longer queued for the suite/);
  assert.match(stale.message.body, /not asked again for 60 min/);
  assert.match(stale.message.body, /run it again to queue again/);
  assert.equal(stale.steer, `${stale.message.subject}.`);
  const exp = HJ.heavyWaitLapsedNotice('w', 'build', 'expired');
  assert.match(exp.message.subject, /^HEAVY SLOT LAPSED: the build slot reserved for you was not used in 5 min/);
  assert.match(exp.message.body, /passed to the next agent/);
  assert.match(exp.message.body, /run it again to queue again/);
});

test('main sends the lapse notice on both rails, like HEAVY SLOT FREE', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /notifyLapse: \(agentId, kind, why\) => notifyHeavyWaitLapsed\(agentId, kind, why\)/);
  assert.match(idx, /function notifyHeavyWaitLapsed\(agentId: string, kind: string, why: 'stale' \| 'expired' \| 'requeued'\): void \{\s*const n = heavyWaitLapsedNotice\(agentId, kind, why\);\s*try \{ hive\.send\(n\.message as Partial<HiveMessage>, n\.from\); \} catch \{ \/\* best effort \*\/ \}\s*try \{ control\.steer\(agentId, n\.steer\); \} catch \{ \/\* best effort \*\/ \}\s*\}/);
});
