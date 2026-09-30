'use strict';

/**
 * WAKE-SCREEN-GUARD (1.1.76): automatic delivery never types into a Codex screen that is not
 * the post-handoff chat composer (ZT-175: a wake typed into Codex's folder-trust screen,
 * where `n` means Quit).
 *
 * Design of record: andy-scratch/ZT175-TRUST-QUIT.md, round 3 + FINAL (Jim V1, god 131cd3).
 *   condition 1  the Codex process is past startup, latched per PTY incarnation: the NEWEST
 *                header in the whole buffer shows a real model and no Resuming/Forking line
 *                follows it; or no header is left and the status line (M3) names the spawn cwd.
 *   condition 2  a FRESH reading for every request: the empty composer (STAGE), or exactly our
 *                own staged text (COMMIT / REENTER), with no PTY output since that reading.
 *
 * FIXTURES. `fixtures/wake-screen-guard/*.json` are the REAL codex 0.157.1 screens of the
 * WSG capture (andy-scratch/WSG-CAPTURE.md, verified by Jim, round 4): each is an offline xterm
 * replay of the captured PTY bytes, identical to the capture's own buffer dump, with the
 * cursor row the replay reports. `fixtures/wake-screen-guard/trust/*.snap` are codex's own
 * insta snapshots of the directory-trust screen (tui/src/onboarding/snapshots, rust-v0.157.1).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const ROOT = path.resolve(__dirname, '..');
const SHARED = loadTs('src/shared/codexScreen.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const GUARD = loadTs('src/main/codexScreenGuard.ts');
const WIRING = loadTs('src/main/automaticSubmitWiring.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');
/** The capture's spawn cwd (Codex prints it in the header and the status line). */
const CWD = 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b';

function fixture(name) {
  const fx = JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
  assert.ok(Array.isArray(fx.lines) && Number.isInteger(fx.cursorRow), `${name}: lines + cursorRow`);
  return fx;
}

/** A codex insta snapshot as screen rows (quoted `terminal.backend()` rows or plain text). */
function snap(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const body = text.split('\n---\n').slice(1).join('\n---\n');
  const rows = body.split('\n').map((l) => (/^".*"$/.test(l) ? JSON.parse(l) : l));
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  let cursorRow = -1;
  rows.forEach((l, i) => { if (l.trimStart().startsWith('\u203a ')) cursorRow = i; });
  return { lines: rows, cursorRow: cursorRow >= 0 ? cursorRow : rows.length - 1 };
}

const facts = (fx, S = SHARED) => S.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow);

// The real screens, by what they are.
const POSITIVES = ['2-trusted-handoff-120x40', '2-trusted-idle-80x24', '2-trusted-after-keystroke', '4-resume-resumed-120x40', '4-resume-resumed-80x24'];
const DRAFTS = ['2-trusted-draft', '4-resume-resumedraft', '1-untrusted-trust-120x40', '1-untrusted-trust-80x24'];
const TRUST_SNAPS = fs.readdirSync(path.join(FX, 'trust')).filter((f) => f.endsWith('.snap')).map((f) => path.join(FX, 'trust', f));

// ─── The shared reader: condition 1 on the real screens ─────────────────────────────────

const K = {};

K.realPositivesOpen = (S = SHARED) => {
  for (const name of POSITIVES) {
    const f = facts(fixture(name), S);
    assert.equal(f.header, 'MODEL', `${name}: the newest header shows the real model`);
    assert.deepEqual(S.codexPastStartup(f, CWD), { open: true, reason: 'header-model' }, `${name}: CONDITION 1 OPENS on the post-handoff screen`);
    assert.equal(S.classifyCodexComposer(f).cls, 'READY', `${name}: the cursor is on the empty composer`);
  }
};

K.realDraftsRefuse = (S = SHARED) => {
  for (const name of DRAFTS) {
    const f = facts(fixture(name), S);
    const v = S.codexPastStartup(f, CWD);
    assert.equal(v.open, false, `${name}: CONDITION 1 REFUSES the startup draft (${JSON.stringify(v)})`);
    assert.equal(v.reason, 'header-loading', `${name}: refused for its loading header`);
  }
  // The draft's composer row is the SAME as the real one: condition 2 alone cannot tell.
  assert.equal(S.classifyCodexComposer(facts(fixture('2-trusted-draft'), S)).cls, 'READY', 'the draft looks like a composer - which is why condition 1 exists');
};

test('CONDITION 1 opens on every real post-handoff screen (fresh and resumed, 120x40 and 80x24, after a shell command)', () => K.realPositivesOpen());
test('CONDITION 1 refuses every real startup draft (fresh, resume, and run 1\'s draft stuck for 20 s)', () => K.realDraftsRefuse());

test('the resume draft is refused for the loading header, and a Resuming line under a real header is refused too', () => {
  const draft = facts(fixture('4-resume-resumedraft'));
  assert.equal(draft.startingAfterHeader, true, 'the capture shows "Resuming session…" under the draft header');
  const real = fixture('2-trusted-handoff-120x40');
  const lines = [...real.lines];
  lines.splice(real.cursorRow, 0, '  Resuming session\u2026');
  const f = SHARED.extractCodexScreen((i) => lines[i], lines.length, real.cursorRow + 1);
  assert.deepEqual(SHARED.codexPastStartup(f, CWD), { open: false, reason: 'session-starting' });
});

K.newestHeaderOnly = (S = SHARED) => {
  const draft = fixture('2-trusted-draft');
  const real = fixture('2-trusted-handoff-120x40');
  const header = (fx) => fx.lines.slice(0, fx.lines.findIndex((l) => l.startsWith('\u2570')) + 1);
  // A draft header ABOVE a real one never counts...
  const a = [...header(draft), ...real.lines];
  assert.equal(S.codexPastStartup(S.extractCodexScreen((i) => a[i], a.length, header(draft).length + real.cursorRow), CWD).open, true, 'ONLY THE NEWEST HEADER COUNTS: a draft header above the real one');
  // ...and a real header above a later loading header does not open.
  const b = [...header(real), ...draft.lines];
  assert.deepEqual(S.codexPastStartup(S.extractCodexScreen((i) => b[i], b.length, header(real).length + draft.cursorRow), CWD), { open: false, reason: 'header-loading' }, 'ONLY THE NEWEST HEADER COUNTS: a real header above a later loading one');
  // A header scrolled far into scrollback is still read (a long resume replay).
  const c = [...header(real), ...Array.from({ length: 5000 }, (_, i) => `history ${i}`), ...real.lines.slice(header(real).length)];
  const cursor = c.length - (real.lines.length - real.cursorRow);
  assert.equal(S.codexPastStartup(S.extractCodexScreen((i) => c[i], c.length, cursor), CWD).open, true, 'a header deep in scrollback is read');
};
test('K3: only the NEWEST header counts, over the whole buffer, scrollback included', () => K.newestHeaderOnly());

test('a transcript line that merely mentions the header is not a header', () => {
  const real = fixture('2-trusted-handoff-120x40');
  const lines = [...real.lines];
  lines.splice(real.cursorRow - 1, 0, '• the screen showed >_ OpenAI Codex (v0.157.1) and model: loading');
  const f = SHARED.extractCodexScreen((i) => lines[i], lines.length, real.cursorRow + 1);
  assert.equal(f.header, 'MODEL', 'the real box above it is still the newest header');
});

K.trustRefuses = (S = SHARED) => {
  assert.equal(TRUST_SNAPS.length, 9, 'all nine codex 0.157.1 trust-directory snapshots');
  const draft = fixture('2-trusted-draft');
  for (const file of TRUST_SNAPS) {
    const t = snap(file);
    const alone = S.extractCodexScreen((i) => t.lines[i], t.lines.length, t.cursorRow);
    assert.equal(S.codexPastStartup(alone, CWD).open, false, `${path.basename(file)}: TRUST SCREEN REFUSED (condition 1)`);
    assert.equal(S.classifyCodexComposer(alone).cls, 'UNKNOWN', `${path.basename(file)}: TRUST SCREEN REFUSED (condition 2)`);
    // ZT-175's shape: the startup draft, then trust drawn below it.
    const lines = [...draft.lines, ...t.lines];
    const after = S.extractCodexScreen((i) => lines[i], lines.length, draft.lines.length + t.cursorRow);
    assert.deepEqual(S.codexPastStartup(after, CWD), { open: false, reason: 'header-loading' }, `${path.basename(file)}: TRUST SCREEN REFUSED after the draft`);
  }
};
test('the nine codex trust-directory snapshots are refused, alone and after the startup draft', () => K.trustRefuses());

test('V1 fallback: no header left + the M3 status line naming the spawn cwd OPENS; without it REFUSES', () => {
  const real = fixture('2-trusted-handoff-120x40');
  const noHeader = real.lines.slice(real.lines.findIndex((l) => l.startsWith('\u2570')) + 1);
  const cursor = real.cursorRow - (real.lines.length - noHeader.length);
  const withM3 = SHARED.extractCodexScreen((i) => noHeader[i], noHeader.length, cursor);
  assert.equal(withM3.header, 'NONE');
  assert.deepEqual(SHARED.codexPastStartup(withM3, CWD), { open: true, reason: 'status-line' }, 'synthetic buffer with no header and M3: OPENS');
  const without = noHeader.filter((l) => !l.includes('\u00b7 C:\\'));
  const noM3 = SHARED.extractCodexScreen((i) => without[i], without.length, cursor);
  assert.deepEqual(SHARED.codexPastStartup(noM3, CWD), { open: false, reason: 'no-marker' }, 'synthetic buffer with no header and no M3: REFUSES');
  // M3 must name THIS agent's spawn cwd, and is never enough on its own under a loading header.
  assert.equal(SHARED.codexPastStartup(withM3, 'C:\\somewhere\\else').open, false, 'a status line for another cwd is not M3');
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 C:\\Dunder\\\u2026\\dir-b', CWD), 'a middle-elided cwd still matches head and tail');
  assert.equal(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 D:\\\u2026\\dir-b', CWD), false);
});

test('condition 2 is allowlist-only: transient footers, other composers and drafts are UNKNOWN', () => {
  const base = facts(fixture('2-trusted-handoff-120x40'));
  const with_ = (over) => ({ ...base, ...over });
  assert.equal(SHARED.classifyCodexComposer(base).cls, 'READY');
  for (const footer of [['  ? / esc close'], ['ctrl + c again to quit'], ['esc again to edit previous message']]) {
    assert.equal(SHARED.classifyCodexComposer(with_({ footer })).cls, 'UNKNOWN', `transient footer ${footer}`);
  }
  for (const cursorRow of ['\u203a hello', '\u203a Ask a follow-up question', '\u203a 1. Update now', '  Viewing sub-agent \u2014 direct input is disabled', '']) {
    assert.equal(SHARED.classifyCodexComposer(with_({ cursorRow })).cls, 'UNKNOWN', `not the empty composer: ${JSON.stringify(cursorRow)}`);
  }
  assert.equal(SHARED.classifyCodexComposer(with_({ cursorRow: '\u203a our text' }), true).cls, 'READY_OWN_DRAFT');
  assert.equal(SHARED.classifyCodexComposer(with_({ cursorRow: '\u203a our text', footer: ['? / esc close'] }), true).cls, 'UNKNOWN', 'an overlay beats even our own draft');
});

test('the facts that cross IPC are validated: a malformed reading is no reading', () => {
  const ok = facts(fixture('2-trusted-handoff-120x40'));
  assert.deepEqual(SHARED.asCodexScreenFacts(ok), ok);
  for (const bad of [null, 1, {}, { ...ok, header: 'OPEN' }, { ...ok, footer: 'x' }, { ...ok, footer: Array(7).fill('x') }, { ...ok, cursorRow: 'x'.repeat(401) }, { ...ok, startingAfterHeader: 'no' }]) {
    assert.equal(SHARED.asCodexScreenFacts(bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

// ─── The owner: the gate in the one submit transaction ──────────────────────────────────

const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };
const TEXT = '[hive] check inbox';

/**
 * A Codex terminal whose screen is a real fixture: `r.screen` names it; once the owner stages,
 * the composer holds exactly what it typed (and typing is PTY output: the generation moves).
 */
function rig(over = {}, Owner = OWNER.AutomaticSubmitOwner) {
  const r = {
    now: 1_000_000, seq: 0, timers: [], writes: [], reads: [], guard: [],
    incarnation: 1, gen: 10, human: 0, prompt: '', screen: '2-trusted-handoff-120x40', provider: 'codex',
    ...over
  };
  r.facts = (tail) => {
    const f = facts(fixture(r.screen));
    return r.prompt ? { ...f, cursorRow: `\u203a ${r.prompt}` } : f;
  };
  const setTimer = (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; };
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => r.incarnation,
    humanGeneration: () => r.human,
    write: (_id, d) => {
      r.writes.push(d);
      if (d === '\r') r.prompt = ''; else r.prompt += d;
      r.gen += 1;                                   // the TUI's echo
      if (r.onWrite) r.onWrite(d);
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: () => Promise.resolve(null),
    capacity: { admit: () => ALLOW, revalidate: () => ALLOW, confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => r.now,
    setTimer,
    screenGuard: () => (r.provider === 'codex' ? 'ENFORCE' : 'OFF'),
    readGuardScreen: (_id, tail) => {
      const stamp = { incarnation: r.stampIncarnation ?? r.incarnation, outputGeneration: r.gen };
      r.reads.push(tail === undefined ? 'empty?' : 'own?');
      if (r.noReading) return Promise.resolve(null);
      const reading = { facts: r.facts(tail), ...stamp, ...(tail === undefined ? {} : { promptTailMatches: r.prompt.endsWith(tail) }) };
      if (r.afterRead) r.afterRead(reading);
      return Promise.resolve(reading);
    },
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: (rec) => r.guard.push(rec),
    ...(over.deps ?? {})
  };
  r.owner = new Owner(r.deps);
  r.settle = async (promise) => {
    let done = false; let value;
    promise.then((v) => { done = true; value = v; });
    for (let i = 0; i < 5000; i += 1) {
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
  r.submit = (id = 'w1', cls = 'CAPACITY_GATED', extra = {}) => r.settle(r.owner.submit({ requestId: id, agentId: 'dwight', admissionClass: cls, text: TEXT, ...extra }));
  return r;
}

K.postHandoffAdmits = async (Owner) => {
  const r = rig({}, Owner);
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'COMMITTED' }, 'a fresh spawn with no turn: the first wake is ADMITTED on the post-handoff composer');
  assert.deepEqual(r.writes, [TEXT, '\r'], 'the text, then Enter');
  assert.deepEqual(r.reads, ['empty?', 'own?'], 'one fresh reading before STAGE, one after the echo');
};

K.startupDraftTypesNothing = async (Owner) => {
  for (const screen of DRAFTS) {
    const r = rig({ screen }, Owner);
    const out = await r.submit();
    assert.equal(r.writes.length, 0, `${screen}: STARTUP DRAFT TYPES NOTHING - no text, no Enter`);
    assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:header-loading' }, `${screen}: named refusal`);
  }
};

K.trustTypesNothing = async (Owner) => {
  for (const file of TRUST_SNAPS) {
    const r = rig({}, Owner);
    const t = snap(file);
    r.facts = () => SHARED.extractCodexScreen((i) => t.lines[i], t.lines.length, t.cursorRow);
    const out = await r.submit();
    assert.equal(r.writes.length, 0, `${path.basename(file)}: TRUST SCREEN RECEIVES NEITHER TEXT NOR CR`);
    assert.equal(out.reason, 'SCREEN_NOT_READY');
  }
};

test('a fresh Codex spawn with no turn: the first wake is admitted once the post-handoff composer is on screen', () => K.postHandoffAdmits());
test('a resumed Codex session with no turn is admitted on its resumed composer (120x40 and 80x24)', async () => {
  for (const screen of ['4-resume-resumed-120x40', '4-resume-resumed-80x24']) {
    const r = rig({ screen });
    assert.deepEqual(await r.submit(), { kind: 'COMMITTED' }, screen);
    assert.deepEqual(r.writes, [TEXT, '\r']);
  }
});
test('every startup draft (fresh, resume, stuck) gets no text and no Enter, for every admission class', async () => {
  await K.startupDraftTypesNothing();
  for (const cls of ['BOOT_SEQUENCE', 'USER_RELEASED']) {
    const r = rig({ screen: '2-trusted-draft' });
    const out = await r.submit('b1', cls);
    assert.equal(r.writes.length, 0, `${cls}: nothing typed into the draft`);
    assert.equal(out.reason, 'SCREEN_NOT_READY');
  }
});
test('the directory-trust screen receives neither the wake text nor CR', () => K.trustTypesNothing());

K.latchIsPerIncarnation = async (Owner) => {
  // A screen whose header has scrolled away and whose status line is off: no marker at all.
  const real = fixture('2-trusted-handoff-120x40');
  const markerless = { header: 'NONE', startingAfterHeader: false, cursorRow: SHARED.CODEX_EMPTY_COMPOSER_ROW, footer: ['? for shortcuts'] };
  const r = rig({}, Owner);
  assert.deepEqual(await r.submit('a'), { kind: 'COMMITTED' }, 'incarnation 1 latched on its real composer');
  r.facts = (tail) => (r.prompt ? { ...markerless, cursorRow: `\u203a ${r.prompt}` } : markerless);
  assert.deepEqual(await r.submit('b'), { kind: 'COMMITTED' }, 'the latch carries a markerless composer of the SAME incarnation');
  r.incarnation = 2;                                  // a respawn under the same PTY id
  const out = await r.submit('c');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:no-marker' }, 'A LATCH NEVER CROSSES A PTY INCARNATION');
  void real;
};
test('the post-handoff latch is per PTY incarnation', () => K.latchIsPerIncarnation());

test('READY from terminalReady (the old latch) cannot satisfy the gate', async () => {
  const r = rig({ screen: '2-trusted-draft' });
  let asked = 0;
  r.deps.terminalReady = () => { asked += 1; return 'READY'; };
  const out = await r.submit();
  assert.ok(asked > 0, 'terminalReady said READY');
  assert.equal(r.writes.length, 0);
  assert.equal(out.reason, 'SCREEN_NOT_READY');
});

test('the latch still refuses a LOADING header of the same incarnation (the widget reconfiguring)', async () => {
  const r = rig();
  assert.deepEqual(await r.submit('a'), { kind: 'COMMITTED' });
  r.screen = '2-trusted-draft';
  assert.deepEqual(await r.submit('b'), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:header-loading' });
});

test('no reading, a late reading, a malformed reading, or no reader at all: refused, nothing typed', async () => {
  const r1 = rig({ noReading: true });
  assert.deepEqual(await r1.submit(), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'no-reading' });
  const r2 = rig();
  r2.deps.readGuardScreen = () => new Promise(() => {});         // never answers: the owner times out
  assert.deepEqual(await r2.submit(), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'no-reading' });
  const r3 = rig();
  r3.deps.readGuardScreen = () => Promise.resolve({ facts: null, incarnation: 1, outputGeneration: 10 });
  assert.equal((await r3.submit()).detail, 'no-reading');
  const r4 = rig({ deps: { readGuardScreen: undefined } });
  assert.equal((await r4.submit()).detail, 'no-reading', 'ENFORCE with no reader is fail-closed');
  for (const r of [r1, r2, r3, r4]) assert.equal(r.writes.length, 0);
});

test('a reading stamped for an older incarnation cannot authorize the live one', async () => {
  const r = rig({ stampIncarnation: 0 });
  assert.deepEqual(await r.submit(), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'incarnation' });
  assert.equal(r.writes.length, 0);
});

K.outputBeforeStageRefuses = async (Owner) => {
  // Output lands after the screen was read and before STAGE (a trust screen being drawn).
  const r = rig({}, Owner);
  r.afterRead = () => { if (r.writes.length === 0) r.gen += 1; };
  const out = await r.submit();
  assert.equal(r.writes.length, 0, 'OUTPUT AFTER THE READING: NO STAGE');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_CHANGED', detail: 'output after the screen reading' });
};
test('output-generation drift between the first reading and STAGE: nothing typed', () => K.outputBeforeStageRefuses());

K.outputBeforeEnterHolds = async (Owner) => {
  // After our echo, every post-stage reading is followed by more output: no Enter, ever.
  const r = rig({}, Owner);
  r.afterRead = () => { if (r.writes.length === 1) r.gen += 1; };
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT], 'OUTPUT AFTER THE POST-STAGE READING: NO ENTER');
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'SCREEN_NOT_VERIFIED_AFTER_STAGE', detail: 'output after every reading' });
};
test('output after the post-stage reading, every time: no Enter, held for a person', () => K.outputBeforeEnterHolds());

test('output after the post-stage reading ONCE: a fresh reading, then the Enter', async () => {
  const r = rig();
  let bumped = false;
  r.afterRead = () => { if (r.writes.length === 1 && !bumped) { bumped = true; r.gen += 1; } };
  assert.deepEqual(await r.submit(), { kind: 'COMMITTED' });
  assert.deepEqual(r.writes, [TEXT, '\r']);
  assert.deepEqual(r.reads, ['empty?', 'own?', 'own?']);
});

test('the screen changes after STAGE (our text no longer the composer): no Enter, held', async () => {
  const r = rig();
  r.onWrite = (d) => { if (d === TEXT) r.screen = '2-trusted-draft'; };
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT], 'no Enter');
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(out.reason, 'SCREEN_NOT_VERIFIED_AFTER_STAGE');
  assert.equal(r.reads.filter((x) => x === 'own?').length, OWNER.SCREEN_COMMIT_READS, 'bounded re-reads');
});

test('a human key in the gap is still HUMAN_INPUT_AFTER_STAGE, not a screen failure', async () => {
  const r = rig();
  // The person's key lands 40 ms into the gap, after our text.
  r.onWrite = (d) => { if (d === TEXT) r.timers.push({ at: r.now + 40, seq: (r.seq += 1), fn: () => { r.human += 1; r.prompt += 'x'; r.gen += 1; } }); };
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.deepEqual(r.writes, [TEXT]);
});

test('an existing human draft refuses; the owner\'s own draft is re-entered only with a fresh own-draft reading', async () => {
  const human = rig();
  human.prompt = 'half a sentence';
  assert.deepEqual(await human.submit(), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'UNKNOWN:not-the-empty-composer' });
  assert.equal(human.writes.length, 0);
  // Our own earlier text left unsent in the composer (WAKE-SELF-TEXT-HOLD).
  const own = rig();
  own.deps.readScreen = () => Promise.resolve({ onPromptRow: true, screenCount: 1, promptTailMatches: own.prompt.endsWith(TEXT) });
  own.deps.write = (_id, d) => { own.writes.push(d); if (d === '\r' && own.dropFirstEnter) { own.dropFirstEnter = false; return { ok: true }; } if (d === '\r') own.prompt = ''; else own.prompt += d; own.gen += 1; return { ok: true }; };
  own.dropFirstEnter = true;
  assert.deepEqual(await own.submit('x1'), { kind: 'COMMITTED' });
  assert.equal(own.prompt, TEXT, 'the TUI kept our text unsent');
  const again = await own.submit('x2', 'CAPACITY_GATED', { priorText: TEXT });
  assert.deepEqual(again, { kind: 'COMMITTED' });
  assert.deepEqual(own.writes, [TEXT, '\r', '\r'], 'one extra Enter on our own draft, no second copy');
  assert.equal(own.reads.at(-1), 'own?', 'and it was read as our own draft first');
});

test('non-Codex providers are unchanged: no screen reading, the same writes', async () => {
  for (const provider of ['claude', 'gemini', 'agy', 'grok', 'kimi', 'custom']) {
    const r = rig({ provider, screen: '2-trusted-draft' });
    assert.deepEqual(await r.submit(), { kind: 'COMMITTED' }, provider);
    assert.deepEqual(r.writes, [TEXT, '\r']);
    assert.deepEqual(r.reads, [], `${provider}: the Codex gate is not consulted`);
  }
});

test('R2-4: a SessionStart latch of the LIVE incarnation opens condition 1; a replaced incarnation does not', async () => {
  const markerless = { header: 'NONE', startingAfterHeader: false, cursorRow: SHARED.CODEX_EMPTY_COMPOSER_ROW, footer: [] };
  const r = rig();
  r.facts = () => (r.prompt ? { ...markerless, cursorRow: `\u203a ${r.prompt}` } : markerless);
  assert.equal(r.owner.latchPostHandoff('p1', 0), false, 'a stale incarnation latches nothing');
  assert.equal((await r.submit('a')).detail, 'startup:no-marker');
  assert.equal(r.owner.latchPostHandoff('p1', 1), true);
  assert.equal(r.owner.postHandoffLatched('p1'), true);
  assert.deepEqual(await r.submit('b'), { kind: 'COMMITTED' });
  r.incarnation = 2;
  assert.equal(r.owner.postHandoffLatched('p1'), false);
});

test('every refusal is a diagnostic record: phase, reason, incarnation, generations - never screen text', async () => {
  const r = rig({ screen: '2-trusted-draft' });
  await r.submit();
  assert.equal(r.guard.length, 1);
  const rec = r.guard[0];
  assert.deepEqual(Object.keys(rec).sort(), ['admissionClass', 'agentId', 'currentGeneration', 'incarnation', 'latched', 'observedGeneration', 'ok', 'phase', 'ptyId', 'reason', 'requestId']);
  assert.deepEqual([rec.phase, rec.ok, rec.reason, rec.incarnation, rec.observedGeneration, rec.currentGeneration, rec.latched], ['STAGE', false, 'startup:header-loading', 1, 10, 10, false]);
});

// ─── The per-incarnation token and the alert ────────────────────────────────────────────

test('R2-4 tokens: only the live incarnation of the named agent\'s PTY resolves; a stale token is refused', () => {
  const t = new GUARD.WakeIncarnationTokens();
  const live = { pty: { dwight: 'p1' }, inc: { p1: 7 } };
  const view = { ptyForAgent: (a) => live.pty[a], incarnation: (p) => live.inc[p] };
  const a = GUARD.WakeIncarnationTokens.mint();
  assert.ok(a.length >= 20 && a !== GUARD.WakeIncarnationTokens.mint(), 'unguessable, fresh each spawn');
  t.register(a, 'dwight', 'p1', 7);
  assert.deepEqual(t.resolve(a, 'dwight', view), { ptyId: 'p1', incarnation: 7 });
  assert.equal(t.resolve(a, 'jim', view), null, 'another agent cannot use it');
  assert.equal(t.resolve('forged', 'dwight', view), null);
  live.inc.p1 = 8;                                    // replaced, before the new token registered
  assert.equal(t.resolve(a, 'dwight', view), null, 'A HOOK FROM A REPLACED INCARNATION, CARRYING THE OLD TOKEN, IS REFUSED');
  const b = GUARD.WakeIncarnationTokens.mint();
  t.register(b, 'dwight', 'p1', 8);
  assert.equal(t.resolve(a, 'dwight', view), null, 'the old token is forgotten');
  assert.deepEqual(t.resolve(b, 'dwight', view), { ptyId: 'p1', incarnation: 8 });
  t.forgetPty('p1');
  assert.equal(t.size, 0);
});

test('F5: one alert after SCREEN_GUARD_ALERT_MS of unbroken refusals; an admission or a respawn resets it', () => {
  const w = new GUARD.ScreenGuardAlertWatch();
  const T = GUARD.SCREEN_GUARD_ALERT_MS;
  assert.equal(w.note('d', false, 'startup:header-loading', 0), null);
  assert.equal(w.note('d', false, 'startup:header-loading', T - 1), null);
  assert.deepEqual(w.note('d', false, 'no-reading', T), { agentId: 'd', reason: 'no-reading', refusedMs: T, refusals: 3 });
  assert.equal(w.note('d', false, 'no-reading', T * 2), null, 'once per run');
  assert.equal(w.note('d', true, 'ok', T * 2), null);
  assert.equal(w.note('d', false, 'x', T * 3), null, 'a new run starts after an admission');
  w.clear('d');
  assert.equal(w.note('d', false, 'x', T * 3 + T - 1), null);
});

// ─── The wiring: the stamp, the broker, the provider scope ──────────────────────────────

test('wiring: the reading is stamped with the incarnation and generation AT REQUEST TIME', async () => {
  const pty = { gen: 4, incarnation: () => 3, outputGeneration: () => pty.gen, spawnCwd: () => CWD };
  let sent = 0;
  const deps = WIRING.buildOwnerDeps({
    pty, capacity: {}, ptyForAgent: () => 'p1', providerForPty: (p) => (p === 'p1' ? 'codex' : 'claude'),
    requestScreenReading: () => Promise.resolve(null),
    requestCodexScreen: () => { sent += 1; pty.gen += 2; return Promise.resolve({ onPromptRow: false, screenCount: 0, codex: facts(fixture('2-trusted-handoff-120x40')) }); }
  });
  assert.equal(deps.screenGuard('p1'), 'ENFORCE');
  assert.equal(deps.screenGuard('p2'), 'OFF');
  const got = await deps.readGuardScreen('p1');
  assert.equal(sent, 1);
  assert.equal(got.incarnation, 3);
  assert.equal(got.outputGeneration, 4, 'OUTPUT DURING THE ROUND TRIP IS NOT COVERED BY THE READING');
  assert.equal(deps.outputGeneration('p1'), 6);
  const bad = WIRING.buildOwnerDeps({ ...{ pty, capacity: {}, ptyForAgent: () => 'p1', providerForPty: () => 'codex', requestScreenReading: () => Promise.resolve(null) },
    requestCodexScreen: () => Promise.resolve({ onPromptRow: false, screenCount: 0, codex: { header: 'MODEL' } }) });
  assert.equal(await bad.readGuardScreen('p1'), null, 'malformed facts are no reading');
});

test('broker: a Codex request says so; a malformed Codex answer is no answer', async () => {
  const sent = [];
  const b = new WIRING.ScreenReadingBroker((...a) => { sent.push(a); return true; }, 10_000, () => ({}));
  const p = b.request('p1', '', 'tail', true);
  assert.deepEqual(sent[0].slice(2), ['', 'tail', true]);
  const f = facts(fixture('2-trusted-handoff-120x40'));
  b.answer(sent[0][1], { onPromptRow: false, screenCount: 0, promptTailMatches: false, codex: f });
  assert.deepEqual(await p, { onPromptRow: false, screenCount: 0, promptTailMatches: false, codex: f });
  const q = b.request('p1', '', undefined, true);
  b.answer(sent[1][1], { onPromptRow: false, screenCount: 0, codex: { header: 'MODEL' } });
  assert.equal(await q, null);
  const plain = b.request('p1', 'needle');
  assert.equal(sent[2].length, 4, 'the ordinary oracle request is unchanged');
  b.answer(sent[2][1], { onPromptRow: true, screenCount: 1 });
  assert.deepEqual(await plain, { onPromptRow: true, screenCount: 1 });
});

test('PtyManager: every accepted chunk moves the output generation; a stale process\'s chunk does not', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const s = { id: 'p1', cwd: CWD, command: '', owner: null, lastOutputAt: 0, hasOutput: false, humanInputGeneration: 0, incarnation: 1, tail: '', proc: { write() {} } };
  pm.sessions.set('p1', s);
  assert.equal(pm.outputGeneration('p1'), 0);
  assert.equal(pm.spawnCwd('p1'), CWD);
  pm.deliverData('p1', s, 'a');
  pm.deliverData('p1', s, 'b');
  assert.equal(pm.outputGeneration('p1'), 2);
  pm.deliverData('p1', { ...s }, 'stale');            // a replaced process's late output
  assert.equal(pm.outputGeneration('p1'), 2);
  assert.equal(pm.outputGeneration('nope'), undefined);
});

// ─── R2-2: no update prompt on any Codex argv ───────────────────────────────────────────

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'check_for_update_on_startup = true\nmodel = "gpt-x"\n');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => hive.dispose());
  return { home, hive };
}

K.codexArgvHasNoUpdateKey = async (t, hiveTs) => {
  const s = sandbox(t);
  const codex = await s.hive.ensureAgent({ id: 'dwight-a', name: 'Dwight', provider: 'codex', cwd: s.home }, { codexNoDaemon: true });
  const i = codex.args.indexOf('check_for_update_on_startup=false');
  assert.ok(i > 0 && codex.args[i - 1] === '-c', 'EVERY CODEX ARGV CARRIES -c check_for_update_on_startup=false');
  assert.equal(codex.args.filter((a) => a === 'check_for_update_on_startup=false').length, 1);
  // `codex resume <sid> [OPTIONS]` is built from these same args (index.ts: [resume, sid, ...args]); -c is global.
  const cfg = fs.readFileSync(path.join(codex.env.CODEX_HOME, 'config.toml'), 'utf8');
  const lines = cfg.split(/\r?\n/).filter((l) => /^\s*check_for_update_on_startup\s*=/.test(l));
  assert.deepEqual(lines, ['check_for_update_on_startup = false'], 'THE AGENT CONFIG SAYS false, once, replacing the seed\'s true');
  const claude = await s.hive.ensureAgent({ id: 'jim-c', name: 'Jim', provider: 'claude', cwd: s.home }, {});
  assert.equal(claude.args.includes('check_for_update_on_startup=false'), false, 'Codex only');
  void hiveTs;
};
test('R2-2: every Codex argv carries -c check_for_update_on_startup=false, and its config.toml says false', (t) => K.codexArgvHasNoUpdateKey(t));

test('R2-2: the top-level writer keeps booleans (it used to drop them) and replaces a seed line', () => {
  const { setCodexTopLevelKeys, setCodexRootTableKeys } = loadTs('src/main/codexAgentConfig.ts');
  const out = setCodexTopLevelKeys('check_for_update_on_startup = true\n[tui]\nx = 1', { check_for_update_on_startup: false, model_auto_compact_token_limit: 120000.7 });
  assert.match(out, /^# --- munder-hive: per-agent token limits and startup settings/);
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('check_for_update_on_startup')), ['check_for_update_on_startup = false']);
  assert.ok(out.includes('model_auto_compact_token_limit = 120000'));
  assert.ok(out.includes('[tui]\nx = 1'), 'tables kept');
  assert.equal(setCodexRootTableKeys('', '', { check_for_update_on_startup: false }).includes('check_for_update_on_startup = false'), true);
});

// ─── R2-4: the hook shim carries the token ──────────────────────────────────────────────

test('R2-4: the REAL hook shim copies MUNDER_WAKE_INCARNATION into the payload and strips a forged one', async (t) => {
  const { HOOK_SHIM } = loadTs('src/main/hive.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'cth-hook.cjs');
  fs.writeFileSync(shim, HOOK_SHIM);
  const run = async (env, payload) => {
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\wsg-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, `${Math.random()}.sock`);
    let got = null;
    const server = net.createServer((c) => { let buf = ''; c.setEncoding('utf8'); c.on('data', (d) => { buf += d; if (buf.includes('\n')) { got = JSON.parse(buf.split('\n')[0]); c.end('{}'); } }); });
    await new Promise((r) => server.listen(sock, r));
    try {
      await new Promise((resolve, reject) => {
        const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HIVE_|AGENT_|MUNDER_)/i.test(k)));
        const child = spawn(process.execPath, [shim], { env: { ...base, AGENT_ID: 'dwight', HIVE_SOCK: sock, ...env }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        child.on('error', reject); child.on('close', resolve);
        child.stdin.end(JSON.stringify(payload));
      });
    } finally { server.close(); }
    return got;
  };
  const withToken = await run({ MUNDER_WAKE_INCARNATION: 'tok-1' }, { hook_event_name: 'SessionStart', munder_wake_incarnation: 'forged' });
  assert.equal(withToken.munder_wake_incarnation, 'tok-1');
  const without = await run({}, { hook_event_name: 'SessionStart', munder_wake_incarnation: 'forged' });
  assert.equal('munder_wake_incarnation' in without, false, 'a payload cannot bring its own token');
});

test('R2-4 wiring: the spawn env names the token, the hook observer hands it on, only SessionStart latches', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /const wakeToken = provider === 'codex' && opts\.hive\?\.id \? WakeIncarnationTokens\.mint\(\) : null;\s*if \(wakeToken\) opts\.env = \{ \.\.\.\(opts\.env \?\? \{\}\), \[WAKE_INCARNATION_ENV\]: wakeToken \};\s*const res = await ptyManager\.spawn\(opts, owner\);/);
  assert.match(idx, /wakeIncarnationTokens\.register\(wakeToken, opts\.hive\.id, opts\.id, ptyManager\.incarnation\(opts\.id\)\)/);
  assert.match(idx, /function onWakeIncarnation\(agentId: string, token: string\): void \{\s*const proven = wakeIncarnationTokens\.resolve\(token, agentId, [^\n]+\n\s*if \(proven\) automaticSubmit\.latchPostHandoff\(proven\.ptyId, proven\.incarnation\);/);
  assert.match(idx, /\n\);\nhookServer\.setWakeIncarnationObserver\(onWakeIncarnation\);/, 'registered right after the HookServer is built');
  const hooks = readSource('src/main/hooks.ts');
  assert.match(hooks, /if \(!fromSubagent && agentId && event === 'SessionStart' && typeof p\.munder_wake_incarnation === 'string' && p\.munder_wake_incarnation\) \{\s*try \{ this\.onWakeIncarnation\?\.\(agentId, p\.munder_wake_incarnation\.slice\(0, 80\)\); \}/, 'only the agent\'s own SessionStart hands the token on');
});

// ─── The renderer answers with the shared reader ────────────────────────────────────────

test('renderer: a Codex request is answered by readCodexScreen over the whole buffer, behind pending output', () => {
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /import \{ extractCodexScreen, type CodexScreenFacts \} from '@shared\/codexScreen';/);
  assert.match(pool, /const codex = extractCodexScreen\(\(i\) => buf\.getLine\(i\)\?\.translateToString\(true\), buf\.length, cursor\);/);
  assert.match(pool, /entry\.term\.write\('', \(\) => \{\s*const tail = [^\n]+\n\s*window\.cth\.answerScreenReading\(req\.requestId, req\.codex === true\s*\? readCodexScreen\(req\.ptyId, tail\)/);
});

// ─── Full path: reconcile -> requestInboxWake -> the REAL owner -> the PTY ──────────────

K.fullPath = async (t, Owner = OWNER.AutomaticSubmitOwner) => {
  const { WorkerWakeWatchdog, WORKER_WAKE_COOLDOWN_MS } = loadTs('src/main/workerWake.ts');
  const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
  const r = rig({ screen: '2-trusted-draft' }, Owner);
  const immediates = [];
  const coordinator = new WorkerWakeWatchdog();
  const pending = new Set(['m1']);
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [...pending],
    facts: () => ({ ptyId: 'p1', lastOutputAt: r.now - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
    submit: (req) => r.owner.submit(req),
    text: () => TEXT,
    setImmediate: (fn) => immediates.push(fn),
    now: () => r.now
  });
  coordinator.noteHook('dwight', 'Stop', '', r.now - 60_000);
  const beat = async () => {
    bridge.reconcileAll(['dwight']);
    for (let i = 0; i < 400; i += 1) {
      while (immediates.length) immediates.shift()();
      await new Promise((res) => setImmediate(res));
      if (!r.timers.length) break;
      r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = r.timers.shift();
      r.now = Math.max(r.now, next.at);
      next.fn();
    }
  };
  await beat();
  assert.equal(r.writes.length, 0, 'FULL PATH: A BEAT ONTO THE STARTUP DRAFT WRITES NOTHING');
  r.screen = '2-trusted-handoff-120x40';
  r.now += WORKER_WAKE_COOLDOWN_MS + 1_000;       // the refused claim's reconcile cooldown
  await beat();
  assert.deepEqual(r.writes, [TEXT, '\r'], 'FULL PATH: the next beat, on the composer, types the wake and Enter');
};
test('full path: reconcileAll -> requestInboxWake -> the owner -> exactly the PROGRAMMATIC writes the screen allows', (t) => K.fullPath(t));

// ─── Mutants: the proofs must kill the wrong implementations ────────────────────────────

const MUTANT_DIR = path.join(__dirname, '.mutants-wsg');
function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  text = text.replace(/from '\.\/(\w+)'/g, "from '../../src/main/$1'").replace(/from '\.\.\/shared\//g, "from '../../src/shared/");
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const MUTANTS = [
  { name: 'the STAGE gate removed (no screen reading before typing)', file: 'src/main/automaticSubmit.ts',
    edits: [["      const g = await this.screenGate(req, ptyId, incarnation, 'STAGE');\n      if (!g.ok) return this.refuse(decision, 'SCREEN_NOT_READY', g.reason);\n      screenGen = g.gen;\n", '      screenGen = deps.outputGeneration?.(ptyId);\n']],
    killer: 'startupDraftTypesNothing', dies: /STARTUP DRAFT TYPES NOTHING/ },
  { name: 'the gate call and its generation check both removed', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (guard === 'ENFORCE') {\n      // A human-owned prompt", "    if (guard === 'NEVER') {\n      // A human-owned prompt"],
      ["    if (guard === 'ENFORCE' && deps.outputGeneration?.(ptyId) !== screenGen) {", "    if (guard === 'NEVER' && deps.outputGeneration?.(ptyId) !== screenGen) {"]],
    killer: 'trustTypesNothing', dies: /TRUST SCREEN RECEIVES NEITHER TEXT NOR CR/ },
  { name: 'no output-generation check at STAGE', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (guard === 'ENFORCE' && deps.outputGeneration?.(ptyId) !== screenGen) {", "    if (guard === 'NEVER' && deps.outputGeneration?.(ptyId) !== screenGen) {"]],
    killer: 'outputBeforeStageRefuses', dies: /OUTPUT AFTER THE READING: NO STAGE/ },
  { name: 'no output-generation check next to the Enter', file: 'src/main/automaticSubmit.ts',
    edits: [["  if (s.screenGen !== undefined && deps.outputGeneration?.(s.ptyId) !== s.screenGen) return { kind: 'SCREEN_CHANGED' };\n", '']],
    killer: 'outputBeforeEnterHolds', dies: /OUTPUT AFTER THE POST-STAGE READING: NO ENTER/ },
  { name: 'the latch is per PTY, not per incarnation', file: 'src/main/automaticSubmit.ts',
    edits: [['      else if (this.postHandoff.get(ptyId) !== incarnation) verdict', '      else if (!this.postHandoff.has(ptyId)) verdict']],
    killer: 'latchIsPerIncarnation', dies: /A LATCH NEVER CROSSES A PTY INCARNATION/ },
  { name: 'the reader does not see `loading`', file: 'src/shared/codexScreen.ts',
    edits: [["header = m[1] === 'loading' ? 'LOADING' : 'MODEL';", "header = 'MODEL';"]],
    shared: true, killer: 'realDraftsRefuse', dies: /CONDITION 1 REFUSES the startup draft/ },
  { name: 'the reader takes the OLDEST header', file: 'src/shared/codexScreen.ts',
    edits: [['  for (let i = length - 1; i >= 0; i -= 1) {\n    if (isHeaderTitle(line(i) ?? \'\')) { title = i; break; }', '  for (let i = 0; i < length; i += 1) {\n    if (isHeaderTitle(line(i) ?? \'\')) { title = i; break; }']],
    shared: true, killer: 'newestHeaderOnly', dies: /ONLY THE NEWEST HEADER COUNTS/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async (tt) => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        const run = (arg) => (m.shared ? K[m.killer](arg) : K[m.killer](arg && arg.AutomaticSubmitOwner));
        await run(m.shared ? SHARED : OWNER);      // the killer PASSES on the real module...
        let died = null;
        try { await run(mod); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
        void tt;
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
