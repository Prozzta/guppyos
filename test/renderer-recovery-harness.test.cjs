'use strict';

/**
 * RENDERER-RECOVERY-164, RENDERED: a real hidden Electron window, a real
 * forcefullyCrashRenderer(), the real recovery module (test/electron-harness/recovery-main.cjs).
 * Proves the reload, the terminal stream reattaching, the recreate hand-over and the give-up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createSandbox, removeSandbox } = require('./electron-harness/run.cjs');

const MARKER = '__RECOVERY_RESULT__';

function runRecovery() {
  const electron = require('electron');
  const sandbox = createSandbox('rr164-');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(__dirname, 'electron-harness', 'recovery-main.cjs'), '--sandbox', sandbox], {
      cwd: join(__dirname, '..'), env: { ...process.env, MUNDER_DEV: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      removeSandbox(sandbox).then(() => {
        const at = out.lastIndexOf(MARKER);
        if (at < 0) { reject(new Error(`no result (exit ${code})\n${out}\n${err}`)); return; }
        resolve(JSON.parse(out.slice(at + MARKER.length).split('\n')[0]));
      }, reject);
    });
  });
}

test('RENDERED: crash 1 reloads the same window and the terminal stream reattaches; crash 2 recreates it and hands the stream over; crash 3 gives up', { timeout: 120_000 }, async () => {
  const r = await runRecovery();
  assert.equal(r.ok, true, r.error);
  const step = (p) => r.steps.find((s) => s.phase === p);

  const loaded = step('loaded');
  assert.ok(loaded.goneListeners >= 1, 'ours is installed (Electron may add its own)');

  const reloaded = step('reloaded');
  assert.equal(reloaded.sameWc, true, 'crash 1: the SAME webContents came back');
  assert.equal(reloaded.newPid, true, 'with a new renderer process');
  assert.equal(reloaded.notice?.action, 'reload', 'and the one-shot "restored" notice');
  assert.equal(reloaded.goneListeners, loaded.goneListeners, 'no duplicate crash listener after the reload');

  const recreated = step('recreated');
  assert.equal(recreated.newWc, true, 'crash 2: a NEW window');
  assert.equal(recreated.notice?.action, 'recreate');
  assert.equal(recreated.ownerMoved, true, 'the terminal stream now goes to the new window');
  assert.equal(recreated.oldDestroyed, true);
  assert.equal(recreated.windows, 1, 'exactly one window afterwards');
  assert.deepEqual(recreated.closeEvents, [], 'destroy(): the close handler (quit warning / floor confirm) never ran');

  const gaveUp = step('gave-up');
  assert.equal(gaveUp.streak, 3);
  assert.equal(gaveUp.reloadedAnyway, false, 'crash 3: nothing is reloaded or recreated');

  assert.deepEqual(r.rows.map((x) => x.recovery), ['reload', 'recreate', 'give-up']);
  assert.ok(r.rows.every((x) => x.reason === 'crashed' || x.reason === 'killed'), JSON.stringify(r.rows));
  assert.ok(r.rows.every((x) => x.hasUptime && typeof x.pid === 'number' && x.pid > 0), 'every row carries pid and uptime');
  assert.equal(r.rows[0].pid, r.firstPid, 'the row names the renderer that died');
});
