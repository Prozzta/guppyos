'use strict';
require('./tools/own-job.cjs');

// PTY-NATURAL-EXIT-NO-KILL-LEAK. A terminal that ends by itself (its program quits, crashes or fails
// to start) goes through PtyManager's onExit, which sends no kill. node-pty 1.1.0 frees the conout
// worker thread only from its kill, and the input socket from nowhere at all: its exit path destroys
// just the output socket. Measured on int d4818eb0 (Node 26.13 and Electron 45.3 as Node): one worker
// (a MessagePort handle) and one open input socket stay per such terminal, for the life of the app;
// a killed terminal keeps its input socket too.
//
// Everything here goes through a real PtyManager and a real console child, and waits BY EVENT: each
// worker's 'exit' and each input socket's 'close'. The watchdog is only the bound on "never" and
// names what is still held. Every test frees what it made, so a red run still lets the file end.
//
// PTY-NATURAL-EXIT-JOIN (FLAKE-PTY-NATURAL-EXIT-READY-EXITCODE-UNDEFINED-108). node-pty emitted 'exit'
// at the output socket's close and read the code then; on ConPTY only the native exit report sets it,
// and the host can close the pipe before that queued report has run: 'exit' carried undefined. The
// patch (tools/patch-node-pty-root-handle.cjs) leaves the exit to the report when the root has ended.
// The two JOIN cells below hold each order by its own lever, with no timer. Mutants, each applied by
// hand to node_modules/node-pty/lib, this file run alone, then the file restored and its sha checked:
//   M1 windowsPtyAgent.js `            guppyPendingExit();` -> `            void 0;` (the report never
//      emits the exit it was left): dies at RED BEFORE, 'THE EXIT IS REPORTED ONCE THE REPORT HAS RUN'.
//   M2 windowsTerminal.js back to pristine 1.1.0 (THE REVERT): dies at RED BEFORE, 'NO EXIT AT THE CLOSE'.
//   M3 windowsTerminal.js `        process.kill(pid, 0);` -> `        throw Object.assign(new Error('m3'),
//      { code: 'ESRCH' });` (no liveness proof): dies at GUARD, 'THE CLOSE OF A LIVE ROOT IS REPORTED AT ONCE'.
//   M4 windowsTerminal.js `return !!e && e.code === 'ESRCH';` -> `return !(e && e.code === 'ESRCH');`
//      (the proof inverted): dies at RED BEFORE, 'NO EXIT AT THE CLOSE'.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { consoleNode } = require('./tools/console-node.cjs');

const NEVER_MS = 8000;   // node-pty's dispose ends the worker 1 s after it is asked to
const WIN = process.platform === 'win32';
let seq = 0;

/** Spawns one terminal through the manager and wires the two release events. */
async function open(m, node, script) {
  const id = `natural-exit-${process.pid}-${seq += 1}`;
  assert.deepEqual(await m.spawn({ id, cwd: process.cwd(), command: node.file, args: ['-e', script], cols: 80, rows: 24 }), { ok: true });
  const proc = m.sessions.get(id).proc;
  const conn = proc._agent._conoutSocketWorker;
  const worker = conn?._worker;
  const inSocket = proc._agent._inSocket;
  assert.ok(worker && inSocket, 'node-pty 1.1.0 internals: a conout worker and an input socket');
  const t = { id, proc, conn, worker, inSocket, workerState: 'alive', inState: 'open' };
  t.released = Promise.all([
    new Promise((res) => worker.once('exit', () => { t.workerState = 'exited'; res(); })),
    new Promise((res) => inSocket.once('close', () => { t.inState = 'closed'; res(); }))
  ]);
  t.exited = new Promise((res) => proc.onExit(res));
  return t;
}

/** Resolves when every terminal released both; rejects naming each one that did not. */
async function allReleased(terminals, after) {
  let watchdog;
  await Promise.race([Promise.all(terminals.map((t) => t.released)), new Promise((_, rej) => {
    watchdog = setTimeout(() => rej(new Error(`${after}, still held: `
      + terminals.map((t, i) => `terminal ${i + 1}: conout worker ${t.workerState}, input socket ${t.inState}`).join('; '))), NEVER_MS);
  })]).finally(() => clearTimeout(watchdog));
}

/** The bound on "never" for one awaited event; names it. */
async function within(promise, what) {
  let watchdog;
  return Promise.race([promise, new Promise((_, rej) => { watchdog = setTimeout(() => rej(new Error(`${what}: not within ${NEVER_MS} ms`)), NEVER_MS); })]).finally(() => clearTimeout(watchdog));
}

const printed = (proc, text) => new Promise((res) => { let seen = ''; proc.onData((d) => { seen += d; if (seen.includes(text)) res(); }); });

async function freeAll(terminals) {
  for (const t of terminals) { await t.worker.terminate(); t.inSocket.destroy(); }
}

const NATURAL = [
  ['never printed (the terminal never became ready)', 'process.exit(0)', 0],
  ['printed first (a ready terminal)', 'console.log(1); setTimeout(() => process.exit(0), 300)', 0],
  ['failed (a non-zero exit)', 'process.exit(3)', 3]
];

for (const [name, script, code] of NATURAL) {
  test(`PTY-NATURAL-EXIT: 3 terminals whose child ${name} leave no conout worker and no input socket`, { skip: !WIN }, async (t) => {
    const { PtyManager } = loadTs('src/main/pty.ts');
    const node = consoleNode();
    t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
    const m = new PtyManager();
    // What the exit handler sees: the exit is reported with the terminal still whole, the release comes after.
    const seen = new Map();
    const byId = new Map();
    m.setExitHandler((id) => { const x = byId.get(id); seen.set(id, { inDestroyed: x.inSocket.destroyed, disposed: x.conn._isDisposed === true }); });
    const terminals = [];
    // The release names no process: the root pid is gone and may be reused, so neither node-pty's
    // _agent.kill (it sweeps the console process list of that pid) nor process.kill may run here.
    const kills = [];
    const realKill = process.kill;
    process.kill = function (...args) { kills.push(`process.kill(${args.join(', ')})`); return realKill.apply(process, args); };
    try {
      for (let i = 0; i < 3; i += 1) {
        const x = await open(m, node, script); byId.set(x.id, x); terminals.push(x);
        const agentKill = x.proc._agent.kill;
        x.proc._agent.kill = function (...args) { kills.push(`_agent.kill of terminal ${i + 1}`); return agentKill.apply(this, args); };
      }
      for (const x of terminals) assert.equal((await x.exited).exitCode, code, 'the child ended by itself; no kill was sent');
      assert.equal(m.sessions.size, 0, 'the sessions are gone: no later kill can reach these terminals');
      for (const x of terminals) {
        assert.deepEqual(seen.get(x.id), { inDestroyed: false, disposed: false }, 'the exit is reported before the terminal is released');
      }
      await allReleased(terminals, 'after a natural exit (PtyManager onExit frees nothing)');
      // PTY-NATURAL-EXIT-JOIN: the output close may ask whether the terminal's own root has ended
      // (signal 0 sends nothing). No other pid, and no real signal.
      const probes = new Set(terminals.map((x) => `process.kill(${x.proc._agent._innerPid}, 0)`));
      assert.deepEqual(kills.filter((k) => !probes.has(k)), [], 'a terminal that ended by itself is released without a kill and without naming a pid');
      // A kill after the natural exit is a harmless no-op, and so is a write.
      for (const x of terminals) {
        assert.deepEqual(m.kill(x.id), { ok: false, error: `no pty: ${x.id}` });
        assert.deepEqual(m.write(x.id, 'late', 'HUMAN'), { ok: false, error: `no pty: ${x.id}` }, 'a write after the exit goes nowhere');
      }
      assert.equal(m.sessions.size, 0);
    } finally {
      process.kill = realKill;
      await freeAll(terminals);
    }
  });
}

test('PTY-NATURAL-EXIT: a killed terminal is released too: its conout worker and its input socket', { skip: !WIN }, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const m = new PtyManager();
  const terminals = [];
  try {
    // One killed while silent (not ready), one killed after it printed (ready).
    terminals.push(await open(m, node, 'setInterval(() => {}, 1000)'));
    const ready = await open(m, node, 'console.log(1); setInterval(() => {}, 1000)');
    terminals.push(ready);
    await new Promise((res) => ready.proc.onData(res));
    for (const x of terminals) assert.deepEqual(m.kill(x.id), { ok: true });
    assert.equal(m.sessions.size, 0);
    for (const x of terminals) await x.exited;
    await allReleased(terminals, 'after PtyManager.kill and the exit that follows it');
    for (const x of terminals) assert.deepEqual(m.kill(x.id), { ok: false, error: `no pty: ${x.id}` }, 'a second kill is a no-op');
  } finally {
    await freeAll(terminals);
  }
});

test('PTY-NATURAL-EXIT-JOIN: RED BEFORE: the output closes before the exit report has run; the exit waits for the report and carries its code', { skip: !WIN }, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const m = new PtyManager();
  const terminals = [];
  try {
    // The child ends by itself on a line of input, so the levers are in place before it can end.
    const x = await open(m, node, "process.stdin.once('data', () => process.exit(0)); console.log('READY-JOIN')");
    terminals.push(x);
    const agent = x.proc._agent;
    const order = [];
    const codes = [];
    x.proc.onExit((e) => { order.push('exit'); codes.push(e.exitCode); });
    // The lever: the native exit report is held, so the host's pipe close comes first, every time.
    let held = null;
    let onHeld;
    const heldReport = new Promise((res) => { onHeld = res; });
    const report = agent._$onProcessExit;
    agent._$onProcessExit = function (...a) { held = () => { order.push('report'); return report.apply(this, a); }; onHeld(); };
    // Added after node-pty's own close listener (added on ready_datapipe), so it runs after it.
    const closed = new Promise((res) => agent._outSocket.once('close', res));
    await within(printed(x.proc, 'READY-JOIN'), 'the child printed');
    assert.equal(m.write(x.id, '\r', 'HUMAN').ok, true, 'the line that ends the child');
    await within(Promise.all([heldReport, closed]), 'the exit report and the output close after a natural exit');
    assert.deepEqual(order, [], 'NO EXIT AT THE CLOSE WHILE THE REPORT IS STILL TO RUN: it would carry an undefined code');
    held();
    assert.deepEqual(order, ['report', 'exit'], 'THE EXIT IS REPORTED ONCE THE REPORT HAS RUN, in its turn');
    assert.deepEqual(codes, [0], "and it carries the child's own exit code");
    assert.equal(agent._guppyPendingExit, undefined, 'the pending exit is cleared');
  } finally {
    await freeAll(terminals);
  }
});

test('PTY-NATURAL-EXIT-JOIN: GUARD: an output close while the root still runs is reported at once, as before', { skip: !WIN }, async () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const m = new PtyManager();
  const terminals = [];
  // FLAKE-PTY-NATURAL-EXIT-GUARD-KILL-ESRCH-108: once the output close is reported, PtyManager's
  // exit handler destroys the input socket (releaseExited), so both of the console host's pipes are
  // gone and the host ends the root by itself, at a time of its own. A liveness check made by the
  // test after the close, and a kill by the root's pid, both race that end (the kill threw ESRCH
  // right after a check that passed). So the root's liveness is taken where it decides the guard:
  // the patch's own signal-0 probe at the close. The child is ended by its pseudoconsole handle,
  // which names no pid and is safe when the host is already ending it.
  const realKill = process.kill;
  const probes = [];
  let innerPid = null;
  try {
    const x = await open(m, node, "console.log('READY-GUARD'); setInterval(() => {}, 1000)");
    terminals.push(x);
    const agent = x.proc._agent;
    innerPid = agent._innerPid;
    process.kill = function (...args) {
      if (Number(args[0]) !== innerPid || (args[1] !== 0 && args[1] !== '0')) return realKill.apply(process, args);
      try { const r = realKill.apply(process, args); probes.push('alive'); return r; } catch (e) { probes.push(e && e.code); throw e; }
    };
    const exits = [];
    x.proc.onExit((e) => exits.push(e.exitCode));
    let reported = false;
    let onReport;
    const reportRan = new Promise((res) => { onReport = res; });
    const report = agent._$onProcessExit;
    agent._$onProcessExit = function (...a) { reported = true; try { return report.apply(this, a); } finally { onReport(); } };
    await within(printed(x.proc, 'READY-GUARD'), 'the child printed');
    const closed = new Promise((res) => agent._outSocket.once('close', res));
    agent._outSocket.destroy();   // the lever: the output closes with the root running
    await within(closed, 'the output close');
    assert.deepEqual(exits, [undefined], 'THE CLOSE OF A LIVE ROOT IS REPORTED AT ONCE: nothing proves that a report is coming');
    assert.equal(reported, false, 'no report has run');
    assert.equal(agent._guppyPendingExit, undefined, 'nothing is left for a report');
    assert.deepEqual(probes, ['alive'], 'THE ROOT STILL RAN AT THE CLOSE: the close asked once, by signal 0, and the root answered');
    process.kill = realKill;
    agent._ptyNative.kill(agent._pty, agent._useConptyDll);   // this test's own child, by its pseudoconsole handle: no pid
    await within(reportRan, 'the exit report after the end of the child');
    assert.deepEqual(exits, [undefined], 'the report emits no second exit');
  } finally {
    process.kill = realKill;
    await freeAll(terminals);
  }
});

test('PTY-NATURAL-EXIT: releaseExited is safe to repeat and leaves a terminal it does not know alone', () => {
  const { releaseExited } = loadTs('src/main/pty.ts');
  assert.equal(typeof releaseExited, 'function', 'src/main/pty.ts exports releaseExited');
  const calls = [];
  const proc = { _agent: { kill: () => calls.push('kill'), _conoutSocketWorker: { dispose: () => calls.push('dispose') }, _inSocket: { destroyed: false, destroy() { calls.push('destroy'); this.destroyed = true; } } } };
  assert.equal(releaseExited(proc, 'win32'), true);
  assert.equal(releaseExited(proc, 'win32'), true);
  assert.deepEqual(calls, ['destroy'], 'no kill; the socket is destroyed once; THE OUTPUT WORKER IS NOT ENDED HERE: it ends by itself when the console host has closed its end (PTY-CONHOST-LEAK-NATIVE)');
  assert.equal(releaseExited(proc, 'linux'), false, 'unix terminals have neither: nothing to do');
  assert.equal(releaseExited({}, 'win32'), false, 'another node-pty: left alone, and said so');
  assert.equal(releaseExited({ _agent: {} }, 'win32'), false);
  // A throwing internal never escapes into node-pty's exit callback.
  assert.equal(releaseExited({ _agent: { _conoutSocketWorker: { dispose() {} }, _inSocket: { destroy() { throw new Error('x'); } } } }, 'win32'), false);
});
