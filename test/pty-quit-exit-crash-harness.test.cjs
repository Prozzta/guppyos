'use strict';

/**
 * EXIT-CRASH, RENDERED: quitting with 4 real ConPTY sessions. The pre-fix order (resolve right
 * after the kill, then app.exit) crashes in node-pty's exit callback and leaves a dump; the fixed
 * killAllAsync (waits for every exit) leaves none. Dumps go to the harness sandbox only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createSandbox, removeSandbox } = require('./electron-harness/run.cjs');

function dumpsIn(dir) {
  const out = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.dmp')) out.push(p); } };
  walk(dir);
  return out;
}

function quit(mode) {
  const electron = require('electron');
  const sandbox = createSandbox(`exitcrash-${mode}-`);
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(__dirname, 'electron-harness', 'pty-quit-main.cjs'), '--sandbox', sandbox, '--mode', mode], {
      cwd: join(__dirname, '..'), env: { ...process.env, MUNDER_DEV: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      // The crashpad handler writes the dump just after the process dies.
      setTimeout(() => {
        const dumps = dumpsIn(join(sandbox, 'crashDumps'));
        const at = out.lastIndexOf('__PTYQUIT__');
        const r = at >= 0 ? JSON.parse(out.slice(at + 11).split('\n')[0]) : null;
        removeSandbox(sandbox).then(() => resolve({ code, dumps: dumps.length, r }), reject);
      }, 3000);
    });
  });
}

// The fixed quit is deterministic and is what the suite gates on. The PRE-FIX crash is a race
// (the exit callback against app.exit): on a busy machine it can lose, so reproducing it is an
// opt-in evidence run (MD_EXITCRASH_REPRO=1), never a suite assertion (0-failure gate: no tests
// that depend on winning a race). In the harness it reproduces INTERMITTENTLY (0xC0000005 + a dump
// in 1 of 2 isolated runs); the deterministic evidence is the real app (Jim, EXIT-CRASH-WHY: +207 ms).
test('EXIT-CRASH: a quit with 4 real ConPTYs exits cleanly with NO crash dump, after every exit arrived', { timeout: 120_000, skip: process.platform !== 'win32' ? 'ConPTY is win32-only' : false }, async () => {
  const after = await quit('new');
  console.log(`new: exit ${after.code}, ${after.dumps} dump(s), ${after.r && after.r.ms} ms, pending ${after.r && after.r.pending}`);
  assert.equal(after.dumps, 0, 'no crash dump');
  assert.equal(after.code, 0, 'a clean exit');
  assert.equal(after.r && after.r.pending, 0, 'every exit arrived before app.exit');
});

test('EXIT-CRASH evidence (opt-in): the pre-fix order crashes', { timeout: 120_000, skip: process.platform !== 'win32' || process.env.MD_EXITCRASH_REPRO !== '1' ? 'opt-in: MD_EXITCRASH_REPRO=1 (a race, not a gate)' : false }, async () => {
  const before = await quit('old');
  console.log(`old: exit ${before.code}, ${before.dumps} dump(s)`);
  assert.ok(before.dumps >= 1 || before.code !== 0, `the pre-fix order crashed (exit ${before.code}, ${before.dumps} dumps)`);
});
