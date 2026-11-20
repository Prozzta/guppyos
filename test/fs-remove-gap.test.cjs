'use strict';
require('./tools/own-job.cjs');
// @heavy-lock live: sustained work: 12 races at once, half of them in the installed Electron as Node. One run of this file takes the heavy slot.
/**
 * FS-REMOVE-READDIR-GAP-108: a tree delete never follows a link that an agent puts in while the
 * delete runs.
 *
 * The old delete (a bottom-up JS walk on paths, e074a677) lost a victim's files once in 26,571
 * jittered runs: between its lstat of a folder and its listing of it, the folder could become a
 * link. The delete is now the fs-handle addon's removeTree, which opens each folder once without
 * following a link and lists and deletes through that handle only.
 *
 * fs-remove-gap-race.cjs is the race: a second process (the agent) plants links to a victim folder
 * in the tree, and swaps the tree's folders for links to it, as fast as it can while the tree is
 * deleted. A loss is a run after which one of the victim's files is gone.
 *
 * This file is the suite's share: RUNS runs of each of the three callers (safeRemoveTreeSync,
 * safeRemoveTree, the worktree reaper) under this Node and, on Windows, under the installed
 * Electron as Node, at 0 losses, and the old walk as the control. The control is the copy of the
 * e074a677 walk kept in the race file, held for 1 ms after each check that found a real folder (why
 * is in the race file, at HOLD_US): it loses within 100 runs, so it is run until it loses and the
 * test fails if it does not.
 *
 * The statistical pin is the same race at a run count that would have caught 1 in 26,571
 * (`node test/fs-remove-gap-race.cjs pin <racers> <runs> <seconds>`); its numbers are on the card
 * and in .github/workflows/fs-remove-gap.yml for Linux and macOS.
 *
 * MUTANTS: C1 in fs-handle-remove-tree.test.cjs (a child opened so that a link is followed) fails
 * here too, as losses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { many } = require('./fs-remove-gap-race.cjs');

const RACERS = 2;
const RUNS = 150;
const IMPLS = ['sync', 'async', 'reaper'];
// The installed app comes from installed-guppy.cjs (run-tests jails LOCALAPPDATA); with no usable app the
// Electron tests skip and say why.
const guppy = require('./tools/installed-guppy.cjs').installedGuppy();
const exe = guppy.exe;

function clean(res, runtime) {
  assert.match(String(res.runtime), runtime);
  for (const impl of IMPLS) {
    const t = res.totals[impl];
    assert.ok(t, `${impl} ran`);
    assert.equal(t.failed, 0, `${impl}: ${JSON.stringify(t.errors)}`);
    assert.equal(t.runs, RACERS * RUNS, `${impl}: every run was made`);
    assert.equal(t.losses, 0, `${impl}: THE VICTIM LOST FILES in ${t.losses} of ${t.runs} runs (first at ${t.firstLossAt})`);
    assert.ok(t.planted + t.swapped > t.runs / 10, `${impl}: the agent got its links in (${t.planted} planted, ${t.swapped} swapped in ${t.runs} runs)`);
    assert.ok(t.landed > 0, `${impl}: no swap landed on a real folder of the tree in ${t.runs} runs (${t.swapped} swapped): this caller was not raced`);
    assert.ok(t.removed > 0, `${impl}: trees were removed`);
  }
}

async function under(file, fn) {
  const before = process.env.FS_GAP_EXE;
  if (file) process.env.FS_GAP_EXE = file; else delete process.env.FS_GAP_EXE;
  try { return await fn(); } finally { if (before === undefined) delete process.env.FS_GAP_EXE; else process.env.FS_GAP_EXE = before; }
}

// The suite also runs with Electron as Node as the test process: "this runtime" is then that Electron.
const HERE = process.versions.electron ? /^Electron .* as Node$/ : /^Node /;

test(`${RACERS * RUNS} raced deletes by each caller lose nothing (this runtime)`, async () => {
  clean(await under(null, () => many(IMPLS, RACERS, RUNS, 300)), HERE);
});

test(`${RACERS * RUNS} raced deletes by each caller lose nothing (the installed Electron as Node)`, { skip: guppy.skip }, async () => {
  clean(await under(exe, () => many(IMPLS, RACERS, RUNS, 300)), /^Electron .* as Node$/);
});

test('CONTROL: the old JS walk loses the victim\'s files in the same race, so the race has teeth', async () => {
  const res = await under(null, () => many(['jswalk'], 8, 20000, 240));
  const t = res.totals.jswalk;
  assert.equal(t.failed, 0, JSON.stringify(t.errors));
  assert.ok(t.losses > 0, `the e074a677 walk lost nothing in ${t.runs} runs: the agent is not reaching the gap`);
});
