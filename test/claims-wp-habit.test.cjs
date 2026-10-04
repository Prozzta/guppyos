'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { summarizeWriteHabit } = loadTs('src/main/claims/writeHabit.ts');

test('W8 measures candidate offers and explicit update/separate decisions without retaining text', () => {
  const rows = [
    { kind: 'claims-note-choice', choice: 'offered', targets: ['c-a', 'c-b'] },
    { kind: 'claims-note-choice', choice: 'replace', targets: ['c-a'] },
    { kind: 'claims-note-choice', choice: 'offered', targets: ['c-c'] },
    { kind: 'claims-note-choice', choice: 'separate', targets: ['c-c'] },
    { kind: 'claims-note-choice', choice: 'cancel', targets: ['c-d'] },
    { kind: 'claims-note-choice', choice: 'new', targets: [] },
    { kind: 'other-event', text: 'ignored' },
  ];
  assert.deepEqual(summarizeWriteHabit(rows), {
    offered: 2, replace: 1, separate: 1, separateWithCandidate: 1, cancel: 1, new: 1,
    explicitResolution: 3, replaceShare: 1 / 3,
  });
  assert.equal(summarizeWriteHabit([]).replaceShare, null);
});
