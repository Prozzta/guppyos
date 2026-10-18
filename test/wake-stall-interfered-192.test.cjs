'use strict';
/**
 * WAKE-STALL-INTERFERED-192: Jim and Andy held INTERFERED on their OWN wake text (1.1.90,
 * 2026-10-17). Jim's log, read-only:
 *   22:22:52.148 Stop; 22:22:52.321 attempt 0 COMMITTED (text 33 ms and Enter 173 ms after the
 *   Stop, while Claude still drew the end of a 7505-message turn). No turn: the Enter became a
 *   newline, our text on the row above an empty cursor row.
 *   22:23:59.828 submit-unconfirmed; 22:23:59.885 attempt 1 re-Entered our draft and settled
 *   COMMITTED 57 ms later with no turn, and the owner forgot the draft (ownDrafts.delete).
 *   22:30:15.013 attempt 2 (the 300 s retry): our exact text was the composer's tail, but with the
 *   draft forgotten it was held INTERFERED PRIOR_TEXT_ON_PROMPT, for a person, for good.
 * The fixes, pinned here through the real owner, the real wiring and a REAL Claude idle screen:
 *   A  nothing is typed into a Claude that is still drawing after its Stop (quiet output first);
 *   B  the draft is ours until a UserPromptSubmit is reported after its Enter; a re-Enter is
 *      COMMITTED only on that report, otherwise SUBMIT_UNCONFIRMED (the coordinator backs off);
 *   C  a hold on our own proven draft is recovered by the app (an Enter, judged on the report).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SHARED = loadTs('src/shared/codexScreen.ts');
const PA = loadTs('src/shared/providerAutomation.ts');
const OWN = loadTs('src/main/automaticSubmit.ts');
const { buildOwnerDeps } = loadTs('src/main/automaticSubmitWiring.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { WorkerWakeWatchdog, WAKE_RETRY_BASE_MS } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');

const FX = path.join(__dirname, 'fixtures', 'tui-composer-allowlist');
const IDLE = JSON.parse(fs.readFileSync(path.join(FX, 'claude-idle-120x40.json'), 'utf8'));
const RULE = /^─{20,}$/;
const TEXT = 'You have new hive mail (delivered in context below): 2026-10-17T22-21-02-600Z-4aea08.';
const T0 = 1_792_275_772_148;   // Jim's Stop, 2026-10-17T22:22:52.148Z
const COMMITTED = { kind: 'COMMITTED' };

/** The idle screen with the composer box holding `prompt` (rows split at its newlines). */
function view(prompt) {
  if (!prompt) return IDLE;
  const rules = [];
  IDLE.lines.forEach((l, i) => { if (RULE.test(l)) rules.push(i); });
  const [top, bottom] = rules.slice(-2);
  const rows = prompt.split('\n').map((row, i) => (i === 0 ? `❯ ${row}` : `  ${row}`));
  return { ...IDLE, lines: [...IDLE.lines.slice(0, top + 1), ...rows, ...IDLE.lines.slice(bottom)], cursorRow: top + rows.length };
}

/**
 * A Claude TUI, as far as the owner can touch it. Input written while it is still drawing the end
 * of a turn (`busyUntil`) waits in its input buffer and is read as ONE chunk: an Enter inside a
 * chunk with text is a newline (the paste rule; GOD-STARTUP-WAITS-ENTER G1 saw the same at boot).
 * A lone Enter submits a non-empty composer (a turn, and a UserPromptSubmit report) unless
 * `enterWorks` is false, when it too is a newline. Every redraw is output.
 */
function rig(over = {}) {
  const r = {
    now: T0, mono: 0, seq: 0, timers: [], writes: [], writeAt: [], prompt: '', turns: [], ups: [],
    out: 1, busyUntil: 0, buffer: '', enterWorks: true, gen: 0, interfered: [], codexReads: 0, ...over
  };
  const setTimer = (fn, ms) => { const t = { at: r.now + ms, seq: (r.seq += 1), fn }; r.timers.push(t); return { id: t.seq, unref() { return this; } }; };
  r.at = (t, fn) => { r.timers.push({ at: t, seq: (r.seq += 1), fn }); };
  r.enter = () => {
    r.out += 1;
    if (r.prompt.trim() === '') return;
    if (!r.enterWorks) { r.prompt += '\n'; return; }
    r.turns.push(r.prompt.trim());
    r.prompt = '';
    r.ups.push(r.now);
  };
  r.process = (chunk) => {
    if (chunk === '\r') { r.enter(); return; }
    r.out += 1;
    r.prompt += chunk.replace(/\r/g, '\n');
  };
  /** The end-of-turn redraw: a frame every 40 ms until `until`, then the buffered input. */
  r.drawUntil = (until) => {
    r.busyUntil = until;
    for (let t = r.now + 40; t < until; t += 40) r.at(t, () => { r.out += 1; });
    r.at(until, () => { r.out += 1; const b = r.buffer; r.buffer = ''; if (b) r.process(b); });
  };
  r.tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => r.now, () => r.mono);
  r.runtime = new CapacityRuntime({
    deliver: () => {}, now: () => r.now, setTimer, log: () => {},
    clearTimer: (h) => { r.timers = r.timers.filter((t) => t.seq !== (h && h.id)); }
  }, r.tracker);
  const tail = (expectedTail) => (expectedTail ? { promptTailMatches: r.prompt.trim() !== '' && r.prompt.trimEnd().endsWith(expectedTail) } : {});
  r.deps = buildOwnerDeps({
    pty: {
      write: (id, data, origin) => {
        assert.equal(origin, 'PROGRAMMATIC');
        r.writes.push(data); r.writeAt.push(r.now);
        if (r.enterWriteFails && data === '\r') return { ok: false, error: 'EPIPE' };
        if (r.now < r.busyUntil) r.buffer += data; else r.process(data);
        return { ok: true };
      },
      incarnation: () => 1,
      humanInputGeneration: () => r.gen,
      lastHumanInputAt: () => undefined,
      hasOutput: () => true,
      inputState: () => ({ mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' }),
      promptState: () => ({ block: null }),
      outputGeneration: () => r.out,
      spawnCwd: () => undefined
    },
    capacity: r.runtime,
    ptyForAgent: (agentId) => (agentId === 'jim' ? 'pty-jim' : undefined),
    providerForPty: () => 'claude',
    requestScreenReading: (ptyId, needle, expectedTail) => {
      if (r.nextReading) { const v = r.nextReading; r.nextReading = null; return Promise.resolve(v); }
      const rows = r.prompt.split('\n');
      return Promise.resolve({
        onPromptRow: rows[rows.length - 1].includes(needle),
        screenCount: [...r.turns, r.prompt].filter((t) => t.includes(needle)).length,
        ...tail(expectedTail)
      });
    },
    requestCodexScreen: (ptyId, expectedTail) => {
      const fx = view(r.prompt);
      r.codexReads += 1;
      if (r.onCodexRead) r.onCodexRead(r.codexReads);   // after the frame was taken: a race
      return Promise.resolve({ onPromptRow: false, screenCount: 0, codex: SHARED.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow), ...tail(expectedTail) });
    },
    onInterfered: (rec) => r.interfered.push(rec),
    submittedSince: (ptyId, agentId, since) => r.ups.some((t) => t >= since),
    now: () => r.now, setTimer
  });
  if (over.guardOff) r.deps.screenGuard = () => 'OFF';
  r.owner = new OWN.AutomaticSubmitOwner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 20000; i += 1) {
      await new Promise((res) => setImmediate(res));
      if (done) return value;
      assert.ok(r.timers.length, 'stuck: unsettled and no timer pending');
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      const dt = Math.max(0, next.at - r.now);
      r.now += dt; r.mono += dt;
      next.fn();
    }
    throw new Error('did not settle');
  };
  r.advance = (ms) => { r.now += ms; r.mono += ms; };
  r.submit = (requestId, extra = {}) => r.settle(r.owner.submit({ requestId, agentId: 'jim', admissionClass: 'CAPACITY_GATED', text: TEXT, ...extra }));
  return r;
}

/** Jim's attempt 0 with a TUI that takes the Enter as a newline: our draft, unsent. */
async function newlineDraft(r) {
  r.enterWorks = false;
  assert.deepEqual(await r.submit('inbox-wake:jim:4aea08:0'), COMMITTED, 'a first Enter is judged by the coordinator\'s 60 s confirmation, as before');
  assert.equal(r.prompt, `${TEXT}\n`, 'our text on the row above an empty cursor row');
  assert.deepEqual(r.turns, []);
  r.writes.length = 0;
}

// ─── A ────────────────────────────────────────────────────────────────────────────────────

test('A: after a Stop, nothing is typed into a Claude still drawing its turn; the wake goes in once output is quiet, and is submitted', async () => {
  const r = rig();
  r.drawUntil(T0 + 400);
  r.now += 5;
  const out = await r.submit('inbox-wake:jim:4aea08:0');
  assert.ok(r.writeAt.length > 0 && r.writeAt[0] >= T0 + 400 + PA.CLAUDE_STAGE_QUIET_MS - 100,
    `first byte at +${r.writeAt[0] - T0} ms: not before ${PA.CLAUDE_STAGE_QUIET_MS} ms of quiet after the last frame (+400 ms)`);
  assert.deepEqual(out, COMMITTED);
  assert.deepEqual(r.writes, [TEXT, '\r'], 'the text, then one Enter');
  assert.deepEqual(r.turns, [TEXT], 'one turn, exactly our text');
});

test('A: the quiet wait is Claude\'s own policy (750 ms), and it is real readiness: a Claude that never goes quiet gets no byte', async () => {
  assert.equal(PA.automaticStageQuietMs('claude'), 750);
  const r = rig();
  r.drawUntil(T0 + 60_000);
  const out = await r.submit('inbox-wake:jim:4aea08:0');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'output-not-quiet' });
  assert.deepEqual(r.writes, [], 'nothing typed');
  assert.equal(r.owner.inhibition('pty-jim'), null, 'nothing held');
});

// ─── B ────────────────────────────────────────────────────────────────────────────────────

test('B (Jim 22:23:59.885): the recheck re-Enter that starts no turn is NOT COMMITTED; the draft stays ours, nothing is held', async () => {
  const r = rig();
  await newlineDraft(r);
  r.advance(67_000);
  const t1 = r.now;
  const a1 = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.equal(a1.kind, 'REFUSED', `not COMMITTED without a turn (got ${JSON.stringify(a1)})`);
  assert.equal(a1.reason, 'SUBMIT_UNCONFIRMED');
  assert.ok(r.now - t1 >= OWN.WAKE_SUBMIT_CONFIRM_MS, 'the report was waited for, not 57 ms');
  assert.deepEqual(r.writes, ['\r'], 'only an Enter on our draft, never a second copy');
  assert.equal(r.owner.inhibition('pty-jim'), null, 'never held for a person');
  assert.deepEqual(r.interfered, []);
});

test('B (Jim 22:30:15.013): at the 300 s retry our own text is still ours: re-Entered, COMMITTED on the report, one turn, never INTERFERED', async () => {
  const r = rig();
  await newlineDraft(r);
  r.advance(67_000);
  await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  r.advance(300_000);
  r.enterWorks = true;
  const a2 = await r.submit('inbox-wake:jim:4aea08:2', { priorText: TEXT });
  assert.deepEqual(a2, COMMITTED, `the 300 s retry delivers (got ${JSON.stringify(a2)})`);
  assert.deepEqual(r.writes, ['\r', '\r'], 'one Enter per attempt, no second copy of the text');
  assert.deepEqual(r.turns, [TEXT], 'exactly one turn');
  assert.equal(r.owner.inhibition('pty-jim'), null);
  assert.deepEqual(r.interfered, [], 'never INTERFERED PRIOR_TEXT_ON_PROMPT on our own text');
});

test('B: however often the TUI refuses the Enter, our own draft is never held as a person\'s', async () => {
  const r = rig();
  await newlineDraft(r);
  for (let i = 1; i <= 4; i += 1) {
    r.advance(300_000);
    const out = await r.submit(`inbox-wake:jim:4aea08:${i}`, { priorText: TEXT });
    assert.equal(out.reason, 'SUBMIT_UNCONFIRMED', `attempt ${i}`);
  }
  assert.deepEqual(r.writes, ['\r', '\r', '\r', '\r']);
  assert.deepEqual(r.interfered, []);
});

test('B single delivery: the FIRST Enter lands late, during the re-Enter\'s wait: COMMITTED, one turn (the re-Enter hit an empty composer)', async () => {
  const r = rig();
  await newlineDraft(r);
  r.advance(67_000);
  // The first Enter was only queued in the TUI: it submits 2 s after our re-Enter, which the TUI
  // read first as one more newline.
  r.at(r.now + 2_000, () => { r.turns.push(r.prompt.trim()); r.prompt = ''; r.ups.push(r.now); r.out += 1; });
  const a1 = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(a1, COMMITTED);
  assert.deepEqual(r.turns, [TEXT], 'exactly one turn');
});

test('B single delivery: the first Enter lands between the re-Enter\'s ready reading and its Enter: the redraw stops the Enter, one turn', async () => {
  // How many screen reads attempt 1 takes before its Enter (the last one is the gate's).
  const dry = rig();
  await newlineDraft(dry);
  dry.advance(67_000);
  let gateRead = 0;
  dry.onCodexRead = (n) => { if (!dry.writes.length) gateRead = n; };
  await dry.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.ok(gateRead > 0, 'the re-Enter is gated on a screen reading');

  const r = rig();
  await newlineDraft(r);
  r.advance(67_000);
  r.onCodexRead = (n) => {
    if (n !== gateRead) return;
    r.turns.push(r.prompt.trim()); r.prompt = ''; r.ups.push(r.now); r.out += 1;   // the late first Enter
  };
  const a1 = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(a1, { kind: 'REFUSED', reason: 'SCREEN_CHANGED', detail: 'output after the re-Enter reading' });
  assert.deepEqual(r.writes, [], 'no Enter after the reading went stale');
  assert.deepEqual(r.turns, [TEXT], 'exactly one turn');
});

test('B: a submit reported after our Enter consumes the draft: a composer that still ends with our text is no longer provably ours (held, no Enter)', async () => {
  const r = rig();
  await newlineDraft(r);
  r.advance(10_000);
  r.ups.push(r.now);          // a prompt WAS submitted since our Enter (a turn the app did not see)
  r.advance(57_000);
  const out = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'PRIOR_TEXT_ON_PROMPT' });
  assert.deepEqual(r.writes, [], 'no Enter on a draft we cannot prove is still ours');
});

test('B: a person\'s key since our stage still rules: held, no Enter', async () => {
  const r = rig();
  await newlineDraft(r);
  r.gen += 1;
  r.advance(67_000);
  const out = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'PRIOR_TEXT_ON_PROMPT' });
  assert.deepEqual(r.writes, []);
});

// ─── C ────────────────────────────────────────────────────────────────────────────────────

/** A hold on our own draft: the recheck's reading caught a frame where the tail did not match. */
async function heldOnOwnDraft(r) {
  await newlineDraft(r);
  r.advance(67_000);
  r.nextReading = { onPromptRow: true, screenCount: 1, promptTailMatches: false };
  const out = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'PRIOR_TEXT_ON_PROMPT' });
  assert.ok(r.owner.inhibition('pty-jim'));
  r.writes.length = 0;
}

test('C: a hold on our own proven draft is recovered by the app: an Enter, a reported submit, SUBMITTED, the hold gone', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  r.advance(60_000);
  r.enterWorks = true;
  const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
  assert.equal(out.kind, 'SUBMITTED', `recovered, not left for a person (got ${JSON.stringify(out)})`);
  assert.deepEqual(r.writes, ['\r']);
  assert.deepEqual(r.turns, [TEXT]);
  assert.equal(r.owner.inhibition('pty-jim'), null);
});

test('C: a person\'s key since our stage: the hold stays theirs, nothing written', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  const held = r.owner.inhibition('pty-jim');
  const reported = r.interfered.length;
  r.gen += 1;
  r.advance(60_000);
  const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
  assert.equal(out.kind, 'HELD');
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.owner.inhibition('pty-jim'), held, 'the same hold, untouched');
  assert.equal(r.interfered.length, reported, 'no Enter tried, so nothing new to report');
});

test('C with the screen guard off: only a composer ENDING with our draft gets the Enter', async () => {
  const r = rig({ guardOff: true });
  await heldOnOwnDraft(r);
  r.prompt += 'and more';
  r.advance(60_000);
  const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
  assert.equal(out.kind, 'HELD');
  assert.deepEqual(r.writes, []);
});

test('C: a TUI that takes no Enter keeps the hold, and gets at most HELD_OWN_ENTER_MAX Enters', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  for (let i = 0; i < OWN.HELD_OWN_ENTER_MAX + 2; i += 1) {
    r.advance(60_000);
    const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
    assert.equal(out.kind, 'HELD', `look ${i}`);
    assert.ok(r.owner.inhibition('pty-jim'), `look ${i}: still held`);
  }
  assert.equal(r.writes.length, OWN.HELD_OWN_ENTER_MAX, 'bounded');
});

test('C: an Enter whose write fails is held anew, and the new hold keeps the count (still at most HELD_OWN_ENTER_MAX)', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  r.enterWriteFails = true;
  for (let i = 0; i < OWN.HELD_OWN_ENTER_MAX + 2; i += 1) {
    r.advance(60_000);
    const held = r.owner.inhibition('pty-jim');
    const out = await r.settle(r.owner.recheckHeld('pty-jim', held.requestId));
    assert.equal(out.kind, 'HELD', `look ${i}`);
    assert.equal(r.owner.inhibition('pty-jim').reason, 'ENTER_WRITE_FAILED', `look ${i}: the new hold says why`);
  }
  assert.equal(r.writes.length, OWN.HELD_OWN_ENTER_MAX, 'bounded across the new holds');
});

test('C: a composer that no longer ENDS with our draft is not provably ours: no Enter, the hold stays', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  r.prompt += 'and more';
  r.advance(60_000);
  const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
  assert.equal(out.kind, 'HELD');
  assert.deepEqual(r.writes, []);
  assert.ok(r.owner.inhibition('pty-jim'));
});

test('C main wiring: a recovered hold is resolved as delivered, and the submit report is Claude\'s UserPromptSubmit', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /onInterferenceResolved\(h\.agentId, r\.kind === 'SUBMITTED' \? 'ALREADY_HANDLED' : 'SEND_AGAIN'\)/);
  assert.match(src, /submittedSince: \(ptyId, agentId, since\) => \(ptyProvider\.get\(ptyId\) === 'claude'\s*\? bootHooks\.submittedSince\(agentId, ptyManager\.livenessFacts\(ptyId\)\?\.spawnedAt \?\? 0, since\)/);
  const wiring = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'automaticSubmitWiring.ts'), 'utf8');
  assert.match(wiring, /submittedSince: w\.submittedSince,/);
});

// ─── the coordinator ────────────────────────────────────────────────────────────────────

test('B coordinator: SUBMIT_UNCONFIRMED is settled UNCONFIRMED: the ids wait out the backoff with the prompt check kept, never a hold', async () => {
  const c = new WorkerWakeWatchdog();
  let now = T0;
  const outcomes = [{ kind: 'REFUSED', reason: 'SUBMIT_UNCONFIRMED' }];
  const submits = [];
  const immediates = [];
  const bridge = new InboxWakeBridge({
    coordinator: c,
    inboxIds: () => ['m1'],
    facts: () => ({ ptyId: 'pty-jim', lastOutputAt: now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
    submit: (req) => { submits.push(req); return Promise.resolve(outcomes.shift() ?? COMMITTED); },
    text: (ids) => `wake ${ids.join(',')}`,
    setImmediate: (fn) => immediates.push(fn),
    now: () => now,
    confirmsTurnStart: () => true
  });
  c.noteHook('jim', 'Stop', '', now);
  // Jim's claim after submit-unconfirmed carries the prompt check.
  c.reconcile('jim', ['m1']);
  const claim0 = c.claim({ agentId: 'jim', ptyId: 'pty-jim', lastOutputAt: now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }, 'reconcile', 'reconcile', now);
  c.settle(claim0, 'COMMITTED', now, true);
  now += 61_000;
  assert.equal(c.beat('jim', now).kind, 'submit-unconfirmed');
  const claim1 = bridge.requestInboxWake('jim', 'reconcile', 'reconcile');
  assert.ok(claim1 && claim1.recheck, 'the re-claim checks the prompt');
  await new Promise((res) => setImmediate(res));
  assert.equal(submits.at(-1).priorText, 'wake m1');
  const st = c.state('jim');
  assert.equal(st.held, null, 'never a hold');
  assert.deepEqual(st.pending, [], 'not pending again at once (no Enter a minute)');
  now += 61_000;
  assert.notEqual(c.beat('jim', now)?.kind, 'wake-retry', 'no retry offered inside the backoff');
  assert.equal(bridge.requestInboxWake('jim', 'reconcile', 'reconcile'), null, 'nothing claimed inside the backoff');
  now += WAKE_RETRY_BASE_MS;
  assert.equal(c.beat('jim', now).kind, 'wake-retry', 'offered again after the backoff');
  const claim2 = bridge.requestInboxWake('jim', 'reconcile', 'reconcile');
  assert.ok(claim2 && claim2.recheck, 'and the prompt check is still carried');
});

// ─── Jim NIT-1: a person's key during the 5 s confirm ──────────────────────────────────────

test('B (Jim NIT-1): a person who types and submits during the re-Enter\'s confirm wait: SUBMIT_UNCONFIRMED at once, never our turn', async () => {
  const r = rig();
  await newlineDraft(r);
  r.advance(67_000);
  const t1 = r.now;
  r.at(t1 + 2_000, () => { r.gen += 1; r.turns.push('their own prompt'); r.ups.push(r.now); r.out += 1; });
  const a1 = await r.submit('inbox-wake:jim:4aea08:1', { priorText: TEXT });
  assert.deepEqual(a1, { kind: 'REFUSED', reason: 'SUBMIT_UNCONFIRMED', detail: 'a person typed while the re-Enter was being confirmed' },
    'the reported submit may be the person\'s: not COMMITTED');
  assert.ok(r.now - t1 < OWN.WAKE_SUBMIT_CONFIRM_MS, 'settled when the key arrived, not at the end of the wait');
  assert.deepEqual(r.writes, ['\r'], 'one Enter on our draft, nothing else');
});

test('C (Jim NIT-1): a person who types and submits during the held re-Enter\'s confirm: the hold stays, not SUBMITTED', async () => {
  const r = rig();
  await heldOnOwnDraft(r);
  r.advance(60_000);
  r.at(r.now + 2_000, () => { r.gen += 1; r.turns.push('their own prompt'); r.ups.push(r.now); r.out += 1; });
  const out = await r.settle(r.owner.recheckHeld('pty-jim', 'inbox-wake:jim:4aea08:1'));
  assert.equal(out.kind, 'HELD', `not delivered on the person's submit (got ${JSON.stringify(out)})`);
  assert.equal(out.why, 'own-draft:REFUSED:SUBMIT_UNCONFIRMED');
  assert.deepEqual(r.writes, ['\r'], 'the Enter went out before the key');
  assert.ok(r.owner.inhibition('pty-jim'), 'still held');
});

// ─── Jim SHOULD-1: a Claude that never goes quiet is a decision, never a silent stall ─────────

const QW = loadTs('src/main/quietRefusalWatch.ts');
const D = loadTs('src/main/floorDigest.ts');
const NOT_QUIET = { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'output-not-quiet' };

test('SHOULD-1: QUIET_REFUSAL_ALERT_AFTER in a row raises one row and a stall; a wake past the gate clears it', () => {
  assert.equal(QW.QUIET_REFUSAL_ALERT_AFTER, 3, 'measured: an idle Claude draws nothing for hours, so 3 in a row is never normal');
  const rows = [];
  const w = new QW.QuietRefusalWatch((row) => rows.push(row));
  w.outcome('jim', NOT_QUIET, T0);
  w.outcome('jim', NOT_QUIET, T0 + 300_000);
  assert.deepEqual(rows, []);
  assert.deepEqual(w.stalls(), [], 'not yet');
  w.outcome('andy', NOT_QUIET, T0 + 1);
  w.outcome('jim', { kind: 'REFUSED', reason: 'CAPACITY_HOLD' }, T0 + 400_000);
  w.outcome('jim', NOT_QUIET, T0 + 600_000);
  assert.deepEqual(rows, [{ kind: 'wake-not-quiet', event: 'raised', agentId: 'jim', count: 3, since: T0 }],
    'a refusal before the quiet gate neither counts nor breaks the run');
  w.outcome('jim', NOT_QUIET, T0 + 900_000);
  assert.equal(rows.length, 1, 'raised once per run');
  assert.deepEqual(w.stalls(), [{ agentId: 'jim', count: 4, since: T0 }], 'per agent: andy has 1');
  w.outcome('jim', COMMITTED, T0 + 1_200_000);
  assert.deepEqual(rows[1], { kind: 'wake-not-quiet', event: 'cleared', agentId: 'jim', count: 4, since: T0 });
  assert.deepEqual(w.stalls(), []);
});

test('SHOULD-1: the screen gate\'s own refusal is past the quiet gate: it ends the run', () => {
  const rows = [];
  const w = new QW.QuietRefusalWatch((row) => rows.push(row));
  w.outcome('jim', NOT_QUIET, T0);
  w.outcome('jim', NOT_QUIET, T0 + 1);
  w.outcome('jim', { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'composer-not-empty' }, T0 + 2);
  w.outcome('jim', NOT_QUIET, T0 + 3);
  w.outcome('jim', NOT_QUIET, T0 + 4);
  assert.deepEqual(rows, [], 'two runs of 2, no alert');
});

test('SHOULD-1 through the real owner: a Claude that never goes quiet is a stall after 3 wakes, with nothing typed', async () => {
  const r = rig();
  const rows = [];
  const w = new QW.QuietRefusalWatch((row) => rows.push(row));
  r.deps.onOutcome = (rec) => w.outcome(rec.agentId, rec.outcome, rec.at);
  r.drawUntil(T0 + 3_600_000);
  for (let i = 0; i < 3; i += 1) {
    const out = await r.submit(`inbox-wake:jim:4aea08:${i}`);
    assert.deepEqual(out, NOT_QUIET, `wake ${i}`);
    r.advance(60_000);
  }
  assert.deepEqual(r.writes, [], 'nothing typed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'raised');
  assert.equal(w.stalls()[0].count, 3);
});

test('SHOULD-1: a stall is a floor-digest decision (god is woken), one per run', () => {
  const stall = { agentId: 'jim-mtujpe28', name: 'Jim', count: 3, since: T0 };
  const items = D.decisionItems([], [], T0 + 900_000, [], [], [stall]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `wake-not-quiet:jim-mtujpe28:${T0}`);
  assert.match(items[0].line, /^Jim: 3 automatic wakes in a row refused over .*nothing typed.*never went quiet \(output-not-quiet\) - its mail is not being delivered/);
  const { decisionItems: viaBuild, markdown } = D.buildFloorDigest({ tasks: { tasks: [] }, meta: {}, flags: [], ledgerIssues: [], agents: [], now: T0 + 900_000, quietStalls: [stall] });
  assert.deepEqual(viaBuild.map((i) => i.id), [items[0].id]);
  assert.ok(markdown.includes(items[0].id));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'floorDigest.ts'), 'utf8');
  assert.match(src, /quietStalls: \(\(\) => \{ try \{ return this\.host\.quietStalls\?\.\(\) \?\? \[\]; \} catch \{ return \[\]; \} \}\)\(\),/);
});

test('SHOULD-1 main wiring: every owner outcome reaches the watch, and its stalls reach the digest', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /onOutcome: \(r\) => \{\s*\/\/[^\n]*\n\s*pushAgentImpact\(\);\s*quietRefusals\.outcome\(r\.agentId, r\.outcome, r\.at\);/);
  assert.match(src, /quietStalls: \(\) => quietRefusals\.stalls\(\)\.map\(\(q\) => \(\{ \.\.\.q, name: agentDisplayName\(q\.agentId\) \}\)\),/);
  assert.match(src, /const quietRefusals = new QuietRefusalWatch\(\(row\) => \{ try \{ hive\.appendLog\(row\); \} catch/);
});
