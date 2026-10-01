'use strict';

/**
 * TASKS-DUP-ID-LOOP (2026-10-01): tasks.json held two cards with id CHANGELOG-NOT-PACKAGED
 * (#193 done/jim, #453 todo). The office floor keyed its previous poll by the LAST copy
 * (todo), so on every 5 s poll the done copy looked like todo -> done, and Jim replayed
 * "filing it as done" forever. Every reader now keys the ledger by the FIRST copy.
 *
 * Mutants that must die:
 *   Mdup1 ledgerChanges keys the previous poll by the last copy (the shipped bug)
 *   Mdup2 the floor or the Kanban stops keying by the first copy
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ledgerChanges, firstOccurrenceById } = loadTs('src/shared/taskLedger.ts');

const poll = () => [
  { id: 'CHANGELOG-NOT-PACKAGED', status: 'done', assignee: 'jim' },
  { id: 'OTHER', status: 'doing', assignee: 'andy' },
  { id: 'CHANGELOG-NOT-PACKAGED', status: 'todo' }
];

test('a duplicate id in two statuses causes no move on repeated polls', () => {
  let last = poll();
  for (let i = 0; i < 5; i++) {
    const next = poll();
    assert.deepEqual(ledgerChanges(last, next), [], `poll ${i} replayed a move`);
    last = next;
  }
});

test('a real status change of the canonical (first) card is still one move', () => {
  const next = poll();
  next[0] = { ...next[0], status: 'doing' };
  const changes = ledgerChanges(poll(), next);
  assert.deepEqual(changes.map((c) => `${c.card.id}:${c.old.status}>${c.card.status}`), ['CHANGELOG-NOT-PACKAGED:done>doing']);
});

test('a change to the later duplicate is not animated (it is reported by the guard instead)', () => {
  const next = poll();
  next[2] = { ...next[2], status: 'doing', assignee: 'andy' };
  assert.deepEqual(ledgerChanges(poll(), next), []);
});

test('a new card is a change with no previous state', () => {
  const next = [...poll(), { id: 'NEW', status: 'todo' }];
  assert.deepEqual(ledgerChanges(poll(), next).map((c) => [c.card.id, c.old]), [['NEW', undefined]]);
});

test('the office floor and the Kanban key the ledger by the first copy (Mdup2)', () => {
  const floor = codeOnly(readSource('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.match(floor, /const ledger: LedgerTask\[\] = firstOccurrenceById\(/);
  assert.match(floor, /of ledgerChanges\(lastLedger, ledger\)/);
  assert.doesNotMatch(floor, /new Map\(lastLedger\.map\(\(t\) => \[t\.id, t\]\)\)/, 'the last-wins previous-poll map is gone');
  const kanban = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'));
  assert.match(kanban, /return firstOccurrenceById\(list,/);
  assert.equal(firstOccurrenceById([{ id: 'a', n: 1 }, { id: 'a', n: 2 }], (x) => x.id)[0].n, 1);
});

test('an assignee-only change is a change (J6)', () => {
  const next = poll();
  next[1] = { ...next[1], assignee: 'jim' };
  assert.deepEqual(ledgerChanges(poll(), next).map((c) => `${c.card.id}:${c.old.assignee}>${c.card.assignee}`), ['OTHER:andy>jim']);
});
