'use strict';

/**
 * ZT-I3 (Jim C1): API writes validate the CHANGE, not the file. A write is refused only if
 * it would INTRODUCE an error (a new duplicate id, an unknown status); then the file is left
 * byte-identical. An error a hand edit already put in the file is reported by the guard and
 * never blocks an unrelated UI, Slack, webhook, voice or auto-move write.
 *
 * Mutants that must die:
 *   M4  validate after the write (the refused write would already be on disk)
 *   M20 a pre-existing duplicate blocks an unrelated patchTask
 *   M21 validate the after-state only
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, TaskLedgerInvalidError } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-delta-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  return hive;
}
const tasksFile = (hive) => path.join(hive.root(), 'tasks.json');
const card = (id, extra = {}) => ({ id, title: id, status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-10-01T00:00:00.000Z', ...extra });
/** God's hand edit: write the file directly, outside every API. */
const handWrite = (hive, tasks) => fs.writeFileSync(tasksFile(hive), JSON.stringify({ tasks }, null, 2));
const log = (hive) => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8');

test('a duplicate already in the file does not block unrelated writes (M20, M21)', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('A', { status: 'done' }), card('B'), card('A')]);
  assert.equal(hive.patchTask('B', { status: 'doing' }, 'ipc'), true);
  assert.equal(hive.addTask(card('C'), 'slack'), true);
  assert.equal(hive.deleteTask('C', 'ipc'), true);
  const ids = hive.tasks().tasks.map((c) => `${c.id}:${c.status}`);
  assert.deepEqual(ids, ['A:done', 'B:doing', 'A:todo'], 'the hand-made duplicate is reported, never "fixed" by a write');
});

test('a write that INTRODUCES a duplicate is refused and the file is byte-identical (M4)', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('A'), card('B')]);
  const before = fs.readFileSync(tasksFile(hive));
  assert.throws(() => hive.writeTasks([card('A'), card('B'), card('A', { status: 'done' })], 'voice'), TaskLedgerInvalidError);
  assert.deepEqual(fs.readFileSync(tasksFile(hive)), before);
  assert.match(log(hive), /"kind":"task-ledger-refused","source":"voice","errors":\["dup:A"\]/);
});

test('a patch that introduces an unknown status is refused; the file is unchanged', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('A'), card('B')]);
  const before = fs.readFileSync(tasksFile(hive));
  assert.throws(() => hive.patchTask('A', { status: 'finished' }, 'ipc'), (e) => e instanceof TaskLedgerInvalidError && /status/.test(e.message));
  assert.deepEqual(fs.readFileSync(tasksFile(hive)), before);
});

test('an existing unknown status does not block a patch to that same card that fixes it', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('A', { status: 'finished' })]);
  assert.equal(hive.patchTask('A', { status: 'done' }, 'ipc'), true);
  assert.equal(hive.tasks().tasks[0].status, 'done');
});

test('every accepted write logs its source', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('A')]);
  hive.patchTask('A', { status: 'doing' }, 'slack');
  assert.match(log(hive), /"kind":"tasks","count":1,"source":"slack"/);
});

test('a hand-made twin is never rewritten by an unrelated write; patch and delete act on the FIRST copy (S2, J17)', (t) => {
  const hive = floor(t);
  handWrite(hive, [card('X', { status: 'done', result: 'R1', notes: 'first' }), card('Y'), card('X', { status: 'todo' })]);
  hive.patchTask('Y', { status: 'doing' }, 'ipc');
  let list = hive.tasks().tasks;
  assert.deepEqual(list[2], card('X', { status: 'todo' }), 'the twin keeps exactly its own fields');
  hive.patchTask('X', { notes: 'patched' }, 'ipc');
  list = hive.tasks().tasks;
  assert.deepEqual([list[0].notes, list[2].notes], ['patched', undefined]);
  assert.equal(hive.deleteTask('X', 'ipc'), true);
  assert.deepEqual(hive.tasks().tasks.map((c) => `${c.id}:${c.status}`), ['Y:doing', 'X:todo'], 'only the first copy is deleted');
});

test('the voice path writes with source "voice" (J15)', () => {
  const { readSource } = require('./read-source.cjs');
  assert.match(readSource('src/main/index.ts'), /hiveWriteTasks: \(tasks\) => hive\.writeTasks\(tasks, 'voice'\)/);
});
