'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 4b (god's rulings after Jim's re-check):
 *  (a) mutant K13: the wake coordinator's pending source that index.ts wires is the REAL rule
 *      (mailReaders.coordinatorPendingIds), tested here, not a copy;
 *  (b) Q15: a delivered message whose body is in NEITHER inbox/ nor inbox/.done/ is closed
 *      terminally (acted, reason "body-missing"), persisted across restarts, never pending, never
 *      backlog, never a wake; an open obligation stays open, flagged missing; the file coming back
 *      into inbox/ is a new delivered transition.
 * Zero model tokens. HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-q15-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');
const L = loadTs('src/main/mailLedger.ts');
const R = loadTs('src/main/mailReaders.ts');

// ── (a) K13 ───────────────────────────────────────────────────────────────────────────────────

const deps = (over = {}) => ({
  mode: () => 'inject',
  pending: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  skipped: () => ['b'],
  files: () => ['f1', 'f2'],
  ...over
});

test('K13: inject / legacy-read agents: the ledger\'s delivered ids in order, MINUS the skipped (unshowable) ids', () => {
  assert.deepEqual(R.coordinatorPendingIds('x', deps()), ['a', 'c']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ mode: () => 'legacy-read' })), ['a', 'c']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ skipped: () => [] })), ['a', 'b', 'c']);
});

test('K13: legacy-move and work-order agents keep 1.1.74 file semantics; a failing ledger falls back to the files', () => {
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ mode: () => 'legacy-move' })), ['f1', 'f2']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ mode: () => 'work-order' })), ['f1', 'f2']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ pending: () => { throw new Error('ledger'); } })), ['f1', 'f2']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ skipped: () => { throw new Error('hooks'); } })), ['f1', 'f2']);
  assert.deepEqual(R.coordinatorPendingIds('x', deps({ mode: () => 'legacy-move', files: () => ['ok', '', undefined, 7] })), ['ok']);
});

// ── (b) Q15, pure ─────────────────────────────────────────────────────────────────────────────

const msg = (id, extra = {}) => ({ id, from: 'god-1', act: 'inform', subject: `s-${id}`, body: `b-${id}`, ...extra });

test('Q15 pure: delivered -> acted with missingAt/missingReason; one loud row; no archive; NOT activity', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, msg('m1'), 1000).doc;
  const before = { act: doc.lastActivityAt, acted: doc.lastActedAt };
  const step = L.applyBodyMissing(doc, 'm1', 'missing', 5000);
  const e = step.doc.entries.m1;
  assert.deepEqual([e.state, e.missingAt, e.missingReason, e.actedAt], ['acted', 5000, 'missing', 5000]);
  assert.deepEqual(step.archive, [], 'there is no file to move');
  assert.deepEqual(step.logs, [{ agentId: 'andy-1', kind: 'mail', stage: 'acted', ids: ['m1'], reason: 'body-missing', why: 'missing' }]);
  assert.equal(step.events[0].harness, true);
  assert.deepEqual({ act: step.doc.lastActivityAt, acted: step.doc.lastActedAt }, before, 'the harness closed it, no agent did');
  assert.deepEqual(L.pendingEntries(step.doc), []);
  assert.deepEqual(L.backlogEntries(step.doc), []);
});

test('Q15 pure: only a DELIVERED inbox entry is closed; surfacing/surfaced/acted/work-order entries are left alone', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, msg('d'), 1).doc;
  doc = L.applyDelivered(doc, msg('s'), 1).doc;
  doc = L.applyClaimSurfacing(doc, ['s'], 'e1', 'UserPromptSubmit', 2).doc;
  doc = L.applyWorkOrder(doc, msg('w'), 3).doc;
  for (const id of ['s', 'w', 'nope']) assert.deepEqual(L.applyBodyMissing(doc, id, 'missing', 9).changed, [], id);
  const once = L.applyBodyMissing(doc, 'd', 'missing', 9).doc;
  assert.deepEqual(L.applyBodyMissing(once, 'd', 'missing', 10).changed, [], 'idempotent');
});

test('Q15 pure: an open obligation stays open (awaitingReply / openRequests), flagged missing in fleet.json', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, msg('r1', { act: 'request' }), 1).doc;
  doc = L.applyDelivered(doc, msg('q1', { act: 'query', requires_reply: true }), 2).doc;
  doc = L.applyBodyMissing(doc, 'r1', 'missing', 3).doc;
  doc = L.applyBodyMissing(doc, 'q1', 'missing', 3).doc;
  assert.deepEqual(L.openRequestEntries(doc, 10).map((o) => o.entry.id), ['r1']);
  assert.deepEqual(L.awaitingReplyEntries(doc, 10).map((o) => o.entry.id), ['r1', 'q1']);
  assert.deepEqual(L.applyPrune(doc, 3 + 30 * 86_400_000).changed, [], 'never pruned while owed (§11.18 #1)');
  const ledger = {
    backlog: () => L.backlogEntries(doc), awaitingReply: () => L.awaitingReplyEntries(doc, 10), openRequests: () => L.openRequestEntries(doc, 10)
  };
  const f = R.fleetMailFields(ledger, 'andy-1');
  assert.equal(f.inboxBacklog, 0);
  assert.deepEqual(f.openRequests.map((o) => [o.id, o.missing]), [['r1', true]]);
  assert.ok(f.awaitingReply.every((o) => o.missing === true));
  assert.equal(R.actionableBacklog(ledger, 'andy-1'), 0, 'readers #9/#13 never count it');
});

test('Q15 pure: reappearing is a NEW delivered transition (row reason "reappeared"); only for a missing entry', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, msg('m1'), 1).doc;
  doc = L.applyDelivered(doc, msg('m2'), 1).doc;
  doc = L.applyBodyMissing(doc, 'm1', 'missing', 2).doc;
  const back = L.applyReappeared(doc, 'm1', 3);
  assert.deepEqual([back.doc.entries.m1.state, back.doc.entries.m1.missingAt], ['delivered', null]);
  assert.equal(back.logs[0].stage, 'delivered');
  assert.equal(back.logs[0].reason, 'reappeared');
  assert.deepEqual(L.pendingEntries(back.doc).map((e) => e.id), ['m1', 'm2'], 'arrival order kept');
  assert.deepEqual(L.applyReappeared(doc, 'm2', 3).changed, [], 'a delivered entry is not "reappeared"');
});

// ── (b) Q15, persisted across a restart, through the real hive ───────────────────────────────

test('Q15: the terminal close is PERSISTED: after a restart it is still acted/missing, not pending, so nothing wakes', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  let hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const lost = hive.send({ to: 'andy-1', act: 'request', subject: 'lost', body: 'x' }, 'god-1');
  const kept = hive.send({ to: 'andy-1', act: 'inform', subject: 'kept', body: 'y' }, 'god-1');
  const inbox = path.join(hive.root(), 'agents', 'andy-1', 'inbox');
  const saved = fs.readFileSync(path.join(inbox, `${lost.id}.json`), 'utf8');
  fs.rmSync(path.join(inbox, `${lost.id}.json`));
  assert.equal(hive.mailBody('andy-1', lost.id).reason, 'missing');
  assert.equal(hive.mail.bodyMissing('andy-1', lost.id, 'missing'), true);
  hive.dispose();
  // Restart.
  hive = new HiveManager(() => home, () => true);
  const e = hive.mail.ledger('andy-1').entries[lost.id];
  assert.deepEqual([e.state, typeof e.missingAt], ['acted', 'number']);
  assert.deepEqual(hive.mail.pending('andy-1').map((x) => x.id), [kept.id], 'restart recovery does not re-pend it');
  assert.equal(hive.inboxBacklog('andy-1'), 1);
  assert.deepEqual(hive.mail.openRequests('andy-1').map((o) => o.entry.id), [lost.id], 'still owed');
  // The file comes back while the app is down: the load redelivers it (never archives it).
  hive.dispose();
  fs.writeFileSync(path.join(inbox, `${lost.id}.json`), saved);
  hive = new HiveManager(() => home, () => true);
  assert.equal(hive.mail.ledger('andy-1').entries[lost.id].state, 'delivered');
  hive.mail.flush('andy-1');
  assert.ok(fs.existsSync(path.join(inbox, `${lost.id}.json`)), 'not moved into .done');
  assert.deepEqual(hive.mail.pending('andy-1').map((x) => x.id).sort(), [kept.id, lost.id].sort());
});

test('Q15/Q28 wiring: the hook reader closes a MISSING body terminally; an unparseable one is counted (Q28) and skipped meanwhile', () => {
  const { readSource, codeOnly } = require('./read-source.cjs');
  const hooks = codeOnly(readSource('src/main/hooks.ts'), 'hooks.ts');
  const body = hooks.slice(hooks.indexOf('private readMailBody('), hooks.indexOf('private mailReminders('));
  assert.match(body, /if \(got\.reason === 'missing'\) \{[\s\S]*?this\.hive\.mail\?\.bodyMissing\(agentId, id, 'missing'\)[\s\S]*?if \(closed\) return null;/);
  assert.match(body, /noteBodyMissing\(agentId, id, got\.reason\)/, 'the row and the banner stay');
  // Creed Q28 (updated: it used to be skipped only): counted in the ledger, closed at the third.
  assert.match(body, /if \(got\.reason === 'unreadable'\) \{[\s\S]*?this\.hive\.mail\?\.parseFailed\(agentId, id\)[\s\S]*?if \(r === 'closed'\)/);
});

// ── Q28 (Creed): an UNPARSEABLE body closes terminally after 3 failures spanning >= 60 s ────────

test('Q28 pure: 3 failed parses spanning >= 60 s close it (acted, body-unparseable, rows); fewer, or faster, only count; a changed file restarts the count', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, msg('u', { act: 'request' }), 1).doc;
  const before = { act: doc.lastActivityAt, acted: doc.lastActedAt };
  let s = L.applyParseFailed(doc, 'u', '10:1', 1_000);
  assert.deepEqual([s.doc.entries.u.state, s.doc.entries.u.parseFails, s.logs], ['delivered', 1, []], 'a count writes no row');
  s = L.applyParseFailed(s.doc, 'u', '10:1', 31_000);
  s = L.applyParseFailed(s.doc, 'u', '10:1', 60_999);
  assert.deepEqual([s.doc.entries.u.state, s.doc.entries.u.parseFails], ['delivered', 3], '3 failures inside 60 s: not yet');
  // A changed file (size:mtime) starts again.
  const reset = L.applyParseFailed(s.doc, 'u', '11:2', 61_000);
  assert.deepEqual([reset.doc.entries.u.parseFails, reset.doc.entries.u.parseFailSince], [1, 61_000]);
  s = L.applyParseFailed(s.doc, 'u', '10:1', 61_000);
  const e = s.doc.entries.u;
  assert.deepEqual([e.state, e.missingReason, e.parseFails, typeof e.missingAt], ['acted', 'unparseable', 4, 'number']);
  assert.deepEqual(s.archive, [], 'the file stays where it is');
  assert.deepEqual(s.logs.map((r) => [r.kind, r.reason ?? null]), [['mail', 'body-unparseable'], ['mail-body-unparseable', null]]);
  assert.equal(s.logs[1].spanMs, 60_000);
  assert.equal(s.events[0].harness, true);
  assert.deepEqual({ act: s.doc.lastActivityAt, acted: s.doc.lastActedAt }, before, 'not activity');
  assert.deepEqual(L.pendingEntries(s.doc), []);
  assert.deepEqual(L.backlogEntries(s.doc), []);
  assert.deepEqual(L.openRequestEntries(s.doc, 70_000).map((o) => o.entry.id), ['u'], 'still owed; fleet flags it missing');
  assert.deepEqual(L.applyParseFailed(s.doc, 'u', '10:1', 99_000).changed, [], 'only a delivered entry counts');
});

test('Q28: persisted through a restart (no wake), with the banner; redelivered only when the file CHANGES and then parses', async (t) => {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  let hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const m = hive.send({ to: 'andy-1', act: 'inform', subject: 'garbled', body: 'x' }, 'god-1');
  const file = path.join(hive.root(), 'agents', 'andy-1', 'inbox', `${m.id}.json`);
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ not json');
  let now = Date.now();
  hive.mail.now = () => now;
  assert.equal(hive.mail.parseFailed('andy-1', m.id), 'counted');
  now += 30_000;
  assert.equal(hive.mail.parseFailed('andy-1', m.id), 'counted');
  now += 30_000;
  assert.equal(hive.mail.parseFailed('andy-1', m.id), 'closed');
  assert.ok(hive.integrityIssues().some((i) => i.error === 'mail-body-unparseable' && i.notice), 'the banner');
  assert.equal(hive.logTail(200).filter((r) => r.kind === 'mail-body-unparseable').length, 1);
  assert.deepEqual(hive.mail.pending('andy-1'), []);
  hive.dispose();
  // Restart: still closed, nothing pending, the file is NOT archived.
  hive = new HiveManager(() => home, () => true);
  assert.deepEqual([hive.mail.ledger('andy-1').entries[m.id].state, hive.mail.ledger('andy-1').entries[m.id].missingReason], ['acted', 'unparseable']);
  assert.deepEqual(hive.mail.pending('andy-1'), [], 'no restart wake (Jim follow-up 3)');
  hive.mail.flush('andy-1');
  assert.ok(fs.existsSync(file), 'not moved into .done');
  // The beat's reconcile: an unchanged file is not "reappeared" (unlike a missing body) ...
  assert.deepEqual(hive.mail.reconcileInbox('andy-1').reappeared, []);
  // ... a changed file that still does not parse is not either ...
  fs.writeFileSync(file, '{ still not json at all');
  assert.deepEqual(hive.mail.reconcileInbox('andy-1').reappeared, []);
  // ... a repaired file is a new delivered transition.
  fs.writeFileSync(file, saved);
  assert.deepEqual(hive.mail.reconcileInbox('andy-1').reappeared, [m.id]);
  const e = hive.mail.ledger('andy-1').entries[m.id];
  assert.deepEqual([e.state, e.missingAt, e.parseFails], ['delivered', null, 0]);
});
