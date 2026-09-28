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

/** A scripted DevTools session: `answers[method]` is a value, a function, or 'hang'. */
function fakeDbg(answers = {}) {
  const listeners = { message: [], detach: [] };
  const d = {
    attached: false, cmds: [],
    isAttached: () => d.attached, attach: () => { d.attached = true; }, detach: () => { d.attached = false; for (const l of listeners.detach) l({}, 'client'); },
    on: (ev, l) => { listeners[ev].push(l); },
    removeListener: () => {},
    emit: (method, params) => { for (const l of listeners.message) l({}, method, params); },
    sendCommand: (m, p) => {
      d.cmds.push(m);
      const a = answers[m];
      if (a === 'hang') return new Promise(() => {});
      if (m === 'Debugger.pause' && a === undefined) { setTimeout(() => d.emit('Debugger.paused', { callFrames: [{ functionName: 'spin', url: 'app.js', location: { lineNumber: 9 } }] }), 5); return Promise.resolve({}); }
      if (m === 'Debugger.resume') { setTimeout(() => d.emit('Debugger.resumed', {}), 1); return Promise.resolve({}); }
      if (m === 'Profiler.stop' && a === undefined) return Promise.resolve({ profile: { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, hitCount: 0, children: [2] }, { id: 2, callFrame: { functionName: 'spin', url: 'app.js', lineNumber: 9 }, hitCount: 40 }] } });
      if (m === 'Performance.getMetrics' && a === undefined) return Promise.resolve({ metrics: [{ name: 'JSHeapUsedSize', value: 524288000 }, { name: 'Nodes', value: 1200 }, { name: 'Timestamp', value: 1 }] });
      return Promise.resolve(typeof a === 'function' ? a(p) : (a ?? {}));
    }
  };
  return d;
}

test('RendererProbe: an armed capture reads metrics, the paused stack, heap/DOM, a profile; resumes every pause it took', async () => {
  const d = fakeDbg({ 'Runtime.getHeapUsage': { usedSize: 524288000, totalSize: 629145600 }, 'Memory.getDOMCounters': { documents: 3, nodes: 1200, jsEventListeners: 88 } });
  const probe = new R.RendererProbe(d);
  assert.equal(await probe.arm(), true);
  assert.deepEqual(d.cmds.slice(0, 2), ['Debugger.enable', 'Performance.enable']);
  let written = null;
  const r = await probe.capture({ sampleMs: 20, write: async (json) => { written = json; return 'C:/p.cpuprofile'; } });
  assert.equal(r.profile, 'ok', JSON.stringify(r));
  assert.deepEqual(r.metrics, { JSHeapUsedSize: 500, Nodes: 1200 });
  assert.deepEqual(r.stack, ['spin app.js:10']);
  assert.equal(r.jsHeapUsedMb, 500); assert.equal(r.domNodes, 1200);
  assert.equal(r.topSelf[0].fn, 'spin app.js:10'); assert.equal(r.file, 'C:/p.cpuprofile'); assert.ok(written);
  assert.equal(d.cmds.filter((m) => m === 'Debugger.pause').length, d.cmds.filter((m) => m === 'Debugger.resume').length, 'every pause taken is resumed');
  assert.equal(d.attached, true, 'stays armed for the next spike');
});

test('RendererProbe: a renderer that stops answering mid-capture is given up on: bounded, detached, disarmed', async () => {
  const d = fakeDbg({ 'Profiler.start': 'hang' });
  const probe = new R.RendererProbe(d);
  await probe.arm();
  const t0 = Date.now();
  const r = await probe.capture({ timeoutMs: 400, write: async () => null });
  assert.equal(r.profile, 'timeout'); assert.equal(r.gaveUp, true); assert.ok(Date.now() - t0 < 1500, 'bounded');
  assert.equal(d.attached, false, 'detached (which also resumes a paused renderer)');
  assert.equal(probe.isArmed(), false);
});

test('RendererProbe: arming a renderer that does not answer times out and detaches; a failed attach never throws', async () => {
  const d = fakeDbg({ 'Debugger.enable': 'hang' });
  const probe = new R.RendererProbe(d);
  assert.equal(await probe.arm(100), false);
  assert.equal(d.attached, false);
  const noAttach = fakeDbg(); noAttach.attach = () => { throw new Error('Another debugger is already attached'); };
  assert.equal(await new R.RendererProbe(noAttach).arm(100), false);
});

test('RendererProbe: a pause it did not request is resumed at once, unless DevTools is open (the developer pause)', async () => {
  const d = fakeDbg();
  let devtools = false;
  const probe = new R.RendererProbe(d, { devToolsOpen: () => devtools });
  await probe.arm();
  d.emit('Debugger.paused', { reason: 'other', callFrames: [] });
  assert.equal(probe.foreignResumes, 1);
  assert.equal(d.cmds.filter((m) => m === 'Debugger.resume').length, 1);
  devtools = true;
  d.emit('Debugger.paused', { reason: 'other', callFrames: [] });
  assert.equal(probe.foreignResumes, 1, 'left alone while DevTools is open');
});

test('summarizeCpuProfile: self and inclusive per function; recursion counted once per sample', () => {
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, hitCount: 0, children: [2] },
    { id: 2, callFrame: { functionName: 'outer', url: 'a.js', lineNumber: 0 }, hitCount: 10, children: [3] },
    { id: 3, callFrame: { functionName: 'outer', url: 'a.js', lineNumber: 0 }, hitCount: 30, children: [4] },
    { id: 4, callFrame: { functionName: 'leaf', url: 'a.js', lineNumber: 4 }, hitCount: 60 }
  ];
  const s = R.summarizeCpuProfile({ nodes });
  assert.equal(s.samples, 100);
  assert.deepEqual(s.self[0], { fn: 'leaf a.js:5', pct: 60 });
  assert.deepEqual(s.inclusive.find((e) => e.fn === 'outer a.js:1'), { fn: 'outer a.js:1', pct: 100 });
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
  assert.match(idx, /if \(mbNow >= ALERT_MB\) \{ try \{ hive\.appendLog\(\{ kind: 'renderer-memory-profile', pid, mb: mbNow, profile: 'skipped-over-limit' \}\)/);
  assert.match(idx, /void probe\.capture\(\{ write: \(json\) => saveRendererProfile\(join\(app\.getPath\('userData'\), 'renderer-profiles'\), pid, json\) \}\)/, 'never awaited');
  assert.match(idx, /const probe = new RendererProbe\(wc\.debugger, [\s\S]{0,200}wc\.on\('did-finish-load', \(\) => \{ void probe\.arm\(\); \}\);/, 'armed on every load of every window');
  assert.match(idx, /reason: 'memory: the view used over 1\.5 GB'/);
  assert.match(idx, /\.\.\.\(memoryCaused\(\) \? \{ cause: 'memory' \} : \{\}\)/);
  assert.match(idx, /kind: 'pty-traffic', counts, mainRssMb:/);
  assert.match(idx, /recoveryPolicies\.set\(wcId, recovery\.policy\);\s*win\.once\('closed', \(\) => \{ recoveryPolicies\.delete\(wcId\); \}\);/);
  assert.doesNotMatch(idx, /takeHeapSnapshot/, 'no full heap snapshot (it would freeze and double a GB heap)');
});
