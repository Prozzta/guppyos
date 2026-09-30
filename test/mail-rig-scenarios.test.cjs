'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 8: the layer-(a) SCENARIO tests listed after INBOX-DESIGN §8.3, and the
 * §11.17 v2 re-check tests N1-N4, on the fake-agent rig (test/mail-rig/). Zero model tokens.
 *
 * LAYER: main-process integration (see mail-rig-faults.test.cjs and NOTES slice 8), except N4
 * and the rollback check, which are FILE-LEVEL by design: N4 is a source/doc pin (there is no
 * downgrade helper to run), and the rollback check reads a 1.1.75-written hive the way 1.1.74
 * reads it (the brief forbids building or running 1.1.74).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startRig, waitFor, sleep, markersIn, REDELIVERED } = require('./mail-rig/driver.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const T = { timeout: 180_000 };
const LEGACY = '(delivered before 1.1.75; may already have been handled)';
const acted = async (rig, agentId, id) => (await rig.entry(agentId, id))?.state === 'acted';

// ——————————————————————————————————————————————————————————————————————— scenarios (§8.3)

test('SCENARIO human-typed turn: pending mail is surfaced by the turn a person starts, with NO wake', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  await rig.call('capacityHold', { on: true });   // no wake could go out even if one were tried
  const m = await rig.call('send', { to: 'cl-1', subject: 'human turn', body: 'for the next turn, whoever starts it' });
  await rig.call('humanType', { id: 'cl-1', text: 'what is next?\r' });
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted in the human turn' });
  assert.deepEqual(rig.prompts('cl-1').map((p) => p.text), ['what is next?'], 'the only prompt is the person\'s');
  assert.ok(rig.contexts('cl-1')[0].ids.includes(m.id), 'its UserPromptSubmit carried the block');
  await rig.call('capacityHold', { on: false });
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 70_000 }); await rig.beat(); await sleep(250); }
  assert.equal((await rig.call('outcomes')).filter((o) => o.outcome.kind === 'COMMITTED').length, 0, 'the coordinator found nothing pending: no wake at all');
  assert.equal(rig.prompts('cl-1').length, 1);
});

test('SCENARIO mid-turn PostToolUse delivery: mail that arrives during a turn is shown at the next tool hook, with the mid-turn wording', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  await rig.call('humanType', { id: 'cl-1', text: 'long task\r' });
  await waitFor(() => rig.hooks('cl-1', 'UserPromptSubmit').length === 1, { what: 'turn started' });
  const m = await rig.call('send', { to: 'cl-1', subject: 'mid-turn', body: 'change of plan' });
  rig.cue('cl-1', { cue: 'tool' });
  const c = await waitFor(() => rig.contexts('cl-1').find((x) => x.event === 'PostToolUse' && x.ids.includes(m.id)), { what: 'PostToolUse block' });
  assert.match(c.context, /arrived during this turn/);
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted at the Stop' });
  assert.equal((await rig.call('outcomes')).length, 0, 'no wake was needed');
});

test('SCENARIO replies tracked: act:request stays open until a reply routes; in_reply_to closes exactly one, sender_id aliases resolve', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  const r1 = await rig.call('send', { to: 'cl-1', id: 'req-1', act: 'request', subject: 'do A', body: 'please do A' });
  const r2 = await rig.call('send', { to: 'cl-1', id: 'req-1', act: 'request', subject: 'do B', body: 'please do B' });   // same id, other content
  const doc = await rig.call('ledger', { id: 'cl-1' });
  const r2e = Object.values(doc.entries).find((e) => e.senderId === 'req-1');
  assert.ok(doc.entries['req-1'] && r2e, 'the collision got a fresh id with sender_id req-1');
  await rig.beatUntil(async () => (await acted(rig, 'cl-1', 'req-1')) && (await acted(rig, 'cl-1', r2e.id)), { what: 'both acted' });
  let rd = await rig.call('readers', { id: 'cl-1' });
  assert.equal(rd.fleet.openRequestCount, 2, 'acted (seen) is not answered: both still open (§11.13 B)');
  rig.cue('cl-1', { cue: 'reply', to: 'god-1', in_reply_to: 'req-1', subject: 're: A', body: 'A done', file: 'rep1' });
  await waitFor(async () => (await rig.call('readers', { id: 'cl-1' })).fleet.openRequestCount === 1, { what: 'one closed' });
  assert.ok((await rig.entry('cl-1', 'req-1')).repliedAt, 'the exact id was closed first');
  rig.cue('cl-1', { cue: 'reply', to: 'god-1', in_reply_to: 'req-1', subject: 're: B', body: 'B done', file: 'rep2' });
  await waitFor(async () => (await rig.call('readers', { id: 'cl-1' })).fleet.openRequestCount === 0, { what: 'the alias closed the other' });
  assert.ok((await rig.entry('cl-1', r2e.id)).repliedAt, 'sender_id req-1 resolved to the reassigned entry');
  rd = await rig.call('readers', { id: 'cl-1' });
  assert.equal(rd.fleet.awaitingReplyCount, 0);
  assert.equal((await rig.rows('mail')).filter((r) => r.stage === 'replied').length, 2, 'two replied rows');
  void r1; void r2;
});

test('SCENARIO piggyback reminder: an open request the agent has SEEN rides along with its next mail block, until a reply routes', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: {} }]);
  const req = await rig.call('send', { to: 'cl-1', act: 'request', subject: 'review the plan', body: 'please review' });
  await rig.beatUntil(() => acted(rig, 'cl-1', req.id), { what: 'request seen' });
  const m2 = await rig.call('send', { to: 'cl-1', subject: 'fyi', body: 'unrelated news' });
  await rig.beatUntil(() => acted(rig, 'cl-1', m2.id), { what: 'm2 acted' });
  const c2 = rig.contexts('cl-1').find((c) => c.ids.includes(m2.id));
  assert.match(c2.context, /Still open \(no reply routed yet\):/);
  assert.ok(c2.context.includes(`[${req.id}]`) && c2.context.includes('review the plan'), 'the reminder names the open request');
  assert.ok(!markersIn(c2.context).includes(req.id), 'as a reminder line, not a re-surfaced body');
  rig.cue('cl-1', { cue: 'reply', to: 'god-1', in_reply_to: req.id, subject: 'reviewed', body: 'lgtm', file: 'rv' });
  await waitFor(async () => (await rig.entry('cl-1', req.id)).repliedAt, { what: 'replied' });
  const m3 = await rig.call('send', { to: 'cl-1', subject: 'more', body: 'more news' });
  await rig.beatUntil(() => acted(rig, 'cl-1', m3.id), { what: 'm3 acted' });
  const c3 = rig.contexts('cl-1').find((c) => c.ids.includes(m3.id));
  assert.doesNotMatch(c3.context, /Still open/, 'no reminder once the reply routed');
});

test('SCENARIO Codex stale task_complete: a replayed completion of the PREVIOUS turn acts nothing; the real one (rollout-only, lost Stop) does', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cx-1', flavour: 'codex', scenario: { manualTurns: true } }]);
  const m1 = await rig.call('send', { to: 'cx-1', subject: 'turn one', body: 'first' });
  await rig.beatUntil(() => rig.contexts('cx-1').some((c) => c.ids.includes(m1.id)), { what: 'turn 1 surfaced', settle: false, holdWhileBusy: true });
  rig.cue('cx-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cx-1', m1.id), { what: 'turn 1 acted' });
  const turn1 = (await waitFor(() => rig.turnEnds('cx-1')[0], { what: 'turn 1 ended' })).turn;

  const m2 = await rig.call('send', { to: 'cx-1', subject: 'turn two', body: 'second' });
  await rig.beatUntil(() => rig.contexts('cx-1').some((c) => c.ids.includes(m2.id)), { what: 'turn 2 surfaced', settle: false, holdWhileBusy: true });
  const turn2 = rig.contexts('cx-1').find((c) => c.ids.includes(m2.id)).turn;
  assert.notEqual(turn2, turn1);
  await waitFor(async () => (await rig.entry('cx-1', m2.id)).state === 'surfaced' || (await rig.entry('cx-1', m2.id)).state === 'surfacing', { what: 'm2 surfacing' });
  rig.cue('cx-1', { cue: 'stale-complete' });   // #52: task_complete for turn 1 again
  await waitFor(() => rig.transcript('cx-1').some((r) => r.kind === 'stale-complete' && r.turn === turn1), { what: 'stale line written' });
  for (let i = 0; i < 3; i++) { await rig.call('advance', { ms: 15_000 }); await rig.beat(); await sleep(250); }
  assert.notEqual((await rig.entry('cx-1', m2.id)).state, 'acted', 'the stale completion acted nothing');
  rig.cue('cx-1', { cue: 'lost-stop' });   // #45: turn 2 completes in the rollout; its Stop hook is lost
  // LOAD-FLAKES-176: the clock moves only once the stub has written turn 2's task_complete (an
  // EVENT); moving it while the cue was still queued behind a slow stub raced the product's
  // simulated-time rules against real process timing. The lost Stop keeps the agent busy, so
  // holdWhileBusy cannot be used here: the beats that read the rollout must run.
  await waitFor(() => rig.turnEnds('cx-1').some((r) => r.how === 'lost-stop' && r.turn === turn2), { what: 'turn 2 closed in the rollout' });
  await rig.beatUntil(() => acted(rig, 'cx-1', m2.id), { what: 'acted by the rollout close of ITS turn', stepMs: 15_000, settle: false, holdForStubs: true });
  const row = (await rig.rows('mail')).find((r) => r.stage === 'acted' && r.ids.includes(m2.id));
  assert.equal(row.epoch, turn2, 'the epoch is the Codex turn_id of turn 2');
});

test('SCENARIO migration import: legacy inbox mail imported with the legacy marker; an archived agent\'s mail set aside in .undelivered with its report, no wake', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([], { god: true });
  await rig.call('register', { id: 'cl-1', provider: 'claude' });
  await rig.call('register', { id: 'cl-old', provider: 'claude', archived: true });
  // A 1.1.74 hive: plain inbox files, a handled one in .done, and no state/mail at all.
  const put = (agent, id, dir = '') => {
    const d = path.join(rig.agentDir(agent), 'inbox', dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ id, from: 'god-1', to: agent, act: 'inform', subject: `old ${id}`, body: `body ${id}`, created_at: new Date().toISOString(), conversation: `c-${id}`, requires_reply: false }));
  };
  put('cl-1', 'old-a'); put('cl-1', 'old-b'); put('cl-1', 'old-done', '.done');
  put('cl-old', 'lost-1'); put('cl-old', 'lost-2');
  await rig.kill9();
  fs.rmSync(path.join(rig.sandbox, 'harness', 'hive', 'state', 'mail'), { recursive: true, force: true });
  await rig.boot();

  const mig = await rig.call('migration');
  assert.equal(mig.ran, true, 'the one-shot boot migration ran');
  const doc = await rig.call('ledger', { id: 'cl-1' });
  assert.deepEqual(Object.keys(doc.entries).sort(), ['old-a', 'old-b'], '.done is history, not imported');
  for (const e of Object.values(doc.entries)) assert.deepEqual([e.state, e.legacy], ['delivered', true]);
  assert.deepEqual(rig.inboxFiles('cl-old'), [], 'the archived agent\'s inbox is emptied');
  assert.deepEqual(fs.readdirSync(path.join(rig.agentDir('cl-old'), 'inbox', '.undelivered')).sort(), ['lost-1.json', 'lost-2.json']);
  const rep = await rig.call('undelivered');
  assert.deepEqual(rep.items.map((i) => i.id).sort(), ['lost-1', 'lost-2'], 'undelivered-report.json lists them for the Human');
  assert.ok(fs.existsSync(path.join(rig.sandbox, 'harness', 'hive', 'state', 'mail', 'migration-report.json')));

  await rig.respawn({ id: 'cl-1', flavour: 'claude', scenario: {} });
  await rig.beatUntil(async () => (await acted(rig, 'cl-1', 'old-a')) && (await acted(rig, 'cl-1', 'old-b')), { what: 'legacy mail handled' });
  const c = rig.contexts('cl-1')[0];
  assert.deepEqual(markersIn(c.context), ['old-a', 'old-b']);
  assert.equal(c.context.split(LEGACY).length - 1, 2, 'the legacy marker on each');
  assert.ok(!(await rig.call('registry')).agents['cl-old'] || (await rig.call('registry')).agents['cl-old'].archived, 'cl-old stays archived');
  assert.equal((await rig.call('outcomes')).filter((o) => o.agentId === 'cl-old').length, 0, 'nothing woken for the archived agent');
});

test('SCENARIO rollback (file level): a 1.1.75-written hive keeps inbox/.done semantics valid for 1.1.74, nothing lost', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const a = await rig.call('send', { to: 'cl-1', subject: 'will be acted', body: 'a' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(a.id)), { what: 'a surfaced' });
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(() => acted(rig, 'cl-1', a.id), { what: 'a acted' });
  await rig.call('capacityHold', { on: true });   // only the person starts turns from here
  await rig.call('humanType', { id: 'cl-1', text: 'next\r' });
  await waitFor(() => rig.hooks('cl-1', 'UserPromptSubmit').length === 2, { what: 'the person\'s turn started' });
  const b = await rig.call('send', { to: 'cl-1', subject: 'surfaced, not acted', body: 'b' });
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(async () => ['surfacing', 'surfaced'].includes((await rig.entry('cl-1', b.id)).state), { what: 'b surfaced mid-turn' });
  const c = await rig.call('send', { to: 'cl-1', subject: 'never shown', body: 'c' });
  await rig.call('flush');
  await sleep(500);
  await rig.kill9();   // the moment of the downgrade: 1.1.75 stops, 1.1.74 starts on this hive

  const inbox = path.join(rig.agentDir('cl-1'), 'inbox');
  const ledger = JSON.parse(fs.readFileSync(rig.ledgerFile('cl-1'), 'utf8'));
  const inInbox = new Set(rig.inboxFiles('cl-1'));
  const inDone = new Set(rig.doneFiles('cl-1'));
  // 1.1.74 reads: inbox/*.json = unhandled (re-woken), inbox/.done/*.json = handled.
  for (const e of Object.values(ledger.entries)) {
    if (e.state === 'acted') assert.ok(inDone.has(e.id) && !inInbox.has(e.id), `${e.id} acted: in .done only`);
    else assert.ok(inInbox.has(e.id) && !inDone.has(e.id), `${e.id} ${e.state}: still in inbox/, so 1.1.74 re-wakes it (at worst one duplicate handling)`);
  }
  assert.deepEqual([a.id, b.id, c.id].map((id) => inInbox.has(id) || inDone.has(id)), [true, true, true], 'no message exists only in the ledger: nothing lost');
  for (const f of fs.readdirSync(inbox)) {
    const p = path.join(inbox, f);
    if (fs.statSync(p).isDirectory()) { assert.ok(['.done', '.undelivered'].includes(f), `only known subdirectories (${f})`); continue; }
    assert.match(f, /\.json$/, 'only message files at the top of inbox/');
    const msg = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(`${msg.id}.json`, f, 'file name = id, as 1.1.74 expects');
    for (const k of ['from', 'to', 'subject', 'body']) assert.ok(k in msg, `1.1.74 message field ${k}`);
  }
  // 1.1.74 ignores state/mail/ (§7.2): nothing a 1.1.74 reader needs lives there.
  assert.ok(fs.existsSync(rig.ledgerFile('cl-1')));
});

test('SCENARIO hooks-shim stub (gemini, legacy-read at release): the <inbox-update> notice names mid-turn mail, the agent reads the files, its Stop acts what the notice named', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'gm-1', flavour: 'gemini', scenario: { manualTurns: true } }]);
  assert.equal((await rig.call('mailChannel', { id: 'gm-1' })).mode, 'legacy-read');
  await rig.call('humanType', { id: 'gm-1', text: 'work\r' });
  await waitFor(() => rig.hooks('gm-1', 'BeforeAgent').length === 1, { what: 'turn started' });
  const m = await rig.call('send', { to: 'gm-1', subject: 'mid', body: 'read me from the file' });
  const m2 = await rig.call('send', { to: 'gm-1', subject: 'second', body: 'also in the notice' });
  rig.cue('gm-1', { cue: 'tool' });
  const ctx = await waitFor(() => rig.contexts('gm-1').find((c) => c.event === 'AfterTool' && /<inbox-update>/.test(c.context)), { what: 'the legacy notice' });
  assert.ok(ctx.context.includes(m.id) && ctx.context.includes(m2.id), 'the notice names the files');
  assert.ok(!/\[hive-mail:/.test(ctx.context), 'no bodies for a legacy-read provider');
  await waitFor(() => rig.transcript('gm-1').some((r) => r.kind === 'read-file' && r.id === m.id), { what: 'the agent read it' });
  rig.cue('gm-1', { cue: 'stop' });
  await waitFor(async () => (await acted(rig, 'gm-1', m.id)) && (await acted(rig, 'gm-1', m2.id)), { what: 'acted at its Stop (legacy-read)' });
  assert.ok((await rig.rows('mail')).some((r) => r.stage === 'acted' && r.mode === 'legacy-read' && r.ids.includes(m.id) && r.ids.includes(m2.id)));
  assert.equal((await rig.call('outcomes')).length, 0, 'no wake typed');
});

// ——————————————————————————————————————————————————————————————————————— N1-N4 (§11.17)

test('N1 the unconfirmed re-surface loop is bounded: context DISCARDED (no transcript evidence) -> after 2 unconfirmed surfacings, latency-fallback + mail-evidence-missing + UI notice', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { hookMode: 'discard' } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'n1', body: 'evidence never appears' });
  await rig.beatUntil(() => acted(rig, 'cl-1', m.id), { what: 'acted by the fallback' });
  const e = await rig.entry('cl-1', m.id);
  assert.equal(e.confirmMethod, 'latency-fallback');
  assert.equal(e.surfaceCount, 3, 'two unconfirmed surfacings, then the fallback one');
  assert.equal((await rig.rows('mail-surface-unconfirmed')).filter((r) => r.ids.includes(m.id)).length, 2);
  assert.equal((await rig.rows('mail-evidence-missing')).length, 1);
  assert.ok((await rig.call('integrity')).some((i) => i.notice), 'the UI alert');
  assert.equal(rig.contexts('cl-1').filter((c) => c.ids.includes(m.id)).length, 3, 'the loop stopped at 3');
});

test('N1 + WAKE GENERATIONS (layer-b dry run #2): a beat DURING each unconfirmed surfacing (reconcile drops the id from the delivered set) and EVERY re-announcement is still TYPED under a new request id, never replayed', T, async (t) => {
  const rig = await startRig(t);
  // Manual turns: each typed wake opens a turn that stays open until the 'stop' cue, so a beat
  // (and its reconcile against the LEDGER's delivered set, which no longer holds the surfacing id)
  // runs INSIDE the surfacing, exactly as in the packaged dry run.
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { hookMode: 'discard', manualTurns: true } }]);
  const m = await rig.call('send', { to: 'cl-1', subject: 'n1-gen', body: 'context is discarded: surfaced twice unconfirmed, then the fallback' });
  const typed = () => rig.prompts('cl-1').filter((p) => String(p.text || '').includes(m.id)).length;
  const surfacing = async () => ['surfacing', 'surfaced'].includes((await rig.entry('cl-1', m.id)).state);
  for (let n = 1; n <= 3; n++) {
    await rig.beatUntil(async () => typed() >= n && (await surfacing()), { what: `announcement ${n} typed and surfacing`, stepMs: 16_000, settle: false, holdForStubs: true });
    await rig.beat();                 // a reconcile while the id is surfacing (not delivered)
    await sleep(300);
    rig.cue('cl-1', { cue: 'stop' });
    if (n < 3) await waitFor(async () => (await rig.entry('cl-1', m.id)).state === 'delivered', { what: `surfacing ${n} unconfirmed -> back to delivered` });
  }
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted after the fallback surfacing' });
  const e = await rig.entry('cl-1', m.id);
  assert.equal(e.confirmMethod, 'latency-fallback');
  assert.equal(e.surfaceCount, 3);
  assert.equal(typed(), 3, 'three announcements TYPED into the agent');
  const outs = (await rig.call('outcomes')).filter((o) => o.agentId === 'cl-1' && o.requestId.startsWith('inbox-wake:') && o.outcome.kind === 'COMMITTED');
  assert.equal(outs.length, 3, 'three committed wake requests (a replay would add none and type nothing)');
  assert.deepEqual(outs.map((o) => o.requestId.split(':').pop()), ['0', '1', '2'], 'generations 0, 1, 2 of the same id set');
  assert.equal(new Set(outs.map((o) => o.requestId)).size, 3);
});

test('N1 BUDGET (layer-b dry run #4): an idle agent whose surfacing evidence never appears reaches acted via latency-fallback in SECONDS, event-driven after one kick beat: no simulated time, no 5-minute F4 wait', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { hookMode: 'discard' } }]);
  const clock0 = await rig.call('advance', { ms: 0 });
  const m = await rig.call('send', { to: 'cl-1', subject: 'n1-budget', body: 'no transcript evidence: two unconfirmed surfacings, then the latency fallback' });
  // ONE beat at the same simulated instant starts the first wake (an idle agent's delivery wake
  // needs the beat's idle reading); after that no beat and no advance: only the Stop-driven
  // re-offers may move it.
  await rig.beat();
  // Before the fix the second unconfirmed surfacing spent the once-budget and the confirming
  // third surfacing waited out the F4 backoff (300 s): this never held.
  await waitFor(() => acted(rig, 'cl-1', m.id), { what: 'acted by the N1 fallback, event-driven', timeoutMs: 30_000 });
  const e = await rig.entry('cl-1', m.id);
  assert.equal(e.confirmMethod, 'latency-fallback');
  assert.equal(e.surfaceCount, 3, 'two unconfirmed surfacings, then the confirming one');
  assert.equal(await rig.call('advance', { ms: 0 }), clock0, 'the simulated clock never moved');
  const wake = (await rig.call('diags', {})).filter((d) => d.agentId === 'cl-1');
  assert.ok(wake.some((r) => r.stage === 'wake-repend' && Array.isArray(r.n1) && r.n1.includes(m.id)), 'the N1 re-offer is logged');
  assert.ok(!wake.some((r) => r.stage === 'wake-ids-exhausted' && (r.idList || []).includes(m.id)), 'never sent to the F4 backoff');
});

test('P1 rig (dry #6 order, ON HOLD): the owner\'s COMMITTED lands AFTER the fast turn\'s Stop; the agent is not wedged, the next mail is acted without simulated time', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cx-1', flavour: 'codex', scenario: {} }]);
  await rig.call('delaySettle', { id: 'cx-1', ms: 4000 });   // longer than the fake agent's turn
  const clock0 = await rig.call('advance', { ms: 0 });
  const m1 = await rig.call('send', { to: 'cx-1', subject: 'p1-one', body: 'the wake whose turn ends before its COMMITTED' });
  await rig.beat();
  await waitFor(() => acted(rig, 'cx-1', m1.id), { what: 'm1 acted (its turn ran before the settle)', timeoutMs: 30_000 });
  const committed = async () => (await rig.call('outcomes')).filter((o) => o.agentId === 'cx-1' && o.outcome.kind === 'COMMITTED').length;
  await waitFor(async () => (await committed()) >= 1, { what: 'the delayed COMMITTED has settled', timeoutMs: 15_000 });
  await sleep(4500);   // the bridge's settle follows the owner's outcome by the injected delay
  await rig.call('delaySettle', { id: 'cx-1', ms: 0 });
  const m2 = await rig.call('send', { to: 'cx-1', subject: 'p1-two', body: 'dry #6: refused as lifecycle-active for 27 min' });
  await rig.beat();   // at the same simulated instant
  try { await waitFor(() => acted(rig, 'cx-1', m2.id), { what: 'm2 acted: the agent is not wedged', timeoutMs: 30_000 }); } catch (e) {
    const why = [...new Set((await rig.call('diags', {})).filter((d) => d.agentId === 'cx-1' && d.stage === 'no-claim').map((d) => d.why))];
    throw new Error(`${e.message}; cx-1 refusals: ${JSON.stringify(why)}; state ${JSON.stringify((await rig.call('wakeState', { id: 'cx-1' })).lifecycle)}`);
  }
  assert.equal(await rig.call('advance', { ms: 0 }), clock0, 'no simulated time passed (no 60 s recovery, no backoff)');
});

test('N2 hookless (custom) and proxy (qwen) work orders: acted = the confirmed PTY write, via:"work-order", never backlog', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cu-1', flavour: 'custom', scenario: {} }, { id: 'qw-1', flavour: 'qwen', scenario: {} }]);
  const a = await rig.call('send', { to: 'cu-1', act: 'request', subject: 'wo custom', body: 'do the custom thing' });
  const b = await rig.call('send', { to: 'qw-1', subject: 'wo qwen', body: 'do the qwen thing' });
  // Automatic delivery to an unmeasured provider is refused by the gate: the Human's "send now".
  await waitFor(async () => (await rig.call('workOrders', { id: 'cu-1' })).length === 1 && (await rig.call('workOrders', { id: 'qw-1' })).length === 1, { what: 'queued' });
  assert.equal((await rig.call('readers', { id: 'cu-1' })).backlog, 0, 'not backlog while queued (no inbox file, no ledger entry)');
  assert.deepEqual(await rig.call('sendNow', { id: 'cu-1' }), ['COMMITTED']);
  assert.deepEqual(await rig.call('sendNow', { id: 'qw-1' }), ['COMMITTED']);
  for (const [agent, id] of [['cu-1', a.id], ['qw-1', b.id]]) {
    await waitFor(() => acted(rig, agent, id), { what: `${agent} acted` });
    const e = await rig.entry(agent, id);
    assert.equal(e.via, 'work-order');
    assert.equal((await rig.call('readers', { id: agent })).backlog, 0);
    await waitFor(() => rig.transcript(agent).some((r) => r.kind === 'work-order' && r.id === id), { what: `${agent} got the whole work order` });
    assert.deepEqual(rig.inboxFiles(agent), [], 'no inbox file');
  }
  assert.equal((await rig.call('readers', { id: 'cu-1' })).fleet.openRequestCount, 1, 'a request still awaits its reply');
  await waitFor(() => rig.transcript('qw-1').some((r) => r.kind === 'proxy-call' && r.status === 200), { what: 'qwen spoke to its sidecar (upstream: the rig fake LLM)' });
});

test('N3 a mid-turn UserPromptSubmit (the person typing into a live turn) JOINS the epoch: no abnormal close, each id surfaced once', T, async (t) => {
  const rig = await startRig(t);
  await rig.setup([{ id: 'cl-1', flavour: 'claude', scenario: { manualTurns: true } }]);
  const m1 = await rig.call('send', { to: 'cl-1', subject: 'n3 one', body: 'first' });
  await rig.beat();
  await waitFor(() => rig.contexts('cl-1').some((c) => c.ids.includes(m1.id)), { what: 'm1 surfaced' });
  rig.cue('cl-1', { cue: 'tool' });
  await waitFor(async () => (await rig.entry('cl-1', m1.id)).state === 'surfaced', { what: 'confirmed' });
  const epoch = await rig.call('mailEpoch', { id: 'cl-1' });
  const m2 = await rig.call('send', { to: 'cl-1', subject: 'n3 two', body: 'second' });
  await rig.call('humanType', { id: 'cl-1', text: 'also do this\r' });
  await waitFor(() => rig.contexts('cl-1').some((c) => c.midTurn && c.ids.includes(m2.id)), { what: 'the joined prompt carries m2' });
  assert.equal(await rig.call('mailEpoch', { id: 'cl-1' }), epoch, 'the same epoch');
  rig.cue('cl-1', { cue: 'stop' });
  await waitFor(async () => (await acted(rig, 'cl-1', m1.id)) && (await acted(rig, 'cl-1', m2.id)), { what: 'both acted' });
  assert.equal((await rig.rows('mail')).filter((r) => r.stage === 'redelivered').length, 0, 'nothing closed abnormally');
  const counts = rig.contexts('cl-1').flatMap((c) => c.ids);
  assert.equal(counts.filter((x) => x === m1.id).length, 1, 'm1 surfaced once');
  assert.equal(counts.filter((x) => x === m2.id).length, 1, 'm2 surfaced once');
  for (const id of [m1.id, m2.id]) assert.equal((await rig.entry('cl-1', id)).epoch, epoch);
});

test('N4 no downgrade helper exists (§11.17 N4 drops §11.12(a)): no downgrade-archive code or marker anywhere in src/', () => {
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|cjs|js)$/.test(e.name)) out.push(p); } return out; };
  const hits = [];
  for (const f of walk(path.join(__dirname, '..', 'src'))) {
    const code = codeOnly(fs.readFileSync(f, 'utf8'));
    if (/downgrade[-_ ]?archive|downgradeArchive|downgrade[-_ ]?helper|downgrade[-_ ]?marker/i.test(code)) hits.push(path.relative(path.join(__dirname, '..'), f));
  }
  assert.deepEqual(hits, [], 'no downgrade helper, marker or boot hook for 1.1.74');
  void readSource;
});

const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const has175 = /^#+\s*\[?v?1\.1\.75\b/m.test(changelog);
test('N4 the rollback text is present: god\'s one reminder broadcast (§11.12(b)) in the 1.1.75 release notes', has175 ? {} : { todo: 'the 1.1.75 CHANGELOG entry is the final slice\'s job (not written yet)' }, () => {
  const at = changelog.search(/^#+\s*\[?v?1\.1\.75\b/m);
  assert.ok(at >= 0, 'a 1.1.75 section exists');
  // The section ends at the next release heading AFTER its own heading line (slicing from at + 1
  // left "# [1.1.75]" at the start of the string, which the ^ anchor matched: an empty section).
  const body = changelog.indexOf('\n', at) + 1;
  const next = changelog.slice(body).search(/^#+\s*\[?v?1\.1\.\d+\b/m);
  const section = next >= 0 ? changelog.slice(at, body + next) : changelog.slice(at);
  assert.ok(section.includes('1.1.74 restored: move handled mail to inbox/.done again'), 'the exact reminder text');
  assert.match(section, /archived/i, 'the archived-bounce behaviour change is listed');
  assert.match(section, /acted/i, 'acted = seen is listed');
});
