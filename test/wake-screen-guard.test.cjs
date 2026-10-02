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
const HOOKS = loadTs('src/main/hooks.ts');
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
  const box = lines.findIndex((l) => l.startsWith('\u2570'));
  lines.splice(box + 1, 0, '  Resuming session\u2026');   // directly under the box, as the draft draws it
  const f = SHARED.extractCodexScreen((i) => lines[i], lines.length, real.cursorRow + 1);
  assert.deepEqual(SHARED.codexPastStartup(f, CWD), { open: false, reason: 'session-starting' });
});

// ─── Jim B1: an agent's OWN OUTPUT is never a marker (agents in this hive quote these screens) ──

/** The real post-handoff screen with `extra` rows of agent output inserted under its header. */
function withAgentOutput(extra, S = SHARED) {
  const real = fixture('2-trusted-handoff-120x40');
  const box = real.lines.findIndex((l) => l.startsWith('\u2570'));
  const lines = [...real.lines.slice(0, box + 2), ...extra, ...real.lines.slice(box + 2)];
  return S.extractCodexScreen((i) => lines[i], lines.length, real.cursorRow + extra.length);
}

K.agentOutputIsNotAMarker = (S = SHARED) => {
  const quote = [
    '\u2022 The startup draft looks like this:', '',
    '  \u256d\u2500\u2500\u2500\u2500\u256e',
    '  \u2502 >_ OpenAI Codex (v0.157.1)                 \u2502',
    '  \u2502 model:       loading   /model to change    \u2502',
    '  \u2570\u2500\u2500\u2500\u2500\u256f',
    '  Resuming session\u2026', ''
  ];
  const q = withAgentOutput(quote, S);
  assert.deepEqual([q.header, q.startingAfterHeader], ['MODEL', false], 'B1: A QUOTED DRAFT HEADER IN AGENT OUTPUT IS NOT A MARKER');
  assert.equal(S.codexPastStartup(q, CWD).open, true);
  const lone = withAgentOutput(['\u2022 Codex prints this under the draft header:', '', '  Resuming session\u2026', ''], S);
  assert.deepEqual([lone.header, lone.startingAfterHeader], ['MODEL', false], 'B1: A LONE RESUMING LINE IN AGENT OUTPUT IS NOT A MARKER');
  // The /status card: a column-0 titled box whose row says `Model:`, not `model:`.
  const status = withAgentOutput([
    '\u256d\u2500\u2500\u2500\u2500\u256e',
    '\u2502 >_ OpenAI Codex (v0.157.1)                          \u2502',
    '\u2502                                                     \u2502',
    '\u2502  Model:            loading (reasoning high)         \u2502',
    '\u2502  Directory:        C:\\Dunder\\_work\\dir-b          \u2502',
    '\u2570\u2500\u2500\u2500\u2500\u256f',
    '  Resuming session\u2026'
  ], S);
  assert.equal(status.header, 'MODEL', 'B1: THE /status CARD IS NOT A SESSION HEADER (the real one above it still counts)');
  assert.equal(status.startingAfterHeader, false, 'B1: THE /status CARD IS NOT A SESSION HEADER (the row under it is not a resume line)');
};
test('B1: a quoted draft header, a lone Resuming line and the /status card in agent output are not markers', () => K.agentOutputIsNotAMarker());

test('B1: the /status card alone (no session header left) is no header; M3 decides', () => {
  const card = ['\u256d\u2500\u256e', '\u2502 >_ OpenAI Codex (v0.157.1) \u2502', '\u2502  Model:  gpt-5.5 \u2502', '\u2570\u2500\u256f',
    SHARED.CODEX_EMPTY_COMPOSER_ROW, '  gpt-5.5 high \u00b7 ' + CWD];
  const f = SHARED.extractCodexScreen((i) => card[i], card.length, 4);
  assert.equal(f.header, 'NONE');
  assert.deepEqual(SHARED.codexPastStartup(f, CWD), { open: true, reason: 'status-line' });
});

test('B2: M3 is the LAST " · " segment: a service tier before it, and the ~ form under HOME', () => {
  const home = 'C:\\Users\\someone';
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 ' + CWD, CWD));
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 high priority \u00b7 ' + CWD, CWD), 'a service-tier token');
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 ~\\proj\\a', home + '\\proj\\a', home), '~\\rel under HOME');
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 ~', home, home), '~ itself');
  assert.equal(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 ~\\proj\\a', home + '\\proj\\a'), false, 'no HOME known: ~ is not expanded');
  assert.equal(SHARED.isCodexStatusLine('gpt-5.5 high \u00b7 ~\\proj\\b', home + '\\proj\\a', home), false);
  assert.equal(SHARED.isCodexStatusLine('\u00b7 ' + CWD, CWD), false, 'at least a model comes first');
  assert.ok(SHARED.isCodexStatusLine('gpt-5.5 \u00b7 ' + CWD, CWD), 'ONE word before the cwd is enough (WSG-FOLLOWUPS: an empty effort label)');
  assert.equal(SHARED.isCodexStatusLine(' \u00b7 ' + CWD, CWD), false, 'nothing before the separator');
  const f = { header: 'NONE', startingAfterHeader: false, cursorRow: SHARED.CODEX_EMPTY_COMPOSER_ROW, footer: ['gpt-5.5 high \u00b7 ~\\proj\\a'] };
  assert.equal(SHARED.codexPastStartup(f, home + '\\proj\\a', home).open, true, 'condition 1 takes HOME');
});

test('N1: a reading that covers no PTY output (generation 0) never latches', async () => {
  const r = rig({ gen: 0 });
  r.deps.write = (_id, d) => { r.writes.push(d); if (d === '\r') r.prompt = ''; else r.prompt += d; return { ok: true }; };
  const out = await r.submit();
  assert.equal(r.owner.postHandoffLatched('p1'), false, 'NOT LATCHED FROM A BLANK TERMINAL');
  assert.equal(out.reason, 'SCREEN_NOT_READY');
  assert.equal(r.writes.length, 0);
});

test('N2 + N3: a torn-down PTY forgets its token; a respawn clears the old banner', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /function teardownPty\(id: string[^\n]*\n[\s\S]{0,1400}wakeIncarnationTokens\.forgetPty\(id\);/);
  assert.match(idx, /\/\/ Jim N3: [^\n]*\n\s*screenGuardNotices\.respawned\(opts\.hive\.id\);/);
  assert.match(idx, /clear: \(agentId\) => hive\.mail\.clearScreenGuardAlert\(agentId\)/, 'the notices coordinator clears the mail notice');
  const { MailLedger } = loadTs('src/main/mailLedger.ts');
  const ledger = Object.create(MailLedger.prototype);
  ledger.notices = new Map();
  ledger.log = () => {};
  MailLedger.prototype.noteScreenGuardAlert.call(ledger, 'dwight', 'no-reading', 300_000, 20);
  assert.equal(ledger.notices.has('dwight|screen-guard'), true);
  MailLedger.prototype.clearScreenGuardAlert.call(ledger, 'dwight');
  assert.equal(ledger.notices.has('dwight|screen-guard'), false);
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
    // 1.1.79 (CODEX-MODEL-SWITCH-PROMPT P2): refused, and now NAMED as Codex's popup.
    const comp = S.classifyCodexComposer(alone);
    assert.equal(comp.cls, 'MODAL', `${path.basename(file)}: TRUST SCREEN REFUSED (condition 2), as a Codex popup`);
    assert.equal(comp.reason, 'codex-popup:Folder access', `${path.basename(file)}: the popup is named by its title`);
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
  // WSG LIVENESS: past the slow budget the abort runs; this rig's abort oracle never sees our
  // text, so nothing is cleared and the text is held for a person.
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', detail: 'no screen reading' });
};
test('output after the post-stage reading, every time: no Enter; past the budget an erase that cannot see our text is held', () => K.outputBeforeEnterHolds());

test('output after the post-stage reading ONCE: a fresh reading, then the Enter', async () => {
  const r = rig();
  let bumped = false;
  r.afterRead = () => { if (r.writes.length === 1 && !bumped) { bumped = true; r.gen += 1; } };
  assert.deepEqual(await r.submit(), { kind: 'COMMITTED' });
  assert.deepEqual(r.writes, [TEXT, '\r']);
  assert.deepEqual(r.reads, ['empty?', 'own?', 'own?']);
});

test('the screen changes after STAGE to a Codex STARTUP screen (foreign): no Enter, no slow wait; the erase cannot see our text, so held', async () => {
  const r = rig();
  r.onWrite = (d) => { if (d === TEXT) r.screen = '2-trusted-draft'; };
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT], 'no Enter');
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', detail: 'no screen reading' });
  assert.equal(r.reads.filter((x) => x === 'own?').length, 1, 'foreign: one reading, then the abort');
  assert.equal(r.guard.at(-1).reason, 'startup:header-loading');
});

// ─── WSG LIVENESS (rc/1.1.76 ISO): a SLOW echo is waited for; past the budget, a VERIFIED erase ──

/** The TUI processes (and so echoes) each write `lagMs` late, IN ORDER; only the first `chunks`
 *  writes are delayed. Ctrl-U clears the composer. The abort oracle sees our text in it. */
function laggy(r, lagMs, chunks = Infinity) {
  let n = 0; let last = 0;
  r.deps.write = (_id, d) => {
    r.writes.push(d);
    if (r.enterOnNull && d === '\r' && r.lastGuardNull) r.violations.push('Enter after a null reading');
    const delayed = n < chunks; if (delayed) n += 1;
    const due = Math.max(r.now + (delayed ? lagMs : 0), last); last = due;
    const apply = () => { if (d === '\r' || d === '\x15') r.prompt = ''; else r.prompt += d; r.gen += 1; };
    if (due <= r.now) apply(); else r.timers.push({ at: due, seq: (r.seq += 1), fn: apply });
    return { ok: true };
  };
  r.deps.readScreen = () => Promise.resolve(r.readScreenAs ? r.readScreenAs() : { onPromptRow: r.prompt.includes(TEXT), screenCount: r.prompt.includes(TEXT) ? 1 : 0 });
  return r;
}

K.slowEchoCommits = async (Owner, lagMs = 1500) => {
  const r = laggy(rig({}, Owner), lagMs);
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'COMMITTED' }, `A SLOW ECHO (${lagMs} ms) IS WAITED FOR, THEN ENTERED`);
  assert.deepEqual(r.writes, [TEXT, '\r'], 'the text, then ONE Enter, no erase');
  assert.ok(r.reads.filter((x) => x === 'own?').length > 3, 'more than the old 3 readings');
};
test('WSG LIVENESS: an echo 1.5 s late (Creed ISO repro) is waited for and COMMITTED', () => K.slowEchoCommits());
test('WSG LIVENESS: an echo 5 s late is waited for and COMMITTED', () => K.slowEchoCommits(OWNER.AutomaticSubmitOwner, 5000));

K.noReadingIsNeverEvidence = async (Owner) => {
  const r = rig({ violations: [], enterOnNull: true }, Owner);
  laggy(r, 0);
  let nulls = 6;
  const real = r.deps.readGuardScreen;
  r.deps.readGuardScreen = (id, tail) => {
    if (tail !== undefined && nulls > 0) { nulls -= 1; r.lastGuardNull = true; r.reads.push('own?'); return Promise.resolve(null); }
    r.lastGuardNull = false;
    return real(id, tail);
  };
  const out = await r.submit();
  assert.deepEqual(r.violations, [], 'NO ENTER ON A NULL READING');
  assert.deepEqual(out, { kind: 'COMMITTED' }, 'six missing readings, then a real one: COMMITTED');
  assert.deepEqual(r.writes, [TEXT, '\r']);
};
test('WSG LIVENESS: missing readings (the oracle starved) are re-read, never taken as proof', () => K.noReadingIsNeverEvidence());

K.overBudgetAborts = async (Owner) => {
  // The FIRST write (our text) is processed 12 s late; the clear and everything after are not.
  const r = laggy(rig({}, Owner), 12_000, 1);
  const out = await r.submit('w1');
  assert.deepEqual(r.writes, [TEXT, '\x15'], 'PAST THE BUDGET: A VERIFIED ERASE, NEVER AN ENTER');
  assert.equal(out.kind, 'ABORTED', `PAST THE BUDGET: ABORTED (released for a re-offer), got ${JSON.stringify(out)}`);
  assert.match(out.detail, /^screen-not-verified:/);
  assert.equal(r.prompt, '', 'the composer is empty again');
  // The re-offer, through the normal path: the same owner, a fresh request.
  assert.deepEqual(await r.submit('w2'), { kind: 'COMMITTED' }, 'the re-offer commits');
  assert.deepEqual(r.writes, [TEXT, '\x15', TEXT, '\r']);
};
test('WSG LIVENESS: an echo later than the budget gives a VERIFIED erase (ABORTED), and the re-offer COMMITS', () => K.overBudgetAborts());

K.foreignAborts = async (Owner) => {
  // After STAGE the reading comes from ANOTHER incarnation's screen: foreign, so no slow wait.
  const r = laggy(rig({}, Owner), 0);
  r.onWrite = undefined;
  const realWrite = r.deps.write;
  r.deps.write = (id, d) => { const w = realWrite(id, d); if (d === TEXT) r.stampIncarnation = 2; return w; };
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'ABORTED', detail: 'screen-foreign:incarnation' }, 'A FOREIGN SCREEN IS ERASED (VERIFIED) AT ONCE');
  assert.deepEqual(r.writes, [TEXT, '\x15']);
  assert.equal(r.reads.filter((x) => x === 'own?').length, 1, 'no slow re-reading for a foreign screen');
};
test('WSG LIVENESS: a foreign screen after STAGE is aborted (verified erase) at once, not waited for', () => K.foreignAborts());

test('WSG LIVENESS: the foreign/slow split', () => {
  for (const s of ['incarnation', 'startup:header-loading', 'startup:session-starting', 'startup:no-header']) assert.equal(OWNER.foreignScreenReason(s), true, s);
  for (const s of ['no-reading', 'READY:empty-composer', 'UNKNOWN:not-the-empty-composer', 'UNKNOWN:transient-footer']) assert.equal(OWNER.foreignScreenReason(s), false, s);
});

K.unverifiableEraseHolds = async (Owner) => {
  // Never echoed within the budgets, and the abort oracle never sees our text: no clear at all.
  const never = laggy(rig({}, Owner), 60_000);
  never.readScreenAs = () => ({ onPromptRow: false, screenCount: 0 });
  const a = await never.submit();
  assert.deepEqual(never.writes, [TEXT], 'NO CTRL-U BEFORE OUR TEXT IS POSITIVELY SEEN');
  assert.deepEqual(a, { kind: 'INTERFERED', reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', detail: 'not on the prompt row' });
  const own = never.reads.filter((x) => x === 'own?').length;
  assert.ok(own > 3 && own <= OWNER.SCREEN_COMMIT_SLOW_BUDGET_MS / OWNER.SCREEN_COMMIT_RETRY_MS + 2, `SLOW RE-READS ARE BOUNDED BY THE BUDGET, got ${own}`);
  // Seen, cleared, but the TUI ignores the clear: the erase is never proven, so it is held.
  const stuck = laggy(rig({}, Owner), 12_000, 1);
  stuck.readScreenAs = () => ({ onPromptRow: stuck.prompt.includes(TEXT) || stuck.writes.includes('\x15'), screenCount: 1 });
  const b = await stuck.submit();
  assert.deepEqual(stuck.writes, [TEXT, '\x15']);
  assert.equal(b.kind, 'INTERFERED', 'AN ERASE THAT IS NOT PROVEN IS HELD');
  assert.equal(b.reason, 'ERASE_NOT_VERIFIED');
};
test('WSG LIVENESS: an erase that cannot be proven stays INTERFERED (held for a person)', () => K.unverifiableEraseHolds());

// ─── WSG LIVENESS, post-Enter (rc/1.1.76 final gate): the acceptance check on a slow TUI ──

/** Like laggy, but the lag and the effect of each write are chosen per write (in order), and
 *  the post-Enter acceptance check is on (verifySubmit). `enter(n)` is what the n-th Enter does:
 *  'submit' (clears the composer), 'newline' (processed - output - but our text stays). */
function slowTui(r, lagOf, enter = () => 'submit') {
  laggy(r, 0);
  let last = 0; let enters = 0;
  r.deps.verifySubmit = () => true;
  r.deps.write = (_id, d) => {
    r.writes.push(d);
    const n = d === '\r' ? (enters += 1) : 0;
    const due = Math.max(r.now + lagOf(d), last); last = due;
    const apply = () => {
      if (d === '\r') { if (enter(n) === 'submit') r.prompt = ''; } else if (d === '\x15') r.prompt = ''; else r.prompt += d;
      r.gen += 1;
    };
    if (due <= r.now) apply(); else r.timers.push({ at: due, seq: (r.seq += 1), fn: apply });
    return { ok: true };
  };
  return r;
}

K.slowEnterCommitsOnce = async (Owner) => {
  // Creed's gate case: the stub processes EVERY write 5 s late, the Enter included.
  const r = slowTui(rig({}, Owner), () => 5000);
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'COMMITTED' });
  assert.deepEqual(r.writes, [TEXT, '\r'], 'NO SECOND ENTER ON A MERELY SLOW ENTER');
  assert.equal(r.prompt, '', 'submitted once');
};
test('WSG LIVENESS post-Enter: an Enter processed 5 s late is waited for: COMMITTED with ONE Enter', () => K.slowEnterCommitsOnce());

K.queuedEnterNeverChased = async (Owner) => {
  // The Enter sits unprocessed past the budget (no output at all): nothing can recall it.
  const r = slowTui(rig({}, Owner), (d) => (d === '\r' ? 60_000 : 0));
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT, '\r'], 'A QUEUED ENTER IS NEVER CHASED (no second Enter, no Ctrl-U behind it)');
  assert.deepEqual(out, { kind: 'COMMITTED' }, 'unconfirmed: the provider confirmation judges the turn');
};
test('WSG LIVENESS post-Enter: an Enter still queued past the budget is never chased (COMMITTED, unconfirmed)', () => K.queuedEnterNeverChased());

K.lostEnterRetried = async (Owner) => {
  const r = slowTui(rig({}, Owner), () => 0, (n) => (n === 1 ? 'newline' : 'submit'));
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'COMMITTED' });
  assert.deepEqual(r.writes, [TEXT, '\r', '\r'], 'AN ENTER PROVEN LOST (OUTPUT, TEXT STAYED) IS SENT ONCE MORE');
};
test('WSG LIVENESS post-Enter: an Enter PROVEN lost (processed, our text stayed) gets one more Enter', () => K.lostEnterRetried());

K.lostTwiceAborted = async (Owner) => {
  const r = slowTui(rig({}, Owner), () => 0, () => 'newline');
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT, '\r', '\r', '\x15'], 'AN ENTER PROVEN LOST TWICE IS ERASED (VERIFIED), NOT HELD');
  assert.deepEqual(out, { kind: 'ABORTED', detail: 'submit-not-accepted' });
  assert.equal(r.prompt, '');
};
test('WSG LIVENESS post-Enter: two Enters proven lost: a VERIFIED erase and a release (ABORTED), not SUBMIT_NOT_ACCEPTED', () => K.lostTwiceAborted());

K.humanKeyDuringSlowWait = async (Owner) => {
  const r = laggy(rig({}, Owner), 8000);
  const t0 = r.now;
  r.timers.push({ at: r.now + 3000, seq: (r.seq += 1), fn: () => { r.human += 1; r.gen += 1; } });
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.deepEqual(r.writes, [TEXT]);
  // WSG-FOLLOWUPS T-W1: honoured at the next reading, not when the echo finally lands (8 s).
  assert.ok(r.now - t0 < 3000 + 4 * OWNER.SCREEN_COMMIT_RETRY_MS, `A HUMAN KEY DURING THE SLOW WAIT IS HONOURED AT ONCE (settled after ${r.now - t0} ms)`);
};
test('WSG LIVENESS: a human key during the slow wait wins (HUMAN_INPUT_AFTER_STAGE, no Enter, no clear), at once', () => K.humanKeyDuringSlowWait());

// ─── WSG-FOLLOWUPS (1.1.77): the abort's own waits, and a half erase ─────────────────────────

K.humanKeyDuringAbortWait = async (Owner) => {
  // Past the budget (10 s) the abort waits to SEE our text (it lands at 12 s); a key at 11 s.
  const r = laggy(rig({}, Owner), 12_000, 1);
  const t0 = r.now;
  r.timers.push({ at: r.now + 11_000, seq: (r.seq += 1), fn: () => { r.human += 1; r.gen += 1; } });
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
  assert.deepEqual(r.writes, [TEXT], 'no Ctrl-U over a human key');
  assert.ok(r.now - t0 < 11_000 + 4 * OWNER.SCREEN_COMMIT_RETRY_MS, `A HUMAN KEY DURING THE ABORT'S WAIT IS HONOURED AT ONCE (settled after ${r.now - t0} ms)`);
};
test('WSG-FOLLOWUPS T-W1: a human key during the abort\'s sighting wait is honoured at once', () => K.humanKeyDuringAbortWait());

K.ptyLostDuringAbortWait = async (Owner) => {
  const r = laggy(rig({}, Owner), 12_000, 1);
  r.timers.push({ at: r.now + 11_000, seq: (r.seq += 1), fn: () => { r.incarnation = undefined; } });
  // A dead PTY has no screen: no reading at all from then on.
  r.readScreenAs = () => (r.incarnation === undefined ? null : { onPromptRow: r.prompt.includes(TEXT), screenCount: r.prompt.includes(TEXT) ? 1 : 0 });
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'FAILED', reason: 'PTY_GONE_AFTER_STAGE' }, 'A PTY LOST DURING THE ABORT\'S WAIT IS FAILED (RELEASED), NOT HELD');
  assert.deepEqual(r.writes, [TEXT]);
};
test('WSG-FOLLOWUPS T-W2: a PTY lost during the abort\'s sighting wait is FAILED, not held', () => K.ptyLostDuringAbortWait());

K.halfEraseHeld = async (Owner) => {
  // Past the budget, the clear leaves a FRAGMENT of our text: the needle is gone (so the
  // erase "verifies"), but the composer is not empty and the re-offer's STAGE would refuse.
  const r = laggy(rig({}, Owner), 12_000, 1);
  const write = r.deps.write;
  r.deps.write = (id, d) => (d === '\x15' ? (r.writes.push(d), r.timers.push({ at: r.now, seq: (r.seq += 1), fn: () => { r.prompt = TEXT.slice(0, 6); r.gen += 1; } }), { ok: true }) : write(id, d));
  const out = await r.submit();
  assert.deepEqual(r.writes, [TEXT, '\x15']);
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'ERASE_LEFT_RESIDUE', detail: '6 chars of our text left' }, 'A HALF ERASE IS HELD, NOT RELEASED INTO A STAGE THAT REFUSES FOR EVER');
};
test('WSG-FOLLOWUPS: a half erase (our fragment left in the composer) is held as ERASE_LEFT_RESIDUE', () => K.halfEraseHeld());

test('WSG-FOLLOWUPS: codexEraseResidue is positive evidence only', () => {
  const f = (row) => ({ ...facts(fixture('2-trusted-handoff-120x40')), cursorRow: row });
  assert.equal(OWNER.codexEraseResidue(f(SHARED.CODEX_EMPTY_COMPOSER_ROW), TEXT), null, 'the empty composer');
  assert.equal(OWNER.codexEraseResidue(f('› '), TEXT), null, 'an empty row');
  assert.equal(OWNER.codexEraseResidue(f('› somebody else'), TEXT), null, 'not a piece of our text');
  assert.equal(OWNER.codexEraseResidue(f('› [hive'), TEXT), '[hive');
  assert.equal(OWNER.codexEraseResidue(f('• Working'), TEXT), null, 'not the composer');
  // Jim N-F1: a residue is the START of our text, at least CODEX_RESIDUE_MIN_CHARS long.
  assert.equal(OWNER.codexEraseResidue(f('› c'), TEXT), null, 'ONE CHARACTER IS NOT RESIDUE (a human keystroke)');
  assert.equal(OWNER.codexEraseResidue(f('› [h'), TEXT), null, 'two characters are not either');
  assert.equal(OWNER.codexEraseResidue(f('› A'), TEXT), null, 'a placeholder caught mid-redraw');
  assert.equal(OWNER.codexEraseResidue(f('› inbox'), TEXT), null, 'A SUFFIX IS NOT RESIDUE (Ctrl-U kills backward)');
  assert.equal(OWNER.codexEraseResidue(f('› [hi'), TEXT), '[hi');
});

K.residueNeedsTwoReadings = async (Owner) => {
  // The first reading after the erase catches a frame mid-redraw; the second is clean.
  const r = laggy(rig({}, Owner), 12_000, 1);
  const write = r.deps.write;
  r.deps.write = (id, d) => (d === '\x15' ? (r.writes.push(d), r.timers.push({ at: r.now, seq: (r.seq += 1), fn: () => { r.prompt = TEXT.slice(0, 6); r.gen += 1; r.timers.push({ at: r.now + 100, seq: (r.seq += 1), fn: () => { r.prompt = ''; r.gen += 1; } }); } }), { ok: true }) : write(id, d));
  r.readScreenAs = () => ({ onPromptRow: r.prompt === TEXT, screenCount: r.prompt === TEXT ? 1 : 0 });
  const out = await r.submit();
  assert.equal(out.kind, 'ABORTED', `A RESIDUE SEEN ON ONE READING ONLY IS NOT HELD, got ${JSON.stringify(out)}`);
};
test('WSG-FOLLOWUPS N-F1: a residue seen on one reading only (mid-redraw) is not held', () => K.residueNeedsTwoReadings());

test('WSG-FOLLOWUPS N-F1: a human key during the erase verification is HUMAN_INPUT_AFTER_STAGE, not residue', async () => {
  const r = laggy(rig(), 12_000, 1);
  const write = r.deps.write;
  r.deps.write = (id, d) => (d === '\x15' ? (r.writes.push(d), r.timers.push({ at: r.now, seq: (r.seq += 1), fn: () => { r.prompt = ''; r.gen += 1; r.human += 1; r.prompt = TEXT.slice(0, 4); } }), { ok: true }) : write(id, d));
  r.readScreenAs = () => ({ onPromptRow: r.prompt === TEXT, screenCount: r.prompt === TEXT ? 1 : 0 });
  const out = await r.submit();
  assert.deepEqual(out, { kind: 'INTERFERED', reason: 'HUMAN_INPUT_AFTER_STAGE' });
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

test('every refusal is a diagnostic record: phase, reason, incarnation, generations - and on a startup refusal only the cursor row and footer, never the conversation', async () => {
  const r = rig({ screen: '2-trusted-draft' });
  await r.submit();
  assert.equal(r.guard.length, 1);
  const rec = r.guard[0];
  // DWIGHT-INPUT-DEAD-179 F2: a startup refusal carries what condition 1 was decided on.
  assert.deepEqual(Object.keys(rec).sort(), ['admissionClass', 'agentId', 'currentGeneration', 'incarnation', 'latched', 'observedGeneration', 'ok', 'phase', 'ptyId', 'reason', 'requestId', 'startupScreen']);
  assert.deepEqual([rec.phase, rec.ok, rec.reason, rec.incarnation, rec.observedGeneration, rec.currentGeneration, rec.latched], ['STAGE', false, 'startup:header-loading', 1, 10, 10, false]);
  assert.deepEqual(Object.keys(rec.startupScreen).sort(), ['cursorRow', 'footer', 'header', 'startingAfterHeader'], 'no rows above the cursor');
  assert.equal(rec.startupScreen.header, 'LOADING');
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

test('R2-4 wiring: the spawn env names the token, the hook observer hands it on, only SessionStart or the agent\'s own Stop latches', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /const wakeToken = provider === 'codex' && opts\.hive\?\.id \? WakeIncarnationTokens\.mint\(\) : null;\s*if \(wakeToken\) opts\.env = \{ \.\.\.\(opts\.env \?\? \{\}\), \[WAKE_INCARNATION_ENV\]: wakeToken \};\s*const res = await ptyManager\.spawn\(opts, owner\);/);
  assert.match(idx, /wakeIncarnationTokens\.register\(wakeToken, opts\.hive\.id, opts\.id, ptyManager\.incarnation\(opts\.id\)\)/);
  assert.match(idx, /function onWakeIncarnation\(agentId: string, token: string\): void \{\s*const proven = wakeIncarnationTokens\.resolve\(token, agentId, [^\n]+\n\s*if \(proven && automaticSubmit\.latchPostHandoff\(proven\.ptyId, proven\.incarnation\)\) screenGuardNotices\.latched\(agentId\);/);
  assert.match(idx, /\n\);\nhookServer\.setWakeIncarnationObserver\(onWakeIncarnation\);/, 'registered right after the HookServer is built');
  const hooks = readSource('src/main/hooks.ts');
  assert.match(hooks, /if \(!fromSubagent && agentId && \(event === 'SessionStart' \|\| event === 'Stop'\) && typeof p\.munder_wake_incarnation === 'string' && p\.munder_wake_incarnation\) \{\s*try \{ this\.onWakeIncarnation\?\.\(agentId, p\.munder_wake_incarnation\.slice\(0, 80\)\); \}/, 'only the agent\'s own SessionStart or Stop hands the token on (fix 1(b))');
});

// ─── The renderer answers with the shared reader ────────────────────────────────────────

test('renderer: a Codex request is answered by readCodexScreen over the whole buffer, behind pending output', () => {
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /import \{ extractCodexScreen, type CodexScreenFacts \} from '@shared\/codexScreen';/);
  assert.match(pool, /const codex = extractCodexScreen\(\(i\) => buf\.getLine\(i\)\?\.translateToString\(true\), buf\.length, cursor\);/);
  assert.match(pool, /entry\.term\.write\('', \(\) => \{\s*const tail = [^\n]+\n\s*window\.cth\.answerScreenReading\(req\.requestId, req\.codex === true\s*\? readCodexScreen\(req\.ptyId, tail\)/);
});

// ─── WSG-CODEX-STARTUP-NO-MARKER (1.1.78): the latch deadlock (_work/WSG-NO-MARKER-177.md) ──

/**
 * Codex 0.157.1's resize replay. app/resize_reflow.rs:291-305 clears with
 * custom_terminal.rs:557-568 (ESC[r ESC[0m ESC[H ESC[2J ESC[3J ESC[H; ESC[3J purges the
 * scrollback), then replays the transcript capped to the newest rows
 * (resize_reflow_cap.rs DEFAULT_TERMINAL_RESIZE_REFLOW_FALLBACK_MAX_ROWS = 1000, "oldest rows are
 * dropped first"). In a long resumed session the session header is the OLDEST cell, so it is
 * gone. This builds that buffer from the REAL resumed capture: its header box, a long
 * transcript, its real composer and footer; then only the newest 1000 rows are kept.
 *
 * The footer's M3 status line (`<model> <effort> · <cwd>`) is configurable and never required;
 * Dwight's footer did not show it (else M3 would have opened condition 1, WSG-NO-MARKER-177
 * step 4). `statusLine: false` (the default here) removes it from the capture's footer, which is
 * the Dwight state; `statusLine: true` keeps it.
 */
const REPLAY_CAP_ROWS = 1000;
function purgedReplay(name = '4-resume-resumed-120x40', transcript = 1500, { statusLine = false } = {}) {
  const fx = fixture(name);
  const box = fx.lines.findIndex((l) => l.startsWith('\u2570'));
  const rows = Array.from({ length: transcript }, (_, i) => `\u2022 transcript row ${i} of a long resumed session`);
  const after = fx.lines.slice(box + 1);
  const m3 = after.findIndex((l, i) => i > fx.cursorRow - box - 1 && l.includes(` \u00b7 ${CWD}`));
  const tail = statusLine || m3 < 0 ? after : [...after.slice(0, m3), '', ...after.slice(m3 + 1)];
  const full = [...fx.lines.slice(0, box + 1), ...rows, ...tail];
  const drop = Math.max(0, full.length - REPLAY_CAP_ROWS);
  return { lines: full.slice(drop), cursorRow: fx.cursorRow + rows.length - drop, hadStatusLine: m3 >= 0 };
}
const purgedFacts = (S = SHARED, opts = {}) => { const p = purgedReplay(undefined, undefined, opts); return S.extractCodexScreen((i) => p.lines[i], p.lines.length, p.cursorRow); };
const withPrompt = (f, r) => (r.prompt ? { ...f, cursorRow: `\u203a ${r.prompt}` } : f);

test('NO-MARKER fixture: the purged-and-replayed resumed screen has no header, condition 1 refuses it, and it IS the composer', () => {
  const p = purgedReplay();
  assert.equal(p.lines.length, REPLAY_CAP_ROWS, 'capped to the newest 1000 rows');
  assert.ok(!p.lines.some((l) => l.startsWith('\u2502 >_ OpenAI Codex (v')), 'the session header box was the oldest cell: dropped');
  const f = purgedFacts();
  assert.equal(f.header, 'NONE');
  assert.deepEqual(SHARED.codexPastStartup(f, CWD), { open: false, reason: 'no-marker' }, 'Dwight 19:35:47: startup:no-marker');
  assert.equal(SHARED.classifyCodexComposer(f).cls, 'READY', 'and yet Codex is idle on its chat composer');
  assert.equal(p.hadStatusLine, true, 'the capture footer had the M3 line; it was removed (Dwight\'s did not show one)');
  assert.deepEqual(SHARED.codexPastStartup(purgedFacts(SHARED, { statusLine: true }), CWD), { open: true, reason: 'status-line' },
    'with the M3 line kept, the same purge is still opened by M3 (why only footers without it were held)');
});

K.automaticWaitsForLatch = async (Owner) => {
  const r = rig({}, Owner);
  const purged = purgedFacts();
  r.facts = () => withPrompt(purged, r);
  for (const id of ['a1', 'a2', 'a3']) {
    assert.deepEqual(await r.submit(id), { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:no-marker' }, 'AUTOMATIC DELIVERY STILL WAITS FOR A LATCH on a header-less screen');
  }
  assert.equal(r.writes.length, 0);
};
test('the deadlock as shipped: a resized resumed Codex with no latch refuses every automatic delivery (nothing typed)', () => K.automaticWaitsForLatch());

K.spawnReadingLatches = async (Owner) => {
  const r = rig({ screen: '4-resume-resumed-120x40' }, Owner);
  assert.equal(r.owner.startupProbeWanted('p1'), true, 'an un-latched Codex PTY wants a startup reading');
  assert.equal(await r.settle(r.owner.observeStartup('p1')), true, 'THE READING RIGHT AFTER SPAWN LATCHES while the header is on screen');
  assert.equal(r.writes.length, 0, 'a startup reading types nothing');
  assert.equal(r.guard.length, 0, 'and is no gate evaluation (no refusal row, no alert run)');
  assert.equal(r.owner.startupProbeWanted('p1'), false, 'latched: no more startup readings');
  const purged = purgedFacts();
  r.facts = () => withPrompt(purged, r);
  assert.deepEqual(await r.submit('after-resize'), { kind: 'COMMITTED' }, 'a header seen at spawn still counts after Codex purges it');
  r.incarnation = 2;
  assert.equal(r.owner.startupProbeWanted('p1'), true, 'a respawn wants its own startup reading');
};
test('fix 1(a): a startup reading right after spawn latches condition 1; a later resize purge no longer holds delivery', () => K.spawnReadingLatches());

test('fix 1(a): a startup reading latches nothing on a draft, a trust screen, a stale stamp, generation 0 or a non-Codex PTY', async () => {
  for (const screen of DRAFTS) {
    const r = rig({ screen });
    assert.equal(await r.settle(r.owner.observeStartup('p1')), false, `${screen}: no latch`);
    assert.equal(r.owner.postHandoffLatched('p1'), false);
  }
  const trust = rig();
  const t = snap(TRUST_SNAPS[0]);
  trust.facts = () => SHARED.extractCodexScreen((i) => t.lines[i], t.lines.length, t.cursorRow);
  assert.equal(await trust.settle(trust.owner.observeStartup('p1')), false, 'the trust screen latches nothing');
  const stale = rig({ stampIncarnation: 0 });
  assert.equal(await stale.settle(stale.owner.observeStartup('p1')), false, 'a reading of an older incarnation latches nothing');
  const blank = rig({ gen: 0 });
  assert.equal(await blank.settle(blank.owner.observeStartup('p1')), false, 'N1: a reading that covers no output latches nothing');
  const claude = rig({ provider: 'claude' });
  assert.equal(claude.owner.startupProbeWanted('p1'), false, 'the guard is OFF for other providers: no startup readings');
  assert.equal(await claude.settle(claude.owner.observeStartup('p1')), false);
  assert.deepEqual(claude.reads, [], 'and no screen IPC');
});

/** A HookServer with only what the latch path needs. */
function hookServer(Hook = HOOKS.HookServer) {
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  return new Hook(hive, () => null, () => ({}), control, undefined, undefined, () => {});
}

K.turnEndLatches = async (Owner, Hook = HOOKS.HookServer) => {
  const r = rig({}, Owner);
  const purged = purgedFacts();
  r.facts = () => withPrompt(purged, r);
  assert.equal((await r.submit('before')).detail, 'startup:no-marker', 'resized before any reading: refused');
  const tokens = new GUARD.WakeIncarnationTokens();
  tokens.register('tok-6', 'dwight', 'p1', r.incarnation);
  const server = hookServer(Hook);
  server.setWakeIncarnationObserver((agentId, token) => {
    const proven = tokens.resolve(token, agentId, { ptyForAgent: () => 'p1', incarnation: () => r.incarnation });
    if (proven) r.owner.latchPostHandoff(proven.ptyId, proven.incarnation);
  });
  server.handle({ hook_event_name: 'Stop', agent_id: 'dwight', provider_agent_id: 'codex-sub-1', munder_wake_incarnation: 'tok-6' });
  assert.equal(r.owner.postHandoffLatched('p1'), false, 'A SUBAGENT STOP LATCHES NOTHING');
  server.handle({ hook_event_name: 'Stop', agent_id: 'dwight', munder_wake_incarnation: 'forged' });
  assert.equal(r.owner.postHandoffLatched('p1'), false, 'an unknown token latches nothing');
  server.handle({ hook_event_name: 'PreToolUse', agent_id: 'dwight', tool_name: 'shell', munder_wake_incarnation: 'tok-6' });
  assert.equal(r.owner.postHandoffLatched('p1'), false, 'a tool hook is not a turn end');
  server.handle({ hook_event_name: 'Stop', agent_id: 'dwight', turn_id: 't1', munder_wake_incarnation: 'tok-6' });
  assert.equal(r.owner.postHandoffLatched('p1'), true, 'THE AGENT\'S OWN TURN END LATCHES ITS LIVE INCARNATION');
  assert.deepEqual(await r.submit('after'), { kind: 'COMMITTED' }, 'and the held delivery goes through');
};
test('fix 1(b): the agent\'s own Stop (this incarnation\'s token) latches; a subagent Stop, a forged token or a tool hook do not', () => K.turnEndLatches());

test('fix 1(a) scheduler: one reading per quiet period after output, none mid-burst, none once latched, one in flight', async () => {
  const timers = [];
  let wanted = true; const probes = []; let release;
  const sp = new GUARD.StartupProbe({
    wanted: () => wanted,
    probe: (id) => { probes.push(id); return new Promise((res) => { release = res; }); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; }
  }, 400);
  const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  sp.output('p1'); sp.output('p1'); sp.output('p1');
  assert.equal(timers.filter((t) => t.live).length, 1, 'a burst re-arms ONE settle timer');
  assert.equal(timers.find((t) => t.live).ms, 400);
  fire();
  assert.deepEqual(probes, ['p1'], 'THE QUIET AFTER THE FIRST BURST TAKES A READING');
  sp.output('p1'); fire();
  assert.deepEqual(probes, ['p1'], 'never a second reading while one is in flight');
  release(true); await new Promise((res) => setImmediate(res));
  wanted = false;
  sp.output('p1');
  assert.equal(sp.pending, 0, 'latched (not wanted): output arms nothing');
  wanted = true; sp.output('p2'); sp.cancel('p2');
  assert.equal(sp.pending, 0, 'a gone PTY cancels its timer');
});

test('fix 1 wiring: every PTY chunk feeds the scheduler; it reads through the owner; latches lift the notice', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /const startupProbe = new StartupProbe\(\{\s*wanted: \(ptyId\) => automaticSubmit\.startupProbeWanted\(ptyId\),\s*probe: \(ptyId\) => automaticSubmit\.observeStartup\(ptyId\)\.then\(\(latched\) => \{/);
  assert.match(idx, /ptyManager\.setOutputObserver\(\(id\) => startupProbe\.output\(id\)\);/);
  assert.match(idx, /if \(proven && automaticSubmit\.latchPostHandoff\(proven\.ptyId, proven\.incarnation\)\) screenGuardNotices\.latched\(agentId\);/);
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const seen = [];
  pm.setOutputObserver((id) => seen.push([id, pm.outputGeneration(id)]));
  const s = { id: 'p1', cwd: CWD, command: '', owner: null, lastOutputAt: 0, hasOutput: false, humanInputGeneration: 0, incarnation: 1, tail: '', proc: { write() {} } };
  pm.sessions.set('p1', s);
  pm.deliverData('p1', s, 'a');
  pm.deliverData('p1', { ...s }, 'stale');
  assert.deepEqual(seen, [['p1', 1]], 'told after the generation moved; a replaced process is not reported');
});

/**
 * Jim W1 (WSG-178 audit): the REAL pre-trust captures (ZT-175) have the cursor row EXACTLY on the
 * empty composer; only their loading header refuses them. Codex sizes that header to the rows
 * above the composer (startup_draft_layout.rs:50-59), so in a terminal of about 8 rows the box
 * loses its model row and the reader sees no header: `no-marker` + READY. This strips the header
 * box from the real capture, which is that screen.
 */
function headerless(name) {
  // Every header box the capture painted (its scrollback holds more than one) loses its rows.
  const fx = fixture(name);
  let lines = [...fx.lines]; let cursorRow = fx.cursorRow;
  for (;;) {
    const title = lines.findIndex((l) => l.startsWith('\u2502 >_ OpenAI Codex (v'));
    if (title < 0) break;
    let top = title; while (top > 0 && !lines[top].startsWith('\u256d')) top -= 1;
    let end = title; while (end < lines.length - 1 && !lines[end].startsWith('\u2570')) end += 1;
    lines = [...lines.slice(0, top), ...lines.slice(end + 1)];
    if (top < cursorRow) cursorRow -= end + 1 - top;
  }
  return SHARED.extractCodexScreen((i) => lines[i], lines.length, cursorRow);
}

K.sendNowNeverBypassesStartup = async (Owner) => {
  for (const name of ['1-untrusted-trust-80x24', '1-untrusted-trust-120x40', '2-trusted-draft']) {
    const f = headerless(name);
    assert.deepEqual([f.header, SHARED.classifyCodexComposer(f).cls], ['NONE', 'READY'], `${name}: header gone, the draft's composer row READY`);
    for (const cls of ['USER_RELEASED', 'CAPACITY_GATED']) {
      const r = rig({}, Owner);
      r.facts = () => withPrompt(f, r);
      const out = await r.submit('s', cls);
      assert.equal(r.writes.length, 0, `${name} ${cls}: SEND NOW NEVER TYPES INTO A HEADER-LESS STARTUP DRAFT`);
      assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:no-marker' });
    }
  }
};
test('W1: "send now" is refused startup:no-marker on the real pre-trust draft with its header gone (a small terminal): nothing typed', () => K.sendNowNeverBypassesStartup());

test('fix 3: "send now" still types NOTHING into a draft, a trust screen, or a header-less screen that is not the empty composer', async () => {
  for (const screen of DRAFTS) {
    const r = rig({ screen });
    assert.equal((await r.submit('s', 'USER_RELEASED')).reason, 'SCREEN_NOT_READY', screen);
    assert.equal(r.writes.length, 0, `${screen}: nothing typed`);
  }
  for (const file of TRUST_SNAPS) {
    const r = rig();
    const t = snap(file);
    r.facts = () => SHARED.extractCodexScreen((i) => t.lines[i], t.lines.length, t.cursorRow);
    assert.equal((await r.submit('s', 'USER_RELEASED')).reason, 'SCREEN_NOT_READY');
    assert.equal(r.writes.length, 0, `${path.basename(file)}: SEND NOW NEVER TYPES INTO THE TRUST SCREEN`);
  }
  const r = rig();
  const purged = purgedFacts();
  r.facts = () => ({ ...purged, cursorRow: '\u203a half a human draft' });
  assert.equal((await r.submit('s', 'USER_RELEASED')).reason, 'SCREEN_NOT_READY');
  assert.equal(r.writes.length, 0, 'a human draft on a header-less screen: nothing typed');
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
    edits: [["header = model === 'loading' ? 'LOADING' : 'MODEL';", "header = 'MODEL';"]],
    shared: true, killer: 'realDraftsRefuse', dies: /CONDITION 1 REFUSES the startup draft/ },
  { name: 'B1: the header title read trimmed (quoted headers count again)', file: 'src/shared/codexScreen.ts',
    edits: [["  return row.startsWith(`│ ${CODEX_HEADER_TITLE} (v`);", "  return row.trim().startsWith(`│ ${CODEX_HEADER_TITLE} (v`);"],
      ["      const m = /^│ model:\\s+(\\S+)/.exec(row);", "      const m = /^│ model:\\s+(\\S+)/.exec(row.trim());"],
      ["      if (row.startsWith('╰')) { boxEnd = i; break; }", "      if (row.trim().startsWith('╰')) { boxEnd = i; break; }"]],
    shared: true, killer: 'agentOutputIsNotAMarker', dies: /A QUOTED DRAFT HEADER IN AGENT OUTPUT IS NOT A MARKER/ },
  { name: 'B1: a box with no model row is taken as the header', file: 'src/shared/codexScreen.ts',
    edits: [['    if (model === null) continue;\n', '']],
    shared: true, killer: 'agentOutputIsNotAMarker', dies: /THE \/status CARD IS NOT A SESSION HEADER/ },
  { name: 'the reader takes the OLDEST header', file: 'src/shared/codexScreen.ts',
    edits: [['  for (let title = length - 1; title >= 0; title -= 1) {', '  for (let title = 0; title < length; title += 1) {']],
    shared: true, killer: 'newestHeaderOnly', dies: /ONLY THE NEWEST HEADER COUNTS/ },
  // WSG LIVENESS (rc/1.1.76 ISO)
  { name: 'LIVENESS: the slow budget ignored (the first failed reading aborts)', file: 'src/main/automaticSubmit.ts',
    edits: [['          if (deps.now() >= slowDeadline) return this.abort(staged, `screen-not-verified:${g.reason}`', '          if (true) return this.abort(staged, `screen-not-verified:${g.reason}`']],
    killer: 'slowEchoCommits', dies: /A SLOW ECHO \(1500 ms\) IS WAITED FOR/ },
  { name: 'LIVENESS: SLOW treated as FOREIGN', file: 'src/main/automaticSubmit.ts',
    edits: [["  return reason === 'incarnation' || reason.startsWith('startup:') || reason.startsWith('MODAL:');", '  return true;']],
    killer: 'slowEchoCommits', dies: /A SLOW ECHO \(1500 ms\) IS WAITED FOR/ },
  { name: 'LIVENESS: FOREIGN waited for like SLOW', file: 'src/main/automaticSubmit.ts',
    edits: [['          if (foreignScreenReason(g.reason)) return this.abort(staged, `screen-foreign:${g.reason}`);\n', '']],
    killer: 'foreignAborts', dies: /A FOREIGN SCREEN IS ERASED \(VERIFIED\) AT ONCE/ },
  { name: 'LIVENESS: past the budget, held for a person (the old behaviour)', file: 'src/main/automaticSubmit.ts',
    edits: [['return this.abort(staged, `screen-not-verified:${g.reason}`, SCREEN_ABORT_VERIFY_BUDGET_MS);', "return this.interfere(staged, 'SCREEN_NOT_VERIFIED_AFTER_STAGE', g.reason);"]],
    killer: 'overBudgetAborts', dies: /PAST THE BUDGET: A VERIFIED ERASE, NEVER AN ENTER/ },
  { name: 'LIVENESS: released for a re-offer WITHOUT an erase', file: 'src/main/automaticSubmit.ts',
    edits: [['return this.abort(staged, `screen-not-verified:${g.reason}`, SCREEN_ABORT_VERIFY_BUDGET_MS);', "{ if (staged.decision) deps.capacity.cancelGrant(staged.decision); return { kind: 'ABORTED', detail: `screen-not-verified:${g.reason}` }; }"]],
    killer: 'overBudgetAborts', dies: /PAST THE BUDGET: A VERIFIED ERASE, NEVER AN ENTER/ },
  { name: 'LIVENESS: the abort reads only once (its verify budget ignored)', file: 'src/main/automaticSubmit.ts',
    edits: [['    const seenBy = deps.now() + verifyBudgetMs;', '    const seenBy = deps.now();']],
    killer: 'overBudgetAborts', dies: /PAST THE BUDGET: A VERIFIED ERASE, NEVER AN ENTER/ },
  { name: 'LIVENESS: a missing reading taken as proof (Enter on a null reading)', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (!r) verdict = { ok: false, reason: 'no-reading' };", '    if (!r) verdict = { ok: true, gen: deps.outputGeneration?.(ptyId) ?? 0 };']],
    killer: 'noReadingIsNeverEvidence', dies: /NO ENTER ON A NULL READING/ },
  { name: 'LIVENESS: Ctrl-U before our text is positively seen', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (!before || !before.onPromptRow || before.screenCount < 1) {\n      return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE'", "    if (!before) {\n      return this.interfere(s, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE'"]],
    killer: 'unverifiableEraseHolds', dies: /NO CTRL-U BEFORE OUR TEXT IS POSITIVELY SEEN/ },
  { name: 'LIVENESS: the erase taken on trust (gone-check dropped)', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (!after || after.onPromptRow || after.screenCount >= before.screenCount) {\n      return this.interfere(s, 'ERASE_NOT_VERIFIED'", "    if (!after) {\n      return this.interfere(s, 'ERASE_NOT_VERIFIED'"]],
    killer: 'unverifiableEraseHolds', dies: /AN ERASE THAT IS NOT PROVEN IS HELD/ },
  // WSG LIVENESS, post-Enter (rc/1.1.76 final gate)
  { name: 'POST-ENTER: a merely slow Enter chased with a second one (the old window)', file: 'src/main/automaticSubmit.ts',
    edits: [['        if (processed && now - quietSince >= SUBMIT_VERIFY_WINDOW_MS) return false;   // PROVEN lost', '        return false;']],
    killer: 'slowEnterCommitsOnce', dies: /NO SECOND ENTER ON A MERELY SLOW ENTER/ },
  { name: 'POST-ENTER: output since the Enter not required (processed always true)', file: 'src/main/automaticSubmit.ts',
    edits: [['        const processed = enterGen === undefined || lastGen !== enterGen;', '        const processed = true;']],
    killer: 'slowEnterCommitsOnce', dies: /NO SECOND ENTER ON A MERELY SLOW ENTER/ },
  { name: 'POST-ENTER: a still-queued Enter chased at the budget', file: 'src/main/automaticSubmit.ts',
    edits: [['        if (now - started >= SUBMIT_SLOW_BUDGET_MS) return processed ? false : null;', '        if (now - started >= SUBMIT_SLOW_BUDGET_MS) return false;']],
    killer: 'queuedEnterNeverChased', dies: /A QUEUED ENTER IS NEVER CHASED/ },
  { name: 'POST-ENTER: two lost Enters held for a person (the old SUBMIT_NOT_ACCEPTED)', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (slowAware) return this.abort(again, 'submit-not-accepted', SCREEN_ABORT_VERIFY_BUDGET_MS);\n", '']],
    killer: 'lostTwiceAborted', dies: /AN ENTER PROVEN LOST TWICE IS ERASED/ },
  // WSG-FOLLOWUPS (Jim X1 / X4, which survived the liveness round as redundant early exits)
  { name: 'FOLLOWUPS X1: no human-key check inside the abort\'s sighting wait', file: 'src/main/automaticSubmit.ts',
    edits: [["      const waiting = postStageGuard(s, deps);\n", '      const waiting = null as ReturnType<typeof postStageGuard>;\n']],
    killer: 'humanKeyDuringAbortWait', dies: /A HUMAN KEY DURING THE ABORT'S WAIT IS HONOURED AT ONCE/ },
  { name: 'FOLLOWUPS X1 (PTY): a PTY lost during the abort\'s wait ends held, not FAILED', file: 'src/main/automaticSubmit.ts',
    edits: [["      const waiting = postStageGuard(s, deps);\n", '      const waiting = null as ReturnType<typeof postStageGuard>;\n']],
    killer: 'ptyLostDuringAbortWait', dies: /A PTY LOST DURING THE ABORT'S WAIT IS FAILED/ },
  { name: 'FOLLOWUPS X4: no human-key check on a failed COMMIT reading', file: 'src/main/automaticSubmit.ts',
    edits: [['          const blocked = postStageGuard(staged, deps);\n          if (blocked) { verdict = blocked; break; }\n', '']],
    killer: 'humanKeyDuringSlowWait', dies: /A HUMAN KEY DURING THE SLOW WAIT IS HONOURED AT ONCE/ },
  { name: 'FOLLOWUPS: a half erase released (residue check removed)', file: 'src/main/automaticSubmit.ts',
    edits: [["      if (residue !== null) return this.interfere(s, 'ERASE_LEFT_RESIDUE', `${residue.length} chars of our text left`);\n", '']],
    killer: 'halfEraseHeld', dies: /A HALF ERASE IS HELD/ },
  { name: 'N-F1: residue on ONE reading held (no second reading)', file: 'src/main/automaticSubmit.ts',
    edits: [['        await this.sleep(SCREEN_COMMIT_RETRY_MS);\n        const residue = await residueNow();\n', '        const residue = await residueNow();\n']],
    killer: 'residueNeedsTwoReadings', dies: /A RESIDUE SEEN ON ONE READING ONLY IS NOT HELD/ },
  // WSG-CODEX-STARTUP-NO-MARKER (1.1.78)
  { name: 'NO-MARKER 1(a): the startup reading latches nothing', file: 'src/main/automaticSubmit.ts',
    edits: [['    if (past.open && r.outputGeneration > 0) { this.postHandoff.set(ptyId, incarnation); return true; }', '    if (false) { this.postHandoff.set(ptyId, incarnation); return true; }']],
    killer: 'spawnReadingLatches', dies: /THE READING RIGHT AFTER SPAWN LATCHES/ },
  { name: 'NO-MARKER 1(b): only SessionStart latches (the turn end is ignored, as shipped)', file: 'src/main/hooks.ts', kind: 'hooks',
    edits: [["(event === 'SessionStart' || event === 'Stop')", "event === 'SessionStart'"]],
    killer: 'turnEndLatches', dies: /THE AGENT'S OWN TURN END LATCHES ITS LIVE INCARNATION/ },
  { name: 'NO-MARKER 1(b) too wide: a subagent\'s Stop latches', file: 'src/main/hooks.ts', kind: 'hooks',
    edits: [["if (!fromSubagent && agentId && (event === 'SessionStart' || event === 'Stop')", "if (agentId && (event === 'SessionStart' || event === 'Stop')"]],
    killer: 'turnEndLatches', dies: /A SUBAGENT STOP LATCHES NOTHING/ },
  { name: 'W1: the send-now bypass restored (a person passes no-marker on an exact composer)', file: 'src/main/automaticSubmit.ts',
    edits: [["      else if (this.postHandoff.get(ptyId) !== incarnation) verdict", "      else if (this.postHandoff.get(ptyId) !== incarnation && !(req.admissionClass === 'USER_RELEASED' && past.reason === 'no-marker' && comp.cls === want)) verdict"]],
    killer: 'sendNowNeverBypassesStartup', dies: /SEND NOW NEVER TYPES INTO A HEADER-LESS STARTUP DRAFT/ },
  { name: 'W1: any class passes no-marker on an exact composer', file: 'src/main/automaticSubmit.ts',
    edits: [["      else if (this.postHandoff.get(ptyId) !== incarnation) verdict", "      else if (this.postHandoff.get(ptyId) !== incarnation && !(past.reason === 'no-marker' && comp.cls === want)) verdict"]],
    killer: 'automaticWaitsForLatch', dies: /AUTOMATIC DELIVERY STILL WAITS FOR A LATCH/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async (tt) => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        const kind = m.kind ?? (m.shared ? 'shared' : 'owner');
        const run = (arg) => (kind === 'shared' ? K[m.killer](arg)
          : kind === 'hooks' ? K[m.killer](undefined, arg && arg.HookServer)
          : K[m.killer](arg && arg.AutomaticSubmitOwner));
        await run(kind === 'shared' ? SHARED : kind === 'hooks' ? HOOKS : OWNER);      // the killer PASSES on the real module...
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
