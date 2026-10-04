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
// DETERMINISM (Dwight's audit, god 9b5fc7): C1 used to make the response late with a 3.2 s busy-wait
// on the host's main thread. The AGY hook shim gives up 5 s after IT starts (AGY_HOOK_SHIM), so the
// late block reached the CLI only if everything else fit in the ~1.8 s left: a wall-clock race that
// failed in another runner. No stall between the 2.5 s limit and the 5 s cap is race-free, so:
//  - C1: the response leaves at once and its flush is MEASURED 3.2 s after arrival (lateNextFlush);
//  - C1b: a real main-thread stall PAST the shim's cap, where the outcome is certain (the shim is
//    always gone): the block never reaches the CLI, and the mail comes back with the marker.
test('C1 hook-response latency past the limit (AGY pipe, the flush measured 3.2 s after arrival): mail-surface-late with transport and elapsed ms, then re-surfaced with the marker', T, async (t) => {
  const rig = await startRig(t);
  const diag = () => rig.diagnose('ag-1');
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'ag-1', subject: 'c1', body: 'answered too late' });
  await rig.call('lateNextFlush', { id: 'ag-1', ms: 3_200 });   // pipe limit: 5 s - min(5 s, 50%) = 2.5 s
  await rig.beat();
  await waitFor(() => rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), { what: 'the (late) block still reached the CLI', diag });
  await waitFor(async () => (await rig.rows('mail-hook-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-hook-late at the flush', diag });
  assert.equal((await rig.entry('ag-1', m.id)).state, 'surfacing', 'a late response is never confirmed by latency');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(async () => (await rig.rows('mail-surface-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-surface-late', diag });
  const row = (await rig.rows('mail-surface-late')).find((r) => r.ids.includes(m.id));
  assert.equal(row.transport, 'pipe');
  // MAIL-RIG-C1-FLAKE: exactly the injected lateness (lateNextFlush), never 3.2 s plus however long
  // this machine took between the hook's arrival and its flush.
  assert.equal(row.latencyMs, 3_200, `elapsed ${row.latencyMs} ms`);
  assert.equal((await rig.entry('ag-1', m.id)).state, 'delivered');
  // MAIL-RIG-C1-FLAKE: the re-wake comes from the Stop's own re-pend; the clock moves only while
  // the agent is quiet, never under the still-starting re-wake turn (see Rig.beatUntil).
  await rig.beatUntil(() => rig.contexts('ag-1').filter((c) => c.ids.includes(m.id)).length >= 2, { what: 're-surfaced', settle: false, holdWhileBusy: true, stepMs: 15_000 });
  assert.ok(rig.contexts('ag-1').filter((c) => c.ids.includes(m.id))[1].context.includes(REDELIVERED), 'with the marker');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'ag-1', m.id), { what: 'acted once in time', diag });
  assert.equal(rig.contexts('ag-1').filter((c) => c.ids.includes(m.id)).length, 2);
});

test('C1b a real main-thread stall past the AGY shim\'s own 5 s give-up: the block never reaches the CLI, the claim settles late, and the mail is re-surfaced with the marker and acted once', T, async (t) => {
  const rig = await startRig(t);
  const diag = () => rig.diagnose('ag-1');
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'ag-1', subject: 'c1b', body: 'the shim gave up' });
  await rig.call('stallNextHook', { id: 'ag-1', ms: 6_000, event: 'PreInvocation' });
  await rig.beat();
  await waitFor(() => rig.hooks('ag-1', 'PreInvocation').length >= 1, { what: 'the PreInvocation hook returned', timeoutMs: 30_000, diag });
  const h = rig.hooks('ag-1', 'PreInvocation')[0];
  assert.equal(h.response, null, 'the shim exited with no output');
  assert.ok(!rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), 'nothing reached the model');
  await waitFor(async () => (await rig.rows('mail-hook-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-hook-late', diag });
  assert.equal((await rig.entry('ag-1', m.id)).state, 'surfacing', 'never confirmed');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(async () => (await rig.rows('mail-surface-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-surface-late', diag });
  const row = (await rig.rows('mail-surface-late')).find((r) => r.ids.includes(m.id));
  assert.equal(row.transport, 'pipe');
  assert.ok(row.latencyMs === null || row.latencyMs >= 5_000, `elapsed ${row.latencyMs} ms`);
  assert.equal((await rig.entry('ag-1', m.id)).state, 'delivered');
  await rig.beatUntil(() => rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), { what: 're-surfaced', settle: false, holdWhileBusy: true, stepMs: 15_000 });
  assert.ok(rig.contexts('ag-1').find((c) => c.ids.includes(m.id)).context.includes(REDELIVERED), 'with the marker');
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'ag-1', m.id), { what: 'acted once', diag });
});

// LOAD-FLAKES-176 (Jim A1): the C1 root cause, PROVEN rather than plausible, and the REAL host
// busy() pinned. The re-wake's turn start is held until the test releases it (the stub's
// `hold-starts` / `release-starts` cues; it was 5 s of wall clock, `slow-starts`, which made the
// proof itself load-dependent: TEST-FLAKE-MAILRIG-C1). The old re-surface step (settle:false, the clock moving
// under the still-starting turn) runs the 60 s SUBMIT_CONFIRM_MS out and loses the re-surface;
// holdWhileBusy keeps it. A busy() that ignored `inFlight` or `lifecycle === 'active'` loses it too.
async function c1UpToRepend(t, diagId = 'ag-1') {
  const rig = await startRig(t);
  const diag = () => rig.diagnose(diagId);
  await rig.setup([{ id: 'ag-1', flavour: 'agy', scenario: { manualTurns: true } }]);
  const m = await rig.call('send', { to: 'ag-1', subject: 'c1-a1', body: 'answered too late' });
  await rig.call('lateNextFlush', { id: 'ag-1', ms: 3_200 });
  await rig.beat();
  await waitFor(() => rig.contexts('ag-1').some((c) => c.ids.includes(m.id)), { what: 'the (late) block reached the CLI', diag });
  // TEST-FLAKE-MAILRIG-C1: the re-wake's turn start is HELD until the test releases it (the stub's
  // `hold-starts`), not for 5 s of wall clock (`slow-starts`). A real-time hold raced the test's own
  // progress: on a loaded runner the steps up to the snapshot took longer than 5 s, the whole
  // re-wake (claim, submit, turn start, hook) was over before the test looked, and the proof failed.
  rig.cue('ag-1', { cue: 'hold-starts' });
  await waitFor(() => rig.transcript('ag-1').some((r) => r.kind === 'cue' && r.cue?.cue === 'hold-starts'), { what: 'turn starts are held from here', diag });
  const held = rig.transcript('ag-1').filter((r) => r.kind === 'start-held').length;
  // The wake record's length BEFORE the cause of the re-wake (the Stop): every claim/settle after it
  // belongs to this re-pend, whenever the test gets to look (the record holds 5,000 rows; ~20 here).
  const wakeBase = (await rig.call('diags')).filter((d) => d.agentId === 'ag-1' && (d.stage === 'claim' || d.stage === 'settle')).length;
  rig.cue('ag-1', { cue: 'stop' });
  await waitFor(async () => (await rig.rows('mail-surface-late')).some((r) => r.ids.includes(m.id)), { what: 'mail-surface-late', diag });
  // The re-pend re-wakes ag-1: its prompt is submitted and its turn start now waits for the test.
  await waitFor(() => rig.transcript('ag-1').filter((r) => r.kind === 'start-held').length > held, { what: 'the re-wake\'s turn start is held', diag });
  return { rig, m, wakeBase, release: () => rig.cue('ag-1', { cue: 'release-starts' }) };
}
const resurfaced = (rig, m) => () => rig.contexts('ag-1').filter((c) => c.ids.includes(m.id)).length >= 2;

test('C1 A1 proof: a re-wake whose turn start is held until released: the OLD step runs the 60 s confirm window out under the starting turn (submit-unconfirmed / exhausted); holdWhileBusy never does, and re-surfaces', T, async (t) => {
  const unconfirmed = async (rig) => (await rig.call('diags')).filter((d) => d.agentId === 'ag-1' && (d.stage === 'submit-unconfirmed' || d.stage === 'wake-ids-exhausted')).length;
  // The old form: 5 steps of 15 s (75 s simulated, > SUBMIT_CONFIRM_MS) take ~1.5 s real, far less
  // than the held 5 s turn start plus 5 s hook: the claim is judged unconfirmed while the turn is
  // still starting. That is the C1 race, deterministic here.
  const old = await c1UpToRepend(t);
  const before = await unconfirmed(old.rig);
  await old.rig.beatUntil(resurfaced(old.rig, old.m), { what: 're-surfaced (old form)', settle: false, stepMs: 15_000, tries: 5, diag: async () => '' }).catch(() => false);
  assert.ok((await unconfirmed(old.rig)) > before, 'the old form moved the clock past the confirm window under the starting re-wake');
  old.release();
  // The fix: the same held turn start, the clock never moves under it, no unconfirmed edge.
  const now = await c1UpToRepend(t);
  const b2 = await unconfirmed(now.rig);
  // GATE-178 (gate at 7ad9d756, round 1a): this used to SAMPLE the host's inFlight while beating.
  // The re-wake is in flight only from its claim to its settle (~250 ms here: 2-3 of ~110 polls
  // 93 ms apart, measured), and under a dual-suite load one poll gap reached 2.2 s, so the sample
  // could miss a window that did happen. The host's own wake record is the evidence instead.
  // TEST-FLAKE-MAILRIG-C1: that record was then counted from a snapshot taken AFTER the Stop's
  // mail-surface-late row. The re-wake (the Stop's own, cause hook) claims and settles ~250 ms after
  // that Stop, so on a loaded runner it was already over at the snapshot and the proof failed
  // (reproduced: a 6 s lag before the snapshot fails it every time). The count now starts BEFORE
  // the Stop (wakeBase), and the held phase is the turn start the test itself holds.
  const wakeRows = async () => (await now.rig.call('diags')).filter((d) => d.agentId === 'ag-1' && (d.stage === 'claim' || d.stage === 'settle'));
  const holds = now.rig.busyHolds ?? 0;
  const beating = now.rig.beatUntil(resurfaced(now.rig, now.m), { what: 're-surfaced', settle: false, holdWhileBusy: true, stepMs: 15_000 });
  // Release the start only once the beat loop has found the agent busy and kept the clock still
  // (an event, not a delay). A loop that moved the clock instead never gets here: this times out.
  await waitFor(() => (now.rig.busyHolds ?? 0) > holds, { what: 'beatUntil held the clock under the held turn start' });
  assert.equal(await unconfirmed(now.rig), b2, 'nothing judged unconfirmed while the start was held');
  now.release();
  await beating;
  assert.equal(await unconfirmed(now.rig), b2, 'holdWhileBusy: never judged unconfirmed');
  const all = await wakeRows();
  const fresh = all.slice(now.wakeBase);
  const settled = fresh.find((d) => d.stage === 'settle' && d.outcome === 'COMMITTED');
  assert.ok(settled && fresh.some((d) => d.stage === 'claim' && d.requestId === settled.requestId),
    `THE RE-WAKE WAS IN FLIGHT WHILE ITS TURN START WAS HELD: the re-pend's ag-1 wake was claimed and submitted (${JSON.stringify(fresh)})`);
  // Its turn start was held after that submit, and released only after the beat loop had held the clock.
  const tr = now.rig.transcript('ag-1');
  const heldAt = tr.findIndex((r) => r.kind === 'start-held');
  assert.ok(heldAt >= 0 && tr.findIndex((r, i) => i > heldAt && r.kind === 'start-released') > heldAt, 'the submitted turn start was held, then released');
  assert.ok(now.rig.contexts('ag-1').filter((c) => c.ids.includes(now.m.id))[1].context.includes(REDELIVERED), 'with the marker');
});

// Unit test: mail-surface "C2: roster + a 10k steer + mail:nothing past the budget, nothing surfacing; …".
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
  await rig.tool('cl-1');
  await waitFor(() => rig.contexts('cl-1').some((c) => c.event === 'PostToolUse' && c.ids.includes(m.id)), { what: 'the next hook surfaces it' });

  const m2 = await rig.call('send', { to: 'cl-1', subject: 'c2 headers', body: 'x'.repeat(3_000) });
  await rig.call('steer', { id: 'cl-1', text: `STEER2 ${'s'.repeat(8_200)}` });
  await rig.tool('cl-1');
  const post = await waitFor(() => rig.hooks('cl-1', 'PostToolUse').filter((h) => JSON.stringify(h.response ?? {}).includes('STEER2'))[0], { what: 'the steered PostToolUse' });
  const c2 = post.response.hookSpecificOutput.additionalContext;
  assert.ok(c2.includes(m2.id), 'the header names it');
  assert.deepEqual(markersIn(c2), [], 'headers only: no body, no marker');
  assert.ok(c2.length <= 9_500, `joined context ${c2.length} <= 9,500`);
  assert.equal((await rig.entry('cl-1', m2.id)).state, 'delivered', 'headers-only claims nothing');
  await rig.tool('cl-1');
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
  // LOAD-FLAKES-176: the clock moves only when the real turns are done (hog run: settle's bounded
  // quiet() ran out, the clock raced the turns, and the ids were acted with no context recorded).
  await rig.beatUntil(async () => { for (const id of ids) if (!(await acted(rig, 'cl-1', id))) return false; return true; }, { what: 'all acted', holdForStubs: true });
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
  await rig.tool('cl-1');
  await waitFor(async () => (await rig.entry('cl-1', m.id)).state === 'surfaced', { what: 'confirmed' });
  rig.cue('cl-1', { cue: 'stop-failure' });
  await waitFor(async () => { const e = await rig.entry('cl-1', m.id); return e.state === 'delivered' && e.redelivered; }, { what: 'back to delivered' });
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'redelivered' && r.reason === 'stop-failure' && r.ids.includes(m.id)));
  // §11.18 #43 (Q40): StopFailure ends the turn in the wake lifecycle too, so no idle Notification
  // (~60 s later on a real Claude) is needed before the re-pended mail is offered again.
  await waitFor(async () => (await rig.call('wakeState', { id: 'cl-1' })).lifecycle === 'idle', { what: 'idle at the StopFailure itself', diag: () => rig.diagnose('cl-1') });
  // LOAD-FLAKES-176: as C1, the clock never moves under the still-starting re-wake (reproduced with
  // RIG_SLOW_STUB_MS=5000: exhausted, retries, even mail-channel-degraded, then 're-surfaced never held').
  await rig.beatUntil(() => rig.contexts('cl-1').filter((c) => c.ids.includes(m.id)).length >= 2, { what: 're-surfaced', settle: false, holdWhileBusy: true });
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
  await rig.tool('cl-1');
  await waitFor(async () => (await rig.entry('cl-1', m.id)).state === 'surfaced', { what: 'confirmed' });
  const epoch = await rig.call('mailEpoch', { id: 'cl-1' });
  rig.cue('cl-1', { cue: 'compact' });
  const re = await waitFor(() => rig.contexts('cl-1').find((c) => c.event === 'SessionStart' && c.compact), { what: 'the compact re-injection' });
  assert.deepEqual(markersIn(re.context), [m.id], 're-injected after the conversation was dropped');
  assert.equal(await rig.call('mailEpoch', { id: 'cl-1' }), epoch, 'no new epoch');
  await rig.tool('cl-1');
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
