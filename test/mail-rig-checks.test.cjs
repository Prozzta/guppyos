'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 8: the Jim must-fix checks C1-C8 of INBOX-DESIGN §11.15, as INTEGRATED
 * rig tests (test/mail-rig/). Layer (a), zero model tokens. The same rules are also pinned at unit
 * level by earlier slices; each test names those, so a failure here that the unit test does not
 * show points at the wiring between the modules, which is what this file exists to exercise.
 *
 * LAYER: main-process integration (see mail-rig-faults.test.cjs and NOTES slice 8).
 * (§11.15's "zero hook traffic -> degrade" is F12 in mail-rig-faults; "the downgrade helper" is N4
 * in mail-rig-scenarios.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startRig, waitFor, sleep, markersIn, REDELIVERED } = require('./mail-rig/driver.cjs');

const T = { timeout: 180_000 };
const acted = async (rig, agentId, id) => (await rig.entry(agentId, id))?.state === 'acted';

// Unit tests: mail-surface "C1 latency rule (AGY)…", "C1 latency rule (Claude over http)…";
// mail-epochs "§11.1 + Q8: a LATE surfacing is re-pended at Stop as mail-surface-late…".
test('C1 hook-response latency past the limit (AGY pipe, a stalled main thread): mail-surface-late with transport and elapsed ms, then re-surfaced with the marker', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'ag-1', subject: 'c1', body: 'answered too late' });
  await rig.call('stallNextHook', { id: 'ag-1', ms: 3_200, event: 'PreInvocation' });   // pipe limit: 5 s - min(5 s, 50%) = 2.5 s
  await rig.beat();
  await waitFor(() => rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), { what: 'the (late) block still reached the CLI', timeoutMs: 30_000 });
  await sleep(300);
  assert.equal((await rig.entry('ag-1', m.id)).state, 'surfacing', 'a late response is never confirmed by latency');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(async () => (await rig.rows('mail-surface-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-surface-late' });
  const row = (await rig.rows('mail-surface-late')).find((r) => r.ids.includes(m.id));
  assert.equal(row.transport, 'pipe');
  assert.ok(row.latencyMs >= 2_500 && row.latencyMs < 6_000, `elapsed ${row.latencyMs} ms`);
  assert.equal((await rig.entry('ag-1', m.id)).state, 'delivered');
  await rig.beatUntil(() => rig.contexts('ag-1').filter((c) => c.ids.includes(m.id)).length >= 2, { what: 're-surfaced', settle: false, stepMs: 15_000 });
  assert.ok(rig.contexts('ag-1').filter((c) => c.ids.includes(m.id))[1].context.includes(REDELIVERED), 'with the marker');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'ag-1', m.id), { what: 'acted once in time' });
});

// Unit test: mail-surface "C2: roster + a 10k steer + mail: nothing past the budget, nothing surfacing; …".
test('C2 a 10k steer + mail: no block past the joined budget, nothing surfacing; a steer leaving < 1,500 gives headers only; the mail follows at the next hook', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'c2', body: 'wait for room' });
  await rig.call('steer', { id: 'cl-1', text: `STEER ${'s'.repeat(9_990)}` });
  await rig.call('humanType', { id: 'cl-1', text: 'go\r' });
  const ups = await waitFor(() => rig.hooks('cl-1', 'UserPromptSubmit')[0], { what: 'UPS' });
  const ctx = ups.response.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('STEER'), 'the steer was delivered (unchanged 1.1.74 behaviour)');
  assert.deepEqual(markersIn(ctx), [], 'no mail block past the budget');
  assert.equal((await rig.entry('cl-1', m.id)).state, 'delivered', 'nothing surfacing');
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(() => rig.contexts('cl-1').some((c) => c.event === 'PostToolUse' && c.ids.includes(m.id)), { what: 'the next hook surfaces it' });

  const m2 = await rig.call('send', { to: 'cl-1', subject: 'c2 headers', body: 'x'.repeat(3_000) });
  await rig.call('steer', { id: 'cl-1', text: `STEER2 ${'s'.repeat(8_200)}` });
  rig.cue('cl-1', { cue: 'tool' });
  const post = await waitFor(() => rig.hooks('cl-1', 'PostToolUse').filter((h) => JSON.stringify(h.response ?? {}).includes('STEER2'))[0], { what: 'the steered PostToolUse' });
  const c2 = post.response.hookSpecificOutput.additionalContext;
  assert.ok(c2.includes(m2.id), 'the header names it');
  assert.deepEqual(markersIn(c2), [], 'headers only: no body, no marker');
  assert.ok(c2.length <= 9_500, `joined context ${c2.length} <= 9,500`);
  assert.equal((await rig.entry('cl-1', m2.id)).state, 'delivered', 'headers-only claims nothing');
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m2.id)), { what: 'm2 drips into the next hook' });
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(async () => (await acted(rig, 'cl-1', m.id)) && (await acted(rig, 'cl-1', m2.id)), { what: 'both acted' });
});

// Unit test: mail-epochs "C3 (§11.3): a text-only wake turn whose block overflowed: …".
test('C3 a text-only wake turn with a budget overflow: what never surfaced is re-pended at the Stop and woken again', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { turn: { tools: 0 } } }]);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await rig.call('send', { to: 'cl-1', subject: `c3 ${i}`, body: `c3 body ${i} `.padEnd(4_000, '-') })).id);
  await rig.beatUntil(async () => { for (const id of ids) if (!(await acted(rig, 'cl-1', id))) return false; return true; }, { what: 'all acted' });
  const first = rig.contexts('cl-1')[0];
  assert.ok(first.ids.length < 4 && first.ids.length > 0, `the text-only turn showed ${first.ids.length} of 4`);
  assert.ok((await rig.call('diags')).some((d) => d.stage === 'wake-repend' && d.agentId === 'cl-1' && d.outcome === 'normal'), 'wake-repend at the Stop');
  assert.ok(rig.prompts('cl-1').length >= 2, 'woken again for the rest');
  const seen = rig.contexts('cl-1').flatMap((c) => c.ids);
  for (const id of ids) assert.equal(seen.filter((x) => x === id).length, 1, `${id} once`);
});

// Unit tests: mail-epochs "§11.4: Claude StopFailure …" and "§11.4: an interrupt (no Stop), then the next UserPromptSubmit while the lifecycle is IDLE …".
test('C4 StopFailure is an abnormal end (re-surfaced with the marker); an interrupt, then the next UserPromptSubmit, closes the epoch and re-surfaces in that same turn', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'c4a', body: 'api error' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m.id)), { what: 'surfaced' });
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(async () => (await rig.entry('cl-1', m.id)).state === 'surfaced', { what: 'confirmed' });
  rig.cue('cl-1', { cue: 'stop-failure' });
  await waitFor(async () => { const e = await rig.entry('cl-1', m.id); return e.state === 'delivered' && e.redelivered; }, { what: 'back to delivered' });
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'redelivered' && r.reason === 'stop-failure' && r.ids.includes(m.id)));
  // After an API error Claude sits at its prompt and, ~60 s later, says so (idle Notification).
  // The wake coordinator counts only Stop / Notification as the turn's end (StopFailure closes the
  // MAIL epoch, not the wake lifecycle): see NOTES Q-slice-8.
  rig.cue('cl-1', { cue: 'status', message: 'Claude is waiting for your input' });
  await waitFor(async () => (await rig.call('wakeState', { id: 'cl-1' })).lifecycle === 'idle', { what: 'idle after the API error' });
  await rig.beatUntil(() => rig.contexts('cl-1').filter((c) => c.ids.includes(m.id)).length >= 2, { what: 're-surfaced', settle: false });
  assert.ok(rig.contexts('cl-1').filter((c) => c.ids.includes(m.id))[1].context.includes(REDELIVERED));
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted' });

  // The interrupt: Ctrl-C ends the turn with NO Stop; Claude then says it is idle; the person types.
  await rig.call('capacityHold', { on: true });   // only the person starts turns from here
  const m2 = await rig.call('send', { to: 'cl-1', subject: 'c4b', body: 'interrupted' });
  await rig.call('humanType', { id: 'cl-1', text: 'start\r' });
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m2.id)), { what: 'm2 surfaced' });
  await rig.call('humanType', { id: 'cl-1', text: '\x03' });
  await waitFor(() => rig.turnEnds('cl-1').some((e) => e.how === 'interrupted'), { what: 'interrupted' });
  rig.cue('cl-1', { cue: 'status', message: 'Claude is waiting for your input' });
  await waitFor(async () => (await rig.call('wakeState', { id: 'cl-1' })).lifecycle === 'idle', { what: 'idle' });
  await rig.call('humanType', { id: 'cl-1', text: 'continue\r' });
  const again = await waitFor(() => rig.contexts('cl-1').filter((c) => c.ids.includes(m2.id))[1], { what: 're-surfaced at the next UserPromptSubmit' });
  assert.equal(again.event, 'UserPromptSubmit', 'in that same turn');
  assert.ok(again.context.includes(REDELIVERED));
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'redelivered' && r.reason === 'interrupted' && r.ids.includes(m2.id)), 'closed abnormally (interrupted)');
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cl-1', m2.id), { what: 'acted' });
});

// Unit tests: mail-epochs "§11.5: SessionStart(compact) opens no epoch and re-injects …"; mail-surface "C5: SessionStart(compact) inside a turn is not an epoch boundary …".
test('C5 SessionStart(compact) mid-turn: no new epoch; the surfaced ids are re-injected, confirmed by evidence, and acted once at the Stop', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'c5', body: 'survive the compaction' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m.id)), { what: 'surfaced' });
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(async () => (await rig.entry('cl-1', m.id)).state === 'surfaced', { what: 'confirmed' });
  const epoch = await rig.call('mailEpoch', { id: 'cl-1' });
  rig.cue('cl-1', { cue: 'compact' });
  const re = await waitFor(() => rig.contexts('cl-1').find((c) => c.event === 'SessionStart' && c.compact), { what: 'the compact re-injection' });
  assert.deepEqual(markersIn(re.context), [m.id], 're-injected after the conversation was dropped');
  assert.equal(await rig.call('mailEpoch', { id: 'cl-1' }), epoch, 'no new epoch');
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(async () => { const e = await rig.entry('cl-1', m.id); return e.state === 'surfaced' && e.surfaceCount === 2; }, { what: 're-injection confirmed by evidence' });
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted' });
  assert.equal((await rig.rows('mail')).filter((r) => r.stage === 'acted' && r.ids.includes(m.id)).length, 1);
  assert.equal((await rig.entry('cl-1', m.id)).epoch, epoch);
});

// Unit test: mail-surface "C6: a prompt that starts with "/" … never carries mail; the next ordinary turn does".
test('C6 a /compact prompt carries no mail block; the next ordinary turn does', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await rig.call('capacityHold', { on: true });
  const m = await rig.call('send', { to: 'cl-1', subject: 'c6', body: 'not into a slash command' });
  await rig.call('humanType', { id: 'cl-1', text: '/compact\r' });
  await waitFor(() => rig.hooks('cl-1', 'PostCompact').length === 1, { what: 'the /compact ran' });
  const ups = rig.hooks('cl-1', 'UserPromptSubmit')[0];
  assert.deepEqual(markersIn(JSON.stringify(ups.response ?? {})), [], 'no block in the slash prompt');
  assert.equal((await rig.entry('cl-1', m.id)).state, 'delivered');
  await rig.call('humanType', { id: 'cl-1', text: 'now work\r' });
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'the next ordinary turn carries it' });
  assert.equal(rig.contexts('cl-1').find((c) => c.ids.includes(m.id)).event, 'UserPromptSubmit');
});

// Unit test: mail-epochs "§11.7 cursor (no Stop): NO idle-based acted, ever; the agent's own move means handled, for that agent only".
test('C7 a cursor-style agent (no hooks): hours of idle act nothing; its own move to .done is what marks the mail handled', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cr-1', flavour: 'cursor', scenario: {} }]);
  assert.equal((await rig.call('mailChannel', { id: 'cr-1' })).mode, 'legacy-move');
  const m = await rig.call('send', { to: 'cr-1', subject: 'c7', body: 'the agent handles its own file' });
  for (let i = 0; i < 8; i++) { await rig.call('advance', { ms: 15 * 60_000 }); await rig.beat(); await sleep(150); }   // 2 h, PTY quiet
  assert.equal((await rig.entry('cr-1', m.id)).state, 'delivered', 'no idle-based acted (§11.7)');
  await rig.call('humanType', { id: 'cr-1', text: `Read your inbox and move handled ones to inbox/.done/: ${m.id}\r` });
  await waitFor(() => rig.transcript('cr-1').some((r) => r.kind === 'moved-file' && r.id === m.id), { what: 'the agent moved it' });
  await rig.beatUntil(() => acted(rig, 'cr-1', m.id), { what: 'its move is handled', stepMs: 15_000 });
  const row = (await rig.rows('mail')).find((r) => r.stage === 'acted' && r.ids.includes(m.id));
  assert.equal(row.mode, 'legacy-move');
  assert.equal(row.reason, 'agent-moved');
});

// Unit tests: mail-readers "#6…", "#9/#13…", "#10/#11 (C8)…", "#14…", "#15…", "#16" pins.
test('C8 readers 9-16 read the ledger over the integrated path; the harness rename into .done is not activity', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await rig.call('capacityHold', { on: true });
  const m = await rig.call('send', { to: 'cl-1', subject: 'c8', body: 'read by every reader' });
  let r = await rig.call('readers', { id: 'cl-1' });
  assert.equal(r.actionableBacklog, 1, '#9 standup: not-acted');
  assert.equal(r.actionablePending, 1, '#13 gate: delivered');
  assert.equal(r.hasBacklog, true, '#12 digest');
  assert.equal(r.fleet.inboxBacklog, 1, '#6 fleet');
  assert.ok(r.ledgerInbox.some((x) => x.id === m.id), '#14 voice watcher');
  assert.equal(r.history.find((h) => h.id === m.id).mail_state, 'delivered', '#15 Threads');
  assert.deepEqual(await rig.call('pending', { id: 'cl-1' }), [m.id], '#16 hive:mailPending');
  const deliveredAt = r.lastActivityAt;
  assert.ok(deliveredAt > 0, '#10 activity moved at delivery');

  await rig.call('capacityHold', { on: false });
  await rig.beatUntil(() => acted(rig, 'cl-1', m.id), { what: 'acted' });
  await waitFor(() => rig.doneFiles('cl-1').includes(m.id), { what: 'the harness rename' });
  for (let i = 0; i < 2; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); await sleep(200); }   // reconcile beats after the rename
  const e = await rig.entry('cl-1', m.id);
  r = await rig.call('readers', { id: 'cl-1' });
  assert.equal(r.actionableBacklog, 0);
  assert.equal(r.actionablePending, 0);
  assert.equal(r.hasBacklog, false);
  assert.equal(r.fleet.inboxBacklog, 0);
  assert.ok(r.ledgerInbox.some((x) => x.id === m.id), '#14: an acted entry is still seen');
  const h = r.history.find((x) => x.id === m.id);
  assert.deepEqual([h.mail_state, h.archived], ['acted', true], '#15: the view does not empty at Stop');
  assert.deepEqual(await rig.call('pending', { id: 'cl-1' }), []);
  assert.equal(r.lastActivityAt, e.actedAt, '#10: the last activity is the ACTED transition, not the later rename');
  assert.equal(r.floor.at, e.actedAt);
  assert.equal(r.coordinationAt, e.actedAt, '#11: lastActedAt');
});
