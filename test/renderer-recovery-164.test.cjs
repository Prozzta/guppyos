'use strict';

/**
 * RENDERER-RECOVERY-164 (WHITE-SCREEN-162): a crashed renderer is brought back instead of
 * leaving the window white.
 *   1st crash -> reload after RELOAD_DELAY_MS, with a one-shot "restored" notice
 *   2nd crash within WINDOW_MS -> recreate the window once (terminals handed over)
 *   3rd crash within WINDOW_MS -> stop recovering, a dialog; the agents keep running
 * plus the Human's addendum: renderer + GPU memory every 60 s through the FAST appender,
 * the last 10 samples attached to the crash row. No crash reporter, no heartbeat.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const R = loadTs('src/main/rendererRecovery.ts');

// ── the policy ───────────────────────────────────────────────────────────────────

test('POLICY: reload, then recreate once, then give up; a quiet gap resets; clean-exit and later crashes are ignored', () => {
  const p = new R.RecoveryPolicy();
  const W = R.WINDOW_MS;
  assert.deepEqual(p.onGone('crashed', 0), { action: 'reload', streak: 1 });
  assert.deepEqual(p.onGone('crashed', W - 1), { action: 'recreate', streak: 2 });
  assert.deepEqual(p.onGone('oom', 2 * W - 2), { action: 'give-up', streak: 3 });
  assert.equal(p.givenUp, true);
  assert.equal(p.onGone('crashed', 2 * W).action, 'ignore', 'after giving up nothing is recovered again');

  const q = new R.RecoveryPolicy();
  assert.equal(q.onGone('crashed', 0).action, 'reload');
  assert.equal(q.onGone('crashed', W + 1).action, 'reload', 'a gap longer than WINDOW_MS starts a new streak');
  assert.equal(q.onGone('clean-exit', W + 2).action, 'ignore', 'clean-exit is not a crash');
  assert.equal(q.onGone('crashed', W + 3).action, 'recreate', 'and does not reset or advance the streak');
  assert.equal(R.RELOAD_DELAY_MS, 500);
  assert.equal(R.WINDOW_MS, 120000);
});

// ── the wiring, with a fake window and fake time ─────────────────────────────────

function fakeWindow(pid = 4242) {
  const wc = new EventEmitter();
  wc.reloads = 0;
  wc.destroyed = false;
  wc.reload = () => { wc.reloads += 1; };
  wc.isDestroyed = () => wc.destroyed;
  wc.getOSProcessId = () => pid;
  const win = { webContents: wc, destroyed: false, isDestroyed() { return this.destroyed; } };
  return win;
}

function rig({ quitting = false } = {}) {
  const w = { t: 1_000_000, timers: [], rows: [], notices: [], recreated: [], gaveUp: [], installs: [] };
  const policy = new R.RecoveryPolicy();
  const deps = {
    policy,
    now: () => w.t,
    setTimer: (fn, ms) => { w.timers.push({ at: w.t + ms, fn }); },
    log: (row) => w.rows.push(row),
    recreate: (old) => { const next = fakeWindow(9999); w.recreated.push({ old, next }); old.destroyed = true; return next; },
    giveUp: (win, d) => w.gaveUp.push(d),
    setNotice: (win, n) => w.notices.push({ win, n }),
    quitting: () => quitting,
    recentMemory: () => [{ at: 1, procs: [{ pid: 4242, type: 'renderer', workingSetMb: 300, privateMb: 250, uptimeS: 60 }] }],
    install: (win) => { w.installs.push(win); R.installRendererRecovery(win, deps); }
  };
  w.deps = deps;
  w.run = (ms) => {
    w.t += ms;
    for (const tm of w.timers.splice(0).sort((a, b) => a.at - b.at)) { if (tm.at <= w.t) tm.fn(); else w.timers.push(tm); }
  };
  return w;
}

test('WIRING: 1st crash reloads the SAME webContents after 500 ms, with a notice; the row carries pid, uptime and memory', () => {
  const w = rig();
  const win = fakeWindow();
  R.installRendererRecovery(win, w.deps);
  w.t += 5000;
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  assert.equal(win.webContents.reloads, 0, 'not immediately');
  w.run(499);
  assert.equal(win.webContents.reloads, 0);
  w.run(1);
  assert.equal(win.webContents.reloads, 1, 'reloaded after RELOAD_DELAY_MS');
  assert.deepEqual(w.notices.map((x) => [x.win === win, x.n.action, x.n.reason, x.n.streak]), [[true, 'reload', 'crashed', 1]]);
  const row = w.rows[0];
  assert.equal(row.kind, 'render-process-gone');
  assert.equal(row.pid, 4242);
  assert.equal(row.windowUptimeMs, 5000);
  assert.equal(row.exitCode, -36861);
  assert.equal(row.recovery, 'reload');
  assert.equal(row.recentMemory.length, 1, 'the last memory samples ride along');
});

test('WIRING: 2nd crash within 2 min recreates the window once and re-arms it; the 3rd gives up; the new window keeps the streak', () => {
  const w = rig();
  const win = fakeWindow();
  R.installRendererRecovery(win, w.deps);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  w.run(500);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  w.run(500);
  assert.equal(w.recreated.length, 1, 'recreated once');
  const next = w.recreated[0].next;
  assert.deepEqual(w.installs, [next], 'the replacement is re-armed');
  assert.equal(w.notices.at(-1).win, next, 'the notice goes to the NEW window');
  assert.equal(w.notices.at(-1).n.action, 'recreate');
  next.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  w.run(500);
  assert.equal(w.gaveUp.length, 1, 'a 3rd crash in the streak gives up');
  assert.equal(w.gaveUp[0].streak, 3);
  assert.equal(next.webContents.reloads, 0, 'and does not reload');
  assert.equal(w.recreated.length, 1, 'or recreate again');
  assert.deepEqual(w.rows.map((r) => r.recovery), ['reload', 'recreate', 'give-up']);
});

test('WIRING: clean-exit and a renderer lost during quit are logged but not recovered; a destroyed window is left alone', () => {
  const w = rig({ quitting: true });
  const win = fakeWindow();
  R.installRendererRecovery(win, w.deps);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  w.run(1000);
  assert.equal(win.webContents.reloads, 0);
  assert.equal(w.rows[0].recovery, 'ignore');

  const v = rig();
  const win2 = fakeWindow();
  R.installRendererRecovery(win2, v.deps);
  win2.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  v.run(1000);
  assert.equal(win2.webContents.reloads, 0);
  win2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  win2.destroyed = true; // the user closed it meanwhile
  v.run(1000);
  assert.equal(win2.webContents.reloads, 0, 'a window closed during the 500 ms is not touched');
});

// ── the memory sampler (the Human's addendum) ────────────────────────────────────

test('SAMPLER: renderer (Tab) + GPU only, KB -> MB, pid and uptime; one renderer-memory row per sample; ring of 10; never throws', () => {
  const rows = [];
  let t = 1_000_000;
  const metrics = [
    { pid: 1, type: 'Browser', creationTime: 0, memory: { workingSetSize: 250000, privateBytes: 240000 } },
    { pid: 7, type: 'Tab', creationTime: t - 60_000, memory: { workingSetSize: 512000, privateBytes: 409600 } },
    { pid: 8, type: 'GPU', creationTime: t - 120_000, memory: { workingSetSize: 128000 } },
    { pid: 9, type: 'Utility', memory: { workingSetSize: 1 } }
  ];
  const s = new R.RendererMemorySampler({ metrics: () => metrics, log: (r) => rows.push(r), now: () => t }); // with a log (for when it is switched on)
  const one = s.sample();
  assert.deepEqual(one.procs, [
    { pid: 7, type: 'renderer', workingSetMb: 500, privateMb: 400, uptimeS: 60 },
    { pid: 8, type: 'gpu', workingSetMb: 125, privateMb: null, uptimeS: 120 }
  ]);
  assert.deepEqual(rows[0], { kind: 'renderer-memory', procs: one.procs });
  for (let i = 0; i < 14; i += 1) { t += 60_000; s.sample(); }
  assert.equal(s.recent().length, R.KEEP_SAMPLES, 'only the last 10 are kept');
  assert.equal(s.recent()[0].at, 1_000_000 + 5 * 60_000, 'oldest first');
  const bad = new R.RendererMemorySampler({ metrics: () => { throw new Error('x'); }, log: () => { throw new Error('y'); }, now: () => t });
  assert.equal(bad.sample(), null);
  const noisy = new R.RendererMemorySampler({ metrics: () => metrics, log: () => { throw new Error('y'); }, now: () => t });
  assert.ok(noisy.sample(), 'a failing log does not stop sampling');
  assert.equal(R.SAMPLE_MS, 60_000);
});

test('SAMPLER wiring (PARKED, god 2b540e): in-memory only, NOT started, no disk row; the crash row is wired for recentMemory', () => {
  const idx = read('src/main/index.ts');
  const block = idx.slice(idx.indexOf('const rendererMemory = new RendererMemorySampler({'), idx.indexOf('function startRendererMemorySampler'));
  assert.match(block, /metrics: \(\) => app\.getAppMetrics\(\),\s*now: \(\) => Date\.now\(\)\s*\}\);/, 'no log: nothing is written');
  assert.doesNotMatch(block, /appendLog|appendFileSync|writeFileSync|openSync|fs\./, 'no file write of any kind');
  assert.equal((idx.match(/startRendererMemorySampler\(\);/g) ?? []).length, 0, 'nothing calls the sampler while it is parked');
  assert.match(idx, /recentMemory: \(\) => rendererMemory\.recent\(\),/, 'the crash row is wired (empty while parked)');
  // When it is switched on, its timer never holds the process open.
  assert.match(idx, /rendererMemoryTimer = setInterval\(\(\) => \{ rendererMemory\.sample\(\); \}, SAMPLE_MS\);\s*rendererMemoryTimer\.unref\?\.\(\);/);
  // Without a log the sampler keeps its ring and writes nothing.
  const rows = [];
  const s = new R.RendererMemorySampler({ metrics: () => [{ pid: 7, type: 'Tab', memory: { workingSetSize: 1024 } }], now: () => 1 });
  s.sample();
  assert.equal(s.recent().length, 1);
  assert.deepEqual(rows, []);
  const mod = read('src/main/rendererRecovery.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(mod, /require\(|from 'node:fs'|from 'fs'|from 'electron'/, 'the module does no I/O and imports nothing');
  assert.doesNotMatch(mod, /ipcMain|ipcRenderer|heartbeat/i, 'no renderer ping');
  assert.doesNotMatch(idx, /crashReporter\.start/, 'no crash reporter (out of scope)');
});

// ── PTY hand-over for a recreated window ─────────────────────────────────────────

test('PTY: reassignOwner moves every session of the old window (and the default sink) to the new one; others untouched', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  const oldWc = { id: 1, isDestroyed: () => false, send() {} };
  const newWc = { id: 2, isDestroyed: () => false, sent: [], send(ch, p) { this.sent.push([ch, p]); } };
  const floorWc = { id: 3, isDestroyed: () => false, send() {} };
  pm.attachWebContents(oldWc);
  pm.sessions.set('pty-god', { owner: oldWc });
  pm.sessions.set('pty-jim', { owner: null });
  pm.sessions.set('pty-floor', { owner: floorWc });
  assert.equal(pm.reassignOwner(oldWc, newWc), 1);
  assert.equal(pm.sessions.get('pty-god').owner, newWc);
  assert.equal(pm.sessions.get('pty-floor').owner, floorWc);
  assert.equal(pm.countByOwner(oldWc), 0, 'closing the old window can reach nothing');
  // The unowned session routes to the default sink, which moved too.
  pm.safeSend('pty:data:pty-jim', 'hi', null);
  assert.deepEqual(newWc.sent, [['pty:data:pty-jim', 'hi']]);
});

test('MAIN WIRING: recreate hands terminals over BEFORE destroying the old window; destroy (not close) skips the quit warning', () => {
  const idx = read('src/main/index.ts');
  const fn = idx.slice(idx.indexOf('function recreateWindowAfterCrash('), idx.indexOf("app.on('child-process-gone'"));
  const iCreate = fn.indexOf('createWindow({ floor: isFloor, partition: recovery.partition, recovery: recovery.policy })');
  const iMove = fn.indexOf('ptyManager.reassignOwner(old.webContents, next.webContents)');
  const iDestroy = fn.indexOf('old.destroy()');
  assert.ok(iCreate > 0 && iMove > iCreate && iDestroy > iMove, 'create -> hand over -> destroy');
  assert.doesNotMatch(fn, /old\.close\(\)/);
  assert.match(idx, /const partition = isFloor \? \(opts\.partition \?\? `persist:floor-\$\{\+\+floorSeq\}`\) : undefined;/, 'a recreated floor keeps its partition');
  assert.match(idx, /watchWindowHealth\(win, isFloor, \{ partition, policy: opts\.recovery \?\? new RecoveryPolicy\(\) \}\);/, 'the streak carries over');
  assert.match(idx, /ipcMain\.handle\('window:takeRecoveryNotice', \(evt\) => \{\s*const n = recoveryNotices\.get\(evt\.sender\.id\) \?\? null;\s*recoveryNotices\.delete\(evt\.sender\.id\);/, 'the notice is one-shot per window');
  assert.match(idx, /if \(!details\.isMainFrame\) return;\s*rendererReadyForHires = false;\s*\/\/[^\n]*\n\s*try \{ capacityDetailTicker\.closed\(wc\.id\); \}/, 'a reload drops the dead view\'s capacity subscriptions');
  // No per-reload main listeners: recovery is installed once per window (createWindow).
  assert.equal((idx.match(/installRendererRecovery\(/g) ?? []).length, 1);
  assert.equal((idx.match(/watchWindowHealth\(win, isFloor/g) ?? []).length, 1);
});
