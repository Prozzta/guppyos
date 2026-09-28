'use strict';
/**
 * ZT-I1-MAIL §11.19 #2 (Creed, INBOX-DESIGN 4883344; god's ruling on Jim's baseline at 502cedcd):
 * the N1 counter `unconfirmedSurfacings` counts ONLY surfacings whose §11.1 evidence is missing
 * (`unconfirmed`) or that arrived LATE; it is NEVER increased by an abnormal-epoch back-edge
 * (interrupt, crash, StopFailure, a new session, a PTY exit or respawn, submit-unconfirmed, the
 * stale backstop, a restart, a compaction overflow, an undelivered restore), and it RESETS on any
 * confirmed surfacing ("consecutive"). Already correct in code (mailLedger.ts: backEdge's
 * countUnconfirmed is false at the abnormal close, applyRedeliver and applyRestartRecovery; true
 * only for 'unconfirmed' and 'late'; applyConfirmSurfaced sets 0). PINNING tests only. The wake
 * coordinator's n1Due (wake-n1-budget.test.cjs) reads this same counter, so they stay consistent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/mailLedger.ts');
const msg = (id) => ({ id, from: 'god-1', act: 'inform', subject: `s-${id}`, body: `b-${id}` });

/** A ledger with `m` delivered and already `n` unconfirmed surfacings, now surfacing in epoch `e`. */
function surfacingWith(n) {
  let doc = L.applyDelivered(L.emptyLedger('cl-1'), msg('m'), 1).doc;
  let t = 10;
  for (let i = 0; i < n; i++) {
    doc = L.applyClaimSurfacing(doc, ['m'], `u${i}`, 'UserPromptSubmit', t++).doc;
    doc = L.applyCloseEpoch(doc, `u${i}`, 'normal', t++).doc;           // unconfirmed: +1
  }
  assert.equal(doc.entries.m.unconfirmedSurfacings, n);
  doc = L.applyClaimSurfacing(doc, ['m'], 'e', 'UserPromptSubmit', t++).doc;
  assert.equal(doc.entries.m.state, 'surfacing');
  return doc;
}

// Every abnormal reason the product passes (hooks.ts closeMailEpoch / abortMailEpochs callers,
// index.ts abortMailTurn, HookServer.abortMailEpochsSince, the stale backstop).
const ABNORMAL = ['stop-failure', 'interrupted', 'next-turn', 'session-startup', 'session-resume', 'session-clear', 'pty-exit', 'respawn', 'submit-unconfirmed', 'stale-epoch', 'abnormal'];

for (const reason of ABNORMAL) {
  test(`§11.19 #2: an abnormal epoch close (${reason}) returns the id to delivered WITHOUT counting toward N1`, () => {
    const doc = surfacingWith(1);
    const s = L.applyCloseEpoch(doc, 'e', 'abnormal', 100, { reason });
    const e = s.doc.entries.m;
    assert.equal(e.state, 'delivered');
    assert.equal(e.redelivered, true, 'with the marker');
    assert.equal(e.unconfirmedSurfacings, 1, 'unchanged');
    assert.deepEqual(L.n1DueIds(s.doc), [], 'not N1-due: an interrupt is not an evidence failure');
    assert.deepEqual(s.logs.map((r) => [r.kind, r.stage, r.reason]), [['mail', 'redelivered', reason]]);
  });
}

test('§11.19 #2: TWO interrupts after one unconfirmed surfacing never make it N1-due (no false latency-fallback)', () => {
  let doc = surfacingWith(1);
  doc = L.applyCloseEpoch(doc, 'e', 'abnormal', 100, { reason: 'interrupted' }).doc;
  doc = L.applyClaimSurfacing(doc, ['m'], 'e2', 'UserPromptSubmit', 101).doc;
  doc = L.applyCloseEpoch(doc, 'e2', 'abnormal', 102, { reason: 'stop-failure' }).doc;
  assert.equal(doc.entries.m.unconfirmedSurfacings, 1);
  assert.deepEqual(L.n1DueIds(doc), []);
});

test('§11.19 #2: the other back-edges (restart recovery, compaction overflow, undelivered restore) never count', () => {
  const doc = surfacingWith(1);
  assert.equal(L.applyRestartRecovery(doc, 100).doc.entries.m.unconfirmedSurfacings, 1, 'restart');
  for (const reason of ['compact-overflow', 'undelivered-restored']) {
    const s = L.applyRedeliver(doc, ['m'], reason, 100);
    assert.equal(s.doc.entries.m.state, 'delivered');
    assert.equal(s.doc.entries.m.unconfirmedSurfacings, 1, reason);
  }
});

test('§11.19 #2 (god: LATE keeps counting): an unconfirmed and a LATE surfacing each count +1; at 2 the id is N1-due', () => {
  let doc = surfacingWith(0);
  doc = L.applyCloseEpoch(doc, 'e', 'normal', 100).doc;
  assert.equal(doc.entries.m.unconfirmedSurfacings, 1, 'unconfirmed');
  doc = L.applyClaimSurfacing(doc, ['m'], 'e2', 'UserPromptSubmit', 101).doc;
  const s = L.applyCloseEpoch(doc, 'e2', 'normal', 102, { late: ['m'] });
  assert.equal(s.doc.entries.m.unconfirmedSurfacings, 2, 'late');
  assert.equal(s.logs[0].kind, 'mail-surface-late');
  assert.deepEqual(L.n1DueIds(s.doc), ['m'], 'the coordinator\'s n1Due reads this very counter');
  assert.ok(s.doc.entries.m.unconfirmedSurfacings >= L.MAIL_UNCONFIRMED_FALLBACK_AFTER);
});

test('§11.19 #2: a CONFIRMED surfacing resets the counter ("consecutive")', () => {
  for (const method of ['evidence', 'latency', 'latency-fallback']) {
    let doc = surfacingWith(2);
    doc = L.applyConfirmSurfaced(doc, ['m'], 'e', method, 100).doc;
    assert.equal(doc.entries.m.state, 'surfaced');
    assert.equal(doc.entries.m.unconfirmedSurfacings, 0, method);
    // Surfaced then returned by an abnormal close: still 0, and a later unconfirmed one counts from 0.
    doc = L.applyCloseEpoch(doc, 'e', 'abnormal', 101, { reason: 'interrupted' }).doc;
    assert.equal(doc.entries.m.unconfirmedSurfacings, 0);
    doc = L.applyClaimSurfacing(doc, ['m'], 'e3', 'UserPromptSubmit', 102).doc;
    doc = L.applyCloseEpoch(doc, 'e3', 'normal', 103).doc;
    assert.equal(doc.entries.m.unconfirmedSurfacings, 1, 'counting again from zero');
  }
});
