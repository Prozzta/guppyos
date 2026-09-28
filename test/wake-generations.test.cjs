'use strict';
/**
 * ZT-I1-MAIL 1.1.75 (layer-b dry run #2, god c59e35): a wake claim's request id is
 * `<base>:<generation>`. The owner (automaticSubmit) delivers a request id AT MOST ONCE and replays a
 * remembered COMMITTED without typing, so every NEW announcement of the same id set must carry a NEW
 * id, however the set came back (re-pend at Stop, the N1 back-edge, an unconfirmed submit, an F4
 * retry), and even when reconcile() dropped the id while it was surfacing. A GENUINE duplicate (the
 * same claim asked again while in flight) mints nothing: it keeps its id, and the owner dedups it
 * (test/automatic-submit.test.cjs replayAfterCommitWritesNoSecondEnter / replayInFlightSharesOneTransaction).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const W = loadTs('src/main/workerWake.ts');
const { WorkerWakeWatchdog, inboxWakeRequestId, inboxWakeClaimId, WAKE_GENERATION_MEMORY, SUBMIT_CONFIRM_MS } = W;

const facts = (agentId, now) => ({ agentId, ptyId: `p-${agentId}`, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });

test('the id format: <base>:<generation>, base = the sorted id set', () => {
  assert.equal(inboxWakeClaimId('a', ['m2', 'm1'], 0), `${inboxWakeRequestId('a', ['m1', 'm2'])}:0`);
  assert.notEqual(inboxWakeClaimId('a', ['m1'], 0), inboxWakeClaimId('a', ['m1'], 1));
  assert.notEqual(inboxWakeClaimId('a', ['m1'], 0), inboxWakeClaimId('b', ['m1'], 0));
});

test('ids DIFFER per generation: every re-announcement of the same set (Stop re-pend, unconfirmed submit, F4 retry) gets the next generation', () => {
  const c = new WorkerWakeWatchdog();
  let now = 1_000_000;
  c.reconcile('dw', ['m1']);
  const ids = [];
  const claimAndCommit = () => {
    const claim = c.claim(facts('dw', now), 'reconcile', 'reconcile', now);
    assert.ok(claim, 'claimed');
    ids.push(claim.requestId);
    c.settle(claim, 'COMMITTED', now, true);
  };
  claimAndCommit();                                          // gen 0
  now += SUBMIT_CONFIRM_MS;
  assert.equal(c.beat('dw', now).kind, 'submit-unconfirmed');
  now += 20_000;
  claimAndCommit();                                          // gen 1
  now += SUBMIT_CONFIRM_MS;
  const edge = c.beat('dw', now);
  assert.equal(edge.kind, 'wake-ids-exhausted');
  now += edge.retryInMs;
  c.reconcile('dw', ['m1']);
  assert.equal(c.beat('dw', now).kind, 'wake-retry');
  now += 20_000;
  claimAndCommit();                                          // gen 2
  assert.deepEqual(ids.map((i) => i.split(':').pop()), ['0', '1', '2']);
  assert.equal(new Set(ids).size, 3, 'never an id twice');
  assert.ok(ids.every((i) => i.startsWith(inboxWakeRequestId('dw', ['m1']) + ':')));
});

test('THE DRY-RUN BUG: reconcile() dropping the id while it is surfacing (and forget()) never resets the generation', () => {
  const c = new WorkerWakeWatchdog();
  let now = 2_000_000;
  const seen = [];
  const round = () => {
    c.reconcile('cl', ['m1']);                               // delivered again (the N1 back-edge)
    const claim = c.claim(facts('cl', now), 'reconcile', 'reconcile', now);
    assert.ok(claim, 'claimed');
    seen.push(claim.requestId);
    c.settle(claim, 'COMMITTED', now, false);
    c.reconcile('cl', []);                                   // surfacing: not in the delivered set
    c.noteHook('cl', 'Stop', '', now + 1000);               // the turn ends; the id comes back next round
    now += 70_000;
  };
  round(); round(); round();
  c.forget('cl', 'p-cl');                                    // the agent leaves the floor and comes back
  round();
  assert.deepEqual(seen.map((i) => i.split(':').pop()), ['0', '1', '2', '3'], 'a fresh generation every time');
  assert.equal(new Set(seen).size, 4);
});

test('a GENUINE same-generation duplicate mints nothing: the claim in flight is not claimed again, and it keeps its id', () => {
  const c = new WorkerWakeWatchdog();
  const now = 3_000_000;
  c.reconcile('x', ['m1']);
  const claim = c.claim(facts('x', now), 'reconcile', 'reconcile', now);
  assert.ok(claim);
  assert.equal(c.claim(facts('x', now + 1), 'reconcile', 'reconcile', now + 1), null, 'no second claim while in flight');
  assert.equal(c.state('x').inFlight.requestId, claim.requestId, 'the same claim, the same id: the owner dedups a re-ask');
  assert.ok(claim.requestId.endsWith(':0'));
  // Different id SETS never share a generation counter.
  const c2 = new WorkerWakeWatchdog();
  c2.reconcile('y', ['a']);
  const ca = c2.claim(facts('y', now), 'reconcile', 'reconcile', now);
  c2.settle(ca, 'COMMITTED', now, false);
  c2.noteHook('y', 'Stop', '', now + 1000);
  c2.reconcile('y', ['a', 'b']);
  const cb = c2.claim(facts('y', now + 70_000), 'reconcile', 'reconcile', now + 70_000);
  assert.ok(ca.requestId.endsWith(':0') && cb && cb.requestId.endsWith(':0'), 'a new set starts at 0');
});

test('the generation memory is bounded per agent (oldest id set dropped first)', () => {
  assert.equal(WAKE_GENERATION_MEMORY, 512);
  const c = new WorkerWakeWatchdog();
  let now = 4_000_000;
  for (let i = 0; i < WAKE_GENERATION_MEMORY + 5; i++) {
    c.reconcile('z', [`m${i}`]);
    const claim = c.claim(facts('z', now), 'reconcile', 'reconcile', now);
    assert.ok(claim, 'claimed');
    c.settle(claim, 'COMMITTED', now, false);
    c.reconcile('z', []);
    c.noteHook('z', 'Stop', '', now + 1000);
    now += 70_000;
  }
  assert.ok(c.generations.get('z').size <= WAKE_GENERATION_MEMORY);
});
