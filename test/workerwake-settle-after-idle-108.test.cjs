'use strict';
require('./tools/own-job.cjs');

/**
 * WORKERWAKE-SETTLE-AFTER-IDLE-DROP (1.1.108): DEFER, NEVER DROP must hold when the owner's
 * COMMITTED lands AFTER the idle tick.
 *
 * The order on the floor (AGY, a short turn; the submit check takes longer than the turn):
 *   claim -> the provider's turn start (a hook, or a `running` reading) opens the epoch
 *         -> an `idle` reading inside the confirm grace: deferred (pendingIdleAt)
 *         -> settle(COMMITTED): re-opened the epoch from its own time AND forgot the deferred idle.
 * AGY is silent while idle and the epoch is confirmed (so no submit-unconfirmed either): nothing
 * closed it, and the worker was held until the 30-min back-edge.
 *
 * The rule pinned here: a settle keeps a deferred idle that is about the claim's OWN turn (read
 * at or after a turn start that came after the claim). It still forgets one that is not: an idle
 * older than the newest turn start, or one read when no turn had started since the claim (the
 * grace's own case: agy still rendering `idle` for the turn before our prompt).
 *
 * The coordinator is REAL; the clock is the caller's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WorkerWakeWatchdog, PROVIDER_IDLE_CONFIRM_MS, SUBMIT_CONFIRM_MS } = loadTs('src/main/workerWake.ts');

const T0 = Date.parse('2026-11-19T19:30:00.000Z');
const fact = (agentId, over = {}) => ({ agentId, ptyId: `pty-${agentId}`, lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false, ...over });

/** An idle worker with one delivered message, claimed at T0. `confirms` (AGY reports its turn starts) is on. */
function claimed() {
  const c = new WorkerWakeWatchdog();
  c.noteHook('p', 'Stop', undefined, T0 - 60_000, true);
  c.noteDelivery('p', 'm1');
  const claim = c.claim(fact('p'), 'hook', 'event', T0);
  assert.ok(claim, `claimed (was: ${c.whyNoClaim('p')})`);
  return { c, claim };
}
const SETTLE = T0 + 1500;

test('a settle AFTER the deferred idle keeps it: the first beat after the grace closes the epoch (turn start by hook)', () => {
  const { c, claim } = claimed();
  c.noteHook('p', 'PreInvocation', undefined, T0 + 300);
  c.noteHook('p', 'PostInvocation', undefined, T0 + 800);
  assert.equal(c.noteProviderStatus('p', 'idle', T0 + 1000), false, 'inside the grace: deferred');
  assert.deepEqual(c.settle(claim, 'COMMITTED', SETTLE, true), { endedBeforeSettle: false });
  assert.equal(c.state('p').lifecycle, 'active', 'the settle itself closes nothing');
  assert.equal(c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS - 1), null, 'the grace runs from the settle (the epoch edge)');
  assert.deepEqual(c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' }, 'DEFER, NEVER DROP');
  assert.equal(c.state('p').lifecycle, 'idle');
  assert.equal(c.beat('p', SETTLE + 20_000), null, 'applied once');
  assert.equal(c.beat('p', SETTLE + SUBMIT_CONFIRM_MS), null, 'and the turn was confirmed: no submit-unconfirmed');
});

test('the same when the turn start was a `running` reading (no hook)', () => {
  const { c, claim } = claimed();
  c.noteProviderStatus('p', 'running', T0 + 300);
  assert.equal(c.noteProviderStatus('p', 'idle', T0 + 1000), false, 'inside the grace: deferred');
  c.settle(claim, 'COMMITTED', SETTLE, true);
  assert.equal(c.state('p').lifecycle, 'active');
  assert.deepEqual(c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' });
  assert.equal(c.state('p').lifecycle, 'idle');
  // Boundary: an idle read in the SAME millisecond as the turn start is not older than it
  // (turnStarted() itself only clears a deferred idle that is strictly older).
  const same = claimed();
  same.c.noteProviderStatus('p', 'running', T0 + 300);
  same.c.noteProviderStatus('p', 'idle', T0 + 300);
  same.c.settle(same.claim, 'COMMITTED', SETTLE, true);
  assert.deepEqual(same.c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' });
});

test('the kept idle still obeys the deferral\'s own rules: held mid-invocation, and overtaken by anything newer', () => {
  // Mid-invocation (PreInvocation without its PostInvocation): not applied until the call ends.
  const mid = claimed();
  mid.c.noteHook('p', 'PreInvocation', undefined, T0 + 300);
  mid.c.noteProviderStatus('p', 'idle', T0 + 1000);
  mid.c.settle(mid.claim, 'COMMITTED', SETTLE, true);
  assert.equal(mid.c.beat('p', SETTLE + 20_000), null, 'a model call is running: no idle mid-turn');
  assert.equal(mid.c.state('p').lifecycle, 'active');
  mid.c.noteHook('p', 'PostInvocation', undefined, SETTLE + 21_000);
  assert.deepEqual(mid.c.beat('p', SETTLE + 30_000), { kind: 'deferred-idle' }, 'released by PostInvocation');

  const setup = () => {
    const w = claimed();
    w.c.noteHook('p', 'PreInvocation', undefined, T0 + 300);
    w.c.noteHook('p', 'PostInvocation', undefined, T0 + 800);
    w.c.noteProviderStatus('p', 'idle', T0 + 1000);
    w.c.settle(w.claim, 'COMMITTED', SETTLE, true);
    return w.c;
  };
  const a = setup();
  a.noteProviderStatus('p', 'running', SETTLE + 500);
  assert.equal(a.beat('p', SETTLE + 20_000), null);
  assert.equal(a.state('p').lifecycle, 'active', 'a newer running reading overtakes the kept idle');
  const b = setup();
  b.noteHook('p', 'PreInvocation', undefined, SETTLE + 500);
  b.noteHook('p', 'PostInvocation', undefined, SETTLE + 900);
  assert.equal(b.beat('p', SETTLE + 20_000), null);
  assert.equal(b.state('p').lifecycle, 'active', 'so does a turn-start hook');
});

test('a settle still forgets a deferred idle that is OLDER than the claim\'s newest turn start', () => {
  const { c, claim } = claimed();
  c.noteProviderStatus('p', 'running', T0 + 300);
  c.noteProviderStatus('p', 'running', T0 + 2000);
  // Read at +1000, received after the +2000 reading (each tick is its own shim process).
  assert.equal(c.noteProviderStatus('p', 'idle', T0 + 1000), false);
  c.settle(claim, 'COMMITTED', T0 + 2500, true);
  assert.equal(c.beat('p', T0 + 2500 + PROVIDER_IDLE_CONFIRM_MS), null, 'the turn was running after that idle was read');
  assert.equal(c.beat('p', T0 + 2500 + 20_000), null);
  assert.equal(c.state('p').lifecycle, 'active');
});

test('a settle still forgets a deferred idle read when NO turn had started since the claim (it is about the turn before)', () => {
  const { c, claim } = claimed();
  // A `running` reading dated before the claim, received late: it opens an epoch but is no
  // turn start of this claim. agy then still renders `idle` until it has taken our prompt.
  c.noteProviderStatus('p', 'running', T0 - 500);
  assert.equal(c.state('p').lifecycle, 'active');
  assert.equal(c.noteProviderStatus('p', 'idle', T0 + 200), false, 'inside the grace: deferred');
  const AT = T0 + 600;
  c.settle(claim, 'COMMITTED', AT, true);
  assert.equal(c.beat('p', AT + PROVIDER_IDLE_CONFIRM_MS), null, 'not about our turn: forgotten');
  assert.equal(c.beat('p', AT + 20_000), null);
  assert.equal(c.state('p').lifecycle, 'active');
  // Unconfirmed, so the submit-confirm bound (not a stale idle) is what speaks next.
  assert.equal(c.beat('p', AT + SUBMIT_CONFIRM_MS)?.kind, 'submit-unconfirmed');
});

// WORKERWAKE-IDLE-READ-BEFORE-SETTLE-ARRIVES-AFTER (1.1.108): the same reading, the other arrival
// order. Each status tick is its own shim process, so an idle READ before the settle can ARRIVE
// after it. The settle has then already moved the epoch edge past the reading, and the ordering
// rule refused it outright: nothing was deferred, AGY said nothing more, and the worker was held
// as in the case above. The rule is the settle's own: a reading about the claim's OWN turn (read
// at or after a turn start that came after the claim) is kept and applied by the first beat after
// the grace; any other one is refused as before. It holds only while the edge IS the settle's.

/** claim -> `starts` (the turn starts, by `running` readings) -> settle at `at` -> the idle read at `idleAt` arrives. */
function lateIdle(starts, at, idleAt) {
  const w = claimed();
  for (const s of starts) w.c.noteProviderStatus('p', 'running', s);
  w.c.settle(w.claim, 'COMMITTED', at, true);
  assert.equal(w.c.noteProviderStatus('p', 'idle', idleAt), false, 'older than the edge: it closes nothing by itself');
  assert.equal(w.c.state('p').lifecycle, 'active');
  return w.c;
}

test('an idle read BEFORE the settle that arrives AFTER it is kept: the first beat after the grace closes the epoch', () => {
  const c = lateIdle([T0 + 300], SETTLE, T0 + 1000);
  assert.equal(c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS - 1), null, 'the grace runs from the settle (the epoch edge)');
  assert.deepEqual(c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' }, 'DEFER, NEVER DROP');
  assert.equal(c.state('p').lifecycle, 'idle');
  assert.equal(c.beat('p', SETTLE + 20_000), null, 'applied once');
  assert.equal(c.beat('p', SETTLE + SUBMIT_CONFIRM_MS), null, 'and the turn was confirmed: no submit-unconfirmed');
  // The turn start by hook, and the boundary: read in the SAME millisecond as the turn start.
  const hook = claimed();
  hook.c.noteHook('p', 'PreInvocation', undefined, T0 + 300);
  hook.c.noteHook('p', 'PostInvocation', undefined, T0 + 800);
  hook.c.settle(hook.claim, 'COMMITTED', SETTLE, true);
  assert.equal(hook.c.noteProviderStatus('p', 'idle', T0 + 1000), false);
  assert.deepEqual(hook.c.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' });
  const same = lateIdle([T0 + 300], SETTLE, T0 + 300);
  assert.deepEqual(same.beat('p', SETTLE + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' });
});

test('the late idle obeys the deferral\'s own rules: anything newer saying active overtakes it', () => {
  const a = lateIdle([T0 + 300], SETTLE, T0 + 1000);
  a.noteProviderStatus('p', 'running', SETTLE + 500);
  assert.equal(a.beat('p', SETTLE + 20_000), null);
  assert.equal(a.state('p').lifecycle, 'active', 'a newer running reading overtakes it');
  const b = lateIdle([T0 + 300], SETTLE, T0 + 1000);
  b.noteHook('p', 'PreInvocation', undefined, SETTLE + 500);
  assert.equal(b.beat('p', SETTLE + 20_000), null, 'a model call is running: no idle mid-turn');
  b.noteHook('p', 'PostInvocation', undefined, SETTLE + 900);
  assert.equal(b.beat('p', SETTLE + 20_000), null);
  assert.equal(b.state('p').lifecycle, 'active', 'so does a turn-start hook');
});

test('a late idle OLDER than the claim\'s newest turn start is still refused', () => {
  const c = lateIdle([T0 + 300, T0 + 2000], T0 + 2500, T0 + 1000);
  assert.equal(c.beat('p', T0 + 2500 + PROVIDER_IDLE_CONFIRM_MS), null, 'the turn was running after that idle was read');
  assert.equal(c.beat('p', T0 + 2500 + 20_000), null);
  assert.equal(c.state('p').lifecycle, 'active');
});

test('a late idle read when NO turn had started since the claim is still refused (it is about the turn before)', () => {
  // The `running` reading is dated before the claim: it opens an epoch but is no turn start of this claim.
  const AT = T0 + 600;
  const c = lateIdle([T0 - 500], AT, T0 + 200);
  assert.equal(c.beat('p', AT + PROVIDER_IDLE_CONFIRM_MS), null, 'not about our turn: refused');
  assert.equal(c.beat('p', AT + 20_000), null);
  assert.equal(c.state('p').lifecycle, 'active');
  assert.equal(c.beat('p', AT + SUBMIT_CONFIRM_MS)?.kind, 'submit-unconfirmed', 'the submit-confirm bound speaks next');
});

test('a late idle older than an edge that is NOT the settle\'s is still refused (a compaction opened after the turn ended)', () => {
  const { c, claim } = claimed();
  c.noteProviderStatus('p', 'running', T0 + 300);
  c.settle(claim, 'COMMITTED', SETTLE, true);
  assert.equal(c.noteHook('p', 'Stop', undefined, T0 + 3000, true), true, 'the turn ends');
  assert.equal(c.state('p').lifecycle, 'idle');
  c.noteHook('p', 'PreCompact', undefined, T0 + 9000);
  assert.equal(c.state('p').lifecycle, 'active', 'a compaction epoch: its edge is the PreCompact');
  // Read after the claim's turn start, before this edge; it says nothing about the compaction.
  assert.equal(c.noteProviderStatus('p', 'idle', T0 + 8000), false);
  assert.equal(c.beat('p', T0 + 9000 + PROVIDER_IDLE_CONFIRM_MS), null, 'not deferred: the compaction is not closed by it');
  assert.equal(c.beat('p', T0 + 9000 + 20_000), null);
  assert.equal(c.state('p').lifecycle, 'active');
  // Nor is it remembered when it arrives after the settle's epoch has CLOSED (the Stop leaves the
  // spent edge in place): the next epoch, here a compaction, must not inherit it.
  const late = claimed();
  late.c.noteProviderStatus('p', 'running', T0 + 300);
  late.c.settle(late.claim, 'COMMITTED', SETTLE, true);
  assert.equal(late.c.noteHook('p', 'Stop', undefined, T0 + 3000, true), true, 'the turn ends');
  assert.equal(late.c.noteProviderStatus('p', 'idle', T0 + 1000), false, 'older than the spent edge');
  late.c.noteHook('p', 'PreCompact', undefined, T0 + 9000);
  assert.equal(late.c.beat('p', T0 + 9000 + PROVIDER_IDLE_CONFIRM_MS), null, 'the settle\'s epoch is over: nothing was deferred');
  assert.equal(late.c.state('p').lifecycle, 'active');
});
