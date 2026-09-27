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

test('EXIT-CRASH: a quit with 4 real ConPTYs crashes in node-pty\'s exit callback before the fix, and not after it', { timeout: 120_000, skip: process.platform !== 'win32' ? 'ConPTY is win32-only' : false }, async () => {
  const before = await quit('old');
  const after = await quit('new');
  console.log(`old: exit ${before.code}, ${before.dumps} dump(s); new: exit ${after.code}, ${after.dumps} dump(s), ${after.r && after.r.ms} ms, pending ${after.r && after.r.pending}`);
  assert.ok(before.dumps >= 1 || before.code !== 0, `the pre-fix order reproduces the crash (exit ${before.code}, ${before.dumps} dumps)`);
  assert.equal(after.dumps, 0, 'no crash dump after the fix');
  assert.equal(after.code, 0, 'a clean exit');
  assert.equal(after.r && after.r.pending, 0, 'every exit arrived before app.exit');
});
