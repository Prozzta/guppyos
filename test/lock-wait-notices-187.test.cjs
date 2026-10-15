'use strict';

/**
 * LOCK-WAIT-NOTICES-187 (1.1.87): the heavy-job lock left a waiting agent unaware in two places
 * (Jim's IDLE-MEANS-IDLE diagnosis, GAP 1 and GAP 2):
 *  - a waiter not denied again for HEAVY_TTL_MS is dropped from the queue as stale, silently. An
 *    agent told "do not retry, you will be told" behind a long holder waited for a notice that
 *    never came;
 *  - a reservation left unused for HEAVY_RESERVE_MS lapses, and the agent was not told it had lost
 *    the slot and was no longer queued.
 * Both now send a notice, on the same two rails (mail + steer) as "HEAVY SLOT FREE". The lock's
 * semantics are unchanged: the same drops and lapses, at the same moments, in the same log rows.
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

test('GAP 1: a waiter dropped as stale is told it is no longer queued', () => {
  const { lock, clock, rows, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  assert.equal(lock.acquire('w', SUITE, 'npm test', 'w1', false).allow, false, 'queued #1');
  clock.t += HEAVY_TTL_MS - MIN;
  lock.acquire('holder', SUITE, 'npm test &', 'h2', true); // the holder's own re-entry keeps it fresh
  clock.t += 2 * MIN;
  lock.release('holder', 'process-exit');
  assert.deepEqual(rows.slice(-2).map((r) => [r.action, r.agentId, r.reason]), [['release', 'holder', 'process-exit'], ['queue-dropped', 'w', 'stale']]);
  assert.deepEqual(lapsed, [['w', 'suite', 'stale']]);
  assert.deepEqual(freed, [], 'no slot was reserved for it');
  assert.deepEqual(lock.queueSnapshot(), { waiters: [], reserved: [] }, 'the drop itself is unchanged');
});

test('Jim NIT 1: a stale waiter leaves the queue ON SCHEDULE while the holder still runs, is told once, and no display says QUEUED any more', async () => {
  const ACT = loadTs('src/shared/activityView.ts');
  const { lock, clock, rows, lapsed } = fakeLock();
  let changes = 0;
  lock.onChange(() => { changes++; });
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('w', SUITE, 'npm test', 'w1', false);
  clock.t += HEAVY_TTL_MS / 2;
  lock.acquire('holder', SUITE, 'npm test &', 'h2', true); // the holder's re-entry keeps its own TTL fresh
  clock.t += HEAVY_TTL_MS / 2 - 1;
  assert.equal(lock.queueSnapshot().waiters.length, 1, 'not yet');
  assert.deepEqual(lapsed, []);
  clock.t += 1;
  const before = changes;
  await lock.scan(); // the watcher's tick (armed while the slot is held); no slot frees
  assert.deepEqual(rows.at(-1), { kind: 'heavy-lock', action: 'queue-dropped', agentId: 'w', reason: 'stale' });
  assert.equal(changes - before, 1, 'one change: the displays repaint');
  assert.deepEqual(lapsed, [['w', 'suite', 'stale']]);
  const view = { holders: lock.snapshot(), ...lock.queueSnapshot() };
  assert.deepEqual(view.waiters, []);
  assert.equal(ACT.heavyActivity('w', view), null, 'no QUEUED #n for an agent the lock will never serve');
  assert.equal(ACT.heavyActivity('holder', view).state, 'background', 'the holder is untouched');
  lock.snapshot();
  assert.equal(lapsed.length, 1, 'told once');
  // A re-deny before the hour restarts it, as before: no drop.
  lock.acquire('v', SUITE, 'npm test', 'v1', false);
  clock.t += HEAVY_TTL_MS - MIN;
  lock.acquire('v', SUITE, 'npm test', 'v2', false);
  clock.t += 2 * MIN;
  lock.queueSnapshot();
  assert.ok(!rows.some((r) => r.action === 'queue-dropped' && r.agentId === 'v'), 'v is not dropped');
  assert.deepEqual(lapsed.filter((l) => l[0] === 'v'), []);
});

test('GAP 2: a reservation that lapses unused tells its agent it lost the slot', () => {
  const { lock, clock, rows, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('w', SUITE, 'npm test', 'w1', false);
  lock.release('holder', 'process-exit');
  assert.equal(freed.length, 1, 'HEAVY SLOT FREE as before');
  clock.t += HEAVY_RESERVE_MS;
  lock.queueSnapshot(); // the watcher (or any read) expires it
  assert.equal(rows.at(-1).action, 'reserve-expired');
  assert.deepEqual(lapsed, [['w', 'suite', 'expired']]);
  // Once only: a later read does not re-tell it.
  lock.snapshot();
  clock.t += MIN;
  lock.queueSnapshot();
  assert.equal(lapsed.length, 1);
});

test('the lapse passes the slot on as before: the next waiter is reserved and told HEAVY SLOT FREE', () => {
  const { lock, clock, freed, lapsed } = fakeLock();
  lock.acquire('holder', SUITE, 'npm test &', 'h1', true);
  lock.acquire('a', SUITE, 'npm test', 'a1', false);
  lock.acquire('b', SUITE, 'npm test', 'b1', false);
  lock.release('holder', 'process-exit');
  clock.t += HEAVY_RESERVE_MS;
  lock.queueSnapshot();
  assert.deepEqual(lapsed, [['a', 'suite', 'expired']]);
  assert.deepEqual(freed.map((f) => f[0]), ['a', 'b']);
  assert.deepEqual(lock.queueSnapshot().reserved.map((r) => r.agentId), ['b']);
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
  // A stale waiter whose own acquire triggers the drop: its acquire answers it.
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
    lock.acquire('w', SUITE, 'npm test', 'w2', false);
    assert.ok(rows.some((r) => r.action === 'queue-dropped' && r.agentId === 'w' && r.reason === 'stale'));
    assert.deepEqual(lapsed, [], 'w is not told about its own drop');
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
  assert.match(idx, /function notifyHeavyWaitLapsed\(agentId: string, kind: string, why: 'stale' \| 'expired'\): void \{\s*const n = heavyWaitLapsedNotice\(agentId, kind, why\);\s*try \{ hive\.send\(n\.message as Partial<HiveMessage>, n\.from\); \} catch \{ \/\* best effort \*\/ \}\s*try \{ control\.steer\(agentId, n\.steer\); \} catch \{ \/\* best effort \*\/ \}\s*\}/);
});
