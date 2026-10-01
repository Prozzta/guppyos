'use strict';
/**
 * ZERO-TOKEN-LIVENESS: the AgentLivenessMonitor reducer and its in-process API
 * (src/main/agentLiveness.ts; design dwight-177/ZERO-TOKEN-LIVENESS-DESIGN.md rev 2, contract
 * creed-177/LIVENESS-V1.md). Pure: clock and facts injected, no timers.
 *
 * The producer half of the liveness-v1 contract lives here: archiveReason is present IFF the
 * lifecycle is ARCHIVED; classifiedSince is unchanged across same-class samples; one row and one
 * callback per classification/lifecycle edge, none otherwise.
 *
 * Named mutants (design slice 1), each must fail this file:
 *   M1 a subagent Stop completes the main turn (lastTurnEndAt advanced by SubagentStop)
 *   M2 a stale / wrong-turn task_complete proves the open turn ended
 *   M3 a quiet timer (the spawn stamp) counts as PTY traffic
 *   M4 a respawn on the same PTY id (PID/id reuse) keeps the prior incarnation
 *   M5 HITL loses the exact `operator-hold` reason
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/agentLiveness.ts');
const { WorkerWakeWatchdog, WORKER_WAKE_BOOT_GRACE_MS, STUCK_ACTIVE_PROOF_MS } = loadTs('src/main/workerWake.ts');
const { LIVENESS_REASON_OPERATOR_HOLD } = loadTs('src/shared/livenessV1.ts');

const T0 = Date.parse('2026-10-01T12:00:00Z');
const MIN = 60_000;

/** A LIVE agent with a PTY spawned long ago, idle lifecycle, no mail. Override per case. */
function facts(over = {}) {
  const base = {
    agentId: 'a1',
    registry: { archived: false, onHold: false },
    pty: { ptyId: 'pty-a1', incarnation: 7, spawnedAt: T0 - 60 * MIN, lastTrafficAt: 0 },
    wake: { lifecycle: 'idle', provisional: false, activeSince: 0, openTurnId: null, turnStartAt: 0, lastTurnEndAt: 0, lastHookAt: 0, lastHumanNeedsAt: 0 },
    control: { paused: false, halted: false, autoDeliveryPaused: false },
    mailWaiting: 0
  };
  return {
    ...base, ...over,
    registry: { ...base.registry, ...(over.registry ?? {}) },
    pty: over.pty === null ? null : { ...base.pty, ...(over.pty ?? {}) },
    wake: { ...base.wake, ...(over.wake ?? {}) },
    control: { ...base.control, ...(over.control ?? {}) }
  };
}
const classify = (f, now = T0, memo = {}, prev) => L.classifyLiveness(f, memo, prev, now);

/** A monitor over one mutable facts object, a manual clock and a recording sink. */
function world(f0 = facts()) {
  const w = { f: f0, now: T0, rows: [], edges: [] };
  w.mon = new L.AgentLivenessMonitor({
    agents: () => (w.f ? [w.f.agentId] : []),
    facts: (id) => (w.f && w.f.agentId === id ? w.f : null),
    sink: (row) => w.rows.push(row),
    now: () => w.now
  });
  w.mon.onLivenessChange((rec, prev) => w.edges.push({ rec, prev }));
  return w;
}

test('precedence: an unrequested PTY end is CRASHED, a requested one EXITED; the code is evidence only', () => {
  const f = facts();
  const crashed = classify(f, T0, { ended: { ptyId: 'pty-a1', incarnation: 7, explicit: false, exitCode: 0, at: T0 - 1000 } });
  assert.equal(crashed.classification, 'CRASHED');
  assert.equal(crashed.reason, 'pty-exit-unrequested');
  assert.equal(crashed.evidence.processExitAt, T0 - 1000);
  assert.equal(crashed.evidence.exitCode, 0, 'a clean code does not make an unrequested exit EXITED');
  const exited = classify(f, T0, { ended: { ptyId: 'pty-a1', incarnation: 7, explicit: true, exitCode: 1, at: T0 - 1000 } });
  assert.equal(exited.classification, 'EXITED', 'a non-zero code does not make a requested kill CRASHED');
  assert.equal(exited.evidence.exitCode, 1);
  assert.equal(exited.incarnation, 'pty-a1#7');
});

test('precedence: no PTY is UNKNOWN; boot grace is UNKNOWN; nothing is judged inside it', () => {
  assert.equal(classify(facts({ pty: null })).classification, 'UNKNOWN');
  assert.equal(classify(facts({ pty: null })).reason, 'no-pty');
  const booting = facts({ pty: { spawnedAt: T0 - (WORKER_WAKE_BOOT_GRACE_MS - 1) }, wake: { lifecycle: 'active', activeSince: T0 - 30 * MIN } });
  assert.deepEqual([classify(booting).classification, classify(booting).reason], ['UNKNOWN', 'boot-grace']);
});

test('an open turn with recent PTY output or hook traffic is BUSY; with none for 5 min it is SUSPECT', () => {
  const busy = facts({ wake: { lifecycle: 'active', activeSince: T0 - 20 * MIN }, pty: { lastTrafficAt: T0 - 4 * MIN } });
  assert.deepEqual([classify(busy).classification, classify(busy).reason], ['BUSY_PROGRESSING', 'pty-traffic']);
  const hooks = facts({ wake: { lifecycle: 'active', activeSince: T0 - 20 * MIN, lastHookAt: T0 - 10_000 }, pty: { lastTrafficAt: T0 - 15 * MIN } });
  assert.deepEqual([classify(hooks).classification, classify(hooks).reason], ['BUSY_PROGRESSING', 'hook-traffic']);
  const quiet = facts({ wake: { lifecycle: 'active', activeSince: T0 - 20 * MIN, lastHookAt: T0 - 6 * MIN }, pty: { lastTrafficAt: T0 - 5 * MIN } });
  assert.deepEqual([classify(quiet).classification, classify(quiet).reason], ['SUSPECT', 'no-progress']);
});

test('L2: a Codex turn whose rollout newest boundary is task_started stays BUSY for 30 quiet minutes', () => {
  const f = facts({
    wake: { lifecycle: 'active', activeSince: T0 - 30 * MIN, openTurnId: 't9', lastHookAt: T0 - 30 * MIN },
    pty: { lastTrafficAt: T0 - 30 * MIN },
    rollout: { kind: 'started', turnId: 't9', at: T0 - 30 * MIN }
  });
  assert.deepEqual([classify(f).classification, classify(f).reason], ['BUSY_PROGRESSING', 'rollout-started']);
});

test('a rollout boundary from BEFORE this incarnation proves nothing about it', () => {
  // The crashed session's last task_started (before the respawn) must not make the new one busy.
  const f = facts({ pty: { spawnedAt: T0 - 20 * MIN }, wake: { lifecycle: 'unknown' }, rollout: { kind: 'started', turnId: 'old', at: T0 - 25 * MIN } });
  assert.equal(classify(f).classification, 'IDLE');
});

test('the open turn completed in the rollout (same turn id) and no hook for the proof window: SUSPECT rollout-complete-no-stop', () => {
  const f = facts({
    wake: { lifecycle: 'active', activeSince: T0 - 2 * MIN, openTurnId: 't1', lastHookAt: T0 - STUCK_ACTIVE_PROOF_MS },
    pty: { lastTrafficAt: T0 - 5000 },
    rollout: { kind: 'complete', turnId: 't1', at: T0 - 70_000 }
  });
  assert.deepEqual([classify(f).classification, classify(f).reason], ['SUSPECT', 'rollout-complete-no-stop']);
  // Inside the proof window it is still BUSY (a completion is followed by the TUI's last redraws).
  const early = facts({ ...f, wake: { ...f.wake, lastHookAt: T0 - STUCK_ACTIVE_PROOF_MS + 1 } });
  assert.equal(classify(early).classification, 'BUSY_PROGRESSING');
});

test('M2: a task_complete of ANOTHER turn, or one older than an unnamed epoch, proves nothing', () => {
  const other = facts({
    wake: { lifecycle: 'active', activeSince: T0 - 2 * MIN, openTurnId: 't2', lastHookAt: T0 - 2 * MIN },
    pty: { lastTrafficAt: T0 - 5000 },
    rollout: { kind: 'complete', turnId: 't1', at: T0 - 70_000 }
  });
  assert.equal(classify(other).classification, 'BUSY_PROGRESSING', 'a wrong-turn completion is not proof');
  const stale = facts({
    wake: { lifecycle: 'active', activeSince: T0 - 2 * MIN, openTurnId: null, lastHookAt: T0 - 2 * MIN },
    pty: { lastTrafficAt: T0 - 5000, spawnedAt: T0 - 60 * MIN },
    rollout: { kind: 'complete', turnId: 't0', at: T0 - 3 * MIN }
  });
  assert.equal(classify(stale).classification, 'BUSY_PROGRESSING', 'a completion older than the epoch is about an earlier turn');
});

test('M3: PTY traffic is real output only: the spawn stamp is never lastPtyTrafficAt', () => {
  const f = facts({ pty: { lastTrafficAt: 0, spawnedAt: T0 - 40_000 }, wake: { lifecycle: 'unknown' } });
  const v = classify(f);
  assert.equal(v.evidence.lastPtyTrafficAt, undefined);
  assert.notEqual(v.classification, 'BUSY_PROGRESSING');
  // And the PTY layer itself reports 0 before the first onData (see pty-liveness.test.cjs too).
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  m.sessions.set('p', { id: 'p', proc: { pid: 1, kill() {} }, lastOutputAt: T0, hasOutput: false, incarnation: 3, spawnedAt: T0, tail: '' });
  assert.deepEqual(m.livenessFacts('p'), { incarnation: 3, spawnedAt: T0, lastTrafficAt: 0 });
});

test('M5: HITL (a permission prompt in this epoch) is IDLE with the EXACT operator-hold reason, never SUSPECT', () => {
  const f = facts({ wake: { lifecycle: 'active', activeSince: T0 - 40 * MIN, lastHookAt: T0 - 39 * MIN, lastHumanNeedsAt: T0 - 39 * MIN }, pty: { lastTrafficAt: T0 - 39 * MIN } });
  const v = classify(f);
  assert.equal(v.classification, 'IDLE');
  assert.equal(v.reason, LIVENESS_REASON_OPERATOR_HOLD);
  assert.equal(v.reason, 'operator-hold');
  for (const control of [{ paused: true }, { halted: true }, { autoDeliveryPaused: true }]) {
    assert.equal(classify(facts({ control })).reason, 'operator-hold', JSON.stringify(control));
  }
  assert.equal(classify(facts({ registry: { onHold: true } })).reason, 'operator-hold');
  // A hold never hides progress: a held agent that is producing output is BUSY.
  const working = facts({ registry: { onHold: true }, wake: { lifecycle: 'active', activeSince: T0 - MIN }, pty: { lastTrafficAt: T0 - 1000 } });
  assert.equal(classify(working).classification, 'BUSY_PROGRESSING');
});

test('idle states: a Stop is IDLE turn-ended; unknown and quiet is IDLE, or UNKNOWN while mail waits; a 5-min refusal run is SUSPECT', () => {
  assert.deepEqual([classify(facts()).classification, classify(facts()).reason], ['IDLE', 'turn-ended']);
  const u = facts({ wake: { lifecycle: 'unknown' }, pty: { lastTrafficAt: T0 - MIN } });
  assert.deepEqual([classify(u).classification, classify(u).reason], ['IDLE', 'quiescent']);
  const waiting = facts({ wake: { lifecycle: 'unknown' }, pty: { lastTrafficAt: T0 - MIN }, mailWaiting: 2 });
  assert.deepEqual([classify(waiting).classification, classify(waiting).reason], ['UNKNOWN', 'awaiting-wake']);
  const stalled = classify(facts({ mailWaiting: 1 }), T0, { wakeRefusalSince: T0 - 5 * MIN, lastWakeRefusalAt: T0 - 1000 });
  assert.deepEqual([stalled.classification, stalled.reason], ['SUSPECT', 'wake-refusal-stall']);
  assert.equal(stalled.evidence.wakeRefusalSince, T0 - 5 * MIN);
  const moving = facts({ wake: { lifecycle: 'unknown' }, pty: { lastTrafficAt: T0 - 2000 } });
  assert.equal(classify(moving).classification, 'BUSY_PROGRESSING');
});

test('G2 (Jim P8): the wake-refusal stall boundary: SUSPECT exactly at WAKE_STALL_AFTER_MS of the same refusal, not 1 ms before', () => {
  const { WAKE_STALL_AFTER_MS } = loadTs('src/main/wakeStall.ts');
  const f = facts({ mailWaiting: 1 });
  const before = classify(f, T0, { wakeRefusalSince: T0 - WAKE_STALL_AFTER_MS + 1, lastWakeRefusalAt: T0 });
  assert.deepEqual([before.classification, before.reason], ['IDLE', 'turn-ended']);
  const at = classify(f, T0, { wakeRefusalSince: T0 - WAKE_STALL_AFTER_MS, lastWakeRefusalAt: T0 });
  assert.deepEqual([at.classification, at.reason], ['SUSPECT', 'wake-refusal-stall']);
  // No mail waiting: a long refusal run is the floor at rest, never a stall.
  const empty = classify(facts({ mailWaiting: 0 }), T0, { wakeRefusalSince: T0 - 3 * WAKE_STALL_AFTER_MS });
  assert.equal(empty.classification, 'IDLE');
});

test('contract: archiveReason is present IFF ARCHIVED (an archive with no recorded reason is explicit)', () => {
  const w = world(facts());
  const live = w.mon.sample('a1');
  assert.equal(live.lifecycle, 'LIVE');
  assert.ok(!('archiveReason' in live) && !('archivedAt' in live));
  for (const reason of ['explicit', 'orphan', 'pty-exit']) {
    w.f = facts({ pty: null, registry: { archived: true, archiveReason: reason, archivedAt: T0 - 5 } });
    const r = w.mon.sample('a1');
    assert.equal(r.lifecycle, 'ARCHIVED');
    assert.equal(r.archiveReason, reason);
    assert.equal(r.archivedAt, T0 - 5);
  }
  w.f = facts({ pty: null, registry: { archived: true } });
  assert.equal(w.mon.sample('a1').archiveReason, 'explicit', 'archived before 1.1.75: counted as explicit');
  w.f = facts();
  const back = w.mon.sample('a1');
  assert.equal(back.lifecycle, 'LIVE');
  assert.ok(!('archiveReason' in back) && !('archivedAt' in back));
});

test('contract: classifiedSince is unchanged across same-class samples; one row and one callback per edge only', () => {
  const w = world(facts({ wake: { lifecycle: 'active', activeSince: T0 }, pty: { lastTrafficAt: T0 } }));
  const first = w.mon.sample('a1');
  assert.equal(first.classification, 'BUSY_PROGRESSING');
  assert.equal(w.rows.length, 1);
  for (let i = 1; i <= 8; i++) {
    w.now = T0 + i * 15_000;
    w.f.pty.lastTrafficAt = w.now;
    w.f.wake.lastHookAt = w.now - 3000;   // the reason moves between pty/hook: still no edge
    const r = w.mon.sample('a1');
    assert.equal(r.classifiedSince, first.classifiedSince, `sample ${i}`);
    assert.equal(r.evidence.sampledAt, w.now);
  }
  assert.equal(w.rows.length, 1, 'no row without an edge (M14: every 15-s sample appending a row)');
  assert.equal(w.edges.length, 1);
  w.now = T0 + 20 * MIN;   // nothing for 5 min: SUSPECT, one edge
  const s = w.mon.sample('a1');
  assert.equal(s.classification, 'SUSPECT');
  assert.equal(s.classifiedSince, w.now);
  assert.equal(w.rows.length, 2);
  assert.deepEqual(Object.keys(w.rows[1]).sort(), ['agentId', 'classification', 'classifiedSince', 'evidence', 'incarnation', 'kind', 'lifecycle', 'reason'].sort());
  assert.equal(w.rows[1].kind, 'liveness');
  assert.equal(w.edges[1].prev.classification, 'BUSY_PROGRESSING');
  assert.deepEqual(w.mon.getLiveness('a1'), s);
});

test('a lifecycle edge alone (same classification) is an edge too', () => {
  const w = world(facts({ pty: null }));
  w.mon.sample('a1');
  w.f = facts({ pty: null, registry: { archived: true, archiveReason: 'orphan' } });
  const r = w.mon.sample('a1');
  assert.equal(r.classification, 'UNKNOWN');
  assert.equal(w.rows.length, 2);
  assert.equal(w.rows[1].lifecycle, 'ARCHIVED');
});

test('DELETED: an agent that left the registry keeps its record, lifecycle DELETED', () => {
  const w = world(facts());
  w.mon.sample('a1');
  w.f = null;
  w.mon.sampleAll();
  const r = w.mon.getLiveness('a1');
  assert.equal(r.lifecycle, 'DELETED');
  assert.ok(!('archiveReason' in r));
  assert.equal(r.reason, 'deleted');
  assert.equal(w.rows.length, 2);
});

test('M1: a SubagentStop never ends the main turn (lastTurnEndAt is the main Stop only)', () => {
  const ww = new WorkerWakeWatchdog();
  ww.noteHook('a1', 'UserPromptSubmit', '', T0 - 2000);
  ww.noteHook('a1', 'SubagentStop', '', T0 - 1000);
  const wf = ww.livenessFacts('a1');
  assert.equal(wf.lifecycle, 'active');
  assert.equal(wf.lastTurnEndAt, 0);
  const v = classify(facts({ wake: wf, pty: { lastTrafficAt: T0 - 500 } }));
  assert.equal(v.classification, 'BUSY_PROGRESSING');
  assert.equal(v.evidence.lastTurnEndAt, undefined);
  ww.noteHook('a1', 'Stop', '', T0);
  assert.equal(ww.livenessFacts('a1').lastTurnEndAt, T0);
  assert.equal(classify(facts({ wake: ww.livenessFacts('a1') })).classification, 'IDLE');
});

test('Dwight F1: a SubagentStop never refreshes the main-session hook evidence (lastHookAt), so it cannot keep a stalled main turn BUSY', () => {
  const ww = new WorkerWakeWatchdog();
  ww.noteHook('a1', 'UserPromptSubmit', '', T0 - 10 * MIN);
  for (let i = 1; i <= 9; i++) ww.noteHook('a1', 'SubagentStop', '', T0 - 10 * MIN + i * MIN);   // subagents keep finishing
  const wf = ww.livenessFacts('a1');
  assert.equal(wf.lastHookAt, T0 - 10 * MIN, 'only the main session counts');
  const v = classify(facts({ wake: wf, pty: { lastTrafficAt: T0 - 10 * MIN } }));
  assert.deepEqual([v.classification, v.reason], ['SUSPECT', 'no-progress']);
  // A main-session hook and a provider status reading DO count.
  ww.noteHook('a1', 'PostToolUse', '', T0 - 1000);
  assert.equal(ww.livenessFacts('a1').lastHookAt, T0 - 1000);
  ww.noteProviderStatus('a1', 'running', T0 - 500);
  assert.equal(ww.livenessFacts('a1').lastHookAt, T0 - 500);
});

test('M4: a respawn on the same PTY id is a new incarnation; nothing of the old one carries over', () => {
  const w = world(facts({ wake: { lifecycle: 'active', activeSince: T0 - MIN }, pty: { lastTrafficAt: T0 - 1000 } }));
  w.mon.sample('a1');
  w.mon.notePtyEnd('a1', { ptyId: 'pty-a1', incarnation: 7, explicit: false, exitCode: 1, at: T0 });
  assert.equal(w.mon.getLiveness('a1').classification, 'CRASHED');
  assert.equal(w.mon.getLiveness('a1').incarnation, 'pty-a1#7');
  // Same id, new process: the PtyManager sequence moves on.
  w.now = T0 + 40_000;
  w.f = facts({ pty: { incarnation: 8, spawnedAt: T0 + 1000, lastTrafficAt: T0 + 30_000 }, wake: { lifecycle: 'unknown' } });
  const r = w.mon.sample('a1');
  assert.equal(r.incarnation, 'pty-a1#8');
  assert.notEqual(r.classification, 'CRASHED');
  assert.equal(r.evidence.processExitAt, undefined, 'the old exit is not evidence about the new process');
});

test('a CRASHED record survives the agent leaving the floor (archived pty-exit) until a new incarnation', () => {
  const w = world(facts());
  w.mon.sample('a1');
  w.mon.notePtyEnd('a1', { ptyId: 'pty-a1', incarnation: 7, explicit: false, exitCode: null, at: T0 });
  // The teardown archives it right after the exit: a lifecycle edge (contract), same classification.
  w.f = facts({ pty: null, registry: { archived: true, archiveReason: 'pty-exit', archivedAt: T0 + 50 } });
  w.now = T0 + 50;
  const archived = w.mon.sample('a1');
  assert.equal(archived.classification, 'CRASHED');
  assert.equal(archived.lifecycle, 'ARCHIVED');
  assert.equal(archived.archiveReason, 'pty-exit');
  assert.equal(archived.classifiedSince, T0 + 50);
  w.now = T0 + 11 * MIN;
  const later = w.mon.sample('a1');
  assert.equal(later.classification, 'CRASHED');
  assert.equal(later.classifiedSince, T0 + 50, 'ZT-I3 times "CRASHED for >= 10 min" from this');
  assert.equal(later.evidence.processExitAt, T0, 'and the exact exit time rides in the evidence');
});

test('STUCK_WAKE: recorded by the WWR owner, sticky until progress, cleared by a turn start, a Stop, acted mail or a respawn', () => {
  const stuckFacts = () => facts({ wake: { lifecycle: 'active', activeSince: T0 - 11 * MIN, lastHookAt: T0 - 11 * MIN }, pty: { lastTrafficAt: T0 - 11 * MIN }, mailWaiting: 1 });
  const w = world(stuckFacts());
  w.mon.sample('a1');
  const r = w.mon.noteStuckWake('a1', 'wwr-recovering');
  assert.deepEqual([r.classification, r.reason], ['STUCK_WAKE', 'wwr-recovering']);
  assert.equal(w.rows.at(-1).classification, 'STUCK_WAKE', 'persisted synchronously');
  // The WWR moved the lifecycle to unknown: still STUCK until something actually progresses.
  w.now += 15_000; w.f.wake.lifecycle = 'unknown';
  assert.equal(w.mon.sample('a1').classification, 'STUCK_WAKE');
  w.now += 15_000; w.f.wake.turnStartAt = w.now - 1000; w.f.wake.lifecycle = 'active'; w.f.wake.activeSince = w.now - 1000;
  assert.equal(w.mon.sample('a1').classification, 'BUSY_PROGRESSING');
  for (const clear of [(f) => { f.wake.lastTurnEndAt = w.now; }, (f) => { f.mailWaiting = 0; }, (f) => { f.pty.incarnation = 99; }]) {
    w.f = stuckFacts();
    w.mon.noteStuckWake('a1', 'wwr-max-recoveries');
    assert.equal(w.mon.getLiveness('a1').reason, 'wwr-max-recoveries');
    w.now += 1000;
    clear(w.f);
    assert.notEqual(w.mon.sample('a1').classification, 'STUCK_WAKE');
  }
});

test('fleet records: every LIVE agent, and a non-LIVE one for a week after its edge', () => {
  const w = world(facts({ pty: null, registry: { archived: true, archiveReason: 'explicit' } }));
  w.mon.sample('a1');
  assert.equal(w.mon.fleetRecords(T0 + L.LIVENESS_FLEET_RETAIN_MS - 1).length, 1);
  assert.equal(w.mon.fleetRecords(T0 + L.LIVENESS_FLEET_RETAIN_MS).length, 0);
});

test('the monitor API never throws on a bad listener or sink, and a never-known agent is not invented', () => {
  const mon = new L.AgentLivenessMonitor({ agents: () => [], facts: () => null, sink: () => { throw new Error('disk'); }, now: () => T0 });
  assert.equal(mon.sample('ghost'), undefined);
  const m2 = new L.AgentLivenessMonitor({ agents: () => ['a1'], facts: () => facts(), sink: () => { throw new Error('disk'); }, now: () => T0 });
  m2.onLivenessChange(() => { throw new Error('listener'); });
  assert.equal(m2.sample('a1').classification, 'IDLE');
});
