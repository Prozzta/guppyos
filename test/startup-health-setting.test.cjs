'use strict';
require('./tools/own-job.cjs');
/**
 * STARTUP-FREEZE-104 A4 (god 415e93): Settings -> Startup health shows the last startup-budget
 * verdict and its breaches. stallWatch hands the verdict to main once per start; main saves it to
 * userData/startup-budget.json with an async write, and serves it via 'health:startupBudget' with an
 * async read (never a sync read on main). No hive, no HOME, no Electron.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SB = loadTs('src/shared/startupBudget.ts');
const M = loadTs('src/main/stallWatch.ts');
const ROOT = path.join(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const AT = '2026-11-12T04:00:00.000Z';
const v = (o) => ({ ok: true, breaches: 0, worstMs: 0, budgetMs: 250, windowMs: 120000, at: AT, ...o });

test('a saved verdict is validated: a torn, edited or inconsistent file is "none"', () => {
  assert.deepEqual(SB.parseStartupVerdict(v({})), v({}));
  assert.deepEqual(SB.parseStartupVerdict(v({ ok: false, breaches: 3, worstMs: 1234.4 })), v({ ok: false, breaches: 3, worstMs: 1234 }));
  for (const bad of [null, 'x', {}, v({ ok: 'yes' }), v({ breaches: -1 }), v({ at: 'never' }), v({ ok: true, breaches: 2 }), v({ ok: false, breaches: 0 }), v({ worstMs: Infinity })]) {
    assert.equal(SB.parseStartupVerdict(bad), null, `MUTANT: rejected ${JSON.stringify(bad)}`);
  }
});

test('the Settings line: off, none yet, checking, smooth, and slow moments with the worst', () => {
  const L = SB.startupHealthLine;
  assert.equal(L(null), 'Startup health: …');
  assert.equal(L({ enabled: false, pending: false, last: v({}) }), SB.STARTUP_HEALTH_COPY.off);
  assert.equal(L({ enabled: true, pending: false, last: null }), SB.STARTUP_HEALTH_COPY.none);
  assert.equal(L({ enabled: true, pending: true, last: null }), SB.STARTUP_HEALTH_COPY.pending);
  assert.match(L({ enabled: true, pending: false, last: v({}) }), /^Last start \(.+\): smooth, no main-thread pause of 250 ms or more\.$/);
  assert.match(L({ enabled: true, pending: false, last: v({ ok: false, breaches: 1, worstMs: 400 }) }), /: 1 slow moment, the worst 400 ms \(limit 250 ms\)\.$/);
  assert.match(L({ enabled: true, pending: false, last: v({ ok: false, breaches: 7, worstMs: 23040 }) }), /: 7 slow moments, the worst 23\.0 s \(limit 250 ms\)\.$/);
  assert.ok(L({ enabled: true, pending: true, last: v({ ok: false, breaches: 2, worstMs: 900 }) }).startsWith(SB.STARTUP_HEALTH_COPY.pending + ' Last start'), 'pending still shows the previous verdict');
});

test('stallWatch hands main the verdict once per start, matching the log row', () => {
  let now = 1000;
  const rows = []; const verdicts = [];
  const w = new M.StallWatch({ now: () => now, origin: 0, log: (r) => rows.push(r), setInterval: () => 'I', clearInterval: () => {}, onStartupVerdict: (x) => verdicts.push(x) });
  w.start();
  w.windowReady();
  now += 25 + 600; w.beat();
  for (let i = 0; i < M.STARTUP_WINDOW_MS / 25 + 400; i++) { now += 25; w.beat(); }
  assert.deepEqual(verdicts, [{ ok: false, breaches: 1, worstMs: 600, budgetMs: 250, windowMs: 120000 }], 'MUTANT: one verdict, handed to main');
  const row = rows.find((r) => r.kind === 'startup-budget');
  assert.deepEqual([row.ok, row.breaches, row.worstMs], [verdicts[0].ok, verdicts[0].breaches, verdicts[0].worstMs]);
  // a throwing receiver never breaks the watcher
  const w2 = new M.StallWatch({ now: () => now, origin: 0, log: () => {}, setInterval: () => 'I', clearInterval: () => {}, onStartupVerdict: () => { throw new Error('disk'); } });
  w2.start(); w2.windowReady();
  assert.doesNotThrow(() => { for (let i = 0; i < M.STARTUP_WINDOW_MS / 25 + 10; i++) { now += 25; w2.beat(); } });
  assert.equal(w2.startupBudget().done, true);
});

test('wiring: main saves and serves the verdict asynchronously; preload and Settings show it', () => {
  const ix = src('src/main/index.ts');
  const h = ix.slice(ix.indexOf("ipcMain.handle('health:startupBudget'"), ix.indexOf("ipcMain.handle('health:startupBudget'") + 600);
  assert.ok(h.length > 100, 'the IPC handler exists');
  assert.match(h, /await fsModule\.promises\.readFile\(join\(app\.getPath\('userData'\), STARTUP_BUDGET_FILE\)/, 'MUTANT: an async read of the main-only file');
  assert.match(h, /parseStartupVerdict\(/, 'the file is validated');
  assert.doesNotMatch(h.slice(0, h.indexOf('\n});')), /readFileSync/, 'never a sync read on main');
  assert.match(ix, /onStartupVerdict: \(v\) => \{ void fsModule\.promises\.writeFile\(join\(app\.getPath\('userData'\), STARTUP_BUDGET_FILE\)/, 'MUTANT: the verdict is saved asynchronously');
  assert.match(src('src/preload/index.ts'), /startupBudget: \(\): Promise<StartupBudgetView> => ipcRenderer\.invoke\('health:startupBudget'\)/);
  const modal = src('src/renderer/src/components/SettingsModal.tsx');
  assert.ok(modal.indexOf('<StartupHealthSetting />') > modal.indexOf('<GraphicsSetting />'), 'MUTANT: Settings -> General shows the line, after Graphics');
  const comp = src('src/renderer/src/components/StartupHealthSetting.tsx');
  assert.match(comp, /window\.cth\.startupBudget\(\)/);
  assert.match(comp, /\{startupHealthLine\(view\)\}/);
});
