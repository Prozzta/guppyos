'use strict';
/**
 * MEMSPIKE-167: containment for a runaway renderer (2026-09-27: 250 MB -> 2.95 GB in ~2 min; the
 * watchdog only logged and the Human had to kill the app). Main decides from its own process
 * metrics (the renderer may be frozen), kills the renderer on a CONFIRMED over-limit, and the
 * existing 1.1.64 recovery reloads / recreates once / gives up. Plus a time-boxed heap look on
 * "doubled" and a per-minute PTY traffic row. The live half (a frozen, allocating renderer really
 * recovered) is test/renderer-memory-recovery-harness.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/main/rendererRecovery.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

function sampler(sizes, extra = {}) {
  const calls = { over: [], doubled: [], alerts: [] };
  const s = new R.RendererMemorySampler({
    metrics: () => Object.entries(sizes).map(([pid, mb]) => ({ pid: Number(pid), type: 'Tab', memory: { privateBytes: mb * 1024 } })),
    now: () => 1,
    alert: (r) => calls.alerts.push(r),
    onOverLimit: (pid, mb) => calls.over.push([pid, mb]),
    onDoubled: (pid, mb) => calls.doubled.push([pid, mb]),
    ...extra
  });
  return { s, calls };
}

test('the watchdog acts only on the SECOND consecutive over-limit sample (the confirming sample)', () => {
  const sizes = { 7: 300 };
  const { s, calls } = sampler(sizes);
  s.sample();
  sizes[7] = 1600; s.sample();
  assert.deepEqual(calls.over, [], 'one over-limit sample: alert only, no action');
  assert.equal(calls.alerts.filter((a) => a.why === 'over-limit').length, 1);
  sizes[7] = 1700; s.sample();
  assert.deepEqual(calls.over, [[7, 1700]], 'the confirming sample acts');
});

test('a dip below the limit resets the confirmation; a pid is handed over once; a new pid starts afresh', () => {
  const sizes = { 7: 1600 };
  const { s, calls } = sampler(sizes);
  s.sample();
  sizes[7] = 1000; s.sample();
  sizes[7] = 1600; s.sample();
  assert.deepEqual(calls.over, [], 'over, under, over: not two in a row');
  s.sample(); s.sample(); s.sample();
  assert.deepEqual(calls.over.map((c) => c[0]), [7], 'acted once for pid 7, never again');
  delete sizes[7]; sizes[9] = 1600; s.sample(); s.sample();
  assert.deepEqual(calls.over.map((c) => c[0]), [7, 9], 'the recovered renderer (new pid) is watched again');
});

test('GPU and main never trigger the recovery; a throwing handler never stops sampling', () => {
  const s = new R.RendererMemorySampler({
    metrics: () => [{ pid: 1, type: 'Browser', memory: { privateBytes: 9e6 } }, { pid: 2, type: 'GPU', memory: { privateBytes: 9e6 } }, { pid: 3, type: 'Tab', memory: { privateBytes: 1700 * 1024 } }],
    now: () => 1, alert: () => {},
    onOverLimit: (pid) => { if (pid === 3) throw new Error('boom'); throw new Error(`wrong pid ${pid}`); }
  });
  assert.ok(s.sample()); assert.ok(s.sample()); assert.ok(s.sample());
});

test('onDoubled fires once per pid, when it doubles', () => {
  const sizes = { 7: 300 };
  const { s, calls } = sampler(sizes);
  s.sample(); sizes[7] = 599; s.sample();
  assert.deepEqual(calls.doubled, []);
  sizes[7] = 600; s.sample(); s.sample(); sizes[7] = 900; s.sample();
  assert.deepEqual(calls.doubled, [[7, 600]]);
});

function fakeWin(pid, { destroyed = false, throwsOnKill = false } = {}) {
  const w = { killed: 0, isDestroyed: () => destroyed,
    webContents: { id: pid * 10, isDestroyed: () => destroyed, getOSProcessId: () => pid,
      forcefullyCrashRenderer: () => { if (throwsOnKill) throw new Error('x'); w.killed += 1; } } };
  return w;
}

test('recoverRendererForMemory: kills the window whose renderer is that pid (no cooperation needed); marks the cause first', () => {
  const a = fakeWin(7); const b = fakeWin(8); const order = [];
  const out = R.recoverRendererForMemory(8, { windows: () => [a, b], givenUp: () => false, beforeKill: (w) => order.push(['mark', w.webContents.id]) });
  assert.equal(out, 'killed');
  assert.equal(b.killed, 1); assert.equal(a.killed, 0);
  assert.deepEqual(order, [['mark', 80]]);
});

test('recoverRendererForMemory: never kills a window that already gave up (it would stay dead); no window / a failed kill are reported', () => {
  const a = fakeWin(7);
  assert.equal(R.recoverRendererForMemory(7, { windows: () => [a], givenUp: () => true, beforeKill: () => {} }), 'given-up');
  assert.equal(a.killed, 0);
  assert.equal(R.recoverRendererForMemory(5, { windows: () => [a], givenUp: () => false, beforeKill: () => {} }), 'no-window');
  assert.equal(R.recoverRendererForMemory(7, { windows: () => [fakeWin(7, { destroyed: true })], givenUp: () => false, beforeKill: () => {} }), 'no-window');
  assert.equal(R.recoverRendererForMemory(7, { windows: () => [fakeWin(7, { throwsOnKill: true })], givenUp: () => false, beforeKill: () => {} }), 'failed');
});

test('the recovery loop is capped by the existing policy: kill, reload, kill, recreate, kill, give up (then no more kills)', () => {
  const policy = new R.RecoveryPolicy();
  const actions = [];
  let t = 0;
  for (let i = 0; i < 4; i += 1) { t += 30_000; actions.push(policy.onGone('killed', t).action); }
  assert.deepEqual(actions, ['reload', 'recreate', 'give-up', 'ignore']);
  assert.equal(policy.givenUp, true, 'recoverRendererForMemory then answers given-up');
});

test('probeRendererHeap: heap + DOM counters, detached after; a renderer that does not answer is skipped at the time box', async () => {
  const cmds = []; let attached = false;
  const dbg = { isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
    sendCommand: async (m) => { cmds.push(m); return m === 'Runtime.getHeapUsage' ? { usedSize: 524288000, totalSize: 629145600 } : { documents: 3, nodes: 1200, jsEventListeners: 88 }; } };
  const r = await R.probeRendererHeap(dbg, 1000);
  assert.equal(r.probe, 'ok'); assert.equal(r.jsHeapUsedMb, 500); assert.equal(r.domNodes, 1200);
  assert.equal(attached, false, 'detached again');
  const hung = { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: () => new Promise(() => {}) };
  const t0 = Date.now(); const h = await R.probeRendererHeap(hung, 200);
  assert.equal(h.probe, 'timeout'); assert.ok(Date.now() - t0 < 1500, 'bounded');
  const busy = { isAttached: () => true, attach: () => { throw new Error('no'); }, detach: () => { throw new Error('must not detach what it did not attach'); }, sendCommand: async () => { throw new Error('gone'); } };
  assert.equal((await R.probeRendererHeap(busy, 200)).probe, 'failed');
});

test('PTY traffic: chars/chunks per output chunk, resizes and redraws counted per PTY; takeTraffic returns and resets', () => {
  const src = read('src/main/pty.ts');
  assert.match(src, /if \(this\.sessions\.get\(id\) !== session\) return;\n\s+const t = this\.trafficOf\(id\); t\.chars \+= data\.length; t\.chunks \+= 1;/, 'counted only for the live session');
  assert.match(src, /this\.trafficOf\(id\)\.resizes \+= 1;\n\s+try \{\n\s+s\.proc\.resize\(cols, rows\);/);
  assert.match(src, /this\.trafficOf\(id\)\.redraws \+= 1;/);
  assert.match(src, /takeTraffic\(\)[\s\S]{0,200}const out = Object\.fromEntries\(this\.traffic\);\s*this\.traffic = new Map\(\);\s*return out;/);
});

test('MAIN WIRING: onOverLimit kills via recoverRendererForMemory and logs render-recovery-memory; the notice and crash row say memory; heap probe time-boxed and skipped over the limit; a pty-traffic row a minute with main RSS', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /onOverLimit: \(pid, mbNow\) => \{\s*const outcome = recoverRendererForMemory\(pid, \{\s*windows: \(\) => BrowserWindow\.getAllWindows\(\),\s*givenUp: \(w\) => recoveryPolicies\.get\(w\.webContents\.id\)\?\.givenUp \?\? false,\s*beforeKill: \(\) => \{ memoryRecoveryAt = Date\.now\(\); \}/);
  assert.match(idx, /kind: 'render-recovery-memory', pid, mb: mbNow, limitMb: ALERT_MB, outcome,\s*mainRssMb:/);
  assert.match(idx, /if \(mbNow >= ALERT_MB\) \{ try \{ hive\.appendLog\(\{ kind: 'renderer-memory-heap', pid, mb: mbNow, probe: 'skipped-over-limit' \}\)/);
  assert.match(idx, /void probeRendererHeap\(w\.webContents\.debugger, 5_000\)/, 'never awaited, 5 s box');
  assert.match(idx, /reason: 'memory: the view used over 1\.5 GB'/);
  assert.match(idx, /\.\.\.\(memoryCaused\(\) \? \{ cause: 'memory' \} : \{\}\)/);
  assert.match(idx, /kind: 'pty-traffic', counts, mainRssMb:/);
  assert.match(idx, /recoveryPolicies\.set\(wcId, recovery\.policy\);\s*win\.once\('closed', \(\) => \{ recoveryPolicies\.delete\(wcId\); \}\);/);
  assert.doesNotMatch(idx, /takeHeapSnapshot/, 'no full heap snapshot (it would freeze and double a GB heap)');
});
