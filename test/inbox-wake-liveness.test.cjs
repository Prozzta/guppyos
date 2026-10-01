'use strict';
/**
 * ZERO-TOKEN-LIVENESS at the WWR boundary (design slices 2 and 4): the bridge RECORDS STUCK_WAKE
 * through the liveness monitor BEFORE the 1.1.76 WWR recovers an agent, and reports a give-up
 * (the recovery cap) as Human-offered, never as a retry. The monitor decides nothing: one
 * predicate (workerWake.stuckAssessment) serves both assessStuckActive and recoverStuckActive.
 *
 * Named mutants, each must fail this file:
 *   M6  a current Codex task_started (the rollout says a turn runs) permits the 10-min recovery
 *   M7  a stale / other-turn task_complete proves the current turn ended
 *   M11 the STUCK_WAKE record is made AFTER the recovery changed the epoch
 *   M12 a provisional or held epoch is recovered
 *   M13 the fourth recovery in a row resets the counter instead of giving up
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WorkerWakeWatchdog, STUCK_ACTIVE_AFTER_MS, STUCK_ACTIVE_PROOF_MS, STUCK_ACTIVE_MAX_RECOVERIES } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { AgentLivenessMonitor } = loadTs('src/main/agentLiveness.ts');

const A = 'dwight';
const T0 = Date.parse('2026-09-30T17:35:47Z');
const flush = () => new Promise((r) => setImmediate(r));

/** The real coordinator, bridge and liveness monitor over one fake PTY; a committing owner. */
function floor({ probe = null, confirms = false, outcome = 'COMMITTED' } = {}) {
  const coordinator = new WorkerWakeWatchdog();
  const inbox = [];
  const submits = [];
  const mailCalls = [];
  const now = { t: T0 };
  const facts = { ptyId: 'pty-a', lastOutputAt: T0, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false };
  const pr = { current: probe };
  const rows = [];
  const stuckCalls = [];
  const monitor = new AgentLivenessMonitor({
    agents: () => [A],
    facts: () => ({
      agentId: A,
      registry: { archived: false, onHold: false },
      pty: { ptyId: 'pty-a', incarnation: 1, spawnedAt: T0 - 3_600_000, lastTrafficAt: facts.lastOutputAt },
      wake: coordinator.livenessFacts(A),
      control: { paused: facts.paused, halted: facts.halted, autoDeliveryPaused: facts.autoDeliveryPaused },
      mailWaiting: inbox.length,
      ...(pr.current && pr.current.ok ? { rollout: pr.current.latest } : {})
    }),
    sink: (row) => rows.push(row),
    now: () => now.t
  });
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [...inbox],
    facts: () => ({ ...facts }),
    submit: (req) => { submits.push(req); return Promise.resolve({ kind: outcome }); },
    text: (ids) => ids.join(','),
    setImmediate: () => {},
    now: () => now.t,
    ...(probe !== null ? { codexTurnProbe: () => pr.current } : {}),
    ...(confirms ? { confirmsTurnStart: () => true } : {}),
    mail: {
      mode: () => 'inject',
      // As the real ledger (index.ts onEpochClosed): an ended epoch reaches the bridge's repend.
      closeTurn: (agentId, turnId) => { mailCalls.push(['closeTurn', agentId, turnId]); bridge.onMailEpochClosed(agentId, 'normal', 'task-complete'); },
      abortSince: (agentId, since, reason) => { mailCalls.push(['abortSince', agentId, since, reason]); bridge.onMailEpochClosed(agentId, 'abnormal', reason); },
      closeStale: () => [],
      hasOpenEpoch: () => false,
      degrade: () => false,
      log: () => {}
    },
    liveness: {
      stuckWake: (agentId, reason) => {
        // M11: what the coordinator looked like WHEN the record was made.
        stuckCalls.push({ reason, lifecycle: coordinator.state(agentId).lifecycle, at: now.t });
        monitor.noteStuckWake(agentId, reason);
      }
    }
  });
  const stuck = (turnId) => {
    bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, turnId);
    for (const id of ['m-1', 'm-2']) { if (!inbox.includes(id)) inbox.push(id); coordinator.noteDelivery(A, id); }
    assert.equal(coordinator.state(A).lifecycle, 'active');
  };
  const beat = (ms) => { now.t += ms; bridge.reconcileAll([A]); monitor.sampleAll(); };
  return { coordinator, bridge, monitor, inbox, submits, mailCalls, now, facts, stuck, beat, rows, stuckCalls, probe: pr };
}

test('M11: STUCK_WAKE is recorded (and its row written) while the epoch is still ACTIVE, then the WWR recovers', () => {
  const f = floor();
  f.stuck();
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.stuckCalls.length, 1);
  assert.deepEqual([f.stuckCalls[0].reason, f.stuckCalls[0].lifecycle], ['wwr-recovering', 'active'], 'recorded BEFORE the recovery');
  const stuckRow = f.rows.findIndex((r) => r.classification === 'STUCK_WAKE');
  assert.ok(stuckRow >= 0, 'one durable row');
  assert.equal(f.rows[stuckRow].reason, 'wwr-recovering');
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active', 'and the WWR, the only owner, recovered it');
  assert.equal(f.monitor.getLiveness(A).classification, 'STUCK_WAKE');
});

test('the assessment and the recovery are one predicate: assess says recover exactly when recover recovers', () => {
  for (const quiet of [STUCK_ACTIVE_AFTER_MS - 1, STUCK_ACTIVE_AFTER_MS]) {
    const ww = new WorkerWakeWatchdog();
    ww.noteHook(A, 'UserPromptSubmit', '', T0);
    const facts = { ptyId: 'p', lastOutputAt: T0 };
    const pre = ww.assessStuckActive(A, facts, 1, T0 + quiet);
    assert.equal(ww.state(A).lifecycle, 'active', 'assess changes nothing');
    assert.equal(ww.assessStuckActive(A, facts, 1, T0 + quiet)?.kind ?? null, pre?.kind ?? null, 'and is repeatable');
    const out = ww.recoverStuckActive(A, facts, 1, T0 + quiet);
    assert.equal(!!pre, !!out, `quiet ${quiet}`);
    if (pre) assert.deepEqual([pre.kind, pre.basis, pre.quietMs], ['recover', out.basis, out.quietMs]);
  }
});

test('M6: a rollout whose newest boundary is task_started blocks recovery for 30 quiet minutes (and no STUCK_WAKE)', () => {
  const f = floor({ probe: { ok: true, latest: { kind: 'started', turnId: 't-run', at: T0 } } });
  f.stuck('t-run');
  for (let i = 0; i < 4; i++) f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.stuckCalls.length, 0);
  assert.equal(f.submits.length, 0);
  assert.equal(f.monitor.getLiveness(A).classification, 'BUSY_PROGRESSING');
  assert.equal(f.monitor.getLiveness(A).reason, 'rollout-started');
});

test('M7: a task_complete of ANOTHER turn is no proof: no 60-s recovery, only the 10-min quiet basis', () => {
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: 't-old', at: T0 - 1000 } } });
  f.stuck('t-open');
  f.beat(STUCK_ACTIVE_PROOF_MS + 1000);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'a stale completion proved nothing');
  assert.equal(f.stuckCalls.length, 0);
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.stuckCalls.length, 1);
  assert.equal(f.mailCalls.find((c) => c[0] === 'abortSince')?.[3], 'stuck-active', 'recovered on the quiet basis');
});

test('the SAME turn completed (CODEX-STOP-MISSING): B1 closes it on the first beat with mail waiting; nothing is stuck', () => {
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: 't-c', at: T0 + 40_000 } } });
  f.stuck('t-c');
  f.beat(15_000);
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active', 'closed by the provider proof (B1), not by the WWR');
  assert.deepEqual(f.mailCalls.find((c) => c[0] === 'closeTurn'), ['closeTurn', A, 't-c']);
  assert.equal(f.stuckCalls.length, 0);
  assert.ok(!f.rows.some((r) => r.classification === 'STUCK_WAKE' || r.classification === 'SUSPECT'));
});

test('an UNNAMED epoch whose completion predates it (B1 refuses): the WWR proof path, recorded first, after 60 s', () => {
  // Our own submit opened the epoch (no turn id); the rollout's newest boundary is a completion of
  // an earlier turn. B1 needs completion > activeSince; the WWR takes it after the proof window.
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: 't-prev', at: T0 - 1000 } } });
  f.stuck(undefined);
  f.beat(STUCK_ACTIVE_PROOF_MS - 1000);
  assert.equal(f.stuckCalls.length, 0);
  f.beat(1000);
  assert.equal(f.stuckCalls.length, 1);
  assert.deepEqual([f.stuckCalls[0].reason, f.stuckCalls[0].lifecycle], ['wwr-recovering', 'active']);
  assert.deepEqual(f.mailCalls.find((c) => c[0] === 'closeTurn'), ['closeTurn', A, 't-prev']);
});

test('M12: a provisional epoch (our own unconfirmed submit) and a held INTERFERED claim are never recovered or recorded', async () => {
  // Provisional: the wake COMMITTED, the provider never confirmed a turn start.
  const p = floor({ confirms: true });
  for (const id of ['m-1']) { p.inbox.push(id); p.coordinator.noteDelivery(A, id); }
  p.now.t += 40_000;   // past boot grace (no spawn recorded: none applies), event claim
  p.coordinator.noteHook(A, 'Stop', '', p.now.t);
  p.bridge.requestInboxWake(A, 'delivery', 'event');
  await flush();
  assert.equal(p.coordinator.state(A).provisional, true);
  p.inbox.push('m-2'); p.coordinator.noteDelivery(A, 'm-2');
  p.beat(STUCK_ACTIVE_AFTER_MS - 1);   // the submit-unconfirmed path owns it (SUBMIT_CONFIRM_MS)
  assert.equal(p.stuckCalls.length, 0);
  // The shared predicate itself refuses a provisional epoch, however long it is quiet.
  const ww = new WorkerWakeWatchdog();
  ww.noteDelivery(A, 'x');
  const claim = ww.claim({ agentId: A, ptyId: 'p', lastOutputAt: T0, autoDeliveryPaused: false, paused: false, halted: false }, 'delivery', 'reconcile', T0 + 60_000);
  assert.ok(claim, 'claimed');
  ww.settle(claim, 'COMMITTED', T0 + 61_000, true);
  assert.equal(ww.state(A).provisional, true);
  ww.noteDelivery(A, 'y');
  const late = T0 + 61_000 + 3 * STUCK_ACTIVE_AFTER_MS;
  assert.equal(ww.assessStuckActive(A, { ptyId: 'p', lastOutputAt: T0 }, 1, late), null);
  assert.equal(ww.recoverStuckActive(A, { ptyId: 'p', lastOutputAt: T0 }, 1, late), null);
  // Held: an INTERFERED claim waits for a person.
  const h = floor({ outcome: 'INTERFERED' });
  h.stuck();
  h.coordinator.noteHook(A, 'Stop', '', h.now.t + 1);
  h.bridge.requestInboxWake(A, 'delivery', 'event');
  await flush();
  assert.ok(h.coordinator.state(A).held, 'held for a person');
  h.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, 't2');
  h.beat(STUCK_ACTIVE_AFTER_MS * 2);
  assert.equal(h.stuckCalls.length, 0);
  assert.equal(h.coordinator.state(A).lifecycle, 'active');
});

test('M13: after the cap, the next stuck epoch is a give-up: recorded as wwr-max-recoveries, epoch untouched, no re-offer', async () => {
  const f = floor();
  f.stuck();
  for (let n = 1; n <= STUCK_ACTIVE_MAX_RECOVERIES; n++) {
    f.beat(STUCK_ACTIVE_AFTER_MS);
    assert.equal(f.stuckCalls.length, n);
    assert.equal(f.stuckCalls.at(-1).reason, 'wwr-recovering');
    // The recovered agent is re-offered once the PTY is quiet; the wake commits; the new turn wedges
    // again (no Stop between: the give-up budget is not reset).
    f.beat(15_000);
    await flush();
    f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, `t${n}`);
    assert.equal(f.coordinator.state(A).lifecycle, 'active');
  }
  const submitsBefore = f.submits.length;
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.stuckCalls.length, STUCK_ACTIVE_MAX_RECOVERIES + 1);
  assert.deepEqual([f.stuckCalls.at(-1).reason, f.stuckCalls.at(-1).lifecycle], ['wwr-max-recoveries', 'active']);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'the epoch is left alone');
  assert.equal(f.monitor.getLiveness(A).reason, 'wwr-max-recoveries');
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.submits.length, submitsBefore, 'no automatic retry after the cap');
  assert.equal(f.stuckCalls.length, STUCK_ACTIVE_MAX_RECOVERIES + 1, 'reported once per epoch');
  assert.equal(f.monitor.getLiveness(A).classification, 'STUCK_WAKE', 'it stays STUCK (sticky) for the Human');

  // The Human clicks "re-offer mail": the stuck epoch ends, the NORMAL beat re-offers.
  assert.equal(f.bridge.onOperatorReoffer(A), true);
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.mailCalls.at(-1)[3], 'operator-reoffer');
  assert.equal(f.submits.length, submitsBefore, 'the click itself submits nothing');
  f.beat(15_000);
  assert.equal(f.submits.length, submitsBefore + 1, 're-offered by the reconcile beat');
  assert.equal(f.bridge.onOperatorReoffer(A), false, 'nothing to re-offer twice');
});

test('without a liveness dep the WWR runs exactly as in 1.1.76 (no assessment is made)', () => {
  const coordinator = new WorkerWakeWatchdog();
  let assessed = 0;
  const realAssess = coordinator.assessStuckActive.bind(coordinator);
  coordinator.assessStuckActive = (...a) => { assessed += 1; return realAssess(...a); };
  const clock = { t: T0 };
  const bridge = new InboxWakeBridge({
    coordinator, inboxIds: () => ['m'], facts: () => ({ ptyId: 'p', lastOutputAt: T0, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: () => Promise.resolve({ kind: 'COMMITTED' }), text: (ids) => ids.join(','), setImmediate: () => {}, now: () => clock.t
  });
  bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, 't');
  coordinator.noteDelivery(A, 'm');
  clock.t += STUCK_ACTIVE_AFTER_MS;
  bridge.reconcileAll([A]);
  assert.equal(assessed, 0);
  assert.notEqual(coordinator.state(A).lifecycle, 'active');
});
