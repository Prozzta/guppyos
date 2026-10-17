'use strict';

/**
 * CARDS-TAB-CLEANUP-191 (Jim's SHOULD): the SHOW DONE toggle, clicked in a real renderer, stores the
 * choice it shows ('1' after SHOW, '0' after HIDE), and a remounted view reads that choice back.
 * Kills the mutant onClick saveShowDone(!show), which the source pin in cards-tab-cleanup-191 let by.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'cards-done-toggle-click.tsx');

test('CLICKED: SHOW stores 1 and HIDE stores 0; a remount opens with the stored choice', async () => {
  const r = await runScenario(scenario, { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);

  assert.deepEqual(r.initial, { cards: ['OPEN-1'], toggle: 'SHOW DONE (2)', stored: null }, 'default: done hidden, nothing stored');
  assert.deepEqual(r.afterShow, { cards: ['DONE-1', 'DONE-2', 'OPEN-1'], toggle: 'HIDE DONE (2)', stored: '1' }, 'SHOW shows the done cards and stores 1');
  assert.deepEqual(r.remountShown, { cards: ['DONE-1', 'DONE-2', 'OPEN-1'], toggle: 'HIDE DONE (2)', stored: '1' }, 'a remount reads SHOW back');
  assert.deepEqual(r.afterHide, { cards: ['OPEN-1'], toggle: 'SHOW DONE (2)', stored: '0' }, 'HIDE hides them and stores 0');
  assert.deepEqual(r.remountHidden, { cards: ['OPEN-1'], toggle: 'SHOW DONE (2)', stored: '0' }, 'a remount reads HIDE back');
});
