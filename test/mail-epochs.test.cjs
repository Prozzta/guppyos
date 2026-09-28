'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 3: acted, Stop / StopFailure and the epoch back-edges (INBOX-DESIGN.md
 * §1.1, §3 #1-#3, §7.1 step 4, §11.1, §11.3, §11.4, §11.5, §11.7, §11.10, §11.17 N1/N3; Jim's
 * audit #4). Zero model tokens: a real (jailed) hive, a real HookServer, the real wake
 * coordinator and bridge, wired to each other as src/main/index.ts wires them, with a fake clock
 * on the bridge. HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-epochs-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { InboxWakeBridge, MAIL_DEGRADE_AFTER_WAKES } = loadTs('src/main/inboxWakeBridge.ts');
const W = loadTs('src/main/workerWake.ts');
const { WorkerWakeWatchdog, inboxWakeRequestId, inboxWakeClaimId, SUBMIT_CONFIRM_MS, WORKER_WAKE_COOLDOWN_MS } = W;
const { MAIL_STALE_EPOCH_MS, MAIL_UNPARSEABLE_AFTER, MAIL_UNPARSEABLE_SPAN_MS } = loadTs('src/main/mailLedger.ts');
const { coordinatorPendingIds } = loadTs('src/main/mailReaders.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

const markersIn = (text) => [...(text ?? '').matchAll(/\[hive-mail:([^\]]+)\]/g)].map((m) => m[1]);
const REDELIVERED = '(re-delivered: this may already have been handled';

/**
 * A floor wired like main: HookServer → bridge.onHook; epoch closes → bridge.onMailEpochClosed;
 * mail blocks → bridge.onMailBlock; the coordinator's pending = ledger delivered ids (§3 #1).
 */
async function world(t, { providers = {}, confirms = () => true, probe = null, goal = () => null } = {}) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  const w = { now: Date.now(), queue: [], reqs: [], diags: [], lastOutput: new Map(), outcome: () => ({ kind: 'COMMITTED' }) };
  let server = null;
  t.after(() => { try { server?.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const id of Object.keys(providers)) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); for (const [id, p] of Object.entries(providers)) r.agents[id] = { ...r.agents[id], provider: p }; return r; };
  const coordinator = new WorkerWakeWatchdog();
  // The REAL pending rule index.ts wires (mailReaders.coordinatorPendingIds), with the same deps
  // (mutant K13: a copy here let a broken skip filter in main survive).
  const pending = (a) => coordinatorPendingIds(a, {
    mode: (x) => server.mailChannel(x).mode,
    pending: (x) => hive.mail.pending(x),
    skipped: (x) => server.mailSkippedIds(x),
    files: (x) => hive.inbox(x).map((m) => m.id)
  });
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: pending,
    facts: (a) => ({ ptyId: `pty-${a}`, lastOutputAt: w.lastOutput.get(a) ?? 1, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: (req) => { w.reqs.push(req); return Promise.resolve(w.outcome(req)); },
    text: (ids) => `You have new hive mail: ${ids.join(', ')}`,
    setImmediate: (fn) => w.queue.push(fn),
    now: () => w.now,
    diag: (stage, fields) => w.diags.push({ stage, ...fields }),
    confirmsTurnStart: confirms,
    ...(probe ? { codexTurnProbe: () => probe.current } : {}),
    mail: {
      mode: (a) => server.mailChannel(a).mode,
      closeTurn: (a, turnId) => { server.closeMailTurn(a, turnId); },
      abortSince: (a, since) => { server.abortMailEpochsSince(a, since, 'submit-unconfirmed'); },
      closeStale: (a, now) => server.closeStaleMailEpochs(a, now),
      hasOpenEpoch: (a) => hive.mail.openEpochs(a).length > 0,
      n1DueIds: (a) => hive.mail.n1Due(a),
      openIds: (a) => hive.mail.openNotDelivered(a),
      degrade: (a, reason, detail) => hive.mail.degradeChannel(a, reason, detail)
    }
  });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, (id) => goal(id),
    (a, e, m, fi, turn, src) => bridge.onHook(a, e, m, fi, turn, src));
  server.setMailCoordination({
    lifecycleActive: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && !s.provisional; },
    wakeIds: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && s.provisional ? [] : s.announced; },
    onEpochClosed: (a, o, r, ids) => bridge.onMailEpochClosed(a, o, r, ids),
    onMailBlock: (a) => bridge.onMailBlock(a)
  });
  hive.setDeliveryObserver(({ agentId, messageId }) => bridge.onDelivery(agentId, messageId));
  w.hive = hive; w.server = server; w.bridge = bridge; w.coordinator = coordinator; w.home = home;
  w.flush = async () => { for (let i = 0; i < 5; i++) { while (w.queue.length) w.queue.shift()(); await new Promise((r) => setImmediate(r)); } };
  w.fire = (agent_id, hook_event_name, extra = {}) => server.handle({ agent_id, hook_event_name, session_id: `s-${agent_id}`, transport: 'http', ...extra });
  w.ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
  w.entry = (a, id) => hive.mail.ledger(a).entries[id];
  w.rows = (kind) => hive.logTail(5000).filter((r) => r.kind === kind);
  w.send = (to, extra = {}) => hive.send({ to, act: 'inform', subject: 's', body: 'b', ...extra }, 'god-1');
  /** Confirm every tentative id of this agent's current epoch (as its transcript would). */
  w.confirm = (a) => { const e = server.mailEpoch(a); server.takeMailClaims(); return hive.mail.confirmSurfaced(a, Object.keys(hive.mail.ledger(a).entries), e, 'evidence'); };
  return w;
}

// ————————————————————————————————————————————————— god db52b8: explicit archive of a LIVE session

test('db52b8: an explicit archive while the PTY is still live (IPC / voice, no teardown), then a hook and a Stop: set aside, no body-missing, no banner, no rename; restore returns each exactly once under its own id', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const inbox = path.join(w.hive.root(), 'agents', 'cl-1', 'inbox');
  const ls = (...p) => { try { return fs.readdirSync(path.join(inbox, ...p)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };
  const m1 = w.send('cl-1', { subject: 'one', body: 'surfaced before the archive' });
  assert.deepEqual(markersIn(w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' }))), [m1.id]);
  w.confirm('cl-1');
  assert.equal(w.entry('cl-1', m1.id).state, 'surfaced');
  const m2 = w.send('cl-1', { subject: 'two', body: 'delivered mid-turn' });
  assert.equal(w.entry('cl-1', m2.id).state, 'delivered');
  // The explicit archive WITHOUT a teardown: the session is still live.
  w.hive.setArchived('cl-1', true);
  assert.deepEqual(ls(), [], 'both files set aside');
  assert.deepEqual(ls('.undelivered'), [`${m1.id}.json`, `${m2.id}.json`].sort());
  assert.ok(w.entry('cl-1', m1.id).setAsideAt && w.entry('cl-1', m2.id).setAsideAt, 'marked set-aside in the same step');
  assert.deepEqual(w.hive.mail.pending('cl-1').map((e) => e.id), [], 'not pending while set aside');
  // A later hook of the live session, then its Stop.
  const post = w.ctx(w.fire('cl-1', 'PostToolUse', {}));
  assert.deepEqual(markersIn(post), [], 'nothing surfaced from .undelivered/');
  w.fire('cl-1', 'Stop');
  w.hive.mail.flushAll();
  assert.equal(w.entry('cl-1', m1.id).state, 'surfaced', 'never acted at the Stop');
  assert.equal(w.entry('cl-1', m2.id).state, 'delivered', 'never closed as missing');
  assert.ok(!w.entry('cl-1', m2.id).missingAt && !w.entry('cl-1', m1.id).missingAt);
  for (const kind of ['mail-body-missing', 'mail-archive-failed']) assert.deepEqual(w.rows(kind), [], `no ${kind} row`);
  assert.ok(!w.rows('mail').some((r) => r.stage === 'acted'), 'no acted row');
  assert.ok(!w.hive.integrityIssues().some((i) => i.error === 'mail-body-missing'), 'no false banner');
  assert.deepEqual(ls('.done'), [], 'nothing renamed into .done');
  // Restore: both come back once, under their own ids, delivered and pending (m1 with the marker).
  w.hive.setArchived('cl-1', false);
  assert.deepEqual(ls(), [`${m1.id}.json`, `${m2.id}.json`].sort(), 'own names, no <stem>.N');
  assert.deepEqual(ls('.undelivered'), []);
  for (const m of [m1, m2]) {
    const e = w.entry('cl-1', m.id);
    assert.deepEqual({ state: e.state, setAside: e.setAsideAt ?? null }, { state: 'delivered', setAside: null });
  }
  assert.deepEqual(w.hive.mail.pending('cl-1').map((e) => e.id).sort(), [m1.id, m2.id].sort());
  assert.equal(Object.keys(w.hive.mail.ledger('cl-1').entries).filter((id) => id.startsWith(m1.id) || id.startsWith(m2.id)).length, 2, 'exactly one entry each');
  const again = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'back' }));
  assert.deepEqual(markersIn(again).sort(), [m1.id, m2.id].sort(), 'each surfaced once after the restore');
  w.confirm('cl-1');
  w.fire('cl-1', 'Stop');
  assert.equal(w.entry('cl-1', m1.id).state, 'acted');
  assert.equal(w.entry('cl-1', m2.id).state, 'acted');
});

// ————————————————————————————————————————————————— the ledger's epochs at Stop (§1.1, §11.1)

test('Stop: a surfaced id becomes acted ONLY for the epoch that Stop closes; the harness then moves its file to .done', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m1 = w.send('cl-1', { subject: 'one', body: 'first' });
  assert.deepEqual(markersIn(w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' }))), [m1.id]);
  const e1 = w.server.mailEpoch('cl-1');
  w.confirm('cl-1');
  // Another epoch's close (a straggler naming another turn) acts nothing here.
  w.hive.mail.closeEpoch('cl-1', 'some-other-epoch', 'normal');
  assert.equal(w.entry('cl-1', m1.id).state, 'surfaced');
  w.fire('cl-1', 'Stop');
  const e = w.entry('cl-1', m1.id);
  assert.deepEqual({ state: e.state, epoch: e.epoch }, { state: 'acted', epoch: e1 });
  assert.ok(w.rows('mail').some((r) => r.stage === 'acted' && r.epoch === e1 && r.ids.includes(m1.id)));
  w.hive.mail.flushAll();
  const inbox = path.join(w.hive.root(), 'agents', 'cl-1', 'inbox');
  assert.ok(!fs.existsSync(path.join(inbox, `${m1.id}.json`)) && fs.existsSync(path.join(inbox, '.done', `${m1.id}.json`)), 'the harness archived it');
  // A second Stop is idempotent.
  w.fire('cl-1', 'Stop');
  assert.equal(w.rows('mail').filter((r) => r.stage === 'acted').length, 1);
});

test('§11.1: the evidence is scanned AT the Stop: a transcript record written just before it (no hook in between) confirms, and the id is acted', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const tr = path.join(w.home, 'transcript.jsonl');
  fs.writeFileSync(tr, '');
  const m = w.send('cl-1');
  const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go', transcript_path: tr }));
  fs.appendFileSync(tr, `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [c] } })}\n`);
  w.fire('cl-1', 'Stop');
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, method: e.confirmMethod }, { state: 'acted', method: 'evidence' });
});

test('§11.1: a surfacing never CONFIRMED is re-pended at the closing Stop (mail-surface-unconfirmed) and re-surfaced with the marker', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  const epoch = w.server.mailEpoch('cl-1');
  w.fire('cl-1', 'Stop');   // no transcript record ever appeared
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered, n1: e.unconfirmedSurfacings }, { state: 'delivered', redelivered: true, n1: 1 });
  assert.ok(w.rows('mail-surface-unconfirmed').some((r) => r.epoch === epoch && r.ids.includes(m.id)));
  const next = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'next' }));
  assert.ok(next.includes(`[hive-mail:${m.id}]`) && next.includes(REDELIVERED));
});

test('§11.1 + Q8: a LATE surfacing is re-pended at Stop as mail-surface-late, the row naming the transport and the elapsed ms', async (t) => {
  const w = await world(t, { providers: { 'ag-1': 'antigravity' } });
  const m = w.send('ag-1');
  w.fire('ag-1', 'PreInvocation', { transport: 'pipe' });
  const claims = w.server.takeMailClaims();
  w.server.settleMailClaims(claims, 1_000, 1_000 + 3_100);   // past the 2.5 s pipe limit
  const epoch = w.server.mailEpoch('ag-1');
  w.fire('ag-1', 'Stop', { transport: 'pipe' });
  const e = w.entry('ag-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  const row = w.rows('mail-surface-late').find((r) => r.ids.includes(m.id));
  assert.deepEqual({ epoch: row.epoch, transport: row.transport, latencyMs: row.latencyMs, reason: row.reason }, { epoch, transport: 'pipe', latencyMs: 3_100, reason: 'late' });
});

test('§11.4: Claude StopFailure (an API error) is an ABNORMAL end: surfaced ids back to delivered with the marker; the hook is registered like Stop', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  w.fire('cl-1', 'StopFailure', { error: 'rate_limit' });
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'stop-failure' && r.ids.includes(m.id)));
  assert.equal(w.rows('mail').filter((r) => r.stage === 'acted').length, 0);
  // Registered in the settings the harness writes, exactly like Stop (http broker and command shim).
  const url = `http://127.0.0.1:60971/hook/cl-1/${'a'.repeat(32)}`;
  const withBroker = w.hive.hookSettings('C:/hive/bin/cth-hook.cjs', w.home, {}, undefined, url, 'cl-1');
  const noBroker = w.hive.hookSettings('C:/hive/bin/cth-hook.cjs', w.home, {}, undefined, null, 'cl-1');
  for (const s of [withBroker, noBroker]) assert.deepEqual(s.hooks.StopFailure, s.hooks.Stop);
});

// ————————————————————————————————————————————————— interrupts and N3 (§11.4, §11.17 N3)

test('§11.4: an interrupt (no Stop), then the next UserPromptSubmit while the lifecycle is IDLE closes the epoch as abnormal; the ids surface again, with the marker, in that same turn', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  const m = w.send('cl-1', { body: 'do the thing' });
  await w.flush();
  assert.equal(w.reqs.length, 1, 'woken');
  assert.deepEqual(markersIn(w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[0].text }))), [m.id]);
  const e1 = w.server.mailEpoch('cl-1');
  w.confirm('cl-1');
  // Esc: no Stop. Claude then goes idle (its idle Notification).
  w.fire('cl-1', 'Notification', { message: 'Claude is waiting for your input' });
  assert.equal(w.coordinator.state('cl-1').lifecycle, 'idle');
  const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'where were we?' }));
  assert.ok(c.includes(`[hive-mail:${m.id}]`) && c.includes(REDELIVERED), c);
  assert.notEqual(w.server.mailEpoch('cl-1'), e1, 'a new epoch');
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, epoch: e.epoch }, { state: 'surfacing', epoch: w.server.mailEpoch('cl-1') });
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'interrupted' && r.epoch === e1));
});

test('N3: our OWN unconfirmed wake nudge is not a live turn: after an interrupt, the wake\'s UserPromptSubmit (lifecycle active but provisional) closes the old epoch as abnormal', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  const m = w.send('cl-1', { subject: 'first' });
  await w.flush();
  w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[0].text });
  w.confirm('cl-1');
  const e1 = w.server.mailEpoch('cl-1');
  w.now += 60_000;
  w.fire('cl-1', 'Notification', { message: 'Claude is waiting for your input' });   // interrupted, then idle
  w.now += 1_000;
  const n = w.send('cl-1', { subject: 'second' });
  await w.flush();
  assert.equal(w.reqs.length, 2, 'a new wake');
  assert.equal(w.coordinator.state('cl-1').provisional, true, 'COMMITTED, not yet confirmed');
  const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[1].text }));
  assert.notEqual(w.server.mailEpoch('cl-1'), e1, 'a new turn, not a join');
  assert.deepEqual(markersIn(c).sort(), [m.id, n.id].sort());
  assert.ok(c.includes(REDELIVERED), 'the interrupted one carries the marker');
});

test('N3: a UserPromptSubmit while the lifecycle is ACTIVE (the human typing into a live turn) JOINS the epoch: nothing closes, nothing surfaces twice', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  const e1 = w.server.mailEpoch('cl-1');
  assert.equal(w.coordinator.state('cl-1').lifecycle, 'active');
  const n = w.send('cl-1', { subject: 'later', body: 'later body' });
  const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'also this' }));
  assert.equal(w.server.mailEpoch('cl-1'), e1, 'the same epoch');
  assert.deepEqual(markersIn(c), [n.id], 'only the new mail; the live one is not surfaced twice');
  assert.equal(w.entry('cl-1', m.id).state, 'surfaced');
  assert.equal(w.rows('mail').filter((r) => r.stage === 'redelivered').length, 0);
  w.confirm('cl-1');
  w.fire('cl-1', 'Stop');
  assert.deepEqual([w.entry('cl-1', m.id).state, w.entry('cl-1', n.id).state], ['acted', 'acted']);
});

test('§11.4: SessionStart(startup|resume) closes whatever the previous session left open, as abnormal', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  w.fire('cl-1', 'SessionStart', { source: 'resume' });
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'session-resume'));
});

// ————————————————————————————————————————————————— compaction (§11.5)

test('§11.5: SessionStart(compact) opens no epoch and re-injects the ids surfaced in it; the re-injection is a surfacing step, confirmed by evidence, and acted at the Stop', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const tr = path.join(w.home, 'transcript.jsonl');
  fs.writeFileSync(tr, '');
  const m = w.send('cl-1', { subject: 'keep me', body: 'the body to keep' });
  const c1 = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go', transcript_path: tr }));
  const attach = (text) => fs.appendFileSync(tr, `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] } })}\n`);
  attach(c1);
  w.fire('cl-1', 'PostToolUse', {});
  assert.equal(w.entry('cl-1', m.id).state, 'surfaced');
  const epoch = w.server.mailEpoch('cl-1');
  const c = w.ctx(w.fire('cl-1', 'SessionStart', { source: 'compact' }));
  assert.equal(w.server.mailEpoch('cl-1'), epoch, 'not an epoch boundary');
  assert.match(c, /Your context was compacted\. 1 message\(s\) you already received in this turn/);
  assert.ok(c.includes(`[hive-mail:${m.id}]`) && c.includes('the body to keep'));
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, epoch: e.epoch, hookKind: e.hookKind, count: e.surfaceCount }, { state: 'surfacing', epoch, hookKind: 'SessionStart', count: 2 });
  attach(c);
  w.fire('cl-1', 'PostToolUse', {});
  assert.equal(w.entry('cl-1', m.id).state, 'surfaced', 'confirmed by the transcript record of the re-injection');
  w.fire('cl-1', 'Stop');
  assert.equal(w.entry('cl-1', m.id).state, 'acted');
});

test('§11.5: a re-injection that does not fit the joined budget goes back to delivered (marker) and drips in again in the SAME epoch', async (t) => {
  let goal = null;
  const w = await world(t, { providers: { 'cl-1': 'claude' }, goal: () => goal });
  const m = w.send('cl-1', { body: 'x'.repeat(2_000) });
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  const epoch = w.server.mailEpoch('cl-1');
  goal = 'G'.repeat(8_600);   // the standing goal rides SessionStart too: < 1,500 left for mail
  const c = w.ctx(w.fire('cl-1', 'SessionStart', { source: 'compact' }));
  assert.ok(!c.includes('hive-mail:'), 'no body past the budget');
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'compact-overflow'));
  goal = null;
  const post = w.ctx(w.fire('cl-1', 'PostToolUse', {}));
  assert.ok(post.includes(`[hive-mail:${m.id}]`) && post.includes(REDELIVERED), 'it drips in again in this turn');
  assert.equal(w.entry('cl-1', m.id).epoch, epoch);
});

// ————————————————————————————————————————————————— Codex (§1.1, #45, #52)

test('Codex: rollout task_complete for the SAME turn id acts that turn\'s mail; a STALE task_complete of an earlier turn acts nothing (#52)', async (t) => {
  const probe = { current: null };
  const w = await world(t, { providers: { 'cx-1': 'codex' }, probe });
  const m1 = w.send('cx-1', { subject: 'one' });
  w.fire('cx-1', 'UserPromptSubmit', { prompt: '[hive] check inbox', turn_id: 'T1', transport: 'pipe' });
  w.confirm('cx-1');
  w.fire('cx-1', 'Stop', { turn_id: 'T1', transport: 'pipe' });
  assert.equal(w.entry('cx-1', m1.id).state, 'acted');
  const m2 = w.send('cx-1', { subject: 'two' });
  w.fire('cx-1', 'UserPromptSubmit', { prompt: '[hive] check inbox', turn_id: 'T2', transport: 'pipe' });
  w.confirm('cx-1');
  assert.equal(w.entry('cx-1', m2.id).epoch, 'T2');
  // T2's Stop is lost. The rollout's newest boundary is the STALE completion of T1.
  probe.current = { ok: true, latest: { kind: 'complete', turnId: 'T1', at: w.now + 10 } };
  w.bridge.reconcileAll(['cx-1']);
  assert.equal(w.entry('cx-1', m2.id).state, 'surfaced', 'a stale task_complete is not T2\'s end');
  assert.equal(w.coordinator.state('cx-1').lifecycle, 'active');
  // ...and even a direct close of T1 touches only T1's epoch.
  w.server.closeMailTurn('cx-1', 'T1');
  assert.equal(w.entry('cx-1', m2.id).state, 'surfaced');
  // T2 completes: its mail is acted.
  probe.current = { ok: true, latest: { kind: 'complete', turnId: 'T2', at: w.now + 20 } };
  w.bridge.reconcileAll(['cx-1']);
  assert.equal(w.entry('cx-1', m2.id).state, 'acted');
  assert.ok(w.rows('mail').some((r) => r.stage === 'acted' && r.epoch === 'T2'));
});

test('Codex: a Stop naming ANOTHER turn (a straggler, #45) closes only that turn; the live one stays open', async (t) => {
  const w = await world(t, { providers: { 'cx-1': 'codex' } });
  const m = w.send('cx-1');
  w.fire('cx-1', 'UserPromptSubmit', { prompt: '[hive] check inbox', turn_id: 'T5', transport: 'pipe' });
  w.confirm('cx-1');
  w.fire('cx-1', 'Stop', { turn_id: 'T4', transport: 'pipe' });
  assert.equal(w.entry('cx-1', m.id).state, 'surfaced');
  assert.equal(w.server.mailEpoch('cx-1'), 'T5');
  w.fire('cx-1', 'Stop', { turn_id: 'T5', transport: 'pipe' });
  assert.equal(w.entry('cx-1', m.id).state, 'acted');
});

// ————————————————————————————————————————————————— §11.3: the coordinator keyed to the ledger

test('C3 (§11.3): a text-only wake turn whose block overflowed: the id never surfaced is re-pended at the Stop and woken again, once', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  const a = w.send('cl-1', { subject: 'a', body: 'A'.repeat(6_000) });
  const b = w.send('cl-1', { subject: 'b', body: 'B'.repeat(6_000) });
  await w.flush();
  assert.equal(w.reqs.length, 1);
  assert.equal(w.reqs[0].requestId, inboxWakeClaimId('cl-1', [a.id, b.id].sort(), 0));
  const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[0].text }));
  assert.deepEqual(markersIn(c), [a.id], 'b did not fit this block');
  w.confirm('cl-1');
  // Text only: no PostToolUse, so b never drips in. The Stop closes the wake's epoch.
  w.fire('cl-1', 'Stop');
  assert.equal(w.entry('cl-1', a.id).state, 'acted');
  assert.equal(w.entry('cl-1', b.id).state, 'delivered');
  assert.ok(w.diags.some((d) => d.stage === 'wake-repend' && d.requeued === 1));
  await w.flush();
  assert.equal(w.reqs.length, 2, 're-pended and woken at that Stop');
  assert.equal(w.reqs[1].requestId, inboxWakeClaimId('cl-1', [b.id], 0), 'a NEW id: [b] alone was never announced before (its own first generation)');
  // No id is announced and delivered after its epoch closed.
  const s = w.coordinator.state('cl-1');
  assert.ok(!s.pending.includes(a.id) && !s.announced.includes(a.id));
});

test('§3 #1/#3: the coordinator\'s pending set is the ledger\'s delivered ids, not the files; a moved or surfaced file wakes nobody, and a surfaced id is never burned', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  const m = w.send('cl-1');
  // A human turn surfaces it before the wake is typed: nothing left to wake for.
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'hello' });
  await w.flush();
  assert.equal(w.reqs.length, 0, 'surfaced (no longer delivered): no wake');
  assert.ok(fs.existsSync(path.join(w.hive.root(), 'agents', 'cl-1', 'inbox', `${m.id}.json`)), 'though the file is still in inbox/');
  // Abnormal end: back to delivered, pending again, woken.
  w.fire('cl-1', 'StopFailure', {});
  w.fire('cl-1', 'Notification', { message: 'Claude is waiting for your input' });
  await w.flush();
  assert.equal(w.reqs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(w.coordinator.state('cl-1').announced)), [m.id]);
});

// ————————————————————————————————————————————————— abnormal ends outside hooks (§1.1)

test('§1.1: PTY exit / respawn (abortMailTurn) and submit-unconfirmed close open epochs as abnormal, with the marker', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  assert.equal(w.server.abortMailTurn('cl-1', 'respawn').length, 1);
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'respawn'));
  const post = w.ctx(w.fire('cl-1', 'PostToolUse', {}));
  assert.ok(post.includes(`[hive-mail:${m.id}]`) && post.includes(REDELIVERED), 'the new incarnation gets it again');
  // submit-unconfirmed: only epochs opened since the carrying wake's claim.
  const since = Date.now() + 60_000;
  assert.deepEqual(w.server.abortMailEpochsSince('cl-1', since), [], 'an epoch older than the claim is not the wake\'s');
  assert.equal(w.server.abortMailEpochsSince('cl-1', 0).length, 1);
  assert.ok(w.rows('mail').some((r) => r.stage === 'redelivered' && r.reason === 'submit-unconfirmed'));
});

test('§1.1: the beat\'s submit-unconfirmed edge closes the carrying wake\'s epochs (since its claim)', async (t) => {
  const calls = [];
  const coordinator = new WorkerWakeWatchdog();
  const bridge = new InboxWakeBridge({
    coordinator, inboxIds: () => ['m1'], facts: () => ({ ptyId: 'pty-a', lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: async () => ({ kind: 'COMMITTED' }), text: () => 'x', setImmediate: (fn) => fn(), now: () => now, confirmsTurnStart: () => true,
    mail: { mode: () => 'inject', closeTurn: () => {}, abortSince: (a, since) => calls.push([a, since]), closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false }
  });
  let now = 1_000;
  coordinator.noteHook('a', 'Stop', undefined, 0, true);
  bridge.requestInboxWake('a', 'delivery', 'event');
  await new Promise((r) => setImmediate(r));
  assert.equal(coordinator.state('a').provisional, true);
  now = 1_000 + SUBMIT_CONFIRM_MS;
  bridge.reconcileAll(['a']);
  assert.deepEqual(calls, [['a', 1_000]]);
});

test('§1.1 / §11.4 last backstop: an epoch open 30 min with no Stop closes as abnormal ONCE, only while the lifecycle is idle (injected clock)', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  const since = w.hive.mail.openEpochs('cl-1')[0].since;
  w.now = since + MAIL_STALE_EPOCH_MS + 60_000;
  w.bridge.reconcileAll(['cl-1']);
  assert.equal(w.entry('cl-1', m.id).state, 'surfaced', 'a long ACTIVE turn is never cut');
  w.fire('cl-1', 'Notification', { message: 'Claude is waiting for your input' });   // idle now (lost Stop)
  w.now = since + MAIL_STALE_EPOCH_MS - 1;
  w.bridge.reconcileAll(['cl-1']);
  assert.equal(w.entry('cl-1', m.id).state, 'surfaced', 'not before 30 minutes');
  w.now = since + MAIL_STALE_EPOCH_MS;
  w.bridge.reconcileAll(['cl-1']);
  const e = w.entry('cl-1', m.id);
  assert.deepEqual({ state: e.state, redelivered: e.redelivered }, { state: 'delivered', redelivered: true });
  assert.equal(w.rows('mail').filter((r) => r.stage === 'redelivered' && r.reason === 'stale-epoch').length, 1);
  assert.equal(w.diags.filter((d) => d.stage === 'mail-epoch-stale').length, 1);
  w.now += MAIL_STALE_EPOCH_MS * 3;
  w.bridge.reconcileAll(['cl-1']);
  assert.equal(w.rows('mail').filter((r) => r.stage === 'redelivered' && r.reason === 'stale-epoch').length, 1, 'fired once');
});

// ————————————————————————————————————————————————— degradation (§11.10)

test('§11.10: 3 COMMITTED wakes with zero hook traffic from the agent: legacy-read, mail-channel-degraded, a UI alert', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  w.send('cl-1', { subject: 'w1' });
  await w.flush();
  assert.equal(w.reqs.length, 1);
  for (let k = 2; k <= MAIL_DEGRADE_AFTER_WAKES; k++) {
    w.send('cl-1', { subject: `w${k}`, body: `b${k}` });
    w.now += Math.max(SUBMIT_CONFIRM_MS, WORKER_WAKE_COOLDOWN_MS) + 1_000;
    w.bridge.reconcileAll(['cl-1']);    // submit-unconfirmed, then a reconcile claim (no hook ever came)
    await w.flush();
    assert.equal(w.reqs.length, k, `wake ${k}`);
  }
  assert.deepEqual(w.hive.mail.channelOverride('cl-1')?.mode, 'legacy-read');
  const row = w.rows('mail-channel-degraded')[0];
  assert.deepEqual({ agentId: row.agentId, reason: row.reason, wakes: row.wakes }, { agentId: 'cl-1', reason: 'zero-hook-traffic', wakes: MAIL_DEGRADE_AFTER_WAKES });
  assert.ok(w.hive.integrityIssues().some((i) => i.error === 'mail-channel-degraded' && i.notice), 'the UI alert');
});

test('§11.10: any hook traffic between the wakes resets the zero-traffic count', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  w.send('cl-1', { subject: 'w1' });
  await w.flush();
  for (let k = 2; k <= MAIL_DEGRADE_AFTER_WAKES + 1; k++) {
    if (k === 3) w.fire('cl-1', 'PreToolUse', { tool_name: 'Bash' });
    w.send('cl-1', { subject: `w${k}`, body: `b${k}` });
    w.now += Math.max(SUBMIT_CONFIRM_MS, WORKER_WAKE_COOLDOWN_MS) + 1_000;
    w.fire('cl-1', 'Notification', { message: 'Claude is waiting for your input' });
    w.bridge.reconcileAll(['cl-1']);
    await w.flush();
  }
  assert.equal(w.hive.mail.channelOverride('cl-1'), null);
  assert.equal(w.rows('mail-channel-degraded').length, 0);
});

test('§11.10: 3 wakes in a row that CONFIRMED a turn start but returned no mail block (their ids still waiting): degraded', async (t) => {
  const w = await world(t, { providers: { 'ag-1': 'antigravity' } });
  w.fire('ag-1', 'Stop', { transport: 'pipe', fully_idle: true });
  for (let k = 1; k <= MAIL_DEGRADE_AFTER_WAKES; k++) {
    w.now += 10_000;
    w.send('ag-1', { subject: `w${k}`, body: `b${k}` });
    await w.flush();
    assert.equal(w.reqs.length, k);
    // AGY's statusline confirms the turn; its PreInvocation (the mail hook) never reaches us.
    w.now += 100;
    w.bridge.onProviderStatus('ag-1', 'running', null, w.now);
    assert.equal(w.coordinator.state('ag-1').provisional, false);
    w.now += 100;
    w.fire('ag-1', 'Stop', { transport: 'pipe', fully_idle: true });
  }
  assert.equal(w.hive.mail.channelOverride('ag-1')?.mode, 'legacy-read');
  assert.equal(w.rows('mail-channel-degraded')[0].reason, 'no-mail-block');
});

test('§11.10: a wake turn that DID get a mail block (even headers only, with its ids still waiting) proves the channel works: no degradation', async (t) => {
  let goal = null;
  const w = await world(t, { providers: { 'cl-1': 'claude' }, goal: () => goal });
  w.fire('cl-1', 'Stop');
  goal = 'G'.repeat(8_300);   // < 1,500 left for mail: headers only, nothing surfaces
  for (let k = 1; k <= MAIL_DEGRADE_AFTER_WAKES + 1; k++) {
    w.now += 10_000;
    w.send('cl-1', { subject: `w${k}`, body: `b${k}` });
    await w.flush();
    w.now += 100;
    const c = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'wake' }));
    assert.ok(c.includes('<hive-mail>') && !c.includes('hive-mail:'), 'headers only');
    w.now += 100;
    w.fire('cl-1', 'Stop');
  }
  assert.ok(w.reqs.length >= MAIL_DEGRADE_AFTER_WAKES);
  assert.equal(w.hive.mail.channelOverride('cl-1'), null);
  assert.equal(w.rows('mail-channel-degraded').length, 0);
});

test('§11.19 #1 (dry runs #3/#4 B5): a wake whose hook RACED its COMMITTED and flushed LATE did get a block: 3 of them never degrade the channel', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  w.fire('cl-1', 'Stop');
  const unsettled = [];
  w.outcome = () => new Promise((res) => unsettled.push(() => res({ kind: 'COMMITTED' })));
  for (let k = 1; k <= MAIL_DEGRADE_AFTER_WAKES + 1; k++) {
    w.now += 10_000;
    w.send('cl-1', { subject: `r${k}`, body: `raced ${k}` });
    await w.flush();
    assert.ok(unsettled.length > 0, `wake ${k} claimed, its submit not settled yet`);
    assert.equal(w.rows('mail-channel-degraded').length, 0, `not degraded after ${k - 1} raced, late wake(s) that each got a block`);
    // The typed wake's UserPromptSubmit arrives BEFORE the owner reports COMMITTED (the watch is
    // not open yet), and its response flushes LATE (the client hung up: mail-hook-late).
    w.now += 50;
    const ctx = w.ctx(w.fire('cl-1', 'UserPromptSubmit', { prompt: 'wake' }));
    assert.ok(ctx.includes('<hive-mail>'), 'a mail block was built');
    w.server.settleMailClaims(w.server.takeMailClaims(), w.now, null);
    w.now += 50;
    while (unsettled.length) unsettled.shift()();
    await w.flush();
    w.now += 100;
    w.fire('cl-1', 'Stop');                                  // the late ids go back to delivered
    await w.flush();
  }
  assert.ok(w.rows('mail-hook-late').length >= MAIL_DEGRADE_AFTER_WAKES, 'every wake\'s hook was late');
  assert.equal(w.rows('mail-channel-degraded').length, 0, 'late is N1\'s business, never the degrade\'s');
  assert.equal(w.hive.mail.channelOverride('cl-1'), null);
});

test('§11.19 #1: a block built AFTER the wake\'s watch ended (its Stop) still resets the no-mail-block streak', async (t) => {
  const w = await world(t, { providers: { 'ag-1': 'antigravity' } });
  w.fire('ag-1', 'Stop', { transport: 'pipe', fully_idle: true });
  const blockless = async (k) => {
    w.now += 10_000;
    w.send('ag-1', { subject: `w${k}`, body: `b${k}` });
    await w.flush();
    w.now += 100;
    w.bridge.onProviderStatus('ag-1', 'running', null, w.now);
    w.now += 100;
    w.fire('ag-1', 'Stop', { transport: 'pipe', fully_idle: true });
  };
  await blockless(1);
  await blockless(2);
  w.bridge.onMailBlock('ag-1');                              // a block reached it after that watch
  await blockless(3);
  assert.equal(w.rows('mail-channel-degraded').length, 0, 'the streak started over: 1 of 3');
  await blockless(4);
  await blockless(5);
  assert.equal(w.rows('mail-channel-degraded')[0]?.reason, 'no-mail-block', '3 blockless wakes in a row still degrade');
});

// ————————————————————————————————————————————————— legacy channels (§2.2, §11.7) and old habits (§7.1)

test('legacy-read (§2.2): the ids the wake named and the mid-turn notice named are acted at the Stop, and archived by the harness', async (t) => {
  const w = await world(t, { providers: { 'ge-1': 'gemini' }, confirms: () => false });
  w.fire('ge-1', 'Stop', { transport: 'pipe' });
  const m1 = w.send('ge-1', { subject: 'wake mail' });
  await w.flush();
  assert.equal(w.reqs.length, 1);
  assert.equal(w.ctx(w.fire('ge-1', 'UserPromptSubmit', { prompt: w.reqs[0].text, transport: 'pipe' })), '', 'no bodies for legacy-read');
  const m2 = w.send('ge-1', { subject: 'mid-turn mail' });
  assert.match(w.ctx(w.fire('ge-1', 'PostToolUse', { transport: 'pipe' })), /^<inbox-update>/);
  const untold = w.send('ge-1', { subject: 'nobody told it' });
  w.fire('ge-1', 'Stop', { transport: 'pipe' });
  assert.equal(w.entry('ge-1', m1.id).state, 'acted');
  assert.equal(w.entry('ge-1', m2.id).state, 'acted');
  assert.equal(w.entry('ge-1', untold.id).state, 'delivered', 'only what the agent was told about');
  assert.ok(w.rows('mail').some((r) => r.stage === 'acted' && r.mode === 'legacy-read'));
  w.hive.mail.flushAll();
  assert.ok(fs.existsSync(path.join(w.hive.root(), 'agents', 'ge-1', 'inbox', '.done', `${m1.id}.json`)));
});

test('§11.7 cursor (no Stop): NO idle-based acted, ever; the agent\'s own move means handled, for that agent only', async (t) => {
  const w = await world(t, { providers: { 'cu-1': 'cursor' } });
  const m = w.send('cu-1');
  w.fire('cu-1', 'Notification', { message: 'waiting for input' });
  w.now += MAIL_STALE_EPOCH_MS * 4;
  w.bridge.reconcileAll(['cu-1']);
  w.hive.mail.reconcileInbox('cu-1', { moveIsHandled: true });
  assert.equal(w.entry('cu-1', m.id).state, 'delivered', 'idle and hours later: still delivered');
  assert.equal(w.rows('mail').filter((r) => r.stage === 'acted').length, 0);
  const inbox = path.join(w.hive.root(), 'agents', 'cu-1', 'inbox');
  // A copy in .done while the file is still in inbox/ is not a move.
  fs.copyFileSync(path.join(inbox, `${m.id}.json`), path.join(inbox, '.done', `${m.id}.json`));
  assert.deepEqual(w.hive.mail.reconcileInbox('cu-1', { moveIsHandled: true }).moved, []);
  assert.equal(w.entry('cu-1', m.id).state, 'delivered');
  fs.rmSync(path.join(inbox, '.done', `${m.id}.json`));
  fs.renameSync(path.join(inbox, `${m.id}.json`), path.join(inbox, '.done', `${m.id}.json`));
  assert.deepEqual(w.hive.mail.reconcileInbox('cu-1', { moveIsHandled: true }).moved, [m.id]);
  assert.equal(w.entry('cu-1', m.id).state, 'acted');
  assert.ok(w.rows('mail').some((r) => r.stage === 'acted' && r.mode === 'legacy-move' && r.reason === 'agent-moved'));
  // An injection agent's move is NEVER "handled" (§7.1 step 4): the same reconcile leaves it delivered.
  const w2 = await world(t, { providers: { 'cl-1': 'claude' } });
  const m2 = w2.send('cl-1');
  const inbox2 = path.join(w2.hive.root(), 'agents', 'cl-1', 'inbox');
  fs.renameSync(path.join(inbox2, `${m2.id}.json`), path.join(inbox2, '.done', `${m2.id}.json`));
  w2.hive.mail.reconcileInbox('cl-1', { moveIsHandled: false });
  assert.equal(w2.entry('cl-1', m2.id).state, 'delivered');
});

test('§7.1 step 4: an old-habit move of an ALREADY-SURFACED id is harmless: acted at its Stop, no error, the file stays in .done', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const m = w.send('cl-1');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.confirm('cl-1');
  const inbox = path.join(w.hive.root(), 'agents', 'cl-1', 'inbox');
  fs.renameSync(path.join(inbox, `${m.id}.json`), path.join(inbox, '.done', `${m.id}.json`));
  w.fire('cl-1', 'Stop');
  w.hive.mail.flushAll();
  assert.equal(w.entry('cl-1', m.id).state, 'acted');
  assert.ok(fs.existsSync(path.join(inbox, '.done', `${m.id}.json`)));
  assert.deepEqual(w.rows('mail-archive-failed'), []);
  assert.deepEqual(w.rows('mail-agent-moved'), [], 'a surfaced id is not re-read');
});

// ————————————————————————————————————————————————— Jim audit #4: disk → ledger on the beat

test('Jim audit #4: an inbox file written outside deliver() reaches the ledger on the next beat (recovered, logged), readdir-cheap', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  const inbox = path.join(w.hive.root(), 'agents', 'cl-1', 'inbox');
  const known = w.send('cl-1');
  fs.writeFileSync(path.join(inbox, 'side-door-1.json'), JSON.stringify({ id: 'side-door-1', from: 'god-1', act: 'request', subject: 'written by hand', body: 'hello' }));
  const reads = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { reads.push(String(p)); return realRead.call(this, p, ...rest); };
  let got;
  try { got = w.hive.mail.reconcileInbox('cl-1'); } finally { fs.readFileSync = realRead; }
  assert.deepEqual(got.recovered, ['side-door-1']);
  assert.ok(!reads.some((p) => p.includes(known.id)), 'a known file is not read');
  const e = w.entry('cl-1', 'side-door-1');
  assert.deepEqual({ state: e.state, subject: e.subject, act: e.act }, { state: 'delivered', subject: 'written by hand', act: 'request' });
  assert.ok(w.rows('mail').some((r) => r.stage === 'delivered' && r.reason === 'recovered' && r.id === 'side-door-1'));
  assert.deepEqual(w.hive.mail.reconcileInbox('cl-1').recovered, [], 'idempotent');
  // The beat runs it for every live agent before the wake reconcile. Work-order agents instead
  // get their leftover files as terminal handoffs (god 1c7544 + Q34).
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /for \(const agentId of live\) \{\s*try \{\s*const mode = hookServer\.mailChannel\(agentId\)\.mode;\s*const noStop = mode === 'legacy-move' \|\| \(mode === 'legacy-read' && hive\.mail\.channelOverride\(agentId\)\?\.reason === 'zero-hook-traffic'\);\s*if \(mode !== 'work-order'\) hive\.mail\.reconcileInbox\(agentId, \{ moveIsHandled: noStop \}\);\s*(\/\/[^\n]*\n\s*)*else hive\.handOffWorkOrderLeftovers\(agentId\);\s*\} catch \{[^}]*\}\s*\}\s*inboxWake\.reconcileAll\(live\);/);
});

// ————————————————————————————————————————————————— pins

test('PIN (§8.1): reannounce is gone: no time-based re-announce, no requeueStale, no REANNOUNCE_AFTER_MS', () => {
  assert.equal(W.REANNOUNCE_AFTER_MS, undefined);
  const ww = codeOnly(readSource('src/main/workerWake.ts'));
  assert.doesNotMatch(ww, /requeueStale|REANNOUNCE_AFTER_MS|announcedAt|kind: 'reannounce'/);
  const bridge = codeOnly(readSource('src/main/inboxWakeBridge.ts'));
  assert.doesNotMatch(bridge, /reannounce/);
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 0, true);
  c.noteDelivery('a', 'm1');
  c.settle(c.claim({ agentId: 'a', ptyId: 'p', lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false }, 'hook', 'event', 10), 'COMMITTED', 10);
  c.noteHook('a', 'Notification', 'Claude is waiting for your input', 20);
  for (const dt of [3 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) assert.equal(c.beat('a', 20 + dt), null, `idle for ${dt} ms: nothing is re-offered by time`);
  assert.deepEqual(c.state('a').pending, []);
});

test('WIRING: main connects the mail epochs and the wake coordinator both ways; respawn and PTY exit end open epochs', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /hookServer\.setMailCoordination\(\{\s*lifecycleActive: \(agentId\) => \{ const s = workerWake\.state\(agentId\); return s\.lifecycle === 'active' && !s\.provisional; \},\s*wakeIds: [^\n]+\n\s*onEpochClosed: \(agentId, outcome, reason, redelivered\) => inboxWake\?\.onMailEpochClosed\(agentId, outcome, reason, redelivered\),\s*onMailBlock: \(agentId\) => inboxWake\?\.onMailBlock\(agentId\)\s*\}\);/);
  assert.match(index, /workerWake\.noteSpawn\(opts\.id, Date\.now\(\), opts\.hive\.id\);\s*try \{ hookServer\.abortMailTurn\(opts\.hive\.id, 'respawn'\); \}/, 'after noteSpawn');
  assert.match(index, /workerWake\.forget\(agentId, id\);[^\n]*\n\s*try \{ forgetWakeRows\(wakeRows, agentId\); \}[^\n]*\n\s*if \(!\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) \{ try \{ hookServer\.abortMailTurn\(agentId, 'pty-exit'\); \}/);
  assert.match(index, /inboxIds: \(agentId\) => mailPendingIds\(agentId\),/);
  // K13: main's pending source IS the tested rule, wired to the HookServer and the ledger.
  assert.match(index, /function mailPendingIds\(agentId: string\): string\[\] \{\s*return coordinatorPendingIds\(agentId, \{\s*mode: \(a\) => hookServer\.mailChannel\(a\)\.mode,\s*pending: \(a\) => hive\.mail\.pending\(a\),\s*skipped: \(a\) => hookServer\.mailSkippedIds\(a\),\s*files: \(a\) => hive\.inbox\(a\)\.map\(\(m\) => m\.id\)\s*\}\);\s*\}/);
});

test('god cce9ab: a mode SWITCH immediately followed by a Stop is closed in the NEW mode: the wake-named mail is acted under legacy-read (the mode is never cached)', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' }, confirms: () => false });
  w.fire('cl-1', 'Stop', { transport: 'pipe' });
  assert.equal(w.server.mailChannel('cl-1').mode, 'inject', 'inject before the switch (and the provider is now cached)');
  const m = w.send('cl-1', { subject: 'named by the wake' });
  await w.flush();
  assert.equal(w.reqs.length, 1, 'one wake');
  // The degradation lands between the wake and the turn: the SAME millisecond, no cache expiry.
  w.hive.mail.degradeChannel('cl-1', 'zero-hook-traffic', {});
  assert.equal(w.server.mailChannel('cl-1').mode, 'legacy-read', 'the very next read sees the switch');
  w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[0].text, transport: 'pipe' });
  w.fire('cl-1', 'Stop', { transport: 'pipe' });
  assert.equal(w.entry('cl-1', m.id).state, 'acted', 'acted at that Stop');
  assert.ok(w.rows('mail').some((r) => r.stage === 'acted' && r.mode === 'legacy-read' && r.ids.includes(m.id)), 'under legacy-read');
  // Source pin: the cache holds the provider only; the mode is computed on every call.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /private readonly providerCache = new Map<string, \{ provider: AgentProvider \| undefined; at: number \}>\(\);/);
  const fn = src.slice(src.indexOf('  mailChannel(agentId: string)'), src.indexOf('\n  }\n', src.indexOf('  mailChannel(agentId: string)')));
  assert.ok(!/return c;/.test(fn), 'no cached mode is returned');
  assert.match(fn, /override = this\.hive\.mail\?\.channelOverride\(agentId\)/);
});

test('Jim LOW residual: a RESPAWN as a different provider invalidates the cached provider: the very next hook reads the new one', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'respawn-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  t.after(() => { try { server.stop(); } catch { /* noop */ } });
  assert.equal(server.mailChannel('sw-1').provider, 'claude', 'cached as claude');
  // The same id is respawned as Codex (the pty:spawn path calls ensureAgent), inside the 5 s window.
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'codex', cwd: home });
  const ch = server.mailChannel('sw-1');
  assert.equal(ch.provider, 'codex', 'the respawn invalidated the cached provider');
  assert.equal(ch.mode, 'inject', 'and the mode follows the new provider (Codex Route A)');
  // The cache itself still works between spawns (one registry read per window).
  let reads = 0;
  const reg = hive.registry.bind(hive);
  hive.registry = () => { reads++; return reg(); };
  server.mailChannel('sw-1'); server.mailChannel('sw-1');
  assert.equal(reads, 0, 'served from the provider cache');
});

test('§11.19 #4 (Q28 cadence pin): an unparseable body is re-tried every 30 s at the hooks; 3 failures spanning >= 60 s close it terminally', async (t) => {
  const w = await world(t, { providers: { 'cl-1': 'claude' } });
  assert.equal(HookServer.MAIL_UNREADABLE_RETRY_MS, 30_000);
  assert.equal(MAIL_UNPARSEABLE_AFTER, 3);
  assert.equal(MAIL_UNPARSEABLE_SPAN_MS, 60_000);
  const m = w.send('cl-1', { subject: 'garbled', body: 'x' });
  fs.writeFileSync(path.join(w.hive.root(), 'agents', 'cl-1', 'inbox', `${m.id}.json`), '{ not json');
  const t0 = Date.now();
  const realNow = Date.now;
  let at = t0;
  Date.now = () => at;
  w.hive.mail.now = () => at;
  const hookAt = (sec) => { at = t0 + sec * 1000; w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' }); w.fire('cl-1', 'Stop'); w.hive.mail.flushAll(); return w.entry('cl-1', m.id); };
  try {
    assert.equal(hookAt(0).parseFails, 1, 'the first failure is counted');
    assert.equal(hookAt(10).parseFails, 1, 'inside 30 s: skipped, not re-counted');
    assert.equal(hookAt(30).parseFails, 2, 'at 30 s: tried again');
    assert.equal(hookAt(59).parseFails, 2, '29 s after the last try: skipped');
    const e = hookAt(60);
    assert.deepEqual([e.state, e.missingReason, e.parseFails], ['acted', 'unparseable', 3], 'the third, 60 s after the first: closed terminally');
  } finally { Date.now = realNow; }
});

test('Jim LOW gap D2: stop() CLEARS the provider cache: nothing cached survives the unsubscribe (the next read goes to the registry)', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'd2-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'claude', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  assert.equal(server.mailChannel('sw-1').provider, 'claude');
  assert.equal(server.providerCache.size, 1, 'cached');
  server.stop();
  assert.equal(server.providerCache.size, 0, 'stop() cleared it');
  // A provider change that no provisioning event announces (the server is unsubscribed now):
  // the very next read must see it, inside the 5 s window.
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); r.agents['sw-1'] = { ...r.agents['sw-1'], provider: 'codex' }; return r; };
  assert.equal(server.mailChannel('sw-1').provider, 'codex', 'read fresh after stop()');
});

test('Jim LOW nit: stop() unsubscribes from onAgentProvisioned: the listener count goes back down and a later provisioning no longer touches that server\'s cache', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'unsub-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'claude', cwd: home });
  const base = hive.provisionedListeners.size;
  const servers = Array.from({ length: 5 }, () => new HookServer(hive, () => null, () => ({ notifications: false })));
  t.after(() => { for (const s of servers) { try { s.stop(); } catch { /* noop */ } } });
  assert.equal(hive.provisionedListeners.size, base + 5, 'one listener per server');
  const [a, b] = servers;
  assert.equal(a.mailChannel('sw-1').provider, 'claude');
  assert.equal(b.mailChannel('sw-1').provider, 'claude');
  for (const s of servers) s.stop();
  assert.equal(hive.provisionedListeners.size, base, 'every stop() removed its listener: nothing piles up');
  a.stop();
  assert.equal(hive.provisionedListeners.size, base, 'a second stop() is harmless');
  // After stop(), a provisioning event reaches no stopped server: its cache is not touched.
  const seen = [];
  const del = b.providerCache.delete.bind(b.providerCache);
  b.providerCache.delete = (k) => { seen.push(k); return del(k); };
  b.providerCache.set('sw-1', { provider: 'claude', at: Date.now() });
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'codex', cwd: home });
  assert.deepEqual(seen, [], 'the stopped server\'s listener is gone');
  // A restarted server subscribes again, once, and sees the next respawn.
  b.start();
  t.after(() => { try { b.stop(); } catch { /* noop */ } });
  b.start();
  assert.equal(hive.provisionedListeners.size, base + 1, 'start() re-subscribes exactly once');
  await hive.ensureAgent({ id: 'sw-1', name: 'sw', provider: 'claude', cwd: home });
  assert.deepEqual(seen, ['sw-1'], 'the restarted server drops the respawned agent\'s cached provider');
  b.stop();
  assert.equal(hive.provisionedListeners.size, base);
});
