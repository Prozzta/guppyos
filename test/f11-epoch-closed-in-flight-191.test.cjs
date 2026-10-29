'use strict';
require('./tools/own-job.cjs');
/**
 * F11 (1.1.91 blocker, red since C1A1 @9378313c): a mail epoch closed while the claim that surfaced
 * it is still in flight.
 *
 * C1A1 made the Antigravity owner verify its submit (automaticVerifySubmit), so an AGY claim now stays
 * in flight for the composer reads after its Enter, as Codex's always has. In that window the claim's
 * typed turn starts and surfaces its ids (PreInvocation). If that epoch then closes without a Stop
 * (the 30-minute stale back-edge; mail-rig F11 moves the simulated clock under the flight, a real
 * machine does it with a sleep/resume), repend() re-offers nothing: it re-pends ANNOUNCED ids and
 * these were still in flight. The late settle(COMMITTED) then marked them announced and reopened an
 * active epoch: the redelivered mail was never woken again (every beat: no-pending-ids).
 *
 * Fix: the bridge tells the coordinator about the close (noteEpochClosed with the redelivered ids);
 * when they belong to the claim in flight, settle() treats its turn as ended, exactly like a Stop
 * before the settle (P1 case A), and the bridge runs the same repend() for them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WorkerWakeWatchdog, PROVIDER_IDLE_CONFIRM_MS } = loadTs('src/main/workerWake.ts');
const facts = (agentId, now) => ({ agentId, ptyId: `p-${agentId}`, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });

function claimed(c, agentId, now, ids = ['m1']) {
  c.reconcile(agentId, ids);
  const claim = c.claim(facts(agentId, now), 'reconcile', 'reconcile', now);
  assert.ok(claim, 'claimed');
  return claim;
}

// The coordinator's path is provider-neutral; Codex's claim stays in flight for its own submit check
// (automaticVerifySubmit), so it gets the same pin with its turn ids.
for (const [who, id, start, turnId] of [['AGY (no turn id)', 'ag', 'PreInvocation', undefined], ['Codex (turn ids)', 'cx', 'UserPromptSubmit', 'T1']]) {
  test(`F11 ${who}: the epoch its turn surfaced closes before the settle (no Stop) -> ended, re-offered once under a new request`, () => {
    const c = new WorkerWakeWatchdog();
    const t0 = 10_000_000;
    const claim = claimed(c, id, t0);
    c.noteHook(id, start, '', t0 + 1000, undefined, turnId);   // the typed turn starts and surfaces m1
    if (start === 'PreInvocation') c.noteHook(id, 'PostInvocation', '', t0 + 1500);
    // The stale close needs an idle lifecycle (closeStaleMail): the provider's idle reading, as in F11.
    const idleAt = t0 + 1000 + PROVIDER_IDLE_CONFIRM_MS;
    assert.equal(c.noteProviderStatus(id, 'idle', idleAt), true);
    assert.equal(c.state(id).lifecycle, 'idle');
    c.noteEpochClosed(id, ['m1'], 'stale-epoch');                            // the stale back-edge: no Stop ever came
    assert.deepEqual(c.settle(claim, 'COMMITTED', idleAt + 1000, true), { endedBeforeSettle: true });
    assert.equal(c.state(id).lifecycle, 'idle', 'no epoch reopened for a turn the mail already gave up on');
    assert.deepEqual(c.repend(id, ['m1'], idleAt + 1010, { turnEnded: true }).requeued, ['m1'], 'm1 back to pending');
    assert.deepEqual(c.repend(id, ['m1'], idleAt + 1020, { turnEnded: true }).requeued, [], 'spent once');
    const again = c.claim(facts(id, idleAt + 2000), 'hook', 'event', idleAt + 2000);
    assert.ok(again, 're-offered');
    assert.deepEqual([...again.ids], ['m1']);
    assert.notEqual(again.requestId, claim.requestId, 'a new request (typed, not replayed)');
  });
}

// Jim SHOULD-1: a close at a new prompt (hooks.ts UserPromptSubmit: 'interrupted' or 'next-turn')
// re-surfaces its ids IN that live turn, so the claim's turn is not over and its mail is carried.
for (const [who, id, start, turnId] of [['AGY', 'ag', 'PreInvocation', undefined], ['Codex', 'cx', 'UserPromptSubmit', 'T1']]) {
  for (const reason of ['interrupted', 'next-turn']) {
    test(`F11 / Jim SHOULD-1 ${who}: an '${reason}' close of the claim's epoch while in flight -> not ended, active, nothing re-pended`, () => {
      const c = new WorkerWakeWatchdog();
      const t0 = 60_000_000;
      const claim = claimed(c, id, t0);
      c.noteHook(id, start, '', t0 + 1000, undefined, turnId);
      c.noteEpochClosed(id, ['m1'], reason);                  // a person typed: the new turn carries m1
      assert.deepEqual(c.repend(id, ['m1'], t0 + 1500, { turnEnded: false }).requeued, [], 'the close\'s own repend: m1 stays with the live turn');
      assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 2000, true), { endedBeforeSettle: false });
      assert.equal(c.state(id).lifecycle, 'active');
      assert.deepEqual(c.state(id).pending, []);
    });
  }
}

test('F11 / Jim SHOULD-1 via the bridge: an interrupted close in flight re-pends nothing; a stale one re-offers the claim\'s ids', async () => {
  const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
  for (const reason of ['interrupted', 'stale-epoch']) {
    const coordinator = new WorkerWakeWatchdog();
    const diags = [];
    let now = 80_000_000;
    const unsettled = [];
    const bridge = new InboxWakeBridge({
      coordinator,
      inboxIds: () => ['X'],
      facts: (a) => ({ ptyId: `p-${a}`, lastOutputAt: now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
      submit: () => new Promise((res) => unsettled.push(() => res({ kind: 'COMMITTED' }))),
      text: (ids) => ids.join(','),
      setImmediate: () => {},
      now: () => now,
      diag: (stage, fields) => diags.push({ stage, ...fields }),
      confirmsTurnStart: () => true,
      mail: { mode: () => 'inject', closeTurn() {}, abortSince() {}, closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false, n1DueIds: () => [], openIds: () => [] }
    });
    assert.ok(bridge.requestInboxWake('cx', 'reconcile', 'reconcile'));
    await new Promise((r) => setImmediate(r));
    now += 1000; coordinator.noteHook('cx', 'UserPromptSubmit', '', now, undefined, 'T1');   // the wake's turn surfaces X
    now += 500; bridge.onMailEpochClosed('cx', 'abnormal', reason, ['X']);                   // still in flight
    now += 500; while (unsettled.length) unsettled.shift()();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const repends = diags.filter((d) => d.stage === 'wake-repend');
    if (reason === 'interrupted') {
      assert.deepEqual(repends, [], 'the re-surfaced X is not re-pended');
      assert.deepEqual(coordinator.state('cx').pending, []);
      assert.equal(coordinator.state('cx').lifecycle, 'active');
    } else {
      assert.deepEqual(repends.map((d) => [d.reason, d.idList]), [['stop-before-settle', ['X']]], 'the stale close re-offers X once');
    }
  }
});

test('F11 control: an epoch with NONE of the in-flight ids closes (an older one) -> the claim\'s turn is still running: active', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 20_000_000;
  const claim = claimed(c, 'ag', t0);
  c.noteHook('ag', 'PreInvocation', '', t0 + 1000);
  c.noteEpochClosed('ag', ['m0'], 'stale-epoch');
  assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 2000, true), { endedBeforeSettle: false });
  assert.equal(c.state('ag').lifecycle, 'active');
});

test('F11 control: a close before any turn start of the claim -> not ended (P1 case B stays on the provisional path)', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 30_000_000;
  const claim = claimed(c, 'ag', t0);
  c.noteEpochClosed('ag', ['m1'], 'stale-epoch');
  assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 2000, true), { endedBeforeSettle: false });
});

test('F11 control: a close with no claim in flight marks nothing, and a close never carries over to the next claim', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 40_000_000;
  c.noteEpochClosed('ag', ['m1'], 'stale-epoch');
  const first = claimed(c, 'ag', t0);
  c.noteHook('ag', 'PreInvocation', '', t0 + 1000);
  assert.deepEqual(c.settle(first, 'COMMITTED', t0 + 2000, true), { endedBeforeSettle: false }, 'the close came before this claim');
  const d = new WorkerWakeWatchdog();
  const second = claimed(d, 'ag', t0);
  d.noteEpochClosed('ag', ['m1'], 'stale-epoch');
  d.settle(second, 'FAILED', t0 + 500, false);              // released: m1 is pending again
  const t1 = t0 + 120_000;                                  // past the reconcile cooldown
  const third = d.claim(facts('ag', t1), 'reconcile', 'reconcile', t1);
  assert.ok(third, 're-claimed');
  d.noteHook('ag', 'PreInvocation', '', t1 + 500);
  assert.deepEqual(d.settle(third, 'COMMITTED', t1 + 1000, true), { endedBeforeSettle: false }, 'the close was the earlier claim\'s');
});

test('F11 wiring: the bridge reports the close (with its redelivered ids) before the repend', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', 'inboxWakeBridge.ts'), 'utf8');
  const i = src.indexOf('if (redelivered.length) this.deps.coordinator.noteEpochClosed(agentId, redelivered, reason);');
  assert.ok(i > 0 && i < src.indexOf('const r = this.deps.coordinator.repend(agentId, delivered'), 'noteEpochClosed precedes repend in onMailEpochClosed');
});
