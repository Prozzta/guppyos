'use strict';
require('./tools/own-job.cjs');
/**
 * WAKE-CODEX-MODAL-PROMPT-BLOCKS-108 (2026-11-27 17:22-17:28Z): Dwight restarted onto Codex's
 * "GPT-5.6 Terra retires" menu. Nothing told god:
 *
 *   1. the startup reading had the menu in its tail and reported only `no-marker`;
 *   2. liveness has no screen fact: IDLE/quiescent with no mail, UNKNOWN/awaiting-wake with mail;
 *   3. no hook after a restart = lifecycle unknown, so event wakes end `lifecycle-unknown`;
 *   4. the gate's `MODAL:codex-popup:<text>` refusal is a log row only; every alert waits 5 min
 *      and god's digest wake then waits the 10-minute batch window.
 *
 * Fix: the startup reading and the gate both tell CodexPopupWatch; liveness says
 * UNKNOWN/screen-popup; after a 20 s settle the digest carries ONE urgent decision naming the
 * popup and god is woken at once. Nothing types, and nothing answers a popup.
 *
 * The screens below are Dwight's own rows from log.jsonl (startup-reading and screen-gate).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');

const WATCH = 'src/main/codexPopupWatch.ts';
const DIGEST = 'src/main/floorDigest.ts';
const LIVE = 'src/main/agentLiveness.ts';
const OWNER = 'src/main/automaticSubmit.ts';
const INDEX = 'src/main/index.ts';
const W = loadTs(WATCH);
const FD = loadTs(DIGEST);
const L = loadTs(LIVE);
const O = loadTs(OWNER);
const SHARED = loadTs('src/shared/codexScreen.ts');

const MIN = 60_000;
const DWIGHT = 'dwight-mu32ztys';
const POPUP_TEXT = 'Switch to GPT-6.1 Terra to continue working in Codex.';
const GATE_REASON = `MODAL:codex-popup:${POPUP_TEXT}`;
const T_SEEN = 1795800155924;   // startup reading: incarnation 7, generation 17, no-marker
const T_GATE = 1795800488061;   // wake-screen-guard refusal, the same incarnation
const T_POST = 1795800504264;   // startup reading after the answer: generation 38, status-line
const CWD = 'C:\\PrzEdit';
const POPUP_ROWS = [
  '  GPT-5.6 Terra retires on December 23, 2026.',
  '  Switch to GPT-6.1 Terra to continue working in Codex.',
  '› 1. Try new model',
  '  2. Use existing model',
  '  enter/esc confirm · ctrl+c quit'
];
const POST_ROWS = [
  '  >_ OpenAI Codex (v0.167.0)',
  '     C:\\PrzEdit',
  '  permissions: YOLO mode',
  '› Ask Codex to do anything',
  '  GPT-5.6-Terra high · C:\\PrzEdit',
  '  ← for agents · ? for shortcuts                                          ⚠ 2 warnings · f2 to view'
];
const factsOf = (lines, cursorRow) => SHARED.extractCodexScreen((i) => lines[i], lines.length, cursorRow);
/** The popup frame: the cursor sat on an empty row under it (the logged cursorRow is ""). */
const POPUP_FACTS = factsOf([...POPUP_ROWS, ''], POPUP_ROWS.length);
const POST_FACTS = factsOf(POST_ROWS, 3);

function mutant(file, from, to) {
  const src = readSource(file);
  assert.ok(src.includes(from), `mutant anchor missing in ${file}: ${from}`);
  return loadTs.fromText(file, src.replace(from, () => to));
}

function watchRig(mod = W) {
  const rows = [];
  const live = { inc: 7, hookAt: 0 };
  return {
    rows, live,
    watch: new mod.CodexPopupWatch((row) => rows.push(row)),
    liveOf: { incarnation: () => live.inc, lastHookAt: () => live.hookAt }
  };
}

test('the fixture is Dwight\'s screen: codexPopup names the retirement menu, and the gate reason carries it', () => {
  assert.equal(POPUP_FACTS.cursorRow, '');
  assert.deepEqual(POPUP_FACTS.footer, []);
  const popup = SHARED.codexPopup(POPUP_FACTS);
  assert.ok(popup, 'the startup reading\'s own facts hold the popup');
  assert.equal(SHARED.codexPopupText(popup), POPUP_TEXT);
  assert.equal(SHARED.popupInReason(GATE_REASON), POPUP_TEXT);
  assert.equal(SHARED.codexPopup(POST_FACTS), null, 'the composer after the answer is no popup');
});

// ---------------------------------------------------------------- t1 a popup settles into a decision
function t1(mod) {
  const r = watchRig(mod);
  assert.equal(r.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN), 'raised');
  assert.deepEqual(r.rows, [{ kind: 'codex-popup-seen', agentId: DWIGHT, incarnation: 7, popup: POPUP_TEXT, source: 'startup' }]);
  assert.equal(r.watch.current(DWIGHT, T_SEEN, r.liveOf).text, POPUP_TEXT, 'up at once for liveness');
  assert.deepEqual(r.watch.popups(T_SEEN + mod.CODEX_POPUP_SETTLE_MS - 1, r.liveOf), [], 'not a decision before it has stayed up');
  // The same popup read again (a redraw, a refused wake) is the same popup: no row, same start.
  assert.equal(r.watch.note(DWIGHT, 7, POPUP_TEXT, 'gate', T_SEEN + mod.CODEX_POPUP_SETTLE_MS - 1), null);
  assert.equal(r.rows.length, 1);
  const up = r.watch.popups(T_SEEN + mod.CODEX_POPUP_SETTLE_MS, r.liveOf);
  assert.equal(up.length, 1, 'a decision once it has stayed up for the settle time');
  assert.deepEqual(up[0], { agentId: DWIGHT, incarnation: 7, text: POPUP_TEXT, since: T_SEEN, seenAt: T_SEEN + mod.CODEX_POPUP_SETTLE_MS - 1, source: 'startup' });
}
test('t1 a popup is up at once and a decision after the settle time; a re-read is the same popup', () => t1(W));

// ---------------------------------------------------------------- t2 a reading without it ends it
function t2(mod) {
  const r = watchRig(mod);
  r.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN);
  assert.equal(r.watch.note(DWIGHT, 7, null, 'startup', T_POST), 'cleared');
  assert.deepEqual(r.rows[1], { kind: 'codex-popup-cleared', agentId: DWIGHT, incarnation: 7, popup: POPUP_TEXT, why: 'startup', upMs: T_POST - T_SEEN });
  assert.equal(r.watch.current(DWIGHT, T_POST, r.liveOf), null);
  assert.deepEqual(r.watch.popups(T_POST + 10 * MIN, r.liveOf), []);
  assert.equal(r.watch.note(DWIGHT, 7, null, 'gate', T_POST + 1), null, 'no popup, nothing to clear');
  assert.equal(r.rows.length, 2);
}
test('t2 a reading with no popup ends it, with a row saying how long it was up', () => t2(W));

// ---------------------------------------------------------------- t3 what is true now ends it
function t3(mod) {
  const a = watchRig(mod);
  a.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN);
  a.live.hookAt = T_SEEN - 1;
  assert.ok(a.watch.current(DWIGHT, T_SEEN + MIN, a.liveOf), 'a hook from before the reading says nothing');
  a.live.hookAt = T_SEEN + 30_000;
  assert.deepEqual(a.watch.popups(T_SEEN + MIN, a.liveOf), [], 'a hook after the reading: Codex is running a session');
  assert.equal(a.rows[1].why, 'hook');

  const b = watchRig(mod);
  b.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN);
  b.live.inc = 8;
  assert.deepEqual(b.watch.popups(T_SEEN + MIN, b.liveOf), [], 'another incarnation: that screen is gone');
  assert.equal(b.rows[1].why, 'incarnation');

  const c = watchRig(mod);
  c.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN);
  c.live.inc = undefined;
  assert.equal(c.watch.current(DWIGHT, T_SEEN + MIN, c.liveOf), null, 'no terminal at all');
}
test('t3 a later hook, another incarnation or no terminal ends the popup at read time', () => t3(W));

// ---------------------------------------------------------------- t4 another popup is a new one
function t4(mod) {
  const r = watchRig(mod);
  r.watch.note(DWIGHT, 7, POPUP_TEXT, 'startup', T_SEEN);
  assert.equal(r.watch.note(DWIGHT, 7, 'Update available', 'gate', T_SEEN + MIN), 'raised', 'another question');
  assert.equal(r.watch.current(DWIGHT, T_SEEN + MIN, r.liveOf).since, T_SEEN + MIN);
  r.live.inc = 8;
  assert.equal(r.watch.note(DWIGHT, 8, 'Update available', 'startup', T_SEEN + 2 * MIN), 'raised', 'the same question on a new incarnation');
  assert.equal(r.watch.current(DWIGHT, T_SEEN + 2 * MIN, r.liveOf).since, T_SEEN + 2 * MIN);
  r.watch.forget(DWIGHT);
  assert.equal(r.watch.current(DWIGHT, T_SEEN + 2 * MIN, r.liveOf), null);
  assert.equal(r.watch.note('', 7, POPUP_TEXT, 'startup', T_SEEN), null, 'no agent, no sighting');
}
test('t4 another text or incarnation is a new popup; forget drops it', () => t4(W));

// ---------------------------------------------------------------- t5 the digest decision
function t5(fd) {
  const now = T_SEEN + 5 * MIN;
  const popup = { agentId: DWIGHT, name: 'Dwight', incarnation: 7, text: POPUP_TEXT, since: T_SEEN };
  const item = fd.codexPopupItem(popup, now);
  assert.equal(item.id, `codex-popup:${DWIGHT}:7:${T_SEEN}`);
  assert.equal(item.urgent, true);
  assert.equal(item.cardId, null);
  assert.ok(item.line.startsWith('Dwight: Codex has had a popup up for '), item.line);
  assert.ok(item.line.includes(`"${POPUP_TEXT}"`), 'the popup is named');
  assert.ok(item.line.includes('the harness typed nothing and chose nothing'), 'says nothing was answered');
  assert.ok(item.line.includes(`term read ${DWIGHT}`), 'says how god can look');
  assert.equal(fd.codexPopupItem({ ...popup, incarnation: null, name: undefined }, now).id, `codex-popup:${DWIGHT}:?:${T_SEEN}`);

  // The popup is the cause of that agent's refused wakes: one item for Dwight, not three.
  const wakeStalls = [
    { agentId: DWIGHT, why: 'lifecycle-unknown', inboxIds: 2, since: T_SEEN },
    { agentId: 'andy', why: 'lifecycle-unknown', inboxIds: 1, since: T_SEEN }
  ];
  const refused = [
    { agentId: DWIGHT, incarnation: 'pty-dwight#7', why: `SCREEN_NOT_READY ${GATE_REASON}`, count: 3, since: T_SEEN, inboxIds: 2, requestId: 'r1' },
    { agentId: 'sele', incarnation: 'pty-sele#2', why: 'SCREEN_NOT_READY startup:header-loading', count: 3, since: T_SEEN, inboxIds: 1, requestId: 'r2' }
  ];
  const ids = fd.decisionItems([], [], now, [], [], [], wakeStalls, refused, [popup]).map((i) => i.id);
  assert.deepEqual(ids, [
    `codex-popup:${DWIGHT}:7:${T_SEEN}`,
    `wake-stall:andy:${T_SEEN}`,
    `wake-refusal-stuck:sele:pty-sele#2:${T_SEEN}`
  ]);
  assert.deepEqual(fd.decisionItems([], [], now, [], [], [], [], [refused[0]], [popup]).map((i) => i.id), [`codex-popup:${DWIGHT}:7:${T_SEEN}`]);
  // Without a popup nothing changes for anyone.
  assert.equal(fd.decisionItems([], [], now, [], [], [], wakeStalls, refused).length, 3);
  const md = fd.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now, codexPopups: [popup] }).markdown;
  assert.ok(md.includes(`"${POPUP_TEXT}"`), 'the digest file lists it under the decisions');
}
test('t5 one urgent decision names the popup and replaces that agent\'s wake-stall and refused-settle items', () => t5(FD));

// ---------------------------------------------------------------- t6 god is woken at once
function t6(fd) {
  const WIN = 10 * MIN;
  const now = T_SEEN + 21_000;
  const popup = fd.codexPopupItem({ agentId: DWIGHT, incarnation: 7, text: POPUP_TEXT, since: T_SEEN }, now);
  const slow = { id: 'stale:A:2026-11-27', cardId: 'A', line: 'A: STALE evidence - still doing?' };
  let r = fd.decideGodWake([slow], { woken: {}, pendingSince: null }, now - MIN, WIN);
  assert.deepEqual(r.wake, [], 'an ordinary item waits out the window');
  r = fd.decideGodWake([popup, slow], r.state, now, WIN);
  assert.deepEqual(r.wake.map((i) => i.id), [popup.id], 'ONLY the popup wakes god inside the window');
  assert.equal(r.state.pendingSince, now - MIN, 'the ordinary item keeps the window it was in');
  r = fd.decideGodWake([popup, slow], r.state, now + MIN, WIN);
  assert.deepEqual(r.wake, [], 'the popup never wakes god twice');
  r = fd.decideGodWake([popup, slow], r.state, now - MIN + WIN, WIN);
  assert.deepEqual(r.wake.map((i) => i.id), [slow.id], 'the ordinary item goes at the end of its own window');
  // A popup alone: woken at once, and nothing is left pending.
  const alone = fd.decideGodWake([popup], { woken: {}, pendingSince: null }, now, WIN);
  assert.deepEqual(alone.wake.map((i) => i.id), [popup.id]);
  assert.equal(alone.state.pendingSince, null);
}
test('t6 the popup wakes god at once; ordinary items keep the batch window', () => t6(FD));

// ---------------------------------------------------------------- t7 liveness
function liveFacts(over = {}) {
  const now = T_SEEN + MIN;
  const base = {
    agentId: DWIGHT,
    registry: { archived: false, onHold: false },
    pty: { ptyId: 'pty-dwight', incarnation: 7, spawnedAt: now - 60 * MIN, lastTrafficAt: 0 },
    wake: { lifecycle: 'unknown', provisional: false, activeSince: 0, openTurnId: null, turnStartAt: 0, lastTurnEndAt: 0, lastHookAt: 0, lastHumanNeedsAt: 0 },
    control: { paused: false, halted: false, autoDeliveryPaused: false },
    mailWaiting: 0
  };
  return {
    ...base, ...over,
    pty: { ...base.pty, ...(over.pty ?? {}) },
    wake: { ...base.wake, ...(over.wake ?? {}) },
    control: { ...base.control, ...(over.control ?? {}) }
  };
}
function t7(mod) {
  const now = T_SEEN + MIN;
  const cr = (over) => { const v = mod.classifyLiveness(liveFacts(over), {}, undefined, now); return `${v.classification}/${v.reason}`; };
  // What Dwight got: free for work with no mail, then merely waiting for a wake.
  assert.equal(cr({}), 'IDLE/quiescent');
  assert.equal(cr({ mailWaiting: 2 }), 'UNKNOWN/awaiting-wake');
  // With the popup known it is neither.
  assert.equal(cr({ screenPopup: true }), 'UNKNOWN/screen-popup', 'not routable as idle');
  assert.equal(cr({ screenPopup: true, mailWaiting: 2 }), 'UNKNOWN/screen-popup');
  assert.equal(cr({ screenPopup: true, pty: { lastTrafficAt: now - 1000 } }), 'UNKNOWN/screen-popup', 'a popup that redraws is not progress');
  assert.equal(cr({ screenPopup: true, wake: { lifecycle: 'idle' } }), 'UNKNOWN/screen-popup', 'a popup at the end of a turn');
  assert.equal(cr({ screenPopup: true, control: { paused: true } }), 'UNKNOWN/screen-popup', 'a pause does not hide it');
  assert.equal(cr({ screenPopup: false, mailWaiting: 2 }), 'UNKNOWN/awaiting-wake');
}
test('t7 liveness: a popup is UNKNOWN/screen-popup, never IDLE, awaiting-wake or busy', () => t7(L));

test('liveness: an open turn and the boot grace still decide before the popup', () => {
  const now = T_SEEN + MIN;
  const cr = (over) => { const v = L.classifyLiveness(liveFacts(over), {}, undefined, now); return `${v.classification}/${v.reason}`; };
  assert.equal(cr({ screenPopup: true, wake: { lifecycle: 'active', activeSince: now - 1000 } }), 'BUSY_PROGRESSING/turn-started');
  assert.equal(cr({ screenPopup: true, pty: { spawnedAt: now - 1000 } }), 'UNKNOWN/boot-grace');
});

// ---------------------------------------------------------------- t8 the startup reading reports it
const ALLOW = { verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: null, state: null, workClass: 'ORDINARY_TURN', limitEpochAt: null };
function ownerRig(mod = O) {
  const r = { now: T_SEEN, seq: 0, timers: [], writes: [], popups: [], startup: [], gen: 17, facts: POPUP_FACTS };
  r.deps = {
    resolvePty: () => 'p1',
    incarnation: () => 7,
    humanGeneration: () => 0,
    write: (_id, d) => { r.writes.push(d); return { ok: true }; },
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
    readGuardScreen: () => Promise.resolve({ facts: r.facts, incarnation: 7, outputGeneration: r.gen }),
    outputGeneration: () => r.gen,
    spawnCwd: () => CWD,
    onScreenGuard: () => {},
    onStartupReading: (rec) => r.startup.push(rec),
    onStartupPopup: (rec) => r.popups.push(rec)
  };
  r.owner = new mod.AutomaticSubmitOwner(r.deps);
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
async function t8(mod) {
  const r = ownerRig(mod);
  assert.equal(await r.settle(r.owner.observeStartup('p1')), false, 'a popup is not past startup');
  assert.deepEqual(r.popups, [{ ptyId: 'p1', incarnation: 7, popup: POPUP_TEXT, outputGeneration: 17 }], 'THE STARTUP READING NAMES THE POPUP');
  // Every reading says so again: its absence is what ends the popup.
  r.gen = 18;
  await r.settle(r.owner.observeStartup('p1'));
  assert.equal(r.popups.length, 2);
  assert.equal(r.popups[1].popup, POPUP_TEXT);
  // Someone answered it (Dwight: generation 38, the composer with its status line).
  r.facts = POST_FACTS; r.gen = 38; r.now = T_POST;
  await r.settle(r.owner.observeStartup('p1'));
  assert.deepEqual(r.popups[2], { ptyId: 'p1', incarnation: 7, popup: null, outputGeneration: 38 });
  assert.deepEqual(r.writes, [], 'THE STARTUP READING TYPES NOTHING: no text, no Enter, no Esc, no digit');
}
test('t8 the Codex startup reading reports the popup, then its absence, and types nothing', () => t8(O));

test('a Claude terminal\'s startup reading reports no Codex popup', async () => {
  const r = ownerRig();
  r.deps.screenProvider = () => 'claude';
  r.deps.startupSettled = () => true;
  await r.settle(r.owner.observeStartup('p1'));
  assert.deepEqual(r.popups, []);
  assert.deepEqual(r.writes, []);
});

// ---------------------------------------------------------------- Dwight's timeline, end to end
test('replay 2026-11-27: seen at the startup reading, a decision 20 s later, god woken at once, gone when answered', () => {
  const r = watchRig();
  const WIN = 10 * MIN;
  const items = (now) => FD.decisionItems([], [], now, [], [], [], [], [],
    r.watch.popups(now, r.liveOf).map((p) => ({ agentId: p.agentId, name: 'Dwight', incarnation: p.incarnation, text: p.text, since: p.since })));
  const verdict = (now, mail) => {
    const v = L.classifyLiveness(liveFacts({ mailWaiting: mail, ...(r.watch.current(DWIGHT, now, r.liveOf) ? { screenPopup: true } : {}) }), {}, undefined, now);
    return `${v.classification}/${v.reason}`;
  };
  let state = { woken: {}, pendingSince: null };

  // 17:22:35Z the startup reading.
  assert.equal(r.watch.note(DWIGHT, 7, SHARED.codexPopupText(SHARED.codexPopup(POPUP_FACTS)), 'startup', T_SEEN), 'raised');
  assert.equal(verdict(T_SEEN, 0), 'UNKNOWN/screen-popup', 'was IDLE/quiescent');
  let w = FD.decideGodWake(items(T_SEEN + 19_000), state, T_SEEN + 19_000, WIN);
  assert.deepEqual(w.wake, [], 'a popup answered at once is nobody\'s decision');
  state = w.state;
  // 20 s on it is still up: one decision, and god is woken now, not after 5 + 10 minutes.
  w = FD.decideGodWake(items(T_SEEN + 21_000), state, T_SEEN + 21_000, WIN);
  assert.equal(w.wake.length, 1);
  assert.ok(w.wake[0].line.includes(`"${POPUP_TEXT}"`));
  assert.ok(FD.wakeBody(w.wake, 'floor-digest.md').includes(`[codex-popup:${DWIGHT}:7:${T_SEEN}]`));
  state = w.state;
  // 17:28:08Z a reconcile wake reaches the gate: the same popup, no second wake of god.
  assert.equal(r.watch.note(DWIGHT, 7, SHARED.popupInReason(GATE_REASON), 'gate', T_GATE), null);
  assert.equal(verdict(T_GATE, 2), 'UNKNOWN/screen-popup', 'was UNKNOWN/awaiting-wake');
  w = FD.decideGodWake(items(T_GATE), state, T_GATE, WIN);
  assert.deepEqual(w.wake, []);
  state = w.state;
  // 17:28:24Z answered by a person: the next startup reading has no popup.
  assert.equal(r.watch.note(DWIGHT, 7, SHARED.codexPopup(POST_FACTS) ? 'still' : null, 'startup', T_POST), 'cleared');
  assert.deepEqual(items(T_POST), []);
  assert.equal(verdict(T_POST, 2), 'UNKNOWN/awaiting-wake');
  assert.deepEqual(r.rows.map((x) => x.kind), ['codex-popup-seen', 'codex-popup-cleared']);
  assert.equal(r.rows[1].upMs, T_POST - T_SEEN);
});

// ---------------------------------------------------------------- the scheduler
test('the digest scheduler sends god the popup decision inside the batch window, once', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-modal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: T_SEEN + 21_000 };
  const sent = [];
  const up = { current: [{ agentId: DWIGHT, name: 'Dwight', incarnation: 7, text: POPUP_TEXT, since: T_SEEN }] };
  const digest = new FD.FloorDigest({
    root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), flags: () => [], ledgerIssues: () => [],
    send: (m, from) => sent.push({ ...m, from }), appendLog: () => {}, codexPopups: () => up.current
  }, () => ({ ...FD.FLOOR_DIGEST_DEFAULTS, wakeBatchMs: 10 * MIN }), () => clock.now);
  await digest.run();
  assert.equal(sent.length, 1, 'not held for the batch window');
  assert.deepEqual([sent[0].to, sent[0].from], ['god', 'digest']);
  assert.ok(sent[0].body.includes(`"${POPUP_TEXT}"`));
  assert.ok(fs.readFileSync(path.join(root, 'floor-digest.md'), 'utf8').includes(POPUP_TEXT));
  clock.now += 5 * MIN;
  await digest.run();
  assert.equal(sent.length, 1, 'one wake per popup');
  up.current = [];
  clock.now += 5 * MIN;
  await digest.run();
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------- wiring, and nothing types
test('index.ts feeds the watch from both readings and reads it for liveness and the digest', () => {
  const src = readSource(INDEX);
  for (const needle of [
    "onStartupPopup: (r) => noteCodexPopup(r.ptyId, r.incarnation, r.popup, 'startup'),",
    'const popup = r.ok ? null : popupInReason(r.reason);',
    "if (r.ok || popup !== null) noteCodexPopup(r.ptyId, r.incarnation, popup, 'gate');",
    'codexPopups: () => codexPopups.popups(Date.now(), popupLive)',
    '...(ptyId && pf && codexPopups.current(agentId, Date.now(), popupLive) ? { screenPopup: true } : {})',
    'try { codexPopups.forget(agentId); } catch { /* best-effort */ }'
  ]) assert.ok(src.includes(needle), `index.ts wiring missing: ${needle}`);
  assert.ok(readSource('src/main/automaticSubmitWiring.ts').includes('onStartupPopup: w.onStartupPopup,'), 'the wiring passes the dep through');
  assert.ok(readSource(DIGEST).includes("a.liveness?.reason === 'screen-popup' ? ' (a Codex popup is waiting for an answer)'"), 'the roster says so too');
});

test('nothing on this path can type: the watch and its feeder have no way to write to a terminal', () => {
  const typing = /\.write\(|sendKeys|sendInput|\.submit\(|ptyManager\.(?!incarnation\b)/;
  const watch = codeOnly(readSource(WATCH));
  assert.doesNotMatch(watch, typing);
  assert.doesNotMatch(watch, /\bimport\b/, 'the watch imports nothing');
  const src = readSource(INDEX);
  const from = src.indexOf('const codexPopups = new CodexPopupWatch(');
  const to = src.indexOf('\n}', src.indexOf('function noteCodexPopup('));
  assert.ok(from > 0 && to > from, 'the feeder block is where this test looks');
  assert.doesNotMatch(codeOnly(src.slice(from, to)), typing);
});

// ---------------------------------------------------------------- mutants
const MUTANTS = [
  { name: 'M1 no settle time', file: WATCH, from: 'if (s && now - s.since >= CODEX_POPUP_SETTLE_MS) out.push(s);', to: 'if (s) out.push(s);', killers: { t1 } },
  { name: 'M2 a re-read restarts the popup', file: WATCH, from: 'if (prev && prev.incarnation === incarnation && prev.text === text) {', to: 'if (false) {', killers: { t1 } },
  { name: 'M3 a reading without it does not end it', file: WATCH, from: '      this.end(prev, source, now);', to: '', killers: { t2 } },
  { name: 'M4 a later hook does not end it', file: WATCH, from: "if (hookAt > s.seenAt) { this.end(s, 'hook', now); return null; }", to: '', killers: { t3 } },
  { name: 'M5 another incarnation does not end it', file: WATCH, from: "if (inc === undefined || (s.incarnation !== null && inc !== s.incarnation)) { this.end(s, 'incarnation', now); return null; }", to: '', killers: { t3 } },
  { name: 'M6 forget is a no-op', file: WATCH, from: '    this.byAgent.delete(agentId);', to: '', killers: { t4 } },
  { name: 'M7 the item is not urgent', file: DIGEST, from: 'cardId: null, urgent: true,', to: 'cardId: null,', killers: { t5, t6 } },
  { name: 'M8 digest id without since', file: DIGEST, from: "id: `codex-popup:${p.agentId}:${p.incarnation ?? '?'}:${p.since}`", to: "id: `codex-popup:${p.agentId}:${p.incarnation ?? '?'}`", killers: { t5 } },
  { name: 'M9 the wake stall is not replaced', file: DIGEST, from: "if (covered.has(s.agentId) || popped.has(s.agentId) || s.why === 'held-interfered') continue;", to: "if (covered.has(s.agentId) || s.why === 'held-interfered') continue;", killers: { t5 } },
  { name: 'M10 the refused settle is not replaced', file: DIGEST, from: 'if (covered.has(r.agentId) || popped.has(r.agentId) || stalled.has(r.agentId)) continue;', to: 'if (covered.has(r.agentId) || stalled.has(r.agentId)) continue;', killers: { t5 } },
  { name: 'M11 urgent waits out the window', file: DIGEST, from: 'if (urgent.length === 0) return { wake: [], state: { woken, pendingSince: since } };', to: 'return { wake: [], state: { woken, pendingSince: since } };', killers: { t6 } },
  { name: 'M12 an urgent item drags the rest out early', file: DIGEST, from: 'const urgent = fresh.filter((i) => i.urgent === true);', to: 'const urgent = fresh.some((i) => i.urgent === true) ? fresh : [];', killers: { t6 } },
  { name: 'M13 liveness ignores the popup', file: LIVE, from: "if (facts.screenPopup === true) return verdict('UNKNOWN', 'screen-popup', inc);", to: '', killers: { t7 } },
  { name: 'M14 the startup reading never names the popup', file: OWNER, from: 'popup: popup ? codexPopupText(popup) : null,', to: 'popup: null,', killers: { t8 } },
  { name: 'M15 the startup reading reports a popup forever', file: OWNER, from: 'const popup = codexPopup(r.facts);\n', to: 'const popup = codexPopup(r.facts);\n        if (!popup) return false;\n', killers: { t8 } }
];

for (const m of MUTANTS) {
  test(`mutant ${m.name} is killed by ${Object.keys(m.killers).join(', ')}`, async () => {
    const mod = mutant(m.file, m.from, m.to);
    for (const [name, killer] of Object.entries(m.killers)) {
      await assert.rejects(async () => killer(mod), `${name} must go red under ${m.name}`);
    }
  });
}
