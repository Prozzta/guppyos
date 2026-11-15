'use strict';
require('./tools/own-job.cjs');

/**
 * CODEX-TURN-ENDS-EARLY (1.1.106) P1, the rig run (god 268cff): the real HookServer over the real
 * pipe/HTTP broker, the real Codex config.toml hooks, the real ledger and wake coordinator, with the
 * fake codex honouring a Stop {decision:'block', reason} the way Codex does: the reason is the next
 * prompt in the SAME turn (same turn_id; stop_hook_active true on the next Stop). No model, no tokens.
 *
 *   HAPPY    a 3-step request: Stops 1 and 2 are blocked, the done reply goes out in step 3 and the
 *            third Stop goes through: one turn, one chain, no OWED_NOT_BLOCKED row.
 *   CAP      4 blocks per obligation per chain, the 5th Stop goes through 'cap'; the next turn's
 *            chain starts again at block 1.
 *   NO-TOOLS a Stop whose segment made no tool call goes through, also right after a block.
 *   WAITS    each suppression lets the Stop through with its own why. Real paths: pause, a human key,
 *            a human draft, the agent's own open request, the setting off. The rig has no heavy lock,
 *            floor hold or HITL source, so those facts (and the pty/inhibit/picker guards) are set
 *            through the rig's owedWait seam, which feeds the same decide() the product calls.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, waitFor } = require('./mail-rig/driver.cjs');

const T = { timeout: 300_000 };
const ID = 'cx-1';
const SPEC = [{ id: ID, flavour: 'codex', scenario: { manualTurns: true } }];
const BEAT = { settle: false, holdWhileBusy: true, stepMs: 15_000, tries: 20 };

const kinds = (rig, kind) => rig.transcript(ID).filter((r) => r.kind === kind);
async function cue(rig, c) {
  const n = kinds(rig, 'cue-done').length;
  rig.cue(ID, c);
  await waitFor(() => kinds(rig, 'cue-done').length > n, { what: `cue ${c.cue} done` });
}
const owedRows = async (rig) => (await rig.rows('wake-stop')).filter((r) => r.agentId === ID && /^OWED_/.test(r.outcome));
async function surface(rig, msg) {
  const m = await rig.call('send', { to: ID, ...msg });
  await rig.beatUntil(() => rig.contexts(ID).some((c) => c.ids.includes(m.id)), { what: `${m.id} surfaced`, ...BEAT });
  return { m, turn: rig.contexts(ID).find((c) => c.ids.includes(m.id)).turn };
}
const request = (rig) => surface(rig, { act: 'request', subject: 'three steps', body: 'step 1, step 2, step 3, then send done' });
async function done(rig, reqId) {
  await cue(rig, { cue: 'reply', to: 'god-1', act: 'done', in_reply_to: reqId, subject: 'done', body: 'all three steps done' });
  await waitFor(async () => (await rig.entry(ID, reqId))?.repliedAt, { what: 'done routed' });
}

test('HAPPY 3-step request: Stops 1-2 blocked, done in step 3, the 3rd Stop goes through; one turn, one chain', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup(SPEC);
  const { m: req, turn } = await request(rig);
  for (const step of [1, 2]) {
    await cue(rig, { cue: 'tool' });
    await cue(rig, { cue: 'stop' });
    assert.equal(kinds(rig, 'stop-blocked').length, step, `step ${step}'s Stop is blocked`);
    assert.equal(rig.turnEnds(ID).length, 0, 'the turn stays open');
  }
  const blocked = kinds(rig, 'stop-blocked');
  assert.ok(blocked.every((b) => b.turn === turn), 'every block continued the same turn');
  assert.ok(blocked[0].reason.includes(`Request ${req.id} from god-1 is still owed`), 'the reason names the request');
  await cue(rig, { cue: 'tool' });
  await done(rig, req.id);
  await cue(rig, { cue: 'stop' });
  await waitFor(() => rig.turnEnds(ID).length === 1, { what: 'turn ended' });
  assert.equal(rig.turnEnds(ID)[0].turn, turn, 'one turn for the whole request');
  assert.equal(kinds(rig, 'stop-blocked').length, 2);
  const rows = await owedRows(rig);
  assert.deepEqual(rows.map((r) => [r.outcome, r.id, r.block, r.segmentTools]), [['OWED_BLOCKED', req.id, 1, 1], ['OWED_BLOCKED', req.id, 2, 1]], 'two blocks, nothing not-blocked: the done ended it');
  const stops = rig.hooks(ID, 'Stop');
  assert.equal(stops.length, 3, 'three Stop hooks');
  assert.ok(stops.slice(0, 2).every((h) => h.response?.decision === 'block') && !stops[2].response?.decision, 'blocks on 1-2, none on 3');
  assert.deepEqual(stops.map((h) => [h.request.turn_id, h.request.stop_hook_active]), [[turn, false], [turn, true], [turn, true]], 'the continued Stops carry the same turn_id and stop_hook_active');
  assert.equal(rig.transcript(ID).filter((r) => r.kind === 'interrupt').length, 0, 'no segment was aborted');
  const entry = await rig.entry(ID, req.id);
  assert.ok(entry.repliedAt, 'the request is discharged');
  t.diagnostic(`HAPPY stops=${stops.length} blocked=2 notBlocked=0 turns=1 done-in-one-chain=yes`);
});

test('CAP 4 blocks per obligation per chain, the 5th Stop goes through; the next turn starts a new chain', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup(SPEC);
  const { m: req, turn } = await request(rig);
  for (let i = 1; i <= 5; i++) { await cue(rig, { cue: 'tool' }); await cue(rig, { cue: 'stop' }); }
  await waitFor(() => rig.turnEnds(ID).length === 1, { what: 'turn ended at the cap' });
  assert.equal(rig.turnEnds(ID)[0].turn, turn);
  assert.equal(kinds(rig, 'stop-blocked').length, 4, 'exactly 4 blocks');
  let rows = await owedRows(rig);
  assert.deepEqual(rows.map((r) => [r.outcome, r.block ?? r.why]), [['OWED_BLOCKED', 1], ['OWED_BLOCKED', 2], ['OWED_BLOCKED', 3], ['OWED_BLOCKED', 4], ['OWED_NOT_BLOCKED', 'cap']]);
  assert.deepEqual(rows[4].ids, [req.id]);
  // The chain ended at a Stop that went through: the next turn is blocked again from 1.
  const { turn: turn2 } = await surface(rig, { act: 'inform', subject: 'nudge', body: 'carry on' });
  assert.notEqual(turn2, turn);
  await cue(rig, { cue: 'tool' });
  await cue(rig, { cue: 'stop' });
  rows = await owedRows(rig);
  assert.deepEqual([rows[5].outcome, rows[5].block], ['OWED_BLOCKED', 1], 'a new chain');
  await done(rig, req.id);
  await cue(rig, { cue: 'stop' });   // no tool, but nothing is owed now: no row
  await waitFor(() => rig.turnEnds(ID).length === 2, { what: 'turn 2 ended' });
  assert.equal((await owedRows(rig)).length, 6);
  t.diagnostic(`CAP turn1 stops=5 blocked=4 notBlocked=1(cap); turn2 block=1 then done`);
});

test('NO-TOOLS a Stop with no tool call in its segment goes through, first Stop and right after a block', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup(SPEC);
  const { m: req, turn } = await request(rig);
  await cue(rig, { cue: 'stop' });
  await waitFor(() => rig.turnEnds(ID).length === 1, { what: 'tool-free turn ended' });
  let rows = await owedRows(rig);
  assert.deepEqual(rows.map((r) => [r.outcome, r.why, r.segmentTools]), [['OWED_NOT_BLOCKED', 'no-tools', 0]]);
  assert.equal(rig.turnEnds(ID)[0].turn, turn);
  const { turn: turn2 } = await surface(rig, { act: 'inform', subject: 'nudge', body: 'carry on' });
  await cue(rig, { cue: 'tool' });
  await cue(rig, { cue: 'stop' });
  await cue(rig, { cue: 'stop' });   // the continued segment made no tool call
  await waitFor(() => rig.turnEnds(ID).length === 2, { what: 'turn 2 ended' });
  assert.equal(rig.turnEnds(ID)[1].turn, turn2);
  rows = await owedRows(rig);
  assert.deepEqual(rows.slice(1).map((r) => [r.outcome, r.block ?? r.why, r.segmentTools]), [['OWED_BLOCKED', 1, 1], ['OWED_NOT_BLOCKED', 'no-tools', 0]]);
  assert.equal(kinds(rig, 'stop-blocked').length, 1);
  t.diagnostic(`NO-TOOLS turn1 notBlocked(no-tools); turn2 blocked=1 then notBlocked(no-tools); req ${req.id} still owed`);
});

test('WAITS each suppression lets the Stop through with its own why; the setting off logs nothing', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup(SPEC);
  const { m: req } = await request(rig);
  const seam = (o) => ({ on: () => rig.call('owedWait', o), off: () => rig.call('owedWait', {}) });
  const cases = [
    ['floor-paused', seam({ floorHeld: true })],
    ['paused', { on: () => rig.call('pause', { id: ID, on: true }), off: () => rig.call('pause', { id: ID, on: false }) }],
    ['halted', seam({ halted: true })],
    ['auto-delivery-paused', seam({ autoDeliveryPaused: true })],
    ['hitl', seam({ hitl: true })],
    ['heavy-holder', seam({ heavyHolder: true })],
    ['heavy-queued', seam({ heavyQueued: true })],
    ['newest-sent-request', { on: () => rig.call('owedWait', { sent: [{ id: 'rig-ask', to: 'god-1', act: 'request', at: Date.now(), open: false }] }), off: () => rig.call('owedWait', {}) }],
    ['pending-mail', seam({ pendingMail: 1 })],
    ['no-pty', seam({ pty: false })],
    ['inhibited', seam({ inhibited: true })],
    ['picker', seam({ promptBlock: 'picker' })],
    ['exited', seam({ promptBlock: 'exited' })],
    ['draft', { on: () => rig.call('humanType', { id: ID, text: 'abc' }), off: () => rig.call('humanType', { id: ID, text: '\x15' }) }],
    ['human-input', { on: () => rig.call('humanType', { id: ID, text: '\x15' }), off: async () => {} }],
    ['off', { on: () => rig.call('owedStopSetting', { setting: { codex: false } }), off: () => rig.call('owedStopSetting', { setting: undefined }) }],
    ['outgoing-request', { on: async () => {
      await cue(rig, { cue: 'reply', to: 'god-1', act: 'request', subject: 'need input', body: 'which db?' });
      await waitFor(async () => Object.values((await rig.call('ledger', { id: 'god-1' })).entries).some((e) => e.from === ID && e.act === 'request'), { what: 'own request routed' });
    }, off: async () => {} }]
  ];
  const seen = [];
  for (let k = 0; k < cases.length; k++) {
    const [why, c] = cases[k];
    if (k > 0) await surface(rig, { act: 'inform', subject: `turn ${k + 1}`, body: 'carry on' });
    await cue(rig, { cue: 'tool' });
    const before = (await owedRows(rig)).length;
    await c.on();
    await cue(rig, { cue: 'stop' });
    await waitFor(() => rig.turnEnds(ID).length === k + 1, { what: `${why}: the Stop went through` });
    const rows = (await owedRows(rig)).slice(before);
    if (why === 'off') assert.deepEqual(rows, [], 'the setting off: never decided, no row');
    else assert.deepEqual(rows.map((r) => [r.outcome, r.why, r.ids]), [['OWED_NOT_BLOCKED', why, [req.id]]], `${why}: not blocked`);
    seen.push(why);
    await c.off();
  }
  assert.equal(kinds(rig, 'stop-blocked').length, 0, 'no wait was blocked');
  assert.equal(rig.turnEnds(ID).length, cases.length, 'one Stop per turn, each went through');
  t.diagnostic(`WAITS ${seen.length} turns, 0 blocked: ${seen.join(', ')}`);
});
