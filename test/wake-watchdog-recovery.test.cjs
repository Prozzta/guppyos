'use strict';

/**
 * WAKE-WATCHDOG-RECOVERY (1.1.76, P1b). The stall watchdog only LOGGED an agent stuck
 * lifecycle-active with mail waiting (index.ts noteWakeRefusal). Now the reconcile beat
 * recovers it, deterministically and with zero model tokens, and re-offers the mail through the
 * normal claim path (never a submit of its own).
 *
 * Two bases:
 * - quiet: active on a non-provisional epoch, mail waiting, no hook/status reading and no PTY
 *   output for STUCK_ACTIVE_AFTER_MS -> lifecycle `unknown`, open mail epochs abort as
 *   `stuck-active`;
 * - rollout-complete (CODEX-STOP-MISSING, Dwight 17:36Z): Codex's rollout says its newest turn
 *   COMPLETED, with STUCK_ACTIVE_PROOF_MS of hook silence -> `idle`, the turn's mail epoch closes
 *   as a Stop would have.
 * Bounded: once per epoch, and after STUCK_ACTIVE_MAX_RECOVERIES in a row without a real Stop it
 * gives up and only reports.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const W = loadTs('src/main/workerWake.ts');
const { WorkerWakeWatchdog, STUCK_ACTIVE_AFTER_MS, STUCK_ACTIVE_PROOF_MS, STUCK_ACTIVE_MAX_RECOVERIES } = W;
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { WAKE_STALL_AFTER_MS } = loadTs('src/main/wakeStall.ts');

const A = 'dwight';
const T0 = Date.parse('2026-09-30T17:35:47Z');

/** The real coordinator + bridge, a committing owner, a recording mail ledger, settable facts. */
function floor({ probe = null, confirms = false } = {}) {
  const coordinator = new WorkerWakeWatchdog();
  const inbox = [];
  const submits = [];
  const diags = [];
  const mailCalls = [];
  const now = { t: T0 };
  const facts = { ptyId: 'pty-a', lastOutputAt: T0, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false };
  const pr = { current: probe };
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [...inbox],
    facts: () => ({ ...facts }),
    submit: (req) => { submits.push(req); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => ids.join(','),
    setImmediate: () => {},
    now: () => now.t,
    diag: (stage, fields) => diags.push({ stage, ...fields }),
    ...(probe !== null ? { codexTurnProbe: () => pr.current } : {}),
    ...(confirms ? { confirmsTurnStart: () => true } : {}),
    mail: {
      mode: () => 'inject',
      closeTurn: (agentId, turnId) => mailCalls.push(['closeTurn', agentId, turnId]),
      abortSince: (agentId, since, reason) => mailCalls.push(['abortSince', agentId, since, reason]),
      closeStale: () => [],
      hasOpenEpoch: () => false,
      degrade: () => false,
      log: (row) => mailCalls.push(['log', row])
    }
  });
  const stuck = (turnId) => {
    bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, turnId);   // a turn starts...
    for (const id of ['m-1', 'm-2']) { if (!inbox.includes(id)) inbox.push(id); coordinator.noteDelivery(A, id); }
    assert.equal(coordinator.state(A).lifecycle, 'active');                // ...and its Stop never comes
  };
  const beat = (ms) => { now.t += ms; bridge.reconcileAll([A]); };
  const rows = () => diags.filter((d) => d.stage === 'stuck-active');
  return { coordinator, bridge, inbox, submits, diags, mailCalls, now, facts, stuck, beat, rows, probe: pr };
}

test('constants: recovery waits past the stall row; the proof window is short; the budget is bounded', () => {
  assert.ok(STUCK_ACTIVE_AFTER_MS > WAKE_STALL_AFTER_MS, 'the stall row is written first');
  assert.equal(STUCK_ACTIVE_AFTER_MS, 10 * 60_000);
  assert.equal(STUCK_ACTIVE_PROOF_MS, 60_000);
  assert.equal(STUCK_ACTIVE_MAX_RECOVERIES, 3);
});

test('quiet: a lost Stop with mail waiting is recovered after the window and the mail is re-offered', () => {
  const f = floor();
  f.stuck();
  f.beat(STUCK_ACTIVE_AFTER_MS - 1_000);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'not before the window');
  assert.equal(f.submits.length, 0);
  f.beat(1_000);
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.submits.length, 1, `re-offered through the normal claim (${JSON.stringify(f.diags.filter((d) => d.stage === 'no-claim').slice(-1))})`);
  assert.deepEqual(f.submits[0].text.split(',').sort(), ['m-1', 'm-2']);
  const [row] = f.rows();
  assert.equal(row.recovered, true);
  assert.equal(row.basis, 'quiet');
  assert.equal(row.recovery, 1);
  assert.ok(f.mailCalls.some((c) => c[0] === 'abortSince' && c[1] === A && c[2] === 0 && c[3] === 'stuck-active'), 'open mail epochs end abnormally');
  assert.ok(f.mailCalls.some((c) => c[0] === 'log' && c[1].kind === 'wake-stuck-active' && c[1].recovered === true), 'a durable hive log row');
});

test('quiet: PTY output inside the window (a live turn redrawing) is never recovered', () => {
  const f = floor();
  f.stuck();
  for (let i = 0; i < 12; i++) { f.facts.lastOutputAt = f.now.t; f.beat(60_000); }
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.rows().length, 0);
});

test('quiet: hook traffic inside the window is never recovered (a long turn that still reports)', () => {
  const f = floor();
  f.stuck();
  for (let i = 0; i < 12; i++) { f.beat(60_000); f.bridge.onHook(A, 'PostToolUse'); }
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.rows().length, 0);
  // Traffic that is not a turn start (a subagent finishing inside the turn) counts too.
  const g = floor();
  g.stuck();
  for (let i = 0; i < 12; i++) { g.beat(60_000); g.bridge.onHook(A, 'SubagentStop'); }
  assert.equal(g.coordinator.state(A).lifecycle, 'active');
  assert.equal(g.rows().length, 0);
});

test('no mail waiting, a human hold, or a permission prompt: never recovered', () => {
  const noMail = floor();
  noMail.bridge.onHook(A, 'UserPromptSubmit');
  noMail.beat(STUCK_ACTIVE_AFTER_MS * 2);
  assert.equal(noMail.coordinator.state(A).lifecycle, 'active');
  for (const hold of ['paused', 'halted', 'autoDeliveryPaused', 'inhibited']) {
    const f = floor();
    f.stuck();
    f.facts[hold] = true;
    f.beat(STUCK_ACTIVE_AFTER_MS * 2);
    assert.equal(f.coordinator.state(A).lifecycle, 'active', hold);
    assert.equal(f.rows().length, 0, hold);
  }
  const hitl = floor();
  hitl.stuck();
  hitl.now.t += 1_000;
  hitl.bridge.onHook(A, 'Notification', 'Claude needs your permission to use Bash');
  hitl.beat(STUCK_ACTIVE_AFTER_MS * 2);
  assert.equal(hitl.coordinator.state(A).lifecycle, 'active', 'the agent may be waiting on a person');
  assert.equal(hitl.rows().length, 0);
});

test('coordinator: never recovers with no mail pending, or with a claim in flight', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook(A, 'UserPromptSubmit', undefined, T0);
  const facts = { ptyId: 'p', lastOutputAt: T0 };
  const late = T0 + STUCK_ACTIVE_AFTER_MS * 2;
  assert.equal(c.recoverStuckActive(A, facts, 0, late), null, 'nothing waiting: nothing is stuck');
  assert.equal(c.recoverStuckActive(A, null, 2, late), null, 'no terminal');
  assert.equal(c.recoverStuckActive(A, facts, 2, late).kind, 'recovered');
});

test('CODEX: a rollout with no turn boundary yet is no proof, and the quiet rule still applies', () => {
  const f = floor({ probe: { ok: true, latest: null } });
  f.stuck();
  f.beat(STUCK_ACTIVE_PROOF_MS * 3);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.coordinator.state(A).lifecycle, 'unknown');
  assert.equal(f.rows().at(-1).basis, 'quiet');
});

test('bounded: once per epoch; after the budget it gives up and only reports; a real Stop restores it', async () => {
  const settle = () => new Promise((r) => setImmediate(r));   // the owner's COMMITTED settles the wake
  const f = floor();
  // Budget: STUCK_ACTIVE_MAX_RECOVERIES recoveries, each a NEW stuck epoch with no Stop between.
  for (let i = 1; i <= STUCK_ACTIVE_MAX_RECOVERIES; i++) {
    f.now.t += 1_000;
    f.stuck();
    f.beat(STUCK_ACTIVE_AFTER_MS);
    assert.notEqual(f.coordinator.state(A).lifecycle, 'active', `recovery ${i}`);
    assert.equal(f.rows().at(-1).recovery, i);
    await settle();
  }
  f.now.t += 1_000;
  f.stuck();
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'gave up: left alone');
  const gave = f.rows().at(-1);
  assert.equal(gave.recovered, false);
  assert.equal(gave.why, 'max-recoveries');
  const n = f.rows().length;
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(f.rows().length, n, 'reported once per epoch, not every beat');
  // A real turn end restores the budget.
  f.bridge.onHook(A, 'Stop', undefined, true);
  f.now.t += 1_000;
  f.stuck();
  f.beat(STUCK_ACTIVE_AFTER_MS);
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.rows().at(-1).recovery, 1);
});

test('CODEX-STOP-MISSING: rollout task_complete is the turn end (Dwight 17:36Z, compaction turn, no Stop)', () => {
  const TURN = '01a0f363-0000-7000-8000-000000000001';
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: TURN, at: T0 + 40_000 } } });
  // The lifecycle went active with no turn id we can match, AFTER the rollout completion.
  f.now.t = T0 + 56_000;
  f.stuck();
  f.beat(STUCK_ACTIVE_PROOF_MS - 1_000);
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'not inside the proof window');
  f.beat(1_000);
  assert.equal(f.coordinator.state(A).lifecycle, 'unknown', 'the provider says the turn ended (unknown: the re-offer still needs 12 s of PTY quiet)');
  const [row] = f.rows();
  assert.equal(row.basis, 'rollout-complete');
  assert.equal(row.turn, TURN);
  assert.ok(f.mailCalls.some((c) => c[0] === 'closeTurn' && c[2] === TURN), 'the turn\'s mail epoch closes as a Stop would have');
  assert.ok(!f.mailCalls.some((c) => c[0] === 'abortSince'), 'not an abnormal abort');
  assert.equal(f.submits.length, 1, 'the waiting mail is delivered');
});

test('CODEX: no proof when a turn is running (newest boundary started) or a NAMED open turn differs', () => {
  const started = floor({ probe: { ok: true, latest: { kind: 'started', turnId: 'x', at: T0 } } });
  started.stuck();
  started.beat(STUCK_ACTIVE_PROOF_MS * 3);
  assert.equal(started.coordinator.state(A).lifecycle, 'active');
  started.beat(STUCK_ACTIVE_AFTER_MS * 2);
  assert.equal(started.coordinator.state(A).lifecycle, 'active', 'D3: a turn the provider says is RUNNING is never recovered, not even by the quiet rule');
  assert.equal(started.rows().length, 0);
  const other = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: 'older-turn', at: T0 - 1 } } });
  other.stuck('open-turn');
  other.beat(STUCK_ACTIVE_PROOF_MS * 3);
  assert.equal(other.coordinator.state(A).lifecycle, 'active', 'B1: a different turn\'s completion proves nothing');
  // ...but the quiet rule still applies to both after the long window.
  other.beat(STUCK_ACTIVE_AFTER_MS);
  assert.equal(other.coordinator.state(A).lifecycle, 'unknown');
  assert.equal(other.rows().at(-1).basis, 'quiet');
  const unreadable = floor({ probe: { ok: false, why: 'unreadable' } });
  unreadable.stuck();
  unreadable.beat(STUCK_ACTIVE_PROOF_MS * 3);
  assert.equal(unreadable.coordinator.state(A).lifecycle, 'active', 'an unreadable rollout is no proof');
});

test('ROOT CAUSE (Dwight 17:36Z): a compaction-only turn (PreCompact, PostCompact, task_complete, NO Stop) ends idle', () => {
  const PREV = '01a0f35d-f3b3-7da1-b9e8-294d70062be1';
  const TURN = '01a0f363-0000-7000-8000-000000000001';
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: TURN, at: T0 + 40_000 } } });
  f.bridge.onHook(A, 'Stop', undefined, true, PREV);                         // 17:33:15 the last regular turn ends
  f.now.t = T0;
  f.bridge.onHook(A, 'PreCompact', undefined, undefined, TURN);              // 17:35:47 the CompactTask starts
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'busy while compacting: no wake is typed into it');
  f.now.t = T0 + 40_000;
  f.bridge.onHook(A, 'PostCompact', undefined, undefined, TURN);             // it finishes; task_complete; no Stop
  assert.equal(f.coordinator.state(A).lifecycle, 'idle', 'the PostCompact ends a compaction-only turn');
  // Jim W3/W2: late stragglers of that closed turn (tool events AND compaction events) never re-open it.
  for (const ev of ['PostToolUse', 'PreToolUse', 'PreCompact', 'PostCompact']) {
    f.bridge.onHook(A, ev, undefined, undefined, TURN);
    assert.equal(f.coordinator.state(A).lifecycle, 'idle', `straggling ${ev}(${TURN}) re-opened the turn`);
  }
  for (const id of ['m-1', 'm-2']) { f.inbox.push(id); f.coordinator.noteDelivery(A, id); }   // 17:36:43 mail
  f.beat(15_000);
  assert.equal(f.submits.length, 1, 'delivered on the next beat, no watchdog needed');
  assert.equal(f.rows().length, 0);
});

test('Jim W2: a late PreCompact of a turn closed by its Stop never re-opens the lifecycle', () => {
  const f = floor();
  const T = '01a0f3aa-0000-7000-8000-000000000009';
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, T);
  f.bridge.onHook(A, 'PostCompact', undefined, undefined, T);
  f.bridge.onHook(A, 'Stop', undefined, true, T);
  assert.equal(f.coordinator.state(A).lifecycle, 'idle');
  f.bridge.onHook(A, 'PreCompact', undefined, undefined, T);   // the shim arrived 5-8 s late
  assert.equal(f.coordinator.state(A).lifecycle, 'idle');
});

test('Jim W1 (a): codex pre-turn compaction (before UserPromptSubmit) longer than 60 s confirms OUR wake: no abort, no second wake', async () => {
  const f = floor({ confirms: true });
  const settle = () => new Promise((r) => setImmediate(r));
  f.bridge.onHook(A, 'Stop', undefined, true, 'prev-turn');
  f.inbox.push('m-1'); f.coordinator.noteDelivery(A, 'm-1');
  f.now.t += 20_000;
  f.bridge.requestInboxWake(A, 'reconcile', 'reconcile');
  await settle();
  assert.equal(f.submits.length, 1);
  assert.equal(f.coordinator.state(A).provisional, true, 'our COMMITTED wake is provisional');
  f.now.t += 1_000;
  f.bridge.onHook(A, 'PreCompact', undefined, undefined, 'T-ours');   // turn.rs:183, before the user input
  assert.equal(f.coordinator.state(A).provisional, false, 'the compaction confirms our submit');
  for (let i = 0; i < 5; i++) { f.facts.lastOutputAt = f.now.t; f.beat(15_000); await settle(); }   // 75 s compacting, PTY busy
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'not expired as submit-unconfirmed');
  assert.ok(!f.mailCalls.some((c) => c[0] === 'abortSince'), 'no abort of our epoch');
  f.bridge.onHook(A, 'PostCompact', undefined, undefined, 'T-ours');
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, 'T-ours');
  f.beat(15_000); await settle();
  assert.equal(f.submits.length, 1, 'exactly ONE wake: none typed into the starting turn');
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
});

test('Jim W1 (b): a PostCompact with no compact epoch of its own changes nothing and is no retry edge', () => {
  const c = new WorkerWakeWatchdog();
  assert.equal(c.noteHook(A, 'PostCompact', undefined, T0), false, 'unknown: no edge');
  assert.equal(c.state(A).lifecycle, 'unknown');
  c.noteHook(A, 'Stop', undefined, T0 + 1, true);
  assert.equal(c.noteHook(A, 'PostCompact', undefined, T0 + 2), false, 'idle: no edge');
  assert.equal(c.state(A).lifecycle, 'idle');
  // Only the PostCompact that closes its OWN compact epoch is the edge.
  c.noteHook(A, 'PreCompact', undefined, T0 + 3);
  assert.equal(c.noteHook(A, 'PostCompact', undefined, T0 + 4), true);
});

test('Jim J3/J14: never with a claim in flight or held; the proof path still needs a terminal', () => {
  const late = T0 + STUCK_ACTIVE_AFTER_MS * 2;
  const facts = { ptyId: 'p', lastOutputAt: T0 };
  for (const slot of ['inFlight', 'held']) {
    const c = new WorkerWakeWatchdog();
    c.noteHook(A, 'UserPromptSubmit', undefined, T0);
    c.agents.get(A)[slot] = { agentId: A, requestId: 'r', ids: ['m-1'], cause: 'reconcile' };
    assert.equal(c.recoverStuckActive(A, facts, 2, late), null, `a claim ${slot}`);
    assert.equal(c.state(A).lifecycle, 'active');
  }
  const c = new WorkerWakeWatchdog();
  c.noteHook(A, 'UserPromptSubmit', undefined, T0);
  assert.equal(c.recoverStuckActive(A, { lastOutputAt: T0 }, 2, late, { turnId: 'x', at: T0 }), null, 'no PTY, even with proof');
  assert.equal(c.recoverStuckActive(A, { ptyId: 'p', lastOutputAt: 0 }, 2, late, { turnId: 'x', at: T0 }).basis, 'rollout-complete', 'proof needs no PTY output clock');
});

test('Jim J22: provider statusline ticks (agy running) count as traffic: a busy agy agent with a quiet PTY is not recovered', () => {
  const f = floor();
  f.stuck();
  for (let i = 0; i < 12; i++) { f.beat(60_000); f.bridge.onProviderStatus(A, 'running', null, f.now.t); }
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  assert.equal(f.rows().length, 0);
});

test('god ruling: the re-offer after a recovery needs 12 s of PTY quiet, and a FRESH rollout check (a turn started since holds it)', async () => {
  const TURN = 'c0mp-0000-7000-8000-000000000002';
  const f = floor({ probe: { ok: true, latest: { kind: 'complete', turnId: TURN, at: T0 - 1 } } });
  f.stuck();
  // the PTY printed 2 s before the recovery beat (the proof path itself ignores PTY output)
  f.facts.lastOutputAt = f.now.t + STUCK_ACTIVE_PROOF_MS - 2_000;
  f.beat(STUCK_ACTIVE_PROOF_MS);
  assert.equal(f.coordinator.state(A).lifecycle, 'unknown', 'recovered at this beat');
  assert.equal(f.submits.length, 0, 'no re-offer inside 12 s of PTY output');
  // a turn starts before the PTY settles: the rollout says so, the re-offer is held
  f.probe.current = { ok: true, latest: { kind: 'started', turnId: 'new', at: f.now.t } };
  f.beat(20_000);
  assert.equal(f.submits.length, 0, 'held: the rollout says a turn is running');
  assert.ok(f.diags.some((d) => d.stage === 'stuck-active' && d.reoffer === 'held' && d.why === 'rollout-running'));
  // the turn ends (rollout complete again), PTY quiet: the one re-offer goes out
  f.probe.current = { ok: true, latest: { kind: 'complete', turnId: 'new', at: f.now.t } };
  f.beat(20_000);
  assert.equal(f.submits.length, 1);
});

test('compaction INSIDE a regular turn changes nothing: that turn\'s Stop ends it (Claude auto-compact)', () => {
  const f = floor();
  f.bridge.onHook(A, 'UserPromptSubmit');
  f.bridge.onHook(A, 'PreCompact');
  f.bridge.onHook(A, 'PostCompact');
  assert.equal(f.coordinator.state(A).lifecycle, 'active', 'the turn is still running');
  f.bridge.onHook(A, 'Stop', undefined, true);
  assert.equal(f.coordinator.state(A).lifecycle, 'idle');
  // A compaction that turns into a regular turn (auto-compact before the prompt): the turn's Stop decides.
  const g = floor();
  g.bridge.onHook(A, 'PreCompact');
  g.bridge.onHook(A, 'UserPromptSubmit');
  g.bridge.onHook(A, 'PostCompact');
  assert.equal(g.coordinator.state(A).lifecycle, 'active', 'PostCompact does not end a regular turn');
});

test('wiring: the beat runs the watchdog after B1 and before its edges; main passes the abort reason', () => {
  const br = codeOnly(readSource('src/main/inboxWakeBridge.ts'));
  const b1 = br.indexOf('this.closeLostCodexTurn(agentId, ids)');
  const wd = br.indexOf('this.recoverStuckActive(agentId, ids)');
  const edge = br.indexOf('this.deps.coordinator.beat(agentId');
  assert.ok(b1 > 0 && wd > b1 && edge > wd);
  assert.match(br, /try \{ this\.recoverStuckActive\(agentId, ids\); \}\s*catch \(e\) \{ this\.deps\.diag\?\.\('stuck-active'/, 'a throw never takes the beat down');
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /abortSince: \(agentId, since, reason\) => \{ hookServer\.abortMailEpochsSince\(agentId, since, reason \?\? 'submit-unconfirmed'\); \}/);
  // The watchdog never types: it has no submit of its own.
  const body = br.slice(br.indexOf('private recoverStuckActive('), br.indexOf('reconcileAll(agentIds'));
  assert.doesNotMatch(body, /submit\(|requestInboxWake\(/);
});
