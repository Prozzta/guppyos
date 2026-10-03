'use strict';

/**
 * READS-QUIET-NOREPLY (1.1.81, god 271ed2 / c95516): quiet mail does not start a turn.
 *
 * An idle agent's inform/agree that needs no reply, from an agent (not the Human, the breaker,
 * the floor digest or the harness), waits for its next real turn, or for 30 min from delivery
 * at most, when ONE wake carries every held id. For an `inject` agent the hooks surface every
 * delivered id anyway, so holding = keeping the id out of the wake coordinator's pending set.
 * Plus the stale-flag fields: a card with waitingFor:"install" + fixVersion is never STALE while
 * the running app is older, and is flagged SHIPPED_INSTALLED once it reaches that version.
 *
 * Each guarantee is a K.* check that takes the module(s) under test, so the MUTANT CENSUS at the
 * end can run the same check against a mutated copy and require it to die for the right reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const CLASS = 'src/shared/mailWakeClass.ts';
const WW = 'src/main/workerWake.ts';
const BRIDGE = 'src/main/inboxWakeBridge.ts';
const STALE = 'src/shared/boardStale.ts';
const DIGEST = 'src/main/floorDigest.ts';

const real = {
  cls: loadTs(CLASS),
  ww: loadTs(WW),
  bridge: loadTs(BRIDGE),
  stale: loadTs(STALE),
  digest: loadTs(DIGEST)
};
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const NOW = 50_000_000;
const MIN = 60_000;
const HOLD = 30 * MIN;
const K = {};

/** A ledger entry as the classifier reads it. */
const entry = (id, over = {}) => ({ id, from: 'jim-mtujpe28', act: 'inform', requiresReply: false, deliveredAt: NOW, ...over });

// ─── 1. the classifier ─────────────────────────────────────────────────────────────────────

K.quietCases = (cls = real.cls) => {
  for (const act of ['inform', 'agree']) {
    assert.equal(cls.mailWakeClass(entry('q', { act }), 'inject'), 'quiet', `AN AGENT'S ${act.toUpperCase()} WITH NO REPLY IS QUIET`);
  }
};
test('quiet: an agent\'s inform or agree that needs no reply, to an inject agent', () => K.quietCases());

K.actsThatWake = (cls = real.cls) => {
  for (const act of ['done', 'request', 'query', 'propose', 'refuse', undefined, 'whatever']) {
    assert.equal(cls.mailWakeClass(entry('w', { act }), 'inject'), 'wake', `ACT ${act} ALWAYS WAKES`);
  }
};
test('wakes: done (results), request, query, propose, refuse and any unknown act', () => K.actsThatWake());

K.replyWakes = (cls = real.cls) => {
  assert.equal(cls.mailWakeClass(entry('w', { requiresReply: true }), 'inject'), 'wake', 'A REQUIRED REPLY ALWAYS WAKES');
  assert.equal(cls.mailWakeClass(entry('w', { act: 'agree', requiresReply: true }), 'inject'), 'wake', 'A REQUIRED REPLY ALWAYS WAKES');
};
test('wakes: anything with requires_reply, whatever its act', () => K.replyWakes());

K.sendersThatWake = (cls = real.cls) => {
  for (const from of ['human', 'digest', 'breaker', 'webhook', 'system', 'heartbeat', 'scheduler']) {
    assert.equal(cls.mailWakeClass(entry('w', { from }), 'inject'), 'wake', `MAIL FROM ${from.toUpperCase()} ALWAYS WAKES`);
  }
};
test('wakes: the Human (answers), the digest (Floor decisions), the breaker, webhooks and every harness sender', () => K.sendersThatWake());

K.wakeNowWakes = (cls = real.cls) => {
  assert.equal(cls.mailWakeClass(entry('w', { wakeNow: true }), 'inject'), 'wake', 'WAKE:NOW ALWAYS WAKES');
  assert.equal(cls.mailWakeClass(entry('q', { wakeNow: false }), 'inject'), 'quiet');
};
test('wakes: a sender\'s "wake": "now"', () => K.wakeNowWakes());

K.onlyInjectHolds = (cls = real.cls) => {
  for (const mode of ['legacy-read', 'legacy-move', 'work-order', '', 'unknown']) {
    assert.equal(cls.mailWakeClass(entry('q'), mode), 'wake', `A ${mode || 'blank'} AGENT READS MAIL BECAUSE OF THE WAKE: NEVER HELD`);
  }
};
test('only an inject agent (Claude, Codex, AGY) is ever held: the others read mail because of the wake prompt', () => K.onlyInjectHolds());

// Jim B1: the answer an idle agent is waiting for. `ledgers` = holder -> id -> the original.
function lookupIn(ledgers) {
  return (holder, id) => ledgers[holder]?.[id];
}
K.answerToOwnAskWakes = (cls = real.cls) => {
  const ledgers = { god: {
    'jim-design': { from: 'jim-mtujpe28', act: 'propose', requiresReply: true },
    'jim-req': { from: 'jim-mtujpe28', act: 'request', requiresReply: true },
    'jim-fyi': { from: 'jim-mtujpe28', act: 'inform', requiresReply: false },
    'creed-req': { from: 'creed-mukyiphw', act: 'request', requiresReply: true }
  } };
  const isAnswer = (e) => cls.answersOwnAsk(e, 'jim-mtujpe28', lookupIn(ledgers));
  const fromGod = (act, inReplyTo) => entry('a', { from: 'god', act, inReplyTo });
  assert.equal(cls.mailWakeClass(fromGod('agree', 'jim-design'), 'inject', isAnswer), 'wake', 'AN AGREE TO MY OWN ASK WAKES ME');
  assert.equal(cls.mailWakeClass(fromGod('inform', 'jim-req'), 'inject', isAnswer), 'wake', 'AN INFORM ANSWERING MY OWN REQUEST WAKES ME');
  assert.equal(cls.mailWakeClass(fromGod('inform', 'jim-fyi'), 'inject', isAnswer), 'quiet', 'A REPLY TO MY OWN FYI STAYS QUIET');
  assert.equal(cls.mailWakeClass(fromGod('inform', 'creed-req'), 'inject', isAnswer), 'quiet', 'A REPLY ON SOMEONE ELSE\'S ASK STAYS QUIET');
  assert.equal(cls.mailWakeClass(fromGod('inform', 'unknown-id'), 'inject', isAnswer), 'quiet', 'AN UNKNOWN ORIGINAL STAYS QUIET');
  assert.equal(cls.mailWakeClass(fromGod('inform', null), 'inject', isAnswer), 'quiet', 'NO IN_REPLY_TO STAYS QUIET');
  // a request sent with requires_reply false (a webhook-style ask) is still an ask
  ledgers.god['jim-req-norr'] = { from: 'jim-mtujpe28', act: 'request', requiresReply: false };
  assert.equal(cls.mailWakeClass(fromGod('inform', 'jim-req-norr'), 'inject', isAnswer), 'wake', 'AN INFORM ANSWERING MY OWN REQUEST WAKES ME');
  // the holds agree with the class, and a throwing lookup fails open (wakes)
  const holds = cls.quietHolds([fromGod('agree', 'jim-design'), entry('q')], 'inject', HOLD, NOW, isAnswer);
  assert.deepEqual([...holds.keys()], ['q'], 'AN AGREE TO MY OWN ASK WAKES ME');
  assert.equal(cls.mailWakeClass(entry('q'), 'inject', () => { throw new Error('ledger'); }), 'wake', 'A FAILING ANSWER LOOKUP WAKES');
};
test('Jim B1: an agree or inform answering the recipient\'s OWN ask wakes it; FYI replies and other threads stay quiet', () => K.answerToOwnAskWakes());

test('Jim B1 wiring: main looks the original up in the answering agent\'s ledger (id or sender_id)', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /const lookup = \(holder: string, id: string\) => \{\n        const es = hive\.mail\.ledger\(holder\)\.entries;\n        return es\[id\] \?\? Object\.values\(es\)\.find\(\(x\) => x\.senderId === id\);\n      \};/);
  assert.match(index, /\(e\) => answersOwnAsk\(e, agentId, lookup\)\);/);
});

test('Jim B1 behaviour on real ledgers: jim proposes to god, god agrees: the agree wakes jim', (t) => {
  const L = loadTs('src/main/mailLedger.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reads-quiet-b1-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  for (const a of ['god', 'jim-1']) fs.mkdirSync(path.join(root, 'agents', a, 'inbox', '.done'), { recursive: true });
  const ml = new L.MailLedger({ root: () => root, appendLog: () => {}, readLogRows: () => [], clock: () => NOW, setTimer: () => ({}), clearTimer: () => {} });
  ml.markDelivered('god', { id: 'design-1', from: 'jim-1', act: 'propose', requires_reply: true, subject: 'design', body: 'b' });
  ml.markDelivered('jim-1', { id: 'ok-1', from: 'god', act: 'agree', in_reply_to: 'design-1', subject: 'approved', body: 'b' });
  ml.markDelivered('jim-1', { id: 'qt-1', from: 'creed-1', act: 'inform', subject: 'QUIET TIME', body: 'b' });
  const lookup = (holder, id) => { const es = ml.ledger(holder).entries; return es[id] ?? Object.values(es).find((x) => x.senderId === id); };
  const es = Object.values(ml.ledger('jim-1').entries);
  const holds = real.cls.quietHolds(es, 'inject', HOLD, NOW, (e) => real.cls.answersOwnAsk(e, 'jim-1', lookup));
  assert.deepEqual([...holds.keys()], ['qt-1'], 'the approval wakes; the quiet-time broadcast waits');
  ml.dispose();
});

// Jim B2: a census of every harness sender. Each sender a send site passes is either one that
// always wakes, or an agent identity on purpose (its mail follows the ordinary rules).
const DELIBERATELY_ORDINARY = new Map([
  ['god', 'index.ts worker dispatch: a request from god, as god'],
  ['human', 'renderer AskMe / Threads / Command Center: the Human (also in the set)']
]);
const PASS_THROUGH = [
  // [file, the sender expression]: forwards a sender chosen elsewhere (each is covered where it
  // is chosen: the closing-time / floor-digest hosts, the renderer's hive:send IPC, the voice deps)
  ['src/main/index.ts', 'from'],
  ['src/main/index.ts', "typeof from === 'string' ? from : 'system'"],
  // rc/1.1.81 merge note (Andy, HEAVY-LOCK delta): the HEAVY SLOT FREE notice is sent as
  // hive.send(n.message, n.from), where n is heavySlotFreeNotice's (from 'system', wake 'now'),
  // which heavy-lock-queue-181 pins as WAKE against this classifier.
  ['src/main/index.ts', 'n.from']
];
function sendSites() {
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (/\.tsx?$/.test(n.name)) files.push(p); } };
  walk(path.join(__dirname, '..', 'src'));
  const out = [];
  const consts = {};
  for (const f of files) {
    const text = readSource(f);
    for (const m of text.matchAll(/export const ([A-Z_]+) = '([a-z-]+)';/g)) consts[m[1]] = m[2];
  }
  for (const f of files) {
    const rel = path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');
    const text = readSource(f);
    for (const m of text.matchAll(/\b(?:hive|host|deps|cth)\.(?:send|hiveSend)\(/g)) {
      // the call's top-level arguments (bracket counting; strings and templates skipped)
      let i = m.index + m[0].length; let depth = 0; const args = ['']; let q = null;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (q) { args[args.length - 1] += ch; if (ch === '\\') { args[args.length - 1] += text[++i]; continue; } if (ch === q) q = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { q = ch; args[args.length - 1] += ch; continue; }
        if ('({['.includes(ch)) depth++;
        if (')}]'.includes(ch)) { if (depth === 0) break; depth--; }
        if (ch === ',' && depth === 0) { args.push(''); continue; }
        args[args.length - 1] += ch;
      }
      const call = text.slice(m.index, i + 1);
      const raw = (args[1] ?? '').trim();
      out.push({ rel, call, raw, sender: raw === '' ? 'system' : /^'([^']+)'$/.test(raw) ? raw.slice(1, -1) : consts[raw] ?? null });
    }
  }
  return out;
}
test('Jim B2: SENDER CENSUS: every hive.send sender always wakes, is an ordinary agent identity on purpose, or forwards one', () => {
  const sites = sendSites();
  assert.ok(sites.length >= 15, `found the send sites (${sites.length})`);
  const seen = new Set();
  for (const s of sites) {
    if (s.sender === null) {
      assert.ok(PASS_THROUGH.some(([f, c]) => f === s.rel && s.raw === c),
        `${s.rel}: a sender the census cannot resolve (${s.raw}): add it to the set, or to PASS_THROUGH if it forwards one`);
      continue;
    }
    seen.add(s.sender);
    assert.ok(real.cls.ALWAYS_WAKE_SENDERS.has(s.sender) || DELIBERATELY_ORDINARY.has(s.sender),
      `${s.rel}: sender "${s.sender}" would have its inform held: add it to ALWAYS_WAKE_SENDERS or DELIBERATELY_ORDINARY with a reason`);
  }
  for (const s of ['michael-voice', 'ephemeral-worker', 'digest', 'scheduler', 'webhook', 'human', 'system']) assert.ok(seen.has(s), `the census saw ${s}`);
});

K.b2Senders = (cls = real.cls) => {
  for (const from of ['michael-voice', 'ephemeral-worker']) {
    assert.equal(cls.mailWakeClass(entry('w', { from }), 'inject'), 'wake', `MAIL FROM ${from.toUpperCase()} ALWAYS WAKES`);
  }
};
test('Jim B2: the Human\'s voice ping (michael-voice) and a worker\'s terminal failure (ephemeral-worker) wake', () => K.b2Senders());

test('Jim\'s HEAVY SLOT FREE notice (from system, inform, no reply, wake:now) wakes', () => {
  assert.equal(real.cls.mailWakeClass(entry('slot', { from: 'system', wakeNow: true }), 'inject'), 'wake');
  assert.equal(real.cls.mailWakeClass(entry('slot', { from: 'system' }), 'inject'), 'wake');
});

K.holdMsConfig = (cls = real.cls) => {
  assert.equal(cls.quietMailHoldMs(undefined), HOLD, 'UNSET = 30 MIN');
  assert.equal(cls.quietMailHoldMs(0), 0, 'ZERO TURNS IT OFF');
  assert.equal(cls.quietMailHoldMs(10), 10 * MIN);
  assert.equal(cls.quietMailHoldMs(-5), HOLD, 'A NEGATIVE VALUE IS THE DEFAULT');
  assert.equal(cls.quietMailHoldMs('30'), HOLD);
  assert.equal(cls.quietMailHoldMs(NaN), HOLD);
};
test('config quietMailHoldMin: unset = 30, 0 = off, junk = the default', () => K.holdMsConfig());

K.holdsFromDelivery = (cls = real.cls) => {
  const es = [entry('a', { deliveredAt: NOW - 10 * MIN }), entry('b', { act: 'request', requiresReply: true }), entry('c', { deliveredAt: NOW - HOLD })];
  const h = cls.quietHolds(es, 'inject', HOLD, NOW);
  assert.deepEqual([...h.entries()], [['a', NOW - 10 * MIN + HOLD]], 'THE HOLD ENDS 30 MIN AFTER DELIVERY');
  assert.equal(h.has('c'), false, 'A HOLD THAT HAS ENDED HOLDS NOTHING');
  assert.equal(cls.quietHolds(es, 'inject', 0, NOW).size, 0, 'OFF HOLDS NOTHING');
};
test('quietHolds: each quiet id until deliveredAt + hold (a restart never extends it); past it, or off, nothing', () => K.holdsFromDelivery());

test('normalizeWakeField keeps only the exact string "now"', () => {
  assert.deepEqual(real.cls.normalizeWakeField('now'), { wake: 'now' });
  for (const v of ['NOW', 'always', true, 1, null, undefined, ['now']]) assert.deepEqual(real.cls.normalizeWakeField(v), {});
});

// ─── 2. the field travels: sender -> router -> ledger ──────────────────────────────────────

test('the router keeps "wake" through normalize, and the ledger records it as wakeNow', () => {
  const hive = readSource('src/main/hive.ts');
  const norm = hive.slice(hive.indexOf('  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {'));
  assert.match(norm.slice(0, 1500), /\.\.\.normalizeSupersedes\(partial\.supersedes\),\n      \.\.\.normalizeWakeField\(partial\.wake\)\n    \};/);
  const ledger = readSource('src/main/mailLedger.ts');
  assert.match(ledger, /\.\.\.\(msg\.wake === 'now' \? \{ wakeNow: true \} : \{\}\),/, 'entryFromMessage');
  assert.match(ledger, /sender_id: typeof m\.sender_id === 'string' \? m\.sender_id : undefined,\n    wake: m\.wake\n  \};/, 'a ledger rebuilt from disk keeps it');
});

test('behaviour: a delivered message with wake:"now" is a wakeNow ledger entry; without it, none', (t) => {
  const L = loadTs('src/main/mailLedger.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-reads-quiet-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  fs.mkdirSync(path.join(root, 'agents', 'jim-1', 'inbox', '.done'), { recursive: true });
  const ml = new L.MailLedger({ root: () => root, appendLog: () => {}, readLogRows: () => [], clock: () => NOW,
    setTimer: () => ({}), clearTimer: () => {} });
  ml.markDelivered('jim-1', { id: 'u1', from: 'system', act: 'inform', subject: 'HEAVY SLOT FREE', body: 'b', wake: 'now' });
  ml.markDelivered('jim-1', { id: 'q1', from: 'creed-1', act: 'inform', subject: 'QUIET TIME', body: 'b' });
  const es = ml.ledger('jim-1').entries;
  assert.equal(es.u1.wakeNow, true);
  assert.equal(es.q1.wakeNow, undefined);
  assert.equal(real.cls.mailWakeClass(es.u1, 'inject'), 'wake');
  assert.equal(real.cls.mailWakeClass(es.q1, 'inject'), 'quiet');
  ml.dispose();
});

// ─── 3. the coordinator: hold, carry, release ──────────────────────────────────────────────

const fact = (over = {}) => ({ agentId: 'alice', ptyId: 'pty-alice', lastOutputAt: NOW - 1_000,
  autoDeliveryPaused: false, paused: false, halted: false, ...over });
function idleWith(ww, ids) {
  const c = new ww.WorkerWakeWatchdog();
  c.noteHook('alice', 'Stop', '', NOW);
  for (const id of ids) c.noteDelivery('alice', id);
  return c;
}

K.quietAloneNeverClaims = (ww = real.ww) => {
  const c = idleWith(ww, ['q1']);
  assert.deepEqual(c.hold('alice', new Map([['q1', NOW + HOLD]]), NOW), ['q1']);
  assert.deepEqual(c.state('alice').pending, []);
  assert.equal(c.claim(fact(), 'delivery', 'event', NOW), null, 'HELD QUIET MAIL ALONE STARTS NO TURN');
  assert.equal(c.whyNoClaim('alice'), 'quiet-held');
  assert.equal(c.claim(fact(), 'reconcile', 'reconcile', NOW + HOLD - 1), null, 'HELD QUIET MAIL ALONE STARTS NO TURN');
  c.reconcile('alice', ['q1']);
  assert.deepEqual(c.state('alice').pending, [], 'RECONCILE NEVER RE-PENDS A HELD ID');
};
test('quiet mail alone never claims (event or reconcile), and reconcile does not re-pend it', () => K.quietAloneNeverClaims());

K.realMailCarriesHeld = (ww = real.ww) => {
  const c = idleWith(ww, ['q1']);
  c.hold('alice', new Map([['q1', NOW + HOLD]]), NOW);
  c.noteDelivery('alice', 'r1');
  const claim = c.claim(fact(), 'delivery', 'event', NOW + MIN);
  assert.ok(claim, 'a request wakes');
  assert.deepEqual([...claim.ids], ['q1', 'r1'], 'A REAL WAKE CARRIES EVERY HELD ID');
  assert.deepEqual({ ids: [...claim.quietReleased.ids], reason: claim.quietReleased.reason }, { ids: ['q1'], reason: 'with-mail' });
  assert.equal(c.quietHeld('alice').size, 0);
};
test('a wake for other mail carries every held quiet id (one turn), marked with-mail', () => K.realMailCarriesHeld());

K.boundReleasesBatch = (ww = real.ww) => {
  const c = idleWith(ww, ['q1']);
  c.hold('alice', new Map([['q1', NOW + HOLD]]), NOW);
  c.noteDelivery('alice', 'q2');
  c.hold('alice', new Map([['q2', NOW + 20 * MIN + HOLD]]), NOW + 20 * MIN);
  assert.equal(c.claim(fact(), 'reconcile', 'reconcile', NOW + HOLD - 1), null, 'BEFORE THE OLDEST HOLD ENDS, NOTHING');
  const claim = c.claim(fact(), 'reconcile', 'reconcile', NOW + HOLD);
  assert.ok(claim, 'THE OLDEST HOLD ENDING RELEASES THE BATCH');
  assert.deepEqual([...claim.ids], ['q1', 'q2'], 'ALL HELD IDS GO IN ONE WAKE');
  assert.equal(claim.quietReleased.reason, 'max-delay');
};
test('when the OLDEST hold ends, every held id goes in ONE wake (max-delay)', () => K.boundReleasesBatch());

K.seenIsDropped = (ww = real.ww) => {
  const c = idleWith(ww, ['q1']);
  c.hold('alice', new Map([['q1', NOW + HOLD]]), NOW);
  c.reconcile('alice', []);   // a human-typed turn's hook surfaced it: no longer delivered
  assert.equal(c.quietHeld('alice').size, 0, 'A HELD ID THE AGENT HAS SEEN IS DROPPED');
  assert.equal(c.claim(fact(), 'reconcile', 'reconcile', NOW + HOLD + 1), null, 'AND NEVER WAKES LATER');
  assert.equal(c.whyNoClaim('alice'), 'no-pending-ids');
};
test('a held id a real turn surfaced (no longer delivered) is dropped: no late wake', () => K.seenIsDropped());

K.holdOnlyPending = (ww = real.ww) => {
  const c = idleWith(ww, ['r1']);
  const claim = c.claim(fact(), 'delivery', 'event', NOW);
  assert.deepEqual(c.hold('alice', new Map([['r1', NOW + HOLD]]), NOW), [], 'AN IN-FLIGHT ID IS NOT HELD');
  assert.deepEqual([...c.state('alice').inFlight.ids], [...claim.ids]);
  const d = idleWith(ww, ['q1']);
  assert.deepEqual(d.hold('alice', new Map([['q1', NOW]]), NOW), [], 'AN ENDED HOLD HOLDS NOTHING');
  assert.deepEqual(d.state('alice').pending, ['q1']);
};
test('hold() moves only pending ids, and only while their hold runs', () => K.holdOnlyPending());

test('guards still apply to a released batch (a paused agent is not woken at the bound)', () => {
  const c = idleWith(real.ww, ['q1']);
  c.hold('alice', new Map([['q1', NOW + HOLD]]), NOW);
  assert.equal(c.claim(fact({ paused: true }), 'reconcile', 'reconcile', NOW + HOLD), null);
  assert.equal(c.whyNoClaim('alice'), 'paused');
  assert.deepEqual([...c.quietHeld('alice').keys()], ['q1'], 'still held, released by the first claim that passes');
});

// ─── 4. the bridge end to end ──────────────────────────────────────────────────────────────

function rig(mods = real, { quietThrows = false, holdMs = HOLD } = {}) {
  const coordinator = new mods.ww.WorkerWakeWatchdog();
  const now = { t: NOW };
  const ledger = new Map();   // id -> entry, delivered
  const submits = [];
  const diag = [];
  const immediates = [];
  const bridge = new mods.bridge.InboxWakeBridge({
    coordinator,
    inboxIds: () => [...ledger.keys()],
    facts: () => ({ ptyId: 'pty-alice', lastOutputAt: now.t - 60_000, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false }),
    submit: (req) => { submits.push(req); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => inboxNudgeText([...ids]),
    setImmediate: (fn) => { immediates.push(fn); },
    now: () => now.t,
    diag: (stage, fields) => { diag.push({ stage, ...fields }); },
    mail: {
      mode: () => 'inject', closeTurn: () => {}, abortSince: () => {}, closeStale: () => [], hasOpenEpoch: () => false,
      degrade: () => false,
      quietUntil: (agentId, ids, at) => {
        if (quietThrows) throw new Error('ledger unreadable');
        return real.cls.quietHolds(ids.map((id) => ledger.get(id)).filter(Boolean), 'inject', holdMs, at);
      }
    }
  });
  coordinator.noteHook('alice', 'Stop', '', NOW);
  const flush = () => { while (immediates.length) immediates.shift()(); };
  const deliver = (id, over = {}) => { ledger.set(id, entry(id, { deliveredAt: now.t, ...over })); bridge.onDelivery('alice', id); flush(); };
  return { coordinator, bridge, now, ledger, submits, diag, deliver, flush };
}

K.bridgeHoldsAndReleases = (mods = real) => {
  const r = rig(mods);
  r.deliver('q1');
  assert.equal(r.submits.length, 0, 'A QUIET DELIVERY TYPES NOTHING');
  const held = r.diag.find((d) => d.stage === 'held');
  assert.ok(held, 'a held row');
  assert.deepEqual(held.idList, ['q1']);
  assert.equal(held.until, NOW + HOLD);
  r.now.t = NOW + HOLD - 1;
  r.bridge.reconcileAll(['alice']);
  assert.equal(r.submits.length, 0, 'NOT BEFORE THE BOUND');
  r.now.t = NOW + HOLD;
  r.bridge.reconcileAll(['alice']);
  assert.equal(r.submits.length, 1, 'THE BEAT RELEASES IT AT THE BOUND: ONE WAKE');
  assert.match(r.submits[0].text, /q1/);
  const rel = r.diag.find((d) => d.stage === 'hold-released');
  assert.deepEqual({ reason: rel.reason, idList: rel.idList }, { reason: 'max-delay', idList: ['q1'] });
};
test('bridge: a quiet delivery is held (a "held" row), and the 15 s beat releases it at 30 min as one wake', () => K.bridgeHoldsAndReleases());

test('bridge: a request still wakes at once, and carries the held quiet mail with it', () => {
  const r = rig();
  r.deliver('q1');
  r.now.t += 5 * MIN;
  r.coordinator.noteHook('alice', 'Stop', '', r.now.t);
  r.deliver('r1', { act: 'request', requiresReply: true, from: 'god' });
  assert.equal(r.submits.length, 1);
  assert.match(r.submits[0].text, /q1/);
  assert.match(r.submits[0].text, /r1/);
  assert.equal(r.diag.find((d) => d.stage === 'hold-released').reason, 'with-mail');
});

K.bridgeFailsOpen = (mods = real) => {
  const r = rig(mods, { quietThrows: true });
  r.deliver('q1');
  assert.equal(r.submits.length, 1, 'NO LEDGER ANSWER = NO HOLD: IT WAKES');
};
test('bridge: a throwing quietUntil holds nothing (fail open: it wakes, as before 1.1.81)', () => K.bridgeFailsOpen());

test('bridge: hold 0 (config off) = every delivery wakes, as before 1.1.81', () => {
  const r = rig(real, { holdMs: 0 });
  r.deliver('q1');
  assert.equal(r.submits.length, 1);
  assert.equal(r.diag.some((d) => d.stage === 'held'), false);
});

test('bridge: Human and breaker mail wake an idle agent at once', () => {
  for (const from of ['human', 'breaker', 'digest']) {
    const r = rig();
    r.deliver('m1', { from });
    assert.equal(r.submits.length, 1, from);
  }
});

// ─── 5. main wiring and the stall watch ────────────────────────────────────────────────────

test('main: quietUntil reads the ledger, the mail mode and the config (cached), through quietHolds', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /quietUntil: \(agentId, ids, now\) => \{\n      const holdMs = quietHoldMsCached\(now\);\n      if \(!\(holdMs > 0\)\) return new Map\(\);\n      const entries = hive\.mail\.ledger\(agentId\)\.entries;\n/);
  assert.match(index, /return quietHolds\(ids\.map\(\(id\) => entries\[id\]\)\.filter\(\(e\) => !!e\), hookServer\.mailChannel\(agentId\)\.mode, holdMs, now,\n        \(e\) => answersOwnAsk\(e, agentId, lookup\)\);\n    \}/);
  assert.match(index, /quietHoldMemo = \{ ms: quietMailHoldMs\(min\), at: now \};/);
  assert.match(index, /min = readConfig\(\)\.quietMailHoldMin;/);
});

test('the stall watch treats quiet-held as deliberate (a bounded hold is not a deadlock)', () => {
  const { WakeStallWatch } = loadTs('src/main/wakeStall.ts');
  const w = new WakeStallWatch();
  assert.equal(w.note('alice', 'quiet-held', 2, NOW), null);
  assert.equal(w.note('alice', 'quiet-held', 2, NOW + 60 * MIN), null, 'never a stall');
});

// ─── 6. stale flags: waitingFor:"install" + fixVersion ─────────────────────────────────────

const H = 3_600_000;
const SNOW = 100 * H;
const doing = (id, extra = {}) => ({ id, title: id, status: 'doing', assignee: 'andy', ...extra });
function staleRun(stale, tasks, runningVersion) {
  const meta = {};
  for (const c of tasks) meta[c.id] = { statusSince: 0, lastEditAt: 0 };
  return stale.detectStale({ tasks, meta, registry: new Map([['andy', { archived: false }]]),
    liveness: new Map([['andy', { agentId: 'andy', incarnation: 'andy-1', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: 0, reason: 'none', evidence: { sampledAt: SNOW } }]]),
    fleet: new Map(), now: SNOW, runningVersion });
}
const kinds = (flags) => flags.map((f) => `${f.cardId}:${f.kind}`);

K.waitingIsNotStale = (stale = real.stale) => {
  const wait = { waitingFor: 'install', fixVersion: '1.1.81' };
  assert.deepEqual(kinds(staleRun(stale, [doing('C', wait), doing('D')], '1.1.80')), ['D:STALE'], 'A CARD WAITING FOR ITS INSTALL IS NEVER STALE');
  assert.deepEqual(kinds(staleRun(stale, [doing('C', wait)], null)), [], 'A CARD WAITING FOR ITS INSTALL IS NEVER STALE');
};
test('a doing card with waitingFor:"install" is not STALE while the running app is older (or unknown)', () => K.waitingIsNotStale());

K.waitingIsNotLoad = (stale = real.stale) => {
  const wait = { waitingFor: 'install', fixVersion: '1.1.81' };
  const tasks = [doing('A'), doing('B'), doing('C'), doing('W1', wait), doing('W2', wait)];
  const many = staleRun(stale, tasks, '1.1.80').filter((f) => f.kind === 'DOING_MANY');
  assert.deepEqual(many, [], 'A CARD WAITING FOR ITS INSTALL IS NOT LOAD');
  assert.equal(staleRun(stale, [...tasks, doing('D')], '1.1.80').filter((f) => f.kind === 'DOING_MANY').length, 4, 'four real doing cards still are');
};
test('waiting cards do not count toward DOING_MANY (the Human: the board said Creed was busy when he was free)', () => K.waitingIsNotLoad());

K.installedFlagsOnce = (stale = real.stale, digest = real.digest) => {
  const wait = { waitingFor: 'install', fixVersion: '1.1.81' };
  for (const running of ['1.1.81', '1.1.82', '1.2.0']) {
    const flags = staleRun(stale, [doing('C', wait)], running);
    assert.deepEqual(kinds(flags), ['C:SHIPPED_INSTALLED'], `INSTALLED (RUNNING ${running}) IS SHIPPED_INSTALLED, NOT STALE`);
    assert.equal(flags[0].decision, true);
    assert.equal(flags[0].fixVersion, '1.1.81');
  }
  const flags = staleRun(stale, [doing('C', wait)], '1.1.81');
  const a = digest.decisionItems(flags, [], SNOW);
  const b = digest.decisionItems(flags, [], SNOW + 48 * H);
  assert.equal(a[0].id, 'shipped_installed:C:1.1.81', 'ONCE PER FIX VERSION');
  assert.equal(b[0].id, a[0].id, 'ONCE PER FIX VERSION (no daily re-arm)');
  assert.match(a[0].line, /installed: verify the fix and close the card\?/);
};
test('once the running app reaches fixVersion: SHIPPED_INSTALLED, one digest decision per fix version', () => K.installedFlagsOnce());

test('a blocked card waiting for its install is flagged SHIPPED_INSTALLED too', () => {
  const flags = staleRun(real.stale, [{ id: 'B', status: 'blocked', assignee: 'andy', waitingFor: 'install', fixVersion: 'v1.1.80' }], '1.1.80');
  assert.deepEqual(kinds(flags), ['B:SHIPPED_INSTALLED']);
});

test('installWait: both fields, x.y.z only; anything else is an ordinary card', () => {
  const w = real.stale.installWait;
  assert.equal(w({ waitingFor: 'install', fixVersion: '1.1.81' }, '1.1.80'), 'waiting');
  assert.equal(w({ waitingFor: 'install', fixVersion: '1.1.81' }, '1.1.81'), 'installed');
  assert.equal(w({ waitingFor: 'install', fixVersion: '1.1.81' }, '1.10.0'), 'installed', 'numeric, not string, compare');
  assert.equal(w({ waitingFor: 'install', fixVersion: '1.1.81' }, 'dev'), 'waiting');
  assert.equal(w({ waitingFor: 'install' }, '9.9.9'), null);
  assert.equal(w({ waitingFor: 'install', fixVersion: 'soon' }, '9.9.9'), null);
  assert.equal(w({ waitingFor: 'review', fixVersion: '1.1.81' }, '9.9.9'), null);
  assert.deepEqual(kinds(staleRun(real.stale, [doing('C', { waitingFor: 'install', fixVersion: 'soon' })], '1.1.80')), ['C:STALE'], 'a malformed card is ordinary');
});

test('the monitor passes the running version, and main gives it this build\'s version', () => {
  assert.match(readSource('src/main/boardMonitor.ts'), /cfg: this\.opts\.cfg\?\.\(\), runningVersion: this\.opts\.runningVersion\?\.\(\) \?\? null \}\);/);
  assert.match(readSource('src/main/index.ts'), /runningVersion: \(\) => app\.getVersion\(\),/);
});

test('the protocol texts document it (PROTOCOL.md for senders, god\'s start-up for the card fields)', () => {
  const hive = readSource('src/main/hive.ts');
  assert.match(hive, /"wake": "now" \(optional: an inform or agree that must be read at once\)/);
  assert.match(hive, /does not wake an idle recipient: it reaches the\n  recipient with its next turn, or within 30 minutes at most\./);
  assert.match(hive, /set "waitingFor": "install" and "fixVersion": "<x\.y\.z>"/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

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
  { name: 'done is quiet too (the card\'s candidate list)', file: CLASS, kind: 'cls',
    edits: [["new Set(['inform', 'agree'])", "new Set(['inform', 'agree', 'done'])"]], killer: 'actsThatWake', dies: /ACT done ALWAYS WAKES/ },
  { name: 'agree always wakes', file: CLASS, kind: 'cls',
    edits: [["new Set(['inform', 'agree'])", "new Set(['inform'])"]], killer: 'quietCases', dies: /AGREE WITH NO REPLY IS QUIET/ },
  { name: 'requires_reply ignored', file: CLASS, kind: 'cls',
    edits: [["  if (e.requiresReply) return 'wake';\n", '']], killer: 'replyWakes', dies: /A REQUIRED REPLY ALWAYS WAKES/ },
  { name: 'the Human is not special', file: CLASS, kind: 'cls',
    edits: [["  'human', 'digest',", "  'digest',"]], killer: 'sendersThatWake', dies: /MAIL FROM HUMAN ALWAYS WAKES/ },
  { name: 'the breaker is not special', file: CLASS, kind: 'cls',
    edits: [["'digest', 'breaker', 'webhook'", "'digest', 'webhook'"]], killer: 'sendersThatWake', dies: /MAIL FROM BREAKER ALWAYS WAKES/ },
  { name: 'Floor decisions (digest) are quiet', file: CLASS, kind: 'cls',
    edits: [["  'human', 'digest',", "  'human',"]], killer: 'sendersThatWake', dies: /MAIL FROM DIGEST ALWAYS WAKES/ },
  { name: 'B1: answers to the recipient\'s own ask are held', file: CLASS, kind: 'cls',
    edits: [['    if (answer) return \'wake\';\n', '']], killer: 'answerToOwnAskWakes', dies: /AN AGREE TO MY OWN ASK WAKES ME/ },
  { name: 'B1: any reply wakes (the original\'s sender ignored)', file: CLASS, kind: 'cls',
    edits: [['  return !!orig && orig.from === recipientId && (', '  return !!orig && (']], killer: 'answerToOwnAskWakes', dies: /SOMEONE ELSE'S ASK STAYS QUIET/ },
  { name: 'B1: only requires_reply counts, not the asking act', file: CLASS, kind: 'cls',
    edits: [['(orig.requiresReply || ASKING_ACTS.has(String(orig.act ?? \'\')))', '(orig.requiresReply)']], killer: 'answerToOwnAskWakes', dies: /ANSWERING MY OWN REQUEST WAKES ME/ },
  { name: 'B1: a failing lookup holds', file: CLASS, kind: 'cls',
    edits: [['    try { answer = isAnswer(e); } catch { answer = true; }', '    try { answer = isAnswer(e); } catch { answer = false; }']], killer: 'answerToOwnAskWakes', dies: /A FAILING ANSWER LOOKUP WAKES/ },
  { name: 'B2: the Human\'s voice ping is held', file: CLASS, kind: 'cls',
    edits: [["  'michael-voice', 'ephemeral-worker'", "  'ephemeral-worker'"]], killer: 'b2Senders', dies: /MAIL FROM MICHAEL-VOICE ALWAYS WAKES/ },
  { name: 'B2: a worker\'s terminal failure is held', file: CLASS, kind: 'cls',
    edits: [["  'michael-voice', 'ephemeral-worker'", "  'michael-voice'"]], killer: 'b2Senders', dies: /MAIL FROM EPHEMERAL-WORKER ALWAYS WAKES/ },
  { name: 'wake:now ignored', file: CLASS, kind: 'cls',
    edits: [["  if (e.wakeNow === true) return 'wake';\n", '']], killer: 'wakeNowWakes', dies: /WAKE:NOW ALWAYS WAKES/ },
  { name: 'legacy agents held too', file: CLASS, kind: 'cls',
    edits: [["  if (mailMode !== 'inject') return 'wake';\n", '']], killer: 'onlyInjectHolds', dies: /READS MAIL BECAUSE OF THE WAKE: NEVER HELD/ },
  { name: 'config 0 does not turn it off', file: CLASS, kind: 'cls',
    edits: [['configMin >= 0 ?', 'configMin > 0 ?']], killer: 'holdMsConfig', dies: /ZERO TURNS IT OFF/ },
  { name: 'the hold runs from now, not from delivery (a restart extends it)', file: CLASS, kind: 'cls',
    edits: [['    const until = e.deliveredAt + holdMs;', '    const until = now + holdMs;']], killer: 'holdsFromDelivery', dies: /THE HOLD ENDS 30 MIN AFTER DELIVERY/ },
  { name: 'quiet mail alone claims (the old behaviour)', file: WW, kind: 'ww',
    edits: [['    if (r.pending.size === 0 && !quietDue)', '    if (r.pending.size === 0 && r.quiet.size === 0)']], killer: 'quietAloneNeverClaims', dies: /HELD QUIET MAIL ALONE STARTS NO TURN/ },
  { name: 'reconcile re-pends a held id', file: WW, kind: 'ww',
    edits: [['r.retries.has(id) || r.quiet.has(id) ||', 'r.retries.has(id) ||']], killer: 'quietAloneNeverClaims', dies: /RECONCILE NEVER RE-PENDS A HELD ID/ },
  { name: 'a real wake leaves held ids behind', file: WW, kind: 'ww',
    edits: [['    const ids = [...new Set([...r.pending, ...quietIds])].sort();', '    const ids = [...r.pending].sort();']], killer: 'realMailCarriesHeld', dies: /A REAL WAKE CARRIES EVERY HELD ID/ },
  { name: 'the bound never releases', file: WW, kind: 'ww',
    edits: [['.some((until) => until <= now);', '.some((until) => until < 0);']], killer: 'boundReleasesBatch', dies: /THE OLDEST HOLD ENDING RELEASES THE BATCH/ },
  { name: 'the bound releases on the NEWEST hold', file: WW, kind: 'ww',
    edits: [['[...r.quiet.values()].some((until) => until <= now);', '[...r.quiet.values()].every((until) => until <= now);']], killer: 'boundReleasesBatch', dies: /THE OLDEST HOLD ENDING RELEASES THE BATCH/ },
  { name: 'a seen id stays held (a late empty wake)', file: WW, kind: 'ww',
    edits: [['    for (const id of [...r.quiet.keys()]) if (!current.has(id)) r.quiet.delete(id);\n', '']], killer: 'seenIsDropped', dies: /A HELD ID THE AGENT HAS SEEN IS DROPPED/ },
  { name: 'hold takes an in-flight id', file: WW, kind: 'ww',
    edits: [['    for (const id of [...r.pending].sort()) {\n      const until = holds.get(id);', '    for (const id of [...r.pending, ...(r.inFlight?.ids ?? [])].sort()) {\n      const until = holds.get(id);']], killer: 'holdOnlyPending', dies: /AN IN-FLIGHT ID IS NOT HELD/ },
  { name: 'bridge never holds', file: BRIDGE, kind: 'bridge',
    edits: [['    this.holdQuiet(agentId, now);\n', '']], killer: 'bridgeHoldsAndReleases', dies: /A QUIET DELIVERY TYPES NOTHING/ },
  { name: 'bridge fails closed (a throw holds everything)', file: BRIDGE, kind: 'bridge',
    edits: [['    try { holds = quietUntil(agentId, pending, now); } catch { return; }', '    try { holds = quietUntil(agentId, pending, now); } catch { holds = new Map(pending.map((id) => [id, now + 1800000])); }']], killer: 'bridgeFailsOpen', dies: /NO LEDGER ANSWER = NO HOLD: IT WAKES/ },
  { name: 'a waiting card is still STALE', file: STALE, kind: 'stale',
    edits: [["    if (f && !(f.kind === 'STALE' && wait !== null)) flags.push(f);", '    if (f) flags.push(f);']], killer: 'waitingIsNotStale', dies: /A CARD WAITING FOR ITS INSTALL IS NEVER STALE/ },
  { name: 'a waiting card counts as load', file: STALE, kind: 'stale',
    edits: [['    if (wait === null) {\n      const list = doingBy.get(agent);', '    if (true) {\n      const list = doingBy.get(agent);']], killer: 'waitingIsNotLoad', dies: /A CARD WAITING FOR ITS INSTALL IS NOT LOAD/ },
  { name: 'installed is never flagged', file: STALE, kind: 'stale',
    edits: [["    if (wait === 'installed') flags.push(installedFlag(card, input));\n", '']], killer: 'installedFlagsOnce', dies: /IS SHIPPED_INSTALLED, NOT STALE/ },
  { name: 'installed only when strictly newer', file: STALE, kind: 'stale',
    edits: [["  return 'installed';\n}", "  return 'waiting';\n}"]], killer: 'installedFlagsOnce', dies: /INSTALLED \(RUNNING 1\.1\.81\) IS SHIPPED_INSTALLED/ },
  { name: 'SHIPPED_INSTALLED re-arms daily like STALE', file: DIGEST, kind: 'digest',
    edits: [["f.kind === 'SHIPPED_INSTALLED' ? `shipped_installed:${f.cardId}:${f.fixVersion ?? ''}`", "f.kind === 'SHIPPED_INSTALLED' ? `shipped_installed:${f.cardId}:${day(now)}`"]], killer: 'installedFlagsOnce', dies: /ONCE PER FIX VERSION/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const mod = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
      const run = m.kind === 'bridge' ? () => K[m.killer]({ ...real, bridge: mod })
        : m.kind === 'digest' ? () => K[m.killer](real.stale, mod)
          : () => K[m.killer](mod);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
