'use strict';
/**
 * P1 (ON HOLD, failing-first): layer-b dry run #6 wedge. A wake's typed turn can START and STOP
 * before the submit owner reports COMMITTED (the Codex F3 submit check takes ~1.5 s; a short turn
 * is faster). settle(COMMITTED) then reopened an epoch that was already over: lifecycle active,
 * not provisional (the start was seen), and the Stop that ended it is older than activeSince, so
 * nothing closes it: every later wake is refused as lifecycle-active.
 *
 * Converged design (Andy + Dwight): claim-correlated. At settle(COMMITTED):
 *  A. a turn START seen after the claim AND a Stop after that start: the typed turn is over.
 *     Record the commit (announced, generation) but stay idle; the claim's ids still delivered go
 *     back to pending ONCE (the §11.3 budget), never lost, never duplicated.
 *  B. a Stop after the claim with NO start seen (a provider that confirms starts): unchanged. The
 *     epoch is provisional and the bounded 60 s submit-unconfirmed path re-pends once (a late Stop
 *     of the PREVIOUS turn is indistinguishable, so "ended" would risk a duplicate nudge).
 *  C. control: a start after the claim and the settle BEFORE its Stop: active until that Stop.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { WorkerWakeWatchdog, SUBMIT_CONFIRM_MS } = loadTs('src/main/workerWake.ts');
const facts = (agentId, now) => ({ agentId, ptyId: `p-${agentId}`, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });

function claimed(c, now, ids = ['m1']) {
  c.reconcile('cx', ids);
  const claim = c.claim(facts('cx', now), 'reconcile', 'reconcile', now);
  assert.ok(claim, 'claimed');
  return claim;
}

test('P1 A (dry #6 order): start and Stop BEFORE the COMMITTED settle -> the lifecycle stays idle and the next delivery is claimed', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 10_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1000);   // the typed turn starts ...
  c.noteHook('cx', 'Stop', '', t0 + 1600);               // ... and ends (600 ms stub turn)
  c.settle(claim, 'COMMITTED', t0 + 1650, true);        // the owner's COMMITTED lands 48 ms later
  assert.equal(c.state('cx').lifecycle, 'idle', 'the turn is over: no reopened epoch');
  // The next mail is claimable at once (dry #6: "lifecycle-active" for 27 min).
  c.reconcile('cx', ['m2']);
  const next = c.claim(facts('cx', t0 + 2000), 'delivery', 'event', t0 + 2000);
  assert.ok(next, 'the next delivery is claimed');
  assert.deepEqual([...next.ids], ['m2']);
});

test('P1 A: the just-ended claim\'s ids that are STILL delivered go back to pending exactly once (never lost, never duplicated)', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 20_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1000);
  c.noteHook('cx', 'Stop', '', t0 + 1600);
  // v2 (Jim FLAW 2): settle reports the ended turn; the caller (the bridge) runs THE SAME repend()
  // with the ledger's delivered ids, so the claim's ids are spent once for this epoch.
  assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 1650, true), { endedBeforeSettle: true });
  assert.deepEqual(c.repend('cx', ['m1'], t0 + 1660, { turnEnded: true }).requeued, ['m1'], 'm1 still delivered: back to pending');
  assert.deepEqual(c.repend('cx', ['m1'], t0 + 1670, { turnEnded: true }).requeued, [], 'a second repend of the same epoch spends nothing');
  c.reconcile('cx', ['m1']);                             // m1 still delivered (its surfacing went unconfirmed)
  const again = c.claim(facts('cx', t0 + 2000), 'hook', 'event', t0 + 2000);   // the Stop-scheduled hook wake (the bridge)
  assert.ok(again, 're-offered at once');
  assert.deepEqual([...again.ids], ['m1']);
  assert.notEqual(again.requestId, claim.requestId, 'under a new generation (typed, not replayed)');
});

test('P1 B (Dwight): a Stop after the claim with NO start seen stays on the bounded provisional path (60 s, re-pend once), never wedged', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 30_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'Stop', '', t0 + 500);                // no start: possibly the previous turn's late Stop
  c.settle(claim, 'COMMITTED', t0 + 700, true);
  assert.equal(c.state('cx').provisional, true);
  const edge = c.beat('cx', t0 + 700 + SUBMIT_CONFIRM_MS);
  assert.equal(edge && edge.kind, 'submit-unconfirmed');
  assert.deepEqual([...edge.ids], ['m1']);
  assert.notEqual(c.state('cx').lifecycle, 'active');
});

test('P1 C (control): a start after the claim and the settle BEFORE its Stop -> active until that Stop, then idle', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 40_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1000);
  c.settle(claim, 'COMMITTED', t0 + 1100, true);
  assert.equal(c.state('cx').lifecycle, 'active');
  c.reconcile('cx', ['m2']);
  assert.equal(c.claim(facts('cx', t0 + 1200), 'delivery', 'event', t0 + 1200), null, 'mail waits for the running turn');
  c.noteHook('cx', 'Stop', '', t0 + 1800);
  assert.equal(c.state('cx').lifecycle, 'idle');
});

// ───────────────────────────── Jim's review of the P1 preview (flaws 1 and 2, the human-turn case)

test('P1 A / Jim FLAW 1 (Codex, turn ids): claim; T2 starts; T1\'s LATE Stop arrives; settle COMMITTED -> stays ACTIVE (T2 is running)', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 50_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1000, undefined, 'T2');   // OUR typed turn starts
  c.noteHook('cx', 'Stop', '', t0 + 1200, undefined, 'T1');               // the PREVIOUS turn's Stop, late
  assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 1300, true), { endedBeforeSettle: false }, 'not ended: nothing is re-pended into the running T2');
  assert.equal(c.state('cx').lifecycle, 'active', 'T2 has not ended: its own Stop (turn id T2) never came');
  c.noteHook('cx', 'Stop', '', t0 + 2000, undefined, 'T2');
  assert.equal(c.state('cx').lifecycle, 'idle', 'T2\'s own Stop ends it');
});

test('P1 A / Jim FLAW 1 (no turn ids): a turn START after the Stop means a turn is running: settle -> ACTIVE, never "ended"', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 60_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1000);
  c.noteHook('cx', 'Stop', '', t0 + 1600);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1700);                   // a newer start: the Stop is not the latest event
  assert.deepEqual(c.settle(claim, 'COMMITTED', t0 + 1750, true), { endedBeforeSettle: false }, 'not ended: the Stop is not the latest event');
  assert.equal(c.state('cx').lifecycle, 'active');
});

test('P1 A / Jim FLAW 2 (via the bridge): the settle-after-Stop re-pend goes through repend(): an id is spent ONCE per epoch, N1-due ids get their one extra offer, never F4', async () => {
  const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
  const coordinator = new WorkerWakeWatchdog();
  const diags = [];
  const queue = [];
  let now = 70_000_000;
  const delivered = { cx: ['X'] };
  const n1Due = { cx: [] };
  const unsettled = [];
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: (a) => delivered[a] ?? [],
    facts: (a) => ({ ptyId: `p-${a}`, lastOutputAt: now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
    submit: () => new Promise((res) => unsettled.push(() => res({ kind: 'COMMITTED' }))),
    text: (ids) => ids.join(','),
    setImmediate: (fn) => queue.push(fn),
    now: () => now,
    diag: (stage, fields) => diags.push({ stage, ...fields }),
    confirmsTurnStart: () => true,
    mail: { mode: () => 'inject', closeTurn() {}, abortSince() {}, closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false, n1DueIds: (a) => n1Due[a] ?? [], openIds: () => [] }
  });
  const settleAll = async () => { while (unsettled.length) unsettled.shift()(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  // W1: X is claimed, COMMITTED, its turn runs and ends unconfirmed; that Stop re-pends X (the §11.3 once).
  assert.ok(bridge.requestInboxWake('cx', 'reconcile', 'reconcile'));
  await settleAll();
  now += 1000; coordinator.noteHook('cx', 'UserPromptSubmit', '', now);
  now += 600; bridge.onMailEpochClosed('cx', 'normal', 'stop', ['X']); coordinator.noteHook('cx', 'Stop', '', now);
  assert.deepEqual(coordinator.state('cx').pending, ['X'], 'the Stop re-pended X once');
  // W2: X is claimed again; its whole turn runs BEFORE the owner's COMMITTED (the dry #6 order).
  now += 70_000;
  n1Due.cx = ['X'];                                        // two unconfirmed surfacings by now
  assert.ok(bridge.requestInboxWake('cx', 'reconcile', 'reconcile'));
  now += 1000; coordinator.noteHook('cx', 'UserPromptSubmit', '', now);
  now += 600; bridge.onMailEpochClosed('cx', 'normal', 'stop', ['X']); coordinator.noteHook('cx', 'Stop', '', now);
  now += 48; await settleAll();
  const st = coordinator.state('cx');
  assert.equal(st.lifecycle, 'idle', 'not reopened');
  assert.deepEqual(st.pending, ['X'], 'X offered again exactly once (its N1-confirming surfacing)');
  assert.equal(diags.filter((d) => d.stage === 'wake-ids-exhausted').length, 0, 'never the F4 backoff');
  // A duplicate Stop of the same epoch spends nothing more.
  bridge.onMailEpochClosed('cx', 'normal', 'stop', ['X']);
  assert.deepEqual(coordinator.state('cx').pending, ['X']);
  assert.equal(diags.filter((d) => d.stage === 'wake-ids-exhausted').length, 0);
});

test('P1 human turn in the window (proposal): a person\'s turn runs between the claim and the COMMITTED; the mail surfaces in it; settle stays idle, nothing is re-offered, our own nudge\'s turn then opens and closes normally', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 80_000_000;
  const claim = claimed(c, t0);
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 300);     // the HUMAN's turn (it surfaces m1)
  c.noteHook('cx', 'Stop', '', t0 + 900);                 // ... and ends (m1 acted)
  c.settle(claim, 'COMMITTED', t0 + 1500, true);         // our nudge went in after it
  c.reconcile('cx', []);                                  // m1 acted: not delivered any more
  assert.equal(c.state('cx').lifecycle, 'idle', 'no epoch reopened on a turn that is over');
  assert.deepEqual(c.state('cx').pending, [], 'nothing re-offered: the mail was seen');
  c.noteHook('cx', 'UserPromptSubmit', '', t0 + 1600);    // our nudge's own turn (nothing to show)
  assert.equal(c.state('cx').lifecycle, 'active');
  c.noteHook('cx', 'Stop', '', t0 + 2200);
  assert.equal(c.state('cx').lifecycle, 'idle', 'and it closes normally');
});
