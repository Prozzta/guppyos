'use strict';

/**
 * ZT-I3 §3.1: `validateLedger`, the whole-ledger check, and the one duplicate-id rule
 * (first occurrence wins). Errors: a missing or duplicate id, an unknown status.
 * Everything else is a warning, which never blocks a write.
 *
 * Mutants that must die:
 *   M1 drop the duplicate-id check
 *   M2 last-wins instead of first-wins (firstOccurrenceById keeps the last copy)
 *   M3 a warning promoted to an error (would block god's writes)
 *   M22 numeric-only priority check (god writes strings)
 *   M23 `dependsOn` only (ignores `deps`, which the live ledger uses)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { validateLedger, firstOccurrenceById, introducedErrors, duplicateIds, DUPLICATE_DESCRIPTION_MIN } = loadTs('src/shared/taskLedger.ts');

const card = (id, extra = {}) => ({ id, title: id, status: 'todo', ...extra });
const keys = (issues, level) => issues.filter((i) => !level || i.level === level).map((i) => i.key).sort();
const agents = new Set(['jim', 'andy']);

test('a duplicate id in two statuses is an error, and the FIRST copy is the card (M1, M2)', () => {
  const ledger = [card('A', { status: 'done', assignee: 'jim' }), card('B'), card('A', { status: 'todo' })];
  const issues = validateLedger(ledger, agents);
  assert.deepEqual(keys(issues, 'error'), ['dup:A']);
  assert.match(issues.find((i) => i.key === 'dup:A').message, /#0, #2/);
  const kept = firstOccurrenceById(ledger, (c) => c.id);
  assert.deepEqual(kept.map((c) => `${c.id}:${c.status}`), ['A:done', 'B:todo']);
  assert.deepEqual([...duplicateIds(ledger)], [['A', [0, 2]]]);
});

test('a card without an id and an unknown status are errors', () => {
  const issues = validateLedger([{ title: 'x', status: 'todo' }, card('S', { status: 'in-progress' })], agents);
  assert.deepEqual(keys(issues, 'error'), ['noid:1', 'status:S']);
});

test('assignee, deps, priority, createdAt and copied descriptions are WARNINGS only (M3)', () => {
  const long = 'x'.repeat(DUPLICATE_DESCRIPTION_MIN);
  const ledger = [
    card('U', { assignee: 'ghost' }),
    card('D', { deps: ['NOPE'] }),
    card('P', { priority: 'urgent' }),
    card('C', { createdAt: 'yesterday-ish' }),
    card('X1', { description: long }),
    card('X2', { description: long })
  ];
  const issues = validateLedger(ledger, agents);
  assert.deepEqual(keys(issues, 'error'), []);
  assert.deepEqual(keys(issues, 'warning'), ['assignee:U', 'createdAt:C', 'dep:D:NOPE', 'desc:X1+X2', 'priority:P']);
  // A ledger with only warnings: any write is allowed.
  assert.deepEqual(introducedErrors([], issues), []);
});

test('the live field mix is accepted as written (M22, M23)', () => {
  const ledger = [
    card('P1', { priority: 'critical' }), card('P2', { priority: 'high' }),
    card('P3', { priority: 'medium' }), card('P4', { priority: 'low' }), card('P5', { priority: 2 }),
    card('DEP', { deps: ['P1'] }), card('DEP2', { dependsOn: ['P2'] }),
    card('BADDEP', { deps: ['MISSING'] })
  ];
  const issues = validateLedger(ledger, agents);
  assert.deepEqual(keys(issues), ['dep:BADDEP:MISSING']);
});

test('"unassigned", an empty assignee and a missing createdAt mean nothing is wrong', () => {
  const issues = validateLedger([card('A', { assignee: 'unassigned' }), card('B', { assignee: '' }), card('C', { assignee: 'jim' })], agents);
  assert.deepEqual(issues, []);
});

test('a description shorter than the copy threshold is never a copy', () => {
  const short = 'y'.repeat(DUPLICATE_DESCRIPTION_MIN - 1);
  assert.deepEqual(validateLedger([card('A', { description: short }), card('B', { description: short })]), []);
});

test('issue keys hold no indexes: an unrelated insert above keeps every key', () => {
  const before = validateLedger([card('A'), card('A'), card('S', { status: '?' })]);
  const after = validateLedger([card('NEW'), card('A'), card('A'), card('S', { status: '?' })]);
  assert.deepEqual(keys(before), keys(after));
  assert.deepEqual(introducedErrors(before, after), []);
});

test('accepts the {tasks:[...]} file shape as well as the bare array', () => {
  assert.deepEqual(keys(validateLedger({ tasks: [card('A'), card('A')] })), ['dup:A']);
});
