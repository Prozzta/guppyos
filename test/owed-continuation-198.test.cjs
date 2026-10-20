'use strict';

/**
 * HIVE-DWIGHT-BG-REINVOKE (god 7e4159): the owed-work continuation.
 *
 *  A. the reply act decides discharge: done/refuse/blocked (needs_human) discharge, inform/agree keep
 *     the work owed, a later discharging reply upgrades an interim one, the rebuild restores the act;
 *  B. the watcher (src/main/owedContinuation.ts): both real incidents replayed from the log rows
 *     (2026-10-20 07:18Z two requests unreplied; 02:59Z a request answered only with an inform),
 *     the 3 min grace, the suppressors, pause/halt, never while active, the caps and the god notice;
 *  the wiring in index.ts and hive.ts (source pins).
 * Pure: a simulated clock, no timers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/mailLedger.ts');
const O = loadTs('src/main/owedContinuation.ts');

const ROOT = path.resolve(__dirname, '..');
const at = (iso) => Date.parse(iso);
const DW = 'dwight-mu32ztys';
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Deliver, surface and act ids in one epoch, the way the log rows show it. */
function actedDoc(agentId, delivered, epoch, surfacedAt, actedAt, doc = L.emptyLedger(agentId)) {
  for (const d of delivered) doc = L.applyDelivered(doc, { id: d.id, from: d.from, act: d.act, subject: d.subject ?? `s-${d.id}`, body: 'b' }, d.at).doc;
  const ids = delivered.map((d) => d.id);
  doc = L.applyClaimSurfacing(doc, ids, epoch, 'UserPromptSubmit', surfacedAt).doc;
  doc = L.applyConfirmSurfaced(doc, ids, epoch, 'evidence', surfacedAt).doc;
  return L.applyCloseEpoch(doc, epoch, 'normal', actedAt).doc;
}

/** Idle facts after a Stop at `stop`, nothing else going on. */
function facts(doc, stop, now, extra = {}) {
  return {
    now, lifecycle: 'idle', lastTurnEndAt: stop, inFlight: false, pendingMail: 0,
    paused: false, halted: false, autoDeliveryPaused: false, hitl: false, heavyQueued: false,
    entries: Object.values(doc.entries), sent: [], ...extra
  };
}

const watcher = (startedAt, god = 'god') => new O.OwedContinuation(startedAt, () => god);

// ————————————————————————————————————————————————— A: the reply act

test('OWED A: an inform, agree or onward request reply keeps the request owed; only done, refuse and blocked discharge it', () => {
  const base = actedDoc('jim-1', [{ id: 'q', from: 'god', act: 'request', at: 1000 }], 'e1', 1001, 1002);
  for (const act of ['inform', 'agree', 'request', 'query']) {
    const s = L.applyReplied(base, 'q', 'r1', 2000, 'god', act);
    const e = s.doc.entries.q;
    assert.equal(e.replyAct, act);
    assert.equal(e.repliedAt, 2000, 'the Requests tab still sees a reply');
    assert.equal(L.isOpenObligation(e), false);
    assert.equal(L.owesWork(e), true, `${act} keeps the work owed`);
    assert.deepEqual(s.logs.find((r) => r.stage === 'replied'), { agentId: 'jim-1', kind: 'mail', stage: 'replied', id: 'q', replyId: 'r1', replyAct: act });
  }
  for (const act of ['done', 'refuse', 'blocked']) {
    const e = L.applyReplied(base, 'q', 'r1', 2000, 'god', act).doc.entries.q;
    assert.equal(L.owesWork(e), false, `${act} discharges`);
  }
  const legacy = L.applyReplied(base, 'q', 'r1', 2000, 'god').doc.entries.q;
  assert.equal(legacy.replyAct, undefined);
  assert.equal(L.owesWork(legacy), false, 'a reply with no act recorded (legacy) counts as discharged');
});

test('OWED A: a later done upgrades an interim reply; another inform changes nothing; a close discharges', () => {
  const base = actedDoc('jim-1', [{ id: 'q', from: 'god', act: 'request', at: 1000 }], 'e1', 1001, 1002);
  const interim = L.applyReplied(base, 'q', 'r1', 2000, 'god', 'inform').doc;
  assert.equal(L.applyReplied(interim, 'q', 'r2', 3000, 'god', 'inform').changed.length, 0, 'a second inform is not an upgrade');
  assert.equal(L.applyReplied(interim, 'q', 'r2', 3000, 'god', 'agree').changed.length, 0, 'nor is an agree');
  const up = L.applyReplied(interim, 'q', 'r3', 4000, 'god', 'done');
  assert.deepEqual(up.changed, ['q']);
  assert.equal(up.doc.entries.q.replyAct, 'done');
  assert.equal(up.doc.entries.q.replyId, 'r3');
  assert.equal(L.owesWork(up.doc.entries.q), false);
  assert.equal(L.applyReplied(up.doc, 'q', 'r4', 5000, 'god', 'done').changed.length, 0, 'a discharged entry stays put');
});

test('OWED A: a dismiss, a supersede or a cited done closes an interim-replied request', () => {
  const T = at('2026-10-20T10:00:00.000Z');
  const base = actedDoc('jim-1', [{ id: '2026-10-20T10-00-00-000Z-abc123', from: 'god', act: 'request', at: T }], 'e1', T + 1, T + 2);
  const id = '2026-10-20T10-00-00-000Z-abc123';
  const interim = L.applyReplied(base, id, 'r1', T + 3, 'god', 'inform').doc;
  const closed = L.applyCloseObligation(interim, id, T + 4, 'closed-by-human');
  assert.deepEqual(closed.changed, [id], 'dismiss');
  assert.equal(L.owesWork(closed.doc.entries[id]), false);
  assert.deepEqual(L.supersededByMessage(interim, 'god', { id: 'sup', at: T + 5, act: 'request', supersedes: [id] }).map((s) => s.id), [id], 'supersede');
  assert.deepEqual(L.answeredByMessage(interim, 'god', { id: 'ans', at: T + 5, act: 'done', subject: `done ${id}`, body: '' }).map((s) => s.id), [id], 'a cited done');
  assert.deepEqual(L.answeredByMessage(interim, 'god', { id: 'ans', at: T + 5, act: 'inform', subject: `progress ${id}`, body: '' }), [], 'a cited inform is a status');
});

test('OWED A: the rebuild restores the act of the latest replied row', () => {
  const T = at('2026-10-20T10:00:00.000Z');
  const rows = (acts) => [
    { ts: T, kind: 'mail', agentId: 'jim-1', stage: 'delivered', id: 'q', from: 'god', act: 'request', requiresReply: true },
    ...acts.map((a, i) => ({ ts: T + 10 + i, kind: 'mail', agentId: 'jim-1', stage: 'replied', id: 'q', replyId: `r${i}`, ...(a ? { replyAct: a } : {}) }))
  ];
  const done = [{ id: 'q', msg: { from: 'god', act: 'request', subject: 's', body: 'b' }, mtimeMs: T + 1 }];
  const interim = L.rebuildLedger('jim-1', { inbox: [], done, logRows: rows(['inform']) }, T + 100).entries.q;
  assert.equal(interim.replyAct, 'inform');
  assert.equal(L.owesWork(interim), true, 'a rebuilt inform-only reply still owes the work');
  const upgraded = L.rebuildLedger('jim-1', { inbox: [], done, logRows: rows(['inform', 'done']) }, T + 100).entries.q;
  assert.equal(upgraded.replyAct, 'done');
  assert.equal(L.owesWork(upgraded), false);
  const legacy = L.rebuildLedger('jim-1', { inbox: [], done, logRows: rows([null]) }, T + 100).entries.q;
  assert.equal('replyAct' in legacy, false);
  assert.equal(L.owesWork(legacy), false);
});

test('OWED A: hive routes needs_human as blocked and passes the act; the ledger close reaches interim asks (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/hive.ts'), 'utf8');
  assert.match(src, /this\.mail\.markReplied\(msg\.from, msg\.in_reply_to, msg\.id, resolveTo\(msg\.to\), msg\.needs_human === true \? 'blocked' : msg\.act\)/);
  const closable = src.slice(src.indexOf('private findClosableAsk('), src.indexOf('private findClosableAsk(') + 1500);
  assert.match(closable, /if \(own && owesWork\(own\)\) return \{ by: 'owner', open: \[caller\] \};/);
  assert.match(closable, /if \(owesWork\(e\)\) open\.push\(a\);/);
});

// ————————————————————————————————————————————————— B: the two real incidents

// 2026-10-20 07:18Z (log.jsonl rows, Dwight's ledger): god's 89d4d1 (06:36) acted at 06:39 with no
// replied row; Jim's done 52d96b, god's requests 095609 (ONBINARY) and 267a5e (ROUTER NIT) acted at
// the Stop 07:18:16.453. Dwight's own audit request d577a3 to Jim was answered by Jim's done at
// 07:17:08 (jim ledger replied row), so it holds nothing back. He sat until god's term send at 08:05:10.
function incident0718() {
  let doc = actedDoc(DW, [{ id: '2026-10-20T06-36-03-468Z-89d4d1', from: 'god', act: 'request', at: at('2026-10-20T06:36:03.476Z') }],
    '01a15806', at('2026-10-20T06:36:46.266Z'), at('2026-10-20T06:39:09.479Z'));
  doc = actedDoc(DW, [
    { id: '2026-10-20T07-17-08-546Z-52d96b', from: 'jim-mtujpe28', act: 'done', at: at('2026-10-20T07:17:08.558Z') },
    { id: '2026-10-20T07-17-16-795Z-095609', from: 'god', act: 'request', at: at('2026-10-20T07:17:16.801Z') },
    { id: '2026-10-20T07-17-33-344Z-267a5e', from: 'god', act: 'request', at: at('2026-10-20T07:17:33.357Z') }
  ], '01a1582b', at('2026-10-20T07:17:49.412Z'), at('2026-10-20T07:18:16.450Z'), doc);
  const sent = [{ id: '2026-10-20T07-15-50-446Z-d577a3', to: 'jim-mtujpe28', act: 'request', at: at('2026-10-20T07:15:50.452Z'), open: false }];
  return { doc, sent, stop: at('2026-10-20T07:18:16.453Z') };
}

// 2026-10-20 02:59Z: god's b1b49e acted at the Stop 02:59:36.500 after Dwight's reply e79f22 with
// act INFORM ("Started INBOUND-BIND-LOOPBACK-198"). His audit request 1103c3 to Jim was replied by
// Jim's done 4697f7 at 02:58:34. Sent after b1b49e: a2a1a4 done, 76a21c inform, e79f22 inform.
// He sat until god's request at 04:25:50.
function incident0259() {
  let doc = actedDoc(DW, [
    { id: '2026-10-20T02-58-34-468Z-4697f7', from: 'jim-mtujpe28', act: 'done', at: at('2026-10-20T02:58:34.475Z') },
    { id: '2026-10-20T02-58-40-309Z-b1b49e', from: 'god', act: 'request', at: at('2026-10-20T02:58:40.317Z') }
  ], '01a1573f', at('2026-10-20T02:58:52.422Z'), at('2026-10-20T02:59:36.499Z'));
  doc = L.applyReplied(doc, '2026-10-20T02-58-40-309Z-b1b49e', '2026-10-20T02-59-34-126Z-e79f22', at('2026-10-20T02:59:34.129Z'), 'god', 'inform').doc;
  const sent = [
    { id: '2026-10-20T02-58-15-276Z-1103c3', to: 'jim-mtujpe28', act: 'request', at: at('2026-10-20T02:58:15.283Z'), open: false },
    { id: '2026-10-20T02-58-21-947Z-24e59d', to: 'god', act: 'inform', at: at('2026-10-20T02:58:21.954Z'), open: false },
    { id: '2026-10-20T02-58-52-978Z-a2a1a4', to: 'god', act: 'done', at: at('2026-10-20T02:58:52.985Z'), open: false },
    { id: '2026-10-20T02-59-01-383Z-76a21c', to: 'creed-mukyiphw', act: 'inform', at: at('2026-10-20T02:59:01.390Z'), open: false },
    { id: '2026-10-20T02-59-34-126Z-e79f22', to: 'god', act: 'inform', at: at('2026-10-20T02:59:34.133Z'), open: false }
  ];
  return { doc, sent, stop: at('2026-10-20T02:59:36.500Z') };
}

test('OWED REPLAY 07:18Z: the unreplied requests get a continuation 3 min after the Stop, not 47 min later', () => {
  const { doc, sent, stop } = incident0718();
  const w = watcher(at('2026-10-20T06:00:00.000Z'));
  assert.deepEqual(w.tick(DW, facts(doc, stop, stop + O.OWED_GRACE_MS - 1, { sent })), { rows: [] }, 'inside the grace: nothing');
  const d = w.tick(DW, facts(doc, stop, stop + O.OWED_GRACE_MS, { sent }));
  const ids = ['2026-10-20T06-36-03-468Z-89d4d1', '2026-10-20T07-17-16-795Z-095609', '2026-10-20T07-17-33-344Z-267a5e'];
  assert.deepEqual(d.rows, [{ kind: 'wake', stage: 'continuation', agentId: DW, ids, graceMs: O.OWED_GRACE_MS, idleMs: O.OWED_GRACE_MS }]);
  assert.equal(d.nudge.from, 'system');
  assert.equal(d.nudge.message.to, DW);
  assert.equal(d.nudge.message.act, 'inform');
  assert.equal(d.nudge.message.requires_reply, false);
  assert.equal(d.nudge.message.wake, 'now', 'through the normal claim path');
  for (const id of ids) assert.ok(d.nudge.message.body.includes(id), id);
  assert.ok(!d.nudge.message.body.includes('52d96b'), 'a done from Jim is not owed work');
  assert.equal(d.notice, undefined);
  assert.ok(stop + O.OWED_GRACE_MS < at('2026-10-20T08:05:10.000Z'));
});

test('OWED REPLAY 02:59Z: a request answered only with an inform still gets a continuation', () => {
  const { doc, sent, stop } = incident0259();
  assert.equal(L.isOpenObligation(doc.entries['2026-10-20T02-58-40-309Z-b1b49e']), false, 'the old rule saw it as answered');
  const d = watcher(at('2026-10-20T02:00:00.000Z')).tick(DW, facts(doc, stop, stop + O.OWED_GRACE_MS, { sent }));
  assert.deepEqual(d.rows.map((r) => [r.stage, r.ids]), [['continuation', ['2026-10-20T02-58-40-309Z-b1b49e']]]);
  assert.ok(d.nudge.message.body.includes('2026-10-20T02-58-40-309Z-b1b49e'));
});

test('OWED REPLAY 02:59Z: had the reply been a done, nothing is owed', () => {
  const { doc: d0, sent, stop } = incident0259();
  const doc = L.applyReplied(d0, '2026-10-20T02-58-40-309Z-b1b49e', 'later-done', stop + 1, 'god', 'done').doc;
  assert.deepEqual(watcher(at('2026-10-20T02:00:00.000Z')).tick(DW, facts(doc, stop, stop + O.OWED_GRACE_MS, { sent })), { rows: [] });
});

// ————————————————————————————————————————————————— suppressors

test('OWED SUPPRESS: a legitimate wait holds it back, with one row per edge', () => {
  const { doc, sent, stop } = incident0718();
  const now = stop + O.OWED_GRACE_MS;
  const cases = [
    ['paused', { paused: true }],
    ['halted', { halted: true }],
    ['auto-delivery-paused', { autoDeliveryPaused: true }],
    ['hitl', { hitl: true }],
    ['heavy-queued', { heavyQueued: true }],
    ['outgoing-request', { sent: [{ ...sent[0], open: true }] }],
    ['outgoing-request', { sent: [...sent, { id: 'older-audit', to: 'jim-mtujpe28', act: 'request', at: stop - 2 * HOUR, open: true }] }],
    ['newest-sent-request', { sent: [...sent, { id: 'ask', to: 'pam-1', act: 'request', at: stop - 1000, open: false }] }]
  ];
  for (const [why, extra] of cases) {
    const w = watcher(at('2026-10-20T06:00:00.000Z'));
    const d = w.tick(DW, facts(doc, stop, now, { sent, ...extra }));
    assert.equal(d.nudge, undefined, why);
    assert.deepEqual(d.rows.map((r) => [r.stage, r.suppressedBy]), [['continuation', why]], why);
    assert.deepEqual(w.tick(DW, facts(doc, stop, now + 15_000, { sent, ...extra })), { rows: [] }, `${why}: no row per beat`);
    const after = w.tick(DW, facts(doc, stop, now + 30_000, { sent }));
    assert.ok(after.nudge, `${why}: the continuation goes once the wait ends`);
  }
});

test('OWED SUPPRESS: an older request or one outside the window does not hold it back', () => {
  const { doc, sent, stop } = incident0718();
  const now = stop + O.OWED_GRACE_MS;
  const old = { id: 'old', to: 'jim-mtujpe28', act: 'request', at: now - O.OWED_WINDOW_MS - 1, open: true };
  assert.ok(watcher(0).tick(DW, facts(doc, stop, now, { sent: [...sent, old] })).nudge, 'an outgoing request older than the window');
  const before = { id: 'before', to: 'pam-1', act: 'request', at: at('2026-10-20T06:00:00.000Z'), open: false };
  assert.ok(watcher(0).tick(DW, facts(doc, stop, now, { sent: [before, { id: 'i', to: 'god', act: 'inform', at: stop - 1, open: false }] })).nudge,
    'the newest sent message is an inform');
  const ask = { id: 'ask', to: 'pam-1', act: 'request', at: stop - 1000, open: false };
  const answered = actedDoc(DW, [{ id: 'pam-done', from: 'pam-1', act: 'done', at: stop - 500 }], 'e9', stop - 400, stop - 300, doc);
  assert.ok(watcher(0).tick(DW, facts(answered, stop, now, { sent: [...sent, ask] })).nudge, 'its newest request was answered since');
  const sys = actedDoc(DW, [{ id: 'sys-note', from: 'system', act: 'inform', at: stop - 500 }], 'e9', stop - 400, stop - 300, doc);
  assert.equal(watcher(0).tick(DW, facts(sys, stop, now, { sent: [...sent, ask] })).nudge, undefined, 'a system mail is no answer');
});

// ————————————————————————————————————————————————— never into a working agent

test('OWED GUARD: nothing while active, in flight, with mail pending, inside the grace or before any Stop', () => {
  const { doc, sent, stop } = incident0718();
  const now = stop + O.OWED_GRACE_MS + 5 * MIN;
  for (const [what, extra] of [
    ['active', { lifecycle: 'active' }],
    ['unknown', { lifecycle: 'unknown' }],
    ['in flight', { inFlight: true }],
    ['mail pending', { pendingMail: 1 }],
    ['no Stop', { lastTurnEndAt: 0 }],
    ['grace', { lastTurnEndAt: now - O.OWED_GRACE_MS + 1 }]
  ]) assert.deepEqual(watcher(0).tick(DW, facts(doc, stop, now, { sent, ...extra })), { rows: [] }, what);
});

test('OWED SCOPE: not for system mail, own mail, non-requests, mail acted before the watcher started, or past the window', () => {
  const T = at('2026-10-20T10:00:00.000Z');
  const doc = actedDoc('jim-1', [
    { id: 'sys', from: 'system', act: 'request', at: T },
    { id: 'self', from: 'jim-1', act: 'request', at: T },
    { id: 'info', from: 'god', act: 'inform', at: T },
    { id: 'query', from: 'god', act: 'query', at: T }
  ], 'e', T + 1, T + 2);
  assert.deepEqual(watcher(0).tick('jim-1', facts(doc, T + 3, T + 3 + O.OWED_GRACE_MS)), { rows: [] });
  const req = actedDoc('jim-1', [{ id: 'q', from: 'god', act: 'request', at: T }], 'e', T + 1, T + 2);
  assert.deepEqual(watcher(T + 3).tick('jim-1', facts(req, T + 3, T + 3 + O.OWED_GRACE_MS)), { rows: [] }, 'acted before the start: no backlog flood');
  assert.ok(watcher(T + 2).tick('jim-1', facts(req, T + 3, T + 3 + O.OWED_GRACE_MS)).nudge, 'acted at the start');
  assert.deepEqual(watcher(0).tick('jim-1', facts(req, T + O.OWED_WINDOW_MS, T + O.OWED_WINDOW_MS + 1)), { rows: [] }, 'past the window');
  const delivered = L.applyDelivered(L.emptyLedger('jim-1'), { id: 'p', from: 'god', act: 'request', subject: 's', body: 'b' }, T).doc;
  assert.deepEqual(watcher(0).tick('jim-1', facts(delivered, T + 3, T + 3 + O.OWED_GRACE_MS)), { rows: [] }, 'not yet acted: the wake owns it');
});

// ————————————————————————————————————————————————— caps

test('OWED CAP: one per obligation per hour and only after a new Stop; two in all, then one stall row and one god notice', () => {
  const { doc, sent, stop } = incident0259();
  const w = watcher(at('2026-10-20T02:00:00.000Z'));
  const t1 = stop + O.OWED_GRACE_MS;
  assert.ok(w.tick(DW, facts(doc, stop, t1, { sent })).nudge, 'first');
  assert.deepEqual(w.tick(DW, facts(doc, stop, t1 + 2 * HOUR, { sent })), { rows: [] }, 'no new Stop since: never again on idle alone');
  const stop2 = t1 + 10 * MIN;
  assert.deepEqual(w.tick(DW, facts(doc, stop2, t1 + O.OWED_REPEAT_MS - 1, { sent })), { rows: [] }, 'a new Stop, but inside the hour');
  const t2 = t1 + O.OWED_REPEAT_MS;
  const d2 = w.tick(DW, facts(doc, stop2, t2, { sent }));
  assert.ok(d2.nudge, 'second, an hour on and after a new Stop');
  assert.equal(d2.notice, undefined);
  const stop3 = t2 + 5 * MIN;
  assert.deepEqual(w.tick(DW, facts(doc, stop3, t2 + O.OWED_REPEAT_MS - 1, { sent })), { rows: [] });
  const t3 = t2 + O.OWED_REPEAT_MS;
  const d3 = w.tick(DW, facts(doc, stop3, t3, { sent }));
  assert.equal(d3.nudge, undefined, 'no third continuation');
  assert.deepEqual(d3.rows, [{ kind: 'wake', stage: 'continuation-gave-up', agentId: DW, ids: ['2026-10-20T02-58-40-309Z-b1b49e'], continuations: O.OWED_MAX, idleMs: t3 - stop3 }]);
  assert.equal(d3.notice.message.to, 'god');
  assert.equal(d3.notice.from, 'system');
  assert.ok(d3.notice.message.subject.startsWith(`STALL: ${DW}`));
  assert.ok(d3.notice.message.body.includes('2026-10-20T02-58-40-309Z-b1b49e'));
  const stop4 = t3 + 5 * MIN;
  assert.deepEqual(w.tick(DW, facts(doc, stop4, t3 + 3 * O.OWED_REPEAT_MS, { sent })), { rows: [] }, 'given up: never a loop');
});

test('OWED CAP: a discharged obligation drops its tally; a fresh one starts its own', () => {
  const T = at('2026-10-20T10:00:00.000Z');
  let doc = actedDoc('jim-1', [{ id: 'a', from: 'god', act: 'request', at: T }], 'e1', T + 1, T + 2);
  const w = watcher(0);
  assert.deepEqual(w.tick('jim-1', facts(doc, T + 3, T + 3 + O.OWED_GRACE_MS)).rows[0].ids, ['a']);
  doc = L.applyReplied(doc, 'a', 'r', T + 5 * MIN, 'god', 'done').doc;
  doc = actedDoc('jim-1', [{ id: 'b', from: 'pam-1', act: 'request', at: T + 6 * MIN }], 'e2', T + 6 * MIN, T + 7 * MIN, doc);
  const d = w.tick('jim-1', facts(doc, T + 7 * MIN, T + 7 * MIN + O.OWED_GRACE_MS));
  assert.deepEqual(d.rows[0].ids, ['b'], 'only the new obligation, at once');
});

test('OWED CAP: no god notice when there is no god or the agent is god', () => {
  const { doc, sent, stop } = incident0259();
  for (const god of [null, DW]) {
    const w = watcher(0, god);
    let s = stop;
    let t = stop + O.OWED_GRACE_MS;
    w.tick(DW, facts(doc, s, t, { sent }));
    s = t + MIN; t += O.OWED_REPEAT_MS;
    w.tick(DW, facts(doc, s, t, { sent }));
    s = t + MIN; t += O.OWED_REPEAT_MS;
    const d = w.tick(DW, facts(doc, s, t, { sent }));
    assert.equal(d.rows[0].stage, 'continuation-gave-up');
    assert.equal(d.notice, undefined, String(god));
  }
});

// ————————————————————————————————————————————————— wiring

test('OWED WIRING: the 15 s beat runs it after the wake reconcile, with the live guards and heavy queue (source pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /inboxWake\.reconcileAll\(live\);\n  runOwedContinuation\(live\);\n  \/\/ ZERO-TOKEN-LIVENESS/);
  const fn = src.slice(src.indexOf('function runOwedContinuation('), src.indexOf('/** Inbox-wake RECONCILIATION'));
  for (const re of [
    /paused: snap\.paused,/, /halted: snap\.halted,/, /autoDeliveryPaused: snap\.autoDeliveryPaused,/,
    /inFlight: !!workerWake\.state\(agentId\)\.inFlight,/, /pendingMail: mailPendingIds\(agentId\)\.length,/,
    /lifecycle: lf\.lifecycle,/, /lastTurnEndAt: lf\.lastTurnEndAt,/,
    /heavyQueued: q\.waiters\.some\(\(w\) => w\.agentId === agentId\) \|\| q\.reserved\.some\(\(r\) => r\.agentId === agentId\),/,
    /open: owesWork\(e\)/,
    /hive\.send\(d\.nudge\.message as Partial<HiveMessage>, 'system'\)/,
    /hive\.send\(d\.notice\.message as Partial<HiveMessage>, 'system'\)/,
    /hive\.appendLog\(row\)/
  ]) assert.match(fn, re);
});
