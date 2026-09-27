'use strict';

/**
 * CODEX-WAKE-162 (Jim, agents/jim-mtujpe28/POST-INSTALL-161.md): on 1.1.61 canary 5 stacked two
 * wake lines. Codex's composer DROPS the em dash the wake line carried (`message(s)  at least`),
 * so the owner's screen attestation never recognised its own stuck text: F3 read "gone" and
 * settled a false COMMITTED, and F2 read "absent" and typed a second copy. Every 1.1.61 test used
 * an ASCII NUDGE, so none saw it.
 *
 * Here the owner runs against a REAL xterm screen drawn the way Codex draws it (the TUI drops
 * what it cannot echo), with the REAL inboxNudgeText, and the renderer's own readers
 * (composerRegionEndsWith, needleMatcher). Plus: the wake text is pure ASCII, F3 wants two
 * "gone" readings, and the Codex gap scales with the payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const loadTs = require('./load-ts.cjs');
const { AutomaticSubmitOwner, SUBMIT_VERIFY_WINDOW_MS, SUBMIT_VERIFY_POLL_MS, SUBMIT_GONE_READS, needleFor } = loadTs('src/main/automaticSubmit.ts');
const PA = loadTs('src/shared/providerAutomation.ts');
const { composerRegionEndsWith, needleMatcher, asciiSkeleton, MIN_SKELETON_CHARS } = loadTs('src/renderer/src/components/composerAttestation.ts');
const { inboxNudgeText, isInboxNudge } = loadTs('src/shared/hiveNudge.ts');

const IDS = ['2026-09-27T10-29-35-315Z-god-dwight-canary5'];
const REAL = inboxNudgeText(IDS);
/** What 1.1.61 typed: the same text with the em dash (the regression Jim reproduced). */
const LEGACY = REAL.replace(' - at least: ', ' — at least: ');
/** Codex's composer: whatever it cannot echo is dropped (observed: the em dash). */
const codexDrop = (t) => t.replace(/[^\x20-\x7e]/g, '');

function write(term, text) { return new Promise((resolve) => term.write(text, resolve)); }

/** Draw the transcript and the composer the way Codex does: `› ` on the composer's first row,
 *  continuation rows indented, the cursor at the end of the last composer row. */
async function draw(term, transcript, composer, drop = codexDrop) {
  term.reset();
  let out = '';
  for (const t of transcript) out += `• ${drop(t)}\r\n`;
  composer.forEach((row, i) => { out += (i === 0 ? '› ' : '  ') + drop(row) + (i < composer.length - 1 ? '\r\n' : ''); });
  await write(term, out);
}

/** The owner's deps over a real xterm Codex screen. enter: 'submits' | 'newline-once' | 'newline-always'. */
function codexWorld({ enter = 'submits', composer = [''] } = {}) {
  const term = new Terminal({ cols: 100, rows: 40, allowProposedApi: true });
  const w = { vt: 0, timers: [], seq: 0, writes: [], composer: [...composer], transcript: [], enters: 0, reads: 0, term };
  w.deps = {
    resolvePty: () => 'pty-dwight',
    incarnation: () => 1,
    humanGeneration: () => 0,
    write: (_id, data) => {
      w.writes.push(data);
      if (data !== '\r') { w.composer[w.composer.length - 1] += data; return { ok: true }; }
      w.enters += 1;
      const text = w.composer.join('\n').trim();
      const submits = enter === 'submits' || (enter === 'newline-once' && w.enters > 1);
      if (submits) { if (text) w.transcript.push(text); w.composer = ['']; } else w.composer.push('');
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'UNKNOWN' }),
    // The renderer's readScreenForNeedle, over the real buffer (same readers it uses).
    readScreen: (_id, needle, expectedTail) => (w.pending = (async () => {
      w.reads += 1;
      await draw(term, w.transcript, w.composer);
      const buf = term.buffer.active;
      const has = needleMatcher(needle);
      let screenCount = 0;
      for (let y = 0; y < term.rows; y += 1) { const l = buf.getLine(buf.baseY + y); if (l && has(l.translateToString(true))) screenCount += 1; }
      return {
        onPromptRow: has(buf.getLine(buf.baseY + buf.cursorY).translateToString(true)),
        screenCount,
        ...(expectedTail ? { promptTailMatches: composerRegionEndsWith(buf, buf.baseY + buf.cursorY, expectedTail) } : {})
      };
    })()),
    capacity: { admit: () => null, revalidate: () => ({ verdict: 'ALLOW', reason: 'x' }), confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; },
    enterGapMs: (_p, len) => PA.automaticEnterGapMs('codex', len),
    verifySubmit: () => true
  };
  w.owner = new AutomaticSubmitOwner(w.deps);
  w.settle = async (p) => {
    let done = false; let value;
    p.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
      await new Promise((r) => setImmediate(r));
      // a screen read awaits xterm's real (async) parse: let it finish before virtual time moves
      while (w.pending) { const p = w.pending; await p; await new Promise((r) => setImmediate(r)); if (w.pending === p) w.pending = null; }
      if (done) return value;
      if (!w.timers.length) continue;
      w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = w.timers.shift();
      w.vt = Math.max(w.vt, next.at);
      next.fn();
    }
    throw new Error('did not settle');
  };
  return w;
}
const submit = (w, text, over = {}) => w.settle(w.owner.submit({ requestId: 'wake-1', agentId: 'dwight', admissionClass: 'USER_RELEASED', text, ...over }));

// ── the wake text ─────────────────────────────────────────────────────────────────────────

test('the wake text is pure printable ASCII (every TUI echoes it verbatim) and is still recognised as a nudge', () => {
  for (const ids of [[], IDS, ['a', 'b', 'c']]) {
    const t = inboxNudgeText(ids);
    assert.match(t, /^[\x20-\x7e]+$/, JSON.stringify(t));
    assert.ok(isInboxNudge(t));
  }
  assert.match(REAL, / - at least: 2026-09-27T10-29-35-315Z-god-dwight-canary5\. Read your inbox/);
  assert.match(needleFor(REAL), /^[\x20-\x7e]+$/, 'the head needle is ASCII too');
});

// ── the readers (Jim's headless repro, now inverted) ─────────────────────────────────────────

test('attestation: a Codex screen that DROPPED the em dash still attests the text (1.1.61 said false); exact screens still do', async () => {
  const term = new Terminal({ cols: 100, rows: 40, allowProposedApi: true });
  const at = () => { const b = term.buffer.active; return composerRegionEndsWith(b, b.baseY + b.cursorY, LEGACY); };
  await draw(term, [], [LEGACY], (t) => t);
  assert.equal(at(), true, 'dash rendered');
  await draw(term, [], [LEGACY]);
  assert.equal(at(), true, 'dash DROPPED by the TUI (the canary-5 screen)');
  await draw(term, [], [LEGACY, '']);
  assert.equal(at(), true, 'the Enter-as-newline screen: text above, cursor on an empty row');
  await draw(term, [], ['something else the human typed']);
  assert.equal(at(), false, 'other text is not ours');
  await draw(term, [], [REAL]);
  const b = term.buffer.active;
  assert.equal(composerRegionEndsWith(b, b.baseY + b.cursorY, REAL), true, 'the ASCII text, as typed');
});

test('attestation: the skeleton is used only when it proves something (all-non-ASCII or tiny texts are not attested by it)', async () => {
  assert.equal(asciiSkeleton('a —  bé'), 'a b');
  assert.equal(MIN_SKELETON_CHARS, 8);
  const term = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  await draw(term, [], ['xyz']);
  const b = term.buffer.active;
  assert.equal(composerRegionEndsWith(b, b.baseY + b.cursorY, '日本語 xyz'), false, 'a 3-char skeleton proves nothing');
  await draw(term, [], ['日本語'], (t) => t);
  assert.equal(composerRegionEndsWith(term.buffer.active, term.buffer.active.baseY + term.buffer.active.cursorY, '日本語'), true, 'exact non-ASCII still matches exactly');
});

test('needles: a needle with a droppable character still finds its row; an ASCII needle is unchanged', () => {
  const m = needleMatcher('s) — at least');
  assert.equal(m('message(s)  at least: x'), true, 'dash dropped by the TUI');
  assert.equal(m('message(s) — at least: x'), true);
  assert.equal(m('nothing here'), false);
  const a = needleMatcher('You have new hiv');
  assert.equal(a('› You have new hive inbox'), true);
  assert.equal(a('You have new'), false);
});

// ── the owner, end to end, on the canary-5 screen ────────────────────────────────────────────

for (const [label, text] of [['REAL inboxNudgeText', REAL], ['1.1.61 em-dash text (the TUI drops the dash)', LEGACY]]) {
  test(`F3 on a Codex screen, ${label}: an Enter that became a NEWLINE is re-Entered; ONE wake line in the turn, COMMITTED`, async () => {
    const w = codexWorld({ enter: 'newline-once' });
    assert.deepEqual(await submit(w, text), { kind: 'COMMITTED' });
    assert.deepEqual(w.writes, [text, '\r', '\r'], 'our own Enter again, nothing typed twice');
    assert.deepEqual(w.transcript, [text]);
  });

  test(`F3 on a Codex screen, ${label}: an Enter that never submits is held SUBMIT_NOT_ACCEPTED, never a false COMMITTED`, async () => {
    const w = codexWorld({ enter: 'newline-always' });
    const out = await submit(w, text);
    assert.equal(out.kind, 'INTERFERED');
    assert.equal(out.reason, 'SUBMIT_NOT_ACCEPTED');
    assert.equal(w.writes.filter((x) => x !== '\r').length, 1, 'typed once');
    assert.deepEqual(w.transcript, []);
  });

  test(`F2 on a Codex screen, ${label}: the re-claim finds our own stuck line (dash dropped) and presses Enter on it - NO second copy`, async () => {
    const w = codexWorld({ enter: 'newline-once' });
    w.deps.verifySubmit = () => false;   // 1.1.61 canary 5: the first claim settled COMMITTED
    w.owner = new AutomaticSubmitOwner(w.deps);
    assert.deepEqual(await submit(w, text), { kind: 'COMMITTED' });
    assert.deepEqual(w.composer, [text, ''], 'stuck: text above, the cursor on an empty row');
    w.deps.verifySubmit = () => true;
    const out = await submit(w, text, { requestId: 'wake-1:again', priorText: text });
    assert.deepEqual(out, { kind: 'COMMITTED' });
    assert.deepEqual(w.writes, [text, '\r', '\r'], 'the second claim typed NOTHING');
    assert.deepEqual(w.transcript, [text], 'one wake line in the turn (1.1.61: two, joined by a newline)');
  });
}

test('F3 on a Codex screen: a clean submit is COMMITTED after SUBMIT_GONE_READS "gone" readings; one paste, one Enter', async () => {
  const w = codexWorld({ enter: 'submits' });
  assert.deepEqual(await submit(w, REAL), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [REAL, '\r']);
  assert.equal(SUBMIT_GONE_READS, 2);
  assert.equal(w.reads, SUBMIT_GONE_READS, 'two consecutive readings, not one');
});

// ── F3 window and the Codex gap ─────────────────────────────────────────────────────────────

test('F3: one "gone" frame between two "still there" readings is not proof (it re-Enters rather than settling)', async () => {
  const seq = [
    { onPromptRow: false, screenCount: 1, promptTailMatches: false },   // mid-redraw: looks gone
    { onPromptRow: true, screenCount: 1, promptTailMatches: true },     // it was still there
    { onPromptRow: true, screenCount: 1, promptTailMatches: true }
  ];
  const w = codexWorld({ enter: 'newline-once' });
  let i = 0;
  const real = w.deps.readScreen;
  w.deps.readScreen = async (...a) => (i < seq.length ? (w.reads += 1, seq[i++]) : real(...a));
  w.owner = new AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await submit(w, REAL), { kind: 'COMMITTED' });
  assert.equal(w.writes.filter((x) => x === '\r').length, 2, 'the lone "gone" frame did not settle it; our Enter went again');
  assert.deepEqual(w.transcript, [REAL]);
  assert.ok(SUBMIT_VERIFY_WINDOW_MS >= 2_500 && SUBMIT_VERIFY_POLL_MS === 250);
});

test('Codex gap scales with the payload: 800 ms up to 200 chars, +2 ms per char, capped at 2 s; others unchanged', () => {
  assert.equal(PA.automaticEnterGapMs('codex'), 800);
  assert.equal(PA.automaticEnterGapMs('codex', 12), 800);
  assert.equal(PA.automaticEnterGapMs('codex', 200), 800);
  // CODEX-BLOAT-165 fix 4 shortened the wake line (~170 chars with one id), so it now takes the base gap.
  assert.equal(PA.automaticEnterGapMs('codex', REAL.length), 800 + Math.max(0, REAL.length - 200) * 2);
  assert.equal(PA.automaticEnterGapMs('codex', 350), 1_100, 'a 350-char payload waits 1.1 s');
  assert.equal(PA.automaticEnterGapMs('codex', 50_000), PA.CODEX_ENTER_GAP_MAX_MS);
  assert.equal(PA.automaticEnterGapMs('codex', NaN), 800);
  for (const p of ['claude', 'antigravity', 'gemini']) assert.equal(PA.automaticEnterGapMs(p, 5000), null, p);
});

test('WIRING: the owner passes the payload length to the gap; the wiring forwards it to automaticEnterGapMs', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  assert.match(read('src/main/automaticSubmit.ts'), /await this\.sleep\(deps\.enterGapMs\?\.\(ptyId, req\.text\.length\) \?\? GAP_MS\);/);
  assert.match(read('src/main/automaticSubmitWiring.ts'), /enterGapMs: \(ptyId, textLength\) => \{[\s\S]*?automaticEnterGapMs\(provider, textLength\)/);
  assert.match(read('src/renderer/src/components/terminalPool.ts'), /const has = needleMatcher\(needle\);[\s\S]*?onPromptRow: has\(promptLine\.translateToString\(true\)\)/);
});
