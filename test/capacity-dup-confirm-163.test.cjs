'use strict';

/**
 * CAPACITY-DUP-CONFIRM-163 — the Dwight deadlock of 2026-09-27 (Jim, CAPACITY-DEADLOCK.md).
 *
 * After a restart the store restores a Codex agent's last reading as UNCONFIRMED:
 * UNKNOWN(RESTORED), which the ratified mapping HOLDS (v1.0.45, unchanged here). An idle
 * agent's newest usable rollout line IS that restored line, so the first hook re-reads it:
 * a DUPLICATE. That duplicate did not confirm the restore (L0-TAIL, unchanged) but DID bind
 * the agent to the pool, and from then on every automatic wake was CAPACITY_HOLD — while
 * only the agent's own next model turn could write the newer line that clears it.
 *
 * The fix: a duplicate re-read of a HEALTHY unconfirmed restore does not bind the agent
 * (it stays NO_POOL, as before its first hook, and proceeds); a NOT_HEALTHY one binds as
 * before and holds. Plus the diagnostics that would have named this at once: the settle
 * row's detail (the hold's basis) and a `capacity-bind` row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY, REASON } = loadTs('src/main/providerCapacityTracker.ts');
const { restoreCapacityStore, CAPACITY_STORE_VERSION } = loadTs('src/main/capacityPersistence.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const OWN = loadTs('src/main/automaticSubmit.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const T0 = 1_800_000_000_000;            // the reading, before the restart
const RESTART = T0 + 50 * 60_000;        // ~50 min later, as on the floor (10:39 -> 11:27)
const KEY = 'codex:acct-a:codex';

const win = (over = {}) => ({
  windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300,
  usedPercent: 28, remainingPercent: 72, resetsAt: RESTART + 5 * 60_000, ...over
});
const weekly = (over = {}) => ({
  windowId: 'seven_day', kind: 'SEVEN_DAY', label: 'Weekly', windowMinutes: 10080,
  usedPercent: 26, remainingPercent: 74, resetsAt: T0 + 5 * 86_400_000, ...over
});
const obs = (windows) => ({
  poolKey: KEY, provider: 'codex', accountScope: 'acct-a', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/r.jsonl', sourceSequence: 19780,
  observedAt: T0, receivedAt: T0, windows,
  providerAttributedLimitingWindowId: null, providerReachedType: null,
  ordinaryUsageAllowed: null, planType: 'plus'
});

/** A runtime whose tracker restored `reading` from a previous process. */
function restarted(reading) {
  let now = T0;
  const before = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => 0);
  before.ingestDetailed(reading);
  const wire = JSON.parse(JSON.stringify({ version: CAPACITY_STORE_VERSION, savedAt: now, pools: before.persistable() }));
  now = RESTART;
  let mono = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  assert.equal(restoreCapacityStore(tracker, wire.pools), 1, 'the reading was restored');
  const rows = [];
  const rt = new CapacityRuntime({
    deliver: () => {}, now: () => now,
    setTimer: () => ({}), clearTimer: () => {},
    log: (row) => rows.push(row)
  }, tracker);
  return { rt, rows, tracker };
}

const verdictFor = (rt, agent) => OWN.resolveAdmission(rt.admission.probe(agent, 'ORDINARY_TURN'), OWN.UNKNOWN_POLICY);

test('the floor case: restored HEALTHY reading, the same line re-read by a hook -> not bound, the wake PROCEEDS (NO_POOL)', () => {
  const reading = obs([win(), weekly()]);
  const { rt, rows, tracker } = restarted(reading);
  assert.equal(tracker.pool(KEY).stateReason, REASON.RESTORED, 'UNKNOWN(RESTORED) after the restart');

  rt.ingest('dwight', obs([win(), weekly()]));   // the compaction turn's hook re-reads line 19780
  assert.equal(tracker.pool(KEY).stateReason, REASON.RESTORED, 'the re-read does NOT confirm the restore (L0-TAIL kept)');
  assert.equal(rt.poolKeyOf('dwight'), null, 'and does not bind Dwight to it');
  const v = verdictFor(rt, 'dwight');
  assert.equal(v.action, 'PROCEED', `the wake goes out (basis ${v.basis})`);
  assert.equal(v.basis, 'UNKNOWN:NO_POOL');
  assert.deepEqual(rows.map((r) => [r.kind, r.agentId, r.outcome, r.state, r.stateReason]),
    [['capacity-bind', 'dwight', 'skipped-restored-duplicate', 'UNKNOWN', REASON.RESTORED]], 'one row, naming why');

  // More hooks re-read it: still unbound, and the skip is logged once, not per hook.
  rt.ingest('dwight', obs([win(), weekly()]));
  rt.ingest('dwight', obs([win(), weekly()]));
  assert.equal(rt.poolKeyOf('dwight'), null);
  assert.equal(rows.length, 1, 'no row per hook');
});

test('a NEWER live line still binds and confirms (the normal path is unchanged)', () => {
  const { rt, rows, tracker } = restarted(obs([win(), weekly()]));
  rt.ingest('dwight', { ...obs([win({ usedPercent: 30, remainingPercent: 70 }), weekly()]), sourceSequence: 19900, observedAt: RESTART + 1000, receivedAt: RESTART + 1000 });
  assert.equal(rt.poolKeyOf('dwight'), KEY);
  assert.notEqual(tracker.pool(KEY).stateReason, REASON.RESTORED, 'a live reading clears the restore');
  assert.equal(verdictFor(rt, 'dwight').action, 'PROCEED');
  assert.deepEqual(rows.map((r) => [r.outcome, r.agentId, r.poolKey]), [['bound', 'dwight', KEY]]);
});

test('a restored EXHAUSTED reading re-read as a duplicate still binds and HOLDS (a restart cannot clear a real limit)', () => {
  const spent = obs([win({ usedPercent: 100, remainingPercent: 0 }), weekly()]);
  const { rt, rows, tracker } = restarted(spent);
  rt.ingest('dwight', obs([win({ usedPercent: 100, remainingPercent: 0 }), weekly()]));
  assert.equal(rt.poolKeyOf('dwight'), KEY, 'bound, as before');
  assert.equal(tracker.pool(KEY).stateReason, REASON.RESTORED);
  const v = verdictFor(rt, 'dwight');
  assert.deepEqual([v.action, v.basis], ['HOLD', 'UNKNOWN:INDETERMINATE']);
  assert.deepEqual(rows.map((r) => [r.outcome, r.state]), [['bound-duplicate', 'UNKNOWN']]);
});

test('an agent ALREADY bound keeps its binding when a restored duplicate arrives', () => {
  const { rt } = restarted(obs([win(), weekly()]));
  const other = { ...obs([win(), weekly()]), poolKey: 'codex:acct-b:codex', accountScope: 'acct-b', streamId: 'codex-rollout:/b.jsonl', observedAt: RESTART, receivedAt: RESTART };
  rt.ingest('dwight', other);
  assert.equal(rt.poolKeyOf('dwight'), 'codex:acct-b:codex');
  rt.ingest('dwight', obs([win(), weekly()]));
  assert.equal(rt.poolKeyOf('dwight'), 'codex:acct-b:codex', 'the skip never unbinds');
});

test('tracker: the DUPLICATE result names an unconfirmed restore and its health; a plain duplicate does not', () => {
  const { tracker } = restarted(obs([win(), weekly()]));
  const r = tracker.ingestDetailed(obs([win(), weekly()]));
  assert.deepEqual([r.accepted, r.changed, r.reason, r.unconfirmedRestore], [true, false, 'DUPLICATE', 'HEALTHY']);

  let now = T0;
  const live = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => 0);
  live.ingestDetailed(obs([win(), weekly()]));
  const d = live.ingestDetailed(obs([win(), weekly()]));
  assert.equal(d.reason, 'DUPLICATE');
  assert.equal(d.unconfirmedRestore, undefined, 'nothing restored: nothing to say');

  const { tracker: t2 } = restarted(obs([win({ remainingPercent: 0, usedPercent: 100 }), weekly()]));
  assert.equal(t2.ingestDetailed(obs([win({ remainingPercent: 0, usedPercent: 100 }), weekly()])).unconfirmedRestore, 'NOT_HEALTHY');
});

test('the settle row carries the owner\'s detail: a CAPACITY_HOLD says which basis held it', async () => {
  const diags = [];
  const queue = [];
  const coordinator = new WorkerWakeWatchdog();
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => ['m1'],
    facts: () => ({ ptyId: 'pty-dwight', lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: () => Promise.resolve({ kind: 'REFUSED', reason: 'CAPACITY_HOLD', detail: 'UNKNOWN:INDETERMINATE' }),
    text: (ids) => inboxNudgeText([...ids]),
    setImmediate: (fn) => queue.push(fn),
    now: () => T0 + 600_000,
    diag: (stage, fields) => diags.push({ stage, ...fields }),
    confirmsTurnStart: () => true
  });
  coordinator.noteHook('dwight', 'Stop', undefined, T0, undefined, 't1');
  bridge.requestInboxWake('dwight', 'renderer', 'reconcile');
  while (queue.length) queue.shift()();
  await new Promise((r) => setImmediate(r));
  const settle = diags.find((d) => d.stage === 'settle');
  assert.ok(settle, 'a settle row');
  assert.deepEqual([settle.outcome, settle.reason, settle.detail], ['REFUSED', 'CAPACITY_HOLD', 'UNKNOWN:INDETERMINATE']);
});
