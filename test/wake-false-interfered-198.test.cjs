'use strict';
require('./tools/own-job.cjs');

/**
 * WAKE-FALSE-INTERFERED-RESTART (1.1.98, Human 2026-10-22).
 *
 * Creed, 2026-10-22: app-start 12:18:09Z; 12:18:50.4Z the term-path wake was typed; 170 ms later
 * the confirm step read the mirror, which showed the text NOWHERE (unpainted after the restart:
 * screen null, no sample yet), and judged it NOT_IN_COMPOSER -> WAKE_TYPED_NOT_SENT -> the owner's
 * latch. 12:20:10Z the same id was surfaced and acted (UserPromptSubmit), Creed replied, Stop:
 * the latch stayed set (every later wake refused 'owner-inhibited', god's 14:55Z request and the
 * 15:24:40Z requiresReply request among them), because a WAKE_TYPED_NOT_SENT hold was never
 * looked at: recheckHeld returned 'typed-not-sent' before any evidence.
 *
 *   fix 1  wakeSender.confirmTyped: a reading that shows our text nowhere is UNKNOWN, re-read
 *          every WAKE_TYPED_CONFIRM_STEP_MS for WAKE_TYPED_CONFIRM_MS; still unknown = the owner's
 *          (our text as prior text, the boot rule), never INTERFERED. INTERFERED needs a reading
 *          that shows our text OFF the prompt row (screenCount >= 1), or a person's key.
 *   fix 2  automaticSubmit.recheckHeld on a WAKE_TYPED_NOT_SENT hold: the wake's own ids surfaced
 *          or acted since the hold (wakeSurfacedSince) end it SUBMITTED 'surfaced'; a turn ended
 *          since the hold (turnEndedSince) lets the plain screen look run: an empty composer
 *          RELEASES it, our text still on the prompt keeps it (never erased). The watch is poked
 *          by UserPromptSubmit/Stop so the look happens on the next tick.
 *   note   the 15:24:40Z delivery had no wake row: wakeRowPolicy folded its 'owner-inhibited'
 *          no-claim (already logged at 14:55Z, no claim since). A delivery's refusal now always logs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const electron = require.resolve('electron');
if (!require.cache[electron]) require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const WS = loadTs('src/main/wakeSender.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const HELD = loadTs('src/main/heldInterference.ts');
const POLICY = loadTs('src/main/wakeRowPolicy.ts');
const SHARED = loadTs('src/shared/codexScreen.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const { inboxWakeTextForProvider } = loadTs('src/shared/hiveNudge.ts');

const ID_A = '2026-10-22T10-00-04-430Z-d61f1d';
const ID_B = '2026-10-22T14-55-01-654Z-20f53f';
const nudge = (ids) => inboxWakeTextForProvider('claude', ids);
const reqFor = (ids, over = {}) => ({ requestId: `inbox-wake:creed:${ids.join('+')}:1`, agentId: 'creed', admissionClass: 'CAPACITY_GATED', text: nudge(ids), ...over });
const IDLE = { lifecycle: 'idle', activeSince: 0, turnStartAt: 10, lastTurnEndAt: 20 };

// ─── fix 1: the WakeSender on a mirror that paints late ─────────────────────────────────

/** The term path's fakes (gtc-m4-wake-197's), with a mirror whose paint is under the test's
 *  control: `w.paintAfter` readings return the text nowhere (screenCount 0); from then on the
 *  composer is read for real. `w.offPrompt` paints our text above the prompt row instead. */
function sender(M, over = {}) {
  const w = {
    now: 1_000_000, gen: 0, prompt: '', transcript: '', readings: 0, paintAfter: Infinity, offPrompt: false, noCount: false,
    nullReading: false, keyAtReading: null, writes: [], entered: 0, owner: [], grants: [], grantSeq: 0, holds: [], rows: [], ...over
  };
  const d = {
    ptyOf: () => 'pty-creed', providerOf: () => 'claude', idleFacts: () => ({ ...IDLE }), spawnedAt: () => 1,
    promptBlock: () => undefined, lastHumanInputAt: () => undefined, humanGeneration: () => w.gen, inhibited: () => false,
    mirrorNeedle: async (_p, needle) => {
      w.readings += 1;
      if (w.keyAtReading === w.readings) w.gen += 1;
      if (w.nullReading && w.readings > 1) return { reading: null }; // null AFTER the pre-type probe (a null probe is the owner's before any write)
      if (w.readings <= w.paintAfter) return { reading: w.noCount ? { onPromptRow: false } : { onPromptRow: false, screenCount: 0 } };
      const onPromptRow = w.prompt.includes(needle);
      const screenCount = (onPromptRow ? 1 : 0) + (w.transcript.includes(needle) ? 1 : 0);
      return { reading: { onPromptRow, screenCount } };
    },
    exclusive: async (_p, fn) => ({ ran: true, value: await fn() }),
    slot: (_a, fn) => fn(),
    settle: async () => {},
    write: (_p, data) => {
      w.writes.push(data);
      if (data === '\r') { w.prompt = ''; w.entered += 1; } else if (w.offPrompt) w.transcript += data; else w.prompt += data;
      return { ok: true };
    },
    ownerSubmit: async (r) => { w.owner.push(r); return { kind: 'COMMITTED' }; },
    admit: () => ({ proceed: true, basis: 'FRESH_HEALTHY', decision: { grant: (w.grantSeq += 1) } }),
    confirmLaunch: (dec) => w.grants.push(['confirm', dec.grant]),
    cancelGrant: (dec) => w.grants.push(['cancel', dec.grant]),
    holdTyped: (ptyId, r, reason, detail) => w.holds.push({ ptyId, requestId: r.requestId, reason, detail }),
    claimAtStop: () => null, settleAtStop: () => {},
    log: (row) => w.rows.push(row),
    now: () => w.now,
    sleep: async (ms) => { w.now += ms; },
    setTimer: () => 0
  };
  w.ws = new M.WakeSender(d, { codexFacts: async () => ({ reading: null, reason: 'mirror-off' }) }, () => ({ path: 'term', stopContinue: { claude: true } }));
  return w;
}

const K = {};

K.restartReplay = async (M = WS) => {
  const w = sender(M);                                    // the mirror never paints during the look
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.notEqual(o.kind, 'INTERFERED', `NO INTERFERED AFTER A RESTART: the text seen nowhere is unknown, not typed over (got ${JSON.stringify(o)})`);
  assert.deepEqual(w.holds, [], 'NO INTERFERED AFTER A RESTART: nothing is held for a person');
  assert.ok(w.readings >= 2, `RE-CONFIRMED: the mirror was read again (${w.readings} readings)`);
  assert.ok(w.now - 1_000_000 >= M.WAKE_TYPED_CONFIRM_MS, 'the look lasted the whole confirm window');
  assert.equal(w.entered, 0, 'no Enter on text no reading could place');
  assert.equal(w.owner.length, 1, 'HANDED TO THE OWNER: its screen gate and erase oracle take over');
  assert.equal(w.owner[0].priorText, nudge([ID_A]), 'our typed text is named as prior text, so it is never typed a second time');
  assert.deepEqual(w.grants, [['cancel', 1]], 'the sender\'s grant is handed back before the owner admits its own');
  const row = w.rows.find((r) => r.kind === 'wake-send');
  assert.deepEqual([row.path, row.why, row.outcome], ['owner', 'wake-unconfirmed', 'COMMITTED'], 'the row says why');
  const again = await w.ws.submit(reqFor([ID_A]));
  assert.equal(again.kind, 'COMMITTED');
  assert.equal(w.writes.length, 1, 'a retry of the same id is the owner\'s: not typed here again');
};
test('fix 1 REPLAY 12:18:50Z: a wake typed onto a mirror that shows it nowhere is re-confirmed, then handed to the owner: never INTERFERED', () => K.restartReplay());

K.paintsLate = async (M = WS) => {
  const w = sender(M, { paintAfter: 3 });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.deepEqual([o.kind, o.via], ['COMMITTED', 'term'], `A LATE PAINT CONFIRMS: ENTER (got ${JSON.stringify(o)})`);
  assert.equal(w.entered, 1, 'A LATE PAINT CONFIRMS: ENTER once');
  assert.ok(w.readings > 3 && w.now - 1_000_000 < M.WAKE_TYPED_CONFIRM_MS, `a later reading showed the text on the prompt row before the window closed (${w.readings} readings)`);
  assert.deepEqual(w.holds, []);
  assert.equal(w.owner.length, 0, 'not the owner\'s');
  assert.deepEqual(w.grants, [['confirm', 1]]);
};
test('fix 1: a mirror that paints during the confirm window gets its Enter (re-confirm, not a one-shot read)', () => K.paintsLate());

K.offPromptStillHeld = async (M = WS) => {
  const w = sender(M, { paintAfter: 0, offPrompt: true });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.equal(o.kind, 'INTERFERED', 'OUR TEXT SEEN OFF THE PROMPT ROW: HELD, as 1.1.97');
  assert.equal(o.detail, 'NOT_IN_COMPOSER');
  assert.deepEqual(w.holds.map((h) => [h.reason, h.detail]), [['WAKE_TYPED_NOT_SENT', 'NOT_IN_COMPOSER']]);
  assert.ok(w.now - 1_000_000 < M.WAKE_TYPED_CONFIRM_STEP_MS, 'one real reading is evidence enough: no confirm step waited');
  assert.equal(w.owner.length, 0);
};
test('fix 1: a REAL reading that shows our text off the prompt row still holds NOT_IN_COMPOSER (nothing weakened)', () => K.offPromptStillHeld());

K.humanKeyWhileLooking = async (M = WS) => {
  const w = sender(M, { keyAtReading: 2 });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.deepEqual([o.kind, o.detail], ['INTERFERED', 'HUMAN_TYPED'], `A PERSON'S KEY DURING THE LOOK: HUMAN_TYPED, held (got ${JSON.stringify(o)})`);
  assert.equal(w.owner.length, 0, 'never handed to the owner over a person\'s key');
  assert.equal(w.entered, 0);
};
test('fix 1: a person\'s key while the sender is still looking holds HUMAN_TYPED (the human generation is re-read each step)', () => K.humanKeyWhileLooking());

/** Jim's WFI audit MAJOR 1 (his wfir-probe shapes): the mirror is blank for two readings, then paints
 *  our text on the prompt row. A person's key that lands at reading 2 (still blank) or at reading 3
 *  (the reading that shows our text) must give HUMAN_TYPED: Enter is never pressed on a person's key. */
K.humanKeyBeforePaint = async (M = WS) => {
  for (const [label, keyAtReading] of [['before the paint (reading 2)', 2], ['at the painted reading (reading 3)', 3]]) {
    const w = sender(M, { paintAfter: 2, keyAtReading });
    const o = await w.ws.submit(reqFor([ID_A]));
    assert.equal(w.entered, 0, `A PERSON'S KEY ${label.toUpperCase()} WINS OVER A LATER ON_PROMPT READING: no Enter (got ${JSON.stringify(o)})`);
    assert.deepEqual([o.kind, o.detail], ['INTERFERED', 'HUMAN_TYPED'], `held HUMAN_TYPED, key ${label}`);
    assert.equal(w.owner.length, 0, `never handed to the owner over a person's key (${label})`);
    assert.deepEqual(w.grants, [['cancel', 1]], `the grant is cancelled (${label})`);
  }
};
test('fix 1 (Jim MAJOR 1): a person\'s key during the blank window beats a later on-prompt reading: HUMAN_TYPED, no Enter', () => K.humanKeyBeforePaint());

/** An older mirror whose reading is null on EVERY needle after the write (the pre-type probe read it; a
 *  null probe is the owner's before anything is typed): 1.1.97 held it as TYPED_NOT_SENT ("not in the
 *  composer"); now it is UNKNOWN for the confirm window and then the owner's (wake-unconfirmed). */
K.nullReadingIsUnknown = async (M = WS) => {
  const w = sender(M, { nullReading: true });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.equal(o.kind, 'COMMITTED', `A NULL READING IS UNKNOWN, THEN THE OWNER'S (got ${JSON.stringify(o)})`);
  assert.equal(w.owner.length, 1, `A NULL READING IS UNKNOWN, THEN THE OWNER'S: handed to the owner (got ${JSON.stringify(o)})`);
  assert.deepEqual(w.holds, [], 'nothing is held on a reading that shows nothing');
  assert.ok(w.now - 1_000_000 >= M.WAKE_TYPED_CONFIRM_MS, 'the whole confirm window was spent first');
  assert.equal(w.entered, 0);
  assert.equal(w.rows.find((r) => r.kind === 'wake-send').why, 'wake-unconfirmed');
};
test('fix 1: a null reading on every needle (older mirror) is UNKNOWN, then the owner\'s: not TYPED_NOT_SENT as in 1.1.97', () => K.nullReadingIsUnknown());

K.olderMirrorNoCount = async (M = WS) => {
  const w = sender(M, { noCount: true });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.equal(o.kind, 'INTERFERED', 'a reading without screenCount is judged as before');
  assert.equal(o.detail, 'NOT_IN_COMPOSER');
  assert.ok(w.now - 1_000_000 < M.WAKE_TYPED_CONFIRM_STEP_MS, 'no confirm step waited');
};
test('fix 1: a reading without screenCount (no count = seen) is exactly the 1.1.97 path', () => K.olderMirrorNoCount());

// ─── fix 2: the owner's held typed wake and its proofs of delivery ───────────────────────

function owner(M, over = {}) {
  const o = { gen: 3, writes: [], seen: [], surfaced: new Map(), asked: [], turnEnd: 0, now: 5, ...over };
  o.owner = new M.AutomaticSubmitOwner({
    resolvePty: () => 'pty-creed', incarnation: () => 1, humanGeneration: () => o.gen,
    write: (_p, d) => { o.writes.push(d); return { ok: true }; }, terminalReady: () => 'READY', eligibility: () => ({ eligible: true }),
    promptBlock: () => null, lastHumanInputAt: () => undefined, abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 }),
    readScreen: async () => ({ onPromptRow: true, screenCount: 1 }),
    capacity: { admit: () => ({ verdict: 'ALLOW', reason: 'FRESH_HEALTHY' }), revalidate: () => ({ verdict: 'ALLOW' }), confirmLaunch: () => {}, cancelGrant: () => {}, holdGrant: () => {} },
    now: () => o.now, setTimer: () => 0,
    wakeSurfacedSince: (agentId, ids, since) => { o.asked.push({ agentId, ids: [...ids], since }); return ids.every((id) => (o.surfaced.get(id) ?? -1) >= since); },
    turnEndedSince: (_a, since) => o.turnEnd > 0 && o.turnEnd >= since,
    ...(over.deps ?? {})
  });
  o.owner.deps.onInterfered = (r) => o.seen.push(['interfered', r.reason, r.detail]);
  o.owner.deps.onOutcome = (r) => o.seen.push(['outcome', r.outcome.kind, r.requestId]);
  o.hold = (ids = [ID_A]) => { const req = reqFor(ids); o.owner.holdTyped('pty-creed', req, 'WAKE_TYPED_NOT_SENT', 'NOT_IN_COMPOSER'); return req; };
  return o;
}

K.surfacedClears = async (M = OWNER) => {
  const o = owner(M);
  const req = o.hold([ID_A]);
  assert.equal(o.owner.inhibition('pty-creed').reason, 'WAKE_TYPED_NOT_SENT');
  o.now = 100;                                            // 12:20:10Z: the id is surfaced by a hook
  o.surfaced.set(ID_A, 100);
  const r = await o.owner.recheckHeld('pty-creed', req.requestId);
  assert.deepEqual([r.kind, r.how], ['SUBMITTED', 'surfaced'], `SURFACED IDS END THE HOLD AS DELIVERED (got ${JSON.stringify(r)})`);
  assert.equal(o.owner.inhibition('pty-creed'), null, 'SURFACED IDS END THE HOLD: the PTY is no longer inhibited');
  assert.deepEqual(o.asked, [{ agentId: 'creed', ids: [ID_A], since: 5 }], 'asked for the wake\'s own ids, since the hold');
  assert.ok(o.seen.some((s) => s[0] === 'outcome' && s[1] === 'HUMAN_HANDLED' && s[2] === req.requestId), 'the request answers HUMAN_HANDLED from now on (a copy is never typed)');
  assert.deepEqual(o.writes, [], 'nothing written: no erase, no Enter');
  assert.deepEqual(await o.owner.recheckHeld('pty-creed', req.requestId), { kind: 'NONE' }, 'a second look finds no hold');
};
test('fix 2 REPLAY 12:20:10Z: a held typed wake whose ids a hook surfaced since the hold ends SUBMITTED (surfaced); the latch is gone', () => K.surfacedClears());

K.noProofStays = async (M = OWNER) => {
  const o = owner(M);
  const req = o.hold([ID_A]);
  o.surfaced.set(ID_A, 1);                                // surfaced BEFORE the hold: not this wake's delivery
  o.now = 100;
  const r = await o.owner.recheckHeld('pty-creed', req.requestId);
  assert.deepEqual(r, { kind: 'HELD', why: 'typed-not-sent', screen: null }, `NO PROOF: HELD AS BEFORE (got ${JSON.stringify(r)})`);
  assert.ok(o.owner.inhibition('pty-creed'), 'still inhibited');
  assert.deepEqual(o.writes, [], 'never erased or re-Entered (Jim Q4)');
};
test('fix 2: no proof (ids surfaced only before the hold, no turn ended) keeps the hold exactly as GTC M4 did', () => K.noProofStays());

K.partialSurfaceStays = async (M = OWNER) => {
  const o = owner(M);
  const req = o.hold([ID_A, ID_B]);
  o.now = 100; o.surfaced.set(ID_A, 100);                 // one of two
  const r = await o.owner.recheckHeld('pty-creed', req.requestId);
  assert.equal(r.kind, 'HELD', 'EVERY id of the wake must have surfaced');
  assert.deepEqual(o.asked[0].ids, [ID_A, ID_B]);
  o.surfaced.set(ID_B, 101);
  assert.equal((await o.owner.recheckHeld('pty-creed', req.requestId)).kind, 'SUBMITTED');
};
test('fix 2: a wake for two ids needs both surfaced', () => K.partialSurfaceStays());

K.proofThrowsStays = async (M = OWNER) => {
  const o = owner(M, { deps: { wakeSurfacedSince: () => { throw new Error('ledger gone'); }, turnEndedSince: () => { throw new Error('no facts'); } } });
  const req = o.hold([ID_A]);
  const r = await o.owner.recheckHeld('pty-creed', req.requestId);
  assert.deepEqual([r.kind, r.why], ['HELD', 'typed-not-sent'], 'a throwing proof is no proof (fail closed)');
};
test('fix 2: a proof that throws is no proof', () => K.proofThrowsStays());

// The Stop proof on a real post-handoff Codex screen (held-interfered-178's terminal): an empty
// composer releases; our text still on the prompt keeps it, unerased.
const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const READY_SCREEN = (() => { const fx = JSON.parse(fs.readFileSync(path.join(FX, '2-trusted-handoff-120x40.json'), 'utf8')); return SHARED.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow); })();
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };
const CWD = 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b';

function codexRig(M, over = {}) {
  const r = { now: 1_000_000, seq: 0, timers: [], writes: [], incarnation: 1, gen: 10, human: 0, prompt: '', transcript: 0, turnEnd: 0, surfaced: false, ...over };
  r.facts = () => (r.prompt ? { ...READY_SCREEN, cursorRow: `\u203a ${r.prompt}` } : READY_SCREEN);
  const onPrompt = (n) => r.prompt.includes(n);
  r.deps = {
    resolvePty: () => 'p1', incarnation: () => r.incarnation, humanGeneration: () => r.human,
    write: (_id, d) => { r.writes.push(d); if (d === '\r') { r.prompt = ''; } else if (d === '\x15') r.prompt = ''; else r.prompt += d; r.gen += 1; return { ok: true }; },
    terminalReady: () => 'READY', eligibility: () => ({ eligible: true }), promptBlock: () => null, lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: (_id, n) => Promise.resolve({ onPromptRow: onPrompt(n), screenCount: (onPrompt(n) ? 1 : 0) + r.transcript }),
    capacity: { admit: () => ALLOW, revalidate: () => ALLOW, confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => r.now,
    setTimer: (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; },
    screenGuard: () => 'ENFORCE',
    readGuardScreen: (_id, tail) => Promise.resolve({ facts: r.facts(), incarnation: r.incarnation, outputGeneration: r.gen, ...(tail === undefined ? {} : { promptTailMatches: r.prompt.endsWith(tail) }) }),
    outputGeneration: () => r.gen, spawnCwd: () => CWD,
    wakeSurfacedSince: () => r.surfaced,
    turnEndedSince: (_a, since) => r.turnEnd > 0 && r.turnEnd >= since
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
  r.drain = () => { while (r.timers.length) { r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq); const next = r.timers.shift(); r.now = Math.max(r.now, next.at); next.fn(); } };
  return r;
}

/** A Codex terminal past its handoff (one wake COMMITTED latches it), then the typed-wake hold. */
async function heldOnCodex(M, over = {}) {
  const r = codexRig(M, over);
  const latch = await r.settle(r.owner.submit({ requestId: 'latch', agentId: 'creed', admissionClass: 'CAPACITY_GATED', text: '[hive] check inbox' }));
  assert.equal(latch.kind, 'COMMITTED', 'the terminal is past its handoff');
  r.drain();
  r.prompt = ''; r.transcript = 0; r.writes.length = 0;
  const req = reqFor([ID_A]);
  r.owner.holdTyped('p1', req, 'WAKE_TYPED_NOT_SENT', 'NOT_IN_COMPOSER');
  r.prompt = req.text;                                    // the typed text sits on the prompt
  r.heldAt = r.now;
  return { r, req };
}

K.stopEmptyReleases = async (M = OWNER) => {
  const { r, req } = await heldOnCodex(M);
  assert.deepEqual((await r.settle(r.owner.recheckHeld('p1', req.requestId))).why, 'typed-not-sent', 'before any turn: held');
  r.prompt = '';                                          // the agent ran a turn: Stop, empty composer
  r.now += 5_000; r.turnEnd = r.now;
  const res = await r.settle(r.owner.recheckHeld('p1', req.requestId));
  assert.equal(res.kind, 'RELEASED', `A STOP WITH AN EMPTY COMPOSER RELEASES THE HOLD (got ${JSON.stringify(res)})`);
  assert.equal(r.owner.inhibition('p1'), null, 'A STOP WITH AN EMPTY COMPOSER RELEASES THE HOLD: not inhibited');
  assert.deepEqual(r.writes, [], 'nothing written');
};
test('fix 2 REPLAY 12:38Z: after a turn ended, an empty composer releases the typed-wake hold (let it retry)', () => K.stopEmptyReleases());

K.stopOnPromptStays = async (M = OWNER) => {
  const { r, req } = await heldOnCodex(M);
  r.now += 5_000; r.turnEnd = r.now;                      // a turn ended, but our text is still on the prompt
  const res = await r.settle(r.owner.recheckHeld('p1', req.requestId));
  assert.deepEqual([res.kind, res.why], ['HELD', 'typed-not-sent:on-prompt'], `OUR TEXT STILL ON THE PROMPT AFTER A TURN: HELD, NOT ERASED (got ${JSON.stringify(res)})`);
  assert.deepEqual(r.writes, [], 'OUR TEXT STILL ON THE PROMPT AFTER A TURN: HELD, NOT ERASED (Jim Q4: no Ctrl-U, no Enter)');
  assert.ok(r.owner.inhibition('p1'));
};
test('fix 2: after a turn ended, our text still on the prompt row stays a person\'s to rule: never erased', () => K.stopOnPromptStays());

K.stopPersonKeyStays = async (M = OWNER) => {
  const { r, req } = await heldOnCodex(M);
  r.prompt = ''; r.human += 1;                            // a person cleared it and typed
  r.now += 5_000; r.turnEnd = r.now;
  const res = await r.settle(r.owner.recheckHeld('p1', req.requestId));
  assert.deepEqual([res.kind, res.why], ['HELD', 'human-input-since-hold'], 'a person\'s keys since the hold keep it theirs');
};
test('fix 2: a person\'s keys since the hold keep it held even after a turn (unchanged rule)', () => K.stopPersonKeyStays());

// ─── the watch is poked by a hook; the row policy logs a delivery's refusal ──────────────

function watchRig(W, over = {}) {
  const w = { now: 0, holds: [], rechecks: [], released: [], answer: { kind: 'HELD', why: 'typed-not-sent', screen: null }, ...over };
  w.watch = new W.HeldInterferenceWatch({
    heldWakes: () => w.holds,
    recheck: (h) => { w.rechecks.push([w.now, h.requestId]); return Promise.resolve(w.answer); },
    released: (h, r) => w.released.push([h.agentId, r.kind, r.how]),
    notice: { raise: () => {}, clear: () => {} },
    log: () => {},
    now: () => w.now
  });
  w.tick = async (t) => { w.now = t; w.watch.tick(t); await new Promise((res) => setImmediate(res)); };
  return w;
}
const HOLD = { agentId: 'creed', requestId: 'w1', ptyId: 'p1', messages: 1, since: 0, reason: 'WAKE_TYPED_NOT_SENT' };

K.pokeRechecksNextTick = async (W = HELD) => {
  const w = watchRig(W);
  w.holds = [HOLD, { ...HOLD, agentId: 'jim', requestId: 'w2', ptyId: 'p2' }];
  await w.tick(15_000);
  assert.deepEqual(w.rechecks, [], 'not within the per-hold minute');
  w.watch.poke('creed');
  w.answer = { kind: 'SUBMITTED', screen: null, how: 'surfaced' };
  await w.tick(30_000);
  assert.deepEqual(w.rechecks, [[30_000, 'w1']], 'A POKED AGENT\'S HOLD IS LOOKED AT ON THE NEXT TICK (the other agent\'s is not)');
  assert.deepEqual(w.released, [['creed', 'SUBMITTED', 'surfaced']], 'and released as the owner said');
  w.watch.poke('nobody');
  await w.tick(45_000);
  assert.equal(w.rechecks.length, 1, 'a poke for an agent without holds does nothing');
};
test('watch: a hook of the agent (poke) brings the look forward to the next tick', () => K.pokeRechecksNextTick());

K.deliveryRefusalLogs = (P = POLICY) => {
  const st = P.newWakeRowState();
  assert.ok(P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'beat', mode: 'reconcile', why: 'owner-inhibited', inboxIds: 1 }), 'the first refusal logs');
  assert.equal(P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'beat', mode: 'reconcile', why: 'owner-inhibited', inboxIds: 1 }), null, 'a beat\'s repeat folds');
  assert.equal(P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'hook', mode: 'event', why: 'owner-inhibited', inboxIds: 1 }), null, 'a hook\'s repeat folds');
  const row = P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'delivery', mode: 'event', why: 'owner-inhibited', inboxIds: 2 });
  assert.ok(row, 'A DELIVERED MESSAGE\'S REFUSAL ALWAYS LOGS (the 15:24:40Z row)');
  assert.equal(row.why, 'owner-inhibited');
  assert.ok(P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'delivery', mode: 'event', why: 'owner-inhibited', inboxIds: 3 }), 'and every delivery\'s');
  assert.equal(P.planWakeRow(st, 'no-claim', { agentId: 'creed', cause: 'beat', mode: 'reconcile', why: 'owner-inhibited', inboxIds: 3 }), null, 'beats still fold');
};
test('row policy: a delivery\'s no-claim is never folded (the 15:24:40Z request had no wake row)', () => K.deliveryRefusalLogs());

// ─── wiring pins ────────────────────────────────────────────────────────────────────────

test('wiring: index.ts passes both proofs and the poke; the wiring and the rig carry them; one resolveInterference caller stays', () => {
  const idx = readSource('src/main/index.ts');
  assert.ok(idx.includes('wakeSurfacedSince: (agentId, ids, since) => {'), 'index: the ledger proof');
  assert.ok(idx.includes("if (!e || (e.state !== 'surfaced' && e.state !== 'acted')) return false;"), 'index: surfaced or acted entries only');
  assert.ok(idx.includes('return Math.max(e.surfacedAt ?? 0, e.actedAt ?? 0) >= since;'), 'index: at or after the hold');
  assert.ok(idx.includes('turnEndedSince: (agentId, since) => { const t = workerWake.livenessFacts(agentId).lastTurnEndAt; return t > 0 && t >= since; },'), 'index: the Stop proof');
  assert.ok(idx.includes("if (agentId && (event === 'UserPromptSubmit' || event === 'Stop')) heldInterference?.poke(agentId);"), 'index: the poke on the two hooks');
  assert.ok(idx.includes('promptTailMatches?: boolean; screenCount?: number } | null, reason: r.reason };'), 'index: the sender gets screenCount');
  assert.equal(idx.split('automaticSubmit.resolveInterference(').length - 1, 1, 'index: still ONE resolveInterference caller (Andy\'s 193 pin): the surfaced proof resolves inside the owner');
  const wiring = readSource('src/main/automaticSubmitWiring.ts');
  assert.ok(wiring.includes('wakeSurfacedSince: w.wakeSurfacedSince,') && wiring.includes('turnEndedSince: w.turnEndedSince,'), 'wiring passes both');
  const rig = fs.readFileSync(path.join(__dirname, 'mail-rig', 'rig-host.cjs'), 'utf8');
  assert.ok(rig.includes('wakeSurfacedSince: (agentId, ids, since) => {') && rig.includes('turnEndedSince: (agentId, since) => { const t = workerWake.livenessFacts(agentId).lastTurnEndAt;'), 'the rig mirrors index');
});

// ─── mutant census ──────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const WSF = 'src/main/wakeSender.ts';
const OWF = 'src/main/automaticSubmit.ts';
const MUTANTS = [
  { name: 'unpainted mirror counts as off-prompt (the 12:18:50Z judgment)', file: WSF, killer: 'restartReplay', dies: /NO INTERFERED AFTER A RESTART/,
    edits: [['          if (r.screenCount === undefined || r.screenCount >= 1) offPrompt = true;', '          offPrompt = true;']] },
  { name: 'UNKNOWN is not the owner\'s (boot only)', file: WSF, killer: 'restartReplay', dies: /NO INTERFERED AFTER A RESTART/,
    edits: [["      if (kind === 'boot' || typed === 'UNKNOWN') {", "      if (kind === 'boot') {"]] },
  { name: 'no re-confirm: one reading decides', file: WSF, killer: 'paintsLate', dies: /A LATE PAINT CONFIRMS: ENTER/,
    edits: [['      await d.sleep(WAKE_TYPED_CONFIRM_STEP_MS);', "      return 'UNKNOWN';"]] },
  { name: 'the human generation is not re-read during the look', file: WSF, killer: 'humanKeyWhileLooking', dies: /A PERSON'S KEY DURING THE LOOK/,
    edits: [["      if (d.humanGeneration(ptyId) !== gen0) return 'HUMAN_TYPED';", '']] },
  { name: 'ON_PROMPT is answered inside the reading pass, before the generation check (Jim MAJOR 1)', file: WSF, killer: 'humanKeyBeforePaint', dies: /WINS OVER A LATER ON_PROMPT READING/,
    edits: [["if (r.onPromptRow || r.promptTailMatches === true) { onPrompt = true; break; }", "if (r.onPromptRow || r.promptTailMatches === true) return 'ON_PROMPT';"]] },
  { name: 'the generation is checked after ON_PROMPT (Jim MAJOR 1, reading 3)', file: WSF, killer: 'humanKeyBeforePaint', dies: /WINS OVER A LATER ON_PROMPT READING/,
    edits: [["      if (d.humanGeneration(ptyId) !== gen0) return 'HUMAN_TYPED';\n      if (onPrompt) return 'ON_PROMPT';", "      if (onPrompt) return 'ON_PROMPT';\n      if (d.humanGeneration(ptyId) !== gen0) return 'HUMAN_TYPED';"]] },
  { name: 'a null reading is held as 1.1.97 did (not in the composer)', file: WSF, killer: 'nullReadingIsUnknown', dies: /A NULL READING IS UNKNOWN, THEN THE OWNER'S/,
    edits: [["          if (!r) continue;", "          if (!r) { offPrompt = true; continue; }"]] },
  { name: 'the grant is not handed back before the owner', file: WSF, killer: 'restartReplay', dies: /handed back before the owner/,
    edits: [["        const why = kind === 'boot' ? 'boot-not-in-composer' : 'wake-unconfirmed';\n        this.cancel(decision);", "        const why = kind === 'boot' ? 'boot-not-in-composer' : 'wake-unconfirmed';"]] },
  { name: 'a real off-prompt reading no longer holds', file: WSF, killer: 'offPromptStillHeld', dies: /OUR TEXT SEEN OFF THE PROMPT ROW: HELD/,
    edits: [["      if (offPrompt) return 'OFF_PROMPT';", '']] },
  { name: 'surfaced ids are no proof', file: OWF, killer: 'surfacedClears', dies: /SURFACED IDS END THE HOLD/,
    edits: [["      if (ids.length > 0 && this.wakeSurfaced(held.agentId, ids, held.at) === true) {", '      if (false) {']] },
  { name: 'surfaced ids resolve as SEND_AGAIN (retyped later)', file: OWF, killer: 'surfacedClears', dies: /answers HUMAN_HANDLED from now on/,
    edits: [["        this.resolveInterference(ptyId, 'ALREADY_HANDLED');\n        return { kind: 'SUBMITTED'", "        this.resolveInterference(ptyId, 'SEND_AGAIN');\n        return { kind: 'SUBMITTED'"]] },
  { name: 'a typed hold is looked at without any turn ended', file: OWF, killer: 'noProofStays', dies: /NO PROOF: HELD AS BEFORE/,
    edits: [["      if (this.turnEnded(held.agentId, held.at) !== true) return stay('typed-not-sent');", '']] },
  { name: 'after a turn, our text on the prompt is erased (Jim Q4 broken)', file: OWF, killer: 'stopOnPromptStays', dies: /OUR TEXT STILL ON THE PROMPT AFTER A TURN: HELD, NOT ERASED/,
    edits: [["      if (typed) return stay('typed-not-sent:on-prompt', screen);", '']] },
  { name: 'a turn ended is no proof either (1.1.97: typed-not-sent forever)', file: OWF, killer: 'stopEmptyReleases', dies: /A STOP WITH AN EMPTY COMPOSER RELEASES THE HOLD/,
    edits: [["      if (this.turnEnded(held.agentId, held.at) !== true) return stay('typed-not-sent');", "      return stay('typed-not-sent');"]] },
  { name: 'the poke does nothing', file: 'src/main/heldInterference.ts', killer: 'pokeRechecksNextTick', dies: /A POKED AGENT'S HOLD IS LOOKED AT ON THE NEXT TICK/,
    edits: [['    for (const h of this.current) if (h.agentId === agentId) this.lastCheck.set(keyOf(h), Number.NEGATIVE_INFINITY);\n', '']] },
  { name: 'a delivery\'s refusal folds like a beat\'s', file: 'src/main/wakeRowPolicy.ts', killer: 'deliveryRefusalLogs', dies: /A DELIVERED MESSAGE'S REFUSAL ALWAYS LOGS/,
    edits: [["        if (seen.has(why) && fields.cause !== 'delivery') return fold();", '        if (seen.has(why)) return fold();']] }
];

for (const m of MUTANTS) {
  test(`mutant dies: ${m.name}`, async () => {
    const M = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
    await assert.rejects(async () => K[m.killer](M), m.dies, `mutant "${m.name}" must die at ${m.dies}`);
  });
}
