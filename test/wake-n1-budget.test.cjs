'use strict';
/**
 * ZT-I1-MAIL 1.1.75, layer-b dry run #4 (god-approved): the wake re-offer budget and N1.
 *
 * N1 (§11.17) confirms a surfacing on the latency rule alone once an id had
 * MAIL_UNCONFIRMED_FALLBACK_AFTER (2) consecutive unconfirmed surfacings, i.e. on the THIRD. The
 * §11.3 re-pend budget re-offered an id ONCE, then sent it to the F4 backoff (5 min): so the one
 * surfacing that would confirm waited 5 minutes on an idle agent. Now:
 *  (i)  an id the ledger says is N1-due gets exactly ONE extra immediate re-offer (n1Reoffered),
 *       then F4 as before (a transport that stays late still backs off);
 *  (ii) reconcile() KEEPS the re-offer state for ids still OPEN in the ledger (surfacing,
 *       surfaced): a beat inside the short surfacing window no longer resets the budget, so
 *       nothing about the 5-minute wait depends on beat timing (dry runs #3/#4: B1 reached acted
 *       only because a beat landed there; B2 did not and stalled).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const W = loadTs('src/main/workerWake.ts');
const { WorkerWakeWatchdog, wakeRetryDelayMs } = W;
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const L = loadTs('src/main/mailLedger.ts');

const facts = (agentId, now) => ({ agentId, ptyId: `p-${agentId}`, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });

/** One wake round: the id is delivered, claimed and COMMITTED, then (optionally) a beat runs while
 *  it is surfacing, and its epoch closes with the id back to delivered (an N1 back-edge). */
function round(c, now, { beatWhileSurfacing = false, n1Due = [] } = {}) {
  c.reconcile('cl', ['m1']);
  const claim = c.claim(facts('cl', now), 'reconcile', 'reconcile', now);
  assert.ok(claim, 'claimed');
  c.settle(claim, 'COMMITTED', now, false);
  if (beatWhileSurfacing) c.reconcile('cl', [], ['m1']);     // surfacing: open, not delivered
  const r = c.repend('cl', ['m1'], now + 1000, { turnEnded: true, n1Due });
  c.noteHook('cl', 'Stop', '', now + 1000);
  return r;
}

test('(i) worker-wake: an N1-due id gets exactly ONE extra immediate re-offer, then the F4 backoff', () => {
  const c = new WorkerWakeWatchdog();
  let now = 5_000_000;
  const r1 = round(c, now);
  assert.deepEqual([r1.requeued, r1.exhausted], [['m1'], []], 'the §11.3 once-re-pend (unconfirmed surfacing 1)');
  now += 70_000;
  const r2 = round(c, now, { n1Due: ['m1'] });               // unconfirmed surfacing 2: N1 threshold reached
  assert.deepEqual(r2.requeued, ['m1'], 'THE FIX: re-offered at once, so the N1-confirming surfacing happens now');
  assert.deepEqual(r2.n1, ['m1']);
  assert.deepEqual(r2.exhausted, []);
  assert.equal(r2.retryInMs, 0, 'no 5-minute backoff');
  now += 70_000;
  const r3 = round(c, now, { n1Due: ['m1'] });               // still unconfirmed (e.g. late): bounded
  assert.deepEqual([r3.requeued, r3.exhausted, r3.n1], [[], ['m1'], []], 'only ONE extra re-offer per id; then F4');
  assert.equal(r3.retryInMs, wakeRetryDelayMs(1));
});

test('(i) worker-wake: without n1Due nothing changes (once, then F4)', () => {
  const c = new WorkerWakeWatchdog();
  let now = 6_000_000;
  assert.deepEqual(round(c, now).requeued, ['m1']);
  now += 70_000;
  const r2 = round(c, now);
  assert.deepEqual([r2.requeued, r2.exhausted, r2.n1], [[], ['m1'], []]);
  assert.equal(r2.retryInMs, wakeRetryDelayMs(1));
});

test('(ii) worker-wake: a reconcile beat DURING surfacing does not reset the re-offer state (budget independent of beat timing)', () => {
  const c = new WorkerWakeWatchdog();
  let now = 7_000_000;
  assert.deepEqual(round(c, now, { beatWhileSurfacing: true }).requeued, ['m1']);
  now += 70_000;
  const r2 = round(c, now, { beatWhileSurfacing: true });
  assert.deepEqual([r2.requeued, r2.exhausted], [[], ['m1']], 'the once-budget survived the beat: exhausted, as without the beat');
  // And the N1 extra re-offer is not refreshed by a beat either.
  const d = new WorkerWakeWatchdog();
  now = 8_000_000;
  round(d, now, { beatWhileSurfacing: true });
  now += 70_000;
  assert.deepEqual(round(d, now, { beatWhileSurfacing: true, n1Due: ['m1'] }).n1, ['m1']);
  now += 70_000;
  const r3 = round(d, now, { beatWhileSurfacing: true, n1Due: ['m1'] });
  assert.deepEqual([r3.requeued, r3.exhausted], [[], ['m1']], 'n1Reoffered survived the beat');
  // After F4 the id stays known (no re-pend by a beat) while it waits out the backoff.
  d.reconcile('cl', ['m1'], []);
  assert.equal(d.claim(facts('cl', now + 80_000), 'reconcile', 'reconcile', now + 80_000), null, 'no claim during the backoff');
});

test('(ii) worker-wake: ids that LEFT the ledger\'s open set (acted, gone) are still forgotten', () => {
  const c = new WorkerWakeWatchdog();
  const now = 9_000_000;
  round(c, now);
  c.reconcile('cl', [], []);                                 // acted: neither delivered nor open
  c.reconcile('cl', ['m1'], []);                             // the same id delivered again later (a new life)
  const claim = c.claim(facts('cl', now + 80_000), 'reconcile', 'reconcile', now + 80_000);
  assert.ok(claim, 'fresh pending');
  c.settle(claim, 'COMMITTED', now + 80_000, false);
  assert.deepEqual(c.repend('cl', ['m1'], now + 81_000, { turnEnded: true }).requeued, ['m1'], 'a fresh once-budget');
});

test('(i) inbox-wake-bridge: onMailEpochClosed reads the ledger\'s N1-due ids, re-offers at once and schedules the wake; no wake-ids-exhausted', () => {
  const coordinator = new WorkerWakeWatchdog();
  const queue = [];
  const diags = [];
  let now = 10_000_000;
  const delivered = { cl: ['m1'] };
  const n1Due = { cl: [] };
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: (a) => delivered[a] ?? [],
    facts: (a) => ({ ptyId: `p-${a}`, lastOutputAt: now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
    submit: () => Promise.resolve({ kind: 'COMMITTED' }),
    text: (ids) => ids.join(','),
    setImmediate: (fn) => queue.push(fn),
    now: () => now,
    diag: (stage, fields) => diags.push({ stage, ...fields }),
    mail: { mode: () => 'inject', closeTurn() {}, abortSince() {}, closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false, n1DueIds: (a) => n1Due[a] ?? [], openIds: () => ['m1'] }
  });
  const commit = () => {
    coordinator.reconcile('cl', delivered.cl);
    const claim = coordinator.claim(facts('cl', now), 'reconcile', 'reconcile', now);
    assert.ok(claim);
    coordinator.settle(claim, 'COMMITTED', now, false);
  };
  commit();
  bridge.onMailEpochClosed('cl', 'normal', 'stop', ['m1']);
  coordinator.noteHook('cl', 'Stop', '', now);
  assert.equal(diags.filter((d) => d.stage === 'wake-repend').length, 1);
  now += 70_000;
  commit();
  n1Due.cl = ['m1'];                                         // the ledger: 2 unconfirmed surfacings
  const mark = diags.length;
  bridge.onMailEpochClosed('cl', 'normal', 'stop', ['m1']);
  const rep = diags.filter((d) => d.stage === 'wake-repend').pop();
  assert.deepEqual(rep.n1, ['m1'], 'the N1 re-offer is logged on the wake-repend row');
  assert.equal(rep.requeued, 1);
  assert.equal(diags.filter((d) => d.stage === 'wake-ids-exhausted').length, 0, 'no 5-minute backoff');
  assert.ok(diags.slice(mark).some((d) => d.stage === 'schedule' && d.cause === 'hook'), 'a wake is scheduled at once');
  // The bridge's own reconcile passes the ledger's open ids (the state survives a beat).
  const calls = [];
  const orig = coordinator.reconcile.bind(coordinator);
  coordinator.reconcile = (...a) => { calls.push(a); return orig(...a); };
  bridge.reconcileAll(['cl']);
  assert.deepEqual(calls[0], ['cl', ['m1'], ['m1']]);
});

test('ledger: n1DueIds = pending ids at the N1 threshold; openNotDeliveredIds = surfacing/surfaced', () => {
  const e = (id, state, n, extra = {}) => ({ id, state, unconfirmedSurfacings: n, seq: Number(id.slice(1)), setAsideAt: null, ...extra });
  const doc = { entries: { m1: e('m1', 'delivered', 2), m2: e('m2', 'delivered', 1), m3: e('m3', 'delivered', 3, { setAsideAt: 1 }), m4: e('m4', 'surfacing', 2), m5: e('m5', 'surfaced', 0), m6: e('m6', 'acted', 2) } };
  assert.equal(L.MAIL_UNCONFIRMED_FALLBACK_AFTER, 2);
  assert.deepEqual(L.n1DueIds(doc), ['m1']);
  assert.deepEqual(L.openNotDeliveredIds(doc).sort(), ['m4', 'm5']);
});

test('main wires the ledger into the bridge (n1DueIds, openIds), like the rig host and the mail-epochs floor', () => {
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /n1DueIds: \(agentId\) => hive\.mail\.n1Due\(agentId\),\s*openIds: \(agentId\) => hive\.mail\.openNotDelivered\(agentId\),/);
  const host = readSource('test/mail-rig/rig-host.cjs');
  assert.match(host, /n1DueIds: \(agentId\) => hive\.mail\.n1Due\(agentId\),\s*openIds: \(agentId\) => hive\.mail\.openNotDelivered\(agentId\),/);
});

test('Jim LOW N3: the N1 re-offer is really PENDING: the very next claim (no reconcile in between) carries the id', () => {
  const c = new WorkerWakeWatchdog();
  let now = 11_000_000;
  round(c, now);
  now += 70_000;
  const r2 = round(c, now, { n1Due: ['m1'] });
  assert.deepEqual(r2.n1, ['m1']);
  assert.deepEqual(c.state('cl').pending, ['m1'], 'back in pending');
  now += 70_000;
  const claim = c.claim(facts('cl', now), 'reconcile', 'reconcile', now);   // NO reconcile first
  assert.ok(claim, 'claimed at once');
  assert.deepEqual([...claim.ids], ['m1'], 'the N1-confirming surfacing is offered now');
});

test('Jim LOW N6: reconcile keeps the re-offer state of an OPEN id but NEVER keeps it pending', () => {
  const c = new WorkerWakeWatchdog();
  c.reconcile('cl', ['m1', 'm2'], []);
  assert.deepEqual(c.state('cl').pending, ['m1', 'm2']);
  c.reconcile('cl', ['m2'], ['m1']);                         // m1 is surfacing: open, not delivered
  assert.deepEqual(c.state('cl').pending, ['m2'], 'an open id is not pending (it is not deliverable)');
  // Also for an id that WAS announced (the state kept is the re-offer state, not pending).
  const now = 12_000_000;
  const claim = c.claim(facts('cl', now), 'reconcile', 'reconcile', now);
  c.settle(claim, 'COMMITTED', now, false);
  c.reconcile('cl', [], ['m2']);
  assert.deepEqual(c.state('cl').pending, []);
  assert.deepEqual(c.state('cl').announced, ['m2'], 'its announced state is kept');
});
