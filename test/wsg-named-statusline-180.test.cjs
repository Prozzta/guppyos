'use strict';

/**
 * DWIGHT-INPUT-DEAD-179 (1.1.80): a RESUMED Codex agent was refused every delivery with
 * `startup:no-marker` until a person typed a turn into its terminal (_work report
 * hive/agents/jim-mtujpe28/DWIGHT-INPUT-DEAD-179.md).
 *
 *   F1  Codex 0.157.1's DEFAULT status line is `model-with-reasoning · current-dir · thread-name`
 *       (tui chatwidget.rs:520). A resumed chat has a name, so the line ends in it, and the old
 *       matcher read the LAST part as the cwd. The cwd may now be any part after the model.
 *   F2  a startup reading's verdict and the screen it was decided on are logged, once per
 *       incarnation and reason (and a startup refusal row carries the same facts).
 *   F3  a startup hold is worded as what releases it: one message typed IN the terminal.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const SHARED = loadTs('src/shared/codexScreen.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const HOLD = loadTs('src/shared/deliveryHold.ts');
const LEDGER = loadTs('src/main/mailLedger.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };

const K = {};
const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');
/** The capture's spawn cwd (wake-screen-guard fixtures). */
const CWD = 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b';
const HOME = 'C:\\Users\\someone';
/** Dwight's live line on 2026-10-02 (session_index thread_name "Check hive inbox"). */
const DWIGHT_LINE = 'gpt-5.6-terra high \u00b7 C:\\PrzEdit \u00b7 Check hive inbox';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
}

/**
 * The resumed capture as Dwight's terminal held it on 2026-10-02: Codex's resize replay dropped
 * the header box (the oldest cell), and the status line carries the chat's name as its third
 * part. Nothing else on the screen differs from the real capture.
 */
function namedResumedScreen(statusLine = `capstub-none default \u00b7 ${CWD} \u00b7 Check hive inbox`) {
  const fx = fixture('4-resume-resumed-120x40');
  const box = fx.lines.findIndex((l) => l.startsWith('\u2570'));
  const lines = fx.lines.slice(box + 1).map((l) => (l.includes(` \u00b7 ${CWD}`) ? `  ${statusLine}` : l));
  assert.ok(lines.some((l) => l.includes('Check hive inbox') || l.includes(statusLine)), 'the status line row was found and replaced');
  return { lines, cursorRow: fx.cursorRow - (box + 1) };
}
const factsOf = (s, S = SHARED) => S.extractCodexScreen((i) => s.lines[i], s.lines.length, s.cursorRow);

// ─── F1: the status line by its parts ───────────────────────────────────────────────────────

K.namedLineOpens = (S = SHARED) => {
  assert.equal(S.isCodexStatusLine(DWIGHT_LINE, 'C:\\PrzEdit'), true, 'A RESUMED CHAT\'S NAMED STATUS LINE PROVES THE CWD');
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 ' + CWD + ' \u00b7 Fix the build', CWD), true);
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 ' + CWD + ' \u00b7 a \u00b7 b', CWD), true, 'a thread name with its own separator');
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 ~\\proj\\a \u00b7 Check inbox', HOME + '\\proj\\a', HOME), true, '~\\rel under HOME, named');
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 C:\\Dunder\\\u2026\\dir-b \u00b7 Check inbox', CWD), true, 'a middle-elided cwd, named');
};
K.cwdNeverFirst = (S = SHARED) => {
  assert.equal(S.isCodexStatusLine(CWD + ' \u00b7 Check inbox', CWD), false, 'THE FIRST PART IS THE MODEL, NEVER THE CWD');
};
K.otherPathsRefused = (S = SHARED) => {
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 C:\\elsewhere \u00b7 Check inbox', CWD), false, 'another cwd, named');
  assert.equal(S.isCodexStatusLine('gpt-5.5 high \u00b7 C:\\elsewhere \u00b7 ' + 'C:\\other\\dir', CWD), false, 'a thread name that looks like another path');
  assert.equal(S.isCodexStatusLine('gpt-5.5 high', CWD), false, 'no separator');
  assert.equal(S.isCodexStatusLine('gpt-5.5   high \u00b7 ' + CWD, CWD), false, 'the model part is words with single spaces (the shortcut hint row is not)');
  assert.equal(S.isCodexStatusLine(DWIGHT_LINE, null), false, 'no spawn cwd known');
};
test('F1: the named status line of a resumed chat proves the cwd (Dwight\'s 2026-10-02 line)', () => K.namedLineOpens());
test('F1: the cwd is never the first part', () => K.cwdNeverFirst());
test('F1: another path, in any part, proves nothing', () => K.otherPathsRefused());

K.namedScreenPastStartup = (S = SHARED) => {
  const f = factsOf(namedResumedScreen(), S);
  assert.equal(f.header, 'NONE', 'the header box was purged by the resize replay');
  assert.deepEqual(S.codexPastStartup(f, CWD), { open: true, reason: 'status-line' }, 'THE PURGED NAMED SCREEN IS PAST STARTUP');
  assert.equal(S.classifyCodexComposer(f).cls, 'READY');
};
test('F1: the purged resumed screen with a named status line is past startup (was no-marker)', () => K.namedScreenPastStartup());

// ─── the owner, end to end ──────────────────────────────────────────────────────────────────

function rig(Owner = OWNER.AutomaticSubmitOwner, screen = namedResumedScreen()) {
  const r = { now: 1_000_000, seq: 0, timers: [], writes: [], guard: [], startup: [], incarnation: 1, gen: 10, prompt: '' };
  const base = factsOf(screen);
  r.facts = () => (r.prompt ? { ...base, cursorRow: `\u203a ${r.prompt}` } : base);
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => r.incarnation,
    humanGeneration: () => 0,
    write: (_id, d) => { r.writes.push(d); if (d === '\r') r.prompt = ''; else r.prompt += d; r.gen += 1; return { ok: true }; },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: () => Promise.resolve(null),
    capacity: { admit: () => ALLOW, revalidate: () => ALLOW, confirmLaunch() {}, cancelGrant() {}, holdGrant() {} },
    now: () => r.now,
    setTimer: (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; },
    screenGuard: () => 'ENFORCE',
    readGuardScreen: (_id, tail) => Promise.resolve({
      facts: r.facts(), incarnation: r.incarnation, outputGeneration: r.gen,
      ...(tail === undefined ? {} : { promptTailMatches: r.prompt.endsWith(tail) })
    }),
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: (rec) => r.guard.push(rec),
    onStartupReading: (rec) => r.startup.push(rec)
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
  return r;
}

test('F1 end to end: a resumed, resized, NAMED Codex gets its delivery (no turn typed by hand first)', async () => {
  const r = rig();
  const out = await r.settle(r.owner.submit({ requestId: 'w1', agentId: 'dwight', admissionClass: 'CAPACITY_GATED', text: '[hive] check inbox' }));
  assert.equal(out.kind, 'COMMITTED', JSON.stringify(out));
  assert.deepEqual(r.writes, ['[hive] check inbox', '\r']);
});

// ─── F2: the startup verdict, logged ────────────────────────────────────────────────────────

K.startupReadingOncePerReason = async (Owner) => {
  const unnamed = { lines: ['\u2022 a transcript row', '', '\u203a Ask Codex to do anything', '', '  gpt-5.5 high \u00b7 C:\\elsewhere \u00b7 Check inbox'], cursorRow: 2 };
  const r = rig(Owner, unnamed);
  for (let i = 0; i < 3; i += 1) assert.equal(await r.settle(r.owner.observeStartup('p1')), false);
  assert.equal(r.startup.length, 1, 'ONE ROW PER INCARNATION AND REASON');
  const rec = r.startup[0];
  assert.deepEqual([rec.ptyId, rec.incarnation, rec.open, rec.reason, rec.outputGeneration], ['p1', 1, false, 'no-marker', 10]);
  assert.deepEqual(rec.screen, { header: 'NONE', startingAfterHeader: false, cursorRow: '\u203a Ask Codex to do anything', footer: ['gpt-5.5 high \u00b7 C:\\elsewhere \u00b7 Check inbox'] },
    'the cursor row and the footer only: never the conversation above it');
  r.incarnation = 2;
  await r.settle(r.owner.observeStartup('p1'));
  assert.equal(r.startup.length, 2, 'A NEW INCARNATION IS REPORTED AGAIN');
  assert.equal(r.startup[1].incarnation, 2);
};
test('F2: a startup reading is reported once per incarnation and reason, with the cursor row and footer', () => K.startupReadingOncePerReason());

test('F2: the latching reading is reported too, rows are cut to STARTUP_ROW_MAX, and a throwing logger decides nothing', async () => {
  const r = rig();
  assert.equal(await r.settle(r.owner.observeStartup('p1')), true);
  assert.deepEqual([r.startup.length, r.startup[0].open, r.startup[0].reason], [1, true, 'status-line']);
  const long = { lines: ['\u203a Ask Codex to do anything', '', `  ${'x'.repeat(300)}`], cursorRow: 0 };
  const l = rig(undefined, long);
  await l.settle(l.owner.observeStartup('p1'));
  assert.equal(l.startup[0].screen.footer[0].length, OWNER.STARTUP_ROW_MAX);
  const t = rig();
  t.deps.onStartupReading = () => { throw new Error('log down'); };
  assert.equal(await t.settle(t.owner.observeStartup('p1')), true, 'diagnostics never decide');
});

test('F2: a startup refusal row carries the startup facts; any other refusal does not', async () => {
  const unnamed = { lines: ['\u203a Ask Codex to do anything', '', '  gpt-5.5 high \u00b7 C:\\elsewhere'], cursorRow: 0 };
  const r = rig(undefined, unnamed);
  const out = await r.settle(r.owner.submit({ requestId: 'w1', agentId: 'dwight', admissionClass: 'CAPACITY_GATED', text: 'x' }));
  assert.deepEqual([out.kind, out.detail], ['REFUSED', 'startup:no-marker']);
  assert.equal(r.guard[0].startupScreen.header, 'NONE');
  assert.deepEqual(r.guard[0].startupScreen.footer, ['gpt-5.5 high \u00b7 C:\\elsewhere']);
});

test('F2 wiring: main logs codex-startup-reading rows and passes startupScreen into wake-screen-guard rows', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /onStartupReading: \(r\) => \{[\s\S]{0,200}kind: 'codex-startup-reading', agentId: ptyToAgent\.get\(r\.ptyId\) \?\? null/);
  assert.match(index, /\.\.\.\(r\.startupScreen \? \{ startupScreen: r\.startupScreen \} : \{\}\)/);
  const wiring = readSource('src/main/automaticSubmitWiring.ts');
  assert.match(wiring, /onStartupReading: w\.onStartupReading,/);
});

// ─── F3: the words ──────────────────────────────────────────────────────────────────────────

const base = { agentName: 'Dwight', interfered: null, paused: false, headManual: false, capacityHold: false, capacityEvidence: null };

K.startupHoldSaysTypeInTerminal = (H = HOLD) => {
  const held = H.deliveryHoldView({ ...base, screenHold: { reason: 'startup:no-marker' } });
  assert.equal(held.kind, 'SCREEN');
  assert.equal(held.action, null, '"send now" is not offered');
  assert.match(held.title, /Click inside Dwight's terminal \(not this box\), type a short message such as "check inbox" and press Enter/, 'A STARTUP HOLD SAYS: TYPE IN THE TERMINAL');
  assert.match(held.hint, /type a short message IN Dwight's terminal/);
  assert.doesNotMatch(`${held.hint} ${held.title}`, /no-marker|startup:/, 'no jargon');
  const other = H.deliveryHoldView({ ...base, screenHold: { reason: 'UNKNOWN:not-the-empty-composer' } });
  assert.match(other.title, /look at the bottom: answer or close any question or menu/, 'other screen holds keep their words');
};
K.startupNoticeSaysTypeInTerminal = (L = LEDGER) => {
  const w = L.screenGuardNoticeText('Dwight', 'startup:no-marker', 300_250, 51);
  assert.match(w.notice, /click inside Dwight's terminal \(not the message box under it\), type a short message such as "check inbox" and press Enter/, 'THE STARTUP NOTICE SAYS: TYPE IN THE TERMINAL');
  assert.doesNotMatch(w.notice, /press Enter once/, 'an Enter on an empty Codex chat box starts no turn');
  assert.doesNotMatch(`${w.title}\n${w.notice}`, /startup:|no-marker|wake-screen-guard/);
  assert.match(w.details, /startup:no-marker, 51 refusals/);
};
test('F3: the composer words a startup hold as what releases it', () => K.startupHoldSaysTypeInTerminal());
test('F3: the alert words a startup hold as what releases it', () => K.startupNoticeSaysTypeInTerminal());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return loadTs.fromText(rel, text);
}

const MUTANTS = [
  { name: 'F1: only the LAST part is the cwd (as shipped)', file: 'src/shared/codexScreen.ts',
    edits: [['  return parts.slice(1).some((part) => isSpawnCwdShown(part, spawnCwd, home));', '  return isSpawnCwdShown(parts[parts.length - 1], spawnCwd, home);']],
    killer: 'namedLineOpens', dies: /A RESUMED CHAT'S NAMED STATUS LINE PROVES THE CWD/ },
  { name: 'F1 too wide: the first part may be the cwd', file: 'src/shared/codexScreen.ts',
    edits: [['  return parts.slice(1).some((part) => isSpawnCwdShown(part, spawnCwd, home));', '  return parts.some((part) => isSpawnCwdShown(part, spawnCwd, home));']],
    killer: 'cwdNeverFirst', dies: /THE FIRST PART IS THE MODEL, NEVER THE CWD/ },
  { name: 'F1 end to end: the named screen stays no-marker', file: 'src/shared/codexScreen.ts',
    edits: [['  return parts.slice(1).some((part) => isSpawnCwdShown(part, spawnCwd, home));', '  return parts.length === 2 && isSpawnCwdShown(parts[1], spawnCwd, home);']],
    killer: 'namedScreenPastStartup', dies: /THE PURGED NAMED SCREEN IS PAST STARTUP/ },
  { name: 'F2: no dedupe (a row per reading)', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [['      if (seen.reasons.has(past.reason)) return;\n', '']],
    killer: 'startupReadingOncePerReason', dies: /ONE ROW PER INCARNATION AND REASON/ },
  { name: 'F2: a new incarnation is never reported', file: 'src/main/automaticSubmit.ts', owner: true,
    edits: [['      if (!seen || seen.incarnation !== incarnation) {', '      if (!seen) {']],
    killer: 'startupReadingOncePerReason', dies: /A NEW INCARNATION IS REPORTED AGAIN/ },
  { name: 'F3: the composer keeps the old advice for a startup hold', file: 'src/shared/deliveryHold.ts',
    edits: [["    if (i.screenHold.reason.startsWith('startup:')) {", '    if (false) {']],
    killer: 'startupHoldSaysTypeInTerminal', dies: /A STARTUP HOLD SAYS: TYPE IN THE TERMINAL/ },
  { name: 'F3: the alert keeps the old advice for a startup hold', file: 'src/main/mailLedger.ts',
    edits: [["  if (reason.startsWith('startup:')) {", '  if (false) {']],
    killer: 'startupNoticeSaysTypeInTerminal', dies: /THE STARTUP NOTICE SAYS: TYPE IN THE TERMINAL/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mod = mutate(m.file, m.edits, m.name);
      const arg = m.owner ? mod.AutomaticSubmitOwner : mod;
      await assert.rejects(async () => { await K[m.killer](arg); }, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
