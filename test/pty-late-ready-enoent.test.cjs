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
 *   A7 (Jim) the exit code is read when the guard is installed, not at the terminate
 *   W1 the missing-guard line is said for every terminal; W2 it is never said
 *
 * PTY-LATE-READY-EXIT-107 (found by TEST-TEMP-LEAK-UNDER-LOAD: 1 to 2 runs in 144 under load timed
 * out in "READY handled inside the flush second" with no terminal exit). node-pty's agent has a
 * second 1000 ms timer, `_closeTimeout`, armed when the root process exits; its `_cleanUpProcess`
 * destroys the data socket. node-pty adds the 'close' listener that reports the exit only on the
 * socket's 'connect' event. Under load the READY is handled about a second after the kill, in the
 * turn that timer is due: the socket is destroyed between connect() and 'connect', no error, no
 * 'connect', no listener, no exit. Lever: `_cleanUpProcess()` is called in the turn the READY is
 * handled, which is that order every time. Mutants, each must fail this file:
 *   X1 a started connect is not watched (the code before this card)
 *   X2 the close reports an exit even after 'connect' came (two exits, with node-pty's own)
 *   X3 the close is watched with on, not once (a second close reports a second exit)
 *   X4 the early close's exit does not carry the agent's exit code
 *   X5 the socket is watched from the kill, not from its connect (the terminate's destroy reports twice)
 *
 * A worker this file leaks would keep the process alive with every test passed; FILE_CAP_MS ends
 * it as a failure instead (Jim's A6/A8 hung the file).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/** node-pty's FLUSH_DATA_INTERVAL: kill -> worker.terminate(). Pinned against its source below. */
const FLUSH_MS = 1000;
const LATE_READY_MS = FLUSH_MS + 500;
const EARLY_READY_MS = 300;
const STALL_MS = FLUSH_MS + 300;
const CAP_MS = 10_000;
/** The whole file. Unref'd: it only ever fires in a process that something else keeps alive. */
const FILE_CAP_MS = 120_000;
/** Every terminal this file spawned, as { id, state() }: what the file cap names. */
const terminals = [];
setTimeout(() => {
  process.stderr.write(`pty-late-ready-enoent: still running after ${FILE_CAP_MS} ms: a worker or a socket was leaked
  kept alive by: ${process.getActiveResourcesInfo().join(', ')}
${terminals.map((t) => `  ${t.id}: ${t.state()}`).join('\n')}
`);
  process.exit(1);
}, FILE_CAP_MS).unref();

/** Settle within CAP_MS or fail: a mutant must never hang this file. */
function within(p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), CAP_MS); })])
    .finally(() => clearTimeout(t));
}
/**
 * Every named event within CAP_MS, or fail NAMING the ones that never came, with what the terminal
 * did see (TEST-TEMP-LEAK-UNDER-LOAD: "timed out: the exit and the worker's end" did not say which).
 */
function withinAll(parts, s, what) {
  const pending = new Set(Object.keys(parts));
  const all = Promise.all(Object.entries(parts).map(([name, p]) => p.then(() => { pending.delete(name); })));
  let t;
  return Promise.race([all, new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timed out: ${what}: never came: ${[...pending].join(', ')}; ${s.state()}`)), CAP_MS);
  })]).finally(() => clearTimeout(t));
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
  const { holdRoot, rootHandoff } = loadTs('src/main/procIdentity.ts');
  const { awaitHeldExit } = require('./tools/await-exit.cjs');
  const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
  const { WindowsTerminal } = require(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'));
  const ROOT = path.join(JAIL, 'root.js');
  fs.writeFileSync(ROOT, 'setInterval(() => {}, 1000);\n');

  const uncaught = [];
  process.on('uncaughtException', (e) => { uncaught.push(e); });
  const thrown = () => uncaught.map((e) => `${e.code || ''} ${e.message}`);
  const owner = { isDestroyed: () => false, send: () => {} };
  const m = new PtyManager();
  let seq = 0;

  // TEST-TEMP-LEAK-UNDER-LOAD: each root is held by handle from its spawn (its pid stays its own, so
  // the kill below can never reach a stranger), and the jail is removed only once every root has
  // EXITED: killAllAsync waits for node-pty's exit report, not the process, and a root still exiting
  // under suite load held the jail (EPERM, swallowed: TEMP LEAK). A root that will not exit, or a jail
  // that still will not go, fails this hook, naming it.
  const holds = [];
  test.after(async () => {
    await m.killAllAsync(2000).catch(() => {});
    for (const { pid } of holds) { try { process.kill(pid); } catch { /* gone */ } }
    try { await awaitHeldExit(holds); } finally { for (const h of holds) h.hold.release(); }
    fs.rmSync(JAIL, { recursive: true, force: true });
  });

  /** A real silent ConPTY, with what the scenarios watch: exits, connects, the worker's terminate and end. */
  async function spawnSilent(delay) {
    readyDelay = delay;
    const id = `late-${++seq}`;
    const r = await m.spawn({ id, cwd: JAIL, command: process.execPath, args: [ROOT], cols: 80, rows: 24, env: {} }, owner);
    assert.equal(r.ok, true, `spawn: ${r.error}`);
    const proc = m.sessions.get(id).proc;
    const hold = holdRoot(proc.pid, 'win32', rootHandoff(proc));
    assert.ok(hold, 'the root is held by handle (resources/fs-handle built)');
    holds.push({ pid: proc.pid, hold });
    const sock = proc._socket;
    const worker = proc._agent._conoutSocketWorker._worker;
    const seen = { events: [], exits: 0, connects: 0 };
    const t0 = Date.now();
    const at = [];
    const note = (name) => { at.push(`${name}@${Date.now() - t0}`); seen.events.push(name); };
    proc.onExit(() => { seen.exits++; note('exit'); });
    const connect = sock.connect;
    sock.connect = function (...a) { seen.connects++; note('connect'); return connect.apply(this, a); };
    const readyHandled = new Promise((res) => { onReadyHandled = () => { note('ready'); res(); }; });
    const workerEnded = new Promise((res) => worker.once('exit', () => { note('worker-exit'); res(); }));
    const exited = new Promise((res) => proc.onExit(res));
    sock.on('end', () => { at.push(`socket-end@${Date.now() - t0}`); });
    sock.on('close', () => { at.push(`socket-close@${Date.now() - t0}`); });
    /** What this terminal has seen so far, for a wait that timed out. */
    const state = () => `seen [${at.join(' ')}] ${Date.now() - t0} ms after the spawn; root ${hold.alive() ? 'running' : 'exited'}; `
      + `agent exit code ${proc._agent.exitCode}; socket destroyed=${sock.destroyed} connecting=${sock.connecting} `
      + `handle=${sock._handle ? 'open' : 'none'} readable=${sock.readable} flowing=${sock.readableFlowing} `
      + `ended=${sock.readableEnded}; thrown [${thrown().join(' | ')}]`;
    terminals.push({ id, state });
    return { proc, sock, worker, seen, readyHandled, workerEnded, exited, state };
  }

  test('the lever matches node-pty: its flush interval is 1000 ms and READY connects with no look at the worker', () => {
    const src = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsConoutConnection.js'), 'utf8');
    assert.match(src, /var FLUSH_DATA_INTERVAL = 1000;/, 'the flush interval this file is timed against');
    assert.match(src, /ConoutConnection\.prototype\.connectSocket = function \(socket\) \{\s*socket\.connect\(/, 'READY -> connect, unconditionally');
    assert.match(src, /this\._worker\.terminate\(\)/, 'the flush timer terminates the worker');
    // PTY-LATE-READY-EXIT-107: the agent's own close timer, and where node-pty learns of the exit.
    const agent = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsPtyAgent.js'), 'utf8');
    assert.match(agent, /this\._closeTimeout = setTimeout\(function \(\) \{ return _this\._cleanUpProcess\(\); \}, FLUSH_DATA_INTERVAL\);/, 'the agent\'s close timer');
    assert.match(agent, /_cleanUpProcess = function \(\) \{[^}]*\}\s*this\._inSocket\.readable = false;\s*this\._outSocket\.readable = false;\s*this\._outSocket\.destroy\(\);/, 'which destroys the data socket');
    assert.match(agent, /this\._outSocket\.on\('connect', function \(\) \{\s*_this\._outSocket\.emit\('ready_datapipe'\);/, 'ready_datapipe comes from the socket\'s connect event');
    const term = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'), 'utf8');
    assert.match(term, /_this\._socket\.on\('ready_datapipe', function \(\) \{[\s\S]*?_this\._socket\.on\('close', function \(\) \{\s*_this\.emit\('exit', _this\._agent\.exitCode\);/, 'the exit is reported by a close listener added on ready_datapipe');
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
    await withinAll({ 'the late READY': s.readyHandled, 'the worker\'s end': s.workerEnded }, s, 'READY after the terminate');
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
    await withinAll({ 'the terminal exit': s.exited, 'the worker\'s end': s.workerEnded }, s, 'READY inside the flush second');
    await turn();
    assert.equal(s.seen.connects, 1, 'a READY before the terminate still connects');
    assert.equal(s.seen.events.indexOf('connect') < s.seen.events.indexOf('exit'), true, `the exit follows the connect: ${s.seen.events}`);
    assert.equal(s.seen.exits, 1, 'exactly one exit: the terminate does not end a terminal whose pipe came up');
    assert.deepEqual(thrown(), [], 'nothing thrown outside a caller');
  });

  test('PTY-LATE-READY-EXIT-107: the agent\'s close timer destroys the socket between connect() and \'connect\': the exit is still reported, once', async () => {
    const s = await spawnSilent(EARLY_READY_MS);
    const codes = [];
    s.proc.onExit((e) => { codes.push(e.exitCode); });
    s.proc.kill();
    assert.equal(s.sock._handle, null, 'the lever holds: the kill ran before the connect');
    let connectEvents = 0;
    s.sock.on('connect', () => { connectEvents++; });
    // node-pty's _closeTimeout body, in the turn the READY is handled: after connect(), before 'connect'.
    s.readyHandled.then(() => { s.proc._agent._exitCode = 41; s.proc._agent._cleanUpProcess(); });
    await withinAll({ 'the terminal exit': s.exited, 'the worker\'s end': s.workerEnded }, s, 'socket destroyed before its connect event');
    await sleep(FLUSH_MS + 300);   // node-pty's own close timer, and anything a second report would ride on
    assert.equal(s.seen.connects, 1, 'the READY did start its connect');
    assert.equal(connectEvents, 0, 'the lever holds: the socket was destroyed before its connect event');
    assert.equal(s.seen.exits, 1, `exactly one exit (${s.state()})`);
    assert.deepEqual(codes, [41], 'the exit carries the agent\'s exit code, read at the close');
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
      await withinAll({ 'the terminal exit': s.exited, 'the worker\'s end': s.workerEnded }, s, `terminal ${i}`);
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
    // A real emitter: the guard watches the socket's 'connect' and 'close'. destroy() closes it, as net does.
    const sock = new EventEmitter();
    let closed = false;
    sock.close = () => { if (!closed) { closed = true; sock.emit('close'); } };
    Object.assign(sock, { readable: true, _handle: handle, destroy: () => { rec.destroys++; sock.close(); } });
    t._socket = sock;
    const worker = { terminate: () => { rec.terminates++; return Promise.resolve(0); } };
    const conn = { connectSocket: () => { rec.connects++; }, _worker: worker };
    // No exit code yet: node-pty's agent learns it from the exit callback, which can come after the kill.
    t._agent = { kill: () => { t._socket.readable = false; }, exitCode: undefined, _conoutSocketWorker: conn };
    t.emit = (name, ...a) => { if (name === 'exit') rec.exits.push(a[0]); };
    return { t, rec, conn, worker, own: { connectSocket: conn.connectSocket, terminate: worker.terminate } };
  }

  test('the guard, step by step, on the real WindowsTerminal prototype', async () => {
    // Terminate first, READY late.
    const late = terminal({ handle: null });
    assert.equal(armEarlyKill(late.t, 'win32'), true);
    late.t.kill();
    assert.deepEqual(late.rec, { connects: 0, terminates: 0, destroys: 0, exits: [] }, 'the kill alone ends nothing');
    late.t._agent.exitCode = 7;   // between the kill and the terminate: the code is read AT the terminate (A7)
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

    // ...and when that socket connects and later closes, the exit is node-pty's to report, not the guard's.
    early.t._socket.emit('connect');
    early.t._socket.close();
    assert.deepEqual(early.rec.exits, [], 'a close after the connect event reports nothing here');

    // PTY-LATE-READY-EXIT-107. READY first, then the socket is closed BEFORE its connect event (the
    // agent's close timer): the guard reports the exit, with the code as it is at the close.
    const cut = terminal({ handle: null });
    armEarlyKill(cut.t, 'win32');
    cut.t.kill();
    cut.t._socket.close();   // closed with no connect started: not this path's to report
    assert.deepEqual(cut.rec.exits, [], 'a socket watched only from its connect');
    const cut2 = terminal({ handle: null });
    armEarlyKill(cut2.t, 'win32');
    cut2.t.kill();
    cut2.conn.connectSocket(cut2.t._socket);
    cut2.t._agent.exitCode = 9;
    cut2.t._socket.close();
    assert.deepEqual(cut2.rec, { connects: 1, terminates: 0, destroys: 0, exits: [9] }, 'closed before its connect event: the exit is reported here');
    // The kill's terminate racing that close, either order: still one exit.
    await cut2.worker.terminate();
    cut2.t._socket.emit('close');
    assert.deepEqual(cut2.rec, { connects: 1, terminates: 1, destroys: 0, exits: [9] }, 'close, then terminate: no second exit');
    const race = terminal({ handle: null });
    armEarlyKill(race.t, 'win32');
    race.t.kill();
    race.conn.connectSocket(race.t._socket);
    await race.worker.terminate();
    assert.deepEqual(race.rec.exits, [], 'the terminate leaves a started connect alone');
    race.t._socket.close();
    await race.worker.terminate();
    assert.deepEqual(race.rec, { connects: 1, terminates: 2, destroys: 0, exits: [undefined] }, 'terminate, then close: one exit');
    // Terminate with no connect started: its own destroy closes the socket, and that close reports nothing more.
    const gone = terminal({ handle: null });
    armEarlyKill(gone.t, 'win32');
    gone.t.kill();
    gone.t._agent.exitCode = 3;
    await gone.worker.terminate();
    gone.conn.connectSocket(gone.t._socket);
    gone.t._socket.emit('close');
    assert.deepEqual(gone.rec, { connects: 0, terminates: 1, destroys: 1, exits: [3] }, 'the terminate\'s exit is the only one');

    // Connected at the kill: nothing of the connection is touched.
    const up = terminal({ handle: {} });
    armEarlyKill(up.t, 'win32');
    up.t.kill();
    assert.equal(up.conn.connectSocket, up.own.connectSocket, 'connectSocket is node-pty\'s own');
    assert.equal(up.worker.terminate, up.own.terminate, 'terminate is the worker\'s own');

    // Another node-pty (no conout connection): the early kill still runs, nothing throws, and the
    // missing guard is said once, however many terminals meet it.
    const warns = [];
    const ownWarn = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    try {
      for (let i = 0; i < 2; i++) {
        const bare = terminal({ handle: null });
        delete bare.t._agent._conoutSocketWorker;
        armEarlyKill(bare.t, 'win32');
        bare.t.kill();
        assert.equal(bare.t._socket.readable, true, 'PTY-EARLY-CLOSE-EOF still holds without it');
      }
    } finally { console.warn = ownWarn; }
    assert.equal(warns.length, 1, `one line for a node-pty the guard does not fit (${JSON.stringify(warns)})`);
    assert.match(warns[0], /^\[pty\] late-READY guard not installed/, 'and it names the guard');
  });
}
