'use strict';

/**
 * ZT-I3 (Jim C3): the validator is fitted to the ledger god actually writes. A fixture
 * with the live field mix (2026-10-01, 504 cards: string priorities critical/high/medium/low
 * and no numbers, `deps` and never `dependsOn`, cards without `createdAt`, the assignee
 * "unassigned", `notes` and `note`) must give 0 errors and exactly the one warning the live
 * ledger had on day one: the CHANGELOG-NOT-PACKAGED description pair.
 *
 * Mutants that must die: M22 numeric-only priority; M23 `dependsOn` only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { validateLedger } = loadTs('src/shared/taskLedger.ts');

const CHANGELOG_DESC = 'The packaged app does not carry CHANGELOG.md, so the voice assistant cannot read "what is new" from the installed build.';

function liveMix() {
  return [
    { id: 'ZT-I1-MAIL', title: 'mail', status: 'doing', assignee: 'andy', priority: 'critical', deps: [], createdAt: '2026-09-29T10:00:00.000Z', notes: 'n' },
    { id: 'ZERO-TOKEN-LIVENESS', title: 'liveness', status: 'todo', assignee: 'dwight', priority: 'high', deps: ['ZT-I1-MAIL'], notes: 'no createdAt' },
    { id: 'CARD-BADGE-AMBIGUOUS', title: 'badge', status: 'todo', assignee: 'unassigned', priority: 'medium', deps: ['ZERO-TOKEN-LIVENESS'], note: 'single note field' },
    { id: 'RELEASE-WORKTREE-PRUNE', title: 'prune', status: 'blocked', priority: 'low', humanQA: [{ q: 'ok?', a: 'yes' }] },
    { id: 'CHANGELOG-NOT-PACKAGED', title: 'changelog', status: 'done', assignee: 'jim', priority: 'high', description: CHANGELOG_DESC, result: 'shipped' },
    { id: 'CHANGELOG-NOT-PACKAGED-2', title: 'changelog 2', status: 'todo', priority: 'high', description: CHANGELOG_DESC },
    { id: 'NO-PRIORITY', title: 'np', status: 'todo', createdAt: '2026-09-30T00:00:00.000Z', repo: 'x', scope: 'y', slack: { channel: 'C', thread_ts: '1' } }
  ];
}

test('the live field mix gives 0 errors and exactly the one description-pair warning', () => {
  const issues = validateLedger(liveMix(), new Set(['andy', 'dwight', 'jim']));
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  assert.deepEqual(issues.map((i) => `${i.level}:${i.key}`), ['warning:desc:CHANGELOG-NOT-PACKAGED+CHANGELOG-NOT-PACKAGED-2']);
});

test('a `deps` entry naming a missing card is still seen (M23)', () => {
  const ledger = liveMix();
  ledger[1].deps = ['GONE'];
  const issues = validateLedger(ledger, new Set(['andy', 'dwight', 'jim']));
  assert.ok(issues.some((i) => i.key === 'dep:ZERO-TOKEN-LIVENESS:GONE'));
});
