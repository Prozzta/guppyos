'use strict';

/**
 * ZT-I1-MAIL (1.1.75) slice 1: the per-agent mail ledger (INBOX-DESIGN.md §1, §11).
 *
 *  - the PURE state machine: every transition and back-edge, idempotent duplicates, acted only on
 *    the matching epoch, reply/outcome tracking, pruning, the N1 counter, the log-row budget;
 *  - the I/O shell (MailLedger): atomic + coalesced writes, flush, the harness .done rename after
 *    the ledger write (with retry), a corrupt ledger rebuilt loudly and never empty, the first-run
 *    migration, restart recovery.
 * A simulated clock and fake timers throughout: no real waiting.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/mailLedger.ts');

const T0 = Date.parse('2026-09-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const msg = (id, extra = {}) => ({ id, from: 'god-1', act: 'inform', subject: `s-${id}`, body: `body of ${id}`, ...extra });

/** Run a sequence of pure steps, collecting every log row. */
function chain(doc) {
  const rows = [];
  const events = [];
  const archive = [];
  const api = {
    get doc() { return doc; },
    rows, events, archive,
    step(s) { doc = s.doc; rows.push(...s.logs); events.push(...s.events); archive.push(...s.archive); return s; }
  };
  return api;
}

// ————————————————————————————————————————————————— pure: the happy path and the row budget

test('delivered → surfacing → surfaced → acted on the matching epoch, ≤ 4 rows per message', () => {
  const c = chain(L.emptyLedger('jim-1'));
  c.step(L.applyDelivered(c.doc, msg('m1', { act: 'request' }), T0));
  assert.equal(c.doc.entries.m1.state, 'delivered');
  assert.equal(c.doc.entries.m1.requiresReply, true, 'request defaults to requires_reply');

  const claim = c.step(L.applyClaimSurfacing(c.doc, ['m1'], 'turn-7', 'UserPromptSubmit', T0 + 1));
  assert.deepEqual(claim.changed, ['m1']);
  assert.equal(c.doc.entries.m1.state, 'surfacing');
  assert.equal(c.doc.entries.m1.epoch, 'turn-7');
  assert.equal(c.doc.entries.m1.surfaceCount, 1);
  assert.equal(claim.logs.length, 0, 'the tentative step writes no row');

  c.step(L.applyConfirmSurfaced(c.doc, ['m1'], 'turn-7', 'evidence', T0 + 2));
  assert.equal(c.doc.entries.m1.state, 'surfaced');

  const close = c.step(L.applyCloseEpoch(c.doc, 'turn-7', 'normal', T0 + 3));
  assert.equal(c.doc.entries.m1.state, 'acted');
  assert.equal(c.doc.entries.m1.actedAt, T0 + 3);
  assert.deepEqual(close.archive, ['m1'], 'the harness archives the file');
  assert.equal(c.doc.lastActedAt, T0 + 3);

  c.step(L.applyReplied(c.doc, 'm1', 'r1', T0 + 4));
  assert.equal(c.doc.entries.m1.repliedAt, T0 + 4);
  assert.equal(c.doc.entries.m1.state, 'acted', 'replied never changes the state');

  const stages = c.rows.map((r) => `${r.kind}:${r.stage}`);
  assert.deepEqual(stages, ['mail:delivered', 'mail:surfaced', 'mail:acted', 'mail:replied']);
  assert.ok(c.rows.every((r) => r.agentId === 'jim-1'));
  assert.deepEqual(c.events.map((e) => e.stage), ['delivered', 'surfacing', 'surfaced', 'acted', 'replied']);
});

test('duplicate events are idempotent', () => {
  let doc = L.emptyLedger('jim-1');
  doc = L.applyDelivered(doc, msg('m1'), T0).doc;
  const again = L.applyDelivered(doc, msg('m1', { body: 'other' }), T0 + 1);
  assert.equal(again.changed.length, 0);
  assert.equal(again.doc, doc, 'a no-op returns the same document');

  doc = L.applyClaimSurfacing(doc, ['m1'], 'e1', 'UserPromptSubmit', T0 + 2).doc;
  // N3: the same id offered again in the same epoch (a mid-turn UserPromptSubmit) is deduped.
  const reclaim = L.applyClaimSurfacing(doc, ['m1'], 'e1', 'PostToolUse', T0 + 3);
  assert.equal(reclaim.changed.length, 0);
  assert.equal(reclaim.doc.entries.m1.surfaceCount, 1);
  // Another epoch cannot claim an id still open in e1.
  assert.equal(L.applyClaimSurfacing(doc, ['m1'], 'e2', 'UserPromptSubmit', T0 + 3).changed.length, 0);

  doc = L.applyConfirmSurfaced(doc, ['m1'], 'e1', 'evidence', T0 + 4).doc;
  assert.equal(L.applyConfirmSurfaced(doc, ['m1'], 'e1', 'evidence', T0 + 5).changed.length, 0);
  doc = L.applyCloseEpoch(doc, 'e1', 'normal', T0 + 6).doc;
  const reclose = L.applyCloseEpoch(doc, 'e1', 'normal', T0 + 7);
  assert.equal(reclose.changed.length, 0);
  assert.equal(L.applyCloseEpoch(doc, 'e1', 'abnormal', T0 + 7).changed.length, 0, 'an acted id never goes back');
  assert.equal(L.applyClaimSurfacing(doc, ['m1'], 'e3', 'UserPromptSubmit', T0 + 8).changed.length, 0, 'acted is final');
  assert.equal(L.applyReplied(L.applyReplied(doc, 'm1', 'r', T0).doc, 'm1', 'r2', T0 + 1).changed.length, 0);
  assert.equal(L.applyClaimSurfacing(doc, ['nope'], 'e3', 'UserPromptSubmit', T0).changed.length, 0, 'unknown ids ignored');
});

test('acted only on the matching epoch', () => {
  let doc = L.emptyLedger('jim-1');
  doc = L.applyDelivered(doc, msg('a'), T0).doc;
  doc = L.applyDelivered(doc, msg('b'), T0).doc;
  doc = L.applyClaimSurfacing(doc, ['a'], 'e1', 'UserPromptSubmit', T0).doc;
  doc = L.applyConfirmSurfaced(doc, ['a'], 'e1', 'evidence', T0).doc;
  // A confirmation for another epoch does nothing.
  doc = L.applyClaimSurfacing(doc, ['b'], 'e2', 'UserPromptSubmit', T0).doc;
  assert.equal(L.applyConfirmSurfaced(doc, ['b'], 'e1', 'evidence', T0).changed.length, 0);
  // A Stop for e2 (e.g. the Codex stale task_complete of another turn) never acts e1's mail.
  assert.equal(L.applyMarkActed(doc, ['a'], 'e2', T0).changed.length, 0);
  const closeE2 = L.applyCloseEpoch(doc, 'e2', 'normal', T0 + 1);
  assert.equal(closeE2.doc.entries.a.state, 'surfaced');
  assert.equal(closeE2.doc.entries.b.state, 'delivered', 'e2 closed with b unconfirmed');
  const closeE1 = L.applyCloseEpoch(closeE2.doc, 'e1', 'normal', T0 + 2);
  assert.equal(closeE1.doc.entries.a.state, 'acted');
});

// ————————————————————————————————————————————————— pure: back-edges

test('abnormal close: surfacing and surfaced go back to delivered with the re-delivered marker', () => {
  let doc = L.emptyLedger('jim-1');
  for (const id of ['a', 'b', 'c']) doc = L.applyDelivered(doc, msg(id), T0).doc;
  doc = L.applyClaimSurfacing(doc, ['a', 'b'], 'e1', 'UserPromptSubmit', T0 + 1).doc;
  doc = L.applyConfirmSurfaced(doc, ['a'], 'e1', 'evidence', T0 + 2).doc;
  const activityBefore = doc.lastActivityAt;
  const s = L.applyCloseEpoch(doc, 'e1', 'abnormal', T0 + 3, { reason: 'pty-exit' });
  assert.deepEqual(s.changed.sort(), ['a', 'b']);
  for (const id of ['a', 'b']) {
    assert.equal(s.doc.entries[id].state, 'delivered');
    assert.equal(s.doc.entries[id].redelivered, true);
    assert.equal(s.doc.entries[id].epoch, null);
  }
  assert.equal(s.doc.entries.c.redelivered, false);
  assert.equal(s.archive.length, 0);
  assert.deepEqual(s.logs, [{ agentId: 'jim-1', kind: 'mail', stage: 'redelivered', reason: 'pty-exit', ids: ['a', 'b'], epoch: 'e1' }]);
  assert.equal(s.doc.lastActivityAt, activityBefore, 'a harness back-edge is not activity (reader #10)');
  // The next surfacing is a fresh claim; the confirm clears the marker.
  let d2 = L.applyClaimSurfacing(s.doc, ['a'], 'e2', 'UserPromptSubmit', T0 + 4).doc;
  assert.equal(d2.entries.a.surfaceCount, 2);
  d2 = L.applyConfirmSurfaced(d2, ['a'], 'e2', 'evidence', T0 + 5).doc;
  assert.equal(d2.entries.a.redelivered, false);
});

test('normal close with an unconfirmed surfacing re-pends it (§11.1), counting toward N1', () => {
  let doc = L.applyDelivered(L.emptyLedger('jim-1'), msg('a'), T0).doc;
  doc = L.applyDelivered(doc, msg('b'), T0).doc;
  doc = L.applyClaimSurfacing(doc, ['a', 'b'], 'e1', 'UserPromptSubmit', T0).doc;
  const s1 = L.applyCloseEpoch(doc, 'e1', 'normal', T0 + 1, { late: ['b'] });
  assert.equal(s1.doc.entries.a.state, 'delivered');
  assert.equal(s1.doc.entries.a.unconfirmedSurfacings, 1);
  assert.equal(s1.doc.entries.a.redelivered, true);
  assert.deepEqual(s1.logs.map((r) => [r.kind, r.stage, r.reason, r.ids.join()]), [
    ['mail-surface-unconfirmed', 'redelivered', 'unconfirmed', 'a'],
    ['mail-surface-late', 'redelivered', 'late', 'b']
  ]);
  assert.equal(s1.archive.length, 0, 'never acted without confirmation');
  // Second unconfirmed surfacing: the counter reaches the N1 fallback threshold.
  let d = L.applyClaimSurfacing(s1.doc, ['a'], 'e2', 'UserPromptSubmit', T0 + 2).doc;
  d = L.applyCloseEpoch(d, 'e2', 'normal', T0 + 3).doc;
  assert.equal(d.entries.a.unconfirmedSurfacings, L.MAIL_UNCONFIRMED_FALLBACK_AFTER);
  // The latency fallback confirms, which resets the counter; an abnormal close does not count.
  d = L.applyClaimSurfacing(d, ['a'], 'e3', 'UserPromptSubmit', T0 + 4).doc;
  d = L.applyConfirmSurfaced(d, ['a'], 'e3', 'latency-fallback', T0 + 5).doc;
  assert.equal(d.entries.a.unconfirmedSurfacings, 0);
  assert.equal(d.entries.a.confirmMethod, 'latency-fallback');
  d = L.applyCloseEpoch(d, 'e3', 'abnormal', T0 + 6).doc;
  assert.equal(d.entries.a.unconfirmedSurfacings, 0);
});

test('restart recovery closes every open epoch abnormally; open epochs are listed oldest first', () => {
  let doc = L.emptyLedger('jim-1');
  for (const id of ['a', 'b', 'c']) doc = L.applyDelivered(doc, msg(id), T0).doc;
  doc = L.applyClaimSurfacing(doc, ['b'], 'e2', 'PostToolUse', T0 + 50).doc;
  doc = L.applyClaimSurfacing(doc, ['a'], 'e1', 'UserPromptSubmit', T0 + 10).doc;
  doc = L.applyConfirmSurfaced(doc, ['a'], 'e1', 'evidence', T0 + 11).doc;
  assert.deepEqual(L.openEpochsOf(doc), [
    { epoch: 'e1', since: T0 + 10, ids: ['a'] },
    { epoch: 'e2', since: T0 + 50, ids: ['b'] }
  ]);
  const s = L.applyRestartRecovery(doc, T0 + 100);
  assert.deepEqual(s.changed, ['a', 'b']);
  assert.ok(['a', 'b'].every((id) => s.doc.entries[id].state === 'delivered' && s.doc.entries[id].redelivered));
  assert.equal(s.logs[0].reason, 'restart');
  assert.deepEqual(L.openEpochsOf(s.doc), []);
  assert.equal(L.applyRestartRecovery(s.doc, T0 + 101).changed.length, 0);
});

// ————————————————————————————————————————————————— pure: work orders, replies, queries, pruning

test('N2: a work order is acted via work-order, out of the backlog, never archived', () => {
  const s = L.applyWorkOrder(L.emptyLedger('kim-1'), msg('w1', { act: 'request' }), T0);
  const e = s.doc.entries.w1;
  assert.equal(e.state, 'acted');
  assert.equal(e.via, 'work-order');
  assert.equal(s.archive.length, 0);
  assert.deepEqual(s.logs.map((r) => [r.stage, r.via]), [['acted', 'work-order']]);
  assert.deepEqual(L.backlogEntries(s.doc), []);
  assert.equal(L.openRequestEntries(s.doc, T0 + 60_000)[0].ageMs, 60_000, 'a work-order request still awaits its outcome');
  assert.equal(L.applyWorkOrder(s.doc, msg('w1'), T0).changed.length, 0);
});

test('replies resolve by id or sender_id; only tracked obligations; awaitingReply and openRequests', () => {
  let doc = L.emptyLedger('jim-1');
  doc = L.applyDelivered(doc, msg('q1', { act: 'query' }), T0).doc;
  doc = L.applyDelivered(doc, msg('r1', { act: 'request', requires_reply: false }), T0 + 1).doc;
  doc = L.applyDelivered(doc, msg('n1', { act: 'inform' }), T0 + 2).doc;
  doc = L.applyDelivered(doc, msg('fresh-1', { act: 'request', sender_id: 'orig-7' }), T0 + 3).doc;
  // Act all four.
  doc = L.applyClaimSurfacing(doc, ['q1', 'r1', 'n1', 'fresh-1'], 'e', 'UserPromptSubmit', T0 + 4).doc;
  doc = L.applyConfirmSurfaced(doc, ['q1', 'r1', 'n1', 'fresh-1'], 'e', 'evidence', T0 + 5).doc;
  doc = L.applyCloseEpoch(doc, 'e', 'normal', T0 + 6).doc;

  const now = T0 + 42 * 60_000;
  assert.deepEqual(L.awaitingReplyEntries(doc, now).map((o) => o.entry.id), ['q1', 'fresh-1']);
  assert.equal(L.awaitingReplyEntries(doc, now)[0].ageMs, now - T0);
  assert.deepEqual(L.openRequestEntries(doc, now).map((o) => o.entry.id), ['r1', 'fresh-1'], 'option B: every request, requires_reply or not');

  assert.equal(L.applyReplied(doc, 'n1', 'x', now).changed.length, 0, 'an inform is not tracked');
  const bySender = L.applyReplied(doc, 'orig-7', 'reply-a', now, 'god-1');
  assert.deepEqual(bySender.changed, ['fresh-1'], 'the sender_id alias resolves');
  assert.equal(bySender.doc.entries['fresh-1'].replyId, 'reply-a');
  doc = L.applyReplied(bySender.doc, 'r1', 'reply-b', now).doc;
  doc = L.applyReplied(doc, 'q1', 'reply-c', now).doc;
  assert.deepEqual(L.awaitingReplyEntries(doc, now), []);
  assert.deepEqual(L.openRequestEntries(doc, now), []);

  assert.deepEqual(L.aliasesIn(doc, 'orig-7').sort(), ['fresh-1', 'orig-7']);
  assert.deepEqual(L.aliasesIn(doc, 'fresh-1').sort(), ['fresh-1', 'orig-7']);
  assert.deepEqual(L.aliasesIn(doc, 'unknown'), ['unknown']);
});

test('a reference naming two open obligations closes exactly one: the one from the reply recipient', () => {
  let doc = L.emptyLedger('jim-1');
  doc = L.applyDelivered(doc, msg('x', { act: 'request', from: 'pam-1' }), T0).doc;
  doc = L.applyDelivered(doc, msg('fresh', { act: 'request', from: 'god-1', sender_id: 'x' }), T0 + 1).doc;
  const toGod = L.applyReplied(doc, 'x', 'r1', T0 + 2, 'god-1');
  assert.deepEqual(toGod.changed, ['fresh'], 'the alias from the recipient wins over the exact id');
  const toPam = L.applyReplied(doc, 'x', 'r1', T0 + 2, 'pam-1');
  assert.deepEqual(toPam.changed, ['x']);
  const unknownTarget = L.applyReplied(doc, 'x', 'r1', T0 + 2, 'dwight-1');
  assert.deepEqual(unknownTarget.changed, ['x'], 'no recipient match: the exact id');
  const second = L.applyReplied(unknownTarget.doc, 'x', 'r2', T0 + 3);
  assert.deepEqual(second.changed, ['fresh'], 'then the next open alias');
  assert.equal(L.applyReplied(second.doc, 'x', 'r3', T0 + 4).changed.length, 0);
});

test('pending and backlog use arrival order, never id order (#18)', () => {
  let doc = L.emptyLedger('jim-1');
  for (const id of ['zz', 'aa', 'mm']) doc = L.applyDelivered(doc, msg(id), T0).doc;
  assert.deepEqual(L.pendingEntries(doc).map((e) => e.id), ['zz', 'aa', 'mm']);
  doc = L.applyClaimSurfacing(doc, ['aa'], 'e', 'UserPromptSubmit', T0).doc;
  assert.deepEqual(L.pendingEntries(doc).map((e) => e.id), ['zz', 'mm']);
  assert.deepEqual(L.backlogEntries(doc).map((e) => e.id), ['zz', 'aa', 'mm'], 'surfacing is still backlog');
});

test('pruning drops acted entries older than 7 days only', () => {
  let doc = L.emptyLedger('jim-1');
  for (const id of ['old', 'young', 'waiting']) doc = L.applyDelivered(doc, msg(id), T0).doc;
  doc = L.applyClaimSurfacing(doc, ['old'], 'e', 'UserPromptSubmit', T0).doc;
  doc = L.applyConfirmSurfaced(doc, ['old'], 'e', 'evidence', T0).doc;
  doc = L.applyCloseEpoch(doc, 'e', 'normal', T0).doc;
  doc = L.applyClaimSurfacing(doc, ['young'], 'f', 'UserPromptSubmit', T0 + 6 * DAY).doc;
  doc = L.applyConfirmSurfaced(doc, ['young'], 'f', 'evidence', T0 + 6 * DAY).doc;
  doc = L.applyCloseEpoch(doc, 'f', 'normal', T0 + 6 * DAY).doc;
  const s = L.applyPrune(doc, T0 + 7 * DAY + 1);
  assert.deepEqual(Object.keys(s.doc.entries).sort(), ['waiting', 'young']);
  assert.equal(s.logs.length, 0);
  assert.equal(L.applyPrune(s.doc, T0 + 7 * DAY + 2).changed.length, 0);
});

// ————————————————————————————————————————————————— pure: ids and admission

test('isValidMailId: the §4.1 regex, no "..", no reserved names', () => {
  for (const ok of ['2026-09-28T10-00-00-000Z-abc123', 'a', 'A.b_c-d', 'x'.repeat(128), 'msg.v2']) assert.equal(L.isValidMailId(ok), true, ok);
  for (const bad of ['', '../x', '..\\x', 'a/b', 'a\\b', 'a..b', '.done', '.hidden', 'x'.repeat(129), 'a b', 'a:b',
    'x.tmp', 'x.TMP', 'x.json.tmp-abc123', 'CON', 'con.json', 'nul', 'COM1', 'lpt9.txt', 'trailing.', '-lead', '_lead', 42, null, undefined, { id: 'x' }]) {
    assert.equal(L.isValidMailId(bad), false, JSON.stringify(bad));
  }
  const fresh = L.freshMailId(T0);
  assert.equal(L.isValidMailId(fresh), true);
  assert.match(fresh, /^2026-09-28T10-00-00-000Z-[0-9a-f]{6}$/);
});

test('classifyIncoming: free, duplicate (id or alias), conflict (ledger, file, unreadable)', () => {
  let doc = L.applyDelivered(L.emptyLedger('jim-1'), msg('m1'), T0).doc;
  doc = L.applyDelivered(doc, msg('fresh-1', { sender_id: 'orig', body: 'aliased' }), T0).doc;
  const none = () => null;
  assert.deepEqual(L.classifyIncoming(doc, msg('m2'), none), { kind: 'free' });
  assert.deepEqual(L.classifyIncoming(doc, msg('m1'), none), { kind: 'dup', existingId: 'm1' });
  assert.deepEqual(L.classifyIncoming(doc, msg('m1', { body: 'changed' }), none), { kind: 'conflict', reason: 'ledger' });
  assert.deepEqual(L.classifyIncoming(doc, msg('m1', { from: 'other-agent' }), none), { kind: 'conflict', reason: 'ledger' }, 'same body, other sender');
  assert.deepEqual(L.classifyIncoming(doc, msg('orig', { body: 'aliased' }), none), { kind: 'dup', existingId: 'fresh-1' }, 'a resend of a reassigned id is a duplicate');
  assert.deepEqual(L.classifyIncoming(doc, msg('orig', { body: 'new' }), none), { kind: 'conflict', reason: 'ledger' });
  // Files in inbox/ or .done/ that the ledger no longer knows (pruned, pre-ledger history).
  const onDisk = (m) => (id) => (id === 'old' ? m : null);
  assert.deepEqual(L.classifyIncoming(doc, msg('old'), onDisk({ from: 'god-1', body: 'body of old' })), { kind: 'dup', existingId: 'old' });
  assert.deepEqual(L.classifyIncoming(doc, msg('old'), onDisk({ from: 'god-1', body: 'different' })), { kind: 'conflict', reason: 'file' });
  assert.deepEqual(L.classifyIncoming(doc, msg('old'), onDisk('unreadable')), { kind: 'conflict', reason: 'unreadable' });
});

// ————————————————————————————————————————————————— pure: rebuild

test('rebuildLedger: conservative, from log rows + filesystem, never empty', () => {
  const rows = [
    { ts: T0, kind: 'mail', agentId: 'jim-1', stage: 'delivered', id: 'in-seen', from: 'god-1', act: 'request', requiresReply: true },
    { ts: T0 + 1, kind: 'mail', agentId: 'jim-1', stage: 'surfaced', ids: ['in-seen'], epoch: 'e' },
    { ts: T0 + 2, kind: 'mail', agentId: 'jim-1', stage: 'delivered', id: 'in-fresh', from: 'god-1', act: 'inform', requiresReply: false },
    { ts: T0 + 3, kind: 'mail', agentId: 'jim-1', stage: 'replied', id: 'done-q', replyId: 'rep-1' },
    { ts: T0 + 4, kind: 'mail', agentId: 'jim-1', stage: 'acted', ids: ['wo-1'], via: 'work-order', from: 'god-1', act: 'request', requiresReply: true },
    { ts: T0 + 5, kind: 'mail', agentId: 'someone-else', stage: 'surfaced', ids: ['in-fresh'] },
    { ts: T0 + 6, kind: 'message', id: 'in-legacy' },
    'garbage', null
  ];
  const file = (id, m, mtimeMs) => ({ id, msg: m, mtimeMs });
  const doc = L.rebuildLedger('jim-1', {
    inbox: [
      file('in-seen', msg('in-seen', { act: 'request' }), T0),
      file('in-fresh', msg('in-fresh'), T0 + 2),
      file('in-legacy', msg('in-legacy'), T0 - 5),
      file('in-broken', null, T0 + 3)
    ],
    done: [
      file('done-q', msg('done-q', { act: 'query' }), T0 + 1),
      file('done-ancient', msg('done-ancient'), T0 - 30 * DAY)
    ],
    logRows: rows
  }, T0 + 10);
  const e = doc.entries;
  assert.deepEqual(Object.keys(e).sort(), ['done-q', 'in-broken', 'in-fresh', 'in-legacy', 'in-seen', 'wo-1']);
  assert.equal(e['in-seen'].state, 'delivered');
  assert.equal(e['in-seen'].redelivered, true, 'surfaced before the corruption: re-delivered marker');
  assert.equal(e['in-seen'].legacy, false);
  assert.equal(e['in-fresh'].redelivered, false, "another agent's rows do not count");
  assert.equal(e['in-legacy'].legacy, true, 'no delivered row: cannot prove it was not handled');
  assert.equal(e['in-broken'].state, 'delivered', 'an unparseable file is still mail');
  assert.equal(e['done-q'].state, 'acted');
  assert.equal(e['done-q'].repliedAt, T0 + 3);
  assert.equal(e['wo-1'].via, 'work-order');
  assert.deepEqual(L.pendingEntries(doc).map((x) => x.id), ['in-legacy', 'in-seen', 'in-fresh', 'in-broken'], 'mtime order');
  assert.ok(L.validLedgerDoc(doc, 'jim-1'));
  assert.ok(doc.nextSeq > 6);
});

// ————————————————————————————————————————————————— the I/O shell

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-ledger-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  const inbox = (a) => path.join(root, 'agents', a, 'inbox');
  fs.mkdirSync(path.join(inbox('jim-1'), '.done'), { recursive: true });
  let now = T0;
  const timers = [];
  const logs = [];
  const logRows = [];
  const make = () => new L.MailLedger({
    root: () => root,
    appendLog: (r) => { logs.push(r); logRows.push({ ts: now, ...r }); },
    readLogRows: () => logRows,
    clock: () => now,
    setTimer: (fn, ms) => { const h = { fn, at: now + ms, ms, dead: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.dead = true; }
  });
  return {
    root, inbox, logs, timers, make,
    ledgerFile: (a) => path.join(root, 'state', 'mail', `${a}.json`),
    advance(ms) { now += ms; },
    get now() { return now; },
    /** Fire every live timer that is due. */
    tick() {
      let fired = 0;
      for (const h of timers.splice(0)) {
        if (h.dead) continue;
        if (h.at <= now) { h.dead = true; h.fn(); fired++; } else timers.push(h);
      }
      return fired;
    },
    live: () => timers.filter((h) => !h.dead),
    writeInbox(a, m, sub = '', mtimeMs = now) {
      const f = path.join(inbox(a), sub, `${m.id}.json`);
      fs.writeFileSync(f, JSON.stringify(m));
      fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
    },
    /** The router's order: admit (loads the ledger), durable inbox write, then delivered. */
    deliver(ml, m, a = 'jim-1') {
      const r = ml.admit(a, m);
      assert.equal(r.duplicate, false);
      this.writeInbox(a, r.msg);
      ml.markDelivered(a, r.msg);
    }
  };
}

const readLedger = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('writes are coalesced (≤ 1 per 250 ms per agent), atomic, and flushAll writes at once', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  ml.markDelivered('jim-1', msg('a'));
  // The first load created the ledger (migration of an empty inbox): one timer, due now.
  assert.equal(s.live().length, 1);
  ml.markDelivered('jim-1', msg('b'));
  ml.markDelivered('jim-1', msg('c'));
  assert.equal(s.live().length, 1, 'three changes, one pending write');
  assert.equal(fs.existsSync(s.ledgerFile('jim-1')), false, 'nothing written before the timer');
  assert.equal(s.tick(), 1);
  assert.deepEqual(Object.keys(readLedger(s.ledgerFile('jim-1')).entries).sort(), ['a', 'b', 'c']);
  // A change right after a write waits for the rest of the 250 ms window.
  s.advance(100);
  ml.markDelivered('jim-1', msg('d'));
  assert.equal(s.live()[0].ms, 150);
  assert.equal(s.tick(), 0, 'not yet due');
  s.advance(150);
  assert.equal(s.tick(), 1);
  assert.ok(readLedger(s.ledgerFile('jim-1')).entries.d);
  // Quit: flushAll writes immediately, no timer needed.
  ml.markDelivered('jim-1', msg('e'));
  ml.flushAll();
  assert.ok(readLedger(s.ledgerFile('jim-1')).entries.e);
  assert.deepEqual(fs.readdirSync(path.dirname(s.ledgerFile('jim-1'))), ['jim-1.json'], 'no temp files left behind');
});

test('no ledger is created for a name that is not an agent, and none for a removed hive', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  assert.deepEqual(ml.markReplied('system', 'x', 'y'), []);
  assert.deepEqual(ml.pending('ghost'), []);
  assert.throws(() => ml.markDelivered('ghost', msg('a')), /no agent/);
  assert.throws(() => ml.markDelivered('../jim-1', msg('a')), /invalid agent id/);
  assert.equal(fs.existsSync(path.join(s.root, 'state')), false);
  ml.markDelivered('jim-1', msg('a'));
  fs.rmSync(s.root, { recursive: true, force: true });
  s.tick();
  assert.equal(fs.existsSync(s.root), false, 'a timer never re-creates a deleted hive');
});

test('acted: the ledger is written first, then the harness moves the file to .done', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  s.deliver(ml, msg('m1'));
  const seen = [];
  ml.subscribe((ev) => seen.push(`${ev.stage}:${ev.id}`));
  assert.deepEqual(ml.claimSurfacing('jim-1', ['m1'], 'e1', 'UserPromptSubmit'), ['m1']);
  assert.deepEqual(ml.confirmSurfaced('jim-1', ['m1'], 'e1'), ['m1']);
  assert.deepEqual(ml.closeEpoch('jim-1', 'e1', 'normal'), { acted: ['m1'], redelivered: [] });
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), 'm1.json')), 'the rename waits for the ledger write');
  s.tick();
  assert.equal(readLedger(s.ledgerFile('jim-1')).entries.m1.state, 'acted');
  assert.ok(!fs.existsSync(path.join(s.inbox('jim-1'), 'm1.json')));
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), '.done', 'm1.json')));
  assert.deepEqual(seen, ['surfacing:m1', 'surfaced:m1', 'acted:m1']);
  assert.equal(ml.lastActedAt('jim-1'), s.now);
});

test('a failed .done rename retries only the rename, logged once; the ledger stays authoritative', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  s.deliver(ml, msg('m1'));
  ml.claimSurfacing('jim-1', ['m1'], 'e1', 'UserPromptSubmit');
  ml.confirmSurfaced('jim-1', ['m1'], 'e1');
  ml.closeEpoch('jim-1', 'e1', 'normal');
  // Block the rename: .done is a FILE, not a directory.
  const done = path.join(s.inbox('jim-1'), '.done');
  fs.rmSync(done, { recursive: true, force: true });
  fs.writeFileSync(done, 'in the way');
  s.tick();
  assert.equal(readLedger(s.ledgerFile('jim-1')).entries.m1.state, 'acted', 'the ledger records acted regardless');
  assert.equal(s.logs.filter((r) => r.kind === 'mail-archive-failed').length, 1);
  assert.equal(s.live().length, 1, 'a retry is scheduled');
  s.advance(1_000);
  s.tick();
  assert.equal(s.logs.filter((r) => r.kind === 'mail-archive-failed').length, 1, 'logged once per id');
  assert.equal(s.live()[0].ms, 2_000, 'backoff');
  fs.rmSync(done);
  s.advance(2_000);
  s.tick();
  assert.ok(fs.existsSync(path.join(done, 'm1.json')), 'the retry completed the rename');
  assert.equal(s.live().length, 0);
  assert.equal(ml.pending('jim-1').length, 0, 'never re-surfaced');
});

test('restart: a crash between the ledger write and the rename finishes the rename; open epochs re-pend', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  for (const id of ['acted-1', 'open-1', 'open-2']) s.deliver(ml, msg(id));
  ml.claimSurfacing('jim-1', ['acted-1', 'open-1'], 'e1', 'UserPromptSubmit');
  ml.confirmSurfaced('jim-1', ['acted-1', 'open-1'], 'e1');
  ml.markActed('jim-1', ['acted-1'], 'e1');
  ml.claimSurfacing('jim-1', ['open-2'], 'e2', 'PostToolUse');
  // "Crash": write the ledger but do NOT run the archive (bypass flushState's rename).
  fs.mkdirSync(path.dirname(s.ledgerFile('jim-1')), { recursive: true });
  fs.writeFileSync(s.ledgerFile('jim-1'), JSON.stringify(ml.ledger('jim-1')));
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), 'acted-1.json')));

  const again = s.make();
  const doc = again.ledger('jim-1');
  assert.equal(doc.entries['acted-1'].state, 'acted', 'no re-wake for acted mail');
  for (const id of ['open-1', 'open-2']) {
    assert.equal(doc.entries[id].state, 'delivered');
    assert.equal(doc.entries[id].redelivered, true);
  }
  assert.deepEqual(again.pending('jim-1').map((e) => e.id), ['open-1', 'open-2']);
  again.flushAll();
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), '.done', 'acted-1.json')), 'rename completed');
  assert.ok(!fs.existsSync(path.join(s.inbox('jim-1'), 'acted-1.json')));
});

test('restart: an inbox file the ledger missed (crash before its write) is recovered as delivered', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  s.deliver(ml, msg('known'));
  ml.flushAll();
  s.writeInbox('jim-1', msg('missed'));
  const again = s.make();
  assert.deepEqual(again.pending('jim-1').map((e) => [e.id, e.legacy]), [['known', false], ['missed', false]]);
  assert.ok(s.logs.some((r) => r.kind === 'mail' && r.stage === 'delivered' && r.id === 'missed' && r.reason === 'recovered'));
});

test('first run (no ledger): inbox files become delivered legacy; .done is not imported', (t) => {
  const s = sandbox(t);
  s.writeInbox('jim-1', msg('old-1'));
  s.writeInbox('jim-1', msg('old-2', { act: 'request' }));
  s.writeInbox('jim-1', msg('history'), '.done');
  const ml = s.make();
  const pend = ml.pending('jim-1');
  assert.deepEqual(pend.map((e) => e.id).sort(), ['old-1', 'old-2']);
  assert.ok(pend.every((e) => e.legacy === true));
  assert.equal(ml.ledger('jim-1').entries.history, undefined);
  assert.deepEqual(s.logs.filter((r) => r.kind === 'mail-ledger-migrated').map((r) => r.imported), [2]);
  assert.equal(s.logs.filter((r) => r.kind === 'mail').length, 0, 'the import writes no per-message rows');
  ml.flushAll();
  // Idempotent: a second boot reads the ledger, no second import.
  const again = s.make();
  again.pending('jim-1');
  assert.equal(s.logs.filter((r) => r.kind === 'mail-ledger-migrated').length, 1);
});

test('a corrupt ledger: logged, quarantined, rebuilt from log + filesystem, surfaced as an integrity issue', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  for (const id of ['seen', 'unseen']) s.deliver(ml, msg(id));
  ml.claimSurfacing('jim-1', ['seen'], 'e1', 'UserPromptSubmit');
  ml.confirmSurfaced('jim-1', ['seen'], 'e1');
  s.writeInbox('jim-1', msg('handled'), '.done');
  ml.flushAll();
  const good = fs.readFileSync(s.ledgerFile('jim-1'), 'utf8');
  fs.writeFileSync(s.ledgerFile('jim-1'), good.slice(0, Math.floor(good.length / 2))); // F3: truncated

  s.advance(1_000);
  const again = s.make();
  const doc = again.ledger('jim-1');
  assert.deepEqual(Object.keys(doc.entries).sort(), ['handled', 'seen', 'unseen'], 'never an empty ledger');
  assert.equal(doc.entries.seen.state, 'delivered');
  assert.equal(doc.entries.seen.redelivered, true);
  assert.equal(doc.entries.unseen.redelivered, false);
  assert.equal(doc.entries.handled.state, 'acted');
  const corrupt = s.logs.filter((r) => r.kind === 'mail-ledger-corrupt');
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].rebuiltEntries, 3);
  const dir = path.dirname(s.ledgerFile('jim-1'));
  const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith('jim-1.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8'), good.slice(0, Math.floor(good.length / 2)), 'the bad bytes are kept');
  assert.deepEqual(again.integrityIssues().map((i) => [i.file, i.quarantine, i.repaired]), [['state/mail/jim-1.json', quarantined[0], true]]);
  again.flushAll();
  assert.ok(L.validLedgerDoc(readLedger(s.ledgerFile('jim-1')), 'jim-1'), 'the rebuilt ledger is written back');
});

test('a structurally invalid ledger (valid JSON) is corrupt too', (t) => {
  const s = sandbox(t);
  s.writeInbox('jim-1', msg('m'));
  fs.mkdirSync(path.dirname(s.ledgerFile('jim-1')), { recursive: true });
  fs.writeFileSync(s.ledgerFile('jim-1'), JSON.stringify({ version: 1, agentId: 'jim-1', nextSeq: 1, entries: [] }));
  const ml = s.make();
  assert.deepEqual(ml.pending('jim-1').map((e) => e.id), ['m']);
  assert.equal(s.logs.filter((r) => r.kind === 'mail-ledger-corrupt')[0].error, 'invalid ledger structure');
});

test('pruning runs on write: acted entries older than 7 days leave the ledger file', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  for (const id of ['a', 'b']) s.deliver(ml, msg(id));
  ml.claimSurfacing('jim-1', ['a'], 'e', 'UserPromptSubmit');
  ml.confirmSurfaced('jim-1', ['a'], 'e');
  ml.closeEpoch('jim-1', 'e', 'normal');
  ml.flushAll();
  assert.ok(readLedger(s.ledgerFile('jim-1')).entries.a);
  s.advance(7 * DAY + 1);
  ml.markDelivered('jim-1', msg('c'));
  ml.flushAll();
  assert.deepEqual(Object.keys(readLedger(s.ledgerFile('jim-1')).entries).sort(), ['b', 'c']);
});

test('a failed ledger write holds the .done rename back and retries the write (logged once)', (t) => {
  const s = sandbox(t);
  const ml = s.make();
  s.deliver(ml, msg('m1'));
  ml.flushAll();
  ml.claimSurfacing('jim-1', ['m1'], 'e1', 'UserPromptSubmit');
  ml.confirmSurfaced('jim-1', ['m1'], 'e1');
  ml.closeEpoch('jim-1', 'e1', 'normal');
  // Make the publish fail: the ledger path is a directory.
  fs.rmSync(s.ledgerFile('jim-1'));
  fs.mkdirSync(path.join(s.ledgerFile('jim-1'), 'blocker'), { recursive: true });
  s.advance(1_000);
  s.tick();
  assert.equal(s.logs.filter((r) => r.kind === 'mail-ledger-write-failed').length, 1);
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), 'm1.json')), 'no rename before the ledger that records acted is durable');
  assert.equal(s.live().length, 1, 'the write is retried');
  s.advance(250);
  s.tick();
  assert.equal(s.logs.filter((r) => r.kind === 'mail-ledger-write-failed').length, 1, 'logged once');
  fs.rmSync(s.ledgerFile('jim-1'), { recursive: true, force: true });
  s.advance(250);
  s.tick();
  assert.equal(readLedger(s.ledgerFile('jim-1')).entries.m1.state, 'acted');
  assert.ok(fs.existsSync(path.join(s.inbox('jim-1'), '.done', 'm1.json')));
});
