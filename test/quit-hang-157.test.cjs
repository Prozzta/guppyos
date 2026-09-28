'use strict';

/**
 * QUIT-HANG (Jim's SLOW-START-FLOOR-CRASH, 2026-09-26): quitting froze the app window
 * (WER AppHangB1 x3) because teardown ran a synchronous `taskkill /T /F` per agent
 * terminal plus a synchronous memory-daemon stop, all on Electron's main thread.
 *
 *  F1 the quit path never calls spawnSync: ONE async batched taskkill for every tree,
 *     ConPTY closed only after the sweep, the daemon stop async, the whole batch capped;
 *     windows hidden first; will-quit joins the work before app.exit.
 *  F2 a Windows logoff/shutdown (`session-end`) runs the teardown without the confirm.
 *  F3 log rows: window-ready, unresponsive/responsive, render/child-process-gone,
 *     quit timings.
 *
 * child_process is faked at the module boundary; process.platform is forced to win32
 * where the Windows path is under test, so this runs the same on every OS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const procKill = loadTs('src/main/procKill.ts');
const { PtyManager } = loadTs('src/main/pty.ts');
const { runQuitSteps } = loadTs('src/main/quitTeardown.ts');

/** Source as LF (a Windows checkout with autocrlf has CRLF). */
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const INDEX = readSrc('src/main/index.ts');
const between = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `missing ${to} after ${from}`);
  return src.slice(a, b);
};

/** Force win32, fake spawn (recorded, scripted), and make any spawnSync a loud failure
 *  that also BLOCKS like the real one, so a sync call shows up in timing as well. */
function winWorld(t, { exitAfterMs = 0 } = {}) {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const spawns = [];
  const syncs = [];
  const realSpawn = cp.spawn, realSync = cp.spawnSync, realExecSync = cp.execSync, realExecFileSync = cp.execFileSync;
  cp.spawn = (bin, args, opts) => {
    const proc = new EventEmitter();
    proc.pid = 90_000 + spawns.length;
    proc.closed = false;
    spawns.push({ bin, args: [...args], opts, proc });
    if (exitAfterMs != null) setTimeout(() => { proc.closed = true; proc.emit('close', 0); }, exitAfterMs);
    return proc;
  };
  // EVERY synchronous child API is a recorded failure that also blocks like the real one. (The
  // "call returns at once" checks below are event checks, not wall-clock bounds: FLAKY-TIMING.)
  const syncTrap = (api) => (bin, args) => {
    syncs.push({ api, bin, args: Array.isArray(args) ? [...args] : [] });
    const end = Date.now() + 150; while (Date.now() < end) { /* a real sync child blocks */ }
    return api === 'spawnSync' ? { status: 0, stdout: '', stderr: '' } : '';
  };
  cp.spawnSync = syncTrap('spawnSync');
  cp.execSync = syncTrap('execSync');
  cp.execFileSync = syncTrap('execFileSync');
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSync; cp.execSync = realExecSync; cp.execFileSync = realExecFileSync; Object.defineProperty(process, 'platform', realPlatform); });
  return { spawns, syncs };
}

/** Every setTimeout delay registered from now until the test ends (the real timers still run). */
function recordTimers(t) {
  const delays = [];
  const real = global.setTimeout;
  global.setTimeout = function (fn, ms, ...rest) { delays.push(ms); return real.call(this, fn, ms, ...rest); };
  t.after(() => { global.setTimeout = real; });
  return { delays, stop: () => { global.setTimeout = real; } };
}

/** Settles before a far-away marker? (An uncapped wait loses the race; load cannot make a capped one lose it.) */
async function settlesBefore(p, markerMs = 60_000) {
  const LOST = Symbol('marker');
  let marker;
  const r = await Promise.race([p.then(() => 'settled'), new Promise((res) => { marker = setTimeout(() => res(LOST), markerMs); })]);
  clearTimeout(marker);
  return r === 'settled';
}

/** CPU time (ms) a synchronous call burns on this thread's process - load-independent. */
function cpuOf(fn) {
  const c0 = process.cpuUsage();
  const r = fn();
  const c = process.cpuUsage(c0);
  return { r, cpuMs: (c.user + c.system) / 1000 };
}
/** A synchronous call that "returns at once" spends almost no CPU (measured ~0-16 ms at Windows'
 *  15.6 ms tick); 100 ms still catches a non-child sync stall on the quit path (FLAKY-XAUDIT M2b). */
const RETURN_AT_ONCE_CPU_MS = 100;

function fakeSession(pid, log) {
  return { proc: { pid, kill: () => log.push(`kill ${pid}`) } };
}

// ── F1: the tree kill ──────────────────────────────────────────────────────

test('F1 killTreesAsync: ONE async taskkill /T /F for every tree, never spawnSync, returns at once', async (t) => {
  const w = winWorld(t, { exitAfterMs: 20 });
  const { r: p, cpuMs } = cpuOf(() => procKill.killTreesAsync([11, 22, 22, 0, -3, 1.5, 33]));
  assert.ok(cpuMs < RETURN_AT_ONCE_CPU_MS, `the call itself burns no CPU to speak of: ${cpuMs} ms`);
  // The call itself does not block: it returned while its taskkill was still running (the fake
  // closes on a 20 ms timer, which cannot fire inside a synchronous call, however busy the machine).
  assert.equal(w.spawns.length, 1, 'taskkill started');
  assert.equal(w.spawns[0].proc.closed, false, 'the call returned before its taskkill exited: it did not wait');
  assert.deepEqual(w.syncs, [], 'no synchronous child API at all');
  await p;
  assert.equal(w.syncs.length, 0, 'no spawnSync');
  assert.equal(w.spawns.length, 1, 'one batched taskkill');
  assert.equal(w.spawns[0].bin, 'taskkill');
  assert.deepEqual(w.spawns[0].args, ['/T', '/F', '/PID', '11', '/PID', '22', '/PID', '33']);
  assert.equal(w.spawns[0].opts.windowsHide, true, 'never flashes a console window');
});

test('F1 killTreesAsync: nothing to kill spawns nothing; a taskkill that never exits is capped', async (t) => {
  const w = winWorld(t, { exitAfterMs: null });
  await procKill.killTreesAsync([]);
  assert.equal(w.spawns.length, 0);
  // FLAKY-TIMING (Andy, flaky-170; FLAKY-XAUDIT nit 7): one rule for every capped wait here -
  // the lower bound is a timer (load-proof); the cap is checked by the TIMER it registers and by
  // settling at all (its taskkill never exits), not by a wall-clock upper bound.
  const timers = recordTimers(t);
  const t0 = Date.now();
  const p = procKill.killTreesAsync([44], 40);
  timers.stop();
  assert.ok(timers.delays.includes(40), `the cap is a 40 ms timer (registered: ${JSON.stringify(timers.delays)})`);
  assert.equal(await settlesBefore(p), true, 'a taskkill that never exits is capped: the call settles');
  const took = Date.now() - t0;
  assert.ok(took >= 35, `capped at ~40 ms, not earlier (took ${took})`);
});

test('F1 PtyManager.killAllAsync: one batched sweep of every tree, ConPTY closed only AFTER it, no spawnSync', async (t) => {
  const log = [];
  const w = winWorld(t, { exitAfterMs: null });
  const m = new PtyManager();
  let exits = 0;
  m.exitHandler = () => { exits++; };
  m.sessions.set('a', fakeSession(101, log));
  m.sessions.set('b', fakeSession(202, log));
  m.sessions.set('c', fakeSession(303, log));
  const { r: done, cpuMs } = cpuOf(() => m.killAllAsync(1000));
  assert.ok(cpuMs < RETURN_AT_ONCE_CPU_MS, `the call itself burns no CPU to speak of: ${cpuMs} ms`);
  // Returns without blocking the main thread: its taskkill never exits (exitAfterMs null), so a
  // call that waited for it could not have returned at all; and no synchronous child API ran.
  assert.equal(w.spawns[0].proc.closed, false, 'returned while its taskkill is still running');
  assert.deepEqual(w.syncs, [], 'no synchronous child API at all');
  assert.equal(m.sessions.size, 0, 'sessions forgotten at once');
  assert.equal(m.exitHandler, null, 'natural-exit teardown suppressed at once');
  assert.equal(w.spawns.length, 1);
  assert.deepEqual(w.spawns[0].args, ['/T', '/F', '/PID', '101', '/PID', '202', '/PID', '303']);
  assert.deepEqual(log, [], 'the trees are still intact while taskkill enumerates them');
  w.spawns[0].proc.emit('close', 0);
  await done;
  assert.deepEqual(log, ['kill 101', 'kill 202', 'kill 303']);
  assert.equal(w.syncs.length, 0);
  assert.equal(exits, 0);
});

test('F1 PtyManager.killAllAsync: a wedged taskkill still closes every ConPTY at the cap', async (t) => {
  const log = [];
  winWorld(t, { exitAfterMs: null });
  const m = new PtyManager();
  m.sessions.set('a', fakeSession(7, log));
  await m.killAllAsync(30);
  assert.deepEqual(log, ['kill 7']);
});

test('EXIT-CRASH: killAllAsync resolves only after every ConPTY exit callback (or EXIT_WAIT_MS), and reports what is still pending', async (t) => {
  const log = [];
  const w = winWorld(t, { exitAfterMs: null });
  const m = new PtyManager();
  const subs = [];
  const exitable = (pid) => {
    const listeners = [];
    return { pid, kill: () => log.push(`kill ${pid}`), onExit: (fn) => { listeners.push(fn); const d = { dispose: () => subs.push(pid) }; return d; }, fire: () => listeners.forEach((fn) => fn({ exitCode: 0 })) };
  };
  const a = exitable(1); const b = exitable(2);
  m.sessions.set('a', { proc: a }); m.sessions.set('b', { proc: b });
  let resolved = false;
  const done = m.killAllAsync(1000).then(() => { resolved = true; });
  assert.equal(m.exitsPending, 2);
  w.spawns[0].proc.emit('close', 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ['kill 1', 'kill 2'], 'killed');
  assert.equal(resolved, false, 'NOT resolved before the exits arrive (the crash was app.exit racing them)');
  a.fire();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(resolved, false); assert.equal(m.exitsPending, 1);
  b.fire();
  await done;
  assert.equal(m.exitsPending, 0);
  assert.deepEqual(subs.sort(), [1, 2], 'each one-shot listener is disposed');
});

test('EXIT-CRASH: an exit that never comes is capped at EXIT_WAIT_MS (the quit never hangs on it)', async (t) => {
  const w = winWorld(t, { exitAfterMs: null });
  const m = new PtyManager();
  assert.equal(PtyManager.EXIT_WAIT_MS, 1500);
  m.sessions.set('a', { proc: { pid: 5, kill: () => {}, onExit: () => ({ dispose() {} }) } });
  // FLAKY-TIMING (Andy, flaky-170): the same rule as the killTreesAsync cap - the lower bound is a
  // timer; the upper side is the timer that is registered (EXIT_WAIT_MS, not the 5.5 s quit cap)
  // and the wait settling at all, not `took < 3000`.
  const timers = recordTimers(t);
  const t0 = Date.now();
  const done = m.killAllAsync(1000);
  w.spawns[0].proc.emit('close', 0);
  assert.equal(await settlesBefore(done), true, 'an exit that never comes is capped: the call settles');
  timers.stop();
  const took = Date.now() - t0;
  assert.ok(timers.delays.includes(PtyManager.EXIT_WAIT_MS), `capped by an EXIT_WAIT_MS timer (registered: ${JSON.stringify(timers.delays)})`);
  assert.ok(!timers.delays.some((ms) => ms > PtyManager.EXIT_WAIT_MS && ms < 60_000), `no longer cap in play: ${JSON.stringify(timers.delays)}`);
  assert.ok(took >= 1400, `capped at EXIT_WAIT_MS, not earlier (took ${took})`);
  assert.equal(m.exitsPending, 1, 'quit-done reports the one still pending');
});

test('EXIT-CRASH wiring: quit-done carries ptyExitsPending', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /steps: \{ \.\.\.r\.steps, ptyCount: ptys, ptyExitsPending: ptyManager\.exitsPending \}/);
});

// ── F1: the bounded batch ──────────────────────────────────────────────────

test('F1 runQuitSteps: steps run concurrently, each timed, a hang is capped, a throw is recorded', async () => {
  const started = [];
  const t0 = Date.now();
  const r = await runQuitSteps([
    { name: 'fast', run: () => { started.push('fast'); return new Promise((res) => setTimeout(res, 10)); } },
    { name: 'hang', run: () => { started.push('hang'); return new Promise(() => {}); } },
    { name: 'boom', run: () => { started.push('boom'); throw new Error('x'); } }
  ], 60);
  const took = Date.now() - t0;
  assert.deepEqual(started, ['fast', 'hang', 'boom'], 'all started together');
  // The lower bound is a timer (the 60 ms cap) and so load-proof; an uncapped hang never settles
  // at all (the test times out), so no upper wall-clock bound is needed (FLAKY-TIMING).
  assert.ok(took >= 55, `bounded by the cap, not earlier (took ${took})`);
  assert.equal(r.capped, true);
  assert.equal(typeof r.steps.fast, 'number');
  assert.equal(r.steps.hang, 'pending');
  assert.equal(r.steps.boom, 'error');
});

test('F1 runQuitSteps: settles as soon as every step does (the cap is a ceiling, not a wait)', async () => {
  // Event, not wall clock (FLAKY-TIMING): with a 60 s cap, a runQuitSteps that waited for its cap
  // loses the race to a 10 s marker; one that settles when its steps do always wins it.
  const WAITED = Symbol('waited-for-the-cap');
  let marker;
  const r = await Promise.race([
    runQuitSteps([{ name: 'a', run: () => Promise.resolve() }], 60_000),
    new Promise((res) => { marker = setTimeout(() => res(WAITED), 10_000); })
  ]);
  clearTimeout(marker);
  assert.notEqual(r, WAITED, 'settled as soon as its step did, not at the cap');
  assert.equal(r.capped, false);
});

// ── F1: wiring (index.ts) ──────────────────────────────────────────────────

test('F1 WIRING: the quit path has no synchronous tree kill or daemon stop', () => {
  const teardown = between(INDEX, 'function teardownAndQuit(): void {', '/** Upper bound on the async quit work');
  assert.doesNotMatch(teardown, /ptyManager\.killAll\(\)/, 'no per-terminal spawnSync taskkill');
  assert.doesNotMatch(teardown, /memory\.stop\(/, 'no legacy memory stop (there is no daemon)');
  assert.doesNotMatch(teardown, /spawnSync|hardKillTree/);
  assert.match(teardown, /void beginQuitWork\(\)/);
  const work = between(INDEX, 'function beginQuitWork(', '\n}\n');
  assert.doesNotMatch(work, /memory\.stop\(/);
  assert.match(work, /ptyManager\.killAllAsync\(\)/);
  assert.match(work, /if \(!quitWork\)/, 'idempotent: every quit path joins one batch');
  const cap = Number(/const QUIT_WORK_CAP_MS = ([\d_]+);/.exec(INDEX)[1].replace(/_/g, ''));
  assert.ok(cap > 0 && cap <= 6_000, `bounded total (${cap} ms)`);
  const pty = readSrc('src/main/pty.ts');
  const asyncKill = between(pty, '  killAllAsync(capMs?: number): Promise<void> {', '\n  }\n');
  assert.doesNotMatch(asyncKill, /hardKillTree|spawnSync/);
});

test('F1 WIRING: windows are hidden before any teardown step', () => {
  const teardown = between(INDEX, 'function teardownAndQuit(): void {', "ipcMain.handle('app:confirmClose'");
  const hide = teardown.indexOf('w.hide()');
  assert.ok(hide > 0, 'hides every window');
  assert.ok(hide < teardown.indexOf('clearMissionTimers()'), 'first');
});

test('F1 WIRING: will-quit joins the quit work before app.exit, and logs the timings', () => {
  const flush = between(INDEX, "let analyticsFlushed = false;\napp.on('will-quit', (e) => {", '\n});\n');
  assert.match(flush, /e\.preventDefault\(\)/);
  assert.match(flush, /beginQuitWork\(\)\.then/);
  assert.match(flush, /kind: 'quit-done'/);
  assert.match(flush, /app\.exit\(0\)/);
  const first = between(INDEX, "app.on('will-quit', () => {", '\n});\n');
  assert.doesNotMatch(first, /memory\.stop\(/);
  assert.match(first, /void beginQuitWork\(\)/);
});

// ── F2 / F3 ────────────────────────────────────────────────────────────────

test('F2 WIRING: a Windows session-end skips the confirm and runs the teardown', () => {
  const health = between(INDEX, 'function watchWindowHealth(', '\n}\n');
  const end = between(health, "win.on('session-end'", '});');
  assert.match(end, /teardownAndQuit\(\)/);
  assert.match(end, /closingTime\.cancel\(\)/);
  // RENDERER-RECOVERY-164: the call now also passes the window's recovery state (partition + crash streak).
  assert.match(INDEX, /allWindows\.add\(win\);\n  watchWindowHealth\(win, isFloor, \{ partition, policy: opts\.recovery \?\? new RecoveryPolicy\(\) \}\);/, 'every window, primary and floor');
  // teardownAndQuit sets allowQuit first, so the close handler's confirm is bypassed.
  assert.match(between(INDEX, 'function teardownAndQuit(): void {', 'const t0'), /allowQuit = true;/);
});

test('F3 WIRING: freeze and slow-start rows exist', () => {
  const health = between(INDEX, 'function watchWindowHealth(', '\n}\n');
  for (const kind of ['window-ready', 'window-unresponsive', 'window-responsive', 'render-process-gone']) {
    assert.ok(health.includes(`'${kind}'`), kind);
  }
  assert.match(health, /wc\.once\('did-finish-load'/);
  assert.match(INDEX, /app\.on\('child-process-gone'[\s\S]{0,400}kind: 'child-process-gone'/);
  assert.match(INDEX, /kind: 'quit-teardown', syncMs/);
});

// ── Jim's audit (QUIT-HANG-157-AUDIT.md): R1, M10, and the normal-use sync kills ──

// The daemon's removal (1.1.59) turned R1 into Jim's M1: there is no MemoryManager; what reset and
// changeHome must wait for now is the memory engine's worker, which holds the index open.
test('R1 / M1: reset and changeHome shut the memory worker down and AWAIT it before they rm / copy', () => {
  const reset = between(INDEX, "ipcMain.handle('app:resetAll', async () => {", '\n});\n');
  const rStop = reset.indexOf('memoryStopped = nativeMemory.shutdown()');
  const rAwait = reset.indexOf('await memoryStopped;');
  const rIdx = reset.indexOf('deleteMemoryIndex(memoryIndex)');
  const rRm = reset.indexOf('rmSync(hiveDir');
  assert.ok(rStop > 0 && rAwait > rStop && rIdx > rAwait && rRm > rAwait, 'shutdown -> await -> delete the index and the hive');
  const change = between(INDEX, "ipcMain.handle('config:changeHome', async", '\n});\n');
  const cStop = change.indexOf('memoryStopped = nativeMemory.shutdown()');
  const cAwait = change.indexOf('await memoryStopped;');
  const cCopy = change.indexOf('cpSync(src');
  const cIdx = change.indexOf('deleteMemoryIndex(oldIndex)');
  assert.ok(cStop > 0 && cAwait > cStop && cCopy > cAwait && cIdx > cCopy, 'shutdown -> await -> copy -> delete the old index');
  assert.doesNotMatch(INDEX, /memory\.stop\(/, 'the legacy MemoryManager is gone');
});

test('M10: the F3 rows hang off the right Electron events', () => {
  const health = between(INDEX, 'function watchWindowHealth(', '\n}\n');
  assert.match(health, /win\.on\('unresponsive', \(\) => \{[^\n]*'window-unresponsive'/);
  assert.match(health, /win\.on\('responsive', \(\) => \{[^\n]*'window-responsive'/);
  // RENDERER-RECOVERY-164: render-process-gone is now handled by installRendererRecovery, which still
  // writes the 'render-process-gone' row (plus pid/uptime/recovery) and then recovers the window.
  assert.match(health, /installRendererRecovery\(win, \{[\s\S]*?log: \(r\) => \{ const \{ kind: _kind, \.\.\.rest \} = r; row\('render-process-gone'/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'main', 'rendererRecovery.ts'), 'utf8'), /win\.webContents\.on\('render-process-gone'[\s\S]{0,400}kind: 'render-process-gone'/);
  assert.match(health, /wc\.once\('did-finish-load', [^\n]*'window-ready'/);
  assert.match(health, /win\.on\('session-end', /);
  assert.match(INDEX, /app\.on\('child-process-gone', /);
});

test('follow-up: ensureKilled sweeps with the async batched kill, never spawnSync', async (t) => {
  const w = winWorld(t, { exitAfterMs: 5 });
  procKill.ensureKilled(5150, 10);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(w.syncs.length, 0, 'no spawnSync');
  assert.equal(w.spawns.length, 1);
  assert.deepEqual(w.spawns[0].args, ['/T', '/F', '/PID', '5150']);
});

test('follow-up: no synchronous tree kill left on normal-use paths', () => {
  // memory.ts (the legacy miner, with its mine/repair/daemon-stop timeouts) is deleted outright.
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'memory.ts')), false);
  const pk = readSrc('src/main/procKill.ts');
  const ensure = between(pk, 'export function ensureKilled(', '\n}\n');
  assert.doesNotMatch(ensure, /hardKillTree\(/);
  // UPDATED for SYNC-CHILD-CALLS: this used to pin PtyManager.killAll as the one sync sweep
  // left (reset/changeHome, accepted in the QUIT-HANG audit). SYNC-KILLALL-WHY.md measured it at
  // ~110-290 ms of frozen main thread PER terminal, so it is removed: reset and changeHome await
  // killAllAsync, and hardKillTree (its only sync taskkill) is gone from procKill.ts.
  const pty = readSrc('src/main/pty.ts');
  assert.doesNotMatch(pty, /hardKillTree\(|\n  killAll\(\) \{/);
  assert.doesNotMatch(pk, /export function hardKillTree|import \{[^}]*spawnSync/);
});
