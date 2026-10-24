'use strict';
require('./tools/own-job.cjs');

/**
 * WAKE-FALSE-INTERFERED-RESTART (1.1.98), the rig half: the owner's WAKE_TYPED_NOT_SENT latch set
 * the way 1.1.98 set it on Creed at 12:18:50Z (`holdTyped`), then the floor's own sequence:
 *
 *   R1  12:18 -> 12:20Z: the held wake's mail is read in a turn god starts (term send); the ids
 *       surface -> the look ends the hold SUBMITTED 'surfaced', the latch is gone, the next mail
 *       wakes the agent (1.1.98: 'owner-inhibited' for 3 hours).
 *   R2  14:55 -> 15:24Z: a latch with NO mail behind it (its ids long acted); a new message is
 *       refused 'owner-inhibited' AND that refusal is a row (a delivery's no-claim never folds);
 *       god's term send runs a turn whose Stop leaves the composer empty -> the look releases it,
 *       and the mail still waiting wakes the agent on the next beat.
 *
 * The rig has no term-path WakeSender (its wakes are the owner's), so the 12:18:50Z judgment itself
 * (screen seen nowhere -> UNKNOWN, re-confirm, owner) is replayed in wake-false-interfered-198.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, waitFor, sleep } = require('./mail-rig/driver.cjs');

const T = { timeout: 180_000 };
const acted = async (rig, agentId, id) => (await rig.entry(agentId, id))?.state === 'acted';
const refusals = async (rig, agentId, since = 0) => (await rig.call('diags', { since })).filter((d) => d.stage === 'no-claim' && d.agentId === agentId);

test('R1 the 12:18Z latch: ids surfaced by a turn god started end the typed-wake hold; the next mail wakes', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-a', flavour: 'claude', scenario: {} }]);
  await rig.call('capacityHold', { on: true });                       // the wake cannot run yet: m1 sits delivered
  const m1 = await rig.call('send', { to: 'cl-a', subject: 'r1', body: 'the wake typed after the restart' });
  await rig.beat();
  const latch = await rig.call('holdTyped', { id: 'cl-a', ids: [m1.id] });
  assert.equal(latch?.reason, 'WAKE_TYPED_NOT_SENT', 'the latch is set as 1.1.98 set it');
  await rig.call('capacityHold', { on: false });
  const t0 = Date.now();
  await rig.beat(); await sleep(300);
  const refused = await refusals(rig, 'cl-a', t0);
  assert.ok(refused.some((d) => d.why === 'owner-inhibited'), `the latch refuses the wake 'owner-inhibited' (got ${JSON.stringify(refused.map((d) => d.why))})`);
  assert.equal(rig.prompts('cl-a').length, 0, 'nothing typed while latched');
  assert.deepEqual([(await rig.call('recheckHeld', { id: 'cl-a' })).kind], ['HELD'], 'no proof yet: held');

  // 12:20:10Z: god's turn (term send) reads the inbox; the id surfaces and is acted.
  const sent = await rig.call('term', { body: { action: 'send', agent: 'cl-a', text: 'read your inbox' } });
  assert.equal(sent.body.ok, true, sent.body.line);
  await waitFor(() => acted(rig, 'cl-a', m1.id), { what: "god's turn acts m1" });
  assert.ok(rig.contexts('cl-a').some((c) => c.ids.includes(m1.id)), 'm1 surfaced in that turn');

  await sleep(1_700);   // HUMAN_QUIET_MS after god's keys
  const look = await rig.call('recheckHeld', { id: 'cl-a' });
  assert.deepEqual([look.kind, look.how], ['SUBMITTED', 'surfaced'], `the surfaced ids end the hold as delivered (got ${JSON.stringify(look)})`);
  assert.equal(await rig.call('inhibition', { id: 'cl-a' }), null, 'the latch is gone');

  // The next mail wakes the agent (1.1.98: refused for three hours).
  const m2 = await rig.call('send', { to: 'cl-a', subject: 'r1-next', body: 'after the latch' });
  await rig.beatUntil(() => acted(rig, 'cl-a', m2.id), { what: 'm2 wakes cl-a and is acted' });
  assert.equal(rig.prompts('cl-a').length, 2, "god's turn and the wake: exactly two prompts");
  assert.ok(rig.contexts('cl-a').some((c) => c.ids.includes(m2.id)), 'm2 surfaced by its own wake');
  assert.equal(rig.prompts('cl-a')[1].text.includes(m1.id), false, 'the typed wake was never typed again');
});

test('R2 the 14:55 -> 15:24Z sequence: a stale latch refuses a delivery (and that is a row); a Stop with an empty composer releases it; the waiting mail wakes', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-a', flavour: 'claude', scenario: {} }]);
  const m1 = await rig.call('send', { to: 'cl-a', subject: 'r2', body: 'acted normally' });
  await rig.beatUntil(() => acted(rig, 'cl-a', m1.id), { what: 'm1 acted' });
  await sleep(300);
  const latch = await rig.call('holdTyped', { id: 'cl-a', ids: [m1.id] });   // the stale latch: its ids were acted BEFORE it
  assert.equal(latch?.reason, 'WAKE_TYPED_NOT_SENT');
  const look0 = await rig.call('recheckHeld', { id: 'cl-a' });
  assert.equal(look0.why, 'typed-not-sent', `ids acted before the hold are no proof: held (got ${JSON.stringify(look0)})`);

  // 14:55:01Z / 15:24:40Z: two deliveries, both refused by the latch, BOTH logged.
  const t0 = Date.now();
  const m2 = await rig.call('send', { to: 'cl-a', subject: 'r2-a', body: "god's 14:55 request" });
  await rig.beat(); await sleep(300);
  const m3 = await rig.call('send', { to: 'cl-a', subject: 'r2-b', body: "god's 15:24:40 request" });
  await rig.beat(); await sleep(300);
  const refused = (await refusals(rig, 'cl-a', t0)).filter((d) => d.why === 'owner-inhibited');
  assert.ok(refused.length >= 2, `each delivery's refusal is seen (got ${refused.length})`);
  assert.ok(refused.filter((d) => d.cause === 'delivery').length >= 2, `both are delivery-caused refusals (the rig keeps diags, not log rows: that each one is a wake row, never folded, is wake-false-interfered-198's row-policy test; got ${JSON.stringify(refused.map((d) => d.cause))})`);
  assert.equal(rig.prompts('cl-a').length, 1, 'only m1\'s wake so far');

  // god's term send: a turn runs, Stops with an empty composer (the typed text was never there).
  const sent = await rig.call('term', { body: { action: 'send', agent: 'cl-a', text: 'read your inbox' } });
  assert.equal(sent.body.ok, true, sent.body.line);
  await waitFor(async () => (await acted(rig, 'cl-a', m2.id)) && acted(rig, 'cl-a', m3.id), { what: "god's turn acts m2 and m3" });
  await sleep(1_700);
  const look = await rig.call('recheckHeld', { id: 'cl-a' });
  assert.ok(look.kind === 'RELEASED' || look.kind === 'SUBMITTED', `a turn ended and the composer is empty: the hold ends (got ${JSON.stringify(look)})`);
  assert.equal(await rig.call('inhibition', { id: 'cl-a' }), null, 'the latch is gone');

  const m4 = await rig.call('send', { to: 'cl-a', subject: 'r2-c', body: 'after the latch' });
  await rig.beatUntil(() => acted(rig, 'cl-a', m4.id), { what: 'm4 wakes cl-a' });
  assert.equal(rig.prompts('cl-a').length, 3, "m1's wake, god's turn, m4's wake");
});
