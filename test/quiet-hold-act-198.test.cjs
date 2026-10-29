'use strict';
require('./tools/own-job.cjs');

/**
 * QUIET-HOLD-ACT-ONLY (1.1.98): the quiet hold keyed on the act alone.
 *
 * C:/Meta/hive/log.jsonl 2026-10-22, 30 "held" wake rows: god's answer to Sele's conflict note
 * (12:09), the Human's spec correction to Speck mid-RAYB-6 (11:29; Speck finished at 11:35 without
 * it), the Human's hard-rule broadcasts (11:37, 11:41; released at max-delay 12:07), facts added to
 * McCey's open RAYB-9 (12:06, 12:07), the floor-pause broadcast (12:17) and McCey's RAYB-9/10
 * results sent as inform. Every one of them carried a fresh conversation id and no in_reply_to
 * (god's 12:09 answer pointed at an INFORM), so Jim B1 (answersOwnAsk) never saw them.
 *
 * The fix is shared/mailWakeClass.ts solicitedQuietMail (harness side; prompts and PROTOCOL are
 * untouched): an inform/agree wakes when (a1) it replies to anything the recipient sent, (a2) it
 * names the card or thread of an ask the recipient still owes, (b) it relays the Human or is a
 * hold/pause broadcast, (c) the recipient has an open ask to the sender and it names no other card.
 * mailLedger records `broadcast` and `humanRelay` at delivery (the body is not kept).
 *
 * Each guarantee is a K.* check that takes the module under test, so the MUTANT CENSUS at the end
 * runs the same check against a mutated copy and requires it to die for the right reason. The
 * integrated replay (real bridge, ledgers, hooks and PTYs) is test/mail-rig-quiet-198.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const CLASS = 'src/shared/mailWakeClass.ts';
const LEDGER = 'src/main/mailLedger.ts';
const real = { cls: loadTs(CLASS), ledger: loadTs(LEDGER) };

const NOW = 50_000_000;
const MIN = 60_000;
const HOLD = 30 * MIN;
const K = {};

/** A delivered inform as the recipient's ledger holds it. */
const inform = (id, over = {}) => ({ id, from: 'god', act: 'inform', requiresReply: false, deliveredAt: NOW, conversation: `conv-${id}`, ...over });
/** An ask as the RECEIVER's ledger holds it (open unless `over` closes it). */
const ask = (id, from, over = {}) => ({ id, from, act: 'request', requiresReply: true, deliveredAt: NOW - MIN, conversation: `conv-${id}`, ...over });

/**
 * The 2026-10-22 floor, as ledgers: speck owes god RAYB-6 (conv-r6); mccey owes god RAYB-9
 * (conv-r9) and already sent an interim inform on it; sele owes god RAYB-11; god's own ledger
 * holds Sele's conflict note (id sele-1, also under the alias sele-x) and a note from andy.
 */
function floor() {
  const docs = {
    speck: [ask('r6', 'god', { cardId: 'RAYB-6' }), ask('r5', 'god', { cardId: 'RAYB-5', closedAt: NOW - 1 })],
    mccey: [ask('r9', 'god', { cardId: 'RAYB-9', repliedAt: NOW - 2, replyAct: 'inform' }), ask('r4', 'god', { cardId: 'RAYB-4', repliedAt: NOW - 2, replyAct: 'done' })],
    sele: [ask('r11', 'god', { cardId: 'RAYB-11' })],
    andy: [ask('j1', 'jim', { cardId: 'JIM-1' })],
    god: [inform('sele-1', { from: 'sele', senderId: 'sele-x', conversation: 'conv-f2bb20' }), inform('andy-1', { from: 'andy' })]
  };
  return { entries: (id) => docs[id] ?? [] };
}

// ─── 1. the solicited rules ─────────────────────────────────────────────────────

K.replyToOwnMessageWakes = (cls = real.cls) => {
  const L = floor();
  // god's 12:09 answer to Sele: in_reply_to her INFORM (not an asking act), so B1 said no.
  assert.equal(cls.solicitedQuietMail(inform('g1', { inReplyTo: 'sele-1', cardId: 'RAYB-9' }), 'sele', L), true, 'A REPLY TO ANYTHING I SENT WAKES ME');
  assert.equal(cls.solicitedQuietMail(inform('g2', { inReplyTo: 'sele-x' }), 'sele', L), true, 'A REPLY VIA THE SENDER_ID ALIAS WAKES ME');
  assert.equal(cls.solicitedQuietMail(inform('g3', { inReplyTo: 'andy-1' }), 'sele', L), false, "A REPLY TO SOMEONE ELSE'S MESSAGE STAYS QUIET");
  assert.equal(cls.solicitedQuietMail(inform('g4', { inReplyTo: 'nowhere' }), 'sele', L), false, 'A REPLY TO AN UNKNOWN ID STAYS QUIET');
  assert.equal(cls.answersOwnAsk(inform('g1', { inReplyTo: 'sele-1' }), 'sele', (h, id) => L.entries(h).find((x) => x.id === id)), false, 'B1 alone still says no: the original was an inform');
};
test('a1: an inform/agree in_reply_to ANY message the recipient sent wakes it (B1 widened past the asking acts)', () => K.replyToOwnMessageWakes());

K.factOnOpenAskWakes = (cls = real.cls) => {
  const L = floor();
  // 11:13 "RAYB-4 landed" (card RAYB-5 then open) and 11:29 "RAYB-6 spec correction" (card RAYB-6).
  assert.equal(cls.solicitedQuietMail(inform('g1', { cardId: 'RAYB-6' }), 'speck', L), true, 'A FACT ON THE CARD I AM WORKING WAKES ME');
  assert.equal(cls.solicitedQuietMail(inform('g2', { conversation: 'conv-r6' }), 'speck', L), true, 'A FACT IN THE THREAD OF MY OPEN ASK WAKES ME');
  assert.equal(cls.solicitedQuietMail(inform('g3', { cardId: 'RAYB-7' }), 'speck', L), false, 'A FACT ON ANOTHER CARD STAYS QUIET');
  assert.equal(cls.solicitedQuietMail(inform('g4', { cardId: 'RAYB-5' }), 'speck', L), false, 'A CLOSED ASK SOLICITS NOTHING');
  assert.equal(cls.solicitedQuietMail(inform('g5', { cardId: 'RAYB-4' }), 'mccey', L), false, 'A DISCHARGED ASK SOLICITS NOTHING');
  // 12:06 / 12:07: the Pixel and Android facts, while McCey had answered RAYB-9 only in the interim.
  assert.equal(cls.solicitedQuietMail(inform('g6', { cardId: 'RAYB-9' }), 'mccey', L), true, 'AN ASK ANSWERED ONLY IN THE INTERIM IS STILL OPEN');
  assert.equal(cls.solicitedQuietMail(inform('g7'), 'speck', L), false, 'A PLAIN FYI (NO CARD, NEW THREAD) STAYS QUIET');
};
test('a2: an inform naming the card or thread of an ask the recipient still owes wakes it; other cards, closed and discharged asks do not', () => K.factOnOpenAskWakes());

K.humanRelayAndHoldWake = (cls = real.cls) => {
  const L = floor();
  assert.equal(cls.solicitedQuietMail(inform('g1', { humanRelay: true }), 'andy', L), true, 'A HUMAN RELAY WAKES');
  assert.equal(cls.solicitedQuietMail(inform('g2', { broadcast: true, subject: 'Floor paused' }), 'andy', L), true, 'A FLOOR-PAUSE BROADCAST WAKES');
  assert.equal(cls.solicitedQuietMail(inform('g3', { broadcast: true, subject: 'HOLD all pushes until the tag lands' }), 'andy', L), true, 'A HOLD BROADCAST WAKES');
  assert.equal(cls.solicitedQuietMail(inform('g4', { broadcast: true, subject: 'weekly status: all green' }), 'andy', L), false, 'A STATUS BROADCAST STAYS QUIET');
  assert.equal(cls.solicitedQuietMail(inform('g5', { subject: 'Floor paused' }), 'andy', L), false, 'A PAUSE WORD IN AN ADDRESSED FYI IS NOT A HOLD NOTICE');
  assert.equal(cls.HUMAN_RELAY_RE.test('humane treatment'), false, 'whole word only');
  assert.equal(cls.HUMAN_RELAY_RE.test("The Human's rule"), true);
};
test('b: a Human relay or a hold/pause broadcast wakes; a status broadcast is still a quiet FYI', () => K.humanRelayAndHoldWake());

K.resultAsInformWakes = (cls = real.cls) => {
  const L = floor();
  // 12:08:37 / 12:12:40: McCey's "RAYB-9 done" and "RAYB-10 done" went to god as INFORM, no card.
  assert.equal(cls.solicitedQuietMail(inform('m1', { from: 'mccey' }), 'god', L), true, 'A RESULT SENT AS INFORM WAKES ITS ASKER');
  assert.equal(cls.solicitedQuietMail(inform('m2', { from: 'mccey', cardId: 'RAYB-9' }), 'god', L), true, 'A RESULT NAMING THE OPEN CARD WAKES ITS ASKER');
  assert.equal(cls.solicitedQuietMail(inform('m3', { from: 'mccey', cardId: 'RAYB-12' }), 'god', L), false, 'AN INFORM NAMING ANOTHER CARD STAYS QUIET');
  assert.equal(cls.solicitedQuietMail(inform('a1', { from: 'andy' }), 'god', L), false, 'AN INFORM FROM AN AGENT I ASKED NOTHING OF STAYS QUIET');
};
test('c: an inform from an agent the recipient has an open ask to is the result and wakes, unless it names another card', () => K.resultAsInformWakes());

test('fail open: a ledger reader that throws wakes (mailWakeClass catches it, as for B1)', () => {
  const boom = { entries: () => { throw new Error('ledger unreadable'); } };
  assert.equal(real.cls.mailWakeClass(inform('x1'), 'inject', (e) => real.cls.solicitedQuietMail(e, 'speck', boom)), 'wake');
  assert.equal(real.cls.mailWakeClass(inform('x1'), 'inject', (e) => real.cls.solicitedQuietMail(e, 'speck', floor())), 'quiet');
});

// ─── 2. the ledger flags and the Meta replay on real ledgers ──────────────────

function realLedgers(t, agents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-quiet-hold-198-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  for (const a of agents) fs.mkdirSync(path.join(root, 'agents', a, 'inbox', '.done'), { recursive: true });
  const L = real.ledger;
  const ml = new L.MailLedger({ root: () => root, appendLog: () => {}, readLogRows: () => [], clock: () => NOW, setTimer: () => ({}), clearTimer: () => {} });
  t.after(() => ml.dispose());
  return ml;
}

K.ledgerFlags = (L = real.ledger, t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-quiet-hold-198-flags-'));
  fs.mkdirSync(path.join(home, 'agents', 'andy-1', 'inbox', '.done'), { recursive: true });
  const ml = new L.MailLedger({ root: () => home, appendLog: () => {}, readLogRows: () => [], clock: () => NOW, setTimer: () => ({}), clearTimer: () => {} });
  // Under a mutant (no `t`) the temp dir is removed here; under node:test it waits for t.after.
  const cleanup = () => { ml.dispose(); fs.rmSync(home, { recursive: true, force: true }); };
  if (t) t.after(cleanup);
  try {
    const e = (msg) => { ml.markDelivered('andy-1', { from: 'god', act: 'inform', subject: 's', body: 'b', ...msg }); return ml.ledger('andy-1').entries[msg.id]; };
    assert.equal(e({ id: 'b1', to: 'broadcast', subject: 'Floor paused by the Human' }).broadcast, true, 'A BROADCAST COPY IS FLAGGED');
    assert.equal('broadcast' in e({ id: 'b2', to: 'andy-1' }), false, 'an addressed copy carries no flag');
    // A Human relay is the Human in the SUBJECT, or a broadcast with the Human in the body. An addressed
    // cc that only quotes the Human in its body is a routine cc (0f1baba7 woke every such cc).
    assert.equal('humanRelay' in e({ id: 'h1', body: "The Human's rule, which is absolute" }), false, 'A BODY-ONLY HUMAN CC STAYS A ROUTINE CC');
    assert.equal(e({ id: 'h2', subject: 'RAYB-6 spec correction from the Human', body: 'narrows the tap rules' }).humanRelay, true, 'A HUMAN RELAY IS FLAGGED: THE SUBJECT NAMES THE HUMAN');
    assert.equal(e({ id: 'h5', to: 'broadcast', subject: 'RAYB hard rule: never fall back to Meta AI', body: "The Human's rule, which is absolute" }).humanRelay, true, 'A BROADCAST WITH THE HUMAN IN THE BODY IS A RELAY');
    assert.equal('humanRelay' in e({ id: 'h6', to: 'broadcast', subject: 'Floor paused', body: 'until god announces a resume' }), false, 'a broadcast without the Human is no relay (the hold notice is rule b\'s other half)');
    assert.equal('humanRelay' in e({ id: 'h3', subject: 'weekly status', body: 'humane, inhumanly fast' }), false, 'whole word only: no flag');
    assert.equal('humanRelay' in e({ id: 'h4', body: { not: 'a string' } }), false, 'a non-string body is not read');
  } finally { if (!t) cleanup(); }
};
test('mailLedger: a broadcast copy and a Human relay are flagged at delivery (the body is not kept)', (t) => K.ledgerFlags(real.ledger, t));

/** The 2026-10-22 Meta sequences, replayed on real ledgers through quietHolds + solicitedQuietMail. */
K.metaReplay = (cls = real.cls, L = real.ledger) => (t) => {
  const AG = ['god', 'speck', 'mccey', 'sele', 'andy'];
  const ml = realLedgers(t, AG);
  const d = (to, msg) => ml.markDelivered(to, { from: 'god', body: 'b', ...msg });
  const ledgers = { entries: (id) => Object.values(ml.ledger(id).entries) };
  const holdsFor = (id) => [...cls.quietHolds(Object.values(ml.ledger(id).entries), 'inject', HOLD, NOW, (e) => cls.solicitedQuietMail(e, id, ledgers)).keys()];
  // The dispatches (requests wake, and are the open asks the rest hang off).
  d('speck', { id: 'r5', act: 'request', card: 'RAYB-5', subject: 'RAYB-5: audit the gesture route' });
  d('speck', { id: 'r6', act: 'request', card: 'RAYB-6', subject: 'RAYB-6: tap rules' });
  d('mccey', { id: 'r9', act: 'request', card: 'RAYB-9', subject: 'RAYB-9: provider stack' });
  d('mccey', { id: 'r10', act: 'request', card: 'RAYB-10', subject: 'RAYB-10: NL key' });
  d('sele', { id: 'r11', act: 'request', card: 'RAYB-11', subject: 'RAYB-11: research' });
  // 11:13 fact on Speck's open RAYB-5; 11:29 the Human's correction mid-RAYB-6.
  d('speck', { id: '2026-10-22T11-13-24-748Z-233428', act: 'inform', card: 'RAYB-5', subject: 'RAYB-4 landed: research/raybans/button-trigger.md', body: "McCey's gesture research is in. Fold it into your RAYB-5 audit." });
  d('speck', { id: '2026-10-22T11-29-12-973Z-b98398', act: 'inform', card: 'RAYB-6', subject: 'RAYB-6 spec correction from the Human', body: 'The Human corrected the tap rules, so this narrows RAYB-6.' });
  // 11:37 / 11:41 the Human's hard rules, 12:17 the floor pause: broadcasts, one copy per agent.
  for (const a of ['speck', 'mccey', 'sele', 'andy']) {
    d(a, { id: '2026-10-22T11-37-39-269Z-db865e', act: 'inform', to: 'broadcast', card: 'RAYB-3', subject: 'RAYB hard rule: never fall back to Meta AI launching our app', body: "The Human's rule, which is absolute: our app must NEVER be started through Meta AI." });
    d(a, { id: '2026-10-22T11-41-02-146Z-789408', act: 'inform', to: 'broadcast', card: 'RAYB-3', conversation: 'conv-f2bb20', subject: 'RAYB hard rules: no always-on mic, no extra BT button; ChatGPT first; text answers', body: 'New decisions from the Human: (1) The glasses mic is NEVER kept streaming.' });
    d(a, { id: '2026-10-22T12-17-52-683Z-b4323d', act: 'inform', to: 'broadcast', conversation: 'conv-ba71b8', subject: 'Floor paused by the Human', body: 'The Human asked to pause. Do not start new work until god announces a resume.' });
  }
  // 12:06 / 12:07 facts added to McCey's open RAYB-9.
  d('mccey', { id: '2026-10-22T12-06-33-104Z-522ed3', act: 'inform', card: 'RAYB-9', subject: 'RAYB-9: phone is Pixel 10 Pro XL', body: "The Human's phone is a Pixel 10 Pro XL." });
  d('mccey', { id: '2026-10-22T12-07-22-138Z-463508', act: 'inform', card: 'RAYB-9', subject: 'RAYB-9: phone runs Android 17', body: 'Pixel 10 Pro XL on Android 17. Keep it brief.' });
  // 12:08:02 Sele's conflict note to god (in the 11:41 broadcast's conversation, no card); 12:08:37 and
  // 12:12:40 McCey's results as inform; 12:09:31 god's answer in_reply_to Sele's INFORM; 12:15:45 god's
  // "send it as done" in_reply_to McCey's inform.
  d('god', { id: '2026-10-22T12-08-02-709Z-1664a2', from: 'sele', act: 'inform', conversation: 'conv-f2bb20', subject: 'RAYB rules ack; RAYB-9 title conflicts with ChatGPT-first', body: 'Ack both RAYB hard rules. One thing to fix: tasks.json RAYB-9 is still titled Gemini.' });
  d('god', { id: '2026-10-22T12-08-37-039Z-2b55f0', from: 'mccey', act: 'inform', conversation: 'conv-902655', subject: 'RAYB-9 done: stack works at zero cost WITH CAVEATS', body: 'File: research/raybans/provider-stack.md. VERDICT: with caveats.' });
  d('sele', { id: '2026-10-22T12-09-31-000Z-aaaaaa', act: 'inform', card: 'RAYB-9', in_reply_to: '2026-10-22T12-08-02-709Z-1664a2', subject: 'RAYB: ChatGPT-first is superseded, provider is free Gemini', body: 'Superseded.' });
  d('god', { id: '2026-10-22T12-12-40-188Z-a81619', from: 'mccey', act: 'inform', conversation: 'conv-f3110d', subject: 'RAYB-10 done: Gemini free key from NL is GREY; top 2 = Groq, Mistral', body: 'Section appended.' });
  d('mccey', { id: '2026-10-22T12-15-45-000Z-bbbbbb', act: 'inform', card: 'RAYB-10', in_reply_to: '2026-10-22T12-12-40-188Z-a81619', subject: 'RAYB-10 closed. Send finished results as act done', body: 'Closed.' });
  // The controls: routine FYIs nobody asked for, which the hold is for.
  d('andy', { id: 'fyi-1', act: 'inform', subject: 'quiet time on', body: 'status only' });
  d('speck', { id: 'fyi-2', from: 'andy', act: 'inform', subject: 'FYI: my branch is pushed', body: 'nothing for you to do' });
  d('god', { id: 'fyi-3', from: 'andy', act: 'inform', subject: 'FYI: lunch', body: 'back at 13:00' });

  assert.deepEqual(holdsFor('speck'), ['fyi-2'], 'SPECK: THE RAYB-4 FACT, THE HUMAN CORRECTION AND THE BROADCASTS WAKE; THE FYI WAITS');
  assert.deepEqual(holdsFor('mccey'), [], 'MCCEY: THE PIXEL/ANDROID FACTS, THE BROADCASTS AND THE CLOSE WAKE');
  assert.deepEqual(holdsFor('sele'), [], "SELE: GOD'S ANSWER TO HER INFORM AND THE BROADCASTS WAKE");
  assert.deepEqual(holdsFor('andy'), ['fyi-1'], 'ANDY: THE BROADCASTS WAKE; THE STATUS FYI WAITS');
  assert.deepEqual(holdsFor('god'), ['fyi-3'], "GOD: MCCEY'S RESULTS AND SELE'S NOTE ON AN OPEN ASK WAKE; THE LUNCH FYI WAITS");
};
test('META REPLAY (2026-10-22, real ledgers): every held answer, correction, relay, fact and result wakes; the three routine FYIs still wait', (t) => K.metaReplay()(t));

// ─── 3. the wiring ──────────────────────────────────────────────────────────────

test('main: quietUntil asks solicitedQuietMail over every ledger (the asks this agent sent sit in the receivers\' ledgers)', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /import \{ quietHolds, quietMailHoldMs, solicitedQuietMail \} from '\.\.\/shared\/mailWakeClass';/);
  assert.match(index, /const ledgers = \{ entries: \(holder: string\) => Object\.values\(hive\.mail\.ledger\(holder\)\.entries\) \};\n      return quietHolds\(ids\.map\(\(id\) => entries\[id\]\)\.filter\(\(e\) => !!e\), hookServer\.mailChannel\(agentId\)\.mode, holdMs, now,\n        \(e\) => solicitedQuietMail\(e, agentId, ledgers\)\);/);
  const ledger = readSource(LEDGER);
  assert.match(ledger, /\.\.\.\(msg\.to === 'broadcast' \? \{ broadcast: true \} : \{\}\),/);
  assert.match(ledger, /\.\.\.\(HUMAN_RELAY_RE\.test\(String\(msg\.subject \?\? ''\)\) \|\| \(msg\.to === 'broadcast' && typeof msg\.body === 'string' && HUMAN_RELAY_RE\.test\(msg\.body\)\) \? \{ humanRelay: true \} : \{\}\),/);
  // The rig host carries the same dep, so mail-rig-quiet-198 exercises the product wiring.
  const host = readSource('test/mail-rig/rig-host.cjs');
  assert.match(host, /\(e\) => wakeClass\.solicitedQuietMail\(e, agentId, ledgers\)\);/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { name: 'a1: only the asking acts count (the 1.1.81 B1 rule)', file: CLASS,
    edits: [['    if (orig && orig.from === recipientId) return true;', "    if (orig && orig.from === recipientId && (orig.requiresReply || ASKING_ACTS.has(String(orig.act ?? '')))) return true;"]],
    killer: 'replyToOwnMessageWakes', dies: /A REPLY TO ANYTHING I SENT WAKES ME/ },
  { name: 'a1: any reply wakes (the original\'s sender ignored)', file: CLASS,
    edits: [['    if (orig && orig.from === recipientId) return true;', '    if (orig) return true;']],
    killer: 'replyToOwnMessageWakes', dies: /A REPLY TO SOMEONE ELSE'S MESSAGE STAYS QUIET/ },
  { name: 'a1: the sender_id alias is not resolved', file: CLASS,
    edits: [['(!!x.senderId && x.senderId === e.inReplyTo)', 'false']],
    killer: 'replyToOwnMessageWakes', dies: /A REPLY VIA THE SENDER_ID ALIAS WAKES ME/ },
  { name: 'a2: the asks the recipient is working are ignored', file: CLASS,
    edits: [['  return ledgers.entries(recipientId).some((x) => stillOwed(x) && sameThread(x));', '  return false;']],
    killer: 'factOnOpenAskWakes', dies: /A FACT ON THE CARD I AM WORKING WAKES ME/ },
  { name: 'a2: the thread is not matched, only the card', file: CLASS,
    edits: [['(!!x.conversation && x.conversation === e.conversation)', 'false']],
    killer: 'factOnOpenAskWakes', dies: /A FACT IN THE THREAD OF MY OPEN ASK WAKES ME/ },
  { name: 'a2: any open ask solicits everything (the card is not matched)', file: CLASS,
    edits: [['  return ledgers.entries(recipientId).some((x) => stillOwed(x) && sameThread(x));', '  return ledgers.entries(recipientId).some((x) => stillOwed(x));']],
    killer: 'factOnOpenAskWakes', dies: /A FACT ON ANOTHER CARD STAYS QUIET/ },
  { name: 'a2: a closed ask still solicits', file: CLASS,
    edits: [['  if (x.closedAt) return false;\n', '']],
    killer: 'factOnOpenAskWakes', dies: /A CLOSED ASK SOLICITS NOTHING/ },
  { name: 'a2: a discharged (done) ask still solicits', file: CLASS,
    edits: [['  return !x.repliedAt || (!!x.replyAct && !DISCHARGING.has(x.replyAct));', '  return true;']],
    killer: 'factOnOpenAskWakes', dies: /A DISCHARGED ASK SOLICITS NOTHING/ },
  { name: 'a2: an interim reply closes the ask', file: CLASS,
    edits: [['  return !x.repliedAt || (!!x.replyAct && !DISCHARGING.has(x.replyAct));', '  return !x.repliedAt;']],
    killer: 'factOnOpenAskWakes', dies: /AN ASK ANSWERED ONLY IN THE INTERIM IS STILL OPEN/ },
  { name: 'b: the Human relay is held', file: CLASS,
    edits: [['  if (e.humanRelay === true) return true;\n', '']],
    killer: 'humanRelayAndHoldWake', dies: /A HUMAN RELAY WAKES/ },
  { name: 'b: the hold/pause broadcast is held', file: CLASS,
    edits: [["  if (e.broadcast === true && HOLD_NOTICE_RE.test(String(e.subject ?? ''))) return true;\n", '']],
    killer: 'humanRelayAndHoldWake', dies: /A FLOOR-PAUSE BROADCAST WAKES/ },
  { name: 'b: every broadcast wakes', file: CLASS,
    edits: [["  if (e.broadcast === true && HOLD_NOTICE_RE.test(String(e.subject ?? ''))) return true;", '  if (e.broadcast === true) return true;']],
    killer: 'humanRelayAndHoldWake', dies: /A STATUS BROADCAST STAYS QUIET/ },
  { name: 'b: a pause word wakes an addressed FYI too', file: CLASS,
    edits: [["  if (e.broadcast === true && HOLD_NOTICE_RE.test(String(e.subject ?? ''))) return true;", "  if (HOLD_NOTICE_RE.test(String(e.subject ?? ''))) return true;"]],
    killer: 'humanRelayAndHoldWake', dies: /A PAUSE WORD IN AN ADDRESSED FYI IS NOT A HOLD NOTICE/ },
  { name: 'c: a result sent as inform is held', file: CLASS,
    edits: [['  if (toSender.length && (!e.cardId || toSender.some(sameThread))) return true;\n', '']],
    killer: 'resultAsInformWakes', dies: /A RESULT SENT AS INFORM WAKES ITS ASKER/ },
  { name: 'c: an inform about another card wakes the asker too', file: CLASS,
    edits: [['(!e.cardId || toSender.some(sameThread))', 'true']],
    killer: 'resultAsInformWakes', dies: /AN INFORM NAMING ANOTHER CARD STAYS QUIET/ },
  { name: 'c: any agent\'s inform wakes (the asker is not matched)', file: CLASS,
    edits: [['.filter((x) => x.from === recipientId && stillOwed(x));', '.filter((x) => stillOwed(x));']],
    killer: 'resultAsInformWakes', dies: /AN INFORM FROM AN AGENT I ASKED NOTHING OF STAYS QUIET/ },
  { name: 'ledger: the broadcast flag is never set', file: LEDGER,
    edits: [["    ...(msg.to === 'broadcast' ? { broadcast: true } : {}),\n", '']],
    killer: 'ledgerFlags', dies: /A BROADCAST COPY IS FLAGGED/ },
  { name: 'ledger: the Human relay flag is never set', file: LEDGER,
    edits: [["? { humanRelay: true } : {}),", '? {} : {}),']],
    killer: 'ledgerFlags', dies: /A HUMAN RELAY IS FLAGGED/ },
  { name: 'ledger: the subject is not read', file: LEDGER,
    edits: [["HUMAN_RELAY_RE.test(String(msg.subject ?? '')) ||", "false ||"]],
    killer: 'ledgerFlags', dies: /A HUMAN RELAY IS FLAGGED: THE SUBJECT NAMES THE HUMAN/ },
  { name: 'ledger: an addressed cc with the Human in its body is a relay again (0f1baba7)', file: LEDGER,
    edits: [["HUMAN_RELAY_RE.test(String(msg.subject ?? '')) || (msg.to === 'broadcast' && typeof msg.body === 'string' && HUMAN_RELAY_RE.test(msg.body))", "HUMAN_RELAY_RE.test(`${msg.subject ?? ''}\\n${typeof msg.body === 'string' ? msg.body : ''}`)"]],
    killer: 'ledgerFlags', dies: /A BODY-ONLY HUMAN CC STAYS A ROUTINE CC/ },
  { name: "ledger: a broadcast's body is not read", file: LEDGER,
    edits: [["(msg.to === 'broadcast' && typeof msg.body === 'string' && HUMAN_RELAY_RE.test(msg.body))", "false"]],
    killer: 'ledgerFlags', dies: /A BROADCAST WITH THE HUMAN IN THE BODY IS A RELAY/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const mod = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
      assert.throws(() => K[m.killer](mod), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
  // The replay itself, against the three rules the Meta rows most needed, dies at the named agent.
  for (const [name, edits, dies] of [
    ['replay: a1 off', [['    if (orig && orig.from === recipientId) return true;', '    if (false) return true;']], /SELE: GOD'S ANSWER/],
    ['replay: c off', [['  if (toSender.length && (!e.cardId || toSender.some(sameThread))) return true;\n', '']], /GOD: MCCEY'S RESULTS/],
    ['replay: b off', [['  if (e.humanRelay === true) return true;\n', '']], /SPECK: THE RAYB-4 FACT, THE HUMAN CORRECTION AND THE BROADCASTS WAKE/]
  ]) {
    await t.test(`mutant: ${name}`, () => {
      const mod = loadTs.fromText(CLASS, mutateText(CLASS, edits, name));
      const cleanups = [];
      try {
        assert.throws(() => K.metaReplay(mod)({ after: (fn) => cleanups.push(fn) }), (e) => {
          assert.match(String(e && e.message), dies, `${name}: died for the wrong reason: ${e && e.message}`);
          return true;
        });
      } finally { for (const fn of cleanups.reverse()) fn(); }
    });
  }
});
