'use strict';

/**
 * GTC M3 (1.1.97): the Human's message box (src/main/messageBox.ts) and its wiring.
 * Design: agents/andy-mtuk4y4x/GOD-TERMINAL-CONTROL-DESIGN.md section 14; Jim 6b9a89 OK WITH
 * CHANGES (MUST 1 re-check + owner lock-out, MUST 2 composer check before the Enter, MUST 3 HUMAN
 * provenance; SHOULD 1-3; rulings a-d).
 *
 * The rig: ONE virtual clock and ONE fake terminal shared by the REAL AutomaticSubmitOwner (its
 * chain is the exclusion), the REAL TermControl slot and the message box. The box writes as the
 * Human does (the generation advances, lastHumanInputAt moves); the owner writes PROGRAMMATIC.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const MB = loadTs('src/main/messageBox.ts');
const { MessageBox, hookIdle, messageBoxPathOf, fingerprintOf, MESSAGE_BOX_CONFIRM_MS, MESSAGE_BOX_BUSY_CONFIRM_MS, MESSAGE_BOX_STALE_MS, MESSAGE_BOX_REPLAY_MAX } = MB;
const { AutomaticSubmitOwner, payloadFor } = loadTs('src/main/automaticSubmit.ts');
const { TermControl } = loadTs('src/main/termControl.ts');

const IDLE = { lifecycle: 'idle', activeSince: 0, turnStartAt: 10, lastTurnEndAt: 20 };
const BUSY = { lifecycle: 'active', activeSince: 30, turnStartAt: 30, lastTurnEndAt: 20 };

function world(over = {}) {
  const w = {
    vt: 1_000_000, timers: [], seq: 0,
    /** Every write on the terminal, in order, with who wrote it. */
    log: [], rows: [],
    gen: 0, lastHumanAt: undefined, prompt: '', showsText: true, mirror: 'on',
    promptBlock: null, facts: { alice: { ...IDLE } }, provider: 'claude', path: 'term',
    ownerCalls: [], onBoxSettle: null, onProbe: null,
    ...over
  };
  const timer = (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; };
  const sleep = (ms) => new Promise((r) => timer(r, ms));
  w.human = (text) => { w.gen += 1; w.prompt += text; w.lastHumanAt = w.vt; w.log.push(['keys', text]); };
  w.ownerDeps = {
    resolvePty: (agentId) => `pty-${agentId}`,
    incarnation: () => 1,
    humanGeneration: () => w.gen,
    write: (_p, data) => {
      w.log.push(['owner', data]);
      if (data === '\r') { w.prompt = ''; if (w.onOwnerEnter) w.onOwnerEnter(); } else w.prompt += data;
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => w.promptBlock,
    lastHumanInputAt: () => w.lastHumanAt,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 }),
    readScreen: (_p, needle) => Promise.resolve({ onPromptRow: w.prompt.includes(needle), screenCount: w.prompt.includes(needle) ? 1 : 0 }),
    capacity: {
      admit: (agentId, workClass) => ({ verdict: 'ALLOW', reason: 'FRESH_HEALTHY', poolKey: 'pool', state: null, workClass, limitEpochAt: null, grantId: null }),
      revalidate: () => ({ verdict: 'ALLOW', reason: 'FRESH_HEALTHY' }),
      confirmLaunch: () => {}, cancelGrant: () => {}, holdGrant: () => {}
    },
    now: () => w.vt,
    setTimer: timer,
    onOutcome: () => {}
  };
  w.owner = new AutomaticSubmitOwner(w.ownerDeps);
  w.term = new TermControl({ godId: () => 'god', ptyOf: () => 'pty-alice', providerOf: () => w.provider, readScreen: async () => null, mirrorOff: () => null,
    write: () => ({ ok: true }), outputGeneration: () => 0, log: () => {}, now: () => w.vt, sleep });
  w.deps = {
    ptyOf: (agentId) => (agentId === 'nobody' ? undefined : `pty-${agentId}`),
    providerOf: () => w.provider,
    idleFacts: (agentId) => w.facts[agentId] ?? { lifecycle: 'unknown', activeSince: 0, turnStartAt: 0, lastTurnEndAt: 0 },
    promptBlock: () => w.promptBlock,
    lastHumanInputAt: () => w.lastHumanAt,
    humanGeneration: () => w.gen,
    mirrorNeedle: async (_p, needle) => {
      if (w.onProbe) { const f = w.onProbe; w.onProbe = null; f(); }
      if (w.mirror !== 'on') return { reading: null, reason: w.mirror };
      return { reading: { onPromptRow: w.prompt.includes(needle) } };
    },
    exclusive: (ptyId, fn, ms) => w.owner.exclusive(ptyId, fn, ms),
    slot: (agentId, fn) => w.term.slot(agentId, fn),
    settle: async () => { if (w.onBoxSettle) { const f = w.onBoxSettle; w.onBoxSettle = null; await f(); } await sleep(150); },
    write: (_p, data) => {
      // The box writes as the Human: pty.ts advances the generation for origin HUMAN.
      w.gen += 1; w.lastHumanAt = w.vt;
      w.log.push(['box', data]);
      if (data === '\r') w.prompt = ''; else if (w.showsText) w.prompt += data;
      return { ok: true };
    },
    ownerSubmit: async (r) => { w.ownerCalls.push(r); return { kind: 'COMMITTED' }; },
    outputQuietMs: () => w.quietMs,
    log: (row) => w.rows.push(row),
    now: () => w.vt,
    sleep,
    setTimer: timer
  };
  w.box = new MessageBox(w.deps, () => w.path);
  w.sleep = sleep;
  return w;
}

const immediate = () => new Promise((r) => setImmediate(r));
async function drive(w, promise) {
  let done = false; let value; let err = null;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; err = e; });
  for (let i = 0; i < 5000; i += 1) {
    await immediate();
    if (done) { if (err) throw err; return value; }
    if (!w.timers.length) throw new Error('stuck: unsettled and no timer pending');
    w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = w.timers.shift();
    w.vt = Math.max(w.vt, next.at);
    next.fn();
  }
  throw new Error('did not settle');
}
const send = (w, over = {}) => drive(w, w.box.deliver({ requestId: 'queue:alice:m1', agentId: 'alice', text: 'please review the diff', now: false, ...over }));
const boxWrites = (w) => w.log.filter(([who]) => who === 'box').map(([, d]) => d);
const later = (w, ms) => drive(w, w.sleep(ms));

// ─── hookIdle: main's hook state is the only verdict (section 14.3) ─────────────────────────

test('hookIdle: a turn end is idle, an open turn is busy, unknown is busy', () => {
  assert.deepEqual(hookIdle(IDLE, 'claude', undefined), { idle: true, by: 'turn-ended', at: 20 });
  assert.equal(hookIdle(BUSY, 'claude', undefined).idle, false);
  assert.equal(hookIdle({ lifecycle: 'unknown', activeSince: 0, turnStartAt: 0, lastTurnEndAt: 0 }, 'claude', undefined).idle, false, 'unknown with no SessionStart is NOT idle');
});

test('hookIdle: READY = a fresh non-compact SessionStart (Claude, Codex); compact, stale or AGY is not', () => {
  const unk = { lifecycle: 'unknown', activeSince: 0, turnStartAt: 10, lastTurnEndAt: 20 };
  assert.deepEqual(hookIdle(unk, 'claude', { at: 50, compact: false }), { idle: true, by: 'session-start', at: 50 });
  assert.equal(hookIdle(unk, 'codex', { at: 50, compact: false }).idle, true);
  assert.equal(hookIdle(unk, 'claude', { at: 50, compact: true }).by, 'compact-start');
  assert.equal(hookIdle(unk, 'claude', { at: 15, compact: false }).idle, false, 'a SessionStart older than the last turn proves nothing now');
  assert.deepEqual(hookIdle(unk, 'antigravity', { at: 50, compact: false }), { idle: false, by: 'agy-start-unproven', at: 50 }, 'Jim SHOULD 3: AGY READY is not proven');
});

test('hookIdle over the REAL watchdog: an AGY fully_idle:false Stop stays busy; a Claude UPS..Stop waits, then lands once', async () => {
  const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
  const wake = new WorkerWakeWatchdog();
  let t = 1_000;
  wake.noteHook('agy1', 'PreInvocation', undefined, (t += 10));
  wake.noteHook('agy1', 'Stop', undefined, (t += 10), false);
  assert.equal(hookIdle(wake.livenessFacts('agy1'), 'antigravity', undefined).idle, false, 'mid-chain: the turn goes on');
  wake.noteHook('agy1', 'Stop', undefined, (t += 10), true);
  assert.equal(hookIdle(wake.livenessFacts('agy1'), 'antigravity', undefined).idle, true);

  const w = world();
  w.deps.idleFacts = (agentId) => wake.livenessFacts(agentId);
  wake.noteHook('alice', 'UserPromptSubmit', undefined, w.vt);
  assert.equal((await send(w)).reason, 'NOT_IDLE');
  wake.noteHook('alice', 'Stop', undefined, w.vt);
  assert.equal((await send(w)).kind, 'COMMITTED');
  assert.equal((await send(w)).kind, 'COMMITTED', 'replayed');
  assert.deepEqual(boxWrites(w), [payloadFor('please review the diff'), '\r'], 'landed once, after the Stop');
});

test('messageBoxPathOf: only "owner" is the old path', () => {
  assert.equal(messageBoxPathOf('owner'), 'owner');
  for (const v of [undefined, null, 'term', 'OWNER', 1]) assert.equal(messageBoxPathOf(v), 'term');
});

// ─── deliver: the order of section 14.4 ─────────────────────────────────────────────────────

test('idle: the text is typed as today\'s bytes, then ONE Enter, as the Human; COMMITTED', async () => {
  const w = world();
  const multi = 'line one of it\nline two of it';
  const o = await send(w, { text: multi });
  assert.deepEqual(o, { kind: 'COMMITTED', via: 'term', command: false });
  assert.deepEqual(boxWrites(w), [payloadFor(multi), '\r']);
  assert.equal(w.ownerCalls.length, 0, "'term' never calls the owner for a deliverable item");
  const row = w.rows.find((r) => r.kind === 'message-box' && r.outcome === 'COMMITTED');
  assert.ok(row && row.len === multi.length && !JSON.stringify(w.rows).includes('line one'), 'logged by length, never the text');
});

test('busy: NOT_IDLE, nothing typed; Send-now skips ONLY the idle check', async () => {
  const w = world({ facts: { alice: { ...BUSY } } });
  const o = await send(w);
  assert.equal(o.kind, 'REFUSED'); assert.equal(o.reason, 'NOT_IDLE'); assert.equal(o.detail, 'turn-open');
  assert.deepEqual(boxWrites(w), []);
  const n = await send(w, { requestId: 'queue:alice:m2', now: true });
  assert.equal(n.kind, 'COMMITTED');
  w.promptBlock = 'draft';
  const d = await send(w, { requestId: 'queue:alice:m3', now: true });
  assert.equal(d.reason, 'DRAFT_IN_TERMINAL', 'Send-now still never types over a draft');
});

test('prompt and quiet vetoes: draft, picker, settling, exited, a recent key; and a Claude mode key', async () => {
  for (const [block, reason] of [['draft', 'DRAFT_IN_TERMINAL'], ['picker', 'PICKER_OPEN'], ['settling', 'PROMPT_SETTLING'], ['exited', 'TERMINAL_EXITED']]) {
    const w = world({ promptBlock: block });
    assert.equal((await send(w)).reason, reason);
    assert.deepEqual(boxWrites(w), []);
  }
  const w = world();
  w.human('x');
  assert.equal((await send(w)).reason, 'HUMAN_TYPING');
  const c = world();
  assert.equal((await send(c, { text: '!rm -rf' })).reason, 'TEXT_ENTERS_MODE');
  assert.equal((await send(world(), { agentId: 'nobody' })).reason, 'NO_PTY');
});

test('replay: an answered request id gets its answer again and types nothing more', async () => {
  const w = world();
  const a = await send(w);
  const b = await send(w);
  assert.deepEqual(b, a);
  assert.deepEqual(boxWrites(w), [payloadFor('please review the diff'), '\r'], 'typed once');
});

test('Jim SHOULD 2: the replay map is bounded (LRU), the oldest forgotten first', async () => {
  const w = world();
  for (let i = 0; i <= MESSAGE_BOX_REPLAY_MAX; i += 1) {
    w.box['answered'].set(`r${i}`, { outcome: { kind: 'COMMITTED' }, at: w.vt });
  }
  await send(w, { requestId: 'fresh' });
  assert.ok(w.box['answered'].size <= MESSAGE_BOX_REPLAY_MAX);
  assert.equal(w.box['answered'].has('r0'), false);
});

// ─── Jim MUST 1: re-check in the slot; the owner locked out until the Enter ────────────────

test('MUST 1: a hook BUSY between the first check and the write gives NOT_IDLE, nothing typed', async () => {
  const w = world();
  w.onProbe = () => { w.facts.alice = { ...BUSY }; };
  const o = await send(w);
  assert.equal(o.reason, 'NOT_IDLE');
  assert.deepEqual(boxWrites(w), []);
});

test('MUST 1: an owner run in flight finishes first; the box re-checks after it and types nothing into the new turn', async () => {
  const w = world();
  // The owner's Enter starts a turn (the hook UPS).
  w.onOwnerEnter = () => { w.facts.alice = { ...BUSY }; };
  const ownerRun = w.owner.submit({ requestId: 'wake-1', agentId: 'alice', admissionClass: 'CAPACITY_GATED', text: 'read your inbox now' });
  const boxRun = w.box.deliver({ requestId: 'queue:alice:m1', agentId: 'alice', text: 'please review the diff', now: false });
  const [own, box] = await drive(w, Promise.all([ownerRun, boxRun]));
  assert.equal(own.kind, 'COMMITTED');
  assert.ok(box.reason === 'NOT_IDLE' || box.reason === 'OWNER_BUSY', `refused, got ${JSON.stringify(box)}`);
  assert.deepEqual(boxWrites(w), [], 'never typed into the owner\'s staged text or its new turn');
});

test('MUST 1: an owner STAGE arriving during the box\'s settle waits behind it, then is refused HUMAN_INPUT_RECENT', async () => {
  const w = world();
  let ownerRun = null;
  w.onBoxSettle = async () => { ownerRun = w.owner.submit({ requestId: 'wake-2', agentId: 'alice', admissionClass: 'CAPACITY_GATED', text: 'read your inbox now' }); };
  const box = await send(w);
  assert.equal(box.kind, 'COMMITTED');
  const own = await drive(w, ownerRun);
  assert.equal(own.kind, 'REFUSED'); assert.equal(own.reason, 'HUMAN_INPUT_RECENT');
  const owners = w.log.filter(([who]) => who === 'owner');
  assert.deepEqual(owners, [], 'the owner wrote nothing between our text and our Enter');
});

test('MUST 1: an owner that holds the chain past 5 s gives OWNER_BUSY, and the box never types later', async () => {
  const w = world();
  let release;
  const hold = w.owner.exclusive('pty-alice', () => new Promise((r) => { release = r; }), 1000);
  const o = await send(w);
  assert.equal(o.reason, 'OWNER_BUSY');
  release(); await drive(w, hold); await later(w, 2000);
  assert.deepEqual(boxWrites(w), []);
});

test('god\'s term and the box share one slot per agent: the box waits for god\'s action', async () => {
  const w = world();
  let release;
  const godAction = w.term.slot('alice', () => new Promise((r) => { release = r; }));
  const box = w.box.deliver({ requestId: 'queue:alice:m1', agentId: 'alice', text: 'please review the diff', now: false });
  await later(w, 3000);
  assert.deepEqual(boxWrites(w), [], 'nothing typed while god\'s action holds the slot');
  release();
  await drive(w, godAction);
  assert.equal((await drive(w, box)).kind, 'COMMITTED');
});

// ─── Jim MUST 2: the composer before the Enter ──────────────────────────────────────────────

test('MUST 2: text that never reaches the composer (a dialog ate it): no Enter, TYPED_NOT_SENT, a note and a digest item', async () => {
  const w = world({ showsText: false });
  const o = await send(w);
  assert.deepEqual(o, { kind: 'TYPED_NOT_SENT', reason: 'NOT_IN_COMPOSER' });
  assert.deepEqual(boxWrites(w), [payloadFor('please review the diff')], 'no Enter');
  assert.match(w.box.view('alice').note, /typed but not sent/);
  assert.deepEqual(w.box.attentionItems().map((a) => a.why), ['NOT_IN_COMPOSER']);
  assert.deepEqual(await send(w), o, 'answered: never typed again');
});

test('Jim SHOULD 2 (9e6216): a paste token proves only MULTI-line text; a one-line text beside a stale token is NOT_IN_COMPOSER', async () => {
  for (const token of ['[Pasted text #1 +3 lines]', '[Pasted Content 812 chars]']) {
    const one = world({ showsText: false, prompt: token });
    assert.deepEqual(await send(one), { kind: 'TYPED_NOT_SENT', reason: 'NOT_IN_COMPOSER' }, token);
    assert.ok(!boxWrites(one).includes('\r'), `${token}: no Enter`);
    // The control: the same screen does prove a multi-line text (the provider folds it to the token).
    const multi = world({ showsText: false, prompt: token });
    assert.deepEqual(await send(multi, { text: 'please review\nthe diff' }), { kind: 'COMMITTED', via: 'term', command: false }, token);
  }
});

test('MUST 2: someone types during the gap: no Enter (it would submit the mixed text)', async () => {
  const w = world();
  w.onBoxSettle = async () => { w.human('zz'); };
  const o = await send(w);
  assert.deepEqual(o, { kind: 'TYPED_NOT_SENT', reason: 'HUMAN_TYPED' });
  assert.ok(!boxWrites(w).includes('\r'));
});

test('MUST 2: with the mirror off, seeded or unreadable the item goes to the owner (USER_RELEASED for Send-now)', async () => {
  for (const m of ['no-mirror', 'seeded', 'unreadable']) {
    const w = world({ mirror: m });
    await send(w);
    await send(w, { requestId: 'queue:alice:m9', now: true });
    assert.deepEqual(w.ownerCalls.map((c) => c.admissionClass), ['CAPACITY_GATED', 'USER_RELEASED'], m);
    assert.deepEqual(boxWrites(w), []);
  }
  const s = world();
  await send(s, { text: 'ok' });
  assert.equal(s.ownerCalls.length, 1, 'text too short for a needle: the owner path');
  // The owner's answers are the owner's to replay: an INTERFERED it later resolves as
  // HUMAN_HANDLED must reach the renderer, so the box keeps none of them.
  const h = world({ mirror: 'no-mirror' });
  const answers = [{ kind: 'INTERFERED', reason: 'X' }, { kind: 'HUMAN_HANDLED' }];
  h.deps.ownerSubmit = async (r) => { h.ownerCalls.push(r); return answers.shift(); };
  assert.equal((await send(h)).kind, 'INTERFERED');
  assert.equal((await send(h)).kind, 'HUMAN_HANDLED');
});

test("ruling (a): config 'owner' sends every Human item through the owner, exactly today's request", async () => {
  const w = world({ path: 'owner' });
  await send(w);
  assert.deepEqual(w.ownerCalls, [{ requestId: 'queue:alice:m1', agentId: 'alice', admissionClass: 'CAPACITY_GATED', text: 'please review the diff' }]);
  assert.deepEqual(boxWrites(w), []);
});

// ─── confirm: never a retry ─────────────────────────────────────────────────────────────────

test('confirm: the UPS carrying our text = DELIVERED; another UPS does not confirm; silence = UNKNOWN after 10 s', async () => {
  const w = world();
  await send(w);
  w.box.noteHook('alice', 'UserPromptSubmit', { prompt: 'something the Human typed in the terminal' });
  w.box.noteHook('alice', 'UserPromptSubmit', { prompt: 'please review\nthe  diff' });
  assert.equal(w.rows.filter((r) => r.kind === 'message-box-confirm').map((r) => r.confirm).join(), 'DELIVERED');
  const u = world();
  await send(u);
  u.box.noteHook('alice', 'UserPromptSubmit', { prompt: 'a different prompt' });
  await later(u, MESSAGE_BOX_CONFIRM_MS + 1);
  assert.deepEqual(u.rows.filter((r) => r.kind === 'message-box-confirm').map((r) => r.confirm), ['UNKNOWN']);
  assert.match(u.box.view('alice').note, /not confirmed/);
  assert.deepEqual(u.box.attentionItems().map((a) => a.why), ['UNKNOWN']);
  assert.deepEqual(await send(u), { kind: 'COMMITTED', via: 'term', command: false }, 'asked again, it is answered, not re-typed');
  assert.deepEqual(boxWrites(u), [payloadFor('please review the diff'), '\r'], 'UNKNOWN never retries');
  assert.equal(fingerprintOf('  a\n b  '), 'a b');
});

test('Jim SHOULD 1 (9e6216): a second send while the first waits for its UPS settles the first as SUPERSEDED, with a row', async () => {
  const w = world();
  await send(w);
  w.lastHumanAt = undefined;   // past the quiet window
  assert.equal((await send(w, { requestId: 'queue:alice:m2', text: 'and then run the tests' })).kind, 'COMMITTED');
  w.box.noteHook('alice', 'UserPromptSubmit', { prompt: 'and then run the tests' });
  await later(w, MESSAGE_BOX_CONFIRM_MS + 1);
  assert.deepEqual(w.rows.filter((r) => r.kind === 'message-box-confirm').map((r) => `${r.requestId}=${r.confirm}`),
    ['queue:alice:m1=SUPERSEDED', 'queue:alice:m2=DELIVERED'], 'each item gets exactly one confirm row; the first never vanishes');
  assert.deepEqual(w.box.attentionItems(), [], 'a superseded item is no alarm');
});

test('confirm: AGY PreInvocation = DELIVERED-CORRELATED; a slash command = COMMAND, no alarm (SHOULD 1)', async () => {
  const a = world({ provider: 'antigravity' });
  await send(a);
  a.box.noteHook('alice', 'PreInvocation', {});
  assert.deepEqual(a.rows.filter((r) => r.kind === 'message-box-confirm').map((r) => r.confirm), ['DELIVERED-CORRELATED']);
  const c = world();
  assert.deepEqual(await send(c, { text: '/compact' }), { kind: 'COMMITTED', via: 'term', command: true });
  await later(c, MESSAGE_BOX_CONFIRM_MS + 1);
  assert.equal(c.box.view('alice').note, null);
  assert.deepEqual(c.box.attentionItems(), []);
});

test('SHOULD 1: a Send-now into a busy turn waits 120 s and says UNCONFIRMED_BUSY gently, no digest item', async () => {
  const w = world({ facts: { alice: { ...BUSY } } });
  await send(w, { now: true });
  await later(w, MESSAGE_BOX_CONFIRM_MS + 1);
  assert.equal(w.rows.filter((r) => r.kind === 'message-box-confirm').length, 0, 'not judged at 10 s');
  await later(w, MESSAGE_BOX_BUSY_CONFIRM_MS);
  assert.deepEqual(w.rows.filter((r) => r.kind === 'message-box-confirm').map((r) => r.confirm), ['UNCONFIRMED_BUSY']);
  assert.match(w.box.view('alice').note, /busy turn/);
  assert.deepEqual(w.box.attentionItems(), []);
});

test('SessionStart through noteHook makes a fresh session READY; a compact one does not', async () => {
  const w = world({ facts: { alice: { lifecycle: 'unknown', activeSince: 0, turnStartAt: 0, lastTurnEndAt: 0 } } });
  assert.equal((await send(w, { requestId: 'a' })).reason, 'NOT_IDLE');
  w.box.noteHook('alice', 'SessionStart', { source: 'compact' });
  assert.equal((await send(w, { requestId: 'b' })).reason, 'NOT_IDLE');
  w.box.noteHook('alice', 'SessionStart', { source: 'startup' });
  assert.equal((await send(w, { requestId: 'c' })).kind, 'COMMITTED');
});

test('14.6: a NOT_IDLE wait over 5 min with the terminal quiet is stale: once in the log and digest, Send-now offered', async () => {
  const w = world({ facts: { alice: { ...BUSY } }, quietMs: MESSAGE_BOX_STALE_MS + 1 });
  for (let t = 0; t <= MESSAGE_BOX_STALE_MS + 6000; t += 3000) { await send(w); await later(w, 3000); }
  assert.equal(w.rows.filter((r) => r.kind === 'term-disagree').length, 1);
  assert.equal(w.box.view('alice').stale, true);
  assert.deepEqual(w.box.attentionItems().map((a) => a.why), ['STALE_WAIT']);
  assert.ok(w.rows.filter((r) => r.kind === 'message-box' && r.reason === 'NOT_IDLE').length <= 6, 'rate-limited to one a minute');
  await later(w, 20_000);
  assert.equal(w.box.view('alice').stale, false, 'a wait nobody asks about is over');
});

// ─── Jim MUST 3 and the wiring ──────────────────────────────────────────────────────────────

test('MUST 3: messageBox:deliver answers only the app window, and its writer is bound to origin HUMAN', () => {
  const idx = codeOnly(readSource('src/main/index.ts'));
  const at = idx.indexOf("ipcMain.handle('messageBox:deliver'");
  assert.ok(at > 0);
  const body = idx.slice(at, idx.indexOf('});', at));
  const check = body.indexOf('if (!ledgerUiSender(evt)) return');
  assert.ok(check > 0 && check < body.indexOf('messageBox.deliver('), 'the sender check comes first');
  assert.match(idx, /write: \(ptyId, data\) => ptyManager\.write\(ptyId, data, 'HUMAN'\)/);
  assert.match(idx, /function ledgerUiSender\(evt: Electron\.IpcMainInvokeEvent\): boolean \{\s*return !!BrowserWindow\.fromWebContents\(evt\.sender\) && evt\.senderFrame === evt\.sender\.mainFrame;/);
});

test('MUST 3: human: true is set by MessageQueueComposer alone (a hive-sourced enqueue can never act as the Human)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = codeOnly(readSource(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')));
        const n = (src.match(/\bhuman:\s*true\b/g) || []).length;
        if (n) hits.push([path.relative(root, p).replace(/\\/g, '/'), n]);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, [['renderer/src/components/MessageQueueComposer.tsx', 1], ['renderer/src/store/store.ts', 1]]);
  assert.match(codeOnly(readSource('src/renderer/src/components/MessageQueueComposer.tsx')), /enqueueMessage\(agent\.id, body, \{ human: true \}\);/, 'the composer\'s own send');
  assert.match(codeOnly(readSource('src/renderer/src/store/store.ts')), /\.\.\.\(meta\?\.human \? \{ human: true as const \} : \{\}\)/, 'the store only passes the flag on');
  // No other enqueue passes a `human` key at all (shorthand or computed).
  const hive = codeOnly(readSource('src/renderer/src/hooks/useHive.ts'));
  assert.ok(!/enqueueMessage\([^;]*\bhuman\b/.test(hive), 'useHive never marks an enqueue human (its texts come from hive events)');
});

test('renderer: only a human item on the term path skips canDeliverToAgent and isTerminalAutomationSafe; pause and capacity stay', () => {
  const src = codeOnly(readSource('src/renderer/src/hooks/useHive.ts'));
  const d = src.slice(src.indexOf('const dispatch = async ('), src.indexOf('const ensureSlackCard'));
  assert.match(d, /const viaBox = next\.human === true && control\?\.messageBox\?\.path === 'term';/);
  assert.match(d, /if \(!idleHere && next\.human !== true\) return \{ sent: false \};/);
  assert.match(d, /if \(!idleHere && !viaBox\) return \{ sent: false \};/);
  assert.match(d, /if \(!viaBox && !isTerminalAutomationSafe\(target\.ptyId, now\)\) return \{ sent: false \};/);
  assert.match(d, /if \(control\?\.autoDeliveryPaused && !next\.manual\) return \{ sent: false \};/);
  assert.match(d, /if \(control\?\.capacityHold && !next\.manual\) return \{ sent: false \};/);
  assert.match(d, /admissionClass: next\.manual \? 'USER_RELEASED' : 'CAPACITY_GATED',/, "the 'owner' request is today's");
  assert.match(d, /outcome = viaBox \? await window\.cth\.messageBoxDeliver\(\{/);
  const typed = d.slice(d.indexOf("if (outcome.kind === 'TYPED_NOT_SENT')"));
  assert.match(typed.slice(0, 400), /removeQueuedMessage\(srcId, next\.id\);[\s\S]*return \{ sent: false \};/, 'TYPED_NOT_SENT drops the item, never retried');
  const flush = src.slice(src.indexOf('const flush = () => {'), src.indexOf('const schedule = () =>'));
  assert.match(flush, /pickQueuedForDelivery\(messageQueues\[a\.id\], refusedAutomatic\)\?\.human !== true\) continue;/);
});

test('hooks: the turn observer gets every main-session hook\'s prompt and source, after onEvent', () => {
  const src = codeOnly(readSource('src/main/hooks.ts'));
  const on = src.indexOf('this.onEvent?.(agentId, event, p.message');
  const obs = src.indexOf('this.turnObserver?.(agentId, event, {');
  assert.ok(on > 0 && obs > on && obs - on < 600);
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /hookServer\.setTurnObserver\(\(agentId, event, f\) => messageBox\?\.noteHook\(agentId, event, f\)\);/);
});
