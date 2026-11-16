'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-LATE-READY-ENOENT (int-1.1.106). A ConPTY killed before its data pipe connected could throw
 * an uncaught 'connect ENOENT \\.\pipe\conpty-...-out-worker' about a second later, and never
 * report its exit (the residual Andy and Jim named on PTY-EARLY-CLOSE-EOF).
 *
 * Chain. armEarlyKill's early close runs node-pty's `_agent.kill()`, whose conout dispose() starts
 * a 1000 ms flush timer that TERMINATES the conout worker, the only server of the '-out-worker'
 * pipe. node-pty connects the data socket whenever the worker's READY message is HANDLED on the
 * main thread (windowsPtyAgent.js onReady -> ConoutConnection.connectSocket -> socket.connect), and
 * does not look at whether the worker was terminated. A READY handled after the terminate connects
 * to a pipe that is gone. The socket has no 'error' listener then (node-pty adds its own on
 * 'ready_datapipe', i.e. after a connect), so Node throws the ENOENT from
 * PipeConnectWrap.afterConnect, outside any caller. It needs no test lever: a main thread busy for
 * that second makes the flush timer and the READY due in the same turn (seen 1 of 4 with a 1.3 s
 * stall). And with or without a READY, a worker terminated before the pipe came up leaves a
 * terminal with no exit, because node-pty reports the exit from the pipe's close.
 *
 * Levers. READY handling is delayed by `readyDelay` ms (worker_threads patched BEFORE node-pty
 * loads), which puts it after the terminate every time; one test uses no delay and blocks the main
 * thread instead. Real ConPTYs through PtyManager.spawn (which arms every terminal).
 *
 * Named mutants, each must fail this file:
 *   L1 no guard at all (the code before this card)
 *   L2 the late READY still connects (connectSocket is not gated on the terminate)
 *   L3 the exit is not reported at the terminate
 *   L4 the terminate ends the terminal even when its socket did start a connect (two exits)
 *   L5 the worker's real terminate() is not called
 *   L6 the guard is installed for a socket that was already connected at the kill
 *   L7 the terminate is not latched (a second terminate reports a second exit)
 *   L8 the socket that will never connect is not destroyed
 *   L9 the exit reported at the terminate does not carry the agent's exit code
 *   L10 a started connect is not remembered (the terminate ends a terminal whose pipe came up)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** node-pty's FLUSH_DATA_INTERVAL: kill -> worker.terminate(). Pinned against its source below. */
const FLUSH_MS = 1000;
const LATE_READY_MS = FLUSH_MS + 500;
const EARLY_READY_MS = 300;
const STALL_MS = FLUSH_MS + 300;
const CAP_MS = 10_000;

/** Settle within CAP_MS or fail: a mutant must never hang this file. */
function within(p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), CAP_MS); })])
    .finally(() => clearTimeout(t));
}
const turn = () => new Promise((res) => setImmediate(res));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

if (process.platform !== 'win32') {
  test('PTY-LATE-READY-ENOENT is a Windows ConPTY defect (inert here)', () => {});
} else {
  const wt = require('node:worker_threads');
  let readyDelay = 0;
  let onReadyHandled = () => {};
  const on0 = wt.Worker.prototype.on;
  wt.Worker.prototype.on = function (name, fn) {
    if (name !== 'message') return on0.call(this, name, fn);
    return on0.call(this, name, (msg) => {
      const run = () => { fn(msg); onReadyHandled(); };
      if (readyDelay > 0) setTimeout(run, readyDelay); else run();
    });
  };

  const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-late-ready-'));
  process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
  assert.equal(os.homedir(), JAIL, 'home is redirected before any hive object is built');
  const loadTs = require('./load-ts.cjs');
  const { armEarlyKill, PtyManager } = loadTs('src/main/pty.ts');
  const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
  const { WindowsTerminal } = require(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'));
  const ROOT = path.join(JAIL, 'root.js');
  fs.writeFileSync(ROOT, 'setInterval(() => {}, 1000);\n');

  const uncaught = [];
  process.on('uncaughtException', (e) => { uncaught.push(e); });
  const thrown = () => uncaught.map((e) => `${e.code || ''} ${e.message}`);
  const owner = { isDestroyed: () => false, send: () => {} };
  const m = new PtyManager();
  const pids = [];
  let seq = 0;

  test.after(async () => {
    await m.killAllAsync(2000).catch(() => {});
    for (const pid of pids) { try { process.kill(pid); } catch { /* gone */ } }
    try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* a pipe may still hold it */ }
  });

  /** A real silent ConPTY, with what the scenarios watch: exits, connects, the worker's terminate and end. */
  async function spawnSilent(delay) {
    readyDelay = delay;
    const id = `late-${++seq}`;
    const r = await m.spawn({ id, cwd: JAIL, command: process.execPath, args: [ROOT], cols: 80, rows: 24, env: {} }, owner);
    assert.equal(r.ok, true, `spawn: ${r.error}`);
    const proc = m.sessions.get(id).proc;
    pids.push(proc.pid);
    const sock = proc._socket;
    const worker = proc._agent._conoutSocketWorker._worker;
    const seen = { events: [], exits: 0, connects: 0 };
    proc.onExit(() => { seen.exits++; seen.events.push('exit'); });
    const connect = sock.connect;
    sock.connect = function (...a) { seen.connects++; seen.events.push('connect'); return connect.apply(this, a); };
    const readyHandled = new Promise((res) => { onReadyHandled = () => { seen.events.push('ready'); res(); }; });
    const workerEnded = new Promise((res) => worker.once('exit', () => { seen.events.push('worker-exit'); res(); }));
    const exited = new Promise((res) => proc.onExit(res));
    return { proc, sock, worker, seen, readyHandled, workerEnded, exited };
  }

  test('the lever matches node-pty: its flush interval is 1000 ms and READY connects with no look at the worker', () => {
    const src = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsConoutConnection.js'), 'utf8');
    assert.match(src, /var FLUSH_DATA_INTERVAL = 1000;/, 'the flush interval this file is timed against');
    assert.match(src, /ConoutConnection\.prototype\.connectSocket = function \(socket\) \{\s*socket\.connect\(/, 'READY -> connect, unconditionally');
    assert.match(src, /this\._worker\.terminate\(\)/, 'the flush timer terminates the worker');
  });

  test('READY handled after the worker was terminated: nothing connects, nothing is thrown, the terminal exits once', async () => {
    const s = await spawnSilent(LATE_READY_MS);
    assert.equal(typeof s.proc._agent._conoutSocketWorker.connectSocket, 'function', 'node-pty still has connectSocket');
    assert.equal(typeof s.worker.terminate, 'function', 'node-pty still has the conout worker');
    s.proc.kill();   // the armed early kill
    assert.equal(s.sock._handle, null, 'the lever holds: the kill ran before the connect');
    await within(s.exited, 'the terminal exit (reported when its pipe\'s server is terminated)');
    assert.deepEqual(s.seen.events, ['exit'], 'the exit comes at the terminate, before the late READY');
    assert.equal(s.sock.destroyed, true, 'the socket that will never connect is destroyed');
    await within(Promise.all([s.readyHandled, s.workerEnded]), 'the late READY and the worker\'s end');
    await sleep(200);   // a connect made here fails in a later turn
    assert.equal(s.seen.connects, 0, 'the late READY connected to a pipe whose server was terminated');
    assert.deepEqual(thrown(), [], 'nothing thrown outside a caller (connect ENOENT)');
    assert.equal(s.seen.exits, 1, 'exactly one exit');
    assert.equal(s.sock._handle, null, 'the socket never got a handle');
  });

  test('READY handled inside the flush second: the pipe connects and node-pty reports the one exit', async () => {
    const s = await spawnSilent(EARLY_READY_MS);
    s.proc.kill();
    assert.equal(s.sock._handle, null, 'the lever holds: the kill ran before the connect');
    await within(Promise.all([s.exited, s.workerEnded]), 'the exit and the worker\'s end');
    await turn();
    assert.equal(s.seen.connects, 1, 'a READY before the terminate still connects');
    assert.equal(s.seen.events.indexOf('connect') < s.seen.events.indexOf('exit'), true, `the exit follows the connect: ${s.seen.events}`);
    assert.equal(s.seen.exits, 1, 'exactly one exit: the terminate does not end a terminal whose pipe came up');
    assert.deepEqual(thrown(), [], 'nothing thrown outside a caller');
  });

  test('no lever: the main thread is busy for the flush second after an early kill (several terminals)', async () => {
    // The flush timer and the READY are both due when the thread comes back. Whichever runs first,
    // the terminal exits once and nothing is thrown. (Old code: ENOENT in about 1 of 4.)
    const hold = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 3; i++) {
      const s = await spawnSilent(0);
      s.proc.kill();
      assert.equal(s.sock._handle, null, 'the kill ran before the connect');
      Atomics.wait(hold, 0, 0, STALL_MS);   // blocks this thread; the worker and the ConPTY carry on
      await within(Promise.all([s.exited, s.workerEnded]), `terminal ${i}: the exit and the worker's end`);
      await sleep(100);
      assert.equal(s.seen.exits, 1, `terminal ${i}: exactly one exit (${s.seen.events})`);
      assert.deepEqual(thrown(), [], `terminal ${i}: nothing thrown outside a caller`);
    }
  });

  /** A WindowsTerminal from the REAL prototype with a recording agent, socket and conout connection. */
  function terminal({ handle }) {
    const rec = { connects: 0, terminates: 0, destroys: 0, exits: [] };
    const t = Object.create(WindowsTerminal.prototype);
    t._isReady = false;
    t._deferreds = [];
    t._socket = { readable: true, _handle: handle, destroy: () => { rec.destroys++; } };
    const worker = { terminate: () => { rec.terminates++; return Promise.resolve(0); } };
    const conn = { connectSocket: () => { rec.connects++; }, _worker: worker };
    t._agent = { kill: () => { t._socket.readable = false; }, exitCode: 7, _conoutSocketWorker: conn };
    t.emit = (name, ...a) => { if (name === 'exit') rec.exits.push(a[0]); };
    return { t, rec, conn, worker, own: { connectSocket: conn.connectSocket, terminate: worker.terminate } };
  }

  test('the guard, step by step, on the real WindowsTerminal prototype', async () => {
    // Terminate first, READY late.
    const late = terminal({ handle: null });
    assert.equal(armEarlyKill(late.t, 'win32'), true);
    late.t.kill();
    assert.deepEqual(late.rec, { connects: 0, terminates: 0, destroys: 0, exits: [] }, 'the kill alone ends nothing');
    assert.equal(await late.worker.terminate(), 0, 'the terminate\'s own result is passed on');
    assert.deepEqual(late.rec, { connects: 0, terminates: 1, destroys: 1, exits: [7] }, 'terminate: worker terminated, socket destroyed, exit reported with the agent\'s code');
    late.conn.connectSocket(late.t._socket);
    assert.equal(late.rec.connects, 0, 'a READY after the terminate connects nothing');
    await late.worker.terminate();
    assert.deepEqual(late.rec, { connects: 0, terminates: 2, destroys: 1, exits: [7] }, 'a second terminate reports no second exit');

    // READY first: the connect goes through, and the terminate then ends nothing.
    const early = terminal({ handle: null });
    armEarlyKill(early.t, 'win32');
    early.t.kill();
    early.conn.connectSocket(early.t._socket);
    assert.equal(early.rec.connects, 1, 'a READY before the terminate connects');
    // The socket's handle is null again once a connected pipe has drained and closed: that is not 'never connected'.
    await early.worker.terminate();
    assert.deepEqual(early.rec, { connects: 1, terminates: 1, destroys: 0, exits: [] }, 'a socket that started its connect is left to node-pty');

    // Connected at the kill: nothing of the connection is touched.
    const up = terminal({ handle: {} });
    armEarlyKill(up.t, 'win32');
    up.t.kill();
    assert.equal(up.conn.connectSocket, up.own.connectSocket, 'connectSocket is node-pty\'s own');
    assert.equal(up.worker.terminate, up.own.terminate, 'terminate is the worker\'s own');

    // Another node-pty (no conout connection): the early kill still runs, and nothing throws.
    const bare = terminal({ handle: null });
    delete bare.t._agent._conoutSocketWorker;
    armEarlyKill(bare.t, 'win32');
    bare.t.kill();
    assert.equal(bare.t._socket.readable, true, 'PTY-EARLY-CLOSE-EOF still holds without it');
  });
}
