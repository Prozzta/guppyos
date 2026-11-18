'use strict';
require('./tools/own-job.cjs');

/**
 * CODEX-TURN-ENDS-EARLY (god c7c868): a Codex agent ends its turn after one milestone of a
 * multi-step request, and Guppy re-invoked owed work only hourly, twice.
 *  P1 (src/main/owedStop.ts + HookServer): the agent's own Stop, with a request still owed, is
 *     blocked with a short fixed reason; every legitimate wait and human guard holds it back; at
 *     most 4 blocks per obligation per chain; a tool-free segment is never blocked; Codex only.
 *  P2 (src/main/owedContinuation.ts): a Codex agent that made tool calls since its last
 *     continuation is continued again after 5 min, up to 6, then STALL; otherwise as before.
 *  The wiring in index.ts (source pins).
 * Pure fakes and one HookServer on a jailed hive: no PTY, no timers, nothing typed anywhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-owed-stop-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const L = loadTs('src/main/mailLedger.ts');
const O = loadTs('src/main/owedContinuation.ts');
const S = loadTs('src/main/owedStop.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const A = 'dwight-1';
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-15T03:00:00.000Z');
const Q1 = '2026-11-15T03-00-00-000Z-q11111';
const Q2 = '2026-11-15T03-01-00-000Z-q22222';

/** A request delivered and shown to the agent (surfacing: the turn that got it is still open). */
function shownDoc(reqs, doc = L.emptyLedger(A)) {
  for (const r of reqs) doc = L.applyDelivered(doc, { id: r.id, from: r.from ?? 'god', act: r.act ?? 'request', subject: `s-${r.id}`, body: 'b' }, r.at).doc;
  return L.applyClaimSurfacing(doc, reqs.map((r) => r.id), 'e1', 'UserPromptSubmit', reqs[reqs.length - 1].at + 1).doc;
}
const entriesOf = (doc) => Object.values(doc.entries);

/** Nothing holds the block back. */
const clear = (over = {}) => ({
  pendingMail: 0, paused: false, halted: false, autoDeliveryPaused: false, hitl: false, heavyQueued: false, heavyHolder: false, floorHeld: false,
  sent: [], pty: true, inhibited: false, ...over
});

const ONE = () => shownDoc([{ id: Q1, at: T0 }]);
const decide = (os1, { doc = ONE(), provider = 'codex', setting, tools = 1, now = T0 + MIN, over = {} } = {}) =>
  os1.decide(A, provider, setting, tools, now, entriesOf(doc), () => clear(over));

// ————————————————————————————————————————————————— P1: the decision

test('P1: Codex is on by default; {codex:false} turns it off; Claude, AGY and others never get it, whatever the setting', () => {
  assert.equal(S.owedStopOn('codex', undefined), true);
  assert.equal(S.owedStopOn('codex', {}), true);
  assert.equal(S.owedStopOn('codex', { codex: true }), true);
  assert.equal(S.owedStopOn('codex', { codex: false }), false);
  for (const p of ['claude', 'antigravity', 'cursor', undefined, null]) {
    assert.equal(S.owedStopOn(p, { codex: true, claude: true, antigravity: true }), false, String(p));
    const os1 = new S.OwedStopContinue(0);
    let read = 0;
    const d = os1.decide(A, p, { codex: true, claude: true, antigravity: true }, 5, T0 + MIN, entriesOf(ONE()), () => { read++; return clear(); });
    assert.deepEqual(d, { reason: null, row: null }, `${p}: the Stop goes through, no row`);
    assert.equal(read, 0, `${p}: no facts read`);
  }
  const off = new S.OwedStopContinue(0);
  assert.deepEqual(decide(off, { setting: { codex: false } }), { reason: null, row: null });
});

test('P1: a shown request still owed blocks the Stop with the fixed reason naming it', () => {
  const os1 = new S.OwedStopContinue(0);
  const d = decide(os1, { tools: 3 });
  assert.equal(d.reason, `Request ${Q1} from god is still owed. Do the next step now. End your turn only after you send done or refuse (in_reply_to ${Q1}), or a query or request naming what you wait on.`);
  assert.deepEqual(d.row, { kind: 'wake-stop', agentId: A, provider: 'codex', outcome: 'OWED_BLOCKED', id: Q1, block: 1, max: 4, chainBlock: 1, chainMax: 8, segmentTools: 3, reasonChars: d.reason.length });
  assert.equal(S.OWED_STOP_MAX, 4);
});

test('P1: the cap is 4 blocks per obligation per chain; the 5th Stop goes through and a new chain starts again', () => {
  const os1 = new S.OwedStopContinue(0);
  for (let i = 1; i <= 4; i++) {
    const d = decide(os1);
    assert.ok(d.reason, `block ${i}`);
    assert.equal(d.row.block, i);
    assert.equal(os1.spent(A, Q1), i);
  }
  const fifth = decide(os1);
  assert.equal(fifth.reason, null, 'the 5th Stop of the chain goes through');
  assert.deepEqual(fifth.row, { kind: 'wake-stop', agentId: A, provider: 'codex', outcome: 'OWED_NOT_BLOCKED', why: 'cap', ids: [Q1], segmentTools: 1 });
  assert.equal(os1.spent(A, Q1), 0, 'a Stop that went through ends the chain');
  assert.ok(decide(os1).reason, 'the next chain (a new turn) gets its own 4');
});

test('P1: with two obligations, the oldest with blocks left is named; past 4 the next one is', () => {
  const doc = shownDoc([{ id: Q1, at: T0 }, { id: Q2, at: T0 + MIN }]);
  const os1 = new S.OwedStopContinue(0);
  const named = [];
  for (let i = 0; i < 9; i++) named.push(decide(os1, { doc, now: T0 + 2 * MIN }).row);
  assert.deepEqual(named.slice(0, 8).map((r) => r.id), [Q1, Q1, Q1, Q1, Q2, Q2, Q2, Q2]);
  assert.equal(named[8].why, 'cap');
  assert.deepEqual(named[8].ids, [Q1, Q2]);
});

test('P1: the chain cap is 8 blocks in all across obligations; the 9th Stop goes through chain-cap and a new chain starts', () => {
  const Q3 = '2026-11-15T03-02-00-000Z-q33333';
  const doc = shownDoc([{ id: Q1, at: T0 }, { id: Q2, at: T0 + MIN }, { id: Q3, at: T0 + 2 * MIN }]);
  const os1 = new S.OwedStopContinue(0);
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(decide(os1, { doc, now: T0 + 3 * MIN }).row);
  assert.equal(S.OWED_STOP_CHAIN_MAX, 8);
  assert.deepEqual(rows.slice(0, 8).map((r) => [r.id, r.block, r.chainBlock]), [[Q1, 1, 1], [Q1, 2, 2], [Q1, 3, 3], [Q1, 4, 4], [Q2, 1, 5], [Q2, 2, 6], [Q2, 3, 7], [Q2, 4, 8]]);
  assert.deepEqual([rows[8].outcome, rows[8].why, rows[8].ids], ['OWED_NOT_BLOCKED', 'chain-cap', [Q1, Q2, Q3]], 'Q3 has blocks left, but the chain has spent 8');
  const again = decide(os1, { doc, now: T0 + 3 * MIN });
  assert.deepEqual([again.row.outcome, again.row.id, again.row.block, again.row.chainBlock], ['OWED_BLOCKED', Q1, 1, 1], 'the Stop that went through ended the chain');
});

test('P1: a tool-free segment is never blocked (an answer or a real wait), and it ends the chain', () => {
  const os1 = new S.OwedStopContinue(0);
  decide(os1); decide(os1);
  assert.equal(os1.spent(A, Q1), 2);
  let read = 0;
  const d = os1.decide(A, 'codex', undefined, 0, T0 + MIN, entriesOf(ONE()), () => { read++; return clear(); });
  assert.equal(d.reason, null);
  assert.equal(d.row.why, 'no-tools');
  assert.equal(read, 0, 'no facts read for a tool-free segment');
  assert.equal(os1.spent(A, Q1), 0);
  assert.equal(decide(os1).row.block, 1);
});

test('P1: every legitimate wait holds the block back (and the Stop ends the chain)', () => {
  const cases = [
    ['floor-paused', { floorHeld: true }],
    ['paused', { paused: true }],
    ['halted', { halted: true }],
    ['auto-delivery-paused', { autoDeliveryPaused: true }],
    ['hitl', { hitl: true }],
    ['heavy-holder', { heavyHolder: true }],
    ['heavy-queued', { heavyQueued: true }],
    ['outgoing-request', { sent: [{ id: 'mine', to: 'jim', act: 'request', at: T0 + 10, open: true }] }],
    ['pending-mail', { pendingMail: 1 }],
    ['no-pty', { pty: false }],
    ['inhibited', { inhibited: true }],
    ['draft', { promptBlock: 'draft' }],
    ['picker', { promptBlock: 'picker' }],
    ['exited', { promptBlock: 'exited' }],
    ['human-input', { lastHumanInputAt: T0 + MIN - 1_499 }]
  ];
  for (const [why, over] of cases) {
    const os1 = new S.OwedStopContinue(0);
    assert.ok(decide(os1).reason);
    const d = decide(os1, { over });
    assert.equal(d.reason, null, why);
    assert.equal(d.row.outcome, 'OWED_NOT_BLOCKED', why);
    assert.equal(d.row.why, why);
    assert.equal(os1.spent(A, Q1), 0, `${why}: the chain ended`);
  }
  // The newest sent message a request, with nothing reaching the agent since (owedSuppressor's rule).
  const os2 = new S.OwedStopContinue(0);
  const late = decide(os2, { over: { sent: [{ id: 'mine', to: 'jim', act: 'request', at: T0 + 10, open: false }] } });
  assert.equal(late.row.why, 'newest-sent-request');
  // Not waits: a closed request answered since, a key 1.5 s ago, an idle prompt.
  const os3 = new S.OwedStopContinue(0);
  assert.ok(decide(os3, { over: { lastHumanInputAt: T0 + MIN - 1_500, promptBlock: 'idle' } }).reason);
  assert.ok(decide(os3, { over: { sent: [{ id: 'old', to: 'jim', act: 'request', at: T0 - 10, open: false }] } }).reason, 'the owed request reached the agent after it');
});

test('P1: what is owed: shown, from another agent, not discharged, since the app start, inside the window', () => {
  const os1 = new S.OwedStopContinue(0);
  // Only delivered (not shown): the wake brings it; nothing owed here.
  let doc = L.applyDelivered(L.emptyLedger(A), { id: Q1, from: 'god', act: 'request', subject: 's', body: 'b' }, T0).doc;
  assert.deepEqual(decide(os1, { doc }), { reason: null, row: null });
  // An inform, a system request and the agent's own are not owed.
  for (const r of [{ id: Q1, at: T0, act: 'inform' }, { id: Q1, at: T0, from: 'system' }, { id: Q1, at: T0, from: A }]) {
    assert.deepEqual(decide(os1, { doc: shownDoc([r]) }), { reason: null, row: null }, JSON.stringify(r));
  }
  // An inform/agree reply keeps it owed; done and refuse discharge it.
  for (const act of ['inform', 'agree']) assert.ok(decide(new S.OwedStopContinue(0), { doc: L.applyReplied(ONE(), Q1, 'r1', T0 + 10, 'god', act).doc }).reason, act);
  for (const act of ['done', 'refuse']) assert.deepEqual(decide(new S.OwedStopContinue(0), { doc: L.applyReplied(ONE(), Q1, 'r1', T0 + 10, 'god', act).doc }), { reason: null, row: null }, act);
  // Shown before the app start, or delivered past the 6 h window: not followed.
  assert.deepEqual(decide(new S.OwedStopContinue(T0 + 5)), { reason: null, row: null });
  assert.deepEqual(decide(new S.OwedStopContinue(0), { now: T0 + O.OWED_WINDOW_MS + 1 }), { reason: null, row: null });
  assert.ok(decide(new S.OwedStopContinue(0), { now: T0 + O.OWED_WINDOW_MS }).reason);
});

// ————————————————————————————————————————————————— P1: the HookServer Stop

async function rig(t, provider) {
  const home = fs.mkdtempSync(path.join(JAIL, 'rig-'));
  const hive = new HiveManager(() => home, () => true);
  let server = null;
  t.after(async () => { try { server?.stop(); } catch { /* noop */ } hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: A, name: 'Dwight', provider, cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r0 = reg(); const r = { ...r0, agents: { ...r0.agents } }; r.agents[A] = { ...r.agents[A], provider }; return r; };
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const w = { calls: [], rows: [], mailBlocks: 0, over: {} };
  server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, () => null, () => {});
  server.setMailCoordination({ lifecycleActive: () => true, wakeIds: () => [], onEpochClosed: () => {}, onMailBlock: () => { w.mailBlocks++; } });
  const owed = new S.OwedStopContinue(0);
  server.setOwedStop({
    decide: (agentId, prov, segmentTools) => {
      w.calls.push({ agentId, prov, segmentTools });
      const d = owed.decide(agentId, prov, undefined, segmentTools, Date.now(), Object.values(hive.mail.ledger(agentId).entries), () => clear(w.over));
      if (d.row) w.rows.push(d.row);
      return d.reason;
    }
  });
  w.fire = (hook_event_name, extra = {}) => server.handle({ agent_id: A, hook_event_name, session_id: 's-a', transport: 'http', ...extra });
  w.tool = () => { w.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }); w.fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }); };
  Object.assign(w, { hive, server, owed });
  return w;
}

/** A turn that gets a request from god (shown at its UserPromptSubmit). */
async function turnWithRequest(w) {
  const m = w.hive.send({ to: A, act: 'request', subject: 'build P1', body: 'three steps' }, 'god-1');
  const ups = w.fire('UserPromptSubmit', { prompt: '[hive] check inbox' });
  assert.match(JSON.stringify(ups), new RegExp(m.id), 'the request is shown in the turn');
  assert.equal(w.hive.mail.ledger(A).entries[m.id].state, 'surfacing');
  return m;
}

test('P1 HookServer: a Codex Stop after a tool call is blocked with the owed reason; the turn stays open; no mail-block signal', async (t) => {
  const w = await rig(t, 'codex');
  const m = await turnWithRequest(w);
  const epoch = w.server.mailEpoch(A);
  w.tool();
  const blocksBefore = w.mailBlocks;
  const res = w.fire('Stop');
  assert.equal(res.decision, 'block');
  assert.equal(res.reason, S.owedStopReason({ id: m.id, from: 'god-1' }));
  assert.deepEqual(w.calls, [{ agentId: A, prov: 'codex', segmentTools: 1 }]);
  assert.equal(w.mailBlocks, blocksBefore, 'an owed block carried no mail (no onMailBlock)');
  assert.equal(w.server.mailEpoch(A), epoch, 'the epoch stays open: the turn goes on');
  assert.equal(w.hive.mail.ledger(A).entries[m.id].state, 'surfacing', 'not closed (acted) by the blocked Stop');
  // The continued segment (stop_hook_active set): two tools, blocked again, counted per segment.
  w.tool(); w.tool();
  const res2 = w.fire('Stop', { stop_hook_active: true });
  assert.equal(res2.decision, 'block');
  assert.equal(w.calls[1].segmentTools, 2);
  // Two more, then the 4-block cap lets the 5th through, which closes the turn.
  w.tool(); assert.equal(w.fire('Stop', { stop_hook_active: true }).decision, 'block');
  w.tool(); assert.equal(w.fire('Stop', { stop_hook_active: true }).decision, 'block');
  w.tool();
  const fifth = w.fire('Stop', { stop_hook_active: true });
  assert.notEqual(fifth?.decision, 'block');
  assert.deepEqual(w.rows.map((r) => r.outcome), ['OWED_BLOCKED', 'OWED_BLOCKED', 'OWED_BLOCKED', 'OWED_BLOCKED', 'OWED_NOT_BLOCKED']);
  assert.equal(w.rows[4].why, 'cap');
  assert.notEqual(w.hive.mail.ledger(A).entries[m.id].state, 'surfacing', 'the Stop that went through closed the turn\'s epoch');
});

test('P1 HookServer: a tool-free segment goes through, after a block too', async (t) => {
  const w = await rig(t, 'codex');
  await turnWithRequest(w);
  const res = w.fire('Stop');
  assert.notEqual(res?.decision, 'block', 'the first segment made no tool call');
  assert.equal(w.calls[0].segmentTools, 0);
  assert.equal(w.rows[0].why, 'no-tools');
  await turnWithRequest(w);
  w.tool();
  assert.equal(w.fire('Stop').decision, 'block');
  assert.notEqual(w.fire('Stop', { stop_hook_active: true })?.decision, 'block', 'the continued segment ended with no tool call');
  assert.equal(w.calls.at(-1).segmentTools, 0);
});

test('P1 HookServer: a legitimate wait or a human guard lets the Stop through', async (t) => {
  for (const over of [{ heavyHolder: true }, { promptBlock: 'draft' }, { lastHumanInputAt: Date.now() }]) {
    const w = await rig(t, 'codex');
    w.over = over;
    await turnWithRequest(w);
    w.tool();
    assert.notEqual(w.fire('Stop')?.decision, 'block', JSON.stringify(over));
  }
});

test('P1 HookServer: Claude and AGY Stops are unchanged (the setting is off for them)', async (t) => {
  for (const provider of ['claude', 'antigravity']) {
    const w = await rig(t, provider);
    w.hive.send({ to: A, act: 'request', subject: 'build', body: 'b' }, 'god-1');
    w.fire(provider === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit', { prompt: 'go' });
    w.tool();
    const res = w.fire('Stop');
    assert.notEqual(res?.decision, 'block', provider);
    assert.deepEqual(w.rows, [], `${provider}: no owed row`);
    assert.equal(w.calls[0]?.prov, provider);
  }
});

test('P1 HookServer: a subagent Stop, a straggler Stop for another turn, a one-way pipe and a Stop with no open turn are never asked', async (t) => {
  const w0 = await rig(t, 'codex');
  w0.fire('Stop');
  assert.deepEqual(w0.calls, [], 'no open turn (an app restart lost it)');
  const w = await rig(t, 'codex');
  await turnWithRequest(w);
  w.tool();
  w.fire('Stop', { provider_agent_id: 'sub-1' });
  w.fire('Stop', { turn_id: 'another-turn' });
  assert.deepEqual(w.calls, []);
  assert.equal(w.fire('Stop').decision, 'block', 'the agent\'s own Stop still is');
  const w2 = await rig(t, 'codex');
  await turnWithRequest(w2);
  w2.tool();
  assert.notEqual(w2.fire('Stop', { transport: 'pipe-oneway' })?.decision, 'block');
  assert.deepEqual(w2.calls, [], 'a one-way pipe cannot carry a block');
  const w3 = await rig(t, 'codex');
  await turnWithRequest(w3);
  w3.tool();
  w3.hive.mail.setChannelOverride(A, { mode: 'legacy-read', reason: 'zero-hook-traffic', since: Date.now() });
  assert.equal(w3.server.mailChannel(A).mode, 'legacy-read');
  assert.notEqual(w3.fire('Stop')?.decision, 'block');
  assert.deepEqual(w3.calls, [], 'a Codex agent degraded to legacy-read is never asked');
});

// ————————————————————————————————————————————————— P2: the Codex continuation cadence

function idleFacts(doc, stop, now, extra = {}) {
  return {
    now, lifecycle: 'idle', lastTurnEndAt: stop, inFlight: false, pendingMail: 0,
    paused: false, halted: false, autoDeliveryPaused: false, hitl: false, heavyQueued: false, heavyHolder: false, floorHeld: false,
    entries: Object.values(doc.entries), sent: [], ...extra
  };
}
function actedDoc() {
  let doc = L.applyDelivered(L.emptyLedger(A), { id: Q1, from: 'god', act: 'request', subject: 'build', body: 'b' }, T0).doc;
  doc = L.applyClaimSurfacing(doc, [Q1], 'e1', 'UserPromptSubmit', T0 + 1).doc;
  doc = L.applyConfirmSurfaced(doc, [Q1], 'e1', 'evidence', T0 + 1).doc;
  return L.applyCloseEpoch(doc, 'e1', 'normal', T0 + 2).doc;
}

test('P2: a working Codex agent is continued again after 5 min, up to 6, then STALL to god', () => {
  assert.equal(O.OWED_REPEAT_CODEX_MS, 5 * MIN);
  assert.equal(O.OWED_MAX_CODEX, 6);
  const doc = actedDoc();
  const w = new O.OwedContinuation(0, () => 'god');
  let stop = T0 + MIN;
  let now = stop + O.OWED_GRACE_MS;
  let tools = 3;
  const first = w.tick(A, idleFacts(doc, stop, now, { provider: 'codex', toolCalls: tools }));
  assert.ok(first.nudge, 'the first after the 3 min grace, as before');
  for (let n = 2; n <= 6; n++) {
    tools += 2;
    stop = now + 30_000;
    const early = w.tick(A, idleFacts(doc, stop, now + O.OWED_REPEAT_CODEX_MS - 1, { provider: 'codex', toolCalls: tools }));
    assert.equal(early.nudge, undefined, `#${n}: not before 5 min`);
    now += O.OWED_REPEAT_CODEX_MS;
    const d = w.tick(A, idleFacts(doc, stop, now, { provider: 'codex', toolCalls: tools }));
    assert.ok(d.nudge, `#${n} at 5 min`);
  }
  tools += 1;
  stop = now + 30_000;
  now += O.OWED_REPEAT_CODEX_MS;
  const gave = w.tick(A, idleFacts(doc, stop, now, { provider: 'codex', toolCalls: tools }));
  assert.equal(gave.nudge, undefined);
  assert.deepEqual(gave.rows, [{ kind: 'wake', stage: 'continuation-gave-up', agentId: A, ids: [Q1], continuations: 6, idleMs: now - stop }]);
  assert.match(gave.notice.message.subject, /after 6 continuations/);
  assert.equal(gave.notice.message.to, 'god');
  assert.deepEqual(w.tick(A, idleFacts(doc, stop + 1, now + HOUR, { provider: 'codex', toolCalls: tools + 9 })).rows, [], 'never a loop');
});

test('P2: no tool call since the last continuation = the hourly repeat and the cap of 2, as before', () => {
  const doc = actedDoc();
  const w = new O.OwedContinuation(0, () => 'god');
  const stop = T0 + MIN;
  const now = stop + O.OWED_GRACE_MS;
  assert.ok(w.tick(A, idleFacts(doc, stop, now, { provider: 'codex', toolCalls: 4 })).nudge);
  const stop2 = now + 10_000;
  assert.equal(w.tick(A, idleFacts(doc, stop2, now + 30 * MIN, { provider: 'codex', toolCalls: 4 })).nudge, undefined, 'no progress: not at 5 or 30 min');
  assert.ok(w.tick(A, idleFacts(doc, stop2, now + HOUR, { provider: 'codex', toolCalls: 4 })).nudge, 'the hourly repeat');
  const stop3 = now + HOUR + 10_000;
  const gave = w.tick(A, idleFacts(doc, stop3, now + 2 * HOUR, { provider: 'codex', toolCalls: 4 }));
  assert.equal(gave.rows[0].stage, 'continuation-gave-up');
  assert.equal(gave.rows[0].continuations, 2);
  assert.match(gave.notice.message.subject, /after 2 continuations/);
});

test('P2: Claude and AGY keep the hourly cadence and the cap of 2, tool calls or not', () => {
  for (const provider of ['claude', 'antigravity', undefined]) {
    const doc = actedDoc();
    const w = new O.OwedContinuation(0, () => 'god');
    const stop = T0 + MIN;
    const now = stop + O.OWED_GRACE_MS;
    assert.ok(w.tick(A, idleFacts(doc, stop, now, { provider, toolCalls: 1 })).nudge);
    const stop2 = now + 10_000;
    assert.equal(w.tick(A, idleFacts(doc, stop2, now + O.OWED_REPEAT_CODEX_MS, { provider, toolCalls: 50 })).nudge, undefined, `${provider}: not at 5 min`);
    assert.ok(w.tick(A, idleFacts(doc, stop2, now + HOUR, { provider, toolCalls: 60 })).nudge);
    const gave = w.tick(A, idleFacts(doc, now + HOUR + 10_000, now + 2 * HOUR, { provider, toolCalls: 99 }));
    assert.equal(gave.rows[0].continuations, 2, String(provider));
  }
});

test('P2: the 5 min repeat still waits for a new Stop and for the suppressors', () => {
  const doc = actedDoc();
  const w = new O.OwedContinuation(0, () => 'god');
  const stop = T0 + MIN;
  const now = stop + O.OWED_GRACE_MS;
  assert.ok(w.tick(A, idleFacts(doc, stop, now, { provider: 'codex', toolCalls: 1 })).nudge);
  assert.equal(w.tick(A, idleFacts(doc, stop, now + 10 * MIN, { provider: 'codex', toolCalls: 5 })).nudge, undefined, 'no Stop since the continuation');
  const held = w.tick(A, idleFacts(doc, now + 1, now + 10 * MIN, { provider: 'codex', toolCalls: 5, heavyHolder: true }));
  assert.equal(held.nudge, undefined);
  assert.equal(held.rows[0].suppressedBy, 'heavy-holder');
});

// ————————————————————————————————————————————————— wiring

test('wiring: main hands the HookServer the owed-stop decision with the setting, the ledger and the guards; P2 gets provider and tool calls', () => {
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /hookServer\.setOwedStop\(\{ decide: \(agentId, provider, segmentTools\) => decideOwedStop\(agentId, provider, segmentTools\) \}\)/);
  const fn = idx.slice(idx.indexOf('function decideOwedStop'), idx.indexOf('function runOwedContinuation'));
  for (const re of [/readConfig\(\)\.owedStopContinue/, /hive\.mail\.ledger\(agentId\)\.entries/, /owedWaitFacts\(agentId, now, owedSentBy\(\[agentId\]\)/, /automaticSubmit\.inhibition\(ptyId\)/, /promptState\(ptyId\)/, /\bpty: !!ptyId,/, /\.\.\.\(s\?\.block \? \{ promptBlock: s\.block \} : \{\}\)/, /lastHumanInputAt\(ptyId\)/, /hive\.appendLog\(d\.row\)/]) assert.match(fn, re);
  const run = idx.slice(idx.indexOf('function runOwedContinuation'), idx.indexOf('function runWorkerWakeBeat'));
  assert.match(run, /provider: hookServer\.mailChannel\(agentId\)\.provider \?\? null/);
  assert.match(run, /toolCalls: hookServer\.toolCallCount\(agentId\)/);
  const hooks = codeOnly(readSource('src/main/hooks.ts'));
  assert.match(hooks, /if \(stopReason === null\) \{\s*try \{ stopReason = this\.owedStopReason\(agentId, p, segmentTools\); \}/, 'the M4 mail block goes first');
  assert.match(hooks, /if \(!owedBlock\) \{ try \{ this\.coordination\?\.onMailBlock\?\.\(agentId\); \}/);
});
