'use strict';

/**
 * RENDERER-RECOVERY-164 (WHITE-SCREEN-162): a crashed renderer is brought back instead of
 * leaving the window white.
 *   1st crash -> reload after RELOAD_DELAY_MS, with a one-shot "restored" notice
 *   2nd crash within WINDOW_MS -> recreate the window once (terminals handed over)
 *   3rd crash within WINDOW_MS -> stop recovering, a dialog; the agents keep running
 * plus the Human's final scope: LOCAL crash dumps (uploadToServer:false, pruned to 3, the dump
 * path in the crash row) and an in-memory ring of renderer/GPU memory (one alert row only), and
 * Jim's RR-164 audit: a recovered view skips the HivePicker, the app can still quit when the
 * renderer is gone, and the recreate order is tested by behaviour. No heartbeat, no IPC ping.
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

test('SAMPLER wiring (final): in-memory ring started after the first window; the ONLY row is the alert, via hive.appendLog', () => {
  const idx = read('src/main/index.ts');
  const block = idx.slice(idx.indexOf('const rendererMemory = new RendererMemorySampler({'), idx.indexOf('function startRendererMemorySampler'));
  assert.match(block, /metrics: \(\) => app\.getAppMetrics\(\),\s*now: \(\) => Date\.now\(\),\s*alert: \(row\) => \{ try \{ hive\.appendLog\(row\); \}/, 'alerts go through the kept-open fast appender');
  assert.doesNotMatch(block, /\blog:/, 'no per-sample row');
  assert.doesNotMatch(block, /appendFileSync|writeFileSync|openSync|fs\./, 'no direct file write');
  assert.match(idx, /startRendererMemorySampler\(\);\s*void pruneDumps\([\s\S]{0,400}\}\)\.catch\(\(\) => \{ \/\* best-effort \*\/ \}\);\s*createWindow\(\);/, 'started once at startup, beside the first window');
  assert.match(idx, /rendererMemoryTimer = setInterval\(\(\) => \{ rendererMemory\.sample\(\); \}, SAMPLE_MS\);\s*rendererMemoryTimer\.unref\?\.\(\);/);
  assert.match(idx, /recentMemory: \(\) => rendererMemory\.recent\(\),/, 'the ring is flushed into the crash row');
  const hive = read('src/main/hive.ts');
  const append = hive.slice(hive.indexOf('  appendLog(event: Record<string, unknown>): void {'), hive.indexOf('  appendLog(event: Record<string, unknown>): void {') + 500);
  assert.match(append, /this\.appendFileFor\(join\(root, 'log\.jsonl'\), LOG_KEEP_ROTATED\)\.append\(line\);/, 'hive.appendLog is the kept-open AppendFile path');
  const mod = read('src/main/rendererRecovery.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(mod, /require\(|from 'node:fs'|from 'fs'|from 'electron'/, 'the recovery module does no I/O and imports nothing');
  assert.doesNotMatch(mod, /ipcMain|ipcRenderer|heartbeat/i, 'no renderer ping');
});

test('SAMPLER alerts: ONE row per renderer per condition (over 1.5 GB, or 2x its first sample); GPU never alerts; nothing else is written', () => {
  assert.equal(R.ALERT_MB, 1536); assert.equal(R.ALERT_FACTOR, 2);
  const alerts = [];
  let mbR = 400; let mbR2 = 1600; let mbG = 5000;
  const metrics = () => [
    { pid: 7, type: 'Tab', memory: { privateBytes: mbR * 1024 } },
    { pid: 8, type: 'Tab', memory: { privateBytes: mbR2 * 1024 } },
    { pid: 9, type: 'GPU', memory: { privateBytes: mbG * 1024 } }
  ];
  const s = new R.RendererMemorySampler({ metrics, now: () => 1, alert: (r) => alerts.push(r) });
  s.sample();
  assert.deepEqual(alerts.map((a) => [a.pid, a.why]), [[8, 'over-limit']], 'pid 8 starts over the limit; GPU is ignored');
  mbR = 799; s.sample();
  assert.equal(alerts.length, 1, 'just under double: nothing');
  mbR = 800; s.sample(); s.sample();
  assert.deepEqual(alerts.map((a) => [a.pid, a.why]), [[8, 'over-limit'], [7, 'doubled']], 'doubled once, not every sample');
  mbR = 1600; s.sample(); s.sample();
  assert.deepEqual(alerts.map((a) => [a.pid, a.why]), [[8, 'over-limit'], [7, 'doubled'], [7, 'over-limit']]);
  assert.equal(alerts[1].firstMb, 400); assert.equal(alerts[1].kind, 'renderer-memory-alert');
  assert.ok(Array.isArray(alerts[1].recent) && alerts[1].recent.length > 0, 'the alert carries the ring so far');
});

test('CRASH DUMPS: local only (uploadToServer false, no submit URL); prune keeps the newest 3; waitForDump finds the new one or gives up', async () => {
  const D = loadTs('src/main/crashDumps.ts');
  const calls = [];
  const res = D.startLocalCrashReporter({ start: (o) => calls.push(o) }, (() => { let t = 100; return () => (t += 2); })());
  assert.deepEqual(calls, [{ uploadToServer: false, compress: true }], 'no submitURL, uploads off');
  assert.equal(res.ok, true); assert.equal(res.readyAt - res.startedAt, 2);
  assert.equal(D.startLocalCrashReporter({ start: () => { throw new Error('boom'); } }).ok, false, 'never throws');
  // A fake Crashpad tree: reports/ with 5 dumps, pending/ with 1, and a non-dump.
  const files = new Map([
    ['C/reports/a.dmp', 1000], ['C/reports/b.dmp', 5000], ['C/reports/c.dmp', 3000], ['C/reports/d.dmp', 4000],
    ['C/reports/e.dmp', 2000], ['C/pending/f.dmp', 6000], ['C/settings.dat', 9999]
  ]);
  const norm = (p) => p.replace(/\\/g, '/');
  const fake = {
    readdir: async (dir) => {
      const d = norm(dir); const kids = new Set();
      for (const k of files.keys()) if (k.startsWith(d + '/')) kids.add(k.slice(d.length + 1).split('/')[0]);
      return [...kids].map((name) => ({ name, isDirectory: () => ![...files.keys()].includes(d + '/' + name), isFile: () => [...files.keys()].includes(d + '/' + name) }));
    },
    stat: async (p) => ({ mtimeMs: files.get(norm(p)), size: 42 }),
    unlink: async (p) => { files.delete(norm(p)); }
  };
  const gone = (await D.pruneDumps('C', 3, fake)).map(norm).sort();
  assert.deepEqual(gone, ['C/reports/a.dmp', 'C/reports/e.dmp', 'C/reports/c.dmp'].sort(), 'the 3 oldest deleted');
  assert.deepEqual([...files.keys()].filter((k) => k.endsWith('.dmp')).sort(), ['C/pending/f.dmp', 'C/reports/b.dmp', 'C/reports/d.dmp']);
  assert.ok(files.has('C/settings.dat'), 'non-dumps are never touched');
  const hit = await D.waitForDump('C', 5500, { tries: 2, sleep: async () => {} }, fake);
  assert.equal(norm(hit.path), 'C/pending/f.dmp');
  assert.equal(await D.waitForDump('C', 99999, { tries: 3, sleep: async () => {} }, fake), null, 'no dump appears -> null');
});

test('CRASH ROW: with findDump the row waits for the dump (the recovery does not), and carries dumpPath / crashedAt', async () => {
  const w = rig();
  let resolveDump;
  w.deps.findDump = () => new Promise((r) => { resolveDump = r; });
  const win = fakeWindow();
  R.installRendererRecovery(win, w.deps);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  w.run(500);
  assert.equal(win.webContents.reloads, 1, 'recovered at 500 ms without waiting for the dump');
  assert.equal(w.rows.length, 0, 'the row waits for the dump');
  resolveDump({ path: 'C:/x/Crashpad/reports/abc.dmp', size: 123 });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0].dumpPath, 'C:/x/Crashpad/reports/abc.dmp');
  assert.equal(w.rows[0].dumpBytes, 123);
  assert.equal(typeof w.rows[0].crashedAt, 'number');
  // No dump: the row is still written, with dumpPath null.
  const v = rig(); v.deps.findDump = async () => null;
  const win2 = fakeWindow(); R.installRendererRecovery(win2, v.deps);
  win2.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  await new Promise((r) => setImmediate(r));
  assert.equal(v.rows[0].dumpPath, null);
});

test('WIRING: the reporter starts as early as the paths are final, local only; dumps pruned async after the first window; marks on startup-timing', () => {
  const idx = read('src/main/index.ts');
  const iSmoke = idx.indexOf("app.setPath('sessionData', smokeUserData);");
  const iStart = idx.indexOf('const crashReporterStart = startLocalCrashReporter(crashReporter);');
  const iLock = idx.indexOf('const gotInstanceLock = app.requestSingleInstanceLock();');
  const iDevPaths = idx.indexOf("app.setPath('crashDumps', crashDir);");
  assert.ok(iDevPaths > 0 && iSmoke > iDevPaths && iStart > iSmoke && iLock > iStart, 'after the dev/smoke path setup, before the single-instance lock and any window');
  assert.doesNotMatch(idx, /crashReporter\.start\(/, 'only through startLocalCrashReporter (which passes uploadToServer:false)');
  assert.doesNotMatch(idx, /submitURL/);
  assert.match(idx, /void pruneDumps\(app\.getPath\('crashDumps'\), KEEP_DUMPS\)\.then\(/, 'prune is async, not awaited on the startup path');
  assert.match(idx, /findDump: async \(since\) => \{\s*const dump = await waitForDump\(app\.getPath\('crashDumps'\), since, \{ exclude: attributedDumps \}\);/);
  assert.match(idx, /startupTiming\.mark\('crash-reporter-start', undefined, crashReporterStart\.startedAt\);\s*startupTiming\.mark\('crash-reporter-ready', undefined, crashReporterStart\.readyAt\);/);
  const dumps = read('src/main/crashDumps.ts');
  assert.doesNotMatch(dumps.replace(/\/\*[\s\S]*?\*\//g, ''), /Sync\(/, 'crashDumps.ts uses no synchronous fs call');
  assert.match(read('src/main/startupTiming.ts'), /'crash-reporter-start', 'crash-reporter-ready'\] as const;/);
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
  assert.match(fn, /return performRecreate<BrowserWindow>\(old, \{/, 'the order lives in performRecreate (tested by behaviour)');
  assert.match(fn, /create: \(\) => \{\s*const next = createWindow\(\{ floor: isFloor, partition: recovery\.partition, recovery: recovery\.policy \}\);/);
  assert.match(fn, /reassign: \(from, to\) => ptyManager\.reassignOwner\(from\.webContents, to\.webContents\),/);
  assert.match(fn, /getMain: \(\) => mainWindow,\s*setMain: \(w\) => \{ mainWindow = w; \},\s*destroy: \(w\) => \{ try \{ w\.destroy\(\); \}/);
  assert.doesNotMatch(fn, /\.close\(\)/);
  assert.match(idx, /const partition = isFloor \? \(opts\.partition \?\? `persist:floor-\$\{\+\+floorSeq\}`\) : undefined;/, 'a recreated floor keeps its partition');
  assert.match(idx, /watchWindowHealth\(win, isFloor, \{ partition, policy: opts\.recovery \?\? new RecoveryPolicy\(\) \}\);/, 'the streak carries over');
  assert.match(idx, /ipcMain\.handle\('window:takeRecoveryNotice', \(evt\) => \{\s*const n = recoveryNotices\.get\(evt\.sender\.id\) \?\? null;\s*recoveryNotices\.delete\(evt\.sender\.id\);/, 'the notice is one-shot per window');
  assert.match(idx, /if \(!details\.isMainFrame\) return;\s*rendererReadyForHires = false;\s*\/\/[^\n]*\n\s*try \{ capacityDetailTicker\.closed\(wc\.id\); \}/, 'a reload drops the dead view\'s capacity subscriptions');
  // No per-reload main listeners: recovery is installed once per window (createWindow).
  assert.equal((idx.match(/installRendererRecovery\(/g) ?? []).length, 1);
  assert.equal((idx.match(/watchWindowHealth\(win, isFloor/g) ?? []).length, 1);
});

// ── Jim's RR-164 audit ─────────────────────────────────────────────────────────

test('AUDIT M6: the 2-minute boundary is inclusive (a crash exactly WINDOW_MS after the last still counts)', () => {
  const p = new R.RecoveryPolicy();
  assert.equal(p.onGone('crashed', 0).action, 'reload');
  assert.equal(p.onGone('crashed', R.WINDOW_MS).action, 'recreate', 'gap == WINDOW_MS continues the streak');
  const q = new R.RecoveryPolicy();
  q.onGone('crashed', 0);
  assert.equal(q.onGone('crashed', R.WINDOW_MS + 1).action, 'reload', 'one ms more starts a new one');
});

test('AUDIT M11/M19 (behaviour): performRecreate creates FIRST, hands over, repoints the main pointer (a focused floor too), destroys LAST', () => {
  const run = (mainIs) => {
    const calls = [];
    const old = { name: 'old' }; const other = { name: 'other' };
    let main = mainIs === 'old' ? old : other;
    const next = R.performRecreate(old, {
      create: () => { calls.push('create'); return { name: 'next' }; },
      reassign: (from, to) => { calls.push(`reassign:${from.name}->${to.name}`); return 3; },
      getMain: () => main,
      setMain: (w) => { calls.push(`setMain:${w.name}`); main = w; },
      destroy: (w) => { calls.push(`destroy:${w.name}`); },
      log: (row) => calls.push(`log:${row.ptysMoved}`)
    });
    return { calls, main: main.name, next: next.name };
  };
  const a = run('old');
  assert.deepEqual(a.calls, ['create', 'reassign:old->next', 'log:3', 'setMain:next', 'destroy:old']);
  assert.equal(a.main, 'next', 'the main-window pointer follows the recreated window (a focused floor included)');
  const b = run('other');
  assert.deepEqual(b.calls, ['create', 'reassign:old->next', 'log:3', 'destroy:old'], 'a pointer to another window is left alone');
  assert.equal(b.main, 'other');
});

test('AUDIT M21: a window destroyed during the recreate delay is not recreated', () => {
  const w = rig();
  const win = fakeWindow();
  R.installRendererRecovery(win, w.deps);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  w.run(500);
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -36861 });
  win.destroyed = true; // closed by the user during the 500 ms
  w.run(500);
  assert.equal(w.recreated.length, 0);
});

test('AUDIT M22: KEEP_DUMPS is 3 and pruneDumps keeps KEEP_DUMPS by default', async () => {
  const D = loadTs('src/main/crashDumps.ts');
  assert.equal(D.KEEP_DUMPS, 3);
  const files = new Map([['C/a.dmp', 1], ['C/b.dmp', 2], ['C/c.dmp', 3], ['C/d.dmp', 4], ['C/e.dmp', 5]]);
  const norm = (p) => p.replace(/\\/g, '/');
  const fake = {
    readdir: async () => [...files.keys()].map((k) => ({ name: k.slice(2), isDirectory: () => false, isFile: () => true })),
    stat: async (p) => ({ mtimeMs: files.get(norm(p)), size: 1 }),
    unlink: async (p) => { files.delete(norm(p)); }
  };
  await D.pruneDumps('C', undefined, fake);
  assert.deepEqual([...files.keys()].sort(), ['C/c.dmp', 'C/d.dmp', 'C/e.dmp']);
});

test('AUDIT LOW: a dump is matched to ITS crash: inside the time window, nearest wins, never one already attributed', async () => {
  const D = loadTs('src/main/crashDumps.ts');
  const t = 1_000_000;
  const files = new Map([['C/old.dmp', t - 60_000], ['C/prev.dmp', t - 500], ['C/mine.dmp', t + 300], ['C/late.dmp', t + 60_000]]);
  const norm = (p) => p.replace(/\\/g, '/');
  const fake = {
    readdir: async () => [...files.keys()].map((k) => ({ name: k.slice(2), isDirectory: () => false, isFile: () => true })),
    stat: async (p) => ({ mtimeMs: files.get(norm(p)), size: 1 }),
    unlink: async () => {}
  };
  const opts = { tries: 1, sleep: async () => {} };
  assert.equal(norm((await D.waitForDump('C', t, opts, fake)).path), 'C/mine.dmp', 'nearest to the crash, not merely the newest');
  assert.equal(norm((await D.waitForDump('C', t, { ...opts, exclude: new Set([path.join('C', 'mine.dmp')]) }, fake)).path), 'C/prev.dmp');
  assert.equal(await D.waitForDump('C', t, { ...opts, exclude: new Set([path.join('C', 'mine.dmp'), path.join('C', 'prev.dmp')]) }, fake), null, 'old/late dumps are outside the window');
  const idx = read('src/main/index.ts');
  assert.match(idx, /waitForDump\(app\.getPath\('crashDumps'\), since, \{ exclude: attributedDumps \}\);\s*if \(dump\) attributedDumps\.add\(dump\.path\);/);
});

test('AUDIT (1) wiring: the recovered page learns it synchronously at load and App skips the picker', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /ipcMain\.on\('window:recoveringSync', \(evt\) => \{ evt\.returnValue = recoveryNotices\.has\(evt\.sender\.id\); \}\);/);
  assert.match(read('src/preload/index.ts'), /recovering: \(\(\): boolean => \{ try \{ return ipcRenderer\.sendSync\('window:recoveringSync'\) === true; \} catch \{ return false; \} \}\)\(\),/);
  assert.match(read('src/renderer/src/App.tsx'), /useState<boolean>\(\(\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(window\.cth\?\.recovering === true\) return true;/);
  // The notice is set BEFORE the reload / right after the recreate, so the flag is true at load.
  const mod = read('src/main/rendererRecovery.ts');
  assert.match(mod, /deps\.setNotice\(win, \{ at, action: 'reload'[^\n]*\);\s*try \{ win\.webContents\.reload\(\); \}/);
});

test('AUDIT (2) wiring: with the renderer gone, close and before-quit ask natively; the give-up dialog can quit', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /if \(rendererGone\(wc\)\) \{ quitOrCancelNatively\(count, win\); return; \}\s*win\.focus\(\);\s*wc\.send\('app:closeRequested'/);
  assert.match(idx, /if \(rendererGone\(mainWindow\.webContents\)\) \{ quitOrCancelNatively\(count, mainWindow\); return; \}/);
  assert.match(idx, /\} else quitOrCancelNatively\(count, null\);/, 'no window at all: still quittable');
  // Jim LOW: the same effects as the renderer modal (app:confirmClose / app:cancelClose).
  assert.match(idx, /function quitOrCancelNatively\(ptyCount: number, parent: BrowserWindow \| null\): void \{\s*if \(confirmQuitNatively\(ptyCount, parent\)\) \{\s*try \{ closingTime\.cancel\(\); \}[^\n]*\n\s*teardownAndQuit\(\);\s*\} else \{\s*abortPendingRestart\(\);/);
  assert.match(idx, /function rendererGone\(wc: Electron\.WebContents\): boolean \{\s*try \{ return wc\.isDestroyed\(\) \|\| wc\.isCrashed\(\); \} catch \{ return true; \}/);
  assert.match(idx, /buttons: \['Quit now', 'Keep agents running'\],[\s\S]{0,120}\.then\(\(r\) => \{ if \(r\.response === 0\) teardownAndQuit\(\); \}\)/);
});

test('AUDIT M24: the dump NEAREST the crash wins, even when a newer dump inside the window exists', async () => {
  const D = loadTs('src/main/crashDumps.ts');
  const t = 5_000_000;
  const files = new Map([['C/near.dmp', t + 100], ['C/newer.dmp', t + 1_900]]);
  const norm = (p) => p.replace(/\\/g, '/');
  const fake = {
    readdir: async () => [...files.keys()].map((k) => ({ name: k.slice(2), isDirectory: () => false, isFile: () => true })),
    stat: async (p) => ({ mtimeMs: files.get(norm(p)), size: 1 }),
    unlink: async () => {}
  };
  const hit = await D.waitForDump('C', t, { tries: 1, sleep: async () => {} }, fake);
  assert.equal(norm(hit.path), 'C/near.dmp', 'nearest to the crash time, not the newest file');
});
