'use strict';

/**
 * MEMSPIKE-167, RENDERED: a hidden window whose renderer freezes in a busy loop while allocating
 * is recovered by MAIN (real sampler, real kill, real 1.1.64 recovery), and a stream from main
 * (the PTY stand-in) reaches the reloaded page (test/electron-harness/memory-recovery-main.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createSandbox, removeSandbox } = require('./electron-harness/run.cjs');

const MARKER = '__MEMRECOVERY_RESULT__';

function run() {
  const electron = require('electron');
  const sandbox = createSandbox('ms167-');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(__dirname, 'electron-harness', 'memory-recovery-main.cjs'), '--sandbox', sandbox], {
      cwd: join(__dirname, '..'), env: { ...process.env, MUNDER_DEV: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      removeSandbox(sandbox).then(() => {
        const at = out.lastIndexOf(MARKER);
        if (at < 0) { reject(new Error(`no result (exit ${code})\n${out.slice(-2000)}\n${err.slice(-2000)}`)); return; }
        resolve(JSON.parse(out.slice(at + MARKER.length).split('\n')[0]));
      }, reject);
    });
  });
}

test('RENDERED: a FROZEN renderer that keeps allocating is killed by main on a confirmed over-limit and reloaded; the stream from main reaches the new page', { timeout: 600_000 }, async () => {
  const r = await run();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.actions.length, 1, 'one recovery for one runaway renderer');
  assert.equal(r.actions[0].outcome, 'killed', 'killed without the renderer cooperating');
  assert.ok(r.actions[0].mb >= r.limitMb, `acted over the limit: ${r.actions[0].mb} MB`);
  assert.ok(r.actions[0].mb <= r.limitMb + 400, `the hog stays bounded (never starves the suite): ${r.actions[0].mb} MB`);
  assert.equal(r.gone.recovery, 'reload', 'the ordinary recovery took over');
  assert.equal(r.notice && r.notice.reason, 'memory', 'the restored notice says why');
  assert.ok(r.steps.some((s) => s.phase === 'recovered' && s.sameWc && s.newPid), 'the same window, a new renderer process');
  assert.ok(r.ptyTicks > 0, 'main (the PTY side) kept running throughout');
  console.log(`recovered in ${r.recoverMs} ms; acted at ${r.actions[0].mb} MB (limit ${r.limitMb})`);
});
