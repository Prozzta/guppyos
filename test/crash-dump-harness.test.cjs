'use strict';

/**
 * RENDERER-RECOVERY-164, RENDERED: the local crash reporter in a real hidden Electron.
 *  - a renderer that really crashes (process.crash()) now leaves a minidump in the LOCAL
 *    crashDumps folder, found by waitForDump, and uploads stay off;
 *  - the reporter adds no measurable startup cost: start() itself, and time-to-ready with vs
 *    without it (3 runs each, medians).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createSandbox, removeSandbox } = require('./electron-harness/run.cjs');

const MARKER = '__CRASHDUMP_RESULT__';
function run(args) {
  const electron = require('electron');
  const sandbox = createSandbox('rr164dump-');
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [join(__dirname, 'electron-harness', 'crash-dump-main.cjs'), '--sandbox', sandbox, ...args], {
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
// Test timeouts are HANG guards (FLAKY-170): under a saturated machine one hidden Electron launch
// measured up to ~100 s, so they are generous; nothing here is judged by them.
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

test('RENDERED: a real renderer crash leaves a LOCAL minidump (no upload), found for the crash row', { timeout: 600_000 }, async () => {
  const r = await run(['--mode', 'dump']);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.uploadsEnabled, false, 'uploads are off');
  assert.ok(r.dumpPath && /\.dmp$/i.test(r.dumpPath), `a .dmp appeared: ${JSON.stringify(r)}`);
  assert.equal(r.inSandbox, true, 'in the app\'s own crashDumps folder');
  assert.ok(r.dumpBytes > 0);
  assert.notEqual(r.exitCode, -36861, 'no longer Crashpad\'s "not connected to a handler" code');
  console.log(`dump: ${r.dumpBytes} B, reason ${r.reason}, exit ${r.exitCode}, start() ${r.startCostMs} ms`);
});

test('RENDERED: the reporter adds no measurable startup cost (start() ms; time-to-ready with vs without, 3 runs each)', { timeout: 1_200_000 }, async () => {
  const on = []; const off = []; const cost = []; const cpu = []; const syncFs = [];
  for (let i = 0; i < 3; i += 1) {
    const a = await run(['--mode', 'ready', '--reporter', 'on']); assert.equal(a.ok, true, a.error); on.push(a.readyMs); cost.push(a.startCostMs); cpu.push(a.startCpuMs); syncFs.push(a.startSyncFs);
    const b = await run(['--mode', 'ready', '--reporter', 'off']); assert.equal(b.ok, true, b.error); off.push(b.readyMs);
  }
  console.log(`crashReporter.start(): ${JSON.stringify(cost)} ms wall, ${JSON.stringify(cpu)} ms CPU, sync fs ${JSON.stringify(syncFs)}; ready with ${JSON.stringify(on)} (median ${median(on)}), without ${JSON.stringify(off)} (median ${median(off)})`);
  // Bounds are loose on purpose: under the full suite the machine is busy. Measured alone:
  // start() 25-37 ms warm; median time-to-ready 288 ms with vs 261 ms without. Under the full
  // suite on a busy floor start() measured 93-189 ms (1.1.66 run), so 150 ms flaked; 400 ms still
  // catches a start() that blocks (a synchronous handler launch or dump scan costs seconds).
  // FLAKY-TIMING (Andy, flaky-170): `median(start() wall) <= 400` failed under a saturated machine
  // (a sample of 7080 ms; median 750) with no defect, so the wall time is reported, not asserted.
  // What a blocking start() would add is WORK on main - a dump scan or prune (sync fs), or compute -
  // and that is checked load-independently: no synchronous fs call at all inside start(), and its
  // CPU time (process.cpuUsage; measured ~16-47 ms, Windows ticks) under 250 ms in the median.
  // (Launching the Crashpad handler is Electron's own work inside crashReporter.start.)
  assert.deepEqual(syncFs, [{}, {}, {}], `start() makes no synchronous fs call: ${JSON.stringify(syncFs)}`);
  assert.ok(median(cpu) < 250, `start() burns little CPU on main: ${JSON.stringify(cpu)} ms`);
  // FLAKY-TIMING (Andy, flaky-170): the time-to-ready DIFFERENCE is reported, no longer asserted.
  // It is two medians of three whole-Electron launches each, i.e. mostly process creation, which a
  // saturated machine moves by hundreds of ms (317 ms measured under load against a 500 ms bound).
  // It also adds no detection: the only reporter code in this harness before 'ready' is
  // startLocalCrashReporter (one crashReporter.start call), and its cost is the start() bound above,
  // measured in-process around exactly that call.
  console.log(`time-to-ready difference (diagnostic): ${median(on) - median(off)} ms`);
});
