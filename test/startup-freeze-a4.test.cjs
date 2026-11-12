'use strict';
require('./tools/own-job.cjs');
/**
 * STARTUP-FREEZE-104 A4: stallWatch feeds a startup-budget check. From window-ready, any main block of
 * >= STARTUP_BUDGET_MS (250) in the next STARTUP_WINDOW_MS (120 s) is a 'startup-budget-breach' row
 * (slices named), and the window's end writes one 'startup-budget' verdict row (ok, breaches, worstMs).
 * main marks window-ready in its did-finish-load handler. A fake clock; the heartbeat is driven by hand.
 * No hive, no HOME: nothing here builds hive objects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/main/stallWatch.ts');
const ROOT = path.join(__dirname, '..');

function rig() {
  let now = 1000;
  const rows = [];
  const w = new M.StallWatch({ now: () => now, origin: 1_700_000_000_000, log: (r) => rows.push(r), setInterval: () => 'I', clearInterval: () => {} });
  return { w, rows, advance: (ms) => { now += ms; }, of: (k) => rows.filter((r) => r.kind === k) };
}
/** Beats on time for `ms` (no stall). */
const idle = (r, ms) => { for (let i = 0; i < ms / M.STALL_BEAT_MS; i++) { r.advance(M.STALL_BEAT_MS); r.w.beat(); } };
/** One main block of `ms`, then the late beat. */
const block = (r, ms) => { r.advance(M.STALL_BEAT_MS + ms); r.w.beat(); };

test('constants: 250 ms budget over 120 s after window-ready', () => {
  assert.deepEqual([M.STARTUP_BUDGET_MS, M.STARTUP_WINDOW_MS, M.STARTUP_BREACH_ROWS], [250, 120000, 20]);
});

test('a clean start: no breach row, one ok verdict at the window end, never again', () => {
  const r = rig();
  r.w.start();
  r.w.windowReady();
  assert.deepEqual(r.w.startupBudget(), { armed: true, done: false, breaches: 0, worstMs: 0, ok: true });
  block(r, 200); // a main-stall row, under the budget
  idle(r, M.STARTUP_WINDOW_MS);
  assert.equal(r.of('startup-budget-breach').length, 0);
  assert.equal(r.of('main-stall').length, 1, 'the 200 ms block is still a main-stall row');
  assert.deepEqual(r.of('startup-budget').map((x) => [x.ok, x.breaches]), [[true, 0]], 'MUTANT: one verdict row');
  idle(r, 5000);
  assert.equal(r.of('startup-budget').length, 1, 'MUTANT: the verdict is written once');
  assert.equal(r.w.startupBudget().done, true);
});

test('blocks of >= 250 ms after window-ready are breach rows with their slices; the verdict fails with the worst', () => {
  const r = rig();
  const slow = { readFileSync() { r.advance(400); return 'x'; } };
  r.w.start({ fs: slow });
  r.w.windowReady();
  idle(r, 1000);
  r.advance(M.STALL_BEAT_MS); slow.readFileSync('C:/hive/agents/god/outbox/.sent/a.json'); r.w.beat();
  idle(r, 1000);
  block(r, 300);
  block(r, 249); // under the budget
  idle(r, M.STARTUP_WINDOW_MS);
  const b = r.of('startup-budget-breach');
  assert.equal(b.length, 2, `MUTANT: the 400 ms and 300 ms blocks are breaches: ${JSON.stringify(b)}`);
  assert.deepEqual(b.map((x) => x.ms), [400, 300]);
  assert.equal(b[0].sinceReadyMs, 1000);
  assert.deepEqual(b[0].slices.map((s) => s.name), ['readFileSync:a.json'], 'the breach names the sync call that blocked');
  const v = r.of('startup-budget');
  assert.deepEqual(v.map((x) => [x.ok, x.breaches, x.worstMs]), [[false, 2, 400]], 'MUTANT: the verdict fails');
  assert.deepEqual(r.w.startupBudget(), { armed: true, done: true, breaches: 2, worstMs: 400, ok: false });
});

test('nothing before window-ready and nothing after the window counts; window-ready is marked once', () => {
  const r = rig();
  r.w.start();
  block(r, 5000); // before window-ready (the launch itself)
  r.w.windowReady();
  idle(r, 10_000);
  r.w.windowReady(); // a second did-finish-load (a reload) does not move the window
  idle(r, M.STARTUP_WINDOW_MS - 10_000);
  block(r, 2000); // after the window
  assert.equal(r.of('startup-budget-breach').length, 0, 'MUTANT: only blocks inside the window count');
  assert.deepEqual(r.of('startup-budget').map((x) => x.ok), [true]);
});

test('an unarmed or stopped watcher checks nothing; breach rows are capped, the verdict still counts all', () => {
  const off = rig();
  off.w.windowReady(); // not started (stallWatch: false)
  assert.equal(off.w.startupBudget().armed, false);
  const r = rig();
  r.w.start();
  r.w.windowReady();
  for (let i = 0; i < 30; i++) { block(r, 300); idle(r, 1000); }
  idle(r, M.STARTUP_WINDOW_MS);
  assert.equal(r.of('startup-budget-breach').length, M.STARTUP_BREACH_ROWS, 'MUTANT: the rows are capped');
  assert.equal(r.of('startup-budget')[0].breaches, 30);
});

test('index.ts marks window-ready for the check in the first window\'s did-finish-load', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf("startupTiming.mark('window-ready');\n");
  assert.ok(at > 0);
  assert.ok(src.indexOf('stallWatch.windowReady();', at) > at && src.indexOf('stallWatch.windowReady();', at) - at < 200, 'MUTANT: window-ready arms the check');
  assert.equal((src.match(/stallWatch\.windowReady\(\)/g) || []).length, 1);
});
