'use strict';
/**
 * HIVE-DWIGHT-BG-REINVOKE: the owed-work continuation end to end on the fake-agent rig (the beat is
 * the runWorkerWakeBeat body, rig-host mirrors runOwedContinuation). A Codex stub acts on god's
 * request, answers it only with an inform (the 02:59Z shape) and stops: while it is paused the
 * continuation is held back (one suppressed row); unpaused it gets ONE continuation mail, which the
 * normal wake path submits; no second one inside the hour. Zero model tokens.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, waitFor } = require('./mail-rig/driver.cjs');

const T = { timeout: 180_000 };
const ID = 'cx-1';
const acted = async (rig, id) => (await rig.entry(ID, id))?.state === 'acted';
const continuations = async (rig) => Object.values((await rig.call('ledger', { id: ID })).entries)
  .filter((e) => e.from === 'system' && e.subject.startsWith('CONTINUE:'));
const owedRows = async (rig) => (await rig.rows('wake')).filter((r) => r.agentId === ID && /^continuation/.test(r.stage));

test('OWED RIG: an inform-only reply then a Stop: held while paused, then ONE continuation through the wake, none again inside the hour', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: ID, flavour: 'codex', scenario: {} }]);
  const req = await rig.call('send', { to: ID, act: 'request', subject: 'build the thing', body: 'please build it' });
  await rig.beatUntil(() => acted(rig, req.id), { what: 'the request acted in a wake turn' });
  await rig.call('pause', { id: ID, on: true });
  rig.cue(ID, { cue: 'reply', to: 'god-1', act: 'inform', in_reply_to: req.id, subject: 'started', body: 'started; continuing', file: 'interim' });
  await waitFor(async () => (await rig.entry(ID, req.id)).replyAct === 'inform', { what: 'the interim reply routed' });

  for (let i = 0; i < 4; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); }
  assert.deepEqual((await owedRows(rig)).map((r) => [r.stage, r.ids, r.suppressedBy]), [['continuation', [req.id], 'paused']], 'paused: one suppressed row, no mail');
  assert.equal((await continuations(rig)).length, 0);

  await rig.call('pause', { id: ID, on: false });
  await rig.beatUntil(async () => (await continuations(rig)).length === 1 && acted(rig, (await continuations(rig))[0].id), { what: 'the continuation was delivered and acted' });
  const [c] = await continuations(rig);
  assert.ok(c.subject.startsWith('CONTINUE: your turn ended with work still owed'));
  assert.ok(rig.contexts(ID).some((x) => x.ids.includes(c.id)), 'the wake turn carried it');
  const rows = await owedRows(rig);
  assert.deepEqual(rows.filter((r) => !r.suppressedBy).map((r) => [r.stage, r.ids]), [['continuation', [req.id]]]);

  for (let i = 0; i < 6; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); }
  assert.equal((await continuations(rig)).length, 1, 'inside the hour: no second continuation');

  rig.cue(ID, { cue: 'reply', to: 'god-1', act: 'done', in_reply_to: req.id, subject: 'built', body: 'done', file: 'final' });
  await waitFor(async () => (await rig.entry(ID, req.id)).replyAct === 'done', { what: 'the done upgraded the interim reply' });
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 30 * 60_000 }); await rig.beat(); }
  assert.equal((await continuations(rig)).length, 1, 'discharged: nothing more, however long it idles');
});
