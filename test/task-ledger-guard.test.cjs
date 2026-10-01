'use strict';

/**
 * ZT-I3 §3.1: the task-ledger guard watches tasks.json and NEVER writes it. It keeps the
 * per-card sidecar (state/task-meta.json): statusSince, lastEditAt, lastEditBy, history.
 * Every check is driven by calling `check()` directly (no watcher, no timers): ordering is
 * constructed, never raced.
 *
 * Mutants that must die:
 *   M6  the guard rewrites tasks.json (e.g. drops the duplicate)
 *   M7  statusSince reset on a non-status edit
 *   M24 an API write attributed to 'file' (Jim C4)
 *   C4a a failed API write still recorded in the sidecar (Jim nit a)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { TaskLedgerGuard } = loadTs('src/main/taskLedgerGuard.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const card = (id, extra = {}) => ({ id, title: id, status: 'todo', dependsOn: [], priority: 3, ...extra });

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: 1_000_000 };
  const logs = [];
  const changes = [];
  const guard = new TaskLedgerGuard({
    root: () => root, agentIds: () => new Set(['jim']), appendLog: (r) => logs.push(r),
    now: () => clock.now, onChange: (c) => changes.push(c)
  });
  const write = (tasks) => fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }, null, 2));
  const meta = () => JSON.parse(fs.readFileSync(path.join(root, 'state', 'task-meta.json'), 'utf8'));
  return { root, clock, logs, changes, guard, write, meta };
}

test('first run: ages are bounded, not known, unless god wrote a timestamp', (t) => {
  const r = rig(t);
  r.write([card('A', { status: 'doing' }), card('B', { status: 'done', doneAt: '1970-01-01T00:00:00.500Z' })]);
  r.guard.check();
  const m = r.meta();
  assert.equal(m.v, 1);
  assert.deepEqual([m.cards.A.statusSince, m.cards.A.statusSinceExact, m.cards.A.lastEditBy], [1_000_000, false, 'install']);
  assert.deepEqual([m.cards.B.statusSince, m.cards.B.statusSinceExact], [500, true]);
});

test('a god file edit: status change stamps statusSince and history; a non-status edit does not (M7)', (t) => {
  const r = rig(t);
  r.write([card('A')]);
  r.guard.check();
  r.clock.now += 60_000;
  r.write([card('A', { status: 'doing' })]);
  const change = r.guard.check();
  assert.deepEqual(change.statusChanged, [{ id: 'A', from: 'todo', to: 'doing' }]);
  let a = r.meta().cards.A;
  assert.deepEqual([a.statusSince, a.statusSinceExact, a.lastEditBy, a.history.length], [1_060_000, true, 'file', 1]);
  r.clock.now += 60_000;
  r.write([card('A', { status: 'doing', title: 'renamed' })]);
  r.guard.check();
  a = r.meta().cards.A;
  assert.equal(a.statusSince, 1_060_000, 'a title edit is not a status change');
  assert.equal(a.lastEditAt, 1_120_000);
});

test('unchanged content is not a change; added and removed cards are seen', (t) => {
  const r = rig(t);
  r.write([card('A')]);
  r.guard.check();
  assert.equal(r.guard.check(), null);
  r.clock.now += 1;
  r.write([card('B')]);
  const change = r.guard.check();
  assert.deepEqual([change.added, change.removed], [['B'], ['A']]);
  assert.equal(r.meta().cards.B.statusSinceExact, true);
});

test('a duplicate made by a file edit: one log row, a notice, and tasks.json untouched (M6)', (t) => {
  const r = rig(t);
  r.write([card('A')]);
  r.guard.check();
  r.write([card('A', { status: 'done' }), card('A')]);
  r.guard.check();
  r.clock.now += 1;
  r.write([card('A', { status: 'done' }), card('A'), card('Z')]);
  const bytes = fs.readFileSync(path.join(r.root, 'tasks.json'));
  r.guard.check();
  assert.deepEqual(fs.readFileSync(path.join(r.root, 'tasks.json')), bytes);
  const invalid = r.logs.filter((l) => l.kind === 'task-ledger-invalid');
  assert.equal(invalid.length, 1, 'logged when the error appears, not on every check');
  assert.equal(invalid[0].by, 'file');
  assert.deepEqual(invalid[0].errors.map((e) => e.key), ['dup:A']);
  assert.match(r.guard.integrityNotice(), /duplicate id A/);
  // The first copy is the card the sidecar tracks.
  assert.equal(r.meta().cards.A.status, 'done');
});

test('the guard never writes tasks.json, even with errors in it (M6)', (t) => {
  const r = rig(t);
  r.write([card('A', { status: 'done' }), card('A'), card('S', { status: 'nope' })]);
  const before = fs.readFileSync(path.join(r.root, 'tasks.json'));
  r.guard.check();
  r.guard.check();
  assert.deepEqual(fs.readFileSync(path.join(r.root, 'tasks.json')), before);
  r.write([card('A')]);
  r.guard.check();
  assert.equal(r.guard.integrityNotice(), null, 'the notice clears when god fixes the file');
});

function hiveRig(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-guard-hive-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const file = path.join(hive.root(), 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks: [card('A'), card('B')] }, null, 2));
  hive.ledgerGuard.check();
  return { hive, file };
}

test('an API write is attributed to its source, and the watcher does not re-attribute it (M24)', (t) => {
  const { hive } = hiveRig(t);
  hive.patchTask('A', { status: 'doing' }, 'slack');
  assert.equal(hive.ledgerGuard.taskMeta().cards.A.lastEditBy, 'api:slack');
  assert.equal(hive.ledgerGuard.check(), null, 'the file holds exactly the bytes the API wrote');
  hive.patchTask('B', { status: 'doing' }, 'voice');
  hive.patchTask('B', { status: 'blocked' }, 'ipc');
  assert.equal(hive.ledgerGuard.check(), null, 'back-to-back API writes');
  const meta = hive.ledgerGuard.taskMeta().cards;
  assert.deepEqual([meta.A.lastEditBy, meta.B.lastEditBy], ['api:slack', 'api:ipc']);
  assert.deepEqual(meta.B.history.map((h) => `${h.from}>${h.to}@${h.by}`), ['todo>doing@api:voice', 'doing>blocked@api:ipc']);
});

test('a god edit right after an API write is attributed to file', (t) => {
  const { hive, file } = hiveRig(t);
  hive.patchTask('A', { status: 'doing' }, 'ipc');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.tasks[0].status = 'done';
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
  hive.ledgerGuard.check();
  assert.equal(hive.ledgerGuard.taskMeta().cards.A.lastEditBy, 'file');
});

test('a failed API write records nothing (Jim nit a)', (t) => {
  const { hive } = hiveRig(t);
  const before = hive.ledgerGuard.taskMeta();
  hive.atomicWriteJson = () => { throw new Error('disk full'); };
  assert.throws(() => hive.patchTask('A', { status: 'doing' }, 'ipc'), /disk full/);
  assert.deepEqual(hive.ledgerGuard.taskMeta(), before);
});

test('integrityIssues() carries a ledger error as a non-pausing notice', (t) => {
  const { hive, file } = hiveRig(t);
  fs.writeFileSync(file, JSON.stringify({ tasks: [card('A'), card('A')] }, null, 2));
  assert.equal(hive.integrityIssues().find((i) => i.file === 'tasks.json'), undefined,
    'Jim S1: the banner poll returns the CACHED result; it never re-reads the 1.85 MB ledger');
  hive.ledgerGuard.check(); // the watcher / poll / API write path
  const issue = hive.integrityIssues().find((i) => i.file === 'tasks.json');
  assert.ok(issue && issue.notice && /duplicate id A/.test(issue.notice));
  assert.equal(issue.quarantine, null);
});

test('a ledger with only warnings raises no notice, so a permanent warning never pins the banner (J11)', (t) => {
  const r = rig(t);
  const long = 'z'.repeat(90);
  r.write([card('A', { description: long }), card('B', { description: long, assignee: 'ghost' })]);
  r.guard.check();
  assert.equal(r.guard.issues().length, 2);
  assert.equal(r.guard.integrityNotice(), null);
});

test('the sidecar forgets removed cards and keeps at most HISTORY_KEEP status changes (J8, J9)', (t) => {
  const { HISTORY_KEEP } = loadTs('src/main/taskLedgerGuard.ts');
  const r = rig(t);
  r.write([card('A'), card('GONE')]);
  r.guard.check();
  for (let i = 0; i < HISTORY_KEEP + 5; i++) {
    r.clock.now += 1000;
    r.write([card('A', { status: i % 2 ? 'todo' : 'doing' })]);
    r.guard.check();
  }
  const m = r.meta();
  assert.deepEqual(Object.keys(m.cards), ['A']);
  assert.equal(m.cards.A.history.length, HISTORY_KEEP);
});

test('a status change found at app start is bounded, not exact (Jim S4)', (t) => {
  const r = rig(t);
  r.write([card('A')]);
  r.guard.check();
  r.write([card('A', { status: 'doing' })]); // changed while the app was closed
  const restarted = new TaskLedgerGuard({ root: () => r.root, agentIds: () => new Set(), appendLog: () => {}, now: () => r.clock.now + 5000 });
  restarted.check();
  const a = restarted.taskMeta().cards.A;
  assert.deepEqual([a.status, a.statusSinceExact], ['doing', false]);
});
