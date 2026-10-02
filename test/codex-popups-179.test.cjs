'use strict';
/**
 * CODEX-MODEL-SWITCH-PROMPT P2 + P3 (1.1.79; god 5ebef5, from Jim's
 * CODEX-MODEL-SWITCH-AND-MODEL-NOT-KEPT.md).
 *
 * At 90 % of a usage limit Codex 0.157.1 opens its "Approaching rate limits" picker at the end of
 * a turn: a modal list that takes every key until it is answered (Dwight, 2026-10-01 20:27:41Z,
 * about 9 hours). The screen guard refused correctly, but could only say
 * `UNKNOWN:not-the-empty-composer`, so nobody knew Codex was asking a question.
 *
 *   P2  a refused screen that is one of Codex's own popups is MODAL, `codex-popup:<title>`
 *       (and `<title> — <question>` when a known title has a question line). The screen-guard
 *       notice, the held-wake notice and the composer's hold line all say what Codex is asking;
 *       the log rows carry it (gate reason, COMMIT `screen.popup`, held-interfered-alert `popup`).
 *   P3  the app NEVER answers a popup: no text, no Enter, no erase, no Esc. Pinned below for
 *       STAGE, for a popup that opens after STAGE (Dwight's order), for the erase, and for the
 *       held wake's once-a-minute look.
 *
 * Real screens: there is no PTY capture of a popup on this floor, so the popups are Codex's own
 * insta snapshots at rust-v0.157.1 (commit 36650394), verbatim in fixtures/codex-popups/, and the
 * nine trust-directory snapshots already in fixtures/wake-screen-guard/trust/. The full-frame test
 * draws the rate-limit picker into the bottom of the real 80x24 capture (2-trusted-idle-80x24),
 * where Codex's bottom pane replaces the composer, with the cursor parked on EVERY row (a popup
 * hides the cursor; its position is wherever the last draw left it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const SHARED = loadTs('src/shared/codexScreen.ts');
const OWNER = loadTs('src/main/automaticSubmit.ts');
const HELD = loadTs('src/main/heldInterference.ts');
const GUARD = loadTs('src/main/codexScreenGuard.ts');
const LEDGER = loadTs('src/main/mailLedger.ts');
const HOLDVIEW = loadTs('src/shared/deliveryHold.ts');

const FX = path.join(__dirname, 'fixtures', 'wake-screen-guard');
const POP = path.join(__dirname, 'fixtures', 'codex-popups');
const CWD = 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), 'utf8'));
/** An insta snapshot's rendered rows (the text after its front matter), trailing blanks dropped. */
function snapRows(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const rows = text.split('\n---\n').slice(1).join('\n---\n').split('\n');
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows;
}
const factsOf = (lines, cursorRow, S = SHARED) => S.extractCodexScreen((i) => lines[i], lines.length, cursorRow);

const RATE = 'codex_tui__chatwidget__tests__rate_limit_switch_prompt_popup.snap';
const RATE_TEXT = 'Approaching rate limits — Switch to gpt-6-luna for lower credit usage?';
/** Every vendor popup, and the reason the gate must give it. */
const VENDOR = [
  [RATE, `codex-popup:${RATE_TEXT}`, true],
  ['codex_tui__update_prompt__tests__update_prompt_modal.snap', 'codex-popup:Update available · 0.0.0 → 9.9.9', true],
  ['codex_tui__model_migration__tests__model_migration_prompt.snap', 'codex-popup:Codex just got an upgrade. Introducing', true],
  ['codex_tui__chatwidget__tests__workspace_member_usage_limit_prompt.snap', 'codex-popup:Usage limit reached — Request a limit increase from your owner to continue using codex. Request increase?', true],
  ['codex_tui__chatwidget__tests__approval_modal_exec.snap', 'codex-popup:Would you like to run the following command?', true],
  // A title not on the list is still a popup by its shape; the row above its choices names it.
  ['codex_tui__chatwidget__tests__approvals_selection_popup@windows.snap', 'codex-popup:Update Model Permissions', false]
];

/** The real 80x24 idle capture with its composer region (tip, composer, status, footer) replaced
 *  by a popup's rows, as Codex's bottom pane draws it; `cursor` defaults to the top row. */
function popupFrame(file = RATE, cursor = 0) {
  const idle = fixture('2-trusted-idle-80x24');
  const keep = idle.lines.slice(0, idle.lines.findIndex((l) => l.includes('Tip: Use /copy')));
  const lines = [...keep, ...snapRows(path.join(POP, file))];
  return { lines, cursorRow: cursor };
}
const RATE_FACTS = (() => { const f = popupFrame(); return factsOf(f.lines, f.cursorRow); })();
const READY_SCREEN = (() => { const fx = fixture('2-trusted-handoff-120x40'); return factsOf(fx.lines, fx.cursorRow); })();
const TEXT = '[hive] check inbox';
const NEEDLE = OWNER.needleFor(TEXT);
const COMMITTED = { kind: 'COMMITTED' };
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };

const K = {};

// ─── P2: the classifier ─────────────────────────────────────────────────────────────────

K.vendorPopupsNamed = (S = SHARED) => {
  for (const [file, reason, known] of VENDOR) {
    const rows = snapRows(path.join(POP, file));
    const f = factsOf(rows, 0, S);
    assert.deepEqual(S.classifyCodexComposer(f), { cls: 'MODAL', reason }, `${file}: THE POPUP IS NAMED`);
    assert.equal(S.codexPopup(f).known, known, `${file}: known title`);
  }
  // The same unlisted popup after a person's arrow key moved the selection to choice 2: the
  // rows above it are choice 1 and its wrapped description (deeper indent), not the title.
  const moved = snapRows(path.join(POP, 'codex_tui__chatwidget__tests__approvals_selection_popup@windows.snap'))
    .map((l) => (l.startsWith('› 1. ') ? `  1. ${l.slice(5)}` : l.startsWith('  2. ') ? `› 2. ${l.slice(5)}` : l));
  assert.deepEqual(S.classifyCodexComposer(factsOf(moved, 0, S)), { cls: 'MODAL', reason: 'codex-popup:Update Model Permissions' }, 'selection on choice 2: THE POPUP IS NAMED by its title');
};
test('P2: each Codex 0.157.1 popup (its own snapshots) is MODAL and named by what it asks', () => K.vendorPopupsNamed());

K.fullFrameAnyCursor = (S = SHARED) => {
  const { lines } = popupFrame();
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const f = factsOf(lines, cursor, S);
    assert.deepEqual(S.classifyCodexComposer(f), { cls: 'MODAL', reason: `codex-popup:${RATE_TEXT}` }, `THE RATE-LIMIT PICKER IS NAMED WHEREVER THE CURSOR IS (row ${cursor})`);
    assert.deepEqual(S.codexPastStartup(f, CWD), { open: true, reason: 'header-model' }, 'condition 1 reads the header as before');
  }
};
test('P2: the rate-limit picker drawn into the real 80x24 capture is named wherever the cursor was parked', () => K.fullFrameAnyCursor());

test('P2: the nine trust-directory snapshots and the update prompt are popups (and the trust title is kept at 40 columns)', () => {
  const dir = path.join(FX, 'trust');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.snap'));
  assert.equal(files.length, 9);
  for (const file of files) {
    const f = factsOf(snapRows(path.join(dir, file)), 0);
    assert.deepEqual(SHARED.classifyCodexComposer(f), { cls: 'MODAL', reason: 'codex-popup:Folder access' }, file);
  }
  assert.ok(SHARED.CODEX_TAIL_ROWS >= 17, 'the 40x17 trust screen fits the tail');
});

K.notAPopup = (S = SHARED) => {
  // Every real composer capture classifies exactly as before (READY / UNKNOWN, never MODAL).
  for (const name of fs.readdirSync(FX).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5))) {
    const fx = fixture(name);
    assert.notEqual(S.classifyCodexComposer(factsOf(fx.lines, fx.cursorRow, S)).cls, 'MODAL', `${name}: a composer capture is not a popup`);
  }
  // An agent quoting a popup in its transcript, above a person's draft: not a popup.
  const idle = fixture('2-trusted-idle-80x24');
  const quoted = [...idle.lines.slice(0, 30), '› 1. Switch to gpt-6-luna', '  2. Keep current model', '  enter select · esc back', '', ...idle.lines.slice(33)];
  const draftRow = quoted.findIndex((l) => l.startsWith('› Ask Codex'));
  quoted[draftRow] = '› 1. fix the bug';
  assert.deepEqual(S.classifyCodexComposer(factsOf(quoted, draftRow, S)), { cls: 'UNKNOWN', reason: 'not-the-empty-composer' }, 'A QUOTED POPUP IN THE TRANSCRIPT IS NOT A POPUP');
  // A numbered draft over the status line of a cwd with a space in it: not a popup.
  const spaced = [...idle.lines];
  spaced[draftRow] = '› 1. fix the bug';
  spaced[idle.lines.length - 2] = '  gpt-5.5 high · C:\\my docs';
  spaced[idle.lines.length - 1] = '';
  assert.equal(S.classifyCodexComposer(factsOf(spaced, draftRow, S)).cls, 'UNKNOWN', 'THE STATUS LINE IS NOT A POPUP HINT');
  // Jim N1: a numbered draft in a side conversation, whose footer is "Side tab to switch · ctrl+c
  // to close" (codex app/side.rs:282-286), under an agent's bullet: not a popup.
  const side = ['• Done.', '', '› 1. fix the bug', '', '  Side tab to switch · ctrl+c to close'];
  assert.equal(S.classifyCodexComposer(factsOf(side, 2, S)).cls, 'UNKNOWN', 'A SIDE CONVERSATION UNDER A BULLET IS NOT A POPUP');
  // Jim J2: a hint over a list with NO selected row is not a popup.
  const rate = snapRows(path.join(POP, RATE)).map((l) => (l.startsWith('› 1. ') ? `  1. ${l.slice(5)}` : l));
  assert.equal(S.classifyCodexComposer(factsOf(rate, 0, S)).cls, 'UNKNOWN', 'NO SELECTED CHOICE, NO POPUP');
  // Jim J3: a tail that starts at the choices (no header row left) is not a popup.
  const headless = snapRows(path.join(POP, RATE)).filter((l) => !/Approaching|Switch to gpt-6-luna for/.test(l) || /^› |^ {2}\d/.test(l));
  let headlessCls;
  try { headlessCls = S.classifyCodexComposer(factsOf(headless, 0, S)).cls; } catch (e) { headlessCls = `threw: ${e.message}`; }
  assert.equal(headlessCls, 'UNKNOWN', 'NO HEADER, NO POPUP (and the classifier never throws)');
  // READY is decided exactly as before, whatever the tail says.
  assert.deepEqual(S.classifyCodexComposer({ ...RATE_FACTS, cursorRow: SHARED.CODEX_EMPTY_COMPOSER_ROW, footer: [] }), { cls: 'READY', reason: 'empty-composer' });
  assert.deepEqual(S.classifyCodexComposer({ ...RATE_FACTS, cursorRow: '› ours' }, true), { cls: 'READY_OWN_DRAFT', reason: 'own-draft' });
};
test('P2: composers, drafts, a quoted popup and a status line are not popups; READY is unchanged', () => K.notAPopup());

K.factsValidated = (S = SHARED) => {
  const ok = RATE_FACTS;
  assert.deepEqual(S.asCodexScreenFacts(ok), ok, 'a reading with its tail crosses IPC');
  const { tail, ...noTail } = ok;
  assert.deepEqual(S.asCodexScreenFacts(noTail), noTail, 'a reading without one too');
  for (const bad of [{ ...ok, tail: 'x' }, { ...ok, tail: Array(S.CODEX_TAIL_ROWS + 1).fill('x') }, { ...ok, tail: ['x'.repeat(S.CODEX_ROW_MAX + 1)] }, { ...ok, tail: [1] }]) {
    assert.equal(S.asCodexScreenFacts(bad), null, `AN OVERSIZED OR MALFORMED TAIL IS NO READING: ${JSON.stringify(bad.tail).slice(0, 40)}`);
  }
};
test('P2: the tail that crosses IPC is validated and bounded', () => K.factsValidated());

test('P2: a reason names its popup; nothing else does', () => {
  assert.equal(SHARED.popupInReason(`MODAL:codex-popup:${RATE_TEXT}`), RATE_TEXT);
  assert.equal(SHARED.popupInReason('codex-popup:Folder access'), 'Folder access');
  for (const r of ['UNKNOWN:not-the-empty-composer', 'startup:no-marker', 'erase:codex-popup:x', '', null, undefined, 'MODAL:codex-popup:']) {
    assert.equal(SHARED.popupInReason(r), null, String(r));
  }
  const long = SHARED.codexPopupText({ title: 'T'.repeat(300), question: null, known: false });
  assert.equal(long.length, SHARED.CODEX_POPUP_TEXT_MAX, 'the popup text is bounded');
});

// ─── P3: the owner never answers a popup ────────────────────────────────────────────────

/**
 * A Codex terminal on the real post-handoff screen. `r.popup` is a popup frame's facts: while it
 * is up the composer is hidden, keys go into the popup and nothing is echoed (Dwight: no PTY
 * output after the popup frame). `r.needleOnPrompt` forces the oracle to report our text on the
 * prompt row (the belt-and-braces case for the erase).
 */
function rig(over = {}, M = OWNER) {
  const r = {
    now: 1_000_000, seq: 0, timers: [], writes: [], guard: [], interfered: [], grants: { cancel: 0, hold: 0 },
    incarnation: 1, gen: 10, human: 0, prompt: '', popup: null, popupOnStage: null, needleOnPrompt: false,
    ...over
  };
  r.facts = () => (r.popup ? r.popup : r.prompt ? { ...READY_SCREEN, cursorRow: `› ${r.prompt}` } : READY_SCREEN);
  const onPrompt = (n) => r.needleOnPrompt || (!r.popup && r.prompt.includes(n));
  const setTimer = (fn, ms) => { r.timers.push({ at: r.now + ms, seq: (r.seq += 1), fn }); return {}; };
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => r.incarnation,
    humanGeneration: () => r.human,
    write: (_id, d) => {
      r.writes.push(d);
      if (d === TEXT && r.popupOnStage) { r.popup = r.popupOnStage; r.popupOnStage = null; }
      if (r.popup) return { ok: true };            // into the popup, unechoed
      if (d === '\r' || d === '\x15') r.prompt = ''; else r.prompt += d;
      r.gen += 1;
      return { ok: true };
    },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 50 }),
    readScreen: (_id, n) => Promise.resolve({ onPromptRow: onPrompt(n), screenCount: onPrompt(n) ? 1 : 0 }),
    capacity: { admit: () => ALLOW, revalidate: () => ALLOW, confirmLaunch() {}, cancelGrant() { r.grants.cancel += 1; }, holdGrant() { r.grants.hold += 1; } },
    now: () => r.now,
    setTimer,
    screenGuard: () => 'ENFORCE',
    readGuardScreen: (_id, tail) => Promise.resolve({ facts: r.facts(), incarnation: r.incarnation, outputGeneration: r.gen, ...(tail === undefined ? {} : { promptTailMatches: !r.popup && r.prompt.endsWith(tail) }) }),
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: (rec) => r.guard.push(rec),
    onInterfered: (rec) => r.interfered.push(rec),
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
  r.drain = () => { while (r.timers.length) { r.timers.sort((a, b) => a.at - b.at || a.seq - b.seq); const n = r.timers.shift(); r.now = Math.max(r.now, n.at); n.fn(); } };
  r.submit = (id = 'w1', cls = 'CAPACITY_GATED') => r.settle(r.owner.submit({ requestId: id, agentId: 'dwight', admissionClass: cls, text: TEXT }));
  r.recheck = (id = 'w1') => r.settle(r.owner.recheckHeld('p1', id));
  /** A first wake latches condition 1 on the real composer; then the slate is clean. */
  r.latch = async () => {
    assert.deepEqual(await r.submit('latch'), COMMITTED, 'a first wake latches condition 1');
    r.drain();
    r.prompt = ''; r.writes.length = 0; r.guard.length = 0;
  };
  return r;
}
const noEsc = (writes) => writes.every((w) => !String(w).includes('\x1b'));

K.stageOnPopupTypesNothing = async (M = OWNER) => {
  const r = rig({}, M);
  await r.latch();
  r.popup = RATE_FACTS;
  const out = await r.submit('w1');
  assert.deepEqual(r.writes, [], 'P3: NO KEY INTO A POPUP (stage): no text, no Enter, no Esc');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: `MODAL:codex-popup:${RATE_TEXT}` }, 'the refusal names the popup');
  assert.equal(r.guard.at(-1).reason, `MODAL:codex-popup:${RATE_TEXT}`, 'the gate row names it (log)');
  for (const cls of ['USER_RELEASED', 'BOOT_SEQUENCE']) {
    const o = await r.submit(`p-${cls}`, cls);
    assert.equal(o.kind, 'REFUSED', `${cls}: a person's "send now" is held by the same check`);
    assert.deepEqual(r.writes, [], `${cls}: nothing typed`);
  }
};
test('P3: on a popup, STAGE types nothing, for every admission class, and the refusal names it', () => K.stageOnPopupTypesNothing());

K.popupAfterStageHeldAtOnce = async (M = OWNER) => {
  // Dwight's order: the STAGE reading saw the empty composer, then the picker opened, and our
  // text went into it unechoed.
  const r = rig({}, M);
  await r.latch();
  r.popupOnStage = RATE_FACTS;
  const t0 = r.now;
  const out = await r.submit('w1');
  assert.deepEqual(r.writes, [TEXT], 'P3: after the stage write, NO ENTER, NO ERASE, NO ESC into the popup');
  assert.equal(out.kind, 'INTERFERED', `held for a person (got ${JSON.stringify(out)})`);
  assert.ok(r.now - t0 < OWNER.SCREEN_COMMIT_SLOW_BUDGET_MS, `A POPUP AFTER STAGE IS NOT WAITED FOR as a slow echo (${r.now - t0} ms)`);
  const commit = r.guard.find((g) => g.phase === 'COMMIT');
  assert.equal(commit.reason, `MODAL:codex-popup:${RATE_TEXT}`);
  assert.equal(commit.screen.popup, RATE_TEXT, 'the COMMIT refusal row logs what Codex asked');
  assert.ok(noEsc(r.writes));
  return r;
};
test('P3: a popup that opens after STAGE (Dwight) gets no Enter, no erase and no Esc, and is held at once', () => K.popupAfterStageHeldAtOnce());

K.eraseNeverIntoPopup = async (M = OWNER) => {
  // Belt and braces: even if the oracle reported our text on the prompt row, a popup on the
  // screen stops the erase.
  const r = rig({}, M);
  await r.latch();
  r.popupOnStage = RATE_FACTS;
  r.deps.readScreen = (_id, n) => Promise.resolve(r.popup ? { onPromptRow: true, screenCount: 1 } : { onPromptRow: r.prompt.includes(n), screenCount: r.prompt.includes(n) ? 1 : 0 });
  const out = await r.submit('w1');
  assert.deepEqual(r.writes, [TEXT], 'P3: NOT EVEN THE ERASE goes into a popup');
  assert.equal(out.kind, 'INTERFERED');
  assert.equal(r.interfered.at(-1).reason, 'CODEX_POPUP_OPEN', 'held as CODEX_POPUP_OPEN');
};
test('P3: the verified erase is never typed into a popup, even with our text reported on the prompt row', () => K.eraseNeverIntoPopup());

K.recheckNeverTypesIntoPopup = async (M = OWNER) => {
  const r = await K.popupAfterStageHeldAtOnce(M);
  const before = r.writes.length;
  r.needleOnPrompt = true;                         // even with our text reported on the prompt row
  const res = await r.recheck('w1');
  assert.deepEqual([res.kind, res.why], ['HELD', `MODAL:codex-popup:${RATE_TEXT}`], 'P3: NO KEY INTO A POPUP (recheck): it stays held, named');
  assert.equal(res.screen.popup, RATE_TEXT, 'the recheck row logs it');
  assert.equal(r.writes.length, before, 'P3: NO KEY INTO A POPUP (recheck): nothing typed');
  assert.ok(r.owner.inhibition('p1'), 'still held');
  // A person answers it (Esc: keep the current model); the composer is clean: released.
  r.needleOnPrompt = false; r.popup = null; r.gen += 1;
  const after = await r.recheck('w1');
  assert.equal(after.kind, 'RELEASED', `once the popup is answered, the held wake is released (got ${JSON.stringify(after)})`);
  assert.equal(r.writes.length, before, 'the release typed nothing either');
  assert.ok(noEsc(r.writes));
};
test('P3: the held wake\'s once-a-minute look never types into a popup, and releases once a person answers it', () => K.recheckNeverTypesIntoPopup());

K.trustAfterDraftNamed = async (M = OWNER) => {
  // ZT-175's shape: the startup draft, then the trust screen. Refused as before, now named.
  const draft = fixture('2-trusted-draft');
  const t = snapRows(path.join(FX, 'trust', 'codex_tui__onboarding__trust_directory__tests__renders_snapshot_for_git_repo.snap'));
  const lines = [...draft.lines, ...t];
  const r = rig({}, M);
  r.facts = () => factsOf(lines, draft.lines.length);
  const out = await r.submit('w1');
  assert.deepEqual(r.writes, [], 'nothing typed into the trust screen');
  assert.deepEqual(out, { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'MODAL:codex-popup:Folder access' }, 'THE POPUP IS NAMED BEFORE STARTUP');
};
test('P2: the trust screen after the startup draft is refused as before, and named as Codex\'s popup', () => K.trustAfterDraftNamed());

test('P2: a popup is a FOREIGN screen after STAGE (never a slow echo)', () => {
  assert.equal(OWNER.foreignScreenReason(`MODAL:codex-popup:${RATE_TEXT}`), true);
  assert.equal(OWNER.foreignScreenReason('UNKNOWN:not-the-empty-composer'), false);
});

// ─── P2: the words ──────────────────────────────────────────────────────────────────────

K.noticeWording = (L = LEDGER) => {
  const n = L.screenGuardNoticeText('Dwight', `MODAL:codex-popup:${RATE_TEXT}`, 300_000, 12);
  assert.equal(n.title, 'Codex is asking Dwight a question.', 'THE SCREEN-GUARD NOTICE NAMES THE QUESTION');
  assert.match(n.notice, /Codex is asking Dwight: "Approaching rate limits — Switch to gpt-6-luna for lower credit usage\?"\./);
  assert.match(n.notice, /never answers/);
  assert.match(n.notice, /answer it there\. To keep the current model, pick "Keep current model" \(or press Esc\)\./);
  assert.match(n.details, /screen check MODAL:codex-popup:Approaching rate limits/, 'the technical reason stays in details');
  const u = L.screenGuardNoticeText('Dwight', 'MODAL:codex-popup:Update available · 0.0.0 → 9.9.9', 300_000, 12);
  assert.match(u.notice, /Codex is asking Dwight: "Update available · 0\.0\.0 → 9\.9\.9"\./);
  assert.doesNotMatch(u.notice, /Keep current model/, 'advice only where it is known');
  const plain = L.screenGuardNoticeText('Dwight', 'UNKNOWN:not-the-empty-composer', 300_000, 12);
  assert.equal(plain.title, 'Dwight isn\'t getting messages right now.', 'any other refusal is worded as before');
  const h = L.heldInterferedNoticeText('Dwight', 2, Date.UTC(2026, 9, 1, 20, 28), TEXT, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', RATE_TEXT);
  assert.match(h.title, /^Dwight hasn't received 2 messages: Codex is asking Dwight a question\.$/, 'THE HELD-WAKE NOTICE NAMES THE QUESTION');
  assert.match(h.notice, /Codex is asking Dwight: "Approaching rate limits — Switch to gpt-6-luna for lower credit usage\?"/);
  assert.match(h.notice, /never answers it/);
  assert.match(h.details, /codex-popup:Approaching rate limits/);
  const old = L.heldInterferedNoticeText('Dwight', 2, Date.UTC(2026, 9, 1, 20, 28), TEXT, 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE');
  assert.equal(old.title, 'Dwight hasn\'t received 2 messages.', 'without a popup, worded as before');
  // The log rows carry it.
  const ledger = Object.create(L.MailLedger.prototype);
  ledger.notices = new Map(); const rows = []; ledger.log = (row) => rows.push(row);
  L.MailLedger.prototype.noteHeldInterferedAlert.call(ledger, 'dwight', { name: 'Dwight', messages: 2, at: 0, wakeText: TEXT, reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE', requestId: 'w1', asking: RATE_TEXT }, 300_000);
  assert.equal(rows[0].popup, RATE_TEXT, 'held-interfered-alert logs the popup');
  L.MailLedger.prototype.noteScreenGuardAlert.call(ledger, 'dwight', `MODAL:codex-popup:${RATE_TEXT}`, 300_000, 12, 'Dwight', 1);
  assert.equal(rows[1].reason, `MODAL:codex-popup:${RATE_TEXT}`, 'wake-screen-guard-alert logs it');
  assert.equal(ledger.notices.get('dwight|screen-guard').title, 'Codex is asking Dwight a question.');
};
test('P2: the screen-guard and held-wake notices say what Codex is asking (and the log rows carry it)', () => K.noticeWording());

K.holdLineWording = (V = HOLDVIEW) => {
  const base = { agentName: 'Dwight', interfered: null, paused: false, headManual: false, capacityHold: false, capacityEvidence: null };
  const v = V.deliveryHoldView({ ...base, screenHold: { reason: `MODAL:codex-popup:${RATE_TEXT}` } });
  assert.equal(v.kind, 'SCREEN');
  assert.equal(v.action, null, 'no button: the app never answers it');
  assert.match(v.hint, /Codex is asking Dwight a question/, 'THE COMPOSER SAYS WHAT CODEX IS ASKING');
  assert.match(v.title, /Codex is asking "Approaching rate limits — Switch to gpt-6-luna for lower credit usage\?"/);
  const plain = V.deliveryHoldView({ ...base, screenHold: { reason: 'startup:no-marker' } });
  assert.match(plain.hint, /terminal is not on its chat box/, 'any other screen hold is worded as before');
};
test('P2: the message box\'s hold line says what Codex is asking', () => K.holdLineWording());

// ─── P2: the held-wake watch words the notice from the latest look ──────────────────────

function watchRig(W = HELD) {
  const w = { now: 0, holds: [], raised: [], answer: { kind: 'HELD', why: 'UNKNOWN:not-the-empty-composer', screen: null } };
  w.watch = new W.HeldInterferenceWatch({
    heldWakes: () => w.holds,
    recheck: () => Promise.resolve(w.answer),
    released: () => {},
    notice: { raise: (h, now, asking) => w.raised.push([now, h.requestId, asking]), clear: () => {} },
    log: () => {},
    now: () => w.now
  });
  w.tick = async (t) => { w.now = t; w.watch.tick(t); await new Promise((res) => setImmediate(res)); };
  return w;
}
const HOLD = { agentId: 'dwight', requestId: 'w1', ptyId: 'p1', messages: 2, since: 0, reason: 'STAGED_TEXT_NOT_POSITIVELY_VISIBLE' };

K.heldNoticeNamesPopup = async (W = HELD) => {
  // Seen before the notice: the notice names it.
  const a = watchRig(W);
  a.holds = [HOLD];
  a.answer = { kind: 'HELD', why: `MODAL:codex-popup:${RATE_TEXT}`, screen: null };
  for (let t = 0; t <= 300_000; t += 15_000) await a.tick(t);
  assert.deepEqual(a.raised, [[300_000, 'w1', RATE_TEXT]], 'THE HELD NOTICE NAMES THE POPUP the latest look saw');
  // Seen after the notice: the notice is worded again, once; and again when it goes.
  const b = watchRig(W);
  b.holds = [HOLD];
  for (let t = 0; t <= 300_000; t += 15_000) await b.tick(t);
  assert.deepEqual(b.raised, [[300_000, 'w1', null]]);
  b.answer = { kind: 'HELD', why: `MODAL:codex-popup:${RATE_TEXT}`, screen: null };
  for (let t = 315_000; t <= 480_000; t += 15_000) await b.tick(t);
  assert.deepEqual(b.raised.slice(1), [[360_000, 'w1', RATE_TEXT]], 'A POPUP SEEN AFTER THE NOTICE REWORDS IT, once');
  b.answer = { kind: 'HELD', why: 'UNKNOWN:not-the-empty-composer', screen: null };
  for (let t = 495_000; t <= 600_000; t += 15_000) await b.tick(t);
  assert.deepEqual(b.raised.slice(2), [[540_000, 'w1', null]], 'and again when it is gone');
};
test('P2: the held-wake notice names a popup seen before it, and is reworded when one appears or goes', () => K.heldNoticeNamesPopup());

K.screenNoticeReworded = (G = GUARD) => {
  const raised = []; const cleared = [];
  const n = new G.ScreenGuardNotices({ raise: (a) => raised.push(a), clear: (id) => cleared.push(id) }, 1000);
  n.reading('dwight', false, 'UNKNOWN:not-the-empty-composer', true, 0);
  n.reading('dwight', false, 'UNKNOWN:not-the-empty-composer', true, 1000);
  assert.deepEqual(raised.map((a) => a.reason), ['UNKNOWN:not-the-empty-composer'], 'the run alerts once');
  n.reading('dwight', false, `MODAL:codex-popup:${RATE_TEXT}`, true, 2000);
  assert.deepEqual(raised.map((a) => a.reason), ['UNKNOWN:not-the-empty-composer', `MODAL:codex-popup:${RATE_TEXT}`], 'A POPUP SEEN AFTER THE SCREEN NOTICE REWORDS IT');
  assert.deepEqual([raised[1].refusedMs, raised[1].refusals], [2000, 3], 'with the run\'s own age and count');
  assert.deepEqual(cleared, ['dwight'], 'the old wording is cleared first (the ledger keeps one notice per agent)');
  n.reading('dwight', false, `MODAL:codex-popup:${RATE_TEXT}`, true, 3000);
  assert.equal(raised.length, 2, 'the same popup again: no new notice');
  n.reading('dwight', true, 'ok', true, 4000);
  n.reading('dwight', false, `MODAL:codex-popup:${RATE_TEXT}`, true, 5000);
  assert.equal(raised.length, 2, 'lifted: a new run waits its own 5 minutes before it alerts');
};
test('P2: a screen-guard notice already up is reworded when a popup appears (once)', () => K.screenNoticeReworded());

// ─── Static wiring ──────────────────────────────────────────────────────────────────────

test('wiring: the renderer extracts the tail with the facts, and main passes the popup to the held notice', () => {
  const pool = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/terminalPool.ts'), 'utf8');
  assert.match(pool, /extractCodexScreen\(\(i\) => buf\.getLine\(i\)\?\.translateToString\(true\), buf\.length, cursor\)/, 'the renderer reads the whole buffer (the tail is its bottom)');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(idx, /raise: \(h, now, asking\) => hive\.mail\.noteHeldInterferedAlert\(h\.agentId, \{[\s\S]{0,200}requestId: h\.requestId, asking,/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

const MUTANTS = [
  { name: 'P2: popups not recognised', file: 'src/shared/codexScreen.ts',
    edits: [["  if (popup) return { cls: 'MODAL', reason: `${CODEX_POPUP_REASON}${codexPopupText(popup)}` };", '']],
    killer: 'vendorPopupsNamed', dies: /THE POPUP IS NAMED/ },
  { name: 'P2: the hint looked for anywhere, not in the last two rows', file: 'src/shared/codexScreen.ts',
    edits: [['  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 2); i -= 1) {', '  for (let i = rows.length - 1; i >= 0; i -= 1) {']],
    killer: 'notAPopup', dies: /A QUOTED POPUP IN THE TRANSCRIPT IS NOT A POPUP/ },
  { name: 'P2: a key may be any word (the status line passes)', file: 'src/shared/codexScreen.ts',
    edits: [["const POPUP_KEY = '[A-Za-z][A-Za-z0-9+/-]*';", "const POPUP_KEY = '\\\\S+';"]],
    killer: 'notAPopup', dies: /THE STATUS LINE IS NOT A POPUP HINT/ },
  { name: 'Jim N1: an agent bullet taken for a title', file: 'src/shared/codexScreen.ts',
    edits: [["  if (title.startsWith('• ')) return null;\n", '']],
    killer: 'notAPopup', dies: /A SIDE CONVERSATION UNDER A BULLET IS NOT A POPUP/ },
  { name: 'Jim J2: any choice counts as selected', file: 'src/shared/codexScreen.ts',
    edits: [['  for (let i = hint - 1; i >= 0; i -= 1) if (POPUP_SELECTED.test(rows[i])) { selected = i; break; }', '  for (let i = hint - 1; i >= 0; i -= 1) if (POPUP_CHOICE.test(rows[i])) { selected = i; break; }']],
    killer: 'notAPopup', dies: /NO SELECTED CHOICE, NO POPUP/ },
  { name: 'Jim J3: no header required', file: 'src/shared/codexScreen.ts',
    edits: [['  if (top === 0) return null;', '  if (false) return null;']],
    killer: 'notAPopup', dies: /NO HEADER, NO POPUP/ },
  { name: 'P2: the tail trimmed (indent lost)', file: 'src/shared/codexScreen.ts',
    edits: [["    const row = (line(i) ?? '').trimEnd();\n    if (row.trim()) tail.unshift(cut(row));", "    const row = (line(i) ?? '').trim();\n    if (row.trim()) tail.unshift(cut(row));"]],
    killer: 'vendorPopupsNamed', dies: /THE POPUP IS NAMED/ },
  { name: 'P2: the tail not validated', file: 'src/shared/codexScreen.ts',
    edits: [[' || r.tail.length > CODEX_TAIL_ROWS) return null;', ') return null;']],
    killer: 'factsValidated', dies: /AN OVERSIZED OR MALFORMED TAIL IS NO READING/ },
  { name: 'P3: the held look erases into a popup', file: 'src/main/automaticSubmit.ts',
    edits: [["    if (modal.cls === 'MODAL') return stay(`${modal.cls}:${modal.reason}`, screen);\n", '']],
    killer: 'recheckNeverTypesIntoPopup', dies: /P3: NO KEY INTO A POPUP \(recheck\)/ },
  { name: 'P3: the erase types into a popup', file: 'src/main/automaticSubmit.ts',
    edits: [["      if (popup) return this.interfere(s, 'CODEX_POPUP_OPEN', codexPopupText(popup));\n", '']],
    killer: 'eraseNeverIntoPopup', dies: /P3: NOT EVEN THE ERASE/ },
  { name: 'P2: startup named before the popup', file: 'src/main/automaticSubmit.ts',
    edits: [["      if (comp.cls === 'MODAL') verdict = { ok: false, reason: `${comp.cls}:${comp.reason}` };\n      // A LOADING header", "      if (false) verdict = { ok: false, reason: `${comp.cls}:${comp.reason}` };\n      // A LOADING header"]],
    killer: 'trustAfterDraftNamed', dies: /THE POPUP IS NAMED BEFORE STARTUP/ },
  { name: 'P2: a popup after STAGE waited for as a slow echo', file: 'src/main/automaticSubmit.ts',
    edits: [[" || reason.startsWith('MODAL:');", ';']],
    killer: 'popupAfterStageHeldAtOnce', dies: /A POPUP AFTER STAGE IS NOT WAITED FOR/ },
  { name: 'P2: the held notice not reworded for a popup', file: 'src/main/heldInterference.ts',
    edits: [['        try { this.deps.notice.raise(h, now, popup); } catch { /* the notice is diagnostics; it never decides */ }\n', '']],
    killer: 'heldNoticeNamesPopup', dies: /A POPUP SEEN AFTER THE NOTICE REWORDS IT/ },
  { name: 'P2: the screen-guard notice not reworded for a popup', file: 'src/main/codexScreenGuard.ts',
    edits: [['      this.sink.raise({ agentId, reason, refusedMs: now - run.since, refusals: run.refusals });\n', '']],
    killer: 'screenNoticeReworded', dies: /A POPUP SEEN AFTER THE SCREEN NOTICE REWORDS IT/ },
  { name: 'P2: the screen-guard notice ignores the popup', file: 'src/main/mailLedger.ts',
    edits: [['  const asking = popupInReason(reason);', '  const asking = null;']],
    killer: 'noticeWording', dies: /THE SCREEN-GUARD NOTICE NAMES THE QUESTION/ },
  { name: 'P2: the composer hold line ignores the popup', file: 'src/shared/deliveryHold.ts',
    edits: [['    const asking = popupInReason(i.screenHold.reason);', '    const asking = null;']],
    killer: 'holdLineWording', dies: /THE COMPOSER SAYS WHAT CODEX IS ASKING/ }
];

test('MUTANT CENSUS: every mutant applies exactly once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      await K[m.killer]();                       // the real code passes the killer
      let text = fs.readFileSync(path.join(__dirname, '..', m.file), 'utf8');
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      for (const [from0, to0] of m.edits) {
        const from = from0.replace(/\n/g, eol); const to = to0.replace(/\n/g, eol);
        const hits = text.split(from).length - 1;
        assert.equal(hits, 1, `mutant "${m.name}": edit target must match EXACTLY ONCE, matched ${hits}`);
        text = text.replace(from, () => to);
      }
      const mod = loadTs.fromText(m.file, text);
      let died = null;
      try { await K[m.killer](mod); } catch (e) { died = e; }
      assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
      assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
      assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message.slice(0, 300)}`);
    });
  }
});
