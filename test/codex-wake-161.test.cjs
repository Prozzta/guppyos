'use strict';

/**
 * CODEX-WAKE-161 (Jim, agents/jim-mtujpe28/CODEX-WAKE-ROOTCAUSE.md). A wake line reached
 * Codex's composer but its Enter landed as a NEWLINE (Codex read the fast non-bracketed burst
 * as a paste), the owner settled COMMITTED at write level, the prior-text recheck looked only
 * at the cursor's row (empty after a newline) and typed a second copy, and the ids of a twice-
 * unconfirmed wake were burned silently.
 *
 *   F1  Codex gets a longer gap between the text and its Enter (automaticEnterGapMs): measured
 *       on the real codex-cli 0.157.1, an Enter 140-200 ms after the burst is a newline and one
 *       300 ms or more after it submits. (A bracketed paste, the first proposal, did not help
 *       through ConPTY, so the payload stays raw.)
 *   F2  the prior-text check reads the WHOLE composer (prompt marker down to the cursor): our
 *       own untouched draft there is re-Entered, anything else is held; never a second copy.
 *   F3  for Codex, COMMITTED only once our text has left the composer (one more Enter of our
 *       own, then a visible INTERFERED SUBMIT_NOT_ACCEPTED).
 *   F4  (workerWake) a twice-unconfirmed wake is logged and offered again after a backoff:
 *       pinned in wake-confirm-153 "CODEX (2) Dwight" and below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const loadTs = require('./load-ts.cjs');
const OWN = loadTs('src/main/automaticSubmit.ts');
const { payloadFor, AutomaticSubmitOwner, SUBMIT_VERIFY_WINDOW_MS, GAP_MS } = OWN;
const { automaticEnterGapMs, automaticVerifySubmit, CODEX_ENTER_GAP_MS } = loadTs('src/shared/providerAutomation.ts');
const { composerRegionEndsWith, normalizeComposerText } = loadTs('src/renderer/src/components/composerAttestation.ts');
const { WorkerWakeWatchdog, WAKE_RETRY_BASE_MS, SUBMIT_CONFIRM_MS } = loadTs('src/main/workerWake.ts');

const NUDGE = 'You have new hive inbox message(s) - at least: 2026-09-27T07-02-23-000Z-god-dwight-evalspec. Read your inbox, act on what is pending there.';

// ── F1 ────────────────────────────────────────────────────────────────────────────────────

test('F1: Codex waits CODEX_ENTER_GAP_MS (800, past the measured 200-300 ms edge) before its Enter; every other provider keeps GAP_MS; payloads are unchanged', () => {
  assert.equal(CODEX_ENTER_GAP_MS, 800);
  assert.ok(CODEX_ENTER_GAP_MS >= 2 * 300, 'a wide margin over the measured edge');
  assert.equal(automaticEnterGapMs('codex'), CODEX_ENTER_GAP_MS);
  for (const p of ['claude', 'antigravity', 'gemini', 'opencode', 'custom']) assert.equal(automaticEnterGapMs(p), null, p);
  assert.equal(payloadFor('one line'), 'one line', 'single-line stays raw (#24; bracketed did not help Codex through ConPTY)');
  assert.equal(payloadFor('two\nlines'), '\x1b[200~two\nlines\x1b[201~');
  assert.equal(automaticVerifySubmit('codex'), true);
  assert.equal(automaticVerifySubmit('claude'), false);
});

test('F1: the owner waits the provider\'s gap before the Enter (and GAP_MS without one)', async () => {
  for (const [gap, want] of [[CODEX_ENTER_GAP_MS, CODEX_ENTER_GAP_MS], [null, GAP_MS]]) {
    const w = world({ enter: 'submits' });
    w.deps.enterGapMs = () => gap;
    w.deps.verifySubmit = () => false;
    let stagedAt = null; let enterAt = null;
    const write = w.deps.write;
    w.deps.write = (id, data) => { if (data === '\r') enterAt = w.vt; else stagedAt = w.vt; return write(id, data); };
    w.owner = new AutomaticSubmitOwner(w.deps);
    assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
    assert.equal(enterAt - stagedAt, want, String(gap));
  }
});

// ── A Codex-shaped composer, for the owner ───────────────────────────────────────────────

/**
 * `enter`: what an Enter does to a composer holding text:
 *   'submits'        the text goes to the transcript; the composer is empty
 *   'newline'        a newline is inserted: the text stays, the cursor drops to an empty row
 *   'newline-once'   the first Enter is a newline (the paste window), later ones submit
 * `screen` answers like the renderer: onPromptRow = the cursor row holds the needle;
 * promptTailMatches = the composer region (all its rows) ends in the expected text.
 */
function world({ enter = 'submits', composer = [''], ownerDraft = false } = {}) {
  const w = { vt: 0, timers: [], seq: 0, writes: [], composer: [...composer], transcript: [], enters: 0, gen: 0, reads: 0 };
  const strip = (d) => d.replace(/\x1b\[20[01]~/g, '');
  w.deps = {
    resolvePty: () => 'pty-dwight',
    incarnation: () => 1,
    humanGeneration: () => w.gen,
    write: (_id, data) => {
      w.writes.push(data);
      if (data !== '\r') { w.composer[w.composer.length - 1] += strip(data); return { ok: true }; }
      w.enters += 1;
      const text = w.composer.join('\n').trim();
      const submits = enter === 'submits' || (enter === 'newline-once' && w.enters > 1);
      if (submits) { if (text) w.transcript.push(text); w.composer = ['']; }
      else w.composer.push('');
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'UNKNOWN' }),
    readScreen: (_id, needle, expectedTail) => {
      w.reads += 1;
      const cursorRow = w.composer[w.composer.length - 1];
      const region = normalizeComposerText(w.composer.join('\n'));
      return Promise.resolve({
        onPromptRow: cursorRow.includes(needle),
        screenCount: [...w.transcript, ...w.composer].filter((r) => r.includes(needle)).length,
        ...(expectedTail ? { promptTailMatches: region.length > 0 && region.endsWith(normalizeComposerText(expectedTail)) } : {})
      });
    },
    capacity: { admit: () => null, revalidate: () => ({ verdict: 'ALLOW', reason: 'x' }), confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; },
    enterGapMs: () => CODEX_ENTER_GAP_MS,
    verifySubmit: () => true
  };
  w.owner = new AutomaticSubmitOwner(w.deps);
  w.settle = async (p) => {
    let done = false; let value;
    p.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((r) => setImmediate(r));
      if (done) return value;
      if (!w.timers.length) throw new Error('stuck');
      w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = w.timers.shift();
      w.vt = Math.max(w.vt, next.at);
      next.fn();
    }
    throw new Error('did not settle');
  };
  if (ownerDraft) w.ownerDraft = ownerDraft;
  return w;
}
const submit = (w, over = {}) => w.settle(w.owner.submit({ requestId: 'wake-1', agentId: 'dwight', admissionClass: 'USER_RELEASED', text: NUDGE, ...over }));
const PASTE = (t) => t;   // Codex payloads are raw (F1 changes the gap, not the payload)

// ── F3 ────────────────────────────────────────────────────────────────────────────────────

test('F3: an Enter that submits -> COMMITTED after the composer reads empty; one paste, one Enter', async () => {
  const w = world({ enter: 'submits' });
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r']);
  assert.deepEqual(w.transcript, [NUDGE]);
  assert.ok(w.reads >= 1, 'the composer was read after the Enter');
});

test('F3: an Enter that became a NEWLINE (the observed Codex failure) is caught: ONE more Enter of our own, then COMMITTED - no second copy typed', async () => {
  const w = world({ enter: 'newline-once' });
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r', '\r'], 'paste, Enter (newline), Enter (submits): never the text twice');
  assert.deepEqual(w.transcript, [NUDGE], 'exactly one wake line in the turn, not a stack');
});

test('F3: a composer that never takes the Enter -> INTERFERED SUBMIT_NOT_ACCEPTED after exactly two Enters (visible hold, nothing more typed)', async () => {
  const w = world({ enter: 'newline' });
  const out = await submit(w);
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'SUBMIT_NOT_ACCEPTED');
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r', '\r']);
  assert.ok(w.owner.inhibition('pty-dwight'), 'the PTY is held for a person');
  assert.ok(w.vt >= 2 * SUBMIT_VERIFY_WINDOW_MS, 'each Enter got the full window to clear');
});

test('F3 is opt-in per provider: without verifySubmit the write-level COMMITTED stands (no read after the Enter)', async () => {
  const w = world({ enter: 'newline' });
  w.deps.verifySubmit = () => false;
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  assert.equal(w.reads, 0);
});

test('F3: no screen reading after the Enter -> COMMITTED (nothing here can prove otherwise; the wake coordinator\'s provider confirmation still judges the turn)', async () => {
  const w = world({ enter: 'newline' });
  w.deps.readScreen = () => Promise.resolve(null);
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r']);
});

// ── F2 ────────────────────────────────────────────────────────────────────────────────────

test('F2: our own unsent wake ABOVE an empty cursor row (a newline Enter) is seen: the recheck re-Enters it instead of typing a second copy', async () => {
  // The first wake: Enter lands as a newline, and verification is off (as on 1.1.60) so the
  // owner remembers the draft but the text stays: exactly the stacked shape of Dwight's rollout.
  const w = world({ enter: 'newline-once' });
  w.deps.verifySubmit = () => false;
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  assert.deepEqual(w.composer, [NUDGE, ''], 'text above, the cursor on an empty row');
  // The re-claim carries the prior text. The cursor row is empty, but the composer holds it.
  w.deps.verifySubmit = () => true;
  const out = await submit(w, { requestId: 'wake-1:again', priorText: NUDGE });
  assert.deepEqual(out, { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r', '\r'], 'the second claim typed NOTHING, it pressed Enter on our own draft');
  assert.deepEqual(w.transcript, [NUDGE], 'one wake line in the turn');
});

test('F2: text in the composer that is NOT our remembered draft is held (PRIOR_TEXT_ON_PROMPT), never typed after', async () => {
  const w = world({ composer: [NUDGE, ''] });   // e.g. left by an app run that has since restarted
  const out = await submit(w, { requestId: 'wake-2:again', priorText: NUDGE });
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'PRIOR_TEXT_ON_PROMPT');
  assert.deepEqual(w.writes, []);
});

test('F2: after a REAL submit the composer is empty, so the re-claim types normally', async () => {
  const w = world({ composer: [''] });
  w.transcript.push(NUDGE);
  assert.deepEqual(await submit(w, { requestId: 'wake-3:again', priorText: NUDGE }), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [PASTE(NUDGE), '\r']);
});

// ── F2 against real xterm screens (the renderer's composer read) ─────────────────────────

function write(term, text) { return new Promise((resolve) => term.write(text, resolve)); }

test('F2 fixture screens (xterm): our wake above an empty cursor row attests; the screen after a real submit does not', async () => {
  const cols = 100;
  // Codex's composer: a `›` marker row, wrapped continuation rows, and after a newline Enter
  // the cursor on a new empty row inside the same composer.
  const stuck = new Terminal({ cols, rows: 12, scrollback: 50 });
  await write(stuck, `• Worked for 2m\r\n\r\n› ${NUDGE}\r\n`);
  let b = stuck.buffer.active;
  const cursorRow = b.getLine(b.baseY + b.cursorY).translateToString(true);
  assert.equal(cursorRow.includes('inbox'), false, 'the cursor row alone says absent (the 1.1.59/1.1.60 check)');
  assert.equal(composerRegionEndsWith(b, b.baseY + b.cursorY, NUDGE), true, 'the composer region says present');

  // After a real submit: the text is in the transcript, and the cursor sits on the NEW
  // prompt row (the marker, empty or with a placeholder).
  for (const prompt of ['› ', '› Ask Codex to do anything']) {
    const sent = new Terminal({ cols, rows: 12, scrollback: 50 });
    await write(sent, `› ${NUDGE}\r\n\r\n• Reading the inbox\r\n\r\n${prompt}`);
    b = sent.buffer.active;
    if (prompt.length > 2) await write(sent, '\r› ');   // cursor back at the start of the placeholder row
    b = sent.buffer.active;
    assert.equal(composerRegionEndsWith(b, b.baseY + b.cursorY, NUDGE), false, `after a real submit (${JSON.stringify(prompt)})`);
  }
});

// ── F4 at the coordinator ────────────────────────────────────────────────────────────────

test('F4: a twice-unconfirmed wake is never burned: reconcile does not re-pend it inside the backoff, and it is pending again after', () => {
  const c = new WorkerWakeWatchdog();
  const facts = (now) => ({ agentId: 'dw', ptyId: 'p', paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });
  let now = 1_000_000;
  c.reconcile('dw', ['m1']);
  const commit = () => {
    const claim = c.claim(facts(now), 'reconcile', 'reconcile', now);
    assert.ok(claim, 'claimed');
    c.settle(claim, 'COMMITTED', now, true);
    return claim;
  };
  assert.equal(commit().requestId.endsWith(':again'), false);
  now += SUBMIT_CONFIRM_MS;
  assert.equal(c.beat('dw', now).kind, 'submit-unconfirmed');
  now += 20_000;
  assert.equal(commit().requestId.endsWith(':again'), true);
  now += SUBMIT_CONFIRM_MS;
  const edge = c.beat('dw', now);
  assert.deepEqual([edge.kind, edge.ids, edge.attempt, edge.retryInMs], ['wake-ids-exhausted', ['m1'], 1, WAKE_RETRY_BASE_MS]);
  for (let t = 60_000; t < WAKE_RETRY_BASE_MS; t += 60_000) {
    c.reconcile('dw', ['m1']);
    assert.equal(c.beat('dw', now + t), null);
    assert.deepEqual(c.state('dw').pending, [], 'still waiting out the backoff');
  }
  c.reconcile('dw', ['m1']);
  assert.deepEqual(c.beat('dw', now + WAKE_RETRY_BASE_MS), { kind: 'wake-retry', ids: ['m1'], attempt: 1 });
  assert.deepEqual(c.state('dw').pending, ['m1']);
  now += WAKE_RETRY_BASE_MS + 20_000;
  assert.equal(commit().requestId.endsWith(':retry1'), true, 'a fresh request id, not a replay');
  // Mail that leaves the disk leaves the retry table too.
  c.settle(c.state('dw').inFlight ?? { agentId: 'dw', requestId: 'x', ids: [] }, 'COMMITTED', now, false);
  c.reconcile('dw', []);
  now += SUBMIT_CONFIRM_MS;
  c.reconcile('dw', ['m2']);
  assert.deepEqual(c.state('dw').pending, ['m2']);
});

// ── Jim's guard tests (CODEX-WAKE-161-AUDIT T1): the safety claims that hold in the code, pinned ──
// Adopted verbatim from agents/jim-mtujpe28/jim-codex161-guards.test.cjs (they reuse world() above).

test('JIM F2-guard: a human key after our stage -> our stacked draft is HELD, never re-Entered', async () => {
  const w = world({ enter: 'newline-once' });
  w.deps.verifySubmit = () => false;
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  w.gen += 1; // a human keystroke since STAGE
  w.deps.verifySubmit = () => true;
  const out = await submit(w, { requestId: 'wake-1:again', priorText: NUDGE });
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'PRIOR_TEXT_ON_PROMPT');
  assert.deepEqual(w.writes, [NUDGE, '\r'], 'no Enter pressed on a human-touched draft');
});

test('JIM F2-guard: composer text ending in our wake but NOT our remembered draft -> HELD', async () => {
  const w = world({ enter: 'newline-once' });
  w.deps.verifySubmit = () => false;
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w, { text: 'human prefix ' + NUDGE }), { kind: 'COMMITTED' });
  w.deps.verifySubmit = () => true;
  const out = await submit(w, { requestId: 'wake-1:again', priorText: NUDGE });
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'PRIOR_TEXT_ON_PROMPT');
  assert.equal(w.writes.filter((x) => x === '\r').length, 1);
});

test('JIM F3 on the re-Enter path: a re-Entered draft that stays -> ONE more Enter then SUBMIT_NOT_ACCEPTED', async () => {
  const w = world({ enter: 'newline' });
  w.deps.verifySubmit = () => false;
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w), { kind: 'COMMITTED' });
  w.deps.verifySubmit = () => true;
  const out = await submit(w, { requestId: 'wake-1:again', priorText: NUDGE });
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'SUBMIT_NOT_ACCEPTED');
  assert.deepEqual(w.writes, [NUDGE, '\r', '\r', '\r'], 'never a second copy; bounded Enters');
});

test('JIM F3: a human key during the verify window -> the second Enter is NOT sent (HUMAN_INPUT_AFTER_STAGE)', async () => {
  const w = world({ enter: 'newline' });
  const read = w.deps.readScreen;
  w.deps.readScreen = (...a) => { w.gen += 1; return read(...a); };
  w.owner = new AutomaticSubmitOwner(w.deps);
  const out = await submit(w);
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'HUMAN_INPUT_AFTER_STAGE');
  assert.deepEqual(w.writes, [NUDGE, '\r'], 'one Enter only');
});

test('F4 (Jim, surviving mutant): mail that leaves the disk during its backoff leaves the retry table: back on disk, it is plain pending at once', () => {
  const c = new WorkerWakeWatchdog();
  const facts = (now) => ({ agentId: 'dw', ptyId: 'p', paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });
  let now = 2_000_000;
  c.reconcile('dw', ['m1']);
  for (let i = 0; i < 2; i++) {
    const claim = c.claim(facts(now), 'reconcile', 'reconcile', now);
    c.settle(claim, 'COMMITTED', now, true);
    now += SUBMIT_CONFIRM_MS;
    c.beat('dw', now);
    now += 20_000;
  }
  assert.deepEqual(c.state('dw').pending, [], 'waiting out a backoff');
  c.reconcile('dw', []);        // moved to .done by hand
  c.reconcile('dw', ['m1']);    // and back (a person restored it)
  assert.deepEqual(c.state('dw').pending, ['m1'], 'no stale retry entry holds it back');
  const claim = c.claim(facts(now), 'reconcile', 'reconcile', now);
  assert.equal(/:retry\d+$/.test(claim.requestId), false, 'and it is a fresh announcement, not a retry');
});
