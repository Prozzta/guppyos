'use strict';

/**
 * MEMSPIKE-168 - the hidden-terminal fit guard, on a REAL xterm in a real (hidden) Electron
 * renderer. PtyTerminalView's font-size effect used to call fit() with no size guard, so a view
 * mounted inside display:none resized its pty to a phantom grid on mount (the memspike repro's
 * "hidden" variant: one pty resize, i.e. one full Codex repaint, per hidden mount). It now has
 * tryFit's clientWidth/clientHeight guard; the resize happens once the host is shown.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = join(__dirname, 'electron-harness', 'scenarios', 'hidden-fit.tsx');

test('a PtyTerminalView inside display:none never resizes its pty; it does once shown', async () => {
  const r = await runScenario(scenario, { timeoutMs: 60_000 });
  assert.equal(r.ok, true, `scenario failed: ${r.error ?? ''}`);
  assert.equal(r.afterMount, 0, 'no pty resize on a hidden mount');
  assert.equal(r.afterFontChange, 0, 'no pty resize on a font-size change while hidden');
  assert.ok(r.shown.length >= 1, `the pty is resized once the host has a size (got ${JSON.stringify(r.shown)})`);
  const last = r.shown[r.shown.length - 1];
  assert.equal(last.id, 'pty-hidden');
  assert.ok(last.cols > 20 && last.rows > 5, `a real grid, not a phantom one: ${last.cols}x${last.rows}`);
});
