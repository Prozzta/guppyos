'use strict';

/**
 * LOAD-FLAKES-176 (renderer half, Jim). Two harness-side flakes, neither a product bug:
 *  - app-recovery RENDERED: one timer covered SETUP (bundle ~17-58 MB, load, eval) AND the scenario,
 *    so a saturated CPU spent the scenario's 150 s before it started. Setup now has its own guard
 *    that names its phase; the scenario's budget starts at `__harnessRun()`.
 *  - renderer-memory-recovery FROZEN: the hog page froze on a 50 ms timer of its own, racing main's
 *    'page:notice' reply; a late reply let the freeze win, 'ready' was never sent and main timed out
 *    "waiting for ready". The page now freezes only on main's 'page:hog', sent after 'ready' and the
 *    sampler; the rendered test answers 'page:notice' 500 ms late on every run (the old order fails).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runScenario, HARNESS_SETUP_TIMEOUT_MS, harnessTestTimeout } = require('./electron-harness/run.cjs');

const H = path.join(__dirname, 'electron-harness');
const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const main = read(path.join(H, 'harness-main.cjs'));
const mem = read(path.join(H, 'memory-recovery-main.cjs'));

test('app-recovery: the scenario timer starts only after the bundle is evaluated, right before __harnessRun()', () => {
  const evalAt = main.indexOf('await win.webContents.executeJavaScript(code, true);');
  const timerAt = main.indexOf('timer = setTimeout(');
  const runAt = main.indexOf("await win.webContents.executeJavaScript('window.__harnessRun()', true);");
  assert.ok(evalAt > 0 && timerAt > evalAt && runAt > timerAt, 'eval -> scenario timer -> run');
  assert.ok(main.indexOf('clearTimeout(setupTimer);', evalAt) < timerAt, 'the setup guard ends where the scenario budget begins');
  assert.match(main, /phase = 'load';[\s\S]*phase = 'eval';/);
  assert.match(main, /sourcemap: process\.env\.HARNESS_SOURCEMAP === '1' \? 'inline' : false/, 'no 40 MB inline map unless asked for');
});

test('app-recovery: the node:test timeout covers setup + scenario + margin, so the harness names the phase first', () => {
  assert.equal(HARNESS_SETUP_TIMEOUT_MS, 300_000);
  assert.equal(harnessTestTimeout(150_000), 300_000 + 150_000 + 60_000);
  for (const [f, ms] of [['app-recovery-harness.test.cjs', 150_000], ['models-refresh-173.test.cjs', 120_000], ['impact-loop-171-harness.test.cjs', 150_000]]) {
    assert.match(read(path.join(__dirname, f)), new RegExp(`timeout: harnessTestTimeout\\(${String(ms).replace(/(\d{3})$/, '_$1')}\\)`), f);
  }
});

test('BEHAVIOUR: a setup that outlives its guard fails with the named phase, never as a scenario timeout', { timeout: 120_000 }, async () => {
  const r = await runScenario(path.join(H, 'scenarios', 'hidden-fit.tsx'), { setupTimeoutMs: 1, timeoutMs: 60_000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^harness setup timed out after 1ms in phase bundle \(the scenario never started\)$/);
});

test('memory-recovery: the page freezes ONLY on main\'s page:hog (no timer of its own); main sends it after ready and the sampler', () => {
  const page = mem.slice(mem.indexOf('writeFileSync(page,'), mem.indexOf('</script>`);'));
  assert.doesNotMatch(page, /setTimeout/, 'no self-timed freeze racing the ready round trip');
  assert.match(page, /ipcRenderer\.on\('page:hog', \(_e, maxMb\) => \{/);
  const readyAt = mem.indexOf("const first = await waitFor('ready');");
  const samplerAt = mem.indexOf('const timer = setInterval(() => sampler.sample(), 300);');
  const hogAt = mem.indexOf("win.webContents.send('page:hog', HOG_MAX_MB);");
  assert.ok(readyAt > 0 && samplerAt > readyAt && hogAt > samplerAt, 'ready -> sampler -> hog');
});

test('memory-recovery: the rendered test answers page:notice late on every run (the order that froze the old page)', () => {
  assert.match(mem, /const NOTICE_DELAY_MS = Number\(argOf\('notice-delay-ms', '0'\)\);/);
  assert.match(read(path.join(__dirname, 'renderer-memory-recovery-harness.test.cjs')), /'--notice-delay-ms', '500'\]/);
});
