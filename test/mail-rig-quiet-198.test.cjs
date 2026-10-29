'use strict';
require('./tools/own-job.cjs');
/**
 * QUIET-HOLD-ACT-ONLY (1.1.98): the C:/Meta/hive/log.jsonl 2026-10-22 sequences, replayed through
 * the INTEGRATED rig (real HiveManager, ledgers, InboxWakeBridge, hooks and PTYs; test/mail-rig/)
 * with the quiet hold on (30 min, as config.quietMailHoldMin defaults). Layer (a), zero model tokens.
 *
 * On the Meta floor every one of these informs was held for up to 30 min because the class keyed
 * on the act alone. Here each must wake its recipient AT ONCE (no "held" row, acted without the
 * clock moving to the bound), while a routine FYI nobody asked for is still held and released at
 * the 30 min bound as one wake. The rules themselves are pinned at unit level, with a mutant
 * census, in test/quiet-hold-act-198.test.cjs; this file exercises the wiring (index.ts quietUntil,
 * mirrored by rig-host; mailLedger's broadcast/humanRelay flags; hive.send's `to` and `card`).
 *
 * LAYER: main-process integration (see mail-rig-faults.test.cjs and NOTES slice 8).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig } = require('./mail-rig/driver.cjs');

const T = { timeout: 240_000 };
const acted = async (rig, agentId, id) => (await rig.entry(agentId, id))?.state === 'acted';
const heldRows = async (rig, agentId, id) => (await rig.call('diags')).filter((d) => d.stage === 'held' && d.agentId === agentId && (d.idList ?? []).includes(id));

/** Send, then require the recipient to act on it with the clock moved by seconds, never minutes: a wake, not the bound. */
async function wakesAtOnce(rig, to, msg, why) {
  const m = await rig.call('send', { to, ...msg });
  const ids = to === 'broadcast' ? rig.agentIds : [to];
  await rig.beatUntil(async () => { for (const a of ids) if (!(await acted(rig, a, m.id))) return false; return true; }, { what: `${why}: acted at once`, stepMs: 2_000, tries: 30 });
  for (const a of ids) assert.deepEqual(await heldRows(rig, a, m.id), [], `${why}: never held for ${a}`);
  return m;
}

test('META REPLAY 2026-10-22: answers, Human relays, hold broadcasts, facts on open asks and results-as-inform wake at once; a routine FYI is still held to the 30 min bound', T, async (t) => {
  const rig = await startRig(t);
  // Speck (sp-1), McCey (mc-1), Sele (se-1): claude-flavoured inject agents with auto turns.
  await rig.setup([
    { id: 'sp-1', flavour: 'claude', scenario: {} },
    { id: 'mc-1', flavour: 'claude', scenario: {} },
    { id: 'se-1', flavour: 'claude', scenario: {} }
  ]);
  await rig.call('quietHold', { min: 30 });

  // The dispatches (requests: they woke on the Meta floor too) are the open asks the rest hang off.
  const r6 = await wakesAtOnce(rig, 'sp-1', { act: 'request', card: 'RAYB-6', subject: 'RAYB-6: tap rules', body: 'OBJECTIVE: the tap rules.' }, 'RAYB-6 request');
  await wakesAtOnce(rig, 'mc-1', { act: 'request', card: 'RAYB-9', subject: 'RAYB-9: provider stack', body: 'OBJECTIVE: the stack.' }, 'RAYB-9 request');
  // Sele's open ask comes from McCey (rule c below), as god has no PTY in the rig.
  await wakesAtOnce(rig, 'mc-1', { from: 'se-1', act: 'request', card: 'RAYB-9', subject: 'RAYB-9: tell me the stack verdict', body: 'I need it for RAYB-11.' }, "Sele's ask to McCey");

  // (a2) 11:13 a fact on the card Speck is working, as a plain inform (no "Human" in it).
  await wakesAtOnce(rig, 'sp-1', { act: 'inform', card: 'RAYB-6', subject: 'RAYB-4 landed: research/raybans/button-trigger.md', body: "McCey's gesture research is in. Fold it into your audit." }, '11:13 fact on the open card');
  // (a2 + b) 11:29 the Human's spec correction to Speck mid-RAYB-6, in the request's conversation.
  await wakesAtOnce(rig, 'sp-1', { act: 'inform', conversation: r6.conversation, subject: 'RAYB-6 spec correction from the Human', body: 'The Human corrected the tap rules, so this narrows RAYB-6.' }, '11:29 spec correction');
  // (b) 11:37 / 11:41 the Human's hard rules and 12:17 the floor pause: broadcasts, every agent at once.
  await wakesAtOnce(rig, 'broadcast', { act: 'inform', card: 'RAYB-3', subject: 'RAYB hard rule: never fall back to Meta AI launching our app', body: "The Human's rule, which is absolute: our app must NEVER be started through Meta AI." }, '11:37 hard rule');
  await wakesAtOnce(rig, 'broadcast', { act: 'inform', subject: 'Floor paused', body: 'Do not start new work until god announces a resume.' }, '12:17 floor pause (no Human word: the hold notice)');
  // (a2) 12:06 / 12:07 facts added to McCey's open RAYB-9.
  await wakesAtOnce(rig, 'mc-1', { act: 'inform', card: 'RAYB-9', subject: 'RAYB-9: phone is Pixel 10 Pro XL', body: 'Answer the Nano section for this device.' }, '12:06 Pixel fact');
  await wakesAtOnce(rig, 'mc-1', { act: 'inform', card: 'RAYB-9', subject: 'RAYB-9: phone runs Android 17', body: 'Flag any Android 17 limits.' }, '12:07 Android fact');
  // (c) 12:08:37 McCey's "RAYB-9 done" sent as INFORM, no card, to the agent whose ask is open.
  const note = await wakesAtOnce(rig, 'se-1', { from: 'mc-1', act: 'inform', subject: 'RAYB-9 done: stack works at zero cost WITH CAVEATS', body: 'File: research/raybans/provider-stack.md. VERDICT: with caveats.' }, "12:08 McCey's result as inform");
  // (a1) 12:09:31 the answer in_reply_to that INFORM (the 1.1.81 rule looked only at asking acts).
  await wakesAtOnce(rig, 'mc-1', { from: 'se-1', act: 'inform', in_reply_to: note.id, subject: 'RAYB: ChatGPT-first is superseded, provider is free Gemini', body: 'Superseded; thanks.' }, '12:09 answer to an inform');

  // The control: a routine FYI nobody asked for is still held, and released at the bound as one wake.
  const fyi = await rig.call('send', { to: 'sp-1', act: 'inform', subject: 'quiet time on', body: 'status only' });
  // A second control (Andy's audit of 0f1baba7): an addressed cc that only QUOTES the Human in its
  // body is a routine cc, not a relay (rule b is Human in the subject, or a broadcast with Human in the body).
  const cc = await rig.call('send', { to: 'sp-1', act: 'inform', subject: 'cc: RAYB-3 wording', body: "For your file: the Human's wording of the rule, as sent to McCey." });
  await rig.beat();
  await rig.beatUntil(async () => (await heldRows(rig, 'sp-1', fyi.id)).length > 0, { what: 'the FYI is held', stepMs: 1_000, tries: 10 });
  assert.equal(await acted(rig, 'sp-1', fyi.id), false, 'the FYI started no turn');
  assert.ok((await heldRows(rig, 'sp-1', cc.id)).length > 0, 'A BODY-ONLY HUMAN CC IS HELD LIKE ANY FYI');
  assert.equal(await acted(rig, 'sp-1', cc.id), false, 'the cc started no turn');
  const promptsBefore = rig.prompts('sp-1').length;
  await rig.call('advance', { ms: 31 * 60_000 });
  await rig.beatUntil(async () => (await acted(rig, 'sp-1', fyi.id)) && acted(rig, 'sp-1', cc.id), { what: 'the FYI and the cc released at the 30 min bound', stepMs: 5_000, tries: 20 });
  const released = (await rig.call('diags')).find((d) => d.stage === 'hold-released' && d.agentId === 'sp-1' && (d.idList ?? []).includes(fyi.id));
  assert.ok(released, 'a hold-released row for the FYI');
  assert.equal(released.reason, 'max-delay');
  assert.equal(rig.prompts('sp-1').length, promptsBefore + 1, 'one wake carried both');
});
