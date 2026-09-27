'use strict';

/**
 * HISTORY-VIEW-169, RENDERED: the production HistoryView in a hidden Electron window
 * (test/electron-harness: show:false; userData, sessionData and crashDumps in the
 * sandbox), against an in-memory transcript with the real byte-cursor contract.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'history-view.tsx');
let run = null;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 120_000 }));

test('RENDERED: opens at the bottom with only a slice of 150 rows mounted', async () => {
  const r = await result();
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.initialGap, 0, 'scrolled to the newest turn');
  assert.match(r.initialLast, /turn 999/);
  assert.ok(r.initialMounted > 0 && r.initialMounted < 60, `virtualised: ${r.initialMounted} of 150 rows mounted`);
});

test('RENDERED: follows a new turn at the bottom; holds position when scrolled up and offers Jump to latest', async () => {
  const r = await result();
  assert.equal(r.followGap, 0);
  assert.match(r.followLast, /fresh 1002/);
  assert.equal(r.heldTop, 200, 'a new turn did not move a reader who scrolled up');
  assert.equal(r.jumpOffered, true);
});

test('RENDERED: Load older keeps what is on screen in place; Jump to latest returns to the newest turn', async () => {
  const r = await result();
  assert.equal(r.olderOffered, true);
  assert.equal(r.anchorStillMounted, true);
  assert.equal(r.anchorShift, 0, 'the first visible row did not move');
  assert.ok(r.mountedAfterOlder < 80, `still virtualised after paging (${r.mountedAfterOlder})`);
  assert.equal(r.jumpGap, 0);
  assert.match(r.jumpLast, /step 1004/);
  assert.deepEqual(r.calls.slice(0, 2), ['tail', 'after'], 'a tail read, then size-checked follow polls');
  assert.ok(r.calls.includes('before'));
});
