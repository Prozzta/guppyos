'use strict';

/**
 * DWIGHT-HELD-INTERFERED-2028 (1.1.78, Human-added; Jim's DWIGHT-HELD-INTERFERED.md, god plan-178).
 *
 * 2026-10-01 20:27:41Z: the app typed Dwight's Codex wake 0.3 s after his Stop hook, while Codex
 * was still finishing the turn (its task_complete came 105 ms after the Stop). The text did not
 * stay on the prompt row, the erase could never see it, so the owner held the wake INTERFERED,
 * and an INTERFERED wake waited for a person forever with nothing telling anyone.
 *
 *   fix 1  a held WAKE is looked at again about once a minute: the plain empty composer with our
 *          text on screen 0 times (and no human key since) releases it as "let it retry"; our text
 *          on the prompt row lets the verified erase run; anything else stays held.
 *   fix 2  after 5 minutes held, a plain-words notice (dismissible, lifted on release) and a
 *          floor-digest decision for god.
 *   fix 3  Codex is staged only after its output has been quiet for 750 ms.
 *   fix 4  COMMIT refusals and INTERFERED holds log the screen facts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const SHARED = loadTs('src/shared/codexScreen.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const HELD = loadTs('src/main/heldInterference.ts');
const DIGEST = loadTs('src/main/floorDigest.ts');
const PROVIDER = loadTs('src/shared/providerAutomation.ts');
const BANNER = loadTs('src/shared/integrityBanner.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const CWD = 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
const READY_SCREEN = (() => { const fx = fixture('2-trusted-handoff-120x40'); return SHARED.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow); })();

const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };
const TEXT = '[hive] check inbox';
const NEEDLE = OWNER.needleFor(TEXT);
const COMMITTED = { kind: 'COMMITTED' };

/**
 * A Codex terminal on the real post-handoff screen. `r.prompt` is the composer's text; `r.blank`
 * is a frame mid-redraw (the cursor row is not the composer); `r.transcript` counts our text
 * above the prompt. A write is PTY output (the generation moves); Enter moves the prompt's text
 * into the transcript; Ctrl-U clears the prompt.
 */
function rig(over = {}, M = OWNER) {
  const r = {
    now: 1_000_000, seq: 0, timers: [], writes: [], guard: [], interfered: [], grants: { cancel: 0, hold: 0, confirm: 0 },
    incarnation: 1, gen: 10, human: 0, prompt: '', blank: false, transcript: 0, provider: 'codex', quietMs: null,
    ...over
  };
  r.facts = () => {
    if (r.blank) return { ...READY_SCREEN, cursorRow: '' };
    if (r.cursorRow !== undefined) return { ...READY_SCREEN, cursorRow: r.cursorRow };
    return r.prompt ? { ...READY_SCREEN, cursorRow: `\u203a ${r.prompt}` } : READY_SCREEN;
  };
  const onPrompt = (n) => !r.blank && r.prompt.includes(n);
  const setTimer = (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; };
  r.at = (ms, fn) => r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn });
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => r.incarnation,
    humanGeneration: () => r.human,
    write: (_id, d) => {
      r.writes.push(d);
      if (d === '\r') { if (r.prompt.includes(NEEDLE)) r.transcript += 1; r.prompt = ''; }
      else if (d === '\x15') r.prompt = '';
      else r.prompt += d;
      r.gen += 1;
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: (_id, n) => Promise.resolve(r.noNeedle ? null : { onPromptRow: onPrompt(n), screenCount: (onPrompt(n) ? 1 : 0) + r.transcript }),
    capacity: {
      admit: () => ALLOW, revalidate: () => ALLOW,
      confirmLaunch() { r.grants.confirm += 1; }, cancelGrant() { r.grants.cancel += 1; }, holdGrant() { r.grants.hold += 1; }
    },
    now: () => r.now,
    setTimer,
    screenGuard: () => (r.provider === 'codex' ? 'ENFORCE' : 'OFF'),
    readGuardScreen: (_id, tail) => {
      if (r.noReading) return Promise.resolve(null);
      const reading = { facts: r.facts(), incarnation: r.incarnation, outputGeneration: r.gen, ...(tail === undefined ? {} : { promptTailMatches: !r.blank && r.prompt.endsWith(tail) }) };
      if (r.afterRead) r.afterRead();
      return Promise.resolve(reading);
    },
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: (rec) => r.guard.push(rec),
    onInterfered: (rec) => r.interfered.push(rec),
    stageQuietMs: () => r.quietMs,
    ...(over.deps ?? {})
  };
  r.owner = new M.AutomaticSubmitOwner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 20000; i += 1) {
      await new Promise((res) => setImmediate(res));
      if (done) return value;
      assert.ok(r.timers.length, 'stuck: unsettled and no timer pending');
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      r.now = Math.max(r.now, next.at);
      next.fn();
    }
    throw new Error('did not settle');
  };
  /** Run every pending timer (the owner's post-COMMIT settle), so the next step starts idle. */
  r.drain = () => {
    while (r.timers.length) {
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      r.now = Math.max(r.now, next.at);
      next.fn();
    }
  };
  r.submit = (id = 'w1', cls = 'CAPACITY_GATED') => r.settle(r.owner.submit({ requestId: id, agentId: 'dwight', admissionClass: cls, text: TEXT }));
  r.recheck = (id = 'w1') => r.settle(r.owner.recheckHeld('p1', id));
  return r;
}

/** Dwight's end of turn, from his Stop at r.now: Codex's task_complete 105 ms later starts the
 *  end-of-stream redraw, which drops what the composer held; frames until `doneMs`, when the
 *  empty composer is drawn again. */
function endOfTurn(r, doneMs = 400) {
  r.at(105, () => { r.prompt = ''; r.blank = true; r.gen += 1; });
  for (let t = 205; t < doneMs; t += 100) r.at(t, () => { r.gen += 1; });
  r.at(doneMs, () => { r.blank = false; r.gen += 1; });
}

/** The 20:27:41 race as 1.1.77 ran it (no quiet window): a wake left held INTERFERED. */
async function heldLikeDwight(over = {}, M = OWNER) {
  const r = rig(over, M);
  assert.deepEqual(await r.submit('latch'), COMMITTED, 'a first wake latches condition 1 on the real composer');
  r.drain();
  r.prompt = ''; r.transcript = 0; r.writes.length = 0; r.guard.length = 0;
  endOfTurn(r);
  const out = await r.submit('w1');
  return { r, out };
}

const K = {};

// ─── The replay ─────────────────────────────────────────────────────────────────────────

K.raceReplays = async (M = OWNER) => {
  const { r, out } = await heldLikeDwight({}, M);
  assert.equal(out.kind, 'INTERFERED', 'REPLAY: the wake typed before the redraw is held INTERFERED');
  assert.equal(out.reason, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', 'REPLAY: held because the erase never saw our text');
  assert.equal(r.writes.filter((w) => w === '\r').length, 0, 'REPLAY: no Enter was sent');
  const refused = r.guard.find((g) => g.phase === 'COMMIT' && !g.ok);
  assert.ok(refused, 'REPLAY: the COMMIT reading refused');
  assert.equal(refused.reason, 'UNKNOWN:not-the-empty-composer', 'REPLAY: refused as at 20:27:42.491');
  assert.ok(r.owner.inhibition('p1'), 'REPLAY: the PTY is inhibited');
};
test('REPLAY 20:27:41: a wake staged before Codex finished its turn is held INTERFERED (as 1.1.77 did)', () => K.raceReplays());

K.commitRefusalLogsScreen = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  const refused = r.guard.find((g) => g.phase === 'COMMIT' && !g.ok);
  assert.deepEqual(refused.screen, { cursorRow: '', footer: [...READY_SCREEN.footer] }, 'FIX 4: A COMMIT REFUSAL LOGS WHAT THE READING SAW');
  assert.equal(r.guard.find((g) => g.phase === 'STAGE').screen, undefined, 'a STAGE reading carries no facts (only COMMIT refusals do)');
  assert.equal(r.interfered.length, 1, 'FIX 4: the hold is reported');
  const h = r.interfered[0];
  assert.equal(h.reason, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE');
  assert.equal(h.agentId, 'dwight');
  assert.ok(h.screen && typeof h.screen.cursorRow === 'string', 'FIX 4: AN INTERFERED HOLD LOGS THE LAST SCREEN FACTS');
  assert.ok(h.screenAgeMs >= 0);
  assert.deepEqual([h.needle.onPromptRow, h.needle.screenCount], [false, 0], 'FIX 4: and the last needle reading (our text not on screen)');
};
test('fix 4: a COMMIT refusal and an INTERFERED hold carry the screen facts (is our text still staged?)', () => K.commitRefusalLogsScreen());

// ─── Fix 3: close the race ──────────────────────────────────────────────────────────────

K.raceClosedByQuiet = async (M = OWNER) => {
  for (const doneMs of [400, 900]) {
    const r = rig({ quietMs: 750 }, M);
    assert.deepEqual(await r.submit('latch'), COMMITTED);
    r.drain();
    r.prompt = ''; r.transcript = 0; r.writes.length = 0;
    const stop = r.now;
    let stagedAt = null;
    const write = r.deps.write;
    r.deps.write = (id, d) => { if (d === TEXT) stagedAt = r.now; return write(id, d); };
    endOfTurn(r, doneMs);
    const out = await r.submit('w1');
    assert.deepEqual(out, COMMITTED, `THE WAKE IS STAGED ONLY AFTER THE OUTPUT IS QUIET (redraw done at +${doneMs} ms)`);
    assert.ok(stagedAt - stop >= doneMs + 750, `THE WAKE IS STAGED ONLY AFTER THE OUTPUT IS QUIET: staged at +${stagedAt - stop} ms`);
    assert.deepEqual(r.writes, [TEXT, '\r']);
  }
};
test('fix 3: with Codex\'s 750 ms quiet window the same end of turn is delivered, staged after the redraw', () => K.raceClosedByQuiet());

test('fix 3: output that never goes quiet types nothing and is asked again (not held)', async () => {
  const r = rig({ quietMs: 750 });
  assert.deepEqual(await r.submit('latch'), COMMITTED);
  r.writes.length = 0; r.prompt = '';
  for (let t = 100; t <= 6000; t += 200) r.at(t, () => { r.gen += 1; });
  const out = await r.submit('w1');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'output-not-quiet' });
  assert.equal(r.writes.length, 0, 'nothing typed');
  assert.equal(r.owner.inhibition('p1'), null, 'nothing held');
});

K.codexQuietWindow = (P = PROVIDER) => {
  assert.equal(P.automaticStageQuietMs('codex'), 750, 'CODEX IS STAGED AFTER 750 MS OF QUIET');
  for (const p of ['claude', 'antigravity', 'cursor']) assert.equal(P.automaticStageQuietMs(p), null, `${p}: no wait`);
};
test('fix 3: the quiet window is Codex\'s only (750 ms)', () => K.codexQuietWindow());

K.personSendNowNotDelayed = async (M = OWNER) => {
  for (const cls of ['USER_RELEASED', 'BOOT_SEQUENCE']) {
    const r = rig({ quietMs: 750 }, M);
    assert.deepEqual(await r.submit('latch'), COMMITTED);
    r.drain();
    r.prompt = ''; r.transcript = 0; r.writes.length = 0;
    const start = r.now;
    for (let t = 50; t <= 1000; t += 50) r.at(t, () => { r.gen += 1; });   // a working Codex streams
    let stagedAt = null;
    const write = r.deps.write;
    r.deps.write = (id, d) => { if (d === TEXT) stagedAt = r.now; return write(id, d); };
    const out = await r.submit(`${cls}-1`, cls);
    assert.deepEqual(out, COMMITTED, `${cls}: A PERSON'S SEND-NOW IS NOT HELD FOR QUIET (not refused)`);
    assert.ok(stagedAt !== null && stagedAt - start < 100, `${cls}: A PERSON'S SEND-NOW IS NOT HELD FOR QUIET (staged at +${stagedAt - start} ms)`);
  }
};
test('Jim S1: the quiet window is for automatic wakes only: a person\'s send-now (and a boot prompt) to a streaming Codex is neither delayed nor refused', () => K.personSendNowNotDelayed());

// ─── Fix 1: the held wake is looked at again ────────────────────────────────────────────

K.selfReleaseOnCleanScreen = async (M = OWNER) => {
  const { r, out } = await heldLikeDwight({}, M);
  assert.equal(out.kind, 'INTERFERED');
  const cancels = r.grants.cancel;
  const res = await r.recheck('w1');
  assert.equal(res.kind, 'RELEASED', `A CLEAN SCREEN RELEASES THE HELD WAKE (got ${JSON.stringify(res)})`);
  assert.equal(res.screen.cursorRow, SHARED.CODEX_EMPTY_COMPOSER_ROW, 'the reading that released it is reported');
  assert.equal(r.owner.inhibition('p1'), null, 'A CLEAN SCREEN RELEASES THE HELD WAKE: the PTY is no longer inhibited');
  assert.equal(r.grants.cancel, cancels + 1, 'the held grant is handed back (not launched), as for "let it retry"');
  assert.equal(r.writes.filter((w) => w !== TEXT).length, 0, 'the look itself typed nothing');
  // "let it retry": the same id goes through every gate again, and is delivered once.
  assert.deepEqual(await r.submit('w1'), COMMITTED, 'the id is free again: the retry is delivered');
  assert.deepEqual(r.writes.slice(-2), [TEXT, '\r']);
};
test('fix 1: a held wake on the plain empty composer, our text nowhere on screen, is released as "let it retry"', () => K.selfReleaseOnCleanScreen());

K.ownTextOnScreenStaysHeld = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  r.transcript = 1;                                  // our text above the prompt (it may have gone out)
  const res = await r.recheck('w1');
  assert.deepEqual([res.kind, res.why], ['HELD', 'own-text-on-screen'], 'OUR TEXT ON SCREEN KEEPS IT HELD');
  assert.ok(r.owner.inhibition('p1'));
};
test('fix 1: our text anywhere on screen keeps it held', () => K.ownTextOnScreenStaysHeld());

K.personTouchedStaysHeld = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  r.human += 1;                                      // a person typed (and perhaps sent it) since
  const res = await r.recheck('w1');
  assert.deepEqual([res.kind, res.why], ['HELD', 'human-input-since-hold'], "A PERSON'S KEY SINCE THE HOLD KEEPS IT HELD");
  // ...also when the key lands while the look is reading the screen.
  const b = await heldLikeDwight({}, M);
  b.r.afterRead = () => { b.r.human += 1; };
  const res2 = await b.r.recheck('w1');
  assert.deepEqual([res2.kind, res2.why], ['HELD', 'human-input-since-hold'], "A PERSON'S KEY SINCE THE HOLD KEEPS IT HELD (during the look)");
};
test('fix 1: a person\'s key since the hold keeps it held (before or during the look)', () => K.personTouchedStaysHeld());

K.ownTextOnPromptErased = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  r.prompt = TEXT;                                   // our text is on the prompt row after all
  const res = await r.recheck('w1');
  assert.equal(res.kind, 'ERASED', `OUR TEXT ON THE PROMPT ROW IS ERASED (got ${JSON.stringify(res)})`);
  assert.equal(r.writes.at(-1), '\x15', 'the verified erase (the clear control), and nothing else');
  assert.equal(r.writes.filter((w) => w === '\r').length, 0, 'never an Enter');
  assert.equal(r.prompt, '');
  assert.equal(r.owner.inhibition('p1'), null);
  assert.deepEqual(await r.submit('w1'), COMMITTED, 'and the id is re-offered');
};
test('fix 1: our own text on the prompt row lets the verified erase run', () => K.ownTextOnPromptErased());

K.noReleaseWithoutLatch = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  r.owner.postHandoff.delete('p1');                  // condition 1 not latched for this incarnation
  const res = await r.recheck('w1');
  assert.equal(res.kind, 'HELD', `NO RELEASE WITHOUT THE LATCH (got ${JSON.stringify(res)})`);
  assert.match(res.why, /^startup:/);
  assert.ok(r.owner.inhibition('p1'));
};
test('Jim T1: no release without condition 1 latched for this incarnation', () => K.noReleaseWithoutLatch());

K.reholdKeepsClock = async (M = OWNER) => {
  const { r } = await heldLikeDwight({}, M);
  const at0 = r.owner.inhibition('p1').at;
  r.now += 120_000;
  r.prompt = TEXT;                                   // our text on the prompt row...
  const write = r.deps.write;
  r.deps.write = (id, d) => (d === '\x15' ? (r.writes.push(d), r.gen += 1, { ok: true }) : write(id, d));   // ...that the erase cannot clear
  const res = await r.recheck('w1');
  assert.equal(res.kind, 'HELD');
  assert.equal(res.why, 'erase:ERASE_NOT_VERIFIED');
  assert.equal(r.owner.inhibition('p1').at, at0, 'A RE-HOLD AFTER A FAILED ERASE KEEPS ITS CLOCK (the notice is not delayed)');
};
test('Jim T2: a re-hold after a failed erase keeps the original hold time', () => K.reholdKeepsClock());

test('fix 1: anything else stays held - a person\'s text, an unknown screen, a changing screen, no reading', async () => {
  for (const [name, set, why] of [
    ['someone else\'s text on the prompt', (r) => { r.cursorRow = '\u203a please look at this'; }, /^UNKNOWN:/],
    ['a frame mid-redraw', (r) => { r.blank = true; }, /^UNKNOWN:/],
    ['output between the two readings', (r) => { r.afterRead = () => { r.gen += 1; }; }, /^screen-changed$/],
    ['no guard reading', (r) => { r.noReading = true; }, /^no-reading$/],
    ['no needle reading', (r) => { r.noNeedle = true; }, /^no-reading$/]
  ]) {
    const { r } = await heldLikeDwight();
    set(r);
    const res = await r.recheck('w1');
    assert.equal(res.kind, 'HELD', `${name}: stays held`);
    assert.match(res.why, why, `${name}: ${res.why}`);
    assert.ok(r.owner.inhibition('p1'), `${name}: still inhibited`);
    assert.equal(r.writes.filter((w) => w === '\x15' || w === '\r').length, 0, `${name}: nothing typed`);
  }
});

test('fix 1: only an automatic wake on a screen-guarded PTY is looked at; a respawn or another id is NONE', async () => {
  const person = await heldLikeDwight();
  // A person's "send now" hold is theirs to rule.
  const p2 = rig();
  assert.deepEqual(await p2.submit('latch'), COMMITTED);
  p2.drain(); p2.prompt = ''; endOfTurn(p2);
  const held = await p2.submit('u1', 'USER_RELEASED');
  assert.equal(held.kind, 'INTERFERED');
  assert.deepEqual(await p2.recheck('u1'), { kind: 'HELD', why: 'not-automatic', screen: null });
  assert.deepEqual(await person.r.recheck('other'), { kind: 'NONE' }, 'another request id');
  person.r.incarnation = 2;
  assert.deepEqual(await person.r.recheck('w1'), { kind: 'NONE' }, 'a respawn retired the hold');
});

// ─── Fix 1 + 2: the watch ───────────────────────────────────────────────────────────────

function watchRig(W = HELD, over = {}) {
  const w = { now: 0, holds: [], rechecks: [], released: [], raised: [], cleared: [], logs: [], answer: { kind: 'HELD', why: 'UNKNOWN:x', screen: null }, ...over };
  w.watch = new W.HeldInterferenceWatch({
    heldWakes: () => w.holds,
    recheck: (h) => { w.rechecks.push([w.now, h.requestId]); return Promise.resolve(w.answer); },
    released: (h, r) => w.released.push([h.agentId, r.kind]),
    notice: { raise: (h) => w.raised.push([w.now, h.agentId, h.requestId]), clear: (a) => w.cleared.push([w.now, a]) },
    log: (row) => w.logs.push(row),
    now: () => w.now
  });
  w.tick = async (t) => { w.now = t; w.watch.tick(t); await new Promise((res) => setImmediate(res)); };
  return w;
}
const HOLD = { agentId: 'dwight', requestId: 'w1', ptyId: 'p1', messages: 2, since: 0, reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE' };

K.recheckAboutOnceAMinute = async (W = HELD) => {
  const w = watchRig(W);
  w.holds = [HOLD];
  for (let t = 0; t <= 180_000; t += 15_000) await w.tick(t);
  assert.deepEqual(w.rechecks.map((x) => x[0]), [60_000, 120_000, 180_000], 'A HELD WAKE IS LOOKED AT ABOUT ONCE A MINUTE');
  assert.equal(w.logs.filter((l) => l.kind === 'held-interfered-recheck').length, 1, 'one row per change of reason, not one a minute');
};
test('fix 1: the watch looks at a held wake about once a minute', () => K.recheckAboutOnceAMinute());

K.noticeAfterFiveMinutes = async (W = HELD) => {
  const w = watchRig(W);
  w.holds = [HOLD];
  for (let t = 0; t < 300_000; t += 15_000) await w.tick(t);
  assert.equal(w.raised.length, 0, 'not before 5 minutes');
  for (let t = 300_000; t <= 600_000; t += 15_000) await w.tick(t);
  assert.deepEqual(w.raised, [[300_000, 'dwight', 'w1']], 'THE HUMAN IS TOLD AFTER 5 MINUTES, once per hold');
  assert.deepEqual(w.watch.noticed().map((h) => h.requestId), ['w1'], 'and the digest is given it');
};
test('fix 2: after 5 minutes held, the Human is told (once per hold)', () => K.noticeAfterFiveMinutes());

K.noticeLiftsWhenHoldEnds = async (W = HELD) => {
  const w = watchRig(W);
  w.holds = [HOLD];
  await w.tick(300_000);
  assert.equal(w.raised.length, 1);
  w.holds = [];                                      // a person ruled, a respawn, or the ids left
  await w.tick(315_000);
  assert.deepEqual(w.cleared, [[315_000, 'dwight']], 'THE NOTICE LIFTS WHEN THE HOLD ENDS');
  assert.deepEqual(w.watch.noticed(), []);
  w.holds = [{ ...HOLD, requestId: 'w2', since: 400_000 }];
  await w.tick(700_000);
  assert.deepEqual(w.raised.at(-1), [700_000, 'dwight', 'w2'], 'a new hold is told again');
};
test('fix 2: the notice lifts when the hold ends any other way, and a new hold is told again', () => K.noticeLiftsWhenHoldEnds());

test('fix 1 + 2: a release by the look resolves the hold and lifts the notice', async () => {
  const w = watchRig();
  w.holds = [HOLD];
  await w.tick(300_000);
  w.answer = { kind: 'RELEASED', screen: { cursorRow: '\u203a x', footer: [] } };
  await w.tick(315_000);
  assert.deepEqual(w.released, [], 'the next look is a minute after the last');
  await w.tick(360_000);
  assert.deepEqual(w.released, [['dwight', 'RELEASED']], 'released: the caller resolves it as "let it retry"');
  assert.deepEqual(w.cleared, [[360_000, 'dwight']], 'and the notice goes at once');
});

// ─── Fix 2: what the Human and god are told ─────────────────────────────────────────────

test('fix 2: the notice is Jim\'s plain wording, and a person may dismiss it', () => {
  const { heldInterferedNoticeText } = loadTs('src/main/mailLedger.ts');
  const at = new Date(2026, 9, 1, 20, 28, 7).getTime();
  const t = heldInterferedNoticeText('Dwight', 2, at, '[hive] check inbox', 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE');
  assert.equal(t.title, "Dwight hasn't received 2 messages.");
  assert.match(t.notice, /^An automatic message to Dwight was interrupted at 20:28\./);
  assert.match(t.notice, /Look at Dwight's chat box: if it shows "\[hive\] check inbox", press Enter; if it is empty, press "let it retry" in Dwight's message box\./);
  assert.match(t.details, /STAGED_TEXT_NOT_POSITIVELY_VISIBLE/);
  assert.equal(heldInterferedNoticeText('Dwight', 1, at, 'x', 'r').title, "Dwight hasn't received 1 message.");
  assert.equal(BANNER.isDismissible({ file: 'state/mail/dwight.json', quarantine: null, error: 'held-interfered', ...t, raisedAt: at }), true, 'a notice: dismissible');
});

K.digestListsHeldWake = (D = DIGEST) => {
  const items = D.decisionItems([], [], 600_000, [{ agentId: 'dwight', name: 'Dwight', messages: 2, since: 0 }]);
  assert.equal(items.length, 1, 'A HELD WAKE IS A DECISION FOR GOD');
  assert.equal(items[0].id, 'held-interfered:dwight:0', 'one item per hold');
  assert.match(items[0].line, /^Dwight: 2 message\(s\) held for .* after an interrupted automatic message/);
  const { markdown } = D.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now: 600_000, heldWakes: [{ agentId: 'dwight', messages: 2, since: 0 }] });
  assert.match(markdown, /## Decisions needed\n\n- \[held-interfered:dwight:0\] dwight: 2 message/);
};
test('fix 2: the floor digest lists a held wake as a decision for god', () => K.digestListsHeldWake());

// ─── Wiring ─────────────────────────────────────────────────────────────────────────────

test('wiring: main runs the watch, resolves a release as "let it retry", and words the notice', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /heldInterferenceTimer = setInterval\(\(\) => \{ try \{ heldInterference\?\.tick\(Date\.now\(\)\); \}/, 'the watch ticks');
  assert.match(idx, /return ptyId && inh && inh\.requestId === claim\.requestId/, 'only a held WAKE claim whose owner hold is that request');
  assert.match(idx, /recheck: \(h\) => automaticSubmit\.recheckHeld\(h\.ptyId, h\.requestId\),/);
  assert.match(idx, /kind: 'interference-self-released'/);
  assert.match(idx, /inboxWake\?\.onInterferenceResolved\(h\.agentId, 'SEND_AGAIN'\);/, 'the same ruling as a person\'s "let it retry"');
  assert.match(idx, /raise: \(h, now, asking\) => hive\.mail\.noteHeldInterferedAlert\(/);
  assert.match(idx, /requestId: h\.requestId, asking,/, '1.1.79 P2: the popup the latest look saw reaches the notice');
  assert.match(idx, /clear: \(agentId\) => hive\.mail\.clearHeldInterferedAlert\(agentId\)/);
  assert.match(idx, /heldWakes: \(\) => \(heldInterference\?\.noticed\(\) \?\? \[\]\)/, 'the digest gets the told holds');
  assert.match(idx, /kind: 'wake-interfered'/, 'fix 4: the hold row');
  assert.match(idx, /\.\.\.\(r\.screen \? \{ screen: r\.screen \} : \{\}\)/, 'fix 4: the COMMIT refusal row');
  const wiring = readSource('src/main/automaticSubmitWiring.ts');
  assert.match(wiring, /return provider \? automaticStageQuietMs\(provider\) : null;/, 'fix 3: the owner is given the provider\'s quiet window');
  assert.match(wiring, /onInterfered: w\.onInterfered,/);
  const wake = readSource('src/main/workerWake.ts');
  assert.match(wake, /heldClaims\(\): Array<\{ agentId: string; claim: WakeClaim \}>/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

const MUTANT_DIR = path.join(__dirname, '.mutants-held178');
function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  // A copy in MUTANT_DIR resolves its relative imports back to the real files.
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, m) => `from '${path.relative(MUTANT_DIR, path.join(ROOT, path.dirname(rel), m)).replace(/\\/g, '/')}'`);
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const MUTANTS = [
  { name: 'fix 1: the look never releases (the 1.1.77 dead end)', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [["    this.inhibited.delete(ptyId);\n    if (held.decision) deps.capacity.cancelGrant(held.decision);\n    this.releaseHeldId(held);\n    return { kind: 'RELEASED', screen };", "    return stay('mutant', screen);"]],
    killer: 'selfReleaseOnCleanScreen', dies: /A CLEAN SCREEN RELEASES THE HELD WAKE/ },
  { name: 'fix 1 unsound: our text on screen does not keep it held', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [["    if (seen.screenCount > 0) return stay('own-text-on-screen', screen);\n", '']],
    killer: 'ownTextOnScreenStaysHeld', dies: /OUR TEXT ON SCREEN KEEPS IT HELD/ },
  { name: 'fix 1 unsound: a person\'s key since the hold is ignored', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [
      ["    if (deps.humanGeneration(ptyId) !== held.humanStage) return stay('human-input-since-hold');\n    const needle", '    const needle'],
      ["    if (deps.humanGeneration(ptyId) !== held.humanStage) return stay('human-input-since-hold');\n    if (!g ||", '    if (!g ||']
    ],
    killer: 'personTouchedStaysHeld', dies: /A PERSON'S KEY SINCE THE HOLD KEEPS IT HELD/ },
  { name: 'fix 1: our text on the prompt row is never erased', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [['    if (seen.onPromptRow && seen.screenCount >= 1) {', '    if (false) {']],
    killer: 'ownTextOnPromptErased', dies: /OUR TEXT ON THE PROMPT ROW IS ERASED/ },
  { name: 'fix 1: the watch looks on every tick', file: 'src/main/heldInterference.ts', real: HELD,
    edits: [['      if (this.inFlight.has(key) || now - (this.lastCheck.get(key) ?? h.since) < this.recheckMs) continue;', '      if (this.inFlight.has(key)) continue;']],
    killer: 'recheckAboutOnceAMinute', dies: /A HELD WAKE IS LOOKED AT ABOUT ONCE A MINUTE/ },
  { name: 'fix 2: the Human is never told', file: 'src/main/heldInterference.ts', real: HELD,
    edits: [['      if (now - h.since >= this.noticeAfterMs && this.raised.get(h.agentId) !== h.requestId) {', '      if (false) {']],
    killer: 'noticeAfterFiveMinutes', dies: /THE HUMAN IS TOLD AFTER 5 MINUTES/ },
  { name: 'fix 2: the notice outlives a hold that ended another way', file: 'src/main/heldInterference.ts', real: HELD,
    edits: [["      if (!keys.has(`${agentId}|${requestId}`)) this.lift(agentId);", '      void agentId; void requestId;']],
    killer: 'noticeLiftsWhenHoldEnds', dies: /THE NOTICE LIFTS WHEN THE HOLD ENDS/ },
  { name: 'fix 2: the digest leaves held wakes out', file: 'src/main/floorDigest.ts', real: DIGEST,
    edits: [['  const items = decisionItems(input.flags, input.ledgerIssues, now, input.heldWakes ?? []);', '  const items = decisionItems(input.flags, input.ledgerIssues, now);'],
      ['  for (const h of heldWakes) {', '  for (const h of heldWakes.slice(0, 0)) {']],
    killer: 'digestListsHeldWake', dies: /A HELD WAKE IS A DECISION FOR GOD/ },
  { name: 'fix 3: no quiet window (the 20:27:41 race)', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [['      if (quietMs > 0 && !(await this.outputQuiet(ptyId, quietMs))) return', '      if (quietMs < 0) return']],
    killer: 'raceClosedByQuiet', dies: /THE WAKE IS STAGED ONLY AFTER THE OUTPUT IS QUIET/ },
  { name: 'fix 3: quiet counted from the start, whatever the output', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [['      if (gen !== last) { last = gen; quietSince = deps.now(); }', '      void gen;']],
    killer: 'raceClosedByQuiet', dies: /THE WAKE IS STAGED ONLY AFTER THE OUTPUT IS QUIET/ },
  { name: 'fix 3: Codex gets no quiet window', file: 'src/shared/providerAutomation.ts', real: PROVIDER,
    edits: [["  return provider === 'codex' ? CODEX_STAGE_QUIET_MS : null;", '  return null;']],
    killer: 'codexQuietWindow', dies: /CODEX IS STAGED AFTER 750 MS OF QUIET/ },
  { name: 'Jim S1: the quiet window holds every admission class', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [["      const quietMs = cls === 'CAPACITY_GATED' ? deps.stageQuietMs?.(ptyId) ?? 0 : 0;", '      const quietMs = deps.stageQuietMs?.(ptyId) ?? 0;']],
    killer: 'personSendNowNotDelayed', dies: /A PERSON'S SEND-NOW IS NOT HELD FOR QUIET/ },
  { name: 'Jim T1 (H5): release without the latch', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [['    if (this.postHandoff.get(ptyId) !== held.incarnation || (!past.open', '    if ((!past.open']],
    killer: 'noReleaseWithoutLatch', dies: /NO RELEASE WITHOUT THE LATCH/ },
  { name: 'Jim T2 (H11): a re-hold restarts its clock', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [['        if (again) again.at = held.at;                 // still the same hold, for its notice\n', '']],
    killer: 'reholdKeepsClock', dies: /A RE-HOLD AFTER A FAILED ERASE KEEPS ITS CLOCK/ },
  { name: 'fix 4: a COMMIT refusal logs no screen facts', file: 'src/main/automaticSubmit.ts', real: OWNER,
    edits: [["        ...(phase === 'COMMIT' && !verdict.ok && r ? { screen: screenFacts(r.facts) } : {}),\n", '']],
    killer: 'commitRefusalLogsScreen', dies: /A COMMIT REFUSAL LOGS WHAT THE READING SAW/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async () => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        await K[m.killer](m.real);                    // the killer PASSES on the real module...
        let died = null;
        try { await K[m.killer](mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
